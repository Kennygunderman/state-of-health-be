/**
 * The import stage, and the two script libraries every import run goes through.
 *
 * Three things are covered here, in this order.
 *
 * FIRST, regression cover for the three import-stage defects a review of the
 * produced v1 release found, each of which is a property of a pure function in
 * `scripts/catalog-import-usda.ts` rather than of the artefact it produced:
 *
 *  - reviewed allergen and diet metadata must reach the row (a release that
 *    published wheat flour, egg, peanut butter, shrimp and salmon as
 *    `allergen_status: 'known'` with no allergen tags would let the planner
 *    offer them to an allergic user, which Agent Action Plan §0.7.3 forbids);
 *  - a curated portion selector that matches no source label must resolve to
 *    nothing, never to an unrelated portion wearing the selector's amount and
 *    unit over a foreign gram weight;
 *  - a dry run, and a category- or limit-restricted run, must not be able to
 *    close the canonical import's checkpoint.
 *
 * The manifest and coverage plan are the shipped ones, deliberately: these
 * tests are as much a check on `data/meal-planning/usda-manifest.v1.json`
 * carrying reviewed safety metadata as on the code that reads it.
 *
 * SECOND, the redaction contract of `scripts/lib/logger.ts` — every log line an
 * import run emits, to a terminal, to CI and to `catalog_import_runs.log`,
 * passes through that module.
 *
 * THIRD, the cross-process USDA rate ledger in `scripts/lib/rateLimiter.ts`,
 * which is what holds an import run to its share of the vendor's hour across a
 * restart and across two concurrent launches; §0.7.1 ties that limiter to this
 * stage, which is why its cover lives with the stage's own.
 *
 * The two libraries are covered here rather than beside their modules because
 * Jest's `roots` is `<rootDir>/src` (jest.config.ts), so a test file under
 * `scripts/` would never be collected. The relative imports are the consequence
 * of that, not a choice.
 */
import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

// The database-origin guard's value side, for the one arm of this stage's
// failure reporter that deliberately WITHHOLDS a first-party sentence. Free to
// import: dbGuard's only dependency is the logger, and its module-load
// assertion is a no-op when no entry script is being run — under Jest
// `process.argv[1]` is the runner, which is exactly the case dbGuard.test.ts
// covers from the other side.
import { DatabaseOriginError, classifyDatabaseOrigin } from '../../../scripts/lib/dbGuard';

import {
    ALLERGEN_CLASSES,
    ARTIFACT_LOCK_STALE_MS,
    COST_CLASSES,
    COVERAGE_CATEGORIES,
    COVERAGE_PLAN_FILE,
    FRESHNESS_OBLIGATIONS_FIELD,
    MANIFEST_FOOD_STATES,
    MERGED_REPORT_COMPOUND_BLOCKS,
    PROVISIONAL_REPORT_MARKER_KEYS,
    ManifestError,
    USDA_DATA_TYPES,
    USDA_MANIFEST_FILE,
    acquireArtifactPublicationLock,
    assertStagedDocumentComplete,
    assertUsdaManifestShape,
    dataPath,
    discardStagedArtifacts,
    fixturePath,
    loadCoveragePlan,
    loadEvidenceAllowlist,
    loadUsdaManifest,
    mergeStageReport,
    promoteStagedArtifacts,
    recoverInterruptedPublication,
    readJsonFile,
    reportPath,
    stageJsonArtifact,
    stagingPathFor,
    withArtifactPublicationLockSync,
    writeJsonFile,
} from '../../../scripts/lib/manifest';
import type { CoveragePlanCategory, StagedArtifact, UsdaManifest, UsdaManifestFood } from '../../../scripts/lib/manifest';
import { truncateFeatureTables } from '../setup/testDb';
import type { UsdaFoodDetail, UsdaFoodPortion, UsdaFoodSummary } from '../../services/usda.service';
// The key builder itself, not a restatement of it: the cache-key scheme the
// manifest documents is only checkable against the function that produces the
// key. It is pure and reads no cache, so importing the value side
// costs nothing here.
import { cacheKeyForRequest } from '../../services/usda.service';
import {
    CatalogImportError,
    IMPORT_REPORT_DESTINATIONS,
    IMPORT_REPORT_FILE,
    IMPORT_REPORT_NOTE_KEY,
    USDA_SOURCE_CACHE_KEY_SCHEME,
    assertCategoryFiltersDeclared,
    assertManifestMatchesCoveragePlan,
    buildImportPlan,
    buildRefusalBlock,
    buildRequirementHeadroomBlock,
    buildValidationRecordData,
    checkManifestAgainstCoveragePlan,
    combineImportReportFigures,
    describeFailure,
    importRecordOutcome,
    importReportDestination,
    importReportTarget,
    importRunScope,
    initialImportCounts,
    matchSelectorPortion,
    parsePortionLabel,
    preflight,
    prepareCatalogFood,
    readImportReportSnapshot,
    runImport,
    sourceCacheKeySchemeDisagreements,
    toBatchRetrieval,
    undeclaredCategoryFilters,
    withArtifactTargetIdentity,
    writeImportReport,
} from '../../../scripts/catalog-import-usda';
import type {
    ImportAssignment,
    ImportBatchFetch,
    ImportOptions,
    ImportReportDestination,
    ImportReportSnapshot,
    QuarantinedRecord,
    RunImportDeps,
    UsdaBatchRetrieval,
} from '../../../scripts/catalog-import-usda';
// One statement for the logger module, covering both of its roles in this file:
// the `ScriptLogger` the import stage is handed, and the functions whose
// redaction contract is what makes handing it anything safe.
import {
    UNEXPECTED_FAILURE_REMEDY,
    classifyInfrastructureFailure,
    createLogger,
    firstPartyMessage,
    hostOf,
    redactUrlUserinfo,
    safeError,
    sanitizeLogFields,
    scrubSecrets,
    type LogLevel,
    type ScriptLogger,
} from '../../../scripts/lib/logger';
import {
    DEFAULT_BURST_CAPACITY,
    DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR,
    DEFAULT_USDA_RATE_LEDGER_SCOPE,
    RATE_WINDOW_MS,
    RateLimitConfigError,
    USDA_HOST,
    USDA_IMPORT_POLICY_CAP_PER_HOUR,
    USDA_RATE_LEDGER_STATE_VERSION,
    USDA_VENDOR_CAP_PER_HOUR,
    UsdaRateLedgerError,
    createFileUsdaRateLedger,
    createProcessLocalUsdaRateLedger,
    createUsdaRateLimiter,
    defaultUsdaRateLedgerDirectory,
    defaultUsdaRateLedgerStateFilePath,
    getUsdaImportRateLimitPerHour,
    isUsdaRequestUrl,
    ledgerLockOwnership,
    pruneAttemptWindow,
    recordAttemptWindow,
    refillBucket,
    usdaStatusClass,
    waitMsForToken,
    windowWaitMs,
    type UsdaRateLedger,
    type UsdaRateLimiter,
    type UsdaRateReservation,
    type UsdaRequestStats,
} from '../../../scripts/lib/rateLimiter';
// The version decision and the persistence it feeds, plus the batch
// accounting. `nextCatalogFoodVersions` is pure, so most of that
// contract is proven with no database at all; `persistPreparedFood` is where it
// meets the write, and a fake `ImportDb` is how the write is observed.
//
// The version rule and its fact set come from `src/services/catalog.logic`,
// the catalog's own decision layer that both writers of `catalog_foods` call,
// rather than from the import CLI that used to export them: a suite importing a
// CLI to reach a pure rule is the same coupling the generation stage had, and
// this import is what keeps the domain module the one place either stage reads
// the rule from. The payload digest stays with the script library that both
// commands share for it.
import {
    IMPORT_CHECK_MISSING_RETRIEVAL_STATUS,
    importEvidenceAssessment,
    importEvidenceCheckName,
    importPublicationStatus,
    persistPreparedFood,
} from '../../../scripts/catalog-import-usda';
import type { ImportDb, PreparedCatalogFood } from '../../../scripts/catalog-import-usda';
// The shared complete-evidence floor, imported here so the import stage's
// disposition is asserted against the SAME predicate validation, the release
// exporter and the release loader apply — not against a copy of its rules.
import { evidenceGapCodes } from '../../../scripts/lib/catalogEvidence';
import { canonicalJsonString, sha256Hex } from '../../../scripts/lib/catalogFoodFacts';
import { nextCatalogFoodVersions } from '../../services/catalog.logic';
import type { StoredVersionedFacts } from '../../services/catalog.logic';
// The stage lock and the run identity a validation pass claims
// both live with run state, which is what they are about.
import {
    CATALOG_STAGE_LOCK_MODES,
    CheckpointError,
    NO_CATALOG_INPUT,
    acquireCatalogStageLock,
    canonicalValidationRunKey,
    catalogInputIdentity,
    catalogStageLockFunctions,
    catalogStageLockKey,
    catalogStageLockMode,
    finishRun,
    isRestrictedValidationRunKey,
    normalizeStageLockPollMs,
    normalizeStageLockWaitMs,
    openOrResumeRun,
    openRun,
    resolveCounts,
    saveCheckpoint,
    validationRunKeyInputPart,
    withCatalogStageLock,
} from '../../../scripts/lib/checkpoint';
import type { CatalogInputRunRow, CatalogStageLockConnection } from '../../../scripts/lib/checkpoint';
// Validation's run identity, its completed-run no-op and its per-food
// lock/re-read/CAS. Importing this module runs nothing: like the import
// script it guards `main()` behind `require.main === module`.
import {
    DEFAULT_CURATOR_DECISIONS_PATH,
    appendValidationHistory,
    historyEntryBelongsToRun,
    identityGroupMoved,
    runHasJudgedFood,
    runValidation,
    settleUnresumableValidationRuns,
    validationRunScope,
} from '../../../scripts/catalog-validate';
import type {
    RunValidationDeps,
    ValidateDb,
    ValidateOptions,
    ValidationBudget,
    ValidationFoodRow,
    ValidationReviewClient,
} from '../../../scripts/catalog-validate';
// The ledger error the advisory review's stop path is driven with: a refused
// reservation is what an exhausted shared cap looks like to this stage.
import { ModelBudgetError } from '../../../scripts/lib/budget';
// The release's refusal rule, which is pure over the run
// ledger, and the read that decides which rows it gets to see.
import { ReleaseIntegrityError, loadPipelineRuns, releaseStalenessReason, runRelease } from '../../../scripts/catalog-release';
import type { ReleaseDb, ReleaseRunRow, RunReleaseDeps } from '../../../scripts/catalog-release';
// The evidence stage's publication contract: one snapshot for both passes, a
// staged pair promoted together, and a scoped report that cannot land on the
// committed artefacts. Importing the module opens no connection and starts no
// run — `main()` is behind `require.main === module`, exactly like the other
// stages above.
import {
    CatalogReportError,
    REPORT_SNAPSHOT_ISOLATION,
    REPORT_STAGE_NOTE_KEY,
    canonicalReportDirectory,
    canonicalizeDirectoryPath,
    defaultReportIo,
    reconcileItemCount,
    runReport,
    scopedReportRefusal,
    writesIntoCanonicalReportDirectory,
} from '../../../scripts/catalog-report';
import type { ReportDb, ReportFoodRow, ReportOutcome, ValidationRecordRow } from '../../../scripts/catalog-report';
import { validateCatalogCandidate } from '../../services/catalog.logic';
import type { CatalogValidationPolicy } from '../../services/catalog.logic';
// The artefact-target rule. Its truth table belongs to `catalog.logic.test.ts`;
// what this file needs are the key names the committed document uses and the
// error the refusal raises, so the wiring can be pinned without restating the
// field names as literals.
import {
    CATALOG_ARTIFACT_TARGET_DIGEST_FIELD,
    CATALOG_ARTIFACT_TARGET_IDENTITY_KEY,
    CatalogArtifactTargetError,
    catalogArtifactTargetIdentity,
} from '../../services/catalog.logic';
import { prisma } from '../../prisma/client';
// The FORMAT of the vendor-deny log, from the side-effect-free half of that
// pair. Its installing half (`../setup/vendorNetworkDeny`) is deliberately NOT
// imported here and is named as a path instead: requiring it installs the
// refusal, which belongs in the children the stage-lock cases launch and not in
// this process, where `jestSetup.ts` removes the keys instead and the rate
// limiter cases replace `globalThis.fetch` with transports of their own.
import { VENDOR_NETWORK_DENY_LOG_VAR, readVendorNetworkDenyLog } from '../setup/vendorNetworkDenyLog';
import type { VendorNetworkDenyEvent } from '../setup/vendorNetworkDenyLog';

const manifest: UsdaManifest = loadUsdaManifest();
const coveragePlan = loadCoveragePlan();

/**
 * A process id that cannot be live: Linux caps `pid_max` at 2^22, so this value
 * is beyond any pid the kernel can assign. Used to stand in for a killed
 * publisher, because a holder whose process is gone is what makes a
 * publication lock stale immediately.
 */
const DEAD_PID = 2_147_483_647;

const silentLogger: ScriptLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
};

/** The four models a batch writes catalog state through. */
const CATALOG_WRITE_MODELS: readonly string[] = [
    'catalog_foods',
    'catalog_food_aliases',
    'catalog_food_portions',
    'catalog_validation_records',
];

/**
 * A catalog client whose transaction is REAL and whose catalog models are not.
 *
 * The import's per-batch transaction carries the run-ledger write as well as
 * the rows — that is what makes a batch's cursor, its counts and its rows one
 * commit — so `$transaction` cannot be a stub handing back a forbidding proxy:
 * the checkpoint inside it has to reach a genuine transaction. It delegates to
 * the real client, and the client the batch body receives forwards the run
 * ledger and the raw query the row lock is taken with while failing BY NAME on
 * any catalog model.
 *
 * That pair is the assertion these cases make: the checkpoint went through a
 * real transaction, and no food, alias, portion or validation record was
 * written. `label` names the kind of case in the failure message, because
 * "reached catalog state" on its own does not say which contract broke.
 *
 * Functions are bound to the real client before they are handed over: a Prisma
 * method extracted through a proxy and called unbound loses its receiver.
 */
const ledgerOnlyCatalogDb = (label: string): ImportDb => {
    const ledgerOnly = (real: unknown): ImportDb =>
        new Proxy(
            {},
            {
                get: (_target, property) => {
                    const key = String(property);
                    if (CATALOG_WRITE_MODELS.indexOf(key) >= 0) {
                        throw new Error(`${label} reached catalog state: db.${key}`);
                    }
                    const value = Reflect.get(real as object, property);
                    return typeof value === 'function' ? value.bind(real) : value;
                },
            },
        ) as unknown as ImportDb;

    return {
        $transaction: <T>(work: (tx: ImportDb) => Promise<T>, txOptions?: { timeout?: number }): Promise<T> =>
            prisma.$transaction((tx) => work(ledgerOnly(tx)), txOptions),
    } as unknown as ImportDb;
};

/** What a batch had already written, inside its own transaction, when the write below failed. */
interface PartialBatchWrite {
    readonly foods: number;
    readonly aliases: number;
    readonly portions: number;
    readonly validationRecords: number;
}

/**
 * A catalog client that fails PART-WAY THROUGH a batch, and reports what that
 * batch had already written when it did.
 *
 * Every other failure this section injects arrives from the vendor, BETWEEN
 * batches: the batch either ran or did not. That can never observe the defect
 * a per-batch transaction exists to prevent — a batch that commits some of its
 * foods and not the rest, leaving rows the ledger does not account for and a
 * cursor that cannot be trusted either way. Reaching it needs the failure
 * INSIDE the transaction, after real rows have been written through it.
 *
 * `failOnValidationRecordWrite` is the Nth `catalog_validation_records.upsert`
 * of the whole run, counted across batches, because that write is the last
 * statement `persistPreparedFood` makes for one food: failing on it means the
 * foods before it in this batch are complete and the food it belongs to has
 * its own row, aliases and portions already written. Everything else forwards
 * to the real transaction client, so those writes are genuine.
 *
 * Before it throws, it counts what the transaction can see — which, inside an
 * uncommitted transaction, is the committed rows PLUS this transaction's own.
 * That count is the evidence a rollback assertion otherwise lacks: without it,
 * "no new rows afterwards" is equally consistent with a stage that wrote
 * nothing at all before failing.
 */
const failAfterPartialBatchWrite = (config: {
    readonly failOnValidationRecordWrite: number;
    readonly message: string;
}): { readonly db: ImportDb; readonly partialWrite: PartialBatchWrite | null } => {
    const state: { writes: number; partialWrite: PartialBatchWrite | null } = {
        writes: 0,
        partialWrite: null,
    };

    const failing = (real: unknown): ImportDb =>
        new Proxy(
            {},
            {
                get: (_target, property) => {
                    if (String(property) === 'catalog_validation_records') {
                        const model = Reflect.get(real as object, property) as {
                            upsert: (args: unknown) => Promise<unknown>;
                        };

                        return {
                            upsert: async (args: unknown): Promise<unknown> => {
                                state.writes += 1;
                                if (state.writes !== config.failOnValidationRecordWrite) {
                                    return model.upsert.call(model, args);
                                }

                                const tx = real as {
                                    catalog_foods: { count: (args?: unknown) => Promise<number> };
                                    catalog_food_aliases: { count: (args?: unknown) => Promise<number> };
                                    catalog_food_portions: { count: (args?: unknown) => Promise<number> };
                                    catalog_validation_records: { count: (args?: unknown) => Promise<number> };
                                };
                                state.partialWrite = {
                                    foods: await tx.catalog_foods.count({ where: { identity_source: 'usda' } }),
                                    aliases: await tx.catalog_food_aliases.count(),
                                    portions: await tx.catalog_food_portions.count(),
                                    validationRecords: await tx.catalog_validation_records.count(),
                                };

                                throw new Error(config.message);
                            },
                        };
                    }
                    const value = Reflect.get(real as object, property);

                    return typeof value === 'function' ? value.bind(real) : value;
                },
            },
        ) as unknown as ImportDb;

    return {
        db: {
            $transaction: <T>(work: (tx: ImportDb) => Promise<T>, txOptions?: { timeout?: number }): Promise<T> =>
                prisma.$transaction((tx) => work(failing(tx)), txOptions),
        } as unknown as ImportDb,
        get partialWrite(): PartialBatchWrite | null {
            return state.partialWrite;
        },
    };
};

const options = (overrides: Partial<ImportOptions> = {}): ImportOptions => ({
    help: false,
    categories: [],
    limit: null,
    resume: false,
    dryRun: false,
    // No stated expectation, which is the default an operator gets: the run
    // imports whichever manifest version the checkout ships. The cases that
    // exercise `--manifest` set it explicitly.
    manifestVersion: null,
    ...overrides,
});

const retrieval = (fdcIds: readonly number[]): UsdaBatchRetrieval => ({
    requestedFdcIds: [...fdcIds],
    cacheKey: `POST /foods?#{"fdcIds":[${fdcIds.join(',')}],"format":"full"}`,
    responseSha256: 'a'.repeat(64),
    source: 'usda_api_cache',
    // A replayed response whose row carries a recorded status. The evidence
    // record quotes this value, so the fixture states one rather than leaving
    // the field to be inferred from `source` — which is the defect the field
    // was added to end.
    httpStatus: 200,
    cachedAt: new Date('2026-09-13T09:11:40.243Z'),
});

/** The batch fetch an `ImportUsdaClient` answers with: records plus provenance. */
const batchFetch = (details: UsdaFoodDetail[], fdcIds: readonly number[]): ImportBatchFetch => ({
    details,
    retrieval: retrieval(fdcIds),
});

/** A per-100 g SR Legacy record: the shape every generic USDA data type states. */
const detailFor = (entry: UsdaManifestFood, portions: UsdaFoodPortion[] = []): UsdaFoodDetail => ({
    fdcId: entry.fdcId as number,
    description: entry.expectedUsdaDescription ?? entry.displayName,
    dataType: entry.usdaDataType,
    publicationDate: '4/1/2019',
    foodNutrients: [
        { nutrientNumber: manifest.nutrientNumbers.protein, value: 10 },
        { nutrientNumber: manifest.nutrientNumbers.fat, value: 5 },
        { nutrientNumber: manifest.nutrientNumbers.carbs, value: 20 },
        { nutrientNumber: manifest.nutrientNumbers.calories, value: 165 },
    ],
    foodPortions: portions,
});

// Every curated entry carries a verified `fdcId` — the declared shape requires
// it and `assertUsdaManifestShape` refuses a document that omits one — so this
// is the whole curated set rather than a filtered subset. It stays a named
// binding because the suite reads it in a dozen places.
const curatedEntries: readonly UsdaManifestFood[] = manifest.foods;

const entryCarrying = (allergen: string): (UsdaManifestFood & { fdcId: number }) | undefined =>
    curatedEntries.find(
        (entry) => entry.reviewedSafety?.allergenStatus === 'known' && entry.reviewedSafety.allergenTags.includes(allergen),
    ) ?? curatedEntries.find((entry) => entry.reviewedSafety?.allergenTags.includes(allergen));

/**
 * THE MANIFEST IS VERIFIED BEFORE IT IS BELIEVED.
 *
 * `loadUsdaManifest` used to check one field — the version string — and cast
 * the rest. Everything downstream then read a fully-typed `UsdaManifest` that
 * nothing had established: a category typo, a missing `fdcId`, an allergen
 * class spelled `tree nuts`, a `pageSize` above the vendor's own maximum, a
 * duplicated `sweepKey`. None of those fails at load. Each one instead
 * mis-files, mis-labels or silently drops records, hundreds of vendor requests
 * into a run — and an allergen typo mis-labels a food a user avoids for
 * medical reasons.
 *
 * `assertUsdaManifestShape` is the narrowing that makes the type true, in the
 * same shape as `assertEvidenceAllowlistShape`: every field checked, every
 * refusal naming the entry it came from, and the whole of it before the rate
 * limiter is installed and before the first request.
 *
 * WHAT THESE CASES ARE. The committed document must pass — a validator no real
 * document satisfies is not in force — and then each mutation of it must be
 * refused. The mutations are applied to a deep clone of the real file rather
 * than to a hand-built fixture, so every case is one field away from a document
 * that works and cannot pass by being incomplete in some other way.
 */
describe('the USDA manifest is verified rather than cast', () => {
    /** A mutable deep clone of the committed document, as parsed JSON. */
    const clone = (): Record<string, any> =>
        JSON.parse(fs.readFileSync(dataPath(USDA_MANIFEST_FILE), 'utf8')) as Record<string, any>;

    const refusal = (mutate: (document: Record<string, any>) => void): ManifestError => {
        const document = clone();
        mutate(document);
        try {
            assertUsdaManifestShape(document, USDA_MANIFEST_FILE);
        } catch (error) {
            expect(error).toBeInstanceOf(ManifestError);

            return error as ManifestError;
        }
        throw new Error('assertUsdaManifestShape accepted a document it should have refused');
    };

    it('accepts the committed document, and returns it narrowed', () => {
        const accepted = assertUsdaManifestShape(clone(), USDA_MANIFEST_FILE);

        // Asserted through the narrowed value rather than against literals: the
        // point is that the checked result is the document, not that the
        // document has a particular number of entries this week.
        expect(accepted.usdaManifestVersion).toBe(manifest.usdaManifestVersion);
        expect(accepted.foods).toHaveLength(manifest.foods.length);
        expect(accepted.datasetSweeps).toHaveLength(manifest.datasetSweeps.length);
        expect(accepted.foods.every((food) => Number.isInteger(food.fdcId))).toBe(true);
    });

    it('states its vocabularies where the unions are declared, so neither can drift alone', () => {
        // Each list is built as a total record over its union, so a member
        // added to the type without a key here is a compile error rather than a
        // value the validator silently accepts. The sizes are asserted because
        // that is the half a compiler cannot see: 21 categories is AAP §0.7.3's
        // coverage plan, and the five states and five data types are the
        // schema's own.
        expect(COVERAGE_CATEGORIES).toHaveLength(21);
        expect(MANIFEST_FOOD_STATES).toHaveLength(5);
        expect(USDA_DATA_TYPES).toHaveLength(5);
        expect(COST_CLASSES).toEqual([1, 2, 3]);
        // The nine the product asks about (AAP §0.1.2). Asserted as an ordered
        // list because this is the constant the document is measured against,
        // so it is the one place where a silent edit would be invisible.
        expect(ALLERGEN_CLASSES).toEqual([
            'milk',
            'eggs',
            'peanuts',
            'tree_nuts',
            'soy',
            'wheat',
            'fish',
            'shellfish',
            'sesame',
        ]);
    });

    /**
     * The truncation these four cases exist for.
     *
     * Every other allergen check in `assertSweepAllergenDietRules` reads
     * `allergenVocabulary` as the authority: `byFoodGroup` tags are checked
     * against it, and so are the `descriptionAllergenMarkers` keys. So a
     * document that drops a class from ALL of those at once is internally
     * consistent, passes every subset check, imports cleanly — and stops tagging
     * that allergen. The vocabulary is therefore compared against
     * {@link ALLERGEN_CLASSES}, which lives in code and not in the document.
     */
    it('refuses a coherent truncation that drops an allergen class everywhere at once', () => {
        const error = refusal((document) => {
            const rules = document.sweepAllergenDietRules;
            // A truncation with no loose ends: vocabulary, marker table,
            // food-group seeds and every reviewed entry, all consistent.
            rules.allergenVocabulary = rules.allergenVocabulary.filter((value: string) => value !== 'milk');
            delete rules.descriptionAllergenMarkers.milk;
            for (const [group, tags] of Object.entries(rules.byFoodGroup as Record<string, string[]>)) {
                const kept = tags.filter((tag) => tag !== 'milk');
                if (kept.length === 0) {
                    delete rules.byFoodGroup[group];
                } else {
                    rules.byFoodGroup[group] = kept;
                }
            }
            for (const entry of document.foods) {
                if (entry.reviewedSafety?.allergenTags !== undefined) {
                    entry.reviewedSafety.allergenTags = entry.reviewedSafety.allergenTags.filter(
                        (tag: string) => tag !== 'milk',
                    );
                }
            }
        });

        expect(error.message).toContain('allergenVocabulary');
        expect(error.message).toContain('milk');
        // Says it is MISSING, not merely that the set differs — the operator
        // needs to know which direction to fix.
        expect(error.message).toContain('omits');
    });

    it('refuses a vocabulary carrying a class the product does not support', () => {
        const error = refusal((document) => {
            document.sweepAllergenDietRules.allergenVocabulary.push('mustard');
        });

        expect(error.message).toContain('allergenVocabulary');
        expect(error.message).toContain('mustard');
        expect(error.message).toContain('adds');
    });

    it('refuses a vocabulary that lists a class twice', () => {
        const error = refusal((document) => {
            document.sweepAllergenDietRules.allergenVocabulary.push('milk');
        });

        expect(error.message).toContain('allergenVocabulary');
        expect(error.message).toContain('more than once');
    });

    it('refuses a marker table that has stopped asking about a class', () => {
        // The vocabulary still names all nine, so nothing here is "unknown" —
        // but with no markers, `sesame` is reachable only where a food group
        // seeds it, and the sweep's groups are coarser than its allergens.
        const error = refusal((document) => {
            delete document.sweepAllergenDietRules.descriptionAllergenMarkers.sesame;
        });

        expect(error.message).toContain('descriptionAllergenMarkers');
        expect(error.message).toContain('sesame');
    });

    it('refuses a manifest that does not say which coverage plan it is written against', () => {
        // Without this field the cross-plan check has nothing to compare, which
        // would quietly downgrade it to "whichever plan the caller loaded".
        const error = refusal((document) => {
            delete document.coveragePlanVersion;
        });

        expect(error.message).toContain('coveragePlanVersion');
    });

    it('refuses an entry that names its record by a rule instead of an id', () => {
        // The form the plan used to SKIP in silence: an entry the contract
        // calls valid, describing a record by name for the import to resolve.
        // Nothing resolved it, so the record was never fetched and the category
        // it was curated for came up short with no line anywhere saying why.
        // There is one identity form now, and a document still using the other
        // is refused where it is read.
        const error = refusal((document) => {
            const entry = document.foods[3];
            delete entry.fdcId;
            entry.resolveBy = { description: 'Tomato, raw', dataType: 'SR Legacy' };
        });

        expect(error.message).toContain('foods[3]');
        expect(error.message).toContain('resolveBy');
        // And it says what to do about it, because the fix is a curation step
        // and not a code change.
        expect(error.message).toContain('fdcId');
    });

    it('refuses an entry with no vendor id at all', () => {
        const error = refusal((document) => {
            delete document.foods[7].fdcId;
        });

        expect(error.message).toContain('foods[7]');
        expect(error.message).toContain('fdcId');
    });

    it('refuses a category, food state, data type or cost class outside its vocabulary', () => {
        expect(refusal((document) => {
            document.foods[0].category = 'produce_vegetables';
        }).message).toContain('category');

        expect(refusal((document) => {
            document.foods[0].foodState = 'uncooked';
        }).message).toContain('foodState');

        expect(refusal((document) => {
            document.foods[0].usdaDataType = 'Foundational';
        }).message).toContain('usdaDataType');

        expect(refusal((document) => {
            document.foods[0].costClass = 4;
        }).message).toContain('costClass');
    });

    it('refuses a misspelled allergen class, and a reviewed entry missing its allergen status', () => {
        // `tree nuts` for `tree_nuts` is the whole defect: the tag is stored,
        // matches nothing the app filters on, and the food reads as safe for
        // someone avoiding tree nuts.
        const typo = refusal((document) => {
            document.foods[0].reviewedSafety.allergenTags = ['tree nuts'];
        });
        expect(typo.message).toContain('allergen');

        const missing = refusal((document) => {
            delete document.foods[0].reviewedSafety.allergenStatus;
        });
        expect(missing.message).toContain('allergenStatus');
    });

    it('refuses a sweep whose page bound contradicts its own measurement, or the vendor cap', () => {
        // `maxPages` is a backstop ABOVE the measured last page, which is what
        // lets a grown dataset be imported. A document stating it
        // below the measurement describes a truncation instead of a backstop.
        const truncating = refusal((document) => {
            document.datasetSweeps[1].maxPages = 3;
        });
        expect(truncating.message).toContain('maxPages');
        expect(truncating.message).toContain('observedLastNonEmptyPage');

        // 200 is `/foods/list`'s documented maximum; a larger page is silently
        // clamped by the vendor, so the plan's page arithmetic would be wrong
        // about how much it had seen.
        const oversized = refusal((document) => {
            document.datasetSweeps[0].pageSize = 500;
        });
        expect(oversized.message).toContain('pageSize');
    });

    it('refuses two sweeps under one key, and two entries for one vendor id', () => {
        const sweeps = refusal((document) => {
            document.datasetSweeps[1].sweepKey = document.datasetSweeps[0].sweepKey;
        });
        expect(sweeps.message).toContain('sweepKey');

        const ids = refusal((document) => {
            document.foods[1].fdcId = document.foods[0].fdcId;
        });
        expect(ids.message).toContain('fdcId');
    });

    it('refuses a configured import rate above the vendor’s own hourly cap', () => {
        // 900 against USDA's 1,000, and the headroom is the point: the same key
        // serves the running API's estimate, label-scan and branded-search
        // traffic, so a document configuring 5,000 does not describe a faster
        // import — it describes an import that exhausts the key the product is
        // using.
        const error = refusal((document) => {
            document.importLimits.configuredRequestsPerHour = 5000;
        });

        expect(error.message).toContain('configuredRequestsPerHour');
    });

    /**
     * THE REQUIREMENT HEADROOM'S ARITHMETIC IS CHECKED, NOT TRUSTED.
     *
     * The block relaxes the per-category candidate-volume cap while a run is
     * below a declared floor, so a malformed one is not a field a stage reads
     * as `undefined` — it is a run that admits either nothing extra or
     * everything, and publishes a count nobody can re-derive. The committed
     * document must pass, each field must be required, and the two relations
     * that make the floor an argument rather than an assertion must be
     * enforced: the floor reaches the requirement, and it reaches what the
     * requirement needs at the measured publish rate.
     */
    describe('the requirement headroom', () => {
        it('accepts the committed block and narrows it', () => {
            const accepted = assertUsdaManifestShape(clone(), USDA_MANIFEST_FILE);
            const headroom = accepted.requirementHeadroom;

            expect(headroom).toBeDefined();
            expect(headroom?.requiredPublishedItems).toBe(10000);
            // The floor has to reach the requirement at the rate beside it, so
            // this is the relation the document itself must satisfy rather than
            // a literal this test pins.
            expect(headroom?.plannedVolumeFloor).toBeGreaterThanOrEqual(
                Math.ceil((headroom?.requiredPublishedItems ?? 0) / (headroom?.measuredPublishRate ?? 1)),
            );
            expect(headroom?.countedAs).toBe('admittedByRequirementHeadroom');
            expect(headroom?.rule.length).toBeGreaterThan(0);
            expect(headroom?.arithmetic.length).toBeGreaterThan(0);
        });

        it('accepts a document that declares none, which is the previous behaviour', () => {
            // Optional by design: without the block every sweep holds to the
            // per-category volumes with no floor under the run's total, exactly
            // as it did before the block existed.
            const document = clone();
            delete document.requirementHeadroom;

            expect(assertUsdaManifestShape(document, USDA_MANIFEST_FILE).requirementHeadroom).toBeUndefined();
        });

        it('refuses a floor below the requirement it serves', () => {
            // Not every planned record publishes, so a floor at or under the
            // requirement cannot reach it even in the best case.
            const error = refusal((document) => {
                document.requirementHeadroom.plannedVolumeFloor = 9_000;
            });

            expect(error.message).toContain('plannedVolumeFloor');
            expect(error.message).toContain('requiredPublishedItems');
        });

        it('refuses a floor the measured publish rate cannot carry to the requirement', () => {
            // 10,100 planned records at 0.94192 publish about 9,513 — short of
            // 10,000 — so the floor and the rate beside it contradict each
            // other and the document is refused rather than run.
            const error = refusal((document) => {
                document.requirementHeadroom.plannedVolumeFloor = 10_100;
            });

            expect(error.message).toContain('below the 10617');
            expect(error.message).toContain('measured publish rate');
        });

        it('refuses a publish rate above 1, which no run can measure', () => {
            const error = refusal((document) => {
                document.requirementHeadroom.measuredPublishRate = 1.2;
            });

            expect(error.message).toContain('measuredPublishRate');
            expect(error.message).toContain('above 1');
        });

        it('refuses a block missing any of the fields that justify the floor', () => {
            for (const field of [
                'requiredPublishedItems',
                'plannedVolumeFloor',
                'measuredPublishRate',
                'measuredOn',
                'measuredFrom',
                'rule',
                'arithmetic',
                'countedAs',
            ]) {
                const error = refusal((document) => {
                    delete document.requirementHeadroom[field];
                });

                expect(error.message).toContain(`requirementHeadroom.${field}`);
            }
        });
    });

    it('refuses the document through the loader, not only when asked directly', () => {
        // The narrowing has to be the LOADER's, or every caller is trusting the
        // cast again. Proven by handing the loader's own checker a document it
        // must reject: `loadUsdaManifest` passes `assertUsdaManifestShape` as
        // its shape check, and this is that function.
        expect(() => assertUsdaManifestShape({ usdaManifestVersion: 'v1' }, USDA_MANIFEST_FILE)).toThrow(ManifestError);
        // And the real loader still answers, which is the other half: a checker
        // wired in wrongly would fail here rather than in a mutation case.
        expect(loadUsdaManifest().foods.length).toBeGreaterThan(0);
    });
});

/**
 * THE CROSS-DOCUMENT HALF, SPLIT BY WHAT IT COSTS.
 *
 * `assertUsdaManifestShape` can only check the manifest against itself. Whether
 * a category it files under is a category the coverage plan TARGETS, and
 * whether a food group belongs to that category, are facts about a second
 * document — and the manifest's own `coveragePlanContract` assigns the check to
 * the importer and requires it before the first vendor request.
 *
 * The two halves of the answer cost different things, which is why they are
 * returned separately — a filing disagreement mis-files every record it
 * touches, while a derivation table KEYED on a food group no record can carry
 * applies to nothing — but BOTH are fatal, and the history is why.
 *
 * The committed documents once carried thirty keys of the second kind, left
 * behind by a taxonomy rename: twenty-one in `byFoodGroup` and nine in
 * `foodGroupOverrides`, naming food groups such as `bread`, `finfish` and
 * `wheat_flour` that the classifier can no longer produce. Every import
 * reported success throughout, because the only consequence was a log line. An
 * allergen seed a curator wrote and the importer never applies does not read as
 * "not determined" — it reads as "contains none of it".
 *
 * They are reconciled now (each re-keyed onto a food group the plan declares,
 * or dropped where a live rule already covers its intent), so the assertions
 * below can require BOTH lists to be empty for the shipped pair and require a
 * refusal for either kind.
 */
describe('the manifest is checked against the coverage plan', () => {
    it('finds no filing disagreement between the committed documents', () => {
        const agreement = checkManifestAgainstCoveragePlan(manifest, coveragePlan);

        // The assertion that makes the fatal half meaningful: the shipped pair
        // agrees, so a failure here is a real regression in one of the two
        // documents rather than a threshold nobody meets.
        expect(agreement.filingMismatches).toEqual([]);
    });

    it('finds no inert derivation key in the committed documents', () => {
        const agreement = checkManifestAgainstCoveragePlan(manifest, coveragePlan);

        // Asserted as an exact empty list rather than a tolerance, because the
        // whole point of the reconciliation is that there is no acceptable
        // number of keys that tag nothing. Named in the failure so a future
        // taxonomy edit reports WHICH key it stranded rather than a count.
        expect(agreement.inertPolicyKeys).toEqual([]);
    });

    it('names an inert allergen key, saying which table and which food group', () => {
        // `byFoodGroup` is a plain string-keyed map, so this drift IS
        // representable in the type — unlike the filing cases below, no cast is
        // needed, which is precisely why it went unnoticed for thirty keys.
        const stranded: UsdaManifest = {
            ...manifest,
            sweepAllergenDietRules: {
                ...manifest.sweepAllergenDietRules,
                byFoodGroup: { ...manifest.sweepAllergenDietRules.byFoodGroup, wheat_flour: ['wheat'] },
            },
        };

        const agreement = checkManifestAgainstCoveragePlan(stranded, coveragePlan);
        expect(agreement.filingMismatches).toEqual([]);
        expect(agreement.inertPolicyKeys).toHaveLength(1);
        expect(agreement.inertPolicyKeys[0]).toContain('sweepAllergenDietRules.byFoodGroup.wheat_flour');
        expect(agreement.inertPolicyKeys[0]).toContain('tags no record');
    });

    it('names an inert cost-class key the same way', () => {
        const stranded: UsdaManifest = {
            ...manifest,
            sweepCostClassRules: {
                ...manifest.sweepCostClassRules,
                foodGroupOverrides: { ...manifest.sweepCostClassRules.foodGroupOverrides, fresh_herb: 3 },
            },
        };

        const agreement = checkManifestAgainstCoveragePlan(stranded, coveragePlan);
        expect(agreement.inertPolicyKeys).toHaveLength(1);
        expect(agreement.inertPolicyKeys[0]).toContain('sweepCostClassRules.foodGroupOverrides.fresh_herb');
        expect(agreement.inertPolicyKeys[0]).toContain('applies to no record');
    });

    it('refuses a manifest written against a different coverage plan version', () => {
        // The check that makes every other check below mean something: all of
        // them read the loaded plan as the authority on what a heading is, so
        // comparing against a plan this manifest was not written for proves
        // only that the two happen to share some names.
        const drifted: UsdaManifest = { ...manifest, coveragePlanVersion: 'v999' };

        const agreement = checkManifestAgainstCoveragePlan(drifted, coveragePlan);
        expect(agreement.filingMismatches).toHaveLength(1);
        expect(agreement.filingMismatches[0]).toContain('v999');
        expect(agreement.filingMismatches[0]).toContain(coveragePlan.coveragePlanVersion);
    });

    it('treats a curated entry filed under a category the plan does not target as fatal', () => {
        // Cast through `unknown` because the drift is UNREPRESENTABLE in the
        // type: `category` is a union, so TypeScript refuses the bad value —
        // which is exactly why the runtime check exists. A JSON document is not
        // typechecked, and this is what one of them looks like.
        const drifted: UsdaManifest = {
            ...manifest,
            foods: [
                { ...manifest.foods[0], category: 'produce_vegetable_fresh' } as unknown as UsdaManifestFood,
                ...manifest.foods.slice(1),
            ],
        };

        const agreement = checkManifestAgainstCoveragePlan(drifted, coveragePlan);
        expect(agreement.filingMismatches).toHaveLength(1);
        expect(agreement.filingMismatches[0]).toContain('produce_vegetable_fresh');
        expect(agreement.filingMismatches[0]).toContain('coverage-plan does not declare');
    });

    it('treats a food group filed under the wrong category as fatal, naming both categories', () => {
        // The subtlest of the three, and the one a version check can never
        // catch: both names exist, so nothing is unknown — the record is simply
        // counted against one category's target while behaving as another's.
        const group = coveragePlan.foodGroups[0];
        const otherCategory = coveragePlan.categories.find((row) => row.category !== group.category);
        expect(otherCategory).toBeDefined();

        const drifted: UsdaManifest = {
            ...manifest,
            foods: [
                {
                    ...manifest.foods[0],
                    foodGroup: group.foodGroup,
                    // Both names are real and both are declared: nothing here
                    // is unknown, which is why only a cross-document check
                    // finds it.
                    category: (otherCategory as CoveragePlanCategory).category,
                },
                ...manifest.foods.slice(1),
            ],
        };

        const agreement = checkManifestAgainstCoveragePlan(drifted, coveragePlan);
        expect(agreement.filingMismatches).toHaveLength(1);
        expect(agreement.filingMismatches[0]).toContain(group.foodGroup);
        expect(agreement.filingMismatches[0]).toContain(group.category);
    });

    it('stops a run on a filing disagreement, before the limiter and the first request', async () => {
        const listFoods = jest.fn(async (): Promise<UsdaFoodSummary[]> => []);
        let limiterInstalled = false;
        const deps = {
            db: ledgerOnlyCatalogDb('a coverage-plan disagreement'),
            runDb: prisma,
            usda: {
                listFoods,
                getFoodsBatch: async (): Promise<UsdaFoodDetail[]> => {
                    throw new Error('a disagreeing manifest must not reach the vendor');
                },
                describeBatchRetrieval: async (fdcIds: readonly number[]): Promise<UsdaBatchRetrieval> =>
                    retrieval(fdcIds),
            },
            manifest: {
                ...manifest,
                usdaManifestVersion: 'v1+suite:coverage-plan-disagreement',
                foods: [{ ...manifest.foods[0], category: 'produce_vegetable_fresh' } as unknown as UsdaManifestFood],
                datasetSweeps: [],
            },
            coveragePlan,
            options: options(),
            logger: silentLogger,
            now: () => new Date('2026-09-14T09:00:00.000Z'),
            installRateLimiter: (): (() => void) => {
                limiterInstalled = true;

                return (): void => undefined;
            },
            writeReport: () => undefined,
        } as unknown as RunImportDeps;

        const failure = await runImport(deps).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogImportError);
        expect((failure as CatalogImportError).code).toBe('manifest_coverage_mismatch');
        // Before the limiter, before any listing, and before a run row exists:
        // stopping halfway through an import is strictly worse to recover from
        // than stopping at the start, and there is nothing to recover here.
        expect(limiterInstalled).toBe(false);
        expect(listFoods).not.toHaveBeenCalled();
        expect(
            await prisma.catalog_import_runs.count({
                where: { manifest_version: 'v1+suite:coverage-plan-disagreement' },
            }),
        ).toBe(0);
    });

    it('accepts the committed pair without warning about anything', () => {
        const warnings: { event: string; fields: unknown }[] = [];
        const recordingLogger: ScriptLogger = {
            ...silentLogger,
            warn: (event: string, fields?: unknown) => {
                warnings.push({ event, fields });
            },
            child: () => recordingLogger,
        };

        // A bare `catalog:import` on the shipped documents must get past this
        // gate cleanly. Asserted with no mutation, because a check this strict
        // is only safe if the committed pair actually satisfies it — otherwise
        // the fix below would have made the importer unrunnable.
        const agreement = assertManifestMatchesCoveragePlan(manifest, coveragePlan, recordingLogger);

        expect(agreement.filingMismatches).toEqual([]);
        expect(agreement.inertPolicyKeys).toEqual([]);
        expect(agreement.volumeMismatches).toEqual([]);
        expect(warnings).toEqual([]);
    });

    it('bounds the requirement headroom by the coverage plan its floor sits inside', () => {
        // THE UPPER BOUND THAT MAKES THE HEADROOM BOUNDED. The manifest's own
        // shape check enforces the LOWER one (the floor reaches the requirement
        // at the measured publish rate) and cannot see the plan. A floor at or
        // above the plan's whole candidate volume could not be reached before
        // the plan ran out of volume, so every category would admit records for
        // the entire sweep and the per-category cap would stop applying
        // altogether — the unconditional removal this rule exists to avoid,
        // wearing a declared exception's clothes.
        const planVolumeTotal =
            coveragePlan.candidateVolumeTotal ??
            coveragePlan.categories.reduce((total, row) => total + row.candidateVolume, 0);
        expect(manifest.requirementHeadroom?.plannedVolumeFloor).toBeLessThanOrEqual(planVolumeTotal);

        const overreaching: UsdaManifest = {
            ...manifest,
            requirementHeadroom: {
                ...(manifest.requirementHeadroom as NonNullable<UsdaManifest['requirementHeadroom']>),
                plannedVolumeFloor: planVolumeTotal + 1,
            },
        };

        const agreement = checkManifestAgainstCoveragePlan(overreaching, coveragePlan);
        expect(agreement.filingMismatches).toEqual([]);
        expect(agreement.inertPolicyKeys).toEqual([]);
        expect(agreement.volumeMismatches).toHaveLength(1);
        expect(agreement.volumeMismatches[0]).toContain('plannedVolumeFloor');
        expect(agreement.volumeMismatches[0]).toContain(String(planVolumeTotal));

        // And it is as fatal as the other two halves: reported without being
        // refused is how the previous inert-key drift survived thirty keys.
        const failure = ((): unknown => {
            try {
                assertManifestMatchesCoveragePlan(overreaching, coveragePlan, silentLogger);
            } catch (error) {
                return error;
            }
            return null;
        })();

        expect(failure).toBeInstanceOf(CatalogImportError);
        expect((failure as CatalogImportError).code).toBe('manifest_headroom_above_plan_volume');
    });

    it('stops a run on an inert derivation key, before the limiter and the first request', async () => {
        const listFoods = jest.fn(async (): Promise<UsdaFoodSummary[]> => []);
        let limiterInstalled = false;
        const deps = {
            db: ledgerOnlyCatalogDb('an inert derivation key'),
            runDb: prisma,
            usda: {
                listFoods,
                getFoodsBatch: async (): Promise<UsdaFoodDetail[]> => {
                    throw new Error('a manifest with a stranded policy key must not reach the vendor');
                },
                describeBatchRetrieval: async (fdcIds: readonly number[]): Promise<UsdaBatchRetrieval> =>
                    retrieval(fdcIds),
            },
            manifest: {
                ...manifest,
                usdaManifestVersion: 'v1+suite:inert-policy-key',
                // Nothing is mis-filed here: every food and every rule files
                // correctly, and the only defect is a key that matches no
                // record. That is the shape the thirty committed keys had, and
                // the run must refuse it rather than log it.
                sweepAllergenDietRules: {
                    ...manifest.sweepAllergenDietRules,
                    byFoodGroup: {
                        ...manifest.sweepAllergenDietRules.byFoodGroup,
                        canned_fish: ['fish'],
                    },
                },
                datasetSweeps: [],
            },
            coveragePlan,
            options: options(),
            logger: silentLogger,
            now: () => new Date('2026-09-14T09:00:00.000Z'),
            installRateLimiter: (): (() => void) => {
                limiterInstalled = true;

                return (): void => undefined;
            },
            writeReport: () => undefined,
        } as unknown as RunImportDeps;

        const failure = await runImport(deps).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogImportError);
        expect((failure as CatalogImportError).code).toBe('manifest_inert_policy_keys');
        expect((failure as CatalogImportError).message).toContain('canned_fish');
        expect(limiterInstalled).toBe(false);
        expect(listFoods).not.toHaveBeenCalled();
        expect(
            await prisma.catalog_import_runs.count({
                where: { manifest_version: 'v1+suite:inert-policy-key' },
            }),
        ).toBe(0);
    });

    it('stops a run on a coverage-plan version it was not written against', async () => {
        const listFoods = jest.fn(async (): Promise<UsdaFoodSummary[]> => []);
        let limiterInstalled = false;
        const deps = {
            db: ledgerOnlyCatalogDb('a coverage-plan version mismatch'),
            runDb: prisma,
            usda: {
                listFoods,
                getFoodsBatch: async (): Promise<UsdaFoodDetail[]> => {
                    throw new Error('a manifest written against another plan must not reach the vendor');
                },
                describeBatchRetrieval: async (fdcIds: readonly number[]): Promise<UsdaBatchRetrieval> =>
                    retrieval(fdcIds),
            },
            manifest: {
                ...manifest,
                usdaManifestVersion: 'v1+suite:plan-version-drift',
                coveragePlanVersion: 'v999',
                datasetSweeps: [],
            },
            coveragePlan,
            options: options(),
            logger: silentLogger,
            now: () => new Date('2026-09-14T09:00:00.000Z'),
            installRateLimiter: (): (() => void) => {
                limiterInstalled = true;

                return (): void => undefined;
            },
            writeReport: () => undefined,
        } as unknown as RunImportDeps;

        const failure = await runImport(deps).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogImportError);
        expect((failure as CatalogImportError).code).toBe('manifest_coverage_mismatch');
        expect((failure as CatalogImportError).message).toContain('v999');
        expect(limiterInstalled).toBe(false);
        expect(listFoods).not.toHaveBeenCalled();
    });
});

/**
 * AN UNDECLARED `--category` IS A REFUSAL, NOT A NARROW RUN
 * (CATIMP-unknown-category-noop).
 *
 * WHAT WAS WRONG. The values were collected by `parseArgs` and applied by
 * membership (`inScope` in `buildImportPlan`), and nothing checked them against
 * the document that defines the vocabulary. So `--category not_a_category`
 * matched no manifest entry and no swept record: the whole work list landed
 * under `skippedCategoryFilter`, the plan held zero batches and the stage
 * completed — exit 0 on a run that imported nothing, while the two sibling
 * stages refuse the same typo with `unknown_category` (generation) and
 * `unknown_category_filter` (reporting).
 *
 * The first case below pins the no-op these refusals prevent, so the reason for
 * the refusal stays visible rather than becoming folklore; the rest pin the
 * refusal itself and that a DECLARED filter is untouched by it.
 */
describe('an undeclared --category is refused rather than run as a no-op', () => {
    const declaredCategories = coveragePlan.categories.map((row) => row.category as string);

    const sweptRow = (index: number): UsdaFoodSummary => ({
        fdcId: 950000 + index,
        description: `Carrots, raw, sample ${index}`,
        dataType: 'SR Legacy',
    });

    it('would otherwise plan nothing at all, which is why it cannot be allowed to run', async () => {
        const listFoods = async (_dataType: string, _pageSize: number, page: number): Promise<UsdaFoodSummary[]> =>
            page === 1 ? [sweptRow(0), sweptRow(1)] : [];

        const plan = await buildImportPlan(
            manifest,
            coveragePlan,
            listFoods,
            options({ categories: ['not_a_category'] }),
            silentLogger,
        );

        // Nothing to fetch, nothing to write, and a counter that says the
        // filter refused the entire work list — the honest report of a run an
        // operator cannot distinguish from a finished import by its exit code.
        expect(plan.batches).toEqual([]);
        expect(plan.assignments.size).toBe(0);
        // Every curated entry plus every swept row this listing offered (two
        // per sweep), so the counter accounts for the whole work list and not
        // merely for part of it.
        expect(plan.skipped.skippedCategoryFilter).toBe(curatedEntries.length + manifest.datasetSweeps.length * 2);
    });

    it('names every undeclared value and every declared category, sorted', () => {
        const failure = ((): unknown => {
            try {
                assertCategoryFiltersDeclared(coveragePlan, ['not_a_category', 'protein_egg', 'dariy'], silentLogger);
            } catch (error) {
                return error;
            }
            return null;
        })();

        expect(failure).toBeInstanceOf(CatalogImportError);
        expect((failure as CatalogImportError).code).toBe('unknown_category_filter');
        // The operator's two mistakes in the order they typed them, and the
        // declared vocabulary they have to choose from — the declared list is
        // sorted so two runs of the same refusal read identically.
        expect((failure as CatalogImportError).message).toContain('--category not_a_category, dariy');
        expect((failure as CatalogImportError).message).toContain([...declaredCategories].sort().join(', '));
        expect((failure as CatalogImportError).message).toContain(COVERAGE_PLAN_FILE);
    });

    it('reports the declared vocabulary as fields, because the message never reaches a log', () => {
        // `safeError` withholds `message` (it is where a URL bearing `api_key=`
        // would appear), so the code alone reaches the operator's log stream.
        // The remedy therefore travels as data on a named line of its own.
        const errors: { event: string; fields?: Record<string, unknown> }[] = [];
        const recordingLogger: ScriptLogger = {
            ...silentLogger,
            error: (event: string, fields?: Record<string, unknown>) => {
                errors.push({ event, fields });
            },
            child: () => recordingLogger,
        };

        expect(() => assertCategoryFiltersDeclared(coveragePlan, ['not_a_category'], recordingLogger)).toThrow(
            CatalogImportError,
        );

        expect(errors).toHaveLength(1);
        expect(errors[0].event).toBe('unknown_category_filter');
        expect(errors[0].fields?.undeclaredCategories).toEqual(['not_a_category']);
        expect(errors[0].fields?.declaredCategories).toEqual([...declaredCategories].sort());
        expect(String(errors[0].fields?.remedy)).toContain(COVERAGE_PLAN_FILE);
    });

    it('de-duplicates a value the operator repeated', () => {
        expect(undeclaredCategoryFilters(coveragePlan, ['dariy', 'dariy', 'protein_egg'])).toEqual(['dariy']);
    });

    it('passes every declared category, and an empty filter, with no log line', () => {
        const errors: string[] = [];
        const recordingLogger: ScriptLogger = {
            ...silentLogger,
            error: (event: string) => {
                errors.push(event);
            },
            child: () => recordingLogger,
        };

        expect(undeclaredCategoryFilters(coveragePlan, declaredCategories)).toEqual([]);
        expect(undeclaredCategoryFilters(coveragePlan, [])).toEqual([]);
        // The whole declared vocabulary at once, and the no-filter default a
        // bare `catalog:import` gets: a gate the shipped plan cannot pass would
        // make the stage unrunnable.
        expect(() => assertCategoryFiltersDeclared(coveragePlan, declaredCategories, recordingLogger)).not.toThrow();
        expect(() => assertCategoryFiltersDeclared(coveragePlan, [], recordingLogger)).not.toThrow();
        expect(errors).toEqual([]);
    });

    it('leaves a declared filter planning exactly what it planned before', async () => {
        const listFoods = async (_dataType: string, _pageSize: number, page: number): Promise<UsdaFoodSummary[]> =>
            page === 1 ? [sweptRow(0), sweptRow(1)] : [];
        const wanted = curatedEntries[0].category as string;

        const plan = await buildImportPlan(
            manifest,
            coveragePlan,
            listFoods,
            options({ categories: [wanted] }),
            silentLogger,
        );

        const categoryOf = (assignment: ImportAssignment): string =>
            assignment.kind === 'curated' ? (assignment.entry.category as string) : (assignment.category as string);

        expect(undeclaredCategoryFilters(coveragePlan, [wanted])).toEqual([]);
        expect(plan.assignments.size).toBeGreaterThan(0);
        expect([...plan.assignments.values()].every((assignment) => categoryOf(assignment) === wanted)).toBe(true);
    });
});

describe('reviewed allergen and diet metadata (N01)', () => {
    it('gives every curated manifest entry a reviewed safety determination', () => {
        const missing = curatedEntries.filter((entry) => entry.reviewedSafety === undefined);
        expect(missing.map((entry) => entry.canonicalName)).toEqual([]);
    });

    it('states the curated-safety contract in the manifest itself', () => {
        expect(typeof manifest.curatedSafetyContract).toBe('string');
        expect((manifest.curatedSafetyContract ?? '').length).toBeGreaterThan(0);
    });

    /**
     * The nine classes the product asks about, written here and not read from
     * the document under test.
     *
     * WHY THIS LIST IS NOT `manifest.sweepAllergenDietRules.allergenVocabulary`.
     * The matrix below used to be driven from that field, which makes it
     * self-certifying: a vocabulary truncated to three entries registers three
     * cases, all three pass, and the suite reports a green matrix for a document
     * that had stopped asking about milk. A test whose coverage is chosen by its
     * subject cannot detect the subject shrinking.
     *
     * So the classes come from the requirement — the multi-select the product
     * specifies (AAP 0.1.2: "Milk, Eggs, Peanuts, Tree nuts, Soy, Wheat, Fish,
     * Shellfish, Sesame"), which is also `allergens` on
     * `meal_plan_preferences` and what `isEligibleForPlanning` excludes on — and
     * the manifest's vocabulary is asserted EQUAL to them below. Either half
     * alone is insufficient: the equality check without the fixed list is
     * circular, and the fixed list without the equality check would let the
     * document carry a tenth class nothing exercises.
     */
    const REQUIRED_ALLERGEN_CLASSES: readonly string[] = [
        'milk',
        'eggs',
        'peanuts',
        'tree_nuts',
        'soy',
        'wheat',
        'fish',
        'shellfish',
        'sesame',
    ];

    it('asks about exactly the nine allergen classes the product specifies', () => {
        // Sorted set equality, so the assertion is about membership rather than
        // declaration order, and a duplicate entry (which `it.each` would
        // silently run twice) fails the length comparison.
        const vocabulary = manifest.sweepAllergenDietRules.allergenVocabulary;
        expect([...vocabulary].sort()).toEqual([...REQUIRED_ALLERGEN_CLASSES].sort());
        expect(new Set(vocabulary).size).toBe(REQUIRED_ALLERGEN_CLASSES.length);
        // The marker table is keyed by these same classes, and a key outside
        // them writes a tag no exclusion reads (`assertUsdaManifestShape`
        // refuses that document; this states the expectation from the suite's
        // side, where a curator will read it).
        expect(Object.keys(manifest.sweepAllergenDietRules.descriptionAllergenMarkers).sort()).toEqual(
            [...REQUIRED_ALLERGEN_CLASSES].sort(),
        );
        // The third leg of the triangle, and the one that makes the runtime
        // validator trustworthy rather than merely present: the constant
        // `assertUsdaManifestShape` measures documents against is itself
        // measured here, against a list written independently of it. Document ==
        // validator == requirement, so no single edit can move all three.
        expect([...ALLERGEN_CLASSES].sort()).toEqual([...REQUIRED_ALLERGEN_CLASSES].sort());
    });

    // One case per allergen class the product asks about — from the fixed list,
    // so a class the document stops declaring still runs here and fails on that
    // class by name rather than quietly not being tested at all.
    it.each(REQUIRED_ALLERGEN_CLASSES)('carries the reviewed %s determination onto the row', (allergen) => {
        const entry = entryCarrying(allergen);
        // Every one of the nine is represented in the reviewed set; if the
        // reviewed data ever stops covering a class, that is the failure.
        expect(entry).toBeDefined();
        const prepared = prepareCatalogFood(
            detailFor(entry as UsdaManifestFood),
            { kind: 'curated', entry: entry as UsdaManifestFood },
            manifest,
            new Date('2026-09-13T11:00:00.000Z'),
            retrieval([(entry as UsdaManifestFood & { fdcId: number }).fdcId]),
        );
        expect(prepared.candidate.allergen_tags).toContain(allergen);
        expect(prepared.candidate.allergen_status).toBe(entry?.reviewedSafety?.allergenStatus);
        expect(prepared.row.diet_tags.slice().sort()).toEqual(
            [...(entry?.reviewedSafety?.dietTags ?? [])].sort(),
        );
    });

    it('never marks a food known without a reviewed determination that says so', () => {
        const unreviewed: UsdaManifestFood = {
            ...(curatedEntries[0] as UsdaManifestFood),
            reviewedSafety: undefined,
        };
        const prepared = prepareCatalogFood(
            detailFor(unreviewed),
            { kind: 'curated', entry: unreviewed },
            manifest,
            new Date(),
            retrieval([curatedEntries[0].fdcId]),
        );
        expect(prepared.candidate.allergen_status).toBe('unknown');
        expect(prepared.candidate.allergen_tags).toEqual([]);
        expect(prepared.row.diet_tags).toEqual([]);
        expect(prepared.assumptions.join(' ')).toContain('no reviewed allergen determination');
    });

    it('carries a reviewed tag list whose completeness the review did not establish, as a declared floor', () => {
        const partiallyReviewed: UsdaManifestFood = {
            ...(curatedEntries[0] as UsdaManifestFood),
            reviewedSafety: { allergenStatus: 'unknown', allergenTags: ['wheat'], dietTags: ['vegan'] },
        };
        const prepared = prepareCatalogFood(
            detailFor(partiallyReviewed),
            { kind: 'curated', entry: partiallyReviewed },
            manifest,
            new Date(),
            retrieval([curatedEntries[0].fdcId]),
        );
        // The tag survives — it is a reviewed fact — while the status keeps the
        // food out of every plan and the record says the list is a floor.
        expect(prepared.candidate.allergen_tags).toEqual(['wheat']);
        expect(prepared.candidate.allergen_status).toBe('unknown');
        expect(prepared.assumptions.join(' ')).toContain('the tags are a floor');
    });

    it('never claims a swept record\'s allergens are known', () => {
        const assignment: ImportAssignment = {
            kind: 'sweep',
            sweepKey: 'sr_legacy',
            category: 'bread_bakery',
            foodGroup: 'bread',
            classified: true,
        };
        const prepared = prepareCatalogFood(
            {
                fdcId: 999001,
                description: 'Bread, whole-wheat, commercially prepared',
                dataType: 'SR Legacy',
                publicationDate: '4/1/2019',
                foodNutrients: [
                    { nutrientNumber: manifest.nutrientNumbers.protein, value: 13 },
                    { nutrientNumber: manifest.nutrientNumbers.fat, value: 3.5 },
                    { nutrientNumber: manifest.nutrientNumbers.carbs, value: 43 },
                    { nutrientNumber: manifest.nutrientNumbers.calories, value: 252 },
                ],
            },
            assignment,
            manifest,
            new Date(),
            retrieval([999001]),
        );
        expect(prepared.candidate.allergen_status).toBe('unknown');
        expect(prepared.assumptions.join(' ')).toContain('not reviewed');
    });
});

describe('nutrition method agrees with the assumptions', () => {
    const base = curatedEntries[0] as UsdaManifestFood;

    it('denies any derivation when the record stated its own energy', () => {
        const prepared = prepareCatalogFood(
            detailFor(base),
            { kind: 'curated', entry: base },
            manifest,
            new Date(),
            retrieval([base.fdcId as number]),
        );
        expect(prepared.nutritionMethod).toContain('nothing was scaled, derived or estimated');
        expect(prepared.assumptions.join(' ')).not.toContain('calories derived');
    });

    it('states the derivation when energy came from the record\'s own macros', () => {
        const noEnergy = detailFor(base);
        const prepared = prepareCatalogFood(
            {
                ...noEnergy,
                foodNutrients: (noEnergy.foodNutrients ?? []).filter(
                    (nutrient) => String(nutrient.nutrientNumber) !== String(manifest.nutrientNumbers.calories),
                ),
            },
            { kind: 'curated', entry: base },
            manifest,
            new Date(),
            retrieval([base.fdcId as number]),
        );
        expect(prepared.candidate.calories).toBeCloseTo(4 * 10 + 4 * 20 + 9 * 5, 6);
        expect(prepared.nutritionMethod).toContain('energy was derived');
        expect(prepared.nutritionMethod).not.toContain('nothing was scaled, derived or estimated');
        expect(prepared.assumptions.join(' ')).toContain('calories derived');
    });
});

describe('identity evidence records the retrieval that happened', () => {
    const base = curatedEntries[0] as UsdaManifestFood;

    const prepared = (
        source: UsdaBatchRetrieval['source'],
        cachedAt: Date | null,
        digest: string,
        httpStatus: number | null = 200,
    ) =>
        prepareCatalogFood(
            detailFor(base),
            { kind: 'curated', entry: base },
            manifest,
            new Date('2026-09-13T11:00:00.000Z'),
            {
                requestedFdcIds: [base.fdcId as number, 12345],
                cacheKey: 'POST /foods?#{"fdcIds":[12345,99999],"format":"full"}',
                responseSha256: digest,
                source,
                httpStatus,
                cachedAt,
            },
        );

    it('names the batch endpoint and method, never a per-food GET', () => {
        const evidence = prepared('usda_api_cache', new Date('2026-09-13T09:11:40.243Z'), 'b'.repeat(64)).evidence;
        expect(evidence.url).toBe('https://api.nal.usda.gov/fdc/v1/foods');
        expect(evidence.method).toBe('POST');
        expect(evidence.url).not.toContain('/fdc/v1/food/');
        expect(evidence.request_body).toEqual({ fdcIds: [base.fdcId, 12345], format: 'full' });
    });

    it('reports the cache row\'s own retrieval time and its recorded status when served from cache', () => {
        const one = prepared('usda_api_cache', new Date('2026-09-13T09:11:40.243Z'), 'b'.repeat(64));
        expect(one.evidence.fetched_at).toBe('2026-09-13T09:11:40.243Z');
        expect(one.evidence.fetched_at_source).toContain('usda_api_cache.fetched_at');
        // The recorded status, not a null inferred from "it came from cache":
        // the exchange that produced the payload really did answer 200, and
        // that is what a retrieval record has to state (AAP §0.3.2).
        expect(one.evidence.http_status).toBe(200);
        expect(one.evidence.http_status_source).toContain('usda_api_cache.http_status');
        expect(one.evidence.body_sha256).toBe('b'.repeat(64));
        expect(one.row.source_cache_key).toBe(one.evidence.source_cache_key);
    });

    it('quotes a recorded status that is not 200 rather than normalising it', () => {
        const one = prepared('usda_api_cache', new Date('2026-09-13T09:11:40.243Z'), 'b'.repeat(64), 201);
        expect(one.evidence.http_status).toBe(201);
    });

    it('falls back to its own clock, and says so, when this run fetched the response', () => {
        const one = prepared('import_run', null, 'c'.repeat(64));
        expect(one.evidence.fetched_at).toBe('2026-09-13T11:00:00.000Z');
        expect(one.evidence.fetched_at_source).toContain('import run clock');
        // This run's observed status, attributed to this run's own exchange.
        expect(one.evidence.http_status).toBe(200);
        expect(one.evidence.http_status_source).toContain("this run's own POST /foods exchange");
        // Always a digest now: the client hands back the payload the records
        // were read out of, so there is nothing for a null to mean.
        expect(one.evidence.body_sha256).toBe('c'.repeat(64));
        expect(one.evidence.body_sha256_subject).toContain("this food's record was read out of");
    });

    /**
     * This pins HONESTY about a null, not its acceptability: a record with no
     * observed status is never published (see the publication case in
     * `persistPreparedFood writes the counters …`), and if one is ever written
     * the evidence has to say which of the three cases it is rather than
     * carrying a 200 nobody saw.
     */
    it('reports a null status as a response older than the ledger, never as a substituted 200', () => {
        const one = prepared('usda_api_cache', new Date('2026-09-13T09:11:40.243Z'), 'b'.repeat(64), null);
        expect(one.evidence.http_status).toBeNull();
        expect(one.evidence.http_status_source).toContain('before that table carried http_status');
        expect(one.evidence.http_status_source).toContain('Not a substituted 200');
        // And the record is unpublishable at the same moment, judged from the
        // record itself rather than from a separate boolean about one of its
        // fields: `importEvidenceAssessment` reads what is about to be written.
        const assessment = importEvidenceAssessment(one);
        expect(assessment.complete).toBe(false);
        expect(evidenceGapCodes(assessment)).toEqual(['retrieval_status_missing']);
    });

    it('finds no gap in a record whose retrieval carried a successful status', () => {
        for (const one of [
            prepared('usda_api_cache', new Date('2026-09-13T09:11:40.243Z'), 'b'.repeat(64), 200),
            prepared('import_run', null, 'c'.repeat(64), 201),
        ]) {
            const assessment = importEvidenceAssessment(one);
            expect(evidenceGapCodes(assessment)).toEqual([]);
            expect(assessment.complete).toBe(true);
            expect(assessment.status).toBe(one.evidence.http_status);
        }
    });

    it('states the cache-key scheme beside the key, so the provenance is checkable', () => {
        const one = prepared('usda_api_cache', new Date('2026-09-13T09:11:40.243Z'), 'b'.repeat(64));
        expect(one.evidence.source_cache_key_scheme).toBe(USDA_SOURCE_CACHE_KEY_SCHEME.shape);
        // The batch key, shared by the response's foods — never the per-food
        // detail path the manifest used to claim, which nothing ever requests.
        expect(one.evidence.source_cache_key).toContain('POST /foods?#');
        expect(one.evidence.source_cache_key_scheme).not.toContain('/food/<fdcId>');
    });

    it('digests the food\'s own record separately and names both digests', () => {
        const one = prepared('usda_api_cache', new Date('2026-09-13T09:11:40.243Z'), 'b'.repeat(64));
        expect(one.evidence.record_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(one.evidence.record_sha256).not.toBe(one.evidence.body_sha256);
        expect(one.evidence.record_sha256_subject).toContain("this food's own record");
    });
});

/**
 * The import stage decides its own disposition with the SHARED complete-evidence
 * predicate (SEC3-validator-publishes-no-evidence).
 *
 * WHAT WAS WRONG. `importPublicationStatus` used to read one boolean about one
 * field — "did the retrieval carry an HTTP status" — while validation, the
 * release exporter and the release loader each assessed the whole record with
 * `assessIdentityEvidence`. So this stage could write a record the other three
 * refuse: a 404 status, a malformed digest, a blank cache key, a blank snippet,
 * an unparseable `fetched_at`, or two spellings of one field disagreeing. The
 * disagreement surfaced only at the stage that had to reject work already done.
 *
 * WHAT THIS BLOCK IS AND IS NOT PROVING. It is defense in depth, not a live
 * publication hole: this stage writes `candidate` or `quarantined` and never
 * `published`. The claim is narrower and checkable — the disposition is now the
 * shared floor's decision over the record that is about to be written, so every
 * mandatory field is enforced at the stage that PRODUCES it, and under the name
 * of the gap.
 */
describe('the import holds a record its own evidence cannot support (SEC3)', () => {
    const base = curatedEntries[0] as UsdaManifestFood;
    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };
    const fetchedAt = new Date('2026-09-14T08:30:00.000Z');

    /** A prepared food whose retrieval evidence is complete, as this stage writes one. */
    const soundRecord = (): PreparedCatalogFood =>
        prepareCatalogFood(detailFor(base), { kind: 'curated', entry: base }, manifest, fetchedAt, {
            requestedFdcIds: [base.fdcId as number],
            cacheKey: 'POST /foods?#{"fdcIds":[' + String(base.fdcId) + '],"format":"full"}',
            responseSha256: 'd'.repeat(64),
            source: 'import_run',
            httpStatus: 200,
            cachedAt: null,
        });

    /**
     * The same food with its evidence record edited.
     *
     * Edited rather than re-prepared, because the point is the RECORD: the
     * candidate, the checks and the verdict are held constant, so a refusal can
     * come from nothing but the evidence.
     */
    const withEvidence = (
        overrides: Record<string, unknown>,
        remove: readonly string[] = [],
    ): PreparedCatalogFood => {
        const one = soundRecord();
        const evidence: Record<string, unknown> = { ...one.evidence, ...overrides };
        for (const field of remove) {
            delete evidence[field];
        }
        return { ...one, evidence: evidence as PreparedCatalogFood['evidence'] };
    };

    const verdictFor = (one: PreparedCatalogFood) => validateCatalogCandidate(one.candidate, policy);

    it('writes a candidate when every mandatory field is present and usable', async () => {
        const one = soundRecord();
        const assessment = importEvidenceAssessment(one);

        expect(evidenceGapCodes(assessment)).toEqual([]);
        expect(assessment.complete).toBe(true);
        expect(assessment.status).toBe(200);
        expect(assessment.finalHost).toBe('api.nal.usda.gov');
        expect(importPublicationStatus(one, verdictFor(one))).toBe('candidate');
    });

    /**
     * Every mandatory field of a USDA retrieval record (AAP §0.3.2), one per
     * case. A USDA row is asked for two fields a generated row is not — the
     * `usda_api_cache` key and the digest of its own record inside that payload
     * — because that is what makes one batch response evidence for one food
     * rather than for the twenty it carried.
     */
    it.each([
        ['url', 'url', 'retrieval_url_missing'],
        ['final_host', 'final_host', 'retrieval_host_missing'],
        ['http_status', 'http_status', 'retrieval_status_missing'],
        ['body_sha256', 'body_sha256', 'retrieval_body_digest_missing'],
        ['record_sha256', 'record_sha256', 'retrieval_record_digest_missing'],
        ['source_cache_key', 'source_cache_key', 'retrieval_source_cache_key_missing'],
        ['matched_snippet', 'matched_snippet', 'retrieval_snippet_missing'],
        ['fetched_at', 'fetched_at', 'retrieval_time_missing'],
    ])('quarantines a record with no %s', (_what, field, code) => {
        const one = withEvidence({}, [field]);

        expect(evidenceGapCodes(importEvidenceAssessment(one))).toEqual([code]);
        expect(importPublicationStatus(one, verdictFor(one))).toBe('quarantined');
    });

    it.each([
        ['a blank url', { url: '   ' }, 'retrieval_url_missing'],
        ['a blank host', { final_host: '' }, 'retrieval_host_missing'],
        ['a truncated body digest', { body_sha256: 'abc123' }, 'retrieval_body_digest_missing'],
        ['a non-hex record digest', { record_sha256: 'z'.repeat(64) }, 'retrieval_record_digest_missing'],
        ['a blank cache key', { source_cache_key: '  ' }, 'retrieval_source_cache_key_missing'],
        ['a blank snippet', { matched_snippet: '' }, 'retrieval_snippet_missing'],
        ['an unparseable retrieval time', { fetched_at: 'soon' }, 'retrieval_time_invalid'],
        ['a retrieval time that is not a real day', { fetched_at: '2026-02-31T00:00:00Z' }, 'retrieval_time_invalid'],
    ])('quarantines a record carrying %s, which a presence check would pass', (_what, overrides, code) => {
        const one = withEvidence(overrides);

        expect(evidenceGapCodes(importEvidenceAssessment(one))).toEqual([code]);
        expect(importPublicationStatus(one, verdictFor(one))).toBe('quarantined');
    });

    it.each([
        ['a client error', 404],
        ['a server error', 503],
        ['a redirect', 302],
    ])('quarantines a record whose retrieval answered %s, not just a null one', (_what, status) => {
        // The gap the old one-field check could not see at all: the status was
        // PRESENT, so `retrievalStatusMissing` was false and the record was
        // written as a candidate — while the exporter and the loader both
        // refuse it as `retrieval_status_invalid`.
        const one = withEvidence({ http_status: status });

        expect(evidenceGapCodes(importEvidenceAssessment(one))).toEqual(['retrieval_status_invalid']);
        expect(importPublicationStatus(one, verdictFor(one))).toBe('quarantined');
    });

    it('reads a record written in camelCase, which is the other stage\'s spelling', () => {
        // `evidence.service.ts` writes camelCase and this stage writes
        // snake_case; both are evidence, and the shared floor reads either. A
        // record spelled the other way must therefore be judged complete, or
        // the predicate would quarantine a sound record for its spelling.
        const one = withEvidence(
            {
                finalHost: 'api.nal.usda.gov',
                status: 200,
                bodySha256: 'd'.repeat(64),
                recordSha256: 'e'.repeat(64),
                sourceCacheKey: 'POST /foods?#{"fdcIds":[1],"format":"full"}',
                matchedSnippet: 'Carrots, raw',
                fetchedAt: fetchedAt.toISOString(),
            },
            [
                'final_host',
                'http_status',
                'body_sha256',
                'record_sha256',
                'source_cache_key',
                'matched_snippet',
                'fetched_at',
            ],
        );

        expect(evidenceGapCodes(importEvidenceAssessment(one))).toEqual([]);
        expect(importPublicationStatus(one, verdictFor(one))).toBe('candidate');
    });

    it('holds a record whose two spellings of one field disagree, rather than picking one', () => {
        // Neither value can be trusted once they disagree: a reader that took
        // the first spelling it found would publish a row on a status the other
        // half of the record contradicts.
        const one = withEvidence({ status: 500 });

        const assessment = importEvidenceAssessment(one);
        expect(evidenceGapCodes(assessment)).toEqual(['evidence_malformed']);
        expect(assessment.gaps[0].field).toBe('http_status/status');
        expect(assessment.gaps[0].observed).toContain('http_status=200');
        expect(assessment.gaps[0].observed).toContain('status=500');
        expect(importPublicationStatus(one, verdictFor(one))).toBe('quarantined');
    });

    it('accepts two spellings that agree, so a doubly-spelled record is not punished', () => {
        const one = withEvidence({ status: 200 });

        expect(evidenceGapCodes(importEvidenceAssessment(one))).toEqual([]);
        expect(importPublicationStatus(one, verdictFor(one))).toBe('candidate');
    });

    it('reports every gap of a record that is short of several fields', () => {
        // One entry per gap, because the repairs differ: a missing digest needs
        // the retrieval re-made, an unparseable time needs the clock that wrote
        // it looked at. A single "evidence incomplete" would name neither.
        const one = withEvidence({ fetched_at: '2026' }, ['body_sha256', 'matched_snippet']);

        expect(evidenceGapCodes(importEvidenceAssessment(one))).toEqual([
            'retrieval_body_digest_missing',
            'retrieval_snippet_missing',
            'retrieval_time_invalid',
        ]);
        expect(importPublicationStatus(one, verdictFor(one))).toBe('quarantined');
    });

    it('names the status gap under the key the report has always used', () => {
        // The one name an operator greps for does not change; every other gap
        // is reported under its own code behind the same prefix, so two records
        // held for different reasons are never one count.
        expect(importEvidenceCheckName('retrieval_status_missing')).toBe(IMPORT_CHECK_MISSING_RETRIEVAL_STATUS);
        expect(importEvidenceCheckName('retrieval_status_invalid')).toBe(
            `${IMPORT_CHECK_MISSING_RETRIEVAL_STATUS}:retrieval_status_invalid`,
        );
        expect(importEvidenceCheckName('retrieval_time_invalid')).toBe(
            `${IMPORT_CHECK_MISSING_RETRIEVAL_STATUS}:retrieval_time_invalid`,
        );
    });

    it('does not publish, whatever the evidence says, which is what this stage is for', () => {
        // The honest bound on this whole block: a sound record becomes a
        // CANDIDATE and not a published row, because publication needs the
        // cross-table duplicate check only `catalog:validate` can make. The
        // floor here holds bad records at the stage that produced them; it does
        // not, and must not, promote good ones.
        const one = soundRecord();
        const verdict = verdictFor(one);

        expect(verdict.publicationStatus).toBe('published');
        expect(importPublicationStatus(one, verdict)).toBe('candidate');
    });
});

/**
 * THE OUTCOME AND THE STATUS ARE ONE STATEMENT ABOUT ONE RECORD
 * (VALREP-rejected-outcome-mismatch).
 *
 * WHAT WAS WRONG. The import-stage floor — an unclassified category or
 * incomplete retrieval evidence — decided `catalog_validation_records.outcome`
 * unconditionally. A row that ALSO failed a reject-tier check was therefore
 * persisted `publication_status: 'rejected'` with `outcome: 'quarantined'`
 * beside reject-tier check evidence, which is the self-contradiction the field
 * exists to avoid: the committed v1 validation report carries 33 of them. It
 * could not self-heal, because `catalog-validate` re-judges `candidate`,
 * `published` and `quarantined` rows only.
 *
 * THE RULE. `rejected` is final (AAP §0.7.3 makes a reject-tier failure
 * `rejected` and never publishable); the floor may only downgrade an otherwise
 * `accepted` verdict to `quarantined`; with no floor the verdict stands.
 */
describe('the import-stage floor may downgrade an outcome, never override a rejection', () => {
    const base = curatedEntries[0] as UsdaManifestFood;
    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };
    const fetchedAt = new Date('2026-09-14T08:30:00.000Z');
    const reviewedAt = new Date('2026-09-14T08:31:00.000Z');

    const soundRecord = (): PreparedCatalogFood =>
        prepareCatalogFood(detailFor(base), { kind: 'curated', entry: base }, manifest, fetchedAt, {
            requestedFdcIds: [base.fdcId as number],
            cacheKey: 'POST /foods?#{"fdcIds":[' + String(base.fdcId) + '],"format":"full"}',
            responseSha256: 'd'.repeat(64),
            source: 'import_run',
            httpStatus: 200,
            cachedAt: null,
        });

    /**
     * The same record with a swept record's unclassified category, which is
     * what `curatorReviewRequired` means (`!curated && !assignment.classified`).
     * Overridden rather than re-prepared so the candidate, the checks and the
     * verdict are held constant and the floor is the only variable.
     */
    const heldForReview = (one: PreparedCatalogFood): PreparedCatalogFood => ({
        ...one,
        curatorReviewRequired: true,
    });

    /** A record whose nutrients fail a reject-tier bound: kcal/100 g over the ceiling. */
    const rejectTier = (one: PreparedCatalogFood): PreparedCatalogFood => ({
        ...one,
        candidate: { ...one.candidate, calories: 5000 },
    });

    const outcomeOf = (one: PreparedCatalogFood): { outcome: unknown; publicationStatus: unknown } => {
        const verdict = validateCatalogCandidate(one.candidate, policy);
        const publicationStatus = importPublicationStatus(one, verdict);
        const record = buildValidationRecordData(one, verdict, publicationStatus, reviewedAt);

        return { outcome: record.outcome, publicationStatus: record.publication_status };
    };

    it('records a reject-tier failure as rejected even while the curator-review floor holds', () => {
        const one = heldForReview(rejectTier(soundRecord()));
        const verdict = validateCatalogCandidate(one.candidate, policy);

        // The premise: the checks really do reject this record, and the status
        // written for it is `rejected`.
        expect(verdict.publicationStatus).toBe('rejected');
        expect(verdict.decidingCheckNames).toContain('kcal_ceiling');
        expect(importPublicationStatus(one, verdict)).toBe('rejected');

        expect(importRecordOutcome(one, verdict, 'rejected')).toBe('rejected');
        expect(outcomeOf(one)).toEqual({ outcome: 'rejected', publicationStatus: 'rejected' });
    });

    it('still downgrades an otherwise accepted verdict to quarantined while the floor holds', () => {
        const one = heldForReview(soundRecord());
        const verdict = validateCatalogCandidate(one.candidate, policy);

        // Unchanged behaviour, and the reason the floor exists: an
        // unclassified food's identity is sound but its category is a
        // placeholder, so it is held rather than accepted — and it is held as
        // a `candidate`, which is the status validation re-judges.
        expect(verdict.outcome).toBe('accepted');
        expect(importRecordOutcome(one, verdict, 'candidate')).toBe('quarantined');
        expect(outcomeOf(one)).toEqual({ outcome: 'quarantined', publicationStatus: 'candidate' });
    });

    it('leaves the verdict alone when no floor holds', () => {
        const one = soundRecord();
        const verdict = validateCatalogCandidate(one.candidate, policy);

        expect(importRecordOutcome(one, verdict, 'candidate')).toBe(verdict.outcome);
        expect(outcomeOf(one)).toEqual({ outcome: 'accepted', publicationStatus: 'candidate' });
    });

    it('agrees with the status when the evidence floor is the one that holds', () => {
        // The evidence half of the floor moves the STATUS as well (a record
        // with no observed retrieval status is quarantined however clean its
        // numbers), so this pair has always agreed — pinned here so the new
        // precedence cannot break the case it was already right about.
        const sound = soundRecord();
        const one: PreparedCatalogFood = {
            ...sound,
            evidence: { ...sound.evidence, http_status: null } as PreparedCatalogFood['evidence'],
        };

        expect(importEvidenceAssessment(one).complete).toBe(false);
        expect(outcomeOf(one)).toEqual({ outcome: 'quarantined', publicationStatus: 'quarantined' });
    });

    it('never writes an outcome its own publication status contradicts', () => {
        // The invariant, over every combination this stage can produce: a
        // rejected row reads `rejected`, a quarantined row reads
        // `quarantined`, and a candidate row reads `accepted` (clean) or
        // `quarantined` (held) — never `rejected`.
        const permitted: Record<string, readonly string[]> = {
            rejected: ['rejected'],
            quarantined: ['quarantined'],
            candidate: ['accepted', 'quarantined'],
        };

        const sound = soundRecord();
        const noStatus: PreparedCatalogFood = {
            ...sound,
            evidence: { ...sound.evidence, http_status: null } as PreparedCatalogFood['evidence'],
        };

        for (const one of [
            sound,
            heldForReview(sound),
            rejectTier(sound),
            heldForReview(rejectTier(sound)),
            noStatus,
            heldForReview(noStatus),
            rejectTier(noStatus),
            heldForReview(rejectTier(noStatus)),
        ]) {
            const { outcome, publicationStatus } = outcomeOf(one);
            expect(permitted[String(publicationStatus)]).toContain(String(outcome));
        }
    });
});


/**
 * The cache-key scheme the manifest documents and the one the import writes are
 * one scheme or the provenance is unverifiable.
 *
 * The manifest used to describe `source_cache_key` as `/food/<fdcId>?format=full`
 * while every row carried the batch key of a `POST /foods` response. Nothing
 * read the manifest block, so nothing could contradict it — and a reader
 * following the documented key would look for a `usda_api_cache` row that has
 * never existed, because this pipeline makes no per-food detail request at all.
 */
describe('the documented source_cache_key scheme is the one the import writes', () => {
    const declared = (manifest as unknown as { sweepNamingPolicy: { sourceCacheKeyScheme?: unknown } })
        .sweepNamingPolicy.sourceCacheKeyScheme;

    it('agrees with the scheme the import exports, field by field', () => {
        expect(sourceCacheKeySchemeDisagreements(declared)).toEqual([]);
    });

    it('declares the batch endpoint, not the per-food detail path', () => {
        expect(USDA_SOURCE_CACHE_KEY_SCHEME.method).toBe('POST');
        expect(USDA_SOURCE_CACHE_KEY_SCHEME.path).toBe('/foods');
        expect(USDA_SOURCE_CACHE_KEY_SCHEME.sharedAcrossBatch).toBe(true);
        expect(USDA_SOURCE_CACHE_KEY_SCHEME.maxFoodsPerKey).toBe(20);
        expect(JSON.stringify(declared)).not.toContain('/food/<fdcId>');
        // The prose beside it is corrected too, and says what the key is.
        const policy = (manifest as unknown as { sweepNamingPolicy: { sourceCacheKey: string } }).sweepNamingPolicy;
        expect(policy.sourceCacheKey).toContain('POST /foods?#');
    });

    it('is the shape the vendor client\'s own key builder produces', () => {
        // Unsorted and duplicated on purpose: the shape claims ascending
        // de-duplicated ids, and `cacheKeyForRequest` is what has to deliver
        // them. This is the same check `main()` makes before the first fetch.
        const built = cacheKeyForRequest('POST', '/foods', {}, { fdcIds: [2, 1, 2], format: 'full' });
        expect(built).toBe('POST /foods?#{"fdcIds":[1,2],"format":"full"}');
        expect(USDA_SOURCE_CACHE_KEY_SCHEME.shape).toBe(
            'POST /foods?#{"fdcIds":[<ascending de-duplicated fdc ids>],"format":"full"}',
        );
    });

    it('reports an absent or disagreeing declaration instead of passing it', () => {
        expect(sourceCacheKeySchemeDisagreements(undefined)).toHaveLength(1);
        expect(sourceCacheKeySchemeDisagreements(undefined)[0]).toContain('absent or is not an object');
        // The exact drift that shipped: the old per-food path.
        const drifted = { ...(declared as Record<string, unknown>), path: '/food/<fdcId>' };
        expect(sourceCacheKeySchemeDisagreements(drifted).join(' ')).toContain('path declares "/food/<fdcId>"');
        const wrongBodyKeys = { ...(declared as Record<string, unknown>), requestBodyKeys: ['fdcId'] };
        expect(sourceCacheKeySchemeDisagreements(wrongBodyKeys).join(' ')).toContain('requestBodyKeys');
    });
});

/**
 * One batch fetch carries its own provenance.
 *
 * `toBatchRetrieval` is the only place the vendor client's vocabulary becomes
 * the vocabulary the evidence records publish, and it is pure — so the mapping
 * that decides `retrieval_source`, `cachedAt` and the digest is asserted with
 * no fetch, no cache and no clock.
 */
describe('the retrieval facts a batch fetch reports', () => {
    const payload = { foods: [{ fdcId: 1, description: 'Beans' }] };

    it('maps a live fetch to import_run, with this run having no vendor timestamp', () => {
        const mapped = toBatchRetrieval({
            requestedFdcIds: [1, 2],
            cacheKey: 'POST /foods?#{"fdcIds":[1,2],"format":"full"}',
            origin: 'network',
            httpStatus: 200,
            fetchedAt: new Date('2026-09-14T08:00:00.000Z'),
            payload,
        });

        expect(mapped.source).toBe('import_run');
        // Null because the run fetched it: the evidence record then states the
        // run clock as the run clock rather than as a vendor retrieval time.
        expect(mapped.cachedAt).toBeNull();
        expect(mapped.httpStatus).toBe(200);
        expect(mapped.responseSha256).toBe(sha256Hex(canonicalJsonString(payload)));
    });

    it('maps a replay to usda_api_cache, keeping the row\'s time and recorded status', () => {
        const cachedAt = new Date('2026-09-13T09:11:40.243Z');
        const mapped = toBatchRetrieval({
            requestedFdcIds: [1],
            cacheKey: 'POST /foods?#{"fdcIds":[1],"format":"full"}',
            origin: 'cache',
            httpStatus: 200,
            fetchedAt: cachedAt,
            payload,
        });

        expect(mapped.source).toBe('usda_api_cache');
        expect(mapped.cachedAt).toBe(cachedAt);
        expect(mapped.httpStatus).toBe(200);
    });

    it('carries a null recorded status through rather than substituting one', () => {
        const mapped = toBatchRetrieval({
            requestedFdcIds: [1],
            cacheKey: 'POST /foods?#{"fdcIds":[1],"format":"full"}',
            origin: 'cache',
            httpStatus: null,
            fetchedAt: new Date('2026-09-13T09:11:40.243Z'),
            payload,
        });

        expect(mapped.httpStatus).toBeNull();
    });

    it('digests the payload the records came out of, so the digest always exists', () => {
        const mapped = toBatchRetrieval({
            requestedFdcIds: [1],
            cacheKey: 'POST /foods?#{"fdcIds":[1],"format":"full"}',
            origin: 'network',
            httpStatus: 200,
            fetchedAt: new Date(),
            payload: {},
        });

        expect(mapped.responseSha256).toMatch(/^[0-9a-f]{64}$/);
    });
});

/**
 * The count set an invocation starts from.
 *
 * `initialImportCounts` is the one shape both the working path and the
 * already-completed path report, which is what keeps a no-op invocation's
 * counts a zeroed version of the real ones rather than a different set of keys.
 */
describe('the counts an invocation starts from', () => {
    const planOf = (assignments: number, skipped: Record<string, number>) =>
        ({ assignments: new Map(Array.from({ length: assignments }, (_, index) => [index, index])), skipped }) as never;

    it('zeroes every counter only a write can raise, and keeps the plan-time facts', () => {
        const counts = initialImportCounts(planOf(7, { skippedDuplicateInPlan: 2 }));

        expect(counts).toEqual({
            planned: 7,
            inserted: 0,
            updated: 0,
            candidates: 0,
            quarantined: 0,
            rejected: 0,
            missingFromVendor: 0,
            // The durable batch counter is part of the shape: it is raised as
            // the run goes rather than at the end, so leaving it
            // out gave an already-completed scope a counts object one key
            // shorter than the working path's — the very drift this shape
            // exists to prevent.
            batchesProcessed: 0,
            skippedDuplicateInPlan: 2,
        });
    });
});

/**
 * Preflight states the ceiling an operator can actually set.
 *
 * The remedy used to read "between 1 and 1000", which is the vendor's cap and
 * not this import's: an operator who followed it landed on a value the limiter
 * refuses at startup.
 */
describe('the rate-limit prerequisite names the import ceiling', () => {
    const preflightDeps = (env: NodeJS.ProcessEnv): Parameters<typeof preflight>[0] => ({
        env: { USDA_API_KEY: 'test-key', ...env },
        loadUsdaManifest,
        loadCoveragePlan,
        resolveRateLimit: getUsdaImportRateLimitPerHour,
        fileExists: () => true,
    });

    it('reports a rate above the ceiling as a prerequisite gap, naming 900', () => {
        const gaps = preflight(preflightDeps({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: '1000' }));
        const gap = gaps.find((entry) => entry.code === 'usda_rate_limit_misconfigured');

        expect(gap).toBeDefined();
        expect(gap?.requirement).toContain(`${USDA_IMPORT_POLICY_CAP_PER_HOUR}`);
        expect(gap?.remedy).toContain(`between 1 and ${USDA_IMPORT_POLICY_CAP_PER_HOUR}`);
        // The vendor's 1,000 is no longer offered as a settable value.
        expect(gap?.remedy).not.toContain('between 1 and 1000');
        expect(gap?.remedy).toContain('Nothing can raise it');
    });

    it('accepts the ceiling itself, and the default', () => {
        expect(
            preflight(preflightDeps({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: `${USDA_IMPORT_POLICY_CAP_PER_HOUR}` })).map(
                (gap) => gap.code,
            ),
        ).not.toContain('usda_rate_limit_misconfigured');
        expect(preflight(preflightDeps({})).map((gap) => gap.code)).not.toContain('usda_rate_limit_misconfigured');
    });

    it('keeps the manifest\'s declared rate inside the ceiling the code enforces', () => {
        // `main()` refuses to run on a disagreement here, because a manifest
        // promising a rate the limiter will not allow would pace the import
        // slower than the document says without saying so.
        expect(manifest.importLimits.configuredRequestsPerHour).toBeLessThanOrEqual(USDA_IMPORT_POLICY_CAP_PER_HOUR);
        expect(manifest.importLimits.vendorRequestsPerHour).toBe(USDA_VENDOR_CAP_PER_HOUR);
        // And the headroom the manifest promises is the one the ceiling leaves.
        expect(manifest.importLimits.vendorRequestsPerHour - manifest.importLimits.configuredRequestsPerHour).toBe(
            USDA_VENDOR_CAP_PER_HOUR - USDA_IMPORT_POLICY_CAP_PER_HOUR,
        );
    });
});

describe('a selector that matches nothing selects nothing (N02)', () => {
    const dataType = 'SR Legacy';
    const cupSelector = { description: '1 cup', amount: 1, unit: 'cup', modifier: 'cup' };

    it('takes an exactly matching source label', () => {
        const portions: UsdaFoodPortion[] = [
            { amount: 1, modifier: 'cup', gramWeight: 240 },
            { amount: 1, modifier: 'slice', gramWeight: 30 },
        ];
        expect(matchSelectorPortion(portions, dataType, cupSelector)?.gramWeight).toBe(240);
    });

    it('takes a source label that contains the selector', () => {
        const portions: UsdaFoodPortion[] = [{ amount: 1, modifier: 'cup, chopped', gramWeight: 150 }];
        expect(matchSelectorPortion(portions, dataType, cupSelector)?.gramWeight).toBe(150);
    });

    it('takes a source label the selector contains', () => {
        const portions: UsdaFoodPortion[] = [{ amount: 1, modifier: 'cup', gramWeight: 128 }];
        const wordier = { description: '1 cup, pieces', amount: 1, unit: 'cup', modifier: 'cup, pieces' };
        expect(matchSelectorPortion(portions, dataType, wordier)?.gramWeight).toBe(128);
    });

    it('returns nothing when the selector names a measure no source label carries', () => {
        // The defect: this used to answer with the 30 g slice, which
        // parsePortionLabel then relabelled "1 cup" — a conversion of 1 cup to
        // 30 g that no source ever stated.
        const portions: UsdaFoodPortion[] = [{ amount: 1, modifier: 'slice', gramWeight: 30 }];
        expect(matchSelectorPortion(portions, dataType, cupSelector)).toBeNull();
    });

    it('returns nothing when the selector names a measure the source states in other words only', () => {
        // A selector whose only text is its human description still names a
        // measure, so a source stating "large"/"small" does not describe it and
        // the food falls back to its sourced 100 g basis rather than borrowing
        // one of those weights.
        const portions: UsdaFoodPortion[] = [
            { amount: 1, modifier: 'large', gramWeight: 200 },
            { amount: 1, modifier: 'small', gramWeight: 100 },
        ];
        expect(matchSelectorPortion(portions, dataType, { description: '1 serving', amount: 1, unit: 'each' })).toBeNull();
    });

    it('falls back to the lowest-weight portion only when the selector names no measure at all', () => {
        const portions: UsdaFoodPortion[] = [
            { amount: 1, modifier: 'large', gramWeight: 200 },
            { amount: 1, modifier: 'small', gramWeight: 100 },
        ];
        expect(matchSelectorPortion(portions, dataType, { description: '' })?.gramWeight).toBe(100);
    });

    it('ignores a selector that does not describe the label it is handed', () => {
        // The defect in its second form: parsePortionLabel used to apply the
        // selector's description, amount and unit to whatever portion it was
        // given, so an unrelated "1 slice / 30 g" came out as "1 cup" weighing
        // 30 g. The selector now has to describe the label to rename it.
        const slice: UsdaFoodPortion = { amount: 1, modifier: 'slice', gramWeight: 30 };
        const label = parsePortionLabel(slice, dataType, cupSelector);
        expect(label).not.toBeNull();
        expect(label?.unit).toBe('slice');
        expect(label?.description.toLowerCase()).toContain('slice');
    });

    it('applies the selector\'s reviewed wording to the label it does describe', () => {
        const cup: UsdaFoodPortion = { amount: 1, modifier: 'cup, chopped', gramWeight: 150 };
        const label = parsePortionLabel(cup, dataType, cupSelector);
        expect(label).toEqual({ description: '1 cup', amount: 1, unit: 'cup' });
    });

    it('ignores a source portion with no usable gram weight', () => {
        const portions: UsdaFoodPortion[] = [
            { amount: 1, modifier: 'cup', gramWeight: 0 },
            { amount: 1, modifier: 'cup', gramWeight: undefined },
        ];
        expect(matchSelectorPortion(portions, dataType, cupSelector)).toBeNull();
    });
});

describe('a partial run cannot close the canonical import (N03)', () => {
    it('scopes an unrestricted run to the manifest version itself', () => {
        expect(importRunScope('v1', options())).toBe('v1');
        expect(importRunScope('v1', options({ resume: true, dryRun: true }))).toBe('v1');
    });

    it('scopes a category- or limit-restricted run away from it', () => {
        const byCategory = importRunScope('v1', options({ categories: ['dairy'] }));
        const byLimit = importRunScope('v1', options({ limit: 50 }));
        expect(byCategory).not.toBe('v1');
        expect(byLimit).not.toBe('v1');
        expect(byCategory).not.toBe(byLimit);
        expect(byCategory.startsWith('v1+partial:')).toBe(true);
    });

    it('gives the same restriction the same scope however it was ordered', () => {
        expect(importRunScope('v1', options({ categories: ['dairy', 'grain'] }))).toBe(
            importRunScope('v1', options({ categories: ['grain', 'dairy'] })),
        );
        expect(importRunScope('v1', options({ categories: ['dairy'] }))).not.toBe(
            importRunScope('v1', options({ categories: ['dairy', 'grain'] })),
        );
    });
});

describe('a dry run writes no run, cursor or completion (N03)', () => {
    /**
     * Any property read on this object fails the test by name. A dry run that
     * opened, advanced or closed the canonical checkpoint would have to reach
     * `runDb` to do it, so refusing every access is the assertion.
     */
    const forbiddenRunDb = new Proxy(
        {},
        {
            get: (_target, property) => {
                throw new Error(`a dry run touched run state: runDb.${String(property)}`);
            },
        },
    );

    const forbiddenDb = new Proxy(
        {},
        {
            get: (_target, property) => {
                throw new Error(`a dry run touched catalog state: db.${String(property)}`);
            },
        },
    );

    it('plans, reports and returns without a run id', async () => {
        const reports: unknown[] = [];
        let installed = 0;
        let restored = 0;

        const deps = {
            db: forbiddenDb,
            runDb: forbiddenRunDb,
            usda: {
                listFoods: async (): Promise<UsdaFoodSummary[]> => [],
                fetchBatch: async () => {
                    throw new Error('a dry run fetched vendor records');
                },
            },
            manifest,
            coveragePlan,
            options: options({ dryRun: true }),
            logger: silentLogger,
            now: () => new Date('2026-09-13T11:00:00.000Z'),
            installRateLimiter: () => {
                installed += 1;
                return () => {
                    restored += 1;
                };
            },
            writeReport: (report: unknown) => {
                reports.push(report);
            },
        } as unknown as RunImportDeps;

        const outcome = await runImport(deps);

        expect(outcome.runId).toBeNull();
        expect(outcome.processedBatches).toBe(0);
        expect(outcome.resumed).toBe(false);
        expect(outcome.counts.inserted).toBe(0);
        expect(reports).toHaveLength(1);
        expect((reports[0] as { runId: string | null }).runId).toBeNull();
        expect((reports[0] as { note: string }).note).toContain('no run or checkpoint state was touched');
        // The pacing is installed and restored even on a dry run, because the
        // plan itself issues the /foods/list calls.
        expect(installed).toBe(1);
        expect(restored).toBe(1);
    });
});

describe('--limit is one budget over the whole work list (N03)', () => {
    const sweptRows = (count: number): UsdaFoodSummary[] =>
        Array.from({ length: count }, (_unused, index) => ({
            fdcId: 900000 + index,
            description: `Carrots, raw, sample ${index}`,
            dataType: 'SR Legacy',
        }));

    it('stops at the limit across curated entries and sweeps together', async () => {
        const listFoods = async (_dataType: string, _pageSize: number, page: number): Promise<UsdaFoodSummary[]> =>
            page === 1 ? sweptRows(40) : [];

        const curatedCount = curatedEntries.length;
        const plan = await buildImportPlan(manifest, coveragePlan, listFoods, options({ limit: curatedCount + 5 }), silentLogger);

        expect(plan.assignments.size).toBe(curatedCount + 5);
        const batched = plan.batches.reduce((total, batch) => total + batch.fdcIds.length, 0);
        // The planned count and the number of records actually batched for
        // fetching are the same number, which is what "one budget" means.
        expect(batched).toBe(plan.assignments.size);
    });

    it('spends the whole budget on curated entries when it is smaller than that set', async () => {
        const listFoods = async (): Promise<UsdaFoodSummary[]> => sweptRows(40);
        const plan = await buildImportPlan(manifest, coveragePlan, listFoods, options({ limit: 5 }), silentLogger);

        expect(plan.assignments.size).toBe(5);
        expect([...plan.assignments.values()].every((assignment) => assignment.kind === 'curated')).toBe(true);
    });

    it('plans every record when no limit is given', async () => {
        const listFoods = async (_dataType: string, _pageSize: number, page: number): Promise<UsdaFoodSummary[]> =>
            page === 1 ? sweptRows(40) : [];
        const plan = await buildImportPlan(manifest, coveragePlan, listFoods, options(), silentLogger);

        expect(plan.assignments.size).toBeGreaterThan(curatedEntries.length);
        const batched = plan.batches.reduce((total, batch) => total + batch.fdcIds.length, 0);
        expect(batched).toBe(plan.assignments.size);
    });
});

/**
 * WHERE A SWEEP STOPS, AND WHY.
 *
 * Three defects in one loop, each of which ends a sweep in the wrong place.
 *
 * THE PERMANENT PAGE CEILING: the bound was
 * `min(maxPages, observedLastNonEmptyPage)`. `observedLastNonEmptyPage` is a
 * MEASUREMENT with an `observedOn` date beside it, and using it as a bound
 * turns it into a permanent ceiling — USDA adds records to these datasets, and
 * every record past the page someone measured once would never be imported,
 * with nothing in the output saying so because the sweep ends normally.
 * `maxPages` is the backstop the document says it is, the measurement is an
 * expectation, and exceeding it is reported as growth.
 *
 * THE UNREAD CATEGORY STOP: `stopWhenCategoryCandidateVolumeReached` was
 * declared on all three sweeps and read by nothing. Records past a category's
 * `candidateVolume` cost requests from a 900/hour budget the other categories
 * need, and overfill the category — which then publishes past the plan's target
 * and reports a shortfall against a number it has already passed.
 *
 * THE DROPPED CURATION: a curated entry the plan could not resolve was counted
 * into `skippedUnresolvedEntry` and stepped over, so reviewed curation was
 * dropped from the catalog and said so only in a counter nobody reads.
 *
 * These cases drive `buildImportPlan` directly with a fake listing, so the page
 * numbers requested and the counters returned are both observable and no
 * request is made.
 */
describe('where a sweep stops, and why', () => {
    /** The sweep the committed document measured furthest: maxPages 50, observed 39. */
    const sweep = manifest.datasetSweeps.find((candidate) => candidate.maxPages > candidate.pageSize / 10);

    /** One sweep only, so a case reads the pages of exactly the sweep it set up. */
    const oneSweep = (overrides: Partial<(typeof manifest.datasetSweeps)[number]> = {}): UsdaManifest => ({
        ...manifest,
        foods: [],
        datasetSweeps: [{ ...manifest.datasetSweeps[0], ...overrides }],
    });

    /**
     * A listing that answers with distinct carrot rows for the first `pages`
     * pages and nothing after, recording every page it was asked for.
     *
     * "Carrots, raw" is used because the committed classification rules file it
     * under a real category — a description nothing classifies would be skipped
     * as an excluded class and the volume budget would never be reached.
     */
    const pagedListing = (
        pages: number,
        rowsPerPage: number,
    ): { readonly requested: number[]; readonly listFoods: RunImportDeps['usda']['listFoods'] } => {
        const requested: number[] = [];

        return {
            requested,
            listFoods: async (_dataType: string, _pageSize: number, page: number): Promise<UsdaFoodSummary[]> => {
                requested.push(page);
                if (page > pages) {
                    return [];
                }

                return Array.from({ length: rowsPerPage }, (_unused, index) => ({
                    fdcId: 5_000_000 + page * 1_000 + index,
                    description: `Carrots, raw, lot ${page}-${index}`,
                    dataType: 'SR Legacy',
                }));
            },
        };
    };

    it('measures the observed last page against maxPages, so the document itself cannot truncate', () => {
        // The invariant the loop now relies on, asserted on the committed
        // document: every sweep's backstop sits at or above its own
        // measurement. `assertUsdaManifestShape` refuses a document where it
        // does not, so this is the two halves meeting.
        expect(sweep).toBeDefined();
        for (const candidate of manifest.datasetSweeps) {
            expect(candidate.maxPages).toBeGreaterThanOrEqual(candidate.observedLastNonEmptyPage ?? 0);
        }
    });

    it('imports the pages a grown dataset added past the measurement', async () => {
        // The dataset now holds five pages; the document measured two. The old
        // bound stopped at two and silently dropped pages three to five.
        const listing = pagedListing(5, 3);
        const logged: { event: string; fields: Record<string, unknown> }[] = [];
        const recordingLogger: ScriptLogger = {
            ...silentLogger,
            info: (event: string, fields?: Record<string, unknown>) => {
                logged.push({ event, fields: fields ?? {} });
            },
            child: () => recordingLogger,
        };

        const plan = await buildImportPlan(
            oneSweep({ maxPages: 8, observedLastNonEmptyPage: 2, stopWhenCategoryCandidateVolumeReached: false }),
            coveragePlan,
            listing.listFoods,
            options(),
            recordingLogger,
        );

        // Pages one to five fetched, six requested once and answered empty.
        expect(listing.requested).toEqual([1, 2, 3, 4, 5, 6]);
        expect(plan.assignments.size).toBe(15);

        // And the growth is REPORTED, because it is the signal to re-measure
        // and confirm `maxPages` still sits above the data.
        const planned = logged.find((entry) => entry.event === 'sweep_planned');
        expect(planned?.fields.grewBeyondObserved).toBe(true);
        expect(planned?.fields.observedLastNonEmptyPage).toBe(2);
        expect(planned?.fields.volumeStoppedAtPage).toBeNull();
    });

    it('stops at the first empty page rather than spending the whole backstop', async () => {
        const listing = pagedListing(2, 2);

        await buildImportPlan(
            oneSweep({ maxPages: 40, observedLastNonEmptyPage: 2, stopWhenCategoryCandidateVolumeReached: false }),
            coveragePlan,
            listing.listFoods,
            options(),
            silentLogger,
        );

        // Three requests for a two-page dataset: the empty answer is the stop,
        // so raising `maxPages` costs one request and not thirty-eight.
        expect(listing.requested).toEqual([1, 2, 3]);
    });

    it('caps a runaway listing at maxPages', async () => {
        // A listing that never empties — a vendor bug, or a cursor that loops.
        // `maxPages` is what it is for.
        const listing = pagedListing(Number.MAX_SAFE_INTEGER, 1);

        await buildImportPlan(
            oneSweep({ maxPages: 4, observedLastNonEmptyPage: 4, stopWhenCategoryCandidateVolumeReached: false }),
            coveragePlan,
            listing.listFoods,
            options(),
            silentLogger,
        );

        expect(listing.requested).toEqual([1, 2, 3, 4]);
    });

    /**
     * The coverage plan with every category's candidate volume set to `volume`.
     *
     * Reduced rather than fabricated so the categories and food groups stay the
     * committed ones — the classification rules file swept rows under them, and
     * a fabricated plan would file nothing.
     */
    const planWithVolume = (volume: number): typeof coveragePlan => ({
        ...coveragePlan,
        categories: coveragePlan.categories.map((row) => ({ ...row, candidateVolume: volume })),
    });

    it('stops a sweep once every category it can file under is full', async () => {
        const listing = pagedListing(10, 4);
        const logged: { event: string; fields: Record<string, unknown> }[] = [];
        const recordingLogger: ScriptLogger = {
            ...silentLogger,
            info: (event: string, fields?: Record<string, unknown>) => {
                logged.push({ event, fields: fields ?? {} });
            },
            child: () => recordingLogger,
        };

        // One category in scope, and it holds six candidates. Page one and two
        // fill it (four then two accepted); the check runs BEFORE the request,
        // so page three is never asked for.
        const plan = await buildImportPlan(
            oneSweep({ maxPages: 10, observedLastNonEmptyPage: 10, stopWhenCategoryCandidateVolumeReached: true }),
            planWithVolume(6),
            listing.listFoods,
            options({ categories: ['produce_vegetable'] }),
            recordingLogger,
        );

        expect(plan.assignments.size).toBe(6);
        expect(listing.requested).toEqual([1, 2]);
        expect(plan.skipped.skippedCategoryVolumeReached).toBe(2);

        const planned = logged.find((entry) => entry.event === 'sweep_planned');
        expect(planned?.fields.volumeStoppedAtPage).toBe(2);
    });

    it('ignores the budget for a sweep that does not ask for it', async () => {
        const listing = pagedListing(3, 4);

        const plan = await buildImportPlan(
            oneSweep({ maxPages: 10, observedLastNonEmptyPage: 10, stopWhenCategoryCandidateVolumeReached: false }),
            planWithVolume(6),
            listing.listFoods,
            options({ categories: ['produce_vegetable'] }),
            silentLogger,
        );

        // Opt-in per sweep: reading the flag's absence as "on" would hold a
        // future sweep to a budget its author never asked for.
        expect(plan.assignments.size).toBe(12);
        expect(plan.skipped.skippedCategoryVolumeReached).toBe(0);
    });

    /**
     * THE REQUIREMENT HEADROOM — THE FLOOR UNDER THE WHOLE RUN'S PLANNED VOLUME.
     *
     * THE DEFECT IT CLOSES. The per-category cap above is a distribution
     * budget, and on the v1 catalog it refused 2,250 genuine generic USDA
     * records while thirteen categories stayed short of their targets because
     * the vendor's datasets do not hold their records at all. The run planned
     * 10,003 records, published 9,422, and finished 578 items below the 10,000
     * the feature requires (AAP §0.1.1 area 3) — with the refused records
     * sitting in categories the cap had already filled.
     *
     * So `usda-manifest.v1.json` declares a `requirementHeadroom`: while the
     * run's TOTAL planned count is below `plannedVolumeFloor`, a full category
     * still admits a swept record. These cases pin the four properties that
     * make that a bounded rule rather than a removed cap — it admits while the
     * floor is unreached, it stops admitting the moment the floor is met, it
     * counts admissions apart from the cap's refusals, and it does not apply to
     * a `--category` run that could never reach a whole-catalog floor.
     */
    describe('the requirement headroom', () => {
        /** The committed headroom block with the floor moved to `floor`. */
        const withFloor = (floor: number): NonNullable<UsdaManifest['requirementHeadroom']> => ({
            ...(manifest.requirementHeadroom as NonNullable<UsdaManifest['requirementHeadroom']>),
            plannedVolumeFloor: floor,
        });

        const sweepWithHeadroom = (floor: number | null): UsdaManifest => ({
            ...oneSweep({ maxPages: 10, observedLastNonEmptyPage: 10, stopWhenCategoryCandidateVolumeReached: true }),
            requirementHeadroom: floor === null ? undefined : withFloor(floor),
        });

        /**
         * The coverage plan reduced to the one category this listing's rows
         * classify under, at `volume` candidates.
         *
         * The page-level stop asks whether EVERY in-scope budgeted category is
         * full, and the headroom applies only to a run over the whole plan — so
         * a 21-category plan and a listing of carrots can never reach that
         * condition, and the page loop would run to `maxPages` for a reason
         * that has nothing to do with the floor. One category is what lets
         * these cases observe where the sweep stops while still running
         * unrestricted, which is the shape the headroom is declared for.
         */
        const vegetableOnlyPlan = (volume: number): typeof coveragePlan => ({
            ...coveragePlan,
            categories: coveragePlan.categories
                .filter((row) => row.category === 'produce_vegetable')
                .map((row) => ({ ...row, candidateVolume: volume })),
        });

        it('admits a full category’s records while the run is below the declared floor', async () => {
            const listing = pagedListing(10, 4);

            // Volume 6 for every category and one category in scope by the
            // classification the rows take, so the cap would refuse everything
            // past the sixth record. The floor is 10, so four more are planned
            // — and they are counted as admitted, never as refused.
            const plan = await buildImportPlan(
                sweepWithHeadroom(10),
                vegetableOnlyPlan(6),
                listing.listFoods,
                options(),
                silentLogger,
            );

            expect(plan.assignments.size).toBe(10);
            expect(plan.admitted.admittedByRequirementHeadroom).toBe(4);
            // The cap's counter keeps its original meaning: these records were
            // not refused, so it counts only what it refused after the floor.
            expect(plan.skipped.skippedCategoryVolumeReached).toBe(2);
            expect(plan.headroom).toMatchObject({
                plannedVolumeFloor: 10,
                admitted: 4,
                stillCapped: 2,
                plannedTotal: 10,
                floorReached: true,
                appliedToThisRun: true,
            });
        });

        it('stops admitting the moment the floor is reached, and the page loop stops with it', async () => {
            const listing = pagedListing(10, 4);

            // Floor 10 over pages of four: pages one, two and three are needed
            // to reach it (4, 8, 12 → the twelfth record is refused), and the
            // fourth page is never requested because nothing on it could be
            // planned.
            const plan = await buildImportPlan(
                sweepWithHeadroom(10),
                vegetableOnlyPlan(6),
                listing.listFoods,
                options(),
                silentLogger,
            );

            expect(plan.assignments.size).toBe(10);
            expect(plan.skipped.skippedCategoryVolumeReached).toBe(2);
            expect(listing.requested).toEqual([1, 2, 3]);
        });

        it('keeps paging past a full category while the floor is unreached', async () => {
            const listing = pagedListing(10, 4);
            const logged: { event: string; fields: Record<string, unknown> }[] = [];
            const recordingLogger: ScriptLogger = {
                ...silentLogger,
                info: (event: string, fields?: Record<string, unknown>) => {
                    logged.push({ event, fields: fields ?? {} });
                },
                child: () => recordingLogger,
            };

            // Without the floor this sweep stopped after page two (the case
            // above this describe block). With a floor of 20 it keeps going to
            // page five, which is the whole point: the page-level stop and the
            // per-record rule have to agree, or the sweep ends before the
            // headroom can admit anything.
            const plan = await buildImportPlan(
                sweepWithHeadroom(20),
                vegetableOnlyPlan(6),
                listing.listFoods,
                options(),
                recordingLogger,
            );

            expect(plan.assignments.size).toBe(20);
            expect(listing.requested).toEqual([1, 2, 3, 4, 5]);
            expect(plan.admitted.admittedByRequirementHeadroom).toBe(14);
            expect(plan.skipped.skippedCategoryVolumeReached).toBe(0);

            const planned = logged.find((entry) => entry.event === 'sweep_planned');
            expect(planned?.fields.admittedByRequirementHeadroom).toBe(14);
            expect(planned?.fields.volumeStoppedAtPage).toBe(5);
        });

        it('does not apply to a --category run, which could never reach a whole-catalog floor', async () => {
            const listing = pagedListing(10, 4);

            const plan = await buildImportPlan(
                sweepWithHeadroom(10_000),
                planWithVolume(6),
                listing.listFoods,
                options({ categories: ['produce_vegetable'] }),
                silentLogger,
            );

            // Exactly the unrestricted-cap behaviour: six planned, two refused,
            // page three never requested. A floor a restricted run cannot reach
            // would otherwise admit every leftover record of that one category.
            expect(plan.assignments.size).toBe(6);
            expect(plan.admitted.admittedByRequirementHeadroom).toBe(0);
            expect(plan.skipped.skippedCategoryVolumeReached).toBe(2);
            expect(listing.requested).toEqual([1, 2]);
            expect(plan.headroom).toMatchObject({ appliedToThisRun: false, admitted: 0 });
            expect(plan.headroom?.appliedToThisRunReason).toContain('--category');
        });

        it('leaves a manifest that declares no headroom on the previous behaviour exactly', async () => {
            const listing = pagedListing(10, 4);

            const plan = await buildImportPlan(
                sweepWithHeadroom(null),
                vegetableOnlyPlan(6),
                listing.listFoods,
                options(),
                silentLogger,
            );

            expect(plan.assignments.size).toBe(6);
            expect(plan.admitted.admittedByRequirementHeadroom).toBe(0);
            expect(plan.skipped.skippedCategoryVolumeReached).toBe(2);
            expect(plan.headroom).toBeNull();

            // And the report block says which rule bounded the run rather than
            // emitting nulls a reader has to interpret.
            const block = buildRequirementHeadroomBlock(plan);
            expect(block.declared).toBe(false);
            expect(block.admittedByRequirementHeadroom).toBe(0);
            expect(block.skippedCategoryVolumeReached).toBe(2);
            expect(String(block.basis)).toContain('candidateVolume');
        });

        it('does not relax a sweep that never asked for the cap', async () => {
            const listing = pagedListing(3, 4);

            const plan = await buildImportPlan(
                {
                    ...oneSweep({
                        maxPages: 10,
                        observedLastNonEmptyPage: 10,
                        stopWhenCategoryCandidateVolumeReached: false,
                    }),
                    requirementHeadroom: withFloor(10),
                },
                planWithVolume(6),
                listing.listFoods,
                options(),
                silentLogger,
            );

            // There is no cap to relax, so every record is planned and none is
            // attributed to the headroom — the counter has to mean "a record
            // the cap would have refused" or it says nothing at all.
            expect(plan.assignments.size).toBe(12);
            expect(plan.admitted.admittedByRequirementHeadroom).toBe(0);
            expect(plan.skipped.skippedCategoryVolumeReached).toBe(0);
        });

        it('reports the floor, what it admitted and what the cap still refused', async () => {
            const listing = pagedListing(10, 4);
            const plan = await buildImportPlan(
                sweepWithHeadroom(10),
                vegetableOnlyPlan(6),
                listing.listFoods,
                options(),
                silentLogger,
            );

            const block = buildRequirementHeadroomBlock(plan);

            expect(block).toMatchObject({
                declared: true,
                requiredPublishedItems: manifest.requirementHeadroom?.requiredPublishedItems,
                plannedVolumeFloor: 10,
                plannedTotal: 10,
                floorReached: true,
                admittedByRequirementHeadroom: 4,
                skippedCategoryVolumeReached: 2,
                appliedToThisRun: true,
            });
            // The block has to say what an admitted record IS, because nothing
            // in the catalog distinguishes it: same checks, same validation
            // record, same source-backed provenance.
            expect(String(block.admittedRecordsAre)).toContain('source_backed');
        });

        it('states floorReached false when the vendor pool runs out before the floor does', async () => {
            const listing = pagedListing(2, 4);

            const plan = await buildImportPlan(
                sweepWithHeadroom(100),
                vegetableOnlyPlan(6),
                listing.listFoods,
                options(),
                silentLogger,
            );

            // Eight records exist, the floor asks for a hundred: the sweep ends
            // on the empty page with everything planned and nothing refused.
            // That is a fact about the datasets, not a fault in the rule, and
            // the block distinguishes it from "the floor is too low".
            expect(plan.assignments.size).toBe(8);
            expect(plan.skipped.skippedCategoryVolumeReached).toBe(0);
            expect(plan.headroom).toMatchObject({ floorReached: false, admitted: 2 });
            expect(String(buildRequirementHeadroomBlock(plan).floorReachedMeaning)).toContain('ran out of records');
        });
    });

    it('treats a category the plan states no volume for as unbudgeted, not as full', async () => {
        const listing = pagedListing(2, 3);
        const withoutVolumes: typeof coveragePlan = { ...coveragePlan, categories: [] };

        const plan = await buildImportPlan(
            oneSweep({ maxPages: 4, observedLastNonEmptyPage: 4, stopWhenCategoryCandidateVolumeReached: true }),
            withoutVolumes,
            listing.listFoods,
            options(),
            silentLogger,
        );

        // Refusing here would make this a cap the coverage plan never set.
        expect(plan.assignments.size).toBe(6);
        expect(plan.skipped.skippedCategoryVolumeReached).toBe(0);
    });

    it('refuses a curated entry with no verified id instead of skipping it', async () => {
        // A hand-built manifest object is the only way to reach this now — the
        // loader refuses such a document — and refusing is still the right
        // answer, because the alternative was dropping reviewed curation into a
        // counter.
        const unresolved: UsdaManifest = {
            ...manifest,
            foods: [{ ...manifest.foods[0], fdcId: undefined } as unknown as UsdaManifestFood],
            datasetSweeps: [],
        };

        const failure = await buildImportPlan(unresolved, coveragePlan, async () => [], options(), silentLogger).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogImportError);
        expect((failure as CatalogImportError).code).toBe('manifest_entry_unresolved');
        // Names the entry and what to do, because the fix is a curation step.
        expect((failure as CatalogImportError).message).toContain('foods[0]');
        expect((failure as CatalogImportError).message).toContain(manifest.foods[0].canonicalName);
    });

    it('keeps the unresolved-entry counter at zero, since nothing is skipped any more', async () => {
        const plan = await buildImportPlan(
            { ...manifest, datasetSweeps: [] },
            coveragePlan,
            async () => [],
            options(),
            silentLogger,
        );

        // The key stays in the report's shape — a sibling artefact reads it —
        // and is now permanently zero rather than sometimes hiding a drop.
        expect(plan.skipped.skippedUnresolvedEntry).toBe(0);
        expect(plan.assignments.size).toBe(curatedEntries.length);
    });
});

/**
 * The operator code a failed run reports.
 *
 * `describeFailure` is the last thing this stage does before it exits, and the
 * code it prints is the difference between "re-run with `--resume`" and "read
 * the code": a vendor failure — USDA's definitive `401`/`403`/`404`, or a
 * request that passed its deadline — is a `UsdaError` from
 * `src/services/usda.service.ts` and has its own code, while anything this
 * file does not recognise stays `unexpected_error` rather than being dressed
 * up as a vendor problem.
 *
 * The vendor case is matched by `error.name`, not `instanceof`: narrowing on
 * the class would mean importing the USDA service's value side at script load,
 * which constructs a Prisma client — the very thing `main()` defers with a
 * dynamic import so that these tests can import this module without a
 * database. `usda.service.test.ts` asserts the name from the other side.
 */
describe('describeFailure', () => {
    const usdaError = (message: string): Error => {
        const error = new Error(message);
        error.name = 'UsdaError';

        return error;
    };

    it('reports a definitive vendor status under its own code', () => {
        const described = describeFailure(usdaError('USDA returned 403'));

        expect(described.code).toBe('usda_request_failed');
        // The NAME and the code, and no `message`. The vendor's sentence is not
        // reported at all: `describeFailure` feeds the durable run log and the
        // operator console, and a message from USDA's edge is prose this stage
        // did not author — it can quote a request URL carrying `api_key`, or a
        // fragment of an error document. `usda_request_failed` is what an
        // operator acts on (re-run with `--resume`), and the status the vendor
        // set arrives as a field when the error carries one.
        expect(described.error).toEqual({ name: 'UsdaError' });
        expect(described.error).not.toHaveProperty('message');
    });

    it('reports a vendor timeout under the same code', () => {
        expect(describeFailure(usdaError('USDA request timed out after 30000ms')).code).toBe('usda_request_failed');
    });

    it('leaves an unrecognised failure as unexpected_error', () => {
        const described = describeFailure(new TypeError('cannot read properties of undefined'));

        expect(described.code).toBe('unexpected_error');
        expect(described.error.name).toBe('TypeError');
    });

    it('does not mistake an error that merely mentions USDA for a vendor failure', () => {
        expect(describeFailure(new Error('the USDA manifest is unreadable')).code).toBe('unexpected_error');
    });

    it('reports a non-Error value without throwing', () => {
        expect(describeFailure('something went wrong').code).toBe('unexpected_error');
    });

    /**
     * THE REALM CASE, which is the one that actually bites this stage.
     *
     * `safeError` carries a closed field set and no `message`, so `code` is the
     * only thing left that tells an operator WHAT went wrong at the filesystem
     * — `ENOENT` versus `EACCES` versus `EISDIR` are three different remedies.
     * An `instanceof Error` check answers `false` for an error thrown by a core
     * module into a Jest sandbox (the sandbox has its own intrinsics; `fs` does
     * not), which would silently report every one of them as a bare
     * `UnknownError` and make the loss invisible to every suite in this folder.
     *
     * Driven with a REAL `fs` failure rather than a constructed cross-realm
     * double, because the realm boundary is the thing under test and a double
     * built in this file is in this file's realm by construction.
     */
    it('reports the machine code of a core-module failure, across the realm boundary', () => {
        let thrown: unknown;
        try {
            fs.readFileSync(path.join(os.tmpdir(), 'soh-no-such-file-2c4f9a1b', 'absent.json'));
        } catch (error) {
            thrown = error;
        }

        // The precondition, asserted so this case cannot quietly stop testing
        // what it is about: if `fs` ever starts throwing same-realm errors here,
        // this line fails and the case is re-read rather than passing vacuously.
        expect(thrown instanceof Error).toBe(false);
        expect(Object.prototype.toString.call(thrown)).toBe('[object Error]');

        const described = describeFailure(thrown);

        expect(described.code).toBe('unexpected_error');
        expect(described.error.name).toBe('Error');
        expect(described.error.code).toBe('ENOENT');
        // And still no prose: the path `fs` quoted in its message is exactly
        // the kind of disclosure the closed field set exists to prevent.
        expect(described.error).not.toHaveProperty('message');
        expect(JSON.stringify(described)).not.toContain('absent.json');
    });

    /**
     * THE HOSTILE-VALUE CASE, and why a logging path must be total.
     *
     * Classifying a thrown value across realms means inspecting it, and neither
     * inspection is safe on an arbitrary value: `Object.prototype.toString.call`
     * READS `Symbol.toStringTag`, and `instanceof` invokes
     * `Error[Symbol.hasInstance]` and walks the prototype chain. `throw` accepts
     * any value, so both can be made to throw.
     *
     * This matters far beyond the odd input, because `describeFailure` runs in
     * the top-level catch and the run finalizer: an exception raised WHILE
     * describing a failure replaces the failure being reported and suppresses
     * the refusal, so the stage would exit with no usable account of why. The
     * two values below are the two ways to provoke it.
     */
    it.each([
        [
            'a value whose Symbol.toStringTag getter throws',
            (): unknown => ({
                get [Symbol.toStringTag](): string {
                    throw new Error('tag getter ran');
                },
            }),
        ],
        [
            'a proxy whose getPrototypeOf trap throws',
            (): unknown =>
                new Proxy(
                    {},
                    {
                        getPrototypeOf(): object {
                            throw new Error('trap ran');
                        },
                    },
                ),
        ],
    ])('describes %s without throwing, as a value it could not classify', (_label, build) => {
        const hostile = build();

        const described = describeFailure(hostile);

        expect(described.code).toBe('unexpected_error');
        expect(described.error.name).toBe('UnknownError');
        expect(described.error).not.toHaveProperty('message');
    });

    it('reports the stage’s own error under the code it carries', () => {
        const described = describeFailure(
            new CatalogImportError('manifest_version_mismatch', '--manifest v2 was given', {
                manifestVersion: 'v2',
            }),
        );

        expect(described.code).toBe('manifest_version_mismatch');
        expect(described.error.name).toBe('CatalogImportError');
    });

    // The failures that reach this stage through its own libraries rather than
    // through USDA. Each carries its reason as a TYPED FIELD, so the reported
    // code is read off the error instead of parsed out of a message — which is
    // what makes a refusal greppable by code and is the whole of §8's "typed
    // errors carry data, not strings". `DatabaseOriginError` and
    // `ModelBudgetError` are the ladder's remaining two branches and belong to
    // the suites that own dbGuard and the model budget.
    it('reports a manifest failure under the code the manifest error carries', () => {
        const described = describeFailure(
            new ManifestError('version_mismatch', 'usda-manifest.v1.json declares v2'),
        );

        expect(described.code).toBe('version_mismatch');
        expect(described.error.name).toBe('ManifestError');
    });

    it('reports a checkpoint failure under the code the checkpoint error carries', () => {
        const described = describeFailure(
            new CheckpointError('run_already_finished', '00000000-0000-4000-8000-000000000001', 'succeeded'),
        );

        expect(described.code).toBe('run_already_finished');
        expect(described.error.name).toBe('CheckpointError');
    });

    it('reports a rate-limit misconfiguration under a fixed code, because that error carries rates instead', () => {
        // The one class in the ladder with no `code` of its own: its typed
        // fields are the three rates, so this stage supplies the code. Falling
        // through to `unexpected_error` would report a refusal an operator
        // fixes in one environment variable as a defect in the importer.
        const described = describeFailure(
            new RateLimitConfigError('requestsPerHour must not exceed the vendor cap', 1001, 20, 1000),
        );

        expect(described.code).toBe('rate_limit_misconfigured');
        expect(described.error.name).toBe('RateLimitConfigError');
    });

    /**
     * THE DATABASE ARM, and the reason this block grew.
     *
     * This stage takes a per-user advisory lock through checkpoint.ts's own
     * `pg` session before it writes a row, so a database that will not accept a
     * connection fails BEFORE Prisma exists to translate it: what arrives is a
     * node-postgres `DatabaseError` whose `name` is the literal lower-case
     * `'error'` and whose `code` is a five-character SQLSTATE. It matched none
     * of the classes above and `machineCodeOf` dropped the SQLSTATE (its
     * pattern required a leading letter), so the most ordinary failure an
     * operator can cause was reported as
     * `{"code":"unexpected_error","error":{"name":"error"}}` — no class, no
     * SQLSTATE, no remedy, while every other failure class in this file names
     * itself. Driven here through `describeFailure` rather than through the
     * classifier alone, because the defect was in how the two composed.
     */
    describe('a database that will not serve the run', () => {
        const driverFailure = (sqlState: string): Error => {
            // The shape node-postgres really throws: `name` is `'error'`, the
            // class name is `DatabaseError`, and the SQLSTATE is on `code`.
            // A real one is exercised against PostgreSQL by the suites that
            // hold a connection; what matters here is that this stage's
            // reporter answers it, and that is decided by these two members.
            const error = new Error(`connection failure (${sqlState})`);
            error.name = 'error';
            (error as unknown as { code: string }).code = sqlState;

            return error;
        };

        it('names a refused connection rather than reporting a surprise', () => {
            const described = describeFailure(driverFailure('53300'));

            expect(described.code).toBe('database_unavailable');
            // The SQLSTATE now survives beside the name, which is the one
            // machine-readable fact the driver supplied.
            expect(described.error).toEqual({ name: 'error', code: '53300' });
            expect(described.detail?.remedy).toContain('DATABASE_URL');
        });

        it('adds the one thing the shared remedy cannot know: this stage resumes', () => {
            // The taxonomy lives in logger.ts so every stage answers alike, and
            // an import is the stage where re-running from zero costs hours of
            // vendor requests. The clause is appended here, not there.
            expect(describeFailure(driverFailure('08006')).detail?.remedy).toContain('--resume');
        });

        it.each([
            ['3D000', 'database_missing', 'a database that does not exist'],
            ['28P01', 'database_authentication_failed', 'a rejected password'],
            ['42P01', 'database_error', 'a target that was never migrated'],
        ])('reports SQLSTATE %s as %s — %s', (sqlState, expected) => {
            const described = describeFailure(driverFailure(sqlState));

            expect(described.code).toBe(expected);
            expect(described.error.code).toBe(sqlState);
        });

        it('gives the same answer when Prisma is the client that failed', () => {
            // Two clients reach the same database on this pipeline, and an
            // operator's fix does not depend on which one noticed.
            const prismaFailure = new Error('cannot reach database server');
            prismaFailure.name = 'PrismaClientInitializationError';
            (prismaFailure as unknown as { code: string }).code = 'P1001';

            expect(describeFailure(prismaFailure).code).toBe('database_unavailable');
        });

        it('does not file a Prisma query error as infrastructure', () => {
            // P2002 is a unique-constraint violation: a defect in this stage's
            // own data or logic wearing a database code. Reporting it under the
            // one heading an operator reads as "not your code" would send them
            // to the wrong place, so it stays unclassified.
            const violation = new Error('unique constraint failed');
            violation.name = 'PrismaClientKnownRequestError';
            (violation as unknown as { code: string }).code = 'P2002';

            const described = describeFailure(violation);

            expect(described.code).toBe('unexpected_error');
            expect(described.detail?.remedy).toBe(UNEXPECTED_FAILURE_REMEDY);
        });

        it('reports no message on any of them, so the widening cost nothing', () => {
            // The remedy is fixed prose from this repository and the SQLSTATE is
            // five characters the driver assigned. Neither is vendor text, and
            // the driver's own sentence — which quotes the database name — is
            // still absent.
            const described = describeFailure(driverFailure('3D000'));

            expect(described.error).not.toHaveProperty('message');
            expect(JSON.stringify(described)).not.toContain('connection failure');
        });
    });

    /**
     * The arms that forward their OWN sentence, and the one that must not.
     *
     * `safeError` carries no `message` because that field is where a request URL
     * bearing `api_key=` reaches a log. That rule is about text this repository
     * did not author. A refusal this file composed is the opposite case: it
     * names the file, the field and the two values that disagree, and none of
     * that survives in a code — so it travels under its own member, scrubbed
     * and bounded, at the sites that have already narrowed to a first-party
     * class. `DatabaseOriginError` is first-party too and is still withheld,
     * because its sentence is the host and database the guard refused.
     */
    describe('the sentences a first-party failure is allowed to carry', () => {
        it('carries the stage’s own sentence beside its typed context', () => {
            const described = describeFailure(
                new CatalogImportError('usda_request_failed', 'batch 12 stopped after 3 attempts', { batchIndex: 12 }),
            );

            expect(described.detail).toEqual({
                batchIndex: 12,
                firstPartyMessage: 'batch 12 stopped after 3 attempts',
            });
        });

        it('scrubs that sentence even though this repository wrote it', () => {
            // The narrowing obligation is not the only defence: a first-party
            // message can still interpolate a DSN or a key, and this one does.
            const described = describeFailure(
                new CatalogImportError('usda_request_failed', `connect to ${DSN_WITH_AT_IN_PASSWORD} failed`),
            );

            expect(described.detail?.firstPartyMessage).toBe(`connect to ${DSN_REDACTED} failed`);
            expectNoCredentialFragment(String(described.detail?.firstPartyMessage));
            // The whole reported object, checked for the fragments that cannot
            // occur in a field name. `expectNoCredentialFragment` above is the
            // stricter list and is aimed at the forwarded VALUE, because two of
            // its fragments are two characters long — `ss` occurs in the key
            // `firstPartyMessage` itself, so applying it to the rendered
            // document would assert about this member's name rather than about
            // the credential.
            for (const fragment of ['pa@ss', 'user:', ':pa']) {
                expect(JSON.stringify(described)).not.toContain(fragment);
            }
        });

        it('carries a manifest refusal’s sentence, which is the half an operator acts on', () => {
            const described = describeFailure(
                new ManifestError(
                    'version_mismatch',
                    'data/meal-planning/usda-manifest.v1.json declares v2 and --manifest asked for v1',
                ),
            );

            expect(described.detail?.firstPartyMessage).toBe(
                'data/meal-planning/usda-manifest.v1.json declares v2 and --manifest asked for v1',
            );
        });

        it('withholds a database-origin refusal’s sentence, because it names the target', () => {
            const described = describeFailure(
                new DatabaseOriginError(
                    'DATABASE_URL names database "state_of_health" on host "db.example.com"',
                    'unrecognised_origin',
                    classifyDatabaseOrigin('postgresql://svc:secret@db.example.com:5432/state_of_health'),
                ),
            );

            expect(described.code).toBe('unrecognised_origin');
            expect(described.detail).toBeUndefined();
            // dbGuard reports this refusal itself, with the target reduced to a
            // digest. Forwarding the sentence would publish the topology that
            // line takes care to withhold.
            expect(JSON.stringify(described)).not.toContain('db.example.com');
            expect(JSON.stringify(described)).not.toContain('state_of_health');
        });

        it('gives a genuinely unclassified failure something to do', () => {
            // The end of the ladder used to be an empty hand: a code that says
            // only "we do not know" and a name. It now carries the shared
            // remedy, which is the same sentence every stage prints there.
            const described = describeFailure(new TypeError('cannot read properties of undefined'));

            expect(described.code).toBe('unexpected_error');
            expect(described.detail?.remedy).toBe(UNEXPECTED_FAILURE_REMEDY);
            expect(described.error).not.toHaveProperty('message');
        });
    });
});

/**
 * THE VENDOR BOUNDARY (Rule backend-architecture §9).
 *
 * A USDA failure used to leave this stage as `UsdaError` itself, so everything
 * upstream was left matching a shape `src/services/usda.service.ts` owns, and
 * the operator was never told WHICH of ~600 batches stopped. Wrapping is the
 * rule; carrying the batch is what makes the wrap worth having, because
 * "re-run with --resume" and "read the code" are different answers and the
 * batch identity is how an operator tells them apart.
 */
describe('a vendor failure leaves this stage as its own error (§9)', () => {
    const vendorOutage = (): Error => {
        const error = new Error('USDA returned 503');
        error.name = 'UsdaError';

        return error;
    };

    const sweptRow = (index: number): UsdaFoodSummary => ({
        fdcId: 970000 + index,
        description: `Carrots, raw, boundary ${index}`,
        dataType: 'SR Legacy',
    });

    const depsThrowingFrom = (
        stage: 'list' | 'batch',
        reports: unknown[] = [],
    ): RunImportDeps =>
        ({
            db: new Proxy(
                {},
                {
                    get: (_target, property) => {
                        throw new Error(`the catalog was written after a vendor outage: db.${String(property)}`);
                    },
                },
            ),
            runDb: new Proxy(
                {},
                {
                    get: (_target, property) => {
                        throw new Error(`run state was touched before the plan: runDb.${String(property)}`);
                    },
                },
            ),
            usda: {
                listFoods: async (): Promise<UsdaFoodSummary[]> => {
                    if (stage === 'list') {
                        throw vendorOutage();
                    }

                    return [sweptRow(0)];
                },
                fetchBatch: async (): Promise<ImportBatchFetch> => {
                    throw vendorOutage();
                },
            },
            manifest,
            coveragePlan,
            // Dry run so the failure is reached without a database: the plan
            // pass is where `listFoods` is called, and it runs before any
            // claim. The batch case is proven against the real client in the
            // durable batch-ledger cases below, which assert the failed closure
            // too.
            options: options({ dryRun: true }),
            logger: silentLogger,
            now: () => new Date('2026-09-13T11:00:00.000Z'),
            installRateLimiter: () => (): void => undefined,
            writeReport: (report: unknown) => {
                reports.push(report);
            },
        }) as unknown as RunImportDeps;

    it('wraps an enumeration failure and names the sweep it stopped on', async () => {
        const failure = await runImport(depsThrowingFrom('list')).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogImportError);
        const wrapped = failure as CatalogImportError;
        expect(wrapped.name).toBe('CatalogImportError');
        expect(wrapped.code).toBe('usda_request_failed');
        expect(wrapped.context.sweepKey).toBe(manifest.datasetSweeps[0].sweepKey);
        // The original is kept, so nothing is lost to the wrap.
        expect((wrapped.underlying as Error).name).toBe('UsdaError');
        expect(describeFailure(wrapped).code).toBe('usda_request_failed');
    });

    it('does not wrap a failure that is not the vendor’s', async () => {
        const deps = depsThrowingFrom('list');
        const notVendor = new TypeError('cannot read properties of undefined');
        const withDefect = {
            ...deps,
            usda: {
                ...deps.usda,
                listFoods: async (): Promise<UsdaFoodSummary[]> => {
                    throw notVendor;
                },
            },
        } as unknown as RunImportDeps;

        // A defect in this file reported as "USDA did not answer" would send an
        // operator to the vendor's status page for a bug in the importer.
        await expect(runImport(withDefect)).rejects.toBe(notVendor);
    });
});

/**
 * `--manifest` states which curation the operator believes they are importing.
 *
 * It asserts rather than selects, because `loadUsdaManifest` resolves exactly
 * one document and version-checks it; what the flag adds is the refusal, and a
 * refusal is only worth having if it costs nothing — so it is checked before
 * the limiter, the plan and the first request.
 */
describe('--manifest refuses a curation the operator did not mean (§0.7.1)', () => {
    const countingDeps = (
        manifestVersion: string | null,
    ): { deps: RunImportDeps; listCalls: () => number; reports: unknown[] } => {
        let listCalls = 0;
        const reports: unknown[] = [];

        const deps = {
            db: new Proxy(
                {},
                {
                    get: (_target, property) => {
                        throw new Error(`a refused run reached the catalog: db.${String(property)}`);
                    },
                },
            ),
            runDb: new Proxy(
                {},
                {
                    get: (_target, property) => {
                        throw new Error(`a refused run reached run state: runDb.${String(property)}`);
                    },
                },
            ),
            usda: {
                listFoods: async (): Promise<UsdaFoodSummary[]> => {
                    listCalls += 1;

                    return [];
                },
                fetchBatch: async (): Promise<ImportBatchFetch> => batchFetch([], []),
            },
            manifest,
            coveragePlan,
            options: options({ dryRun: true, manifestVersion }),
            logger: silentLogger,
            now: () => new Date('2026-09-13T11:00:00.000Z'),
            installRateLimiter: () => (): void => undefined,
            writeReport: (report: unknown) => {
                reports.push(report);
            },
        } as unknown as RunImportDeps;

        return { deps, listCalls: () => listCalls, reports };
    };

    it('refuses a mismatch before spending a single request', async () => {
        const { deps, listCalls, reports } = countingDeps('v2');

        const failure = await runImport(deps).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogImportError);
        expect((failure as CatalogImportError).code).toBe('manifest_version_mismatch');
        expect((failure as CatalogImportError).context.manifestVersion).toBe('v2');
        // The whole point of checking first: nothing was enumerated, nothing
        // was reported and no run state exists to clean up.
        expect(listCalls()).toBe(0);
        expect(reports).toEqual([]);
    });

    it('proceeds when the stated version is the one the checkout ships', async () => {
        const { deps, reports } = countingDeps(manifest.usdaManifestVersion);

        const outcome = await runImport(deps);

        expect(outcome.runId).toBeNull();
        expect(reports).toHaveLength(1);
        expect((reports[0] as { options: { manifestVersion: string | null } }).options.manifestVersion).toBe(
            manifest.usdaManifestVersion,
        );
    });

    it('proceeds when no expectation was stated, which is the default', async () => {
        const { deps } = countingDeps(null);

        await expect(runImport(deps)).resolves.toMatchObject({ runId: null });
    });
});

/**
 * WHAT THE REPORT HAS TO SAY (AAP §0.7.1 Group 3, §0.7.3).
 *
 * The import half of data/meal-planning/reports/latest/import-report.json.
 * Every block here was absent before, and the committed artefact had to
 * describe the absence from the outside — `usdaRequests.unmeasuredReason` and
 * `measurementGaps` named this stage as the reason its counters were null. The
 * cases below are what stop that from being true again.
 */
describe('the import report states what the run measured (§0.7.3)', () => {
    interface CategoryRow {
        readonly category: string;
        readonly publishedTarget: number;
        readonly candidateVolume: number;
        readonly candidates: number;
        readonly published: number;
        readonly shortfall: number;
        readonly candidateVolumeShortfall: number;
    }

    const dryRunReport = (stats?: () => UsdaRequestStats): Record<string, unknown> => {
        const reports: unknown[] = [];
        const deps = {
            db: {},
            runDb: {},
            usda: {
                listFoods: async (): Promise<UsdaFoodSummary[]> => [],
                fetchBatch: async (): Promise<ImportBatchFetch> => batchFetch([], []),
            },
            manifest,
            coveragePlan,
            options: options({ dryRun: true }),
            logger: silentLogger,
            now: () => new Date('2026-09-13T11:00:00.000Z'),
            installRateLimiter: () => (): void => undefined,
            rateLimiterStats: stats,
            writeReport: (report: unknown) => {
                reports.push(report);
            },
        } as unknown as RunImportDeps;

        return runImport(deps).then(() => reports[0] as Record<string, unknown>) as unknown as Record<string, unknown>;
    };

    const measuredStats = (): UsdaRequestStats => ({
        configuredPerHour: 900,
        policyCapPerHour: 900,
        vendorCapPerHour: 1000,
        burstCapacity: 20,
        attempts: 617,
        pauses: 2,
        totalPausedMs: 41_000,
        longestPauseMs: 28_500,
        firstAttemptAt: '2026-09-13T10:00:00.000Z',
        lastAttemptAt: '2026-09-13T11:00:00.000Z',
        ledgerKind: 'file',
        ledgerScope: 'api.nal.usda.gov',
        attemptsInWindow: 640,
        // Every attempt lands in exactly one bucket, which is the identity the
        // report states and a reader checks the block by: these seven plus
        // transportFailures sum to `attempts`.
        statusClassCounts: {
            ok2xx: 600,
            retryable400: 6,
            timeout408: 1,
            throttled429: 4,
            otherClientError: 2,
            serverError: 3,
            otherStatus: 0,
        },
        transportFailures: 1,
    });

    it('writes the limiter’s own counters verbatim under usdaRequests', async () => {
        const report = await dryRunReport(measuredStats);
        const block = report.usdaRequests as Record<string, unknown>;

        // Verbatim: the field names are rateLimiter.ts's contract, and
        // catalog-report.ts reconciles against them.
        expect(block).toMatchObject(measuredStats());
        expect(block.unmeasured).toBe(false);
        expect(block.limiterCountsPhysicalAttempts).toBe(true);
        // A pause is the ceiling working, so the report has to say so rather
        // than leave a non-zero count looking like an error.
        expect(String(block.pausesNote)).toContain('never fail');
        // The retry accounting is explained and its owner named, not restated
        // as numbers this file would have to keep in step.
        expect(block.rulesOwnedBy).toBe('src/services/usda.service.ts');
        expect(String(block.accountingBasis)).toContain('Attempt-based');
        // 900 configured against a 1000 cap leaves the live API its share.
        expect(block.headroomPerHour).toBe(100);
        // And the 900 is reported as the ENFORCED ceiling, not as this
        // document's preference: a value above it is refused at startup.
        expect(block.importCeilingPerHour).toBe(USDA_IMPORT_POLICY_CAP_PER_HOUR);
        expect(String(block.importCeilingBasis)).toContain('refuses any higher configuration at startup');
        expect(block.policyCapPerHour).toBe(USDA_IMPORT_POLICY_CAP_PER_HOUR);
    });

    it('says a counter was not measured rather than reporting it as zero', async () => {
        const block = (await dryRunReport(undefined)).usdaRequests as Record<string, unknown>;

        expect(block.unmeasured).toBe(true);
        expect(String(block.unmeasuredReason)).toContain('zero would claim');
        // The absence is the assertion: a zero here would state that a run
        // which really did enumerate the sweeps issued no vendor request.
        expect(block).not.toHaveProperty('attempts');
        expect(block).not.toHaveProperty('pauses');
        expect(block).not.toHaveProperty('statusClassCounts');
        expect(block).not.toHaveProperty('transportFailures');
        // Named in the reason, so a reader looking for a status split finds out
        // it was not recorded rather than inferring a zero from its absence.
        expect(String(block.unmeasuredReason)).toContain('statusClassCounts');
        // The accounting basis is stated either way — it describes the stage,
        // not the invocation.
        expect(block.detailBatchSize).toBe(manifest.importLimits.detailBatchSize);
    });

    it('writes the measured status split, and the identity it is checked by', async () => {
        const block = (await dryRunReport(measuredStats)).usdaRequests as Record<string, unknown>;

        // The block used to carry a sentence saying nobody counted these,
        // which stopped being true once the limiter read each response's
        // status at the transport.
        expect(block).not.toHaveProperty('statusClassCountsUnavailable');
        expect(block.statusClassCounts).toEqual(measuredStats().statusClassCounts);
        expect(block.transportFailures).toBe(1);
        expect(String(block.statusClassCountsBasis)).toContain('Measured by scripts/lib/rateLimiter.ts');
        expect(String(block.statusClassCountsIdentity)).toContain('attempts ===');

        // The identity actually holds for the numbers written, which is what
        // makes the block checkable from the artefact alone.
        const counts = block.statusClassCounts as Record<string, number>;
        const summed =
            Object.values(counts).reduce((total, count) => total + count, 0) + (block.transportFailures as number);
        expect(summed).toBe(block.attempts);
    });

    it('separates the two import-stage dedupe mechanisms from the validator’s', async () => {
        const report = await dryRunReport(measuredStats);
        const duplicates = report.duplicatesRemoved as Record<string, unknown>;

        // Reported by a dry run because both mechanisms are applied while the
        // plan is built, before any fetch.
        expect(duplicates.skippedCuratedIdentityAtImport).toEqual(expect.any(Number));
        expect(duplicates.skippedDuplicateInPlanAtImport).toEqual(expect.any(Number));
        // The cross-table decision is catalog:validate's, and the report says
        // so rather than leaving a reader to assume this stage made it.
        //
        // `basisAtImport`, not `basis`: the block is co-written by three stages
        // (see scripts/lib/manifest.ts, CROSS-STAGE REPORT MERGING), so a
        // shared prose key meant whichever stage wrote last described only its
        // own sub-keys while appearing to describe the block.
        expect(String(duplicates.basisAtImport)).toContain('dedupeIdentity runs in catalog:validate');
        expect(duplicates).not.toHaveProperty('basis');
    });

    it('omits the measured blocks a dry run never looked at', async () => {
        const report = await dryRunReport(measuredStats);

        // An empty categories or quarantined block would read as "none found"
        // where the truth is "never validated": the dry run writes no row and
        // runs no check, so the honest report leaves them out.
        expect(report).not.toHaveProperty('categories');
        expect(report).not.toHaveProperty('quarantined');
        expect(report).not.toHaveProperty('failuresByCheck');
    });

    it('states plainly that a dry run does spend enumeration requests', async () => {
        const report = await dryRunReport(measuredStats);

        // The previous note claimed "Nothing was fetched", which the sweep
        // enumeration contradicts: buildImportPlan walks /foods/list.
        expect(String(report.note)).toContain('no detail record was fetched');
        expect(String(report.note)).not.toContain('Nothing was fetched');
    });
});

/**
 * The MEASURED half of the report, which only a real run can produce.
 *
 * These go through the real run ledger for the same reason the batch-accounting
 * cases do: the blocks are written at the end of a run that claimed a row, and
 * what is under test is the artefact that run leaves behind. The catalog writes
 * are faked — an empty vendor response leaves the persistence path with nothing
 * to write — which keeps the cases about the report alone.
 */
describe('the measured half of the import report (§0.7.3)', () => {
    const FIXED_NOW = new Date('2026-09-14T09:00:00.000Z');

    interface CategoryRow {
        readonly category: string;
        readonly publishedTarget: number;
        readonly candidateVolume: number;
        readonly candidates: number;
        readonly published: number;
        readonly shortfall: number;
        readonly candidateVolumeShortfall: number;
    }

    /** One batch of work, so the run reaches its report without a long plan. */
    const LIMIT = 20;

    const runScope = importRunScope(manifest.usdaManifestVersion, options({ limit: LIMIT }));

    const clearClaimedRun = async (): Promise<void> => {
        await prisma.catalog_import_runs.deleteMany({
            where: { kind: 'usda_import', manifest_version: runScope },
        });
    };

    beforeEach(clearClaimedRun);
    afterEach(clearClaimedRun);

    const transactionOnlyDb = (): ImportDb => ledgerOnlyCatalogDb('a report case');

    const destinations: ImportReportDestination[] = [];

    const runAndReadReport = async (): Promise<Record<string, unknown>> => {
        const reports: unknown[] = [];
        destinations.length = 0;
        const deps = {
            db: transactionOnlyDb(),
            runDb: prisma,
            usda: {
                listFoods: async (): Promise<UsdaFoodSummary[]> => [],
                fetchBatch: async (fdcIds: readonly number[]): Promise<ImportBatchFetch> => batchFetch([], fdcIds),
            },
            manifest,
            coveragePlan,
            options: options({ limit: LIMIT }),
            logger: silentLogger,
            now: () => FIXED_NOW,
            installRateLimiter: () => (): void => undefined,
            writeReport: (report: unknown, destination: ImportReportDestination) => {
                reports.push(report);
                destinations.push(destination);
            },
        } as unknown as RunImportDeps;

        await runImport(deps);
        expect(reports).toHaveLength(1);

        return reports[0] as Record<string, unknown>;
    };

    it('carries one categories row per coverage-plan category, with the exact shortfall', async () => {
        const report = await runAndReadReport();
        const rows = report.categories as CategoryRow[];

        expect(rows).toHaveLength(coveragePlan.categories.length);
        expect(rows.map((row) => row.category)).toEqual(coveragePlan.categories.map((row) => row.category));

        for (const planned of coveragePlan.categories) {
            const row = rows.find((candidate) => candidate.category === planned.category) as CategoryRow;
            expect(row.publishedTarget).toBe(planned.publishedTarget);
            expect(row.candidateVolume).toBe(planned.candidateVolume);
            // This stage publishes nothing, so the shortfall is the whole
            // target — reported exactly, never softened (§0.7.3).
            expect(row.published).toBe(0);
            expect(row.shortfall).toBe(planned.publishedTarget);
        }

        const coverage = report.coverage as {
            publishedTargetTotal: number;
            shortfallTotal: number;
            meetsTarget: boolean;
        };
        expect(coverage.shortfallTotal).toBe(coverage.publishedTargetTotal);
        expect(coverage.meetsTarget).toBe(false);
        // The basis is what stops the number being misread as a defect.
        expect(String(report.shortfallBasis)).toContain('writes none by design');
        expect(String(report.shortfallBasis)).toContain('candidateVolumeShortfall is the figure that judges THIS stage');
    });

    it('lists every category short of its candidate volume as a coverage gap', async () => {
        const report = await runAndReadReport();
        const gaps = report.coverageGaps as { category: string; candidateVolumeShortfall: number }[];

        // The vendor answered every batch with nothing, so no candidate was
        // written and every planned category is short by its whole volume.
        expect(gaps).toHaveLength(coveragePlan.categories.length);
        for (const gap of gaps) {
            const planned = coveragePlan.categories.find((row) => row.category === gap.category);
            expect(gap.candidateVolumeShortfall).toBe(planned?.candidateVolume);
        }
    });

    it('keys the failing-check totals by the tier catalog.logic.ts assigns', async () => {
        const report = await runAndReadReport();
        const failures = report.failuresByCheck as {
            checkNameVocabulary: string;
            importStage: Record<string, Record<string, number>>;
        };

        expect(failures.checkNameVocabulary).toContain('CATALOG_CHECK_NAMES');
        // All three tiers are always present, so a consumer never has to guess
        // whether an absent tier means "none" or "not reported".
        expect(Object.keys(failures.importStage).sort()).toEqual(['quarantine', 'reject', 'review']);
    });

    it('reports the quarantined list with its own bound, so a failing run still writes a readable report', async () => {
        const report = await runAndReadReport();
        const quarantined = report.quarantined as {
            total: number;
            listed: number;
            truncated: boolean;
            listLimit: number;
        };

        expect(quarantined.total).toBe(0);
        expect(quarantined.listed).toBe(0);
        expect(quarantined.truncated).toBe(false);
        // The bound is stated, so a truncated list can be recognised as one.
        expect(quarantined.listLimit).toBeGreaterThan(0);
    });

    it('is bound for the canonical artefact, because a real run measured rows it wrote', async () => {
        const report = await runAndReadReport();

        // The counterpart of the dry-run routing above: this run claimed a run
        // row and imported (or tried to import) rows, so its figures are
        // evidence and belong in the committed file.
        expect(destinations).toEqual(['canonical']);
        expect(report.reportKind).toBe('canonical');
    });

    it('measures provenance from the rows written rather than restating the policy', async () => {
        const report = await runAndReadReport();
        const identity = report.countsByIdentitySource as Record<string, unknown>;
        const provenance = report.countsByNutritionProvenance as Record<string, unknown>;

        // Nothing was written, so every measured total is 0 — and the zero is
        // measured, which is exactly what the wording has to say.
        expect(identity.usda).toBe(0);
        expect(identity.ai_generated).toBe(0);
        expect(String(identity.measuredFrom)).toContain('written on each catalog_foods row');
        expect(String(identity.aiGeneratedZeroReason)).toContain('never here');
        expect(provenance.source_backed).toBe(0);
        expect(provenance.ingredient_derived).toBe(0);
        expect(provenance.ai_estimated).toBe(0);
    });
});

/**
 * Writing the report file MERGES; it does not clobber (§0.7.3).
 *
 * `import-report.json` is a shared artefact: `catalog-report.ts` aggregates the
 * release identity, the cross-stage reconciliation and the measurement gaps
 * into the same document, and the committed v1 artefact carries all of it. A
 * plain `writeFileSync` at the end of an import would delete that half of the
 * file every time an operator re-imported, which is why the write layers this
 * stage's keys over whatever is already there.
 *
 * These cases run against a real temporary file rather than a fake `fs`,
 * because what is under test is the read-modify-write of an on-disk document —
 * the thing a stub would assume rather than prove.
 */
describe('writeImportReport merges into the sibling artefact (§0.7.3)', () => {
    let workspace: string;
    let target: string;

    // The two shapes of key a sibling stage owns: one this stage never emits
    // (must survive) and one it does (must be replaced by the fresher value).
    const SIBLING_ONLY_KEY = 'catalogRelease';
    const SHARED_KEY = 'counts';
    // A third shape, and the one exception to preservation: a key that asserts
    // something about the whole document rather than counting what its writer
    // measured. `aggregatedAt` says when the aggregate sections were computed,
    // so an import write landing after it makes it false — and no stage writes
    // it, so nothing can refresh it. AGGREGATE_OWNED_ASSERTION_KEYS names it
    // and the merge removes it instead of carrying it forward.
    const AGGREGATE_ASSERTION_KEY = 'aggregatedAt';

    // The database identity every write now stamps. The merge cases below are
    // about MERGING, so their fixture records this run's own digest: that is
    // what an artefact this pipeline published looks like from the first write
    // onward, and it keeps the target check on its silent path so a warning in
    // these cases means a merge defect rather than an adoption notice. The
    // adoption, agreement and refusal paths have their own cases further down.
    const TEST_TARGET_DIGEST = 'aabbccdd1122';

    const existingDocument = (): Record<string, unknown> => ({
        [SIBLING_ONLY_KEY]: 'v1',
        [AGGREGATE_ASSERTION_KEY]: '2026-09-10T00:00:00.000Z',
        producedBy: 'catalog-report.ts',
        [SHARED_KEY]: { inserted: 999 },
        [CATALOG_ARTIFACT_TARGET_IDENTITY_KEY]: catalogArtifactTargetIdentity(TEST_TARGET_DIGEST),
    });

    const warnings: { event: string; fields?: Record<string, unknown> }[] = [];
    const warnCapturingLogger: ScriptLogger = {
        debug: () => undefined,
        info: () => undefined,
        warn: (event: string, fields?: Record<string, unknown>) => {
            warnings.push({ event, fields });
        },
        error: () => undefined,
        child: () => warnCapturingLogger,
    };

    const readTarget = (): Record<string, unknown> =>
        JSON.parse(fs.readFileSync(target, 'utf-8')) as Record<string, unknown>;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-import-report-'));
        target = path.join(workspace, 'nested', 'import-report.json');
        warnings.length = 0;
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('preserves every key the import stage does not measure', () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(existingDocument(), null, 2), 'utf-8');

        writeImportReport(target, { [SHARED_KEY]: { inserted: 20 }, usdaRequests: { attempts: 1 } }, TEST_TARGET_DIGEST, warnCapturingLogger);
        const merged = readTarget();

        // The sibling's half is still the sibling's, byte-for-byte.
        expect(merged[SIBLING_ONLY_KEY]).toBe('v1');
        expect(merged.producedBy).toBe('catalog-report.ts');
        // This stage's half is this run's, not the stale aggregate's.
        expect(merged[SHARED_KEY]).toEqual({ inserted: 20 });
        expect(merged.usdaRequests).toEqual({ attempts: 1 });
        // Every pre-existing key survives EXCEPT the aggregate-owned
        // assertion, which this write did not supply and therefore cannot
        // leave standing: it would state an aggregation time earlier than the
        // write beside it.
        expect(merged).not.toHaveProperty(AGGREGATE_ASSERTION_KEY);
        for (const key of Object.keys(existingDocument())) {
            if (key === AGGREGATE_ASSERTION_KEY) {
                continue;
            }
            expect(merged).toHaveProperty(key);
        }
        expect(warnings).toEqual([]);
    });

    it('records which half of the artefact the run produced', () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify(existingDocument(), null, 2), 'utf-8');

        writeImportReport(target, { [SHARED_KEY]: { inserted: 20 } }, TEST_TARGET_DIGEST, warnCapturingLogger);
        const note = readTarget()[IMPORT_REPORT_NOTE_KEY] as Record<string, unknown>;

        expect(note.mergedIntoExisting).toBe(true);
        expect(note.stage).toBe('catalog-import-usda');
        // preservedKeys names what this write left alone — sorted, and holding
        // only the keys the report did not carry, so a reader can tell the two
        // halves apart without diffing the file against a previous copy.
        expect(note.preservedKeys).toEqual([SIBLING_ONLY_KEY, 'producedBy'].sort());
        expect(note.preservedKeys).not.toContain(SHARED_KEY);
        // The dropped assertion is named in the same note, so the removal is
        // visible to a reader of the artefact rather than silent.
        expect(note.preservedKeys).not.toContain(AGGREGATE_ASSERTION_KEY);
        expect(note.droppedAggregateAssertions).toEqual([AGGREGATE_ASSERTION_KEY]);
        // The co-written blocks are named in the note, so a reader can tell
        // which keys were merged by sub-key from those that were replaced.
        expect(note.compoundBlocks).toEqual(['duplicatesRemoved', 'failuresByCheck']);
        // This write carried no sibling sub-key: the existing document holds
        // neither compound block.
        expect(note.preservedSubKeys).toEqual({});
        expect(String(note.basis)).toContain('report stages all write into this file');
    });

    it('creates the document, and its directory, when no sibling has written one', () => {
        expect(fs.existsSync(target)).toBe(false);

        writeImportReport(target, { [SHARED_KEY]: { inserted: 0 } }, TEST_TARGET_DIGEST, warnCapturingLogger);
        const written = readTarget();
        const note = written[IMPORT_REPORT_NOTE_KEY] as Record<string, unknown>;

        expect(written[SHARED_KEY]).toEqual({ inserted: 0 });
        // Nothing was merged, and the note says so rather than claiming a
        // merge that never happened over an empty base.
        expect(note.mergedIntoExisting).toBe(false);
        expect(note.preservedKeys).toEqual([]);
        expect(warnings).toEqual([]);
    });

    it('replaces an unparseable document and says so, instead of failing the import', () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, '{"counts": {"inserted": 2', 'utf-8');

        writeImportReport(target, { [SHARED_KEY]: { inserted: 20 } }, TEST_TARGET_DIGEST, warnCapturingLogger);
        const written = readTarget();

        // The work is already committed to the database by the time the report
        // is written, so a half-written file must not throw it away — and the
        // replacement is never silent.
        expect(written[SHARED_KEY]).toEqual({ inserted: 20 });
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.event).toBe('report_replaced');
        expect(String(warnings[0]?.fields?.reason)).toContain('could not be parsed');
        // The file name is enough context; the path is not logged.
        expect(warnings[0]?.fields?.file).toBe('import-report.json');
    });

    it('replaces a document that is valid JSON but not an object', () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, JSON.stringify([{ counts: { inserted: 2 } }]), 'utf-8');

        writeImportReport(target, { [SHARED_KEY]: { inserted: 20 } }, TEST_TARGET_DIGEST, warnCapturingLogger);
        const written = readTarget();
        const note = written[IMPORT_REPORT_NOTE_KEY] as Record<string, unknown>;

        // An array spread into an object shape would produce "0", "1", … keys
        // beside the report, which is why it counts as unusable rather than as
        // a base to merge into.
        expect(Array.isArray(written)).toBe(false);
        expect(written).not.toHaveProperty('0');
        expect(note.mergedIntoExisting).toBe(false);
        expect(warnings[0]?.event).toBe('report_replaced');
        expect(String(warnings[0]?.fields?.reason)).toContain('not a JSON object');
    });

    it('writes a trailing newline so the artefact stays a well-formed text file', () => {
        writeImportReport(target, { [SHARED_KEY]: { inserted: 0 } }, TEST_TARGET_DIGEST, warnCapturingLogger);

        // The committed artefact ends in a newline; a write that dropped it
        // would show as a whole-file diff on every import.
        expect(fs.readFileSync(target, 'utf-8').endsWith('}\n')).toBe(true);
    });

    it('keeps the sub-keys a sibling stage contributed to a shared compound block', () => {
        // `duplicatesRemoved` and `failuresByCheck` are CO-WRITTEN: the
        // generation stage measures its own half of each and the report stage
        // measures the catalog-wide half, and all three sit side by side
        // because they answer the same question from three vantage points. A
        // top-level spread would have replaced the whole block, so an import
        // silently deleted the generation stage's measurements.
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(
            target,
            JSON.stringify(
                {
                    duplicatesRemoved: {
                        generationStage: { candidatesDropped: 12 },
                        basisAtGeneration: 'what the generation run merged',
                    },
                    failuresByCheck: { generationStage: { reject: { brand_pattern_name: 3 } } },
                    // The sibling stage that wrote this document stamped the
                    // database it addressed, as every stage now does; carrying
                    // it keeps this case about compound-block merging rather
                    // than about the adoption of an unstamped artefact, which
                    // has its own cases below.
                    [CATALOG_ARTIFACT_TARGET_IDENTITY_KEY]: catalogArtifactTargetIdentity(TEST_TARGET_DIGEST),
                },
                null,
                2,
            ),
            'utf-8',
        );

        writeImportReport(
            target,
            {
                duplicatesRemoved: { skippedDuplicateInPlanAtImport: 4, basisAtImport: 'what this import skipped' },
                failuresByCheck: { importStage: { reject: {}, quarantine: {}, review: {} } },
            },
            TEST_TARGET_DIGEST,
            warnCapturingLogger,
        );
        const merged = readTarget();
        const duplicates = merged.duplicatesRemoved as Record<string, unknown>;
        const failures = merged.failuresByCheck as Record<string, unknown>;

        // Both halves of both blocks, in one document.
        expect(duplicates.generationStage).toEqual({ candidatesDropped: 12 });
        expect(duplicates.basisAtGeneration).toBe('what the generation run merged');
        expect(duplicates.skippedDuplicateInPlanAtImport).toBe(4);
        expect(duplicates.basisAtImport).toBe('what this import skipped');
        expect(failures.generationStage).toEqual({ reject: { brand_pattern_name: 3 } });
        expect(failures.importStage).toEqual({ reject: {}, quarantine: {}, review: {} });

        // And the note names what survived, sub-key by sub-key, so the
        // preservation is legible in the artefact and not only in the code.
        const note = merged[IMPORT_REPORT_NOTE_KEY] as Record<string, unknown>;
        expect(note.preservedSubKeys).toEqual({
            duplicatesRemoved: ['basisAtGeneration', 'generationStage'],
            failuresByCheck: ['generationStage'],
        });
        // A compound block is merged, so it is not a "preserved key": half of
        // it is this run's.
        expect(note.preservedKeys).toEqual([]);
        expect(warnings).toEqual([]);
    });

    it('publishes through a rename, so an interrupted write cannot truncate the artefact', () => {
        const previous = { counts: { inserted: 1 }, catalogRelease: 'v1' };
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${JSON.stringify(previous, null, 2)}\n`, 'utf-8');

        const renames: { from: string; to: string }[] = [];
        const originalRename = fs.renameSync;
        const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
            renames.push({ from: String(from), to: String(to) });
            return originalRename(from, to);
        }) as typeof fs.renameSync);

        try {
            writeImportReport(target, { counts: { inserted: 20 } }, TEST_TARGET_DIGEST, warnCapturingLogger);
        } finally {
            renameSpy.mockRestore();
        }

        // Exactly one rename, from a sibling in the SAME directory — which is
        // what makes it atomic rather than a copy — onto the artefact itself.
        expect(renames).toHaveLength(1);
        expect(renames[0]?.to).toBe(target);
        expect(path.dirname(renames[0]?.from ?? '')).toBe(path.dirname(target));
        expect(renames[0]?.from).not.toBe(target);

        // The document landed whole, and the directory holds no leftover.
        expect(readTarget().counts).toEqual({ inserted: 20 });
        expect(fs.readdirSync(path.dirname(target))).toEqual(['import-report.json']);
    });

    it('refuses to write while another stage is publishing into the same directory', () => {
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const previous = { counts: { inserted: 1 } };
        fs.writeFileSync(target, `${JSON.stringify(previous, null, 2)}\n`, 'utf-8');

        const held = acquireArtifactPublicationLock(path.dirname(target), 'catalog-report:artefacts');
        try {
            // Loud, not skipped: the import's rows are already committed, but a
            // report written underneath another publisher would revert that
            // publisher's half of the artefact. The rerun is a no-op for the
            // database, so failing here costs an operator a command and saves
            // the evidence.
            const failure = (() => {
                try {
                    writeImportReport(target, { counts: { inserted: 20 } }, TEST_TARGET_DIGEST, warnCapturingLogger);
                    return null;
                } catch (error) {
                    return error;
                }
            })();

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('artifact_publication_locked');
            expect((failure as ManifestError).message).toContain('catalog-report:artefacts');
            // And the artefact the other publisher is working on is untouched.
            expect(readTarget().counts).toEqual({ inserted: 1 });
        } finally {
            held.release();
        }
    });
});

/**
 * WHICH DATABASE THE ARTEFACT DESCRIBES (§0.7.3, §0.9.3).
 *
 * `import-report.json` is merged into by three stages, and because the merge
 * PRESERVES the keys a write does not supply, an import pointed at a second
 * database used to fold its own counters into a document describing the first
 * — leaving an artefact whose two halves came from two catalogs with nothing on
 * its face saying so. Every write now records the digest of the database it
 * addressed, and a write whose digest disagrees with the one on disk is
 * refused rather than merged.
 *
 * The decision itself is pure and lives in `src/services/catalog.logic.ts`,
 * where `catalog.logic.test.ts` owns its truth table. What these cases pin is
 * the WIRING: that this stage asks before it merges, that the refusal leaves
 * the file byte-identical, that the identity it stamps is the origin's own, and
 * that stamping it did not make the artefact non-deterministic.
 */
describe('writeImportReport records and checks the database the artefact describes (§0.7.3)', () => {
    const RUN_DIGEST = 'aabbccdd1122';
    const OTHER_DIGEST = 'ffeeddccbbaa';

    let workspace: string;
    let target: string;
    const events: { level: 'info' | 'warn'; event: string; fields?: Record<string, unknown> }[] = [];
    const recordingLogger: ScriptLogger = {
        debug: () => undefined,
        info: (event: string, fields?: Record<string, unknown>) => {
            events.push({ level: 'info', event, fields });
        },
        warn: (event: string, fields?: Record<string, unknown>) => {
            events.push({ level: 'warn', event, fields });
        },
        error: () => undefined,
        child: () => recordingLogger,
    };

    const identityBlock = (): Record<string, unknown> =>
        (JSON.parse(fs.readFileSync(target, 'utf-8')) as Record<string, unknown>)[
            CATALOG_ARTIFACT_TARGET_IDENTITY_KEY
        ] as Record<string, unknown>;

    const eventNames = (name: string): Record<string, unknown>[] =>
        events.filter((entry) => entry.event === name).map((entry) => entry.fields ?? {});

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-import-target-'));
        target = path.join(workspace, 'import-report.json');
        events.length = 0;
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    it('stamps the digest of the database it wrote against, on a first write', () => {
        writeImportReport(target, { counts: { inserted: 3 } }, RUN_DIGEST, recordingLogger);

        const identity = identityBlock();
        expect(identity[CATALOG_ARTIFACT_TARGET_DIGEST_FIELD]).toBe(RUN_DIGEST);
        // The basis travels with the value: a reader of the committed file has
        // to know what the digest is of, and that it discloses no host name.
        expect(String(identity.digestBasis)).toContain('one-way digest');
        // A first write has no recorded identity to disagree with, so it is
        // reported as such rather than as an adoption — and quietly.
        const checked = eventNames('artefact_target_checked');
        expect(checked).toHaveLength(1);
        expect(checked[0]?.verdict).toBe('first_write');
        expect(checked[0]?.recordedDigest).toBe('none');
        expect(eventNames('artefact_target_adopted')).toEqual([]);
    });

    it('adopts an artefact that records no identity, and warns rather than refusing', () => {
        // Exactly the committed v1 artefact's shape: published before the field
        // existed. Refusing it would make the field impossible to introduce.
        fs.writeFileSync(target, `${JSON.stringify({ catalogRelease: 'v1', counts: { inserted: 1 } }, null, 2)}\n`, 'utf-8');

        writeImportReport(target, { counts: { inserted: 3 } }, RUN_DIGEST, recordingLogger);

        const adopted = eventNames('artefact_target_adopted');
        expect(adopted).toHaveLength(1);
        expect(adopted[0]?.verdict).toBe('adopted');
        expect(adopted[0]?.recordedDigest).toBe('none');
        expect(adopted[0]?.targetDigest).toBe(RUN_DIGEST);
        expect(String(adopted[0]?.basis)).toContain('adopted rather than refused');
        // The write went through, the sibling's key survived, and the document
        // now carries an identity — so the NEXT write against another database
        // is refused instead of merged.
        const written = JSON.parse(fs.readFileSync(target, 'utf-8')) as Record<string, unknown>;
        expect(written.catalogRelease).toBe('v1');
        expect(written.counts).toEqual({ inserted: 3 });
        expect(identityBlock()[CATALOG_ARTIFACT_TARGET_DIGEST_FIELD]).toBe(RUN_DIGEST);
    });

    it('merges without a warning when the artefact already records this run\u2019s database', () => {
        writeImportReport(target, { counts: { inserted: 1 } }, RUN_DIGEST, recordingLogger);
        events.length = 0;

        writeImportReport(target, { counts: { inserted: 3 } }, RUN_DIGEST, recordingLogger);

        const checked = eventNames('artefact_target_checked');
        expect(checked).toHaveLength(1);
        expect(checked[0]?.verdict).toBe('agrees');
        expect(checked[0]?.recordedDigest).toBe(RUN_DIGEST);
        expect(eventNames('artefact_target_adopted')).toEqual([]);
        expect(events.filter((entry) => entry.level === 'warn')).toEqual([]);
    });

    it('refuses an artefact describing a different database, and leaves it byte-identical', () => {
        writeImportReport(target, { counts: { inserted: 1 }, catalogRelease: 'v1' }, OTHER_DIGEST, recordingLogger);
        const before = fs.readFileSync(target);
        events.length = 0;

        const failure = (() => {
            try {
                writeImportReport(target, { counts: { inserted: 3 } }, RUN_DIGEST, recordingLogger);
                return null;
            } catch (error) {
                return error;
            }
        })();

        expect(failure).toBeInstanceOf(CatalogArtifactTargetError);
        const refusal = failure as CatalogArtifactTargetError;
        expect(refusal.code).toBe('artefact_target_mismatch');
        // The remedy is in the message, and the file name is the only path-like
        // value in it: an absolute path is environment, and the URL is a secret.
        expect(refusal.message).toContain('nothing was written');
        expect(refusal.message).toContain('catalog:report --out');
        expect(refusal.context.file).toBe('import-report.json');
        expect(refusal.context.recordedDigest).toBe(OTHER_DIGEST);
        expect(refusal.context.runDigest).toBe(RUN_DIGEST);
        // NOT "the counters are unchanged" — the whole file, byte for byte.
        // A refusal that rewrote the document differently would still have
        // corrupted the evidence it claims to have protected.
        expect(fs.readFileSync(target).equals(before)).toBe(true);
        // And the refusal is reported under its own code, so an operator reads
        // "which database did I mean" rather than a defect report.
        expect(describeFailure(refusal).code).toBe('artefact_target_mismatch');
        expect(describeFailure(refusal).error.name).toBe('CatalogArtifactTargetError');
    });

    it('adds no per-write value to the artefact, so reruns stay byte-identical', () => {
        const report = { counts: { inserted: 3 }, usdaRequests: { attempts: 7 } };
        const snapshots: Buffer[] = [];
        for (let write = 0; write < 3; write += 1) {
            writeImportReport(target, report, RUN_DIGEST, recordingLogger);
            snapshots.push(fs.readFileSync(target));
        }

        // The property that matters: STEADY STATE is byte-stable. Recording the
        // target identity must not make an artefact differ between two runs
        // that read the same catalog, because the release reconciliation
        // compares the committed file against a fresh one.
        expect(snapshots[1]?.equals(snapshots[2] ?? Buffer.alloc(0))).toBe(true);

        // The identity block itself is identical from the FIRST write onward:
        // it carries the digest and its basis, and deliberately no verdict and
        // no clock (catalog.logic.ts catalogArtifactTargetIdentity explains
        // why — the verdict is a property of the write, not of the target, and
        // it is reported in the run log instead).
        const identityOf = (snapshot: Buffer): unknown =>
            (JSON.parse(snapshot.toString('utf-8')) as Record<string, unknown>)[CATALOG_ARTIFACT_TARGET_IDENTITY_KEY];
        expect(identityOf(snapshots[0] ?? Buffer.alloc(0))).toEqual(identityOf(snapshots[1] ?? Buffer.alloc(0)));
        expect(identityOf(snapshots[1] ?? Buffer.alloc(0))).toEqual(identityOf(snapshots[2] ?? Buffer.alloc(0)));

        // A first write DOES differ from the writes after it, in exactly one
        // pre-existing field of the merge note and nowhere else: it created the
        // document rather than merging into one. Pinned rather than glossed
        // over, so a future non-determinism cannot hide behind it.
        const noteOf = (snapshot: Buffer): Record<string, unknown> =>
            (JSON.parse(snapshot.toString('utf-8')) as Record<string, unknown>)[
                IMPORT_REPORT_NOTE_KEY
            ] as Record<string, unknown>;
        expect(noteOf(snapshots[0] ?? Buffer.alloc(0)).mergedIntoExisting).toBe(false);
        expect(noteOf(snapshots[1] ?? Buffer.alloc(0)).mergedIntoExisting).toBe(true);
        const withoutNote = (snapshot: Buffer): Record<string, unknown> => {
            const document = JSON.parse(snapshot.toString('utf-8')) as Record<string, unknown>;
            delete document[IMPORT_REPORT_NOTE_KEY];
            return document;
        };
        expect(withoutNote(snapshots[0] ?? Buffer.alloc(0))).toEqual(withoutNote(snapshots[1] ?? Buffer.alloc(0)));
    });

    it('stamps the preview destination too, so two previews can be told apart', () => {
        // The preview is disposable, but "which database did this preview read"
        // is the first question an operator comparing two of them has.
        const preview = path.join(workspace, 'preview.json');
        fs.writeFileSync(preview, JSON.stringify(withArtifactTargetIdentity({ reportKind: 'dry_run_preview' }, RUN_DIGEST)), 'utf-8');

        const identity = (JSON.parse(fs.readFileSync(preview, 'utf-8')) as Record<string, unknown>)[
            CATALOG_ARTIFACT_TARGET_IDENTITY_KEY
        ] as Record<string, unknown>;

        expect(identity[CATALOG_ARTIFACT_TARGET_DIGEST_FIELD]).toBe(RUN_DIGEST);
        expect(String(identity.digestBasis)).toContain('same database');
    });
});

/**
 * THE ARTEFACT PUBLICATION HELPER.
 *
 * Every report this pipeline commits — the import report, the validation
 * report, the benchmark report, the recipe coverage report — is written through
 * `scripts/lib/manifest.ts`, so atomicity is a property of the pipeline rather
 * than of each of the seven call sites. These cases run against real temporary
 * directories, because what is under test is what the filesystem is left
 * holding when a publication is interrupted — precisely the thing a stubbed
 * `fs` would assume instead of prove.
 */
describe('the artefact publication helper every report stage writes through', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-publication-'));
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const readJson = (absolutePath: string): Record<string, unknown> =>
        JSON.parse(fs.readFileSync(absolutePath, 'utf-8')) as Record<string, unknown>;

    describe('stagingPathFor', () => {
        it('names a hidden sibling in the same directory, so the promotion is a same-filesystem rename', () => {
            const target = path.join(workspace, 'report.json');
            const staging = stagingPathFor(target);

            // Same directory: a rename across filesystems is not atomic, and
            // os.tmpdir() is very often a different filesystem from the
            // repository.
            expect(path.dirname(staging)).toBe(path.dirname(target));
            expect(path.basename(staging).startsWith('.report.json.')).toBe(true);
            // The pid is in the name, so two publishers staging the same
            // artefact write two files and neither sees the other's partial
            // document.
            expect(path.basename(staging)).toContain(String(process.pid));
        });

        it('never returns the same path twice within a process', () => {
            const target = path.join(workspace, 'report.json');
            const paths = [stagingPathFor(target), stagingPathFor(target), stagingPathFor(target)];

            expect(new Set(paths).size).toBe(paths.length);
        });
    });

    describe('writeJsonFile', () => {
        it('creates the directory, writes the document and leaves no staging file behind', () => {
            const target = path.join(workspace, 'nested', 'deeper', 'report.json');

            writeJsonFile(target, { counts: { inserted: 3 } });

            expect(readJson(target)).toEqual({ counts: { inserted: 3 } });
            expect(fs.readFileSync(target, 'utf-8').endsWith('}\n')).toBe(true);
            expect(fs.readdirSync(path.dirname(target))).toEqual(['report.json']);
        });

        it('replaces the previous document by rename rather than truncating it in place', () => {
            const target = path.join(workspace, 'report.json');
            writeJsonFile(target, { generation: 1 });

            const renames: { from: string; to: string }[] = [];
            const originalRename = fs.renameSync;
            const renameSpy = jest.spyOn(fs, 'renameSync').mockImplementation(((from: fs.PathLike, to: fs.PathLike) => {
                renames.push({ from: String(from), to: String(to) });
                return originalRename(from, to);
            }) as typeof fs.renameSync);

            try {
                writeJsonFile(target, { generation: 2 });
            } finally {
                renameSpy.mockRestore();
            }

            // The rename is the whole point: a reader either sees generation 1
            // or generation 2 and never a file that stops mid-document.
            expect(renames).toEqual([{ from: expect.stringContaining('.report.json.'), to: target }]);
            expect(readJson(target)).toEqual({ generation: 2 });
        });
    });

    describe('a staged set', () => {
        const stage = (dir: string): { validation: StagedArtifact; importReport: StagedArtifact } => ({
            validation: stageJsonArtifact(path.join(dir, 'validation-report.json'), { items: { a: 1 } }),
            importReport: stageJsonArtifact(path.join(dir, 'import-report.json'), { counts: { inserted: 2 } }),
        });

        it('exists on disk without either artefact having changed', () => {
            writeJsonFile(path.join(workspace, 'validation-report.json'), { items: { previous: true } });
            writeJsonFile(path.join(workspace, 'import-report.json'), { counts: { inserted: 1 } });

            const staged = stage(workspace);

            // Both staged documents are complete files, and both canonical
            // paths still hold the PREVIOUS run's artefacts.
            expect(fs.existsSync(staged.validation.stagingPath)).toBe(true);
            expect(fs.existsSync(staged.importReport.stagingPath)).toBe(true);
            expect(readJson(path.join(workspace, 'validation-report.json'))).toEqual({ items: { previous: true } });
            expect(readJson(path.join(workspace, 'import-report.json'))).toEqual({ counts: { inserted: 1 } });
        });

        it('becomes both artefacts at once when it is promoted', () => {
            const staged = stage(workspace);

            promoteStagedArtifacts([staged.validation, staged.importReport]);

            expect(readJson(path.join(workspace, 'validation-report.json'))).toEqual({ items: { a: 1 } });
            expect(readJson(path.join(workspace, 'import-report.json'))).toEqual({ counts: { inserted: 2 } });
            // Nothing is left over, so a later run cannot mistake a leftover
            // staging file for a document to promote.
            expect(fs.readdirSync(workspace).sort()).toEqual(['import-report.json', 'validation-report.json']);
        });

        it('leaves the previous pair intact when it is discarded instead', () => {
            writeJsonFile(path.join(workspace, 'validation-report.json'), { items: { previous: true } });
            writeJsonFile(path.join(workspace, 'import-report.json'), { counts: { inserted: 1 } });
            const staged = stage(workspace);

            discardStagedArtifacts([staged.validation, staged.importReport]);

            expect(readJson(path.join(workspace, 'validation-report.json'))).toEqual({ items: { previous: true } });
            expect(readJson(path.join(workspace, 'import-report.json'))).toEqual({ counts: { inserted: 1 } });
            expect(fs.readdirSync(workspace).sort()).toEqual(['import-report.json', 'validation-report.json']);
        });

        it('can be discarded twice, because a failed promotion has already removed some of it', () => {
            const staged = stage(workspace);

            discardStagedArtifacts([staged.validation, staged.importReport]);

            // The failure path calls discard after promote may already have
            // renamed one of the files away, so discard has to tolerate a
            // staging path that is no longer there.
            expect(() => discardStagedArtifacts([staged.validation, staged.importReport])).not.toThrow();
        });

        it('is refused whole when one document is truncated, and the previous pair survives', () => {
            writeJsonFile(path.join(workspace, 'validation-report.json'), { items: { previous: true } });
            writeJsonFile(path.join(workspace, 'import-report.json'), { counts: { inserted: 1 } });
            const staged = stage(workspace);

            // A document that stops mid-way is what an interrupted stream
            // leaves: valid-looking JSON until the point it was cut.
            const truncated = fs.readFileSync(staged.validation.stagingPath, 'utf-8').slice(0, 12);
            fs.writeFileSync(staged.validation.stagingPath, truncated, 'utf-8');

            const failure = (() => {
                try {
                    promoteStagedArtifacts([staged.validation, staged.importReport]);
                    return null;
                } catch (error) {
                    return error;
                }
            })();

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('incomplete_staged_artifact');
            // NEITHER artefact moved: the pair is only evidence together, so a
            // truncated half means the run published nothing.
            expect(readJson(path.join(workspace, 'validation-report.json'))).toEqual({ items: { previous: true } });
            expect(readJson(path.join(workspace, 'import-report.json'))).toEqual({ counts: { inserted: 1 } });
        });

        it('checks the terminator its writer actually ends with', () => {
            const staged = stageJsonArtifact(path.join(workspace, 'report.json'), { a: 1 });

            // The size-and-tail check, not a parse: the validation report is
            // tens of megabytes and parsing it to prove it parses would cost a
            // second and several hundred megabytes on every run.
            expect(() => assertStagedDocumentComplete(staged)).not.toThrow();
            fs.writeFileSync(staged.stagingPath, '{"a": 1}', 'utf-8');
            expect(() => assertStagedDocumentComplete(staged)).toThrow(/does not end with the terminator/);
        });
    });

    describe('the publication lock', () => {
        it('admits one publisher and names the holder to the second', () => {
            const first = acquireArtifactPublicationLock(workspace, 'catalog-import-usda:report');
            try {
                const failure = (() => {
                    try {
                        acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
                        return null;
                    } catch (error) {
                        return error;
                    }
                })();

                expect(failure).toBeInstanceOf(ManifestError);
                expect((failure as ManifestError).code).toBe('artifact_publication_locked');
                // The holder and its pid, so an operator can tell a running
                // stage from a leftover file without guessing.
                expect((failure as ManifestError).message).toContain('catalog-import-usda:report');
                expect((failure as ManifestError).message).toContain(String(process.pid));
            } finally {
                first.release();
            }

            // Released, so the directory is publishable again.
            const second = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
            second.release();
            expect(fs.existsSync(first.lockPath)).toBe(false);
        });

        it('releases on the failure path, so one failed publication does not block the next run', () => {
            const failure = (() => {
                try {
                    withArtifactPublicationLockSync(workspace, 'catalog-report:artefacts', () => {
                        throw new Error('the publication failed');
                    });
                    return null;
                } catch (error) {
                    return error;
                }
            })();

            expect((failure as Error).message).toBe('the publication failed');
            const retaken = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
            retaken.release();
        });

        it('takes over a lock whose holder is gone', () => {
            const probe = acquireArtifactPublicationLock(workspace, 'probe');
            const lockPath = probe.lockPath;
            probe.release();

            // A killed run leaves its record behind. The pid is what decides
            // it: a holder whose process no longer exists is stale
            // immediately, whatever the timestamp says.
            fs.writeFileSync(
                lockPath,
                `${JSON.stringify(
                    {
                        holder: 'catalog-import-usda:report',
                        pid: DEAD_PID,
                        startedAt: new Date().toISOString(),
                        directory: workspace,
                    },
                    null,
                    2,
                )}\n`,
                'utf-8',
            );

            const taken = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
            taken.release();
            expect(fs.existsSync(lockPath)).toBe(false);
        });

        it('takes over a lock older than the stale bound even when its pid is live', () => {
            const probe = acquireArtifactPublicationLock(workspace, 'probe');
            const lockPath = probe.lockPath;
            probe.release();

            fs.writeFileSync(
                lockPath,
                `${JSON.stringify(
                    {
                        holder: 'catalog-validate:report',
                        pid: process.pid,
                        startedAt: new Date(Date.now() - ARTIFACT_LOCK_STALE_MS - 1_000).toISOString(),
                        directory: workspace,
                    },
                    null,
                    2,
                )}\n`,
                'utf-8',
            );

            const taken = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
            taken.release();
        });

        it('scopes the lock to the directory, so two output directories publish in parallel', () => {
            const other = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-publication-other-'));
            const first = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
            try {
                // A `--out` run and the committed pair are different evidence;
                // one must not block the other.
                const second = acquireArtifactPublicationLock(other, 'catalog-report:artefacts');
                second.release();
            } finally {
                first.release();
                fs.rmSync(other, { recursive: true, force: true });
            }
        });
    });
});

/**
 * THE FAILURE PATHS OF PUBLICATION.
 *
 * The happy path proves the artefacts appear; only these prove they cannot
 * appear half-replaced. Each test drives a real filesystem and forces the exact
 * interleaving the finding describes, because "the renames run back to back" is
 * an argument and a rolled-back pair on disk is evidence.
 */
describe('publication under failure, contention and attack', () => {
    let workspace: string;
    let validationPath: string;
    let importPath: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-publication-failure-'));
        validationPath = path.join(workspace, 'validation-report.json');
        importPath = path.join(workspace, 'import-report.json');
        fs.writeFileSync(validationPath, '{\n  "generation": 1\n}\n');
        fs.writeFileSync(importPath, '{\n  "generation": 1\n}\n');
    });

    afterEach(() => {
        jest.restoreAllMocks();
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const generationOf = (absolutePath: string): unknown =>
        (JSON.parse(fs.readFileSync(absolutePath, 'utf-8')) as Record<string, unknown>).generation;

    const visibleEntries = (): string[] => fs.readdirSync(workspace).sort();

    describe('a failure part-way through promoting the set', () => {
        it('rolls the whole set back, so no mixed generation is ever addressable', () => {
            const staged = [
                stageJsonArtifact(validationPath, { generation: 2 }),
                stageJsonArtifact(importPath, { generation: 2 }),
            ];

            // Fail the rename that moves the SECOND staged document into place —
            // the exact interleaving that used to leave one new file beside one
            // old one permanently.
            const realRename = fs.renameSync.bind(fs);
            jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                if (String(from) === staged[1].stagingPath && String(to) === importPath) {
                    throw new Error('injected rename failure');
                }
                return realRename(from as string, to as string);
            });

            expect(() => promoteStagedArtifacts(staged)).toThrow(/rolled back/);

            // Both canonical paths hold the generation they had on entry.
            expect(generationOf(validationPath)).toBe(1);
            expect(generationOf(importPath)).toBe(1);
            expect(generationOf(validationPath)).toBe(generationOf(importPath));
        });

        it('leaves no staging, backup or journal debris behind after rolling back', () => {
            const staged = [
                stageJsonArtifact(validationPath, { generation: 2 }),
                stageJsonArtifact(importPath, { generation: 2 }),
            ];
            const realRename = fs.renameSync.bind(fs);
            jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                if (String(from) === staged[1].stagingPath && String(to) === importPath) {
                    throw new Error('injected rename failure');
                }
                return realRename(from as string, to as string);
            });

            expect(() => promoteStagedArtifacts(staged)).toThrow();

            // Only the two artefacts: no `.tmp`, no `.previous`, no journal.
            expect(visibleEntries()).toEqual(['import-report.json', 'validation-report.json']);
        });

        it('names the artefact it failed on, so an operator is not left guessing', () => {
            const staged = [
                stageJsonArtifact(validationPath, { generation: 2 }),
                stageJsonArtifact(importPath, { generation: 2 }),
            ];
            const realRename = fs.renameSync.bind(fs);
            jest.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
                if (String(from) === staged[1].stagingPath && String(to) === importPath) {
                    throw new Error('injected rename failure');
                }
                return realRename(from as string, to as string);
            });

            try {
                promoteStagedArtifacts(staged);
                throw new Error('expected the publication to fail');
            } catch (error) {
                expect((error as ManifestError).code).toBe('artifact_publication_failed');
                expect((error as Error).message).toContain('import-report.json');
                expect((error as Error).message).toContain('before this run');
            }
        });

        it('refuses a set spanning two directories rather than weakening the guarantee', () => {
            const other = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-publication-other-'));
            try {
                const staged = [
                    stageJsonArtifact(validationPath, { generation: 2 }),
                    stageJsonArtifact(path.join(other, 'import-report.json'), { generation: 2 }),
                ];
                expect(() => promoteStagedArtifacts(staged)).toThrow(/must share one directory/);
                // The refusal happens before anything moves.
                expect(generationOf(validationPath)).toBe(1);
            } finally {
                fs.rmSync(other, { recursive: true, force: true });
            }
        });
    });

    describe('a publication a process was killed in the middle of', () => {
        // Reproduces the on-disk state a crash between the two renames leaves:
        // the journal, one artefact's previous content moved to its backup, and
        // the new document already in its place.
        const leaveInterruptedPublication = (): void => {
            const staged = stageJsonArtifact(validationPath, { generation: 99 });
            const backupPath = path.join(workspace, '.validation-report.json.4242.abcdef01.previous');
            fs.renameSync(validationPath, backupPath);
            fs.renameSync(staged.stagingPath, validationPath);
            fs.writeFileSync(
                path.join(workspace, '.artefact-publication.journal'),
                `${JSON.stringify(
                    {
                        holderPid: 4242,
                        startedAt: new Date().toISOString(),
                        entries: [
                            { finalPath: validationPath, stagingPath: staged.stagingPath, backupPath },
                        ],
                    },
                    null,
                    2,
                )}\n`,
            );
        };

        it('reverts the set to the generation published before it, not forward into it', () => {
            leaveInterruptedPublication();
            // The interrupted run's document is on disk at this point.
            expect(generationOf(validationPath)).toBe(99);

            const reverted = recoverInterruptedPublication(workspace);

            expect(reverted).toEqual(['validation-report.json']);
            expect(generationOf(validationPath)).toBe(1);
            expect(visibleEntries()).toEqual(['import-report.json', 'validation-report.json']);
        });

        it('is performed automatically by the next publisher, under the lock', () => {
            leaveInterruptedPublication();

            // A publisher that knows nothing about the interrupted run.
            withArtifactPublicationLockSync(workspace, 'catalog-import-usda:report', () => undefined);

            expect(generationOf(validationPath)).toBe(1);
            expect(fs.existsSync(path.join(workspace, '.artefact-publication.journal'))).toBe(false);
        });

        it('does nothing, and does not throw, when no publication was interrupted', () => {
            expect(recoverInterruptedPublication(workspace)).toEqual([]);
            expect(generationOf(validationPath)).toBe(1);
        });
    });

    describe('the publication lock under contention', () => {
        it('makes two callers of one physical directory contend, even through a symlink', () => {
            // `path.resolve` leaves symlinks alone, so keying the lock on the
            // spelling let an `--out <symlink>` run publish beside the committed
            // path into the same file.
            const alias = path.join(os.tmpdir(), `soh-publication-alias-${process.pid}`);
            fs.symlinkSync(workspace, alias);
            const held = acquireArtifactPublicationLock(workspace, 'catalog-import-usda:report');
            try {
                expect(() => acquireArtifactPublicationLock(alias, 'catalog-report:artefacts')).toThrow(
                    /is being published by/,
                );
            } finally {
                held.release();
                fs.rmSync(alias);
            }
        });

        it('records the physical directory, not the spelling the run used', () => {
            const alias = path.join(os.tmpdir(), `soh-publication-record-${process.pid}`);
            fs.symlinkSync(workspace, alias);
            const held = acquireArtifactPublicationLock(alias, 'catalog-report:artefacts');
            try {
                const record = JSON.parse(fs.readFileSync(held.lockPath, 'utf-8')) as Record<string, unknown>;
                expect(record.directory).toBe(fs.realpathSync(workspace));
            } finally {
                held.release();
                fs.rmSync(alias);
            }
        });

        it('exposes its record the instant the lock exists, never an empty file', () => {
            // `open(wx)` then write left a window in which a contender read no
            // record and — under any "unreadable means abandoned" rule — stole a
            // live lock. The record is linked into place with its content.
            const held = acquireArtifactPublicationLock(workspace, 'catalog-import-usda:report');
            try {
                const record = JSON.parse(fs.readFileSync(held.lockPath, 'utf-8')) as Record<string, unknown>;
                expect(record.pid).toBe(process.pid);
                expect(record.holder).toBe('catalog-import-usda:report');
                expect(String(record.startedAt)).not.toHaveLength(0);
            } finally {
                held.release();
            }
        });

        it('treats a fresh unreadable record as held rather than abandoned', () => {
            const probe = acquireArtifactPublicationLock(workspace, 'probe');
            const lockPath = probe.lockPath;
            probe.release();

            // A record being written by a live holder, or truncated by a crash a
            // moment ago, is indistinguishable — so it must not be stolen.
            fs.writeFileSync(lockPath, '');
            try {
                expect(() => acquireArtifactPublicationLock(workspace, 'contender')).toThrow(
                    /is being published by/,
                );
            } finally {
                fs.rmSync(lockPath, { force: true });
            }
        });

        it('takes over an unreadable record once it is older than the settling window', () => {
            const probe = acquireArtifactPublicationLock(workspace, 'probe');
            const lockPath = probe.lockPath;
            probe.release();

            fs.writeFileSync(lockPath, '');
            const longAgo = new Date(Date.now() - 10 * 60 * 1000);
            fs.utimesSync(lockPath, longAgo, longAgo);

            const taken = acquireArtifactPublicationLock(workspace, 'contender');
            try {
                const record = JSON.parse(fs.readFileSync(taken.lockPath, 'utf-8')) as Record<string, unknown>;
                expect(record.holder).toBe('contender');
            } finally {
                taken.release();
            }
        });

        it('releases the lock on the failure path, so one failed run does not block the next', () => {
            expect(() =>
                withArtifactPublicationLockSync(workspace, 'catalog-import-usda:report', () => {
                    throw new Error('publication failed');
                }),
            ).toThrow('publication failed');

            const next = acquireArtifactPublicationLock(workspace, 'catalog-report:artefacts');
            next.release();
        });
    });

    describe('a pre-placed staging path (CWE-59)', () => {
        it('refuses to write through a symlink left at the staging name', () => {
            // `--out` accepts any directory, so on a shared one another local
            // principal can pre-place the staging name. Exclusive creation is
            // what stops the write following it out of the directory.
            const outsideTarget = path.join(workspace, 'not-an-artefact.txt');
            fs.writeFileSync(outsideTarget, 'untouched\n');
            const attacked = path.join(workspace, 'attacked-report.json');
            const staging = stagingPathFor(attacked);
            fs.symlinkSync(outsideTarget, staging);

            // Every creator of a staging path opens it exclusively, so the
            // pre-placed entry is an error rather than a followed link.
            expect(() => fs.openSync(staging, 'wx')).toThrow(
                expect.objectContaining({ code: 'EEXIST' }) as unknown as Error,
            );
            expect(fs.readFileSync(outsideTarget, 'utf-8')).toBe('untouched\n');
            expect(fs.existsSync(attacked)).toBe(false);
        });

        it('does not let the staging name be guessed from the artefact name', () => {
            const first = stagingPathFor(importPath);
            const second = stagingPathFor(importPath);

            expect(first).not.toBe(second);
            // Basename, pid and a counter alone were predictable; the random
            // component is what makes pre-placing it a guess rather than a plan.
            expect(path.basename(first)).not.toBe(path.basename(second));
            expect(path.basename(first).length).toBeGreaterThan('import-report.json'.length + 12);
        });
    });

    describe('the streamed staged document', () => {
        it('is flushed to disk before it becomes promotable', async () => {
            // `end()` flushes to the OS, not the disk, and the completeness check
            // reads the document's tail — so without this the check could pass on
            // bytes a power loss would lose.
            const fsyncSpy = jest.spyOn(fs, 'fsyncSync');
            const io = defaultReportIo();
            const opened = io.openStagedSink(path.join(workspace, 'streamed-report.json'));
            await opened.sink.write('{\n  "items": {}\n}\n');
            await opened.sink.end();

            expect(fsyncSpy).toHaveBeenCalled();
            expect(fs.readFileSync(opened.staged.stagingPath, 'utf-8')).toBe('{\n  "items": {}\n}\n');

            io.discard([opened.staged]);
        });

        it('is created exclusively, so it cannot follow a pre-placed entry', () => {
            // Asserted on the flag the sink opens with, because the staging name
            // carries a random nonce and cannot be pre-placed from a test. The
            // default `w` follows a symlink and truncates its target; `wx`
            // refuses any existing entry, which is the property that matters.
            const createSpy = jest.spyOn(fs, 'createWriteStream');
            const io = defaultReportIo();
            const opened = io.openStagedSink(path.join(workspace, 'exclusive-report.json'));

            expect(createSpy).toHaveBeenCalledWith(
                opened.staged.stagingPath,
                expect.objectContaining({ flags: 'wx' }),
            );

            opened.sink.destroy();
            io.discard([opened.staged]);
        });
    });
});

/**
 * THE CROSS-STAGE REPORT MERGE.
 *
 * `import-report.json` is written by three stages, and the two kinds of key in
 * it merge differently: a stage-private key is replaced by its owner, and a
 * shared compound block is merged one sub-key at a time. One policy, in one
 * place, used by all three writers — because a second copy of the rule is a
 * second rule that can drift from it while still looking right.
 */
describe('the cross-stage report merge', () => {
    const policy = { noteKey: 'importStageWrite', stage: 'catalog-import-usda' } as const;

    it('declares the blocks that are co-written, so all three writers share one list', () => {
        expect(MERGED_REPORT_COMPOUND_BLOCKS).toEqual(['duplicatesRemoved', 'failuresByCheck']);
    });

    // A provisional marker is placed by hand on a committed artefact that predates
    // these producers, so a reader cannot mistake it for evidence of
    // them. A measured write IS evidence of its own run, so the marker has to be
    // self-clearing: were it preserved like any other sibling key, a freshly
    // regenerated artefact would declare itself stale, which is the same untruth
    // the marker exists to correct.
    it('declares the provisional markers and the per-stage obligation field', () => {
        expect(PROVISIONAL_REPORT_MARKER_KEYS).toEqual(['staleness']);
        expect(FRESHNESS_OBLIGATIONS_FIELD).toBe('outstandingStages');
    });

    // Freshness is per stage because the artefact is co-written. The failure this
    // guards against is a stage that owes nothing clearing a warning
    // about sections it never measured.
    const staleMarker = (stages: readonly string[]): Record<string, unknown> => ({
        staleness: { status: 'stale_relative_to_producers', outstandingStages: [...stages] },
        counts: { inserted: 1 },
        requirement: { fromReportStage: true },
    });

    it('discharges only the writing stage\'s own freshness obligation', () => {
        const merge = mergeStageReport(
            staleMarker(['catalog-import-usda', 'catalog-report']),
            { counts: { inserted: 20 } },
            policy,
        );

        // The marker survives, because the report stage still owes its aggregates.
        expect(merge.document).toHaveProperty('staleness');
        expect((merge.document.staleness as Record<string, unknown>).outstandingStages).toEqual(['catalog-report']);
        const note = merge.document.importStageWrite as Record<string, unknown>;
        expect(note.dischargedFreshnessObligation).toBe('catalog-import-usda');
        expect(note.outstandingFreshnessObligations).toEqual(['catalog-report']);
        expect(note.clearedProvisionalMarkers).toEqual([]);
    });

    it('removes the marker only once the last obligation is discharged', () => {
        const afterImport = mergeStageReport(
            staleMarker(['catalog-import-usda', 'catalog-report']),
            { counts: { inserted: 20 } },
            policy,
        );
        const afterReport = mergeStageReport(
            afterImport.document,
            { requirement: { fromReportStage: true, fresh: true } },
            { noteKey: 'reportStageWrite', stage: 'catalog-report' },
        );

        expect(afterReport.document).not.toHaveProperty('staleness');
        const note = afterReport.document.reportStageWrite as Record<string, unknown>;
        expect(note.clearedProvisionalMarkers).toEqual(['staleness']);
        expect(note.outstandingFreshnessObligations).toEqual([]);
    });

    it('lets a generation-only write clear nothing at all', () => {
        const merge = mergeStageReport(
            staleMarker(['catalog-import-usda', 'catalog-report']),
            { aiGenerationCounts: { generated: 3 } },
            { noteKey: 'generationStageWrite', stage: 'catalog-generate-ai' },
        );

        // Generation owes this artefact nothing (release v1 is USDA-only), so it
        // must neither discharge an obligation nor remove the warning.
        expect(merge.document).toHaveProperty('staleness');
        expect((merge.document.staleness as Record<string, unknown>).outstandingStages).toEqual([
            'catalog-import-usda',
            'catalog-report',
        ]);
        const note = merge.document.generationStageWrite as Record<string, unknown>;
        expect(note.dischargedFreshnessObligation).toBeNull();
        expect(note.clearedProvisionalMarkers).toEqual([]);
    });

    it('discharges the validate obligation on the validation artefact', () => {
        const merge = mergeStageReport(
            staleMarker(['catalog-validate', 'catalog-report']),
            { counts: { published: 11046 } },
            { noteKey: 'validateStageWrite', stage: 'catalog-validate' },
        );

        expect((merge.document.staleness as Record<string, unknown>).outstandingStages).toEqual(['catalog-report']);
        const note = merge.document.validateStageWrite as Record<string, unknown>;
        expect(note.dischargedFreshnessObligation).toBe('catalog-validate');
    });

    it('leaves a marker with no usable obligation list alone', () => {
        // Conservative direction: an unusable list cannot say whose sections are
        // stale, and clearing a warning is the unrecoverable mistake.
        const merge = mergeStageReport(
            { staleness: { status: 'stale_relative_to_producers' }, counts: { inserted: 1 } },
            { counts: { inserted: 20 } },
            policy,
        );

        expect(merge.document).toHaveProperty('staleness');
        const note = merge.document.importStageWrite as Record<string, unknown>;
        expect(note.dischargedFreshnessObligation).toBeNull();
        expect(note.clearedProvisionalMarkers).toEqual([]);
    });

    it('records an empty cleared list when the artefact carries no marker', () => {
        const merge = mergeStageReport({ counts: { inserted: 1 } }, { counts: { inserted: 20 } }, policy);

        const note = merge.document.importStageWrite as Record<string, unknown>;
        expect(note.clearedProvisionalMarkers).toEqual([]);
        expect(note.dischargedFreshnessObligation).toBeNull();
    });

    it('keeps a marker key a stage writes itself, so nothing is dropped silently', () => {
        const merge = mergeStageReport(
            { staleness: { status: 'stale_relative_to_producers' } },
            { staleness: { status: 'written-by-the-stage' } },
            policy,
        );

        expect(merge.document.staleness).toEqual({ status: 'written-by-the-stage' });
        const note = merge.document.importStageWrite as Record<string, unknown>;
        expect(note.clearedProvisionalMarkers).toEqual([]);
    });

    it('replaces a stage-private key and preserves one the stage does not own', () => {
        const merge = mergeStageReport(
            { counts: { inserted: 1 }, catalogRelease: 'v1' },
            { counts: { inserted: 20 } },
            policy,
        );

        expect(merge.document.counts).toEqual({ inserted: 20 });
        expect(merge.document.catalogRelease).toBe('v1');
        expect(merge.preservedKeys).toEqual(['catalogRelease']);
        expect(merge.preservedSubKeys).toEqual({});
    });

    it('merges a shared compound block sub-key by sub-key rather than replacing it', () => {
        const merge = mergeStageReport(
            {
                duplicatesRemoved: { generationStage: { dropped: 3 }, basisAtGeneration: 'generation prose' },
                failuresByCheck: { generationStage: { reject: {} }, measuredFromCatalog: { published: {} } },
            },
            {
                duplicatesRemoved: { skippedDuplicateInPlanAtImport: 7, basisAtImport: 'import prose' },
                failuresByCheck: { importStage: { reject: {} } },
            },
            policy,
        );

        expect(merge.document.duplicatesRemoved).toEqual({
            generationStage: { dropped: 3 },
            basisAtGeneration: 'generation prose',
            skippedDuplicateInPlanAtImport: 7,
            basisAtImport: 'import prose',
        });
        expect(merge.document.failuresByCheck).toEqual({
            generationStage: { reject: {} },
            measuredFromCatalog: { published: {} },
            importStage: { reject: {} },
        });
        expect(merge.preservedSubKeys).toEqual({
            duplicatesRemoved: ['basisAtGeneration', 'generationStage'],
            failuresByCheck: ['generationStage', 'measuredFromCatalog'],
        });
    });

    it('lets a stage overwrite its OWN sub-key of a shared block', () => {
        const merge = mergeStageReport(
            { duplicatesRemoved: { skippedDuplicateInPlanAtImport: 1, generationStage: { dropped: 3 } } },
            { duplicatesRemoved: { skippedDuplicateInPlanAtImport: 9 } },
            policy,
        );

        // The fresher measurement of the same thing wins; the other stage's
        // sub-key is still there.
        expect(merge.document.duplicatesRemoved).toEqual({
            skippedDuplicateInPlanAtImport: 9,
            generationStage: { dropped: 3 },
        });
        expect(merge.preservedSubKeys).toEqual({ duplicatesRemoved: ['generationStage'] });
    });

    it('replaces a compound block when what is there is not an object to merge into', () => {
        const merge = mergeStageReport(
            { duplicatesRemoved: 'a sentence an older revision wrote' },
            { duplicatesRemoved: { basisAtImport: 'import prose' } },
            policy,
        );

        // Nothing can be merged sub-key-wise into a string, and spreading one
        // would produce "0", "1", … keys beside the report.
        expect(merge.document.duplicatesRemoved).toEqual({ basisAtImport: 'import prose' });
        expect(merge.preservedSubKeys).toEqual({});
    });

    it('keeps the position of every key already in the document', () => {
        const merge = mergeStageReport(
            { stage: 'catalog-import-usda', catalogRelease: 'v1', counts: { inserted: 1 } },
            { counts: { inserted: 2 }, plannedBatches: 4 },
            policy,
        );

        // Position as well as value: a rerun of one stage should produce a diff
        // of the fields that changed, not a reordering of the whole artefact.
        expect(Object.keys(merge.document)).toEqual([
            'stage',
            'catalogRelease',
            'counts',
            'plannedBatches',
            policy.noteKey,
        ]);
    });

    it('fails as a merge error rather than halfway through a write', () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;

        // Serialised inside the merge, before any caller writes: a value that
        // cannot be represented as JSON has to fail while the previous
        // artefact is still whole.
        const failure = (() => {
            try {
                mergeStageReport(null, { counts: cyclic }, policy);
                return null;
            } catch (error) {
                return error;
            }
        })();

        expect(failure).toBeInstanceOf(ManifestError);
        expect((failure as ManifestError).code).toBe('invalid_merged_report');
    });
});

/**
 * WHERE A DRY RUN WRITES ITS REPORT.
 *
 * A dry run measures what a real run WOULD do: it opens no run row, writes no
 * cursor, claims no completion and writes no catalog row. Its report is
 * therefore a plan, and the committed `import-report.json` is evidence of a
 * catalog that exists — so a dry run that wrote there would replace measured
 * figures with hypothetical ones, under no stage lock, and the file would give
 * a reviewer no way to tell which it was reading.
 */
describe('where a dry run writes its report', () => {
    it('names exactly two destinations, so the routing cannot fall through to a default', () => {
        expect([...IMPORT_REPORT_DESTINATIONS]).toEqual(['canonical', 'dry_run_preview']);
    });

    it('routes a dry run to the preview and a real run to the canonical artefact', () => {
        expect(importReportDestination(options({ dryRun: true }))).toBe('dry_run_preview');
        expect(importReportDestination(options({ dryRun: false }))).toBe('canonical');
        // The flag is the only thing that decides it: a restricted real run
        // still measures rows it wrote, so its report is evidence.
        expect(importReportDestination(options({ limit: 20 }))).toBe('canonical');
        expect(importReportDestination(options({ categories: ['produce_fruit'] }))).toBe('canonical');
    });

    it('puts the preview outside the repository, keyed by process, and never at the canonical path', () => {
        const canonical = importReportTarget('canonical');
        const preview = importReportTarget('dry_run_preview');

        expect(path.basename(canonical)).toBe(IMPORT_REPORT_FILE);
        expect(canonical).toContain(path.join('data', 'meal-planning', 'reports', 'latest'));
        expect(preview).not.toBe(canonical);
        // Outside the repository: a preview is not a tracked artefact, and it
        // must not be committable by accident.
        expect(preview.startsWith(os.tmpdir())).toBe(true);
        expect(preview).not.toContain('meal-planning');
        // Keyed by process, so two operators previewing at once do not
        // overwrite each other's file.
        expect(preview).toContain(String(process.pid));
    });

    it('asks the run to write to the preview, and labels the document as a plan', async () => {
        const writes: { report: Record<string, unknown>; destination: ImportReportDestination }[] = [];
        const deps = {
            db: {},
            runDb: {},
            usda: {
                listFoods: async (): Promise<UsdaFoodSummary[]> => [],
                getFoodsBatch: async (): Promise<UsdaFoodDetail[]> => [],
                describeBatchRetrieval: async (): Promise<UsdaBatchRetrieval> => retrieval([]),
            },
            manifest,
            coveragePlan,
            options: options({ dryRun: true }),
            logger: silentLogger,
            now: () => new Date('2026-09-13T11:00:00.000Z'),
            installRateLimiter: () => (): void => undefined,
            writeReport: (report: unknown, destination: ImportReportDestination) => {
                writes.push({ report: report as Record<string, unknown>, destination });
            },
        } as unknown as RunImportDeps;

        await runImport(deps);

        expect(writes).toHaveLength(1);
        // The destination is decided by the run and obeyed by main(), which is
        // what keeps the canonical file out of a dry run's reach.
        expect(writes[0]?.destination).toBe('dry_run_preview');
        // And the document says what it is, so a preview that is copied
        // somewhere cannot be mistaken for evidence.
        expect(writes[0]?.report.reportKind).toBe('dry_run_preview');
        const basis = String(writes[0]?.report.reportKindBasis);
        expect(basis).toContain('not evidence of an import');
        expect(basis).toContain('held no catalog stage lock');
        expect(basis).toContain('canonical import-report.json was not touched');
    });
});

/**
 * THE TWO REFUSAL TIERS, COUNTED APART.
 *
 * `quarantined` and `rejected` are different `publication_status` values with
 * different futures: a quarantined record is held until more data arrives and
 * is re-validated on the next pass, and a rejected one failed a reject-tier
 * check and is never publishable. Summing them overstates what a later pass
 * can recover, and listing them together makes the shortfall unreadable.
 */
describe('the refusal tiers the import report states separately', () => {
    const refusal = (sourceKey: string, publicationStatus: string, check: string): QuarantinedRecord => ({
        sourceKey,
        fdcId: Number(sourceKey.split(':')[1]),
        category: 'produce_fruit',
        foodState: 'raw',
        publicationStatus,
        failedChecks: [check],
    });

    const figures = (
        counts: Record<string, number>,
        refused: readonly QuarantinedRecord[],
    ): ImportReportSnapshot => ({
        attempts: 1,
        throughBatchIndex: 1,
        processedBatches: 1,
        counts,
        byCategory: {},
        byCheck: {},
        byIdentityStatus: {},
        byNutritionMethod: {},
        byCategoryOutcome: {},
        refused,
    });

    it('counts and lists each tier from its own rows', () => {
        const snapshot = figures(
            { quarantined: 2, rejected: 3 },
            [
                refusal('usda:1', 'quarantined', 'missing_core_nutrient'),
                refusal('usda:2', 'rejected', 'brand_pattern_name'),
                refusal('usda:3', 'quarantined', 'missing_gram_weight'),
                refusal('usda:4', 'rejected', 'kcal_per_100g_impossible'),
                refusal('usda:5', 'rejected', 'macro_mass_exceeds_basis'),
            ],
        );

        const quarantined = buildRefusalBlock('quarantined', snapshot);
        const rejected = buildRefusalBlock('rejected', snapshot);

        expect(quarantined.tier).toBe('quarantined');
        expect(quarantined.total).toBe(2);
        expect(quarantined.listed).toBe(2);
        expect((quarantined.records as QuarantinedRecord[]).map((record) => record.sourceKey)).toEqual([
            'usda:1',
            'usda:3',
        ]);

        expect(rejected.tier).toBe('rejected');
        expect(rejected.total).toBe(3);
        expect(rejected.listed).toBe(3);
        expect((rejected.records as QuarantinedRecord[]).map((record) => record.sourceKey)).toEqual([
            'usda:2',
            'usda:4',
            'usda:5',
        ]);

        // The two blocks are disjoint: a rejected row appears in neither the
        // quarantine count nor the quarantine list.
        expect((quarantined.records as QuarantinedRecord[]).every((record) => record.publicationStatus === 'quarantined')).toBe(true);
        expect((rejected.records as QuarantinedRecord[]).every((record) => record.publicationStatus === 'rejected')).toBe(true);
    });

    it('says what each tier means, because the two outcomes are not interchangeable', () => {
        const snapshot = figures({ quarantined: 0, rejected: 0 }, []);

        expect(String(buildRefusalBlock('quarantined', snapshot).basis)).toContain('publishable once it can be');
        expect(String(buildRefusalBlock('rejected', snapshot).basis)).toContain('never publishable');
        expect(String(buildRefusalBlock('rejected', snapshot).basis)).toContain('summing them overstates');
    });

    it('reports truncation from total against listed, never from the cap', () => {
        // A list exactly at its cap is not truncated if that is all there was:
        // `listed >= limit` called it truncated and made a complete list look
        // partial, which is the one thing a bounded list must not do.
        const exactly = figures({ quarantined: 1 }, [refusal('usda:1', 'quarantined', 'missing_core_nutrient')]);
        expect(buildRefusalBlock('quarantined', exactly).truncated).toBe(false);

        // More refused than listed IS truncation, whatever the cap.
        const beyond = figures({ quarantined: 4 }, [refusal('usda:1', 'quarantined', 'missing_core_nutrient')]);
        const block = buildRefusalBlock('quarantined', beyond);
        expect(block.total).toBe(4);
        expect(block.listed).toBe(1);
        expect(block.truncated).toBe(true);
        // The bound is stated either way, so a reader can recognise a capped
        // list as one.
        expect(block.listLimit).toBeGreaterThan(0);
    });

    it('reports a tier the run never wrote as zero and not as absent', () => {
        const snapshot = figures({}, []);
        const block = buildRefusalBlock('rejected', snapshot);

        // An absent total would leave a consumer unable to tell "none" from
        // "not measured"; this stage always measures both tiers.
        expect(block.total).toBe(0);
        expect(block.listed).toBe(0);
        expect(block.truncated).toBe(false);
        expect(block.records).toEqual([]);
    });
});

/**
 * THE FIGURES A RESUMED RUN CARRIES.
 *
 * An import is resumable: the cursor names the batch to continue from, and the
 * upserts make a re-processed batch a no-op. Every report dimension, though, is
 * accumulated in memory — so a run interrupted at batch 40 of 60 and resumed
 * once reported the last 20 batches and stated them as the run's totals. The
 * figures therefore travel WITH the cursor, taken at the same instant, and the
 * report states carried plus this attempt along with the basis it was arrived
 * at by.
 */
describe('the report figures a resumed run carries', () => {
    const snapshot = (overrides: Partial<ImportReportSnapshot> = {}): ImportReportSnapshot => ({
        attempts: 1,
        throughBatchIndex: 5,
        processedBatches: 5,
        counts: { inserted: 90, updated: 4, candidates: 88, quarantined: 2, rejected: 4, missingFromVendor: 0 },
        byCategory: { produce_fruit: 50, produce_vegetable: 40 },
        byCheck: { missing_core_nutrient: 2 },
        byIdentityStatus: { verified: 90 },
        byNutritionMethod: { usda_record: 90 },
        byCategoryOutcome: { produce_fruit: { written: 50, candidates: 49, quarantined: 1, rejected: 0 } },
        refused: [
            {
                sourceKey: 'usda:1',
                fdcId: 1,
                category: 'produce_fruit',
                foodState: 'raw',
                publicationStatus: 'quarantined',
                failedChecks: ['missing_core_nutrient'],
            },
        ],
        ...overrides,
    });

    describe('readImportReportSnapshot', () => {
        it('reads the snapshot a cursor carries', () => {
            const stored = snapshot();
            const read = readImportReportSnapshot({ fingerprint: 'abc', nextBatchIndex: 5, report: stored });

            expect(read?.attempts).toBe(1);
            expect(read?.throughBatchIndex).toBe(5);
            expect(read?.counts).toEqual(stored.counts);
            expect(read?.byCategory).toEqual(stored.byCategory);
            expect(read?.refused).toEqual(stored.refused);
        });

        it('reads nothing from a cursor written before the figures travelled with it', () => {
            // A cursor from an earlier revision of this stage carries no
            // snapshot. That resume has to report the attempt it can measure
            // and SAY SO, rather than fail a run whose work is committed.
            expect(readImportReportSnapshot({ fingerprint: 'abc', nextBatchIndex: 5 })).toBeNull();
            expect(readImportReportSnapshot(null)).toBeNull();
            expect(readImportReportSnapshot('not an object')).toBeNull();
            expect(readImportReportSnapshot({ report: 'not an object' })).toBeNull();
            expect(readImportReportSnapshot({ report: [] })).toBeNull();
        });

        it('drops a refusal entry that is not a refusal record rather than carrying a broken one', () => {
            const read = readImportReportSnapshot({
                report: { ...snapshot(), refused: [{ sourceKey: 'usda:1' }, 'nonsense', null] },
            });

            expect(read?.refused).toEqual([]);
        });
    });

    describe('combineImportReportFigures', () => {
        const thisAttempt = {
            attempts: 2,
            throughBatchIndex: 8,
            processedBatches: 3,
            counts: { inserted: 20, updated: 1, candidates: 21, quarantined: 0, rejected: 0, missingFromVendor: 2 },
            byCategory: { produce_fruit: 10, grain: 11 },
            byCheck: { missing_core_nutrient: 1 },
            byIdentityStatus: { verified: 21 },
            byNutritionMethod: { usda_record: 21 },
            byCategoryOutcome: new Map([['grain', { written: 11, candidates: 11, quarantined: 0, rejected: 0 }]]),
            refused: [] as readonly QuarantinedRecord[],
            refusalListLimit: 500,
        };

        it('adds this attempt to what the cursor carried, dimension by dimension', () => {
            const carried = snapshot();
            const combined = combineImportReportFigures({ carried, ...thisAttempt });

            // Outcome counters sum, so the report states the records the RUN
            // imported and not the tail of them.
            expect(combined.counts.inserted).toBe(110);
            expect(combined.counts.updated).toBe(5);
            expect(combined.counts.quarantined).toBe(2);
            expect(combined.counts.rejected).toBe(4);
            expect(combined.counts.missingFromVendor).toBe(2);
            // Per-key maps sum per key, and a key only one side measured
            // survives.
            expect(combined.byCategory).toEqual({ produce_fruit: 60, produce_vegetable: 40, grain: 11 });
            expect(combined.byCheck).toEqual({ missing_core_nutrient: 3 });
            expect(combined.byIdentityStatus).toEqual({ verified: 111 });
            expect(combined.byCategoryOutcome.produce_fruit).toEqual({
                written: 50,
                candidates: 49,
                quarantined: 1,
                rejected: 0,
            });
            expect(combined.byCategoryOutcome.grain).toEqual({ written: 11, candidates: 11, quarantined: 0, rejected: 0 });
            // Batch totals and the attempt number are the run's, not the
            // attempt's.
            expect(combined.processedBatches).toBe(8);
            expect(combined.attempts).toBe(2);
            expect(combined.throughBatchIndex).toBe(8);
            // The refusal worklist keeps what earlier attempts named.
            expect(combined.refused.map((record) => record.sourceKey)).toEqual(['usda:1']);
        });

        it('states this attempt alone when the cursor carried nothing', () => {
            const combined = combineImportReportFigures({ carried: null, ...thisAttempt });

            expect(combined.counts).toEqual(thisAttempt.counts);
            expect(combined.byCategory).toEqual(thisAttempt.byCategory);
            expect(combined.processedBatches).toBe(3);
        });

        it('keeps the refusal worklist inside its bound while the totals stay exact', () => {
            const carried = snapshot({
                refused: [
                    {
                        sourceKey: 'usda:1',
                        fdcId: 1,
                        category: 'produce_fruit',
                        foodState: 'raw',
                        publicationStatus: 'quarantined',
                        failedChecks: ['missing_core_nutrient'],
                    },
                ],
                counts: { quarantined: 1 },
            });
            const combined = combineImportReportFigures({
                ...thisAttempt,
                carried,
                counts: { quarantined: 1 },
                refused: [
                    {
                        sourceKey: 'usda:2',
                        fdcId: 2,
                        category: 'grain',
                        foodState: 'dry',
                        publicationStatus: 'quarantined',
                        failedChecks: ['missing_gram_weight'],
                    },
                ],
                refusalListLimit: 1,
            });

            // The list is capped; the TOTAL is not. That is what keeps
            // `truncated` derivable from `total > listed`.
            expect(combined.refused).toHaveLength(1);
            expect(combined.counts.quarantined).toBe(2);
            expect(buildRefusalBlock('quarantined', combined).truncated).toBe(true);
        });
    });
});

/**
 * CATALOG-REPORT PUBLISHES ITS PAIR OR NOTHING.
 *
 * The two evidence artefacts are only evidence together: the aggregate figures
 * in `import-report.json` are reconciled against the per-item records in
 * `validation-report.json`, and the item count is reconciled against the
 * published rows the aggregate pass counted. So the run stages both documents,
 * checks them against each other, and promotes them back to back — or promotes
 * neither and leaves the previous pair exactly as it was.
 *
 * These cases drive `runReport` with the REAL `defaultReportIo` against a
 * temporary directory and a fake `catalog_foods` reader, because what is under
 * test is what the filesystem holds afterwards.
 */
describe('catalog-report publishes its pair or nothing', () => {
    const evidenceAllowlist = loadEvidenceAllowlist();
    const reportedCategory = coveragePlan.categories[0].category;

    const validationRecord = {
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

    /**
     * Declared as a `ReportFoodRow` rather than cast to one. The row the report
     * reads is the row `FOOD_SELECTION` asks for, and a fixture that stood in
     * for it through `as unknown as` was free to omit a selected column: it
     * omitted `basis_amount` and `_count`, and `publishedItemFacts` — which
     * reads `row._count.catalog_food_components` for the component checks and
     * `row.basis_amount` for the normalisation ones — threw on every published
     * row rather than failing at compile time. An annotation makes the next
     * column the stage selects a type error here instead.
     */
    const reportRow = (sourceKey: string, publicationStatus: string, withRecord = true): ReportFoodRow => ({
        source_key: sourceKey,
        canonical_name: `name ${sourceKey}`,
        display_name: `Display ${sourceKey}`,
        category: reportedCategory,
        food_state: 'raw',
        identity_source: 'usda',
        identity_status: 'verified',
        nutrition_provenance: 'source_backed',
        nutrition_basis: 'per_100g',
        // The basis a per-100 g row states, so the normalisation had the
        // arithmetic it is credited with having done.
        basis_amount: 100,
        publication_status: publicationStatus,
        food_group: 'other',
        usda_data_type: 'SR Legacy',
        catalog_validation_records: withRecord
            ? ({ ...validationRecord, publication_status: publicationStatus } as ValidationRecordRow)
            : null,
        // A USDA row derives no component set, which is a fact about the table
        // and is what the component checks' absence is explained by.
        _count: { catalog_food_components: 0 },
    });

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
                let scoped = [...rows]
                    .filter((row) => wantedStatus === undefined || row.publication_status === wantedStatus)
                    .sort((left, right) => (left.source_key < right.source_key ? -1 : 1));
                if (query.cursor !== undefined) {
                    const at = scoped.findIndex((row) => row.source_key === query.cursor?.source_key);
                    scoped = scoped.slice(at + 1);
                }
                return query.take === undefined ? scoped : scoped.slice(0, query.take);
            },
        },
    });

    const run = async (outDir: string, db: ReportDb): Promise<ReportOutcome> =>
        runReport({
            db,
            plan: coveragePlan,
            allowlistVersion: evidenceAllowlist.allowlistVersion,
            evidenceRegistrySnapshot: evidenceAllowlist.registrySnapshot,
            options: { help: false, category: null, out: outDir },
            outDir,
            logger: silentLogger,
            io: defaultReportIo(),
        });

    const PUBLISHED_ROWS = [reportRow('usda:1', 'published'), reportRow('usda:2', 'published')];
    const ROWS = [...PUBLISHED_ROWS, reportRow('usda:9', 'quarantined')];

    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-catalog-report-'));
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const readJson = (name: string): Record<string, unknown> =>
        JSON.parse(fs.readFileSync(path.join(workspace, name), 'utf-8')) as Record<string, unknown>;

    it('publishes both artefacts, with one item record per published row', async () => {
        const outcome = await run(workspace, reportDb(ROWS));

        expect(fs.readdirSync(workspace).sort()).toEqual(['import-report.json', 'validation-report.json']);
        expect(outcome.itemRecords).toBe(PUBLISHED_ROWS.length);
        expect(outcome.publishedRows).toBe(PUBLISHED_ROWS.length);
        expect(Object.keys((readJson('validation-report.json').items as Record<string, unknown>)).sort()).toEqual([
            'usda:1',
            'usda:2',
        ]);
    });

    it('states the reconciliation in the artefact, and the isolation it was measured under', async () => {
        await run(workspace, reportDb(ROWS));
        const sibling = (readJson('import-report.json').siblingReconciliation as Record<string, unknown>)
            .validationReport as Record<string, unknown>;

        // The evidence says how it was reconciled, so a reviewer does not have
        // to take the claim on trust.
        expect(sibling.itemRecords).toBe(PUBLISHED_ROWS.length);
        expect(sibling.publishedRowsMeasured).toBe(PUBLISHED_ROWS.length);
        expect(sibling.itemRecordsAgreeWithPublishedRows).toBe(true);
        expect(sibling.snapshotIsolation).toBe(REPORT_SNAPSHOT_ISOLATION);
        expect(sibling.quarantinePerCategoryAgrees).toBe(true);
        // The old wording claimed "one scan"; two passes over one snapshot is
        // what actually happens, and the note has to say the true thing.
        expect(String(sibling.agreementNote)).toContain('snapshot');
        expect(String(sibling.agreementNote)).not.toContain('from one scan');
    });

    it('produces a byte-identical pair on a rerun against unchanged data', async () => {
        // Twice, because the first write into an EMPTY directory truthfully
        // records `mergedIntoExisting: false` while every later one merges.
        // What a reviewer re-runs is the second kind, and that is the run this
        // determinism claim is about.
        await run(workspace, reportDb(ROWS));
        const validationAfterFirst = fs.readFileSync(path.join(workspace, 'validation-report.json'));
        await run(workspace, reportDb(ROWS));
        const validationBefore = fs.readFileSync(path.join(workspace, 'validation-report.json'));
        const importBefore = fs.readFileSync(path.join(workspace, 'import-report.json'));

        await run(workspace, reportDb(ROWS));

        // Determinism is what makes a diff in review mean the catalog changed.
        expect(fs.readFileSync(path.join(workspace, 'validation-report.json')).equals(validationBefore)).toBe(true);
        expect(fs.readFileSync(path.join(workspace, 'import-report.json')).equals(importBefore)).toBe(true);
        // The validation report carries no merge note, so even the very first
        // write is byte-identical to the ones after it.
        expect(validationAfterFirst.equals(validationBefore)).toBe(true);
    });

    it('does not name its own merge note as a key it preserved from another stage', async () => {
        await run(workspace, reportDb(ROWS));
        await run(workspace, reportDb(ROWS));
        const note = readJson('import-report.json')[REPORT_STAGE_NOTE_KEY] as Record<string, unknown>;

        // The note key is this stage's own bookkeeping left behind by its
        // previous run, so listing it as preserved would be a false statement
        // about the artefact.
        expect(note.preservedKeys).not.toContain(REPORT_STAGE_NOTE_KEY);
    });

    it('keeps the sub-keys and private blocks the import and generation stages own', async () => {
        await run(workspace, reportDb(ROWS));
        const artefact = readJson('import-report.json');
        artefact.counts = { inserted: 12252 };
        artefact.usdaRequests = { attempts: 617 };
        artefact.duplicatesRemoved = {
            ...(artefact.duplicatesRemoved as Record<string, unknown>),
            basisAtImport: 'import prose',
            generationStage: { dropped: 3 },
        };
        fs.writeFileSync(path.join(workspace, 'import-report.json'), `${JSON.stringify(artefact, null, 2)}\n`, 'utf-8');

        await run(workspace, reportDb(ROWS));
        const merged = readJson('import-report.json');

        expect(merged.counts).toEqual({ inserted: 12252 });
        expect(merged.usdaRequests).toEqual({ attempts: 617 });
        expect((merged.duplicatesRemoved as Record<string, unknown>).basisAtImport).toBe('import prose');
        expect((merged.duplicatesRemoved as Record<string, unknown>).generationStage).toEqual({ dropped: 3 });
        // And this stage's own sub-keys of the shared block are still fresh.
        expect((merged.duplicatesRemoved as Record<string, unknown>).measuredFrom).toEqual(expect.any(String));
        // The note names this stage, beside the other two stages' notes.
        expect(merged[REPORT_STAGE_NOTE_KEY]).toEqual(expect.any(Object));
    });

    it('publishes nothing when the two passes disagree, and names the rows that caused it', async () => {
        await run(workspace, reportDb(ROWS));
        const validationBefore = fs.readFileSync(path.join(workspace, 'validation-report.json'));
        const importBefore = fs.readFileSync(path.join(workspace, 'import-report.json'));

        // The aggregate pass sees two published rows with records; the
        // emitting pass finds the second one's record gone. Under one snapshot
        // this cannot happen — which is exactly why it has to fail the run
        // rather than write a report that is short by one item.
        const drifting: ReportDb = {
            catalog_foods: {
                findMany: async (args: unknown): Promise<ReportFoodRow[]> => {
                    const query = args as { where?: Record<string, unknown> };
                    const emitting = query.where?.publication_status !== undefined;
                    const source = emitting
                        ? [reportRow('usda:1', 'published'), reportRow('usda:2', 'published', false)]
                        : ROWS;
                    return reportDb(source).catalog_foods.findMany(args);
                },
            },
        };

        const failure = await run(workspace, drifting).then(
            () => null,
            (error: unknown) => error,
        );

        expect(failure).toBeInstanceOf(CatalogReportError);
        expect((failure as CatalogReportError).code).toBe('item_count_mismatch');
        expect((failure as CatalogReportError).message).toContain('usda:2');
        expect((failure as CatalogReportError).message).toContain('snapshot');
        // Both previous artefacts are byte-identical, and no staging file was
        // left behind for a later run to mistake for a document to promote.
        expect(fs.readFileSync(path.join(workspace, 'validation-report.json')).equals(validationBefore)).toBe(true);
        expect(fs.readFileSync(path.join(workspace, 'import-report.json')).equals(importBefore)).toBe(true);
        expect(fs.readdirSync(workspace).sort()).toEqual(['import-report.json', 'validation-report.json']);
    });

    it('publishes nothing when a published row carries no validation record at all', async () => {
        const failure = await run(
            workspace,
            reportDb([reportRow('usda:1', 'published'), reportRow('usda:2', 'published', false)]),
        ).then(
            () => null,
            (error: unknown) => error,
        );

        // Caught by the aggregate pass, before either document is staged: a
        // report claiming complete evidence for a catalog that has none for
        // some of its rows is the dangerous outcome here.
        expect((failure as CatalogReportError).code).toBe('missing_validation_record');
        expect(fs.readdirSync(workspace)).toEqual([]);
    });

    it('refuses to run while another stage is publishing into the same directory', async () => {
        const held = acquireArtifactPublicationLock(workspace, 'catalog-import-usda:report');
        try {
            const failure = await run(workspace, reportDb(ROWS)).then(
                () => null,
                (error: unknown) => error,
            );

            expect(failure).toBeInstanceOf(ManifestError);
            expect((failure as ManifestError).code).toBe('artifact_publication_locked');
            expect((failure as ManifestError).message).toContain('catalog-import-usda:report');
            expect(fs.readdirSync(workspace)).toEqual([]);
        } finally {
            held.release();
        }
    });

    it('reconciles the item count from the numbers themselves, whichever way they disagree', () => {
        // The pure rule, at its own level: both the short case and the long
        // case are failures, and a skip fails even when the totals agree.
        expect(() =>
            reconcileItemCount({
                validationReportPath: '/tmp/validation-report.json',
                reconciliation: { itemsEmitted: 2, publishedRowsMeasured: 2, skippedWithoutRecord: 0, skippedNamed: [] },
            }),
        ).not.toThrow();

        expect(() =>
            reconcileItemCount({
                validationReportPath: '/tmp/validation-report.json',
                reconciliation: { itemsEmitted: 1, publishedRowsMeasured: 2, skippedWithoutRecord: 0, skippedNamed: [] },
            }),
        ).toThrow(/1 per-item record\(s\) were written for 2 published row\(s\)/);

        expect(() =>
            reconcileItemCount({
                validationReportPath: '/tmp/validation-report.json',
                reconciliation: { itemsEmitted: 3, publishedRowsMeasured: 2, skippedWithoutRecord: 0, skippedNamed: [] },
            }),
        ).toThrow(/item_count_mismatch|3 per-item record/);

        // Two offsetting changes can leave the totals equal while the evidence
        // is short, so a skip is a failure in its own right.
        expect(() =>
            reconcileItemCount({
                validationReportPath: '/tmp/validation-report.json',
                reconciliation: {
                    itemsEmitted: 2,
                    publishedRowsMeasured: 2,
                    skippedWithoutRecord: 1,
                    skippedNamed: ['usda:7'],
                },
            }),
        ).toThrow(/usda:7/);
    });
});

/**
 * A SCOPED REPORT CANNOT LAND ON THE COMMITTED ARTEFACTS.
 *
 * `--category` measures one category: its coverage, requirement, shortfall and
 * per-item records cover that category alone. Written to the committed paths
 * those figures read exactly like whole-catalog evidence — same file names,
 * same shape, same `reportVersion` — while understating the catalog by every
 * other category. The DESTINATION is therefore what the guard asks about, not
 * whether the flag was given: omitting `--out` and passing the committed
 * directory as `--out` produce the same artefacts in the same place.
 */
describe('a scoped report cannot land on the committed artefacts', () => {
    const canonical = path.join('/repo', 'data', 'meal-planning', 'reports', 'latest');

    const refusalFor = (out: string | null, resolvedOutDir: string): string | null =>
        scopedReportRefusal({ category: 'produce_fruit', out, resolvedOutDir, canonicalReportDir: canonical });

    it('recognises the committed directory itself and anything inside it', () => {
        expect(writesIntoCanonicalReportDirectory(canonical, canonical)).toBe(true);
        expect(writesIntoCanonicalReportDirectory(`${canonical}${path.sep}`, canonical)).toBe(true);
        expect(writesIntoCanonicalReportDirectory(path.join(canonical, 'scoped'), canonical)).toBe(true);
        expect(writesIntoCanonicalReportDirectory(path.join(canonical, 'a', 'b'), canonical)).toBe(true);
        // A relative traversal that lands back inside it is still inside it.
        expect(writesIntoCanonicalReportDirectory(path.join(canonical, 'a', '..', 'b'), canonical)).toBe(true);
    });

    it('leaves a sibling, a parent and a look-alike directory alone', () => {
        expect(writesIntoCanonicalReportDirectory(path.join('/repo', 'data', 'meal-planning', 'reports', 'scoped'), canonical)).toBe(false);
        expect(writesIntoCanonicalReportDirectory(path.join('/repo', 'data', 'meal-planning', 'reports'), canonical)).toBe(false);
        // A prefix match is not a containment: `latest-scoped` is a different
        // directory, and a `startsWith` test would have refused it.
        expect(writesIntoCanonicalReportDirectory(`${canonical}-scoped`, canonical)).toBe(false);
        expect(writesIntoCanonicalReportDirectory(path.join('/tmp', 'scoped'), canonical)).toBe(false);
    });

    it('refuses the explicit form as well as the omitted one', () => {
        // The bypass this closes: `--out data/meal-planning/reports/latest`
        // satisfied a guard that only asked whether `--out` was given.
        const explicit = refusalFor('data/meal-planning/reports/latest', canonical);
        expect(explicit).not.toBeNull();
        expect(String(explicit)).toContain('--out data/meal-planning/reports/latest');
        expect(String(explicit)).toContain(canonical);

        const omitted = refusalFor(null, canonical);
        expect(omitted).not.toBeNull();
        expect(String(omitted)).toContain('the default report directory');

        // Both name what would be replaced and what to do instead.
        for (const refusal of [explicit, omitted]) {
            expect(String(refusal)).toContain('validation-report.json');
            expect(String(refusal)).toContain('import-report.json');
            expect(String(refusal)).toContain('Pass --out <dir>');
        }
    });

    it('refuses a subdirectory of the committed directory too', () => {
        expect(refusalFor('data/meal-planning/reports/latest/scoped', path.join(canonical, 'scoped'))).not.toBeNull();
    });

    it('allows a scoped run that writes somewhere else', () => {
        expect(refusalFor('/tmp/scoped-report', '/tmp/scoped-report')).toBeNull();
        expect(refusalFor('../scoped', path.join('/repo', '..', 'scoped'))).toBeNull();
    });

    it('resolves a path through its symlinks before comparing, so the guard cannot be walked around', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-report-symlink-'));
        try {
            const real = path.join(root, 'latest');
            fs.mkdirSync(real);
            const link = path.join(root, 'link-to-latest');
            fs.symlinkSync(real, link, 'dir');

            // Named two ways, one directory. A lexical comparison would have
            // called these different places.
            expect(canonicalizeDirectoryPath(link)).toBe(fs.realpathSync(real));
            expect(writesIntoCanonicalReportDirectory(canonicalizeDirectoryPath(link), canonicalizeDirectoryPath(real))).toBe(true);
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('resolves a directory that does not exist yet down to the deepest ancestor that does', () => {
        const root = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-report-missing-'));
        try {
            const missing = path.join(root, 'not', 'created', 'yet');

            // An `--out` directory the run has not created yet still has to be
            // comparable, or the guard would only work on a second run.
            expect(canonicalizeDirectoryPath(missing)).toBe(path.join(fs.realpathSync(root), 'not', 'created', 'yet'));
        } finally {
            fs.rmSync(root, { recursive: true, force: true });
        }
    });

    it('points at the directory the committed artefacts actually live in', () => {
        // The guard is only meaningful if it names the real place.
        expect(canonicalReportDirectory()).toBe(path.dirname(reportPath('validation-report.json')));
        expect(canonicalReportDirectory()).toContain(path.join('data', 'meal-planning', 'reports', 'latest'));
    });
});


/* -------------------------------------------------------------------------- *
 * The first of the two libraries every import run depends on.
 * -------------------------------------------------------------------------- */

// The redaction contract of scripts/lib/logger.ts.
//
// The module is the single chokepoint every meal-planning CLI script, plus
// checkpoint.ts's persisted run log and dbGuard.ts's refusal path, routes
// caller strings through, so what is asserted here is what reaches an
// operator's terminal, a CI log and the `catalog_import_runs.log` JSONB column.

const REDACTED = '***';

// The DSN shape the whole suite turns on: an unescaped `@` inside the password,
// which is legal in a Postgres URL and common in generated credentials. The
// userinfo ends at the LAST `@` in the authority, so the password is `pa@ss`
// and the host is `localhost` — a rule that stops at the first `@` publishes
// the suffix `ss`.
const DSN_WITH_AT_IN_PASSWORD = 'postgresql://user:pa@ss@localhost:5433/db';
const DSN_REDACTED = 'postgresql://***@localhost:5433/db';

// Every fragment of the credential above. `pa`, `ss` and `pa@ss` must not
// survive anywhere in any output; `user` is the username half of the same
// userinfo and is equally gone.
const PASSWORD_FRAGMENTS: readonly string[] = ['pa@ss', 'pa', 'ss', 'user:', 'user'];

const expectNoCredentialFragment = (rendered: string): void => {
    for (const fragment of PASSWORD_FRAGMENTS) {
        expect(rendered).not.toContain(fragment);
    }
};

describe('the redaction contract of the script logger', () => {
    describe('redactUrlUserinfo', () => {
        describe('the userinfo boundary', () => {
            it('redacts through the last @ of the authority, not the first', () => {
                expect(redactUrlUserinfo(DSN_WITH_AT_IN_PASSWORD)).toBe(DSN_REDACTED);
            });

            it('keeps the host, port, path, query and fragment', () => {
                expect(redactUrlUserinfo('postgresql://u:p@host:5433/db?sslmode=require#note')).toBe(
                    'postgresql://***@host:5433/db?sslmode=require#note',
                );
            });

            it('returns a URL whose authority holds no @ byte-identical', () => {
                const bareHost = 'postgresql://localhost:5433/soh_dev';

                expect(redactUrlUserinfo(bareHost)).toBe(bareHost);
            });

            it('redacts an empty userinfo, because the @ is what declares one', () => {
                expect(redactUrlUserinfo('postgresql://@host/db')).toBe('postgresql://***@host/db');
            });
        });

        describe('what is not a URL', () => {
            it('leaves a `://` with no scheme in front of it alone', () => {
                expect(redactUrlUserinfo('://u:p@host/db')).toBe('://u:p@host/db');
            });

            it('leaves a `://` whose left-hand run has no letter alone', () => {
                expect(redactUrlUserinfo('1.2://u:p@host/db')).toBe('1.2://u:p@host/db');
            });

            it('accepts a scheme of digits, +, - and . after its leading letter', () => {
                expect(redactUrlUserinfo('a+b-c.1://u:p@host/db')).toBe('a+b-c.1://***@host/db');
            });

            // The 41-character bound limits how far left the walk looks, not what it
            // recognises: a run longer than the window is still a scheme as long as
            // a letter falls inside the window, which is what keeps a credential
            // redacted behind an unusually long scheme.
            it('redacts a scheme run longer than the walk-back window', () => {
                expect(redactUrlUserinfo(`${'s'.repeat(42)}://u:p@host/db`)).toBe(`${'s'.repeat(42)}://${REDACTED}@host/db`);
            });

            it('redacts when the scheme letter sits at the far edge of the window', () => {
                const scheme = `a${'1'.repeat(40)}`;

                expect(redactUrlUserinfo(`${scheme}://u:p@host/db`)).toBe(`${scheme}://${REDACTED}@host/db`);
            });

            it('leaves a `://` whose whole walk-back window holds no letter alone', () => {
                const notAScheme = `a${'1'.repeat(41)}`;

                expect(redactUrlUserinfo(`${notAScheme}://u:p@host/db`)).toBe(`${notAScheme}://u:p@host/db`);
            });

            it('leaves an @ that belongs to a path alone', () => {
                expect(redactUrlUserinfo('a://host://u:p@h')).toBe('a://host://u:p@h');
            });
        });

        describe('the non-string guard', () => {
            it('yields an empty string for a non-string, like scrubSecrets', () => {
                expect(redactUrlUserinfo(undefined as unknown as string)).toBe('');
                expect(redactUrlUserinfo(null as unknown as string)).toBe('');
                expect(redactUrlUserinfo(42 as unknown as string)).toBe('');
            });
        });
    });

    describe('scrubSecrets — URL userinfo', () => {
        it('redacts through the last @ so no fragment of the password survives', () => {
            const scrubbed = scrubSecrets(DSN_WITH_AT_IN_PASSWORD);

            expect(scrubbed).toBe(DSN_REDACTED);
            expectNoCredentialFragment(scrubbed);
        });

        it('redacts a percent-encoded @ inside the password', () => {
            expect(scrubSecrets('postgresql://user:pa%40ss@host/db')).toBe('postgresql://***@host/db');
        });

        it('redacts a 600-character password rather than failing to match it', () => {
            const password = 'P'.repeat(600);

            const scrubbed = scrubSecrets(`postgresql://u:${password}@h/db`);

            expect(scrubbed).toBe('postgresql://***@h/db');
            expect(scrubbed).not.toContain('P');
        });

        it('redacts the userinfo of a bracketed IPv6 authority', () => {
            expect(scrubSecrets('postgresql://u:p@[::1]:5432/db')).toBe('postgresql://***@[::1]:5432/db');
        });

        it('leaves a bracketed IPv6 authority with no userinfo alone', () => {
            expect(scrubSecrets('postgresql://[::1]:5432/db')).toBe('postgresql://[::1]:5432/db');
        });

        it('handles an uppercase scheme', () => {
            expect(scrubSecrets('POSTGRESQL://U:P@H/db')).toBe('POSTGRESQL://***@H/db');
        });

        it('handles a mixed-case scheme', () => {
            expect(scrubSecrets('PostgreSQL://U:P@H/db')).toBe('PostgreSQL://***@H/db');
        });

        it('leaves a scheme separator at the end of the string alone', () => {
            expect(scrubSecrets('postgresql://')).toBe('postgresql://');
        });

        it('redacts every URL in a string, not just the first', () => {
            expect(scrubSecrets('a://u:p@h b://x:y@z c://q:r@s')).toBe(`a://${REDACTED}@h b://${REDACTED}@z c://${REDACTED}@s`);
        });

        it('ends an authority at a tab, a carriage return or a newline', () => {
            expect(scrubSecrets('postgresql://u:p@h\tpostgresql://u2:p2@h2\rpostgresql://u3:p3@h3\nrest')).toBe(
                'postgresql://***@h\tpostgresql://***@h2\rpostgresql://***@h3\nrest',
            );
        });

        it('ends an authority at a non-breaking space, so the next URL is still found', () => {
            expect(scrubSecrets('postgresql://u:p@h\u00a0postgresql://u2:pw2@h2')).toBe(
                'postgresql://***@h\u00a0postgresql://***@h2',
            );
        });

        it('redacts a URL embedded in surrounding prose', () => {
            const scrubbed = scrubSecrets(`connect failed: ${DSN_WITH_AT_IN_PASSWORD} - retrying`);

            expect(scrubbed).toBe(`connect failed: ${DSN_REDACTED} - retrying`);
            expectNoCredentialFragment(scrubbed);
        });

        it('leaves an @ in a query string alone — it is not userinfo', () => {
            expect(scrubSecrets('https://example.com/path?a=b@c')).toBe('https://example.com/path?a=b@c');
        });

        it('leaves a bare email address with no scheme alone', () => {
            expect(scrubSecrets('reported by ops@example.com')).toBe('reported by ops@example.com');
        });

        it('leaves a bare host alone, so a log still says which database a run used', () => {
            expect(scrubSecrets('postgresql://127.0.0.1:5433/soh_dev')).toBe('postgresql://127.0.0.1:5433/soh_dev');
        });
    });

    describe('scrubSecrets — idempotence', () => {
        // `scrubSecrets` legitimately runs on already-scrubbed strings: a caller
        // passes a message through it and the logger scrubs the fields again on the
        // way to the line. Every rule's output must therefore be a fixed point of
        // that rule, and an already-redacted DSN in particular must come back
        // unchanged rather than accumulating markers.
        const cases: readonly string[] = [
            DSN_WITH_AT_IN_PASSWORD,
            DSN_REDACTED,
            'postgresql://user:pa%40ss@host/db',
            'postgresql://u:p@[::1]:5432/db',
            'postgresql://[::1]:5432/db',
            'postgresql://@host/db',
            'POSTGRESQL://U:P@H/db',
            'postgresql://',
            'a://u:p@h b://x:y@z',
            'https://example.com/path?a=b@c',
            'reported by ops@example.com',
            'DATABASE_URL=postgresql://user:pa@ss@localhost/db',
            'Authorization: Bearer sk-test-123',
            'USDA_API_KEY=abc123 retry',
        ];

        it.each(cases)('is a fixed point of itself for %j', (value) => {
            const once = scrubSecrets(value);

            expect(scrubSecrets(once)).toBe(once);
        });

        it('leaves an already-redacted authority untouched', () => {
            expect(scrubSecrets(DSN_REDACTED)).toBe(DSN_REDACTED);
        });
    });

    describe('scrubSecrets — linear time on adversarial input', () => {
        // The rule this file replaced was a regex, and a regex form of it
        // rescans from every offset when its scheme body is unbounded — work
        // quadratic in the input length, where the hand-written scan below is
        // one linear pass. THIS ASSERTION IS THE EVIDENCE for that claim, and
        // it is deliberately the only form of it here: no wall-clock figure is
        // quoted, because a millisecond count is a property of the runner that
        // produced it and reads as a guarantee on every other runner. The
        // budget is set orders of magnitude above what a linear pass needs, so
        // a loaded CI worker cannot make it flap, while a return to a
        // rescanning form — whose cost grows with the square of LENGTH — fails
        // it on any machine.
        const BUDGET_MS = 2_000;
        const LENGTH = 200_000;

        const measure = (input: string): number => {
            const startedAt = process.hrtime.bigint();
            scrubSecrets(input);
            return Number(process.hrtime.bigint() - startedAt) / 1e6;
        };

        it('scrubs 200,000 characters of repeated scheme separators within budget', () => {
            expect(measure('a://'.repeat(LENGTH / 4))).toBeLessThan(BUDGET_MS);
        });

        it('scrubs one scheme followed by a 200,000-character delimiter-free run within budget', () => {
            expect(measure(`a://${'x'.repeat(LENGTH)}`)).toBeLessThan(BUDGET_MS);
        });

        it('scrubs 200,000 characters of scheme-legal runs within budget', () => {
            expect(measure('A-KEY-'.repeat(LENGTH / 6))).toBeLessThan(BUDGET_MS);
        });

        it('still finds a DSN at the end of a 200,000-character line', () => {
            // The filler is spaced so the last rule (any run of 40 or more opaque
            // characters) does not claim it and hide what this case is about.
            const filler = 'x '.repeat(LENGTH / 2);

            const scrubbed = scrubSecrets(`${filler}${DSN_WITH_AT_IN_PASSWORD}`);

            expect(scrubbed).toBe(`${filler}${DSN_REDACTED}`);
        });
    });

    describe('the credential never reaches a log line or a persisted entry', () => {
        it('scrubs a DSN held in a log field value', () => {
            const sanitized = sanitizeLogFields({ dsn: DSN_WITH_AT_IN_PASSWORD });

            expect(sanitized).toEqual({ dsn: DSN_REDACTED });
            expectNoCredentialFragment(JSON.stringify(sanitized));
        });

        it('scrubs a DSN nested inside a log field structure', () => {
            const sanitized = sanitizeLogFields({ target: { origin: { url: DSN_WITH_AT_IN_PASSWORD } } });

            expect(sanitized).toEqual({ target: { origin: { url: DSN_REDACTED } } });
            expectNoCredentialFragment(JSON.stringify(sanitized));
        });

        it('withholds an error message entirely, so a DSN it quotes cannot reach a log', () => {
            const rendered = safeError(new Error(`connect failed for ${DSN_WITH_AT_IN_PASSWORD}`));

            // STRONGER than scrubbing it: the message is not carried, so this
            // route to a log line does not exist for ANY prose the error holds
            // — a DSN the scrub rules match, and equally one they do not.
            expect(rendered).toEqual({ name: 'Error' });
            expect(rendered).not.toHaveProperty('message');
            // The rendered VALUES, not a serialization of them: the field name
            // `message` itself contains the two-character fragment `ss`.
            expectNoCredentialFragment(rendered.name);
        });

        it('still scrubs a DSN held by the one field it does carry', () => {
            // The name is attacker-reachable too: a vendor SDK or a wrapped
            // error can set it, so the field that survives is scrubbed rather
            // than trusted.
            const error = new Error('opening the connection failed');
            error.name = `Error at ${DSN_WITH_AT_IN_PASSWORD}`;

            const rendered = safeError(error);

            expect(rendered.name).toContain(DSN_REDACTED);
            expectNoCredentialFragment(rendered.name);
        });

        it('scrubs a DSN on its way to a serialized log line', () => {
            const lines: Array<{ line: string; level: LogLevel }> = [];
            const logger = createLogger('catalog-import', {
                write: (line, level): void => {
                    lines.push({ line, level });
                },
                now: (): Date => new Date(0),
            });

            logger.error('database_unreachable', { dsn: DSN_WITH_AT_IN_PASSWORD });

            expect(lines).toHaveLength(1);
            expect(JSON.parse(lines[0].line)).toEqual({
                ts: '1970-01-01T00:00:00.000Z',
                level: 'error',
                scope: 'catalog-import',
                event: 'database_unreachable',
                dsn: DSN_REDACTED,
            });
            expectNoCredentialFragment(lines[0].line);
        });
    });

    describe('scrubSecrets — the rules beside the URL rule', () => {
        // The URL rule is one of five applied in order, and the order is part of
        // the contract. These four exist so a change to that list cannot silently
        // stop redacting a key, a token or a private key.
        it('collapses a PEM block, body and markers together', () => {
            const pem = `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n-----END PRIVATE KEY-----`;

            expect(scrubSecrets(pem)).toBe(REDACTED);
        });

        it('collapses the PEM block before the long-base64 rule can claim its body', () => {
            // If the base64 rule ran first the markers would survive around a
            // redacted body, which names the file and the key type in the log.
            const scrubbed = scrubSecrets(`key: -----BEGIN RSA PRIVATE KEY-----\n${'B'.repeat(80)}\n-----END RSA PRIVATE KEY-----`);

            expect(scrubbed).toBe(`key: ${REDACTED}`);
            expect(scrubbed).not.toContain('BEGIN');
        });

        it('redacts a Bearer token and keeps the scheme word', () => {
            expect(scrubSecrets('Authorization: Bearer sk-test-123')).toBe(`Authorization: Bearer ${REDACTED}`);
        });

        it('redacts a credential-bearing KEY=value and keeps the name', () => {
            expect(scrubSecrets('USDA_API_KEY=abc123 retry')).toBe(`USDA_API_KEY=${REDACTED} retry`);
            expect(scrubSecrets('OPENROUTER_API_KEY=sk-or-v1-xyz')).toBe(`OPENROUTER_API_KEY=${REDACTED}`);
        });

        it('leaves a harmless NAME=value alone', () => {
            expect(scrubSecrets('pageSize=20 and monkey=1')).toBe('pageSize=20 and monkey=1');
        });

        it('redacts a long opaque run and keeps a short checksum prefix', () => {
            expect(scrubSecrets(`digest ${'a'.repeat(44)}`)).toBe(`digest ${REDACTED}`);
            expect(scrubSecrets('digest 0123456789ab')).toBe('digest 0123456789ab');
        });

        it('redacts a DSN whose variable name no KEY=value alternative matches', () => {
            // `DATABASE_URL` is not in the KEY=value vocabulary — `url` is not a
            // credential name — so the URL rule is the only thing standing between
            // this string and the log.
            const scrubbed = scrubSecrets(`DATABASE_URL=${DSN_WITH_AT_IN_PASSWORD}`);

            expect(scrubbed).toBe(`DATABASE_URL=${DSN_REDACTED}`);
            expectNoCredentialFragment(scrubbed);
        });

        it('still redacts a DSN stored under a credential-bearing name', () => {
            expect(scrubSecrets('password=postgresql://u:p@h/db')).toBe(`password=${REDACTED}`);
        });
    });

    /**
     * THE ONE EXEMPTION IN THE OPAQUE-RUN RULE.
     *
     * `/` is a base64 character, so a repository-relative data path is the same
     * shape as a key body. The rule redacted the middle of one:
     * `data/meal-planning/catalog/releases/v9005/manifest.json` contains the
     * 40-character run `planning/catalog/releases/v9005/manifest` and printed as
     * `data/meal-***.json` — inside the preflight gap message whose entire
     * purpose is to name the manifest an operator must produce. The shipped `v1`
     * release sits one character under the threshold, which is why the defect
     * was invisible until a release id grew.
     *
     * These cases hold BOTH halves of that trade at once: the paths must come
     * back whole, and every credential shape must still be destroyed. A failure
     * in the first group is the diagnostic defect returning; a failure in the
     * second is a leak, and is the reason each secret shape is pinned here
     * rather than assumed to be covered by the rules above.
     */
    describe('scrubSecrets — the opaque-run rule and the paths it must not eat', () => {
        it.each([
            ['the manifest path whose release id crosses the threshold', 'data/meal-planning/catalog/releases/v9005/manifest.json'],
            ['the shipped release, which sat just under it', 'data/meal-planning/catalog/releases/v1/manifest.json'],
            ['a jsonl artefact in the same directory', 'data/meal-planning/catalog/releases/v9005/validation-records.jsonl'],
            ['the directory itself, named with a trailing separator', 'data/meal-planning/catalog/releases/v90051234/'],
            ['a deep artefact path well past 40 characters', 'data/meal-planning/catalog/releases/v9005/validation/records/part0001'],
            ['a report path', 'data/meal-planning/reports/latest/import-report.json'],
        ])('prints %s whole', (_label, value) => {
            expect(scrubSecrets(value)).toBe(value);
        });

        it('prints the path inside the sentence that carries it, which is where it was lost', () => {
            const sentence =
                'data/meal-planning/catalog/releases/v9005/manifest.json must load and declare the coverage-plan version this build understands.';

            expect(scrubSecrets(sentence)).toBe(sentence);
        });

        it.each([
            ['a base64 service account, the credential this rule exists for', Buffer.from(JSON.stringify({ type: 'service_account', private_key: 'MIIEvQIBADANBg' })).toString('base64')],
            ['a key body lifted out of its PEM markers', 'AAAAB3NzaC1yc2EAAAADAQABAAABgQDQ2b8kZ9s4mVpN7xQ1TmVtYWxwbGFubmluZw=='],
            ['an opaque mixed-case token', 'sk0rZq8LmNpQ7vXt2WyE4RbA9cUfHjKdSgTn6MoP1iYl3ZbCxVeQwAsD5fGhJkLm'],
            ['a full SHA-256 digest, which this rule has always hidden', 'a'.repeat(64)],
            ['a long run with no separator at all', 'abcdefghijklmnopqrstuvwxyz0123456789abcdefghijklmnopqrstuvwxyz'],
            ['a slashed run with one uppercase segment', `aGVsbG8/d29ybGQ/${'abcdefghijklmnopqrstuvwxyz'.repeat(2)}`],
            ['a slashed run carrying base64 padding', 'abcdefghijklmnop/qrstuvwxyzabcdefg/hijklmnopqrstuvwxyzab=='],
            ['a slashed run carrying a base64 plus', 'abcdefghijklmnop/qrstuvwxyz+bcdefg/hijklmnopqrstuvwxyzab'],
            ['a run with only one separator', `abcdefghijklmnopqrst/${'uvwxyzabcdefghij'.repeat(2)}`],
            ['a run with a segment longer than any path this repository writes', `data/${'a'.repeat(33)}/releases/manifest`],
        ])('still destroys %s', (_label, value) => {
            expect(scrubSecrets(value)).not.toContain(value.slice(0, 40));
            expect(scrubSecrets(value)).toContain(REDACTED);
        });

        it('is a fixed point on both outcomes, which is what the rule list requires of every entry', () => {
            const path = 'data/meal-planning/catalog/releases/v9005/manifest.json';
            const secret = 'AAAAB3NzaC1yc2EAAAADAQABAAABgQDQ2b8kZ9s4mVpN7xQ1TmVtYWxwbGFubmluZw==';

            expect(scrubSecrets(scrubSecrets(path))).toBe(scrubSecrets(path));
            expect(scrubSecrets(scrubSecrets(secret))).toBe(scrubSecrets(secret));
        });

        it('exempts a path without weakening the rules that run before it', () => {
            // The exemption is decided per RUN, not per string, so a line that
            // carries both a path and a credential keeps the first and loses the
            // second.
            const line = `loading data/meal-planning/catalog/releases/v9005/manifest.json from ${DSN_WITH_AT_IN_PASSWORD} with USDA_API_KEY=abc123`;
            const scrubbed = scrubSecrets(line);

            expect(scrubbed).toContain('data/meal-planning/catalog/releases/v9005/manifest.json');
            expect(scrubbed).toContain(DSN_REDACTED);
            expect(scrubbed).toContain(`USDA_API_KEY=${REDACTED}`);
            expectNoCredentialFragment(scrubbed);
        });
    });
});

/**
 * THE FAILURE TAXONOMY THE STAGES SHARE.
 *
 * Every stage in `scripts/` ends in the same `describeFailure` and the same
 * top-level catch, and each of them mapped anything outside its own error
 * classes to `unexpected_error`. A database that will not accept a connection
 * is not an unexpected error: it is the most ordinary failure a stage has, it
 * arrives BEFORE any Prisma client exists (the stage advisory lock is taken
 * through checkpoint.ts's own `pg` session), and node-postgres names it
 * `'error'` — so with its SQLSTATE dropped a refusal read
 * `{"code":"unexpected_error","error":{"name":"error"}}` and told an operator
 * nothing at all.
 *
 * These cases pin the two halves of the repair that live in logger.ts: the
 * SQLSTATE now survives into the closed field set, and the classification is
 * shared so five stages cannot disagree about the same code. What they must
 * NOT show is a `message` — the closed field set is the disclosure boundary,
 * and the sentence is forwarded only by `firstPartyMessage`, under the
 * narrowing obligation tested below.
 */
describe('the failure taxonomy the script stages share', () => {
    const withCode = (code: string, name = 'error'): Error => {
        const error = new Error('boom');
        error.name = name;
        (error as unknown as { code: string }).code = code;

        return error;
    };

    describe('safeError — the database codes it used to drop', () => {
        it.each(['53300', '08006', '3D000', '28P01', '57P03', '42P01'])(
            'reports SQLSTATE %s, which is digit-leading and used to fail the code pattern',
            (sqlState) => {
                expect(safeError(withCode(sqlState))).toEqual({ name: 'error', code: sqlState });
            },
        );

        it('still reports a Prisma code and a Node errno, which always passed', () => {
            expect(safeError(withCode('P2002', 'PrismaClientKnownRequestError'))).toEqual({
                name: 'PrismaClientKnownRequestError',
                code: 'P2002',
            });
            expect(safeError(withCode('ENOENT'))).toEqual({ name: 'error', code: 'ENOENT' });
        });

        it('reports no message, which is the whole point of the closed field set', () => {
            const described = safeError(withCode('53300'));

            expect(described).not.toHaveProperty('message');
            expect(JSON.stringify(described)).not.toContain('boom');
        });

        it.each([
            ['a code that is really a sentence', 'connection to server at "db" failed'],
            ['a code that is really a path', '/var/run/postgresql/.s.PGSQL.5432'],
            ['a four-character near-miss', '5330'],
            ['a six-character near-miss', '533000'],
            ['a lower-case five-character value', '53p03'],
        ])('drops %s, because the widening is a shape and not a free pass', (_label, code) => {
            expect(safeError(withCode(code))).toEqual({ name: 'error' });
        });
    });

    describe('classifyInfrastructureFailure', () => {
        it.each([
            ['53300', 'database_unavailable', 'a role or server at its connection limit'],
            ['53100', 'database_unavailable', 'a full disk'],
            ['08006', 'database_unavailable', 'a connection that failed'],
            ['08P01', 'database_unavailable', 'a protocol violation'],
            ['57P03', 'database_unavailable', 'a server not yet accepting connections'],
            ['57P04', 'database_unavailable', 'a database dropped under the run'],
            ['3D000', 'database_missing', 'a database that does not exist'],
            ['28P01', 'database_authentication_failed', 'a rejected password'],
            ['28000', 'database_authentication_failed', 'a rejected authorization'],
            ['42P01', 'database_error', 'an unmigrated target'],
            ['42501', 'database_error', 'an under-granted role'],
        ])('names %s as %s — %s', (code, expected) => {
            expect(classifyInfrastructureFailure(withCode(code))?.code).toBe(expected);
        });

        it.each([
            ['P1001', 'database_unavailable'],
            ['P1002', 'database_unavailable'],
            ['P1017', 'database_unavailable'],
            ['P1003', 'database_missing'],
            ['P1000', 'database_authentication_failed'],
            ['P1010', 'database_authentication_failed'],
        ])('gives Prisma %s the same name, so the answer does not depend on which client failed', (code, expected) => {
            expect(classifyInfrastructureFailure(withCode(code, 'PrismaClientInitializationError'))?.code).toBe(
                expected,
            );
        });

        it.each(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EHOSTUNREACH', 'EAI_AGAIN'])(
            'names %s as unreachable, which is the same operator answer as SQLSTATE class 08',
            (errno) => {
                expect(classifyInfrastructureFailure(withCode(errno))?.code).toBe('database_unavailable');
            },
        );

        it('carries a fixed remedy that names DATABASE_URL and no value of it', () => {
            const classified = classifyInfrastructureFailure(withCode('3D000'));

            expect(classified?.remedy).toContain('DATABASE_URL');
            expect(classified?.remedy).toContain('does not exist');
            // Nothing interpolated from the failure, so no driver or vendor text
            // can reach a log line through this field.
            expect(classified?.remedy).not.toContain('boom');
            expect(classified?.remedy).toBe(classifyInfrastructureFailure(withCode('3D000'))?.remedy);
        });

        it('gives each name its own remedy, because the four fixes have nothing in common', () => {
            const remedies = ['53300', '3D000', '28P01', '42P01'].map(
                (code) => classifyInfrastructureFailure(withCode(code))?.remedy,
            );

            expect(new Set(remedies).size).toBe(4);
        });

        it('declines a Prisma query error, which is a stage defect wearing a database code', () => {
            // P2002 is a unique-constraint violation. Filing it as
            // infrastructure would put a data or logic bug under the one heading
            // an operator reads as "not your code".
            expect(classifyInfrastructureFailure(withCode('P2002', 'PrismaClientKnownRequestError'))).toBeNull();
            expect(classifyInfrastructureFailure(withCode('P2025', 'PrismaClientKnownRequestError'))).toBeNull();
        });

        it.each([
            ['a filesystem failure', withCode('ENOENT')],
            ['a programming mistake', new TypeError('cannot read properties of undefined')],
            ['an error with no code at all', new Error('boom')],
            ['a thrown string', 'something went wrong'],
            ['a thrown undefined', undefined],
            ['a thrown null', null],
        ])('declines %s, leaving it to the caller’s own arms', (_label, value) => {
            expect(classifyInfrastructureFailure(value)).toBeNull();
        });

        it('is total on a hostile value, because it runs inside the handler that reports failures', () => {
            // A getter that throws and a proxy whose traps throw are the two ways
            // to make inspection fail. An exception raised while classifying a
            // failure would replace the failure being reported.
            const throwingGetter = {
                get code(): string {
                    throw new Error('getter ran');
                },
            };
            const hostileProxy = new Proxy(
                {},
                {
                    get(): never {
                        throw new Error('trap ran');
                    },
                },
            );

            expect(classifyInfrastructureFailure(throwingGetter)).toBeNull();
            expect(classifyInfrastructureFailure(hostileProxy)).toBeNull();
        });
    });

    describe('firstPartyMessage', () => {
        it('forwards a sentence this repository composed', () => {
            const message = 'release v9005 declares 12 foods and foods.jsonl holds 11';

            expect(firstPartyMessage(new Error(message))).toBe(message);
        });

        it('keeps the data path in it, which is the half an operator acts on', () => {
            const message =
                'data/meal-planning/catalog/releases/v9005/manifest.json must load and declare the coverage-plan version this build understands.';

            expect(firstPartyMessage(new Error(message))).toBe(message);
        });

        it('still scrubs the message, so the narrowing obligation is not the only defence', () => {
            const forwarded = firstPartyMessage(new Error(`connect to ${DSN_WITH_AT_IN_PASSWORD} failed`));

            expect(forwarded).toBe(`connect to ${DSN_REDACTED} failed`);
            expectNoCredentialFragment(forwarded ?? '');
        });

        it('bounds the sentence, so one line stays one line', () => {
            const long = `${'refusal '.repeat(400)}end`;
            const forwarded = firstPartyMessage(new Error(long));

            expect(long.length).toBeGreaterThan(1000);
            expect(forwarded).toHaveLength(1001);
            expect(forwarded?.endsWith('…')).toBe(true);
        });

        it.each([
            ['an empty message', new Error('')],
            ['a thrown string', 'boom'],
            ['a thrown undefined', undefined],
            ['a value whose message getter throws', {
                get message(): string {
                    throw new Error('getter ran');
                },
            }],
        ])('returns undefined for %s, so an absent member stays absent', (_label, value) => {
            expect(firstPartyMessage(value)).toBeUndefined();
        });
    });
});

/* -------------------------------------------------------------------------- *
 * The second of them.
 * -------------------------------------------------------------------------- */

// What this suite is for.
//
// `scripts/lib/rateLimiter.ts` holds the catalog importer to 900 USDA requests
// per hour so the 100/hour the running API needs on the SAME key survives
// (AAP §0.7.1). That ceiling is only real if it spans processes: the importer
// is a multi-hour run that is expected to be interrupted and resumed, and
// `checkpoint.ts` deliberately allows two launches of one stage to work
// through the same run. A ledger that lived in a closure would hand each of
// those a fresh 900, so the two cases below are the point of this file — a
// RESTART inside the hour, and TWO CONCURRENT IMPORTERS, both proved to keep
// the aggregate at or below the configured rate, the second of them across
// real operating-system processes.
//
// Each of those two is proved TWICE: once with an explicit shared
// `stateFilePath`, which proves the mechanism, and once in DEFAULT
// configuration — no injected ledger, no state path, differing working
// directories — which is what proves that two importers launched
// independently end up on one ledger at all. The default path is the thing
// that decides that, so it is tested as the configuration an operator runs
// rather than as a string.
//
// Everything else here is the fail-closed posture (state that cannot be
// trusted, or a critical section that was not exclusive, stops the import
// instead of admitting an attempt it failed to record), the atomicity of the
// on-disk state, and regression cover for the module behaviour eight CLI
// scripts already depend on.
//
// No network, no database and no real waiting: the clock and `sleep` are
// injected everywhere, so an hour of pacing costs microseconds. Every test
// given a state path writes inside a per-test temporary directory that is
// removed afterwards; the default-configuration tests write into the
// host-scoped default directory, which they share with every other process on
// the machine, so each of them uses a scope unique to this run and removes
// its own files (see 'the default configuration' and 'the suite itself').

const BACKEND_ROOT = path.join(__dirname, '..', '..', '..');
const RATE_LIMITER_MODULE = path.join(BACKEND_ROOT, 'scripts', 'lib', 'rateLimiter.ts');
const SCRIPTS_TSCONFIG = path.join(BACKEND_ROOT, 'tsconfig.scripts.json');
// Absolute, not the bare `ts-node/register` specifier: Node resolves a bare
// `--require` id against the CHILD'S WORKING DIRECTORY, and the tests below
// deliberately launch children from directories outside the checkout.
const TS_NODE_REGISTER = path.join(BACKEND_ROOT, 'node_modules', 'ts-node', 'register');
// Absolute for the same reason, and a path rather than an import because
// requiring it is what installs it (see the import block above).
const VENDOR_NETWORK_DENY_MODULE = path.join(
    BACKEND_ROOT,
    'src',
    '__tests__',
    'setup',
    // `.js`, and dependency-free CommonJS, so it can be the child's FIRST
    // `--require` — ahead of ts-node, which Node cannot load a `.ts` hook
    // without.
    'vendorNetworkDeny.js',
);

const CHILD_TIMEOUT_MS = 90_000;

interface ChildOutcome {
    status: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Runs one child Node process over the TypeScript module under test.
 *
 * `cwd` is a parameter because it is the subject of two of the tests: the
 * default ledger path must be the same for every importer on the host however
 * each of them was launched.
 *
 * `TMPDIR` is forwarded when the parent has one, so parent and child agree on
 * `os.tmpdir()` — the root the default ledger directory hangs off.
 */
const runChildProcess = (
    scriptPath: string,
    args: readonly string[],
    cwd: string,
): Promise<ChildOutcome> =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--require', TS_NODE_REGISTER, scriptPath, ...args], {
            cwd,
            timeout: CHILD_TIMEOUT_MS,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
                TS_NODE_PROJECT: SCRIPTS_TSCONFIG,
                TS_NODE_TRANSPILE_ONLY: '1',
            },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (status) => {
            resolve({ status, stdout, stderr });
        });
    });

/**
 * A scope no other process can be using. The default ledger directory is
 * HOST-scoped by design, so a test that writes there shares a directory with
 * every other checkout's suite and with any real importer on the machine; a
 * scope carrying this process's pid, the clock and a random tail is what keeps
 * those runs from being accounted against each other. Every character stays
 * inside the `[a-z0-9._-]` set the state file name preserves, so the scope is
 * recoverable from the path a test cleans up.
 */
const uniqueLedgerScope = (label: string): string =>
    `${label}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.test.invalid`;

// An arbitrary but fixed instant, so every expectation below is a plain number
// rather than something derived from the machine's clock.
const T0 = 1_700_000_000_000;

const TEST_SCOPE = 'test.usda.invalid';

interface Clock {
    read: () => number;
    advance: (ms: number) => void;
    sleep: (ms: number) => Promise<void>;
    sleeps: number[];
}

// A clock the tests own. `sleep` advances it, which is what makes an hour of
// pacing instant while keeping the module's own loop honest: it still has to
// compute a wait, and the wait it computes is what moves time.
const createClock = (startMs: number = T0): Clock => {
    let nowMs = startMs;
    const sleeps: number[] = [];

    return {
        read: (): number => nowMs,
        advance: (ms: number): void => {
            nowMs += ms;
        },
        sleep: async (ms: number): Promise<void> => {
            sleeps.push(ms);
            nowMs += ms;
        },
        sleeps,
    };
};

const instantSleep = async (): Promise<void> => undefined;

interface CapturedLog {
    event: string;
    fields: Record<string, unknown>;
}

const createRecordingLogger = (): { lines: CapturedLog[]; logger: ScriptLogger } => {
    const lines: CapturedLog[] = [];
    const record = (event: string, fields?: Record<string, unknown>): void => {
        lines.push({ event, fields: fields ?? {} });
    };

    const logger: ScriptLogger = {
        debug: record,
        info: record,
        warn: record,
        error: record,
        child: (): ScriptLogger => logger,
    };

    return { lines, logger };
};

const readStateDocument = (stateFilePath: string): { version: unknown; scope: unknown; attempts: unknown } =>
    JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as { version: unknown; scope: unknown; attempts: unknown };

const readStamps = (stateFilePath: string): number[] => {
    const document = readStateDocument(stateFilePath);

    expect(document.version).toBe(USDA_RATE_LEDGER_STATE_VERSION);
    expect(Array.isArray(document.attempts)).toBe(true);

    return document.attempts as number[];
};

const writeStateDocument = (stateFilePath: string, document: unknown): void => {
    fs.writeFileSync(stateFilePath, `${JSON.stringify(document)}\n`, 'utf8');
};

const reserveOnce = (ledger: UsdaRateLedger, nowMs: number, limit: number): Promise<UsdaRateReservation> =>
    ledger.reserve({ nowMs, limit, windowMs: RATE_WINDOW_MS });

const waitForCondition = async (
    satisfied: () => boolean,
    timeoutMs: number,
    description: string,
): Promise<void> => {
    const deadlineMs = Date.now() + timeoutMs;

    while (!satisfied()) {
        if (Date.now() > deadlineMs) {
            throw new Error(`timed out waiting for ${description}`);
        }

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
        });
    }
};

describe('the cross-process USDA rate ledger', () => {
    describe('scripts/lib/rateLimiter', () => {
        let workspace: string;

        beforeEach(() => {
            workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-usda-ledger-'));
        });

        afterEach(() => {
            fs.rmSync(workspace, { recursive: true, force: true });
        });

        const statePathFor = (name: string = 'ledger.json'): string => path.join(workspace, name);

        const fileLedgerOver = (stateFilePath: string, scope: string = TEST_SCOPE): UsdaRateLedger =>
            createFileUsdaRateLedger({ stateFilePath, scope, sleep: instantSleep, lockRetryDelayMs: 0 });

        // -----------------------------------------------------------------------
        // The two cases the review asked for.
        // -----------------------------------------------------------------------

        describe('a restart inside the rolling hour', () => {
            const RATE = 5;

            // A ledger instance per limiter is exactly what a restarted process
            // has: the same state file, a fresh in-memory view.
            const limiterOver = (
                stateFilePath: string,
                now: () => number,
                sleep: (ms: number) => Promise<void>,
            ): UsdaRateLimiter =>
                createUsdaRateLimiter({
                    requestsPerHour: RATE,
                    burstCapacity: RATE,
                    now,
                    sleep,
                    ledger: fileLedgerOver(stateFilePath),
                });

            it('does not hand the restarted process a fresh hourly allowance', async () => {
                const stateFilePath = statePathFor();
                const clock = createClock();

                const before = limiterOver(stateFilePath, clock.read, clock.sleep);
                for (let index = 0; index < RATE; index += 1) {
                    await before.acquire();
                }

                expect(before.stats().attempts).toBe(RATE);
                expect(before.stats().pauses).toBe(0);
                expect(before.stats().attemptsInWindow).toBe(RATE);
                expect(readStamps(stateFilePath)).toHaveLength(RATE);

                // Ten minutes of the hour have gone by when the operator restarts.
                clock.advance(600_000);

                // Refused, and the wait is the remainder of the hour measured from
                // the OLDEST stamp the previous process wrote.
                const reservation = await reserveOnce(fileLedgerOver(stateFilePath), clock.read(), RATE);

                expect(reservation.admitted).toBe(false);
                expect(reservation.attemptsInWindow).toBe(RATE);
                expect(reservation.waitMs).toBe(RATE_WINDOW_MS - 600_000);

                // Driven through `acquire`, the restarted limiter waits out exactly
                // that remainder — plus the one millisecond the inclusive far
                // boundary withholds — and then admits.
                const after = limiterOver(stateFilePath, clock.read, clock.sleep);
                await after.acquire();

                expect(clock.sleeps).toEqual([RATE_WINDOW_MS - 600_000, 1]);
                expect(after.stats().attempts).toBe(1);
                expect(after.stats().pauses).toBe(2);
                expect(clock.read()).toBe(T0 + RATE_WINDOW_MS + 1);
                // The five stamps from before the restart have aged out, so the
                // hour holds one attempt, not six.
                expect(readStamps(stateFilePath)).toEqual([T0 + RATE_WINDOW_MS + 1]);
                expect(after.stats().attemptsInWindow).toBe(1);
            });

            it('keeps the aggregate at the configured rate across three consecutive restarts', async () => {
                const stateFilePath = statePathFor();
                const clock = createClock();
                // Any pause at all is a failure here: the point is that the first
                // RATE attempts across three launches go through without waiting,
                // and that the one after them cannot.
                const refuseToWait = async (ms: number): Promise<void> => {
                    throw new Error(`unexpected pause of ${ms}ms`);
                };

                let admitted = 0;

                for (let launch = 0; launch < 3; launch += 1) {
                    const limiter = limiterOver(stateFilePath, clock.read, refuseToWait);

                    for (let index = 0; index < 2; index += 1) {
                        if (admitted < RATE) {
                            await limiter.acquire();
                            admitted += 1;
                            continue;
                        }

                        await expect(limiter.acquire()).rejects.toThrow('unexpected pause');
                    }
                }

                // Three launches, six attempts, one hour: five admitted and the
                // sixth paused. A process-local ledger would have admitted all six.
                expect(admitted).toBe(RATE);
                expect(readStamps(stateFilePath)).toHaveLength(RATE);
            });
        });

        describe('two concurrent importers', () => {
            it('admits at most the limit in aggregate from interleaved in-process ledgers', async () => {
                const stateFilePath = statePathFor();
                const limit = 4;
                const ledgers = [fileLedgerOver(stateFilePath), fileLedgerOver(stateFilePath)];

                // Twice the allowance, asked for at the same instant, alternating
                // between the two ledgers and all in flight together.
                const reservations = await Promise.all(
                    Array.from({ length: limit * 2 }, (_unused, index) =>
                        reserveOnce(ledgers[index % ledgers.length] as UsdaRateLedger, T0, limit),
                    ),
                );

                const admitted = reservations.filter((reservation) => reservation.admitted);

                expect(admitted).toHaveLength(limit);
                expect(readStamps(stateFilePath)).toHaveLength(limit);

                for (const refused of reservations.filter((candidate) => !candidate.admitted)) {
                    // The window filled at T0, so nothing can age out before the
                    // hour is up.
                    expect(refused.waitMs).toBe(RATE_WINDOW_MS);
                    expect(refused.attemptsInWindow).toBe(limit);
                }

                // The count each admission saw is 1..limit with no repeats: proof
                // the decision and the record were ONE step, rather than two
                // ledgers both reading the same count and both admitting.
                expect(admitted.map((reservation) => reservation.attemptsInWindow).sort((a, b) => a - b)).toEqual([
                    1, 2, 3, 4,
                ]);
            });

            it(
                'admits at most the limit in aggregate across real child processes',
                async () => {
                    const stateFilePath = statePathFor();
                    const barrierPath = path.join(workspace, 'start');
                    const readyPrefix = 'ready.';
                    const limit = 6;

                    const childScript = path.join(workspace, 'reserve-child.js');
                    fs.writeFileSync(
                        childScript,
                        `'use strict';
const fs = require('fs');
const path = require('path');
const { createFileUsdaRateLedger } = require(${JSON.stringify(RATE_LIMITER_MODULE)});

const [statePath, scope, barrier, limit, attempts, nowMs] = process.argv.slice(2);

const ledger = createFileUsdaRateLedger({
    stateFilePath: statePath,
    scope,
    lockAttempts: 2000,
    lockRetryDelayMs: 2,
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
    fs.writeFileSync(path.join(path.dirname(barrier), '${readyPrefix}' + process.pid), '', 'utf8');

    const deadline = Date.now() + 30000;
    while (!fs.existsSync(barrier)) {
        if (Date.now() > deadline) {
            throw new Error('barrier never appeared');
        }
    }

    let admitted = 0;
    for (let index = 0; index < Number(attempts); index += 1) {
        const reservation = await ledger.reserve({
            nowMs: Number(nowMs),
            limit: Number(limit),
            windowMs: ${RATE_WINDOW_MS},
        });

        if (reservation.admitted) {
            admitted += 1;
        }

        // A gap between attempts so the two children really interleave
        // instead of one draining the allowance before the other starts.
        await pause(3);
    }

    process.stdout.write(JSON.stringify({ admitted }));
};

main().then(
    () => process.exit(0),
    (error) => {
        process.stderr.write(String(error && error.message));
        process.exit(1);
    },
);
`,
                        'utf8',
                    );

                    const runChild = (): Promise<ChildOutcome> =>
                        runChildProcess(
                            childScript,
                            [stateFilePath, TEST_SCOPE, barrierPath, `${limit}`, `${limit}`, `${T0}`],
                            BACKEND_ROOT,
                        );

                    const children = [runChild(), runChild()];

                    // Released only once BOTH children are booted and spinning on
                    // the barrier, so their reservations really do overlap rather
                    // than running in sequence.
                    await waitForCondition(
                        () => fs.readdirSync(workspace).filter((entry) => entry.startsWith(readyPrefix)).length === 2,
                        CHILD_TIMEOUT_MS / 2,
                        'both children to signal readiness',
                    );
                    fs.writeFileSync(barrierPath, 'go', 'utf8');

                    const [first, second] = await Promise.all(children);

                    expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: '' });
                    expect({ status: second.status, stderr: second.stderr }).toEqual({ status: 0, stderr: '' });

                    const firstAdmitted = (JSON.parse(first.stdout) as { admitted: number }).admitted;
                    const secondAdmitted = (JSON.parse(second.stdout) as { admitted: number }).admitted;

                    // The whole point: two processes, one hour, one allowance
                    // between them, each having asked for all of it. How the limit
                    // splits between them is the scheduler's business and is
                    // deliberately not asserted; the total is what the vendor sees.
                    expect(firstAdmitted + secondAdmitted).toBe(limit);
                    expect(readStamps(stateFilePath)).toHaveLength(limit);

                    // Nothing left behind: no lock and no half-written temp file.
                    expect(
                        fs.readdirSync(workspace).filter((entry) => entry.endsWith('.lock') || entry.endsWith('.tmp')),
                    ).toEqual([]);
                },
                CHILD_TIMEOUT_MS,
            );
        });

        // -----------------------------------------------------------------------
        // The same two cases again, in the configuration an operator actually
        // runs: no injected ledger, no `stateFilePath`, nothing but a rate and a
        // scope. Handing two importers one explicit path proves the mechanism; it
        // does not prove that two importers launched independently END UP on one
        // ledger, and the default path is what decides that. Every test here
        // writes into the host-scoped default directory under a scope unique to
        // this run, and removes its own files afterwards.
        // -----------------------------------------------------------------------

        describe('the default configuration', () => {
            const scopesToClean: string[] = [];

            const useUniqueScope = (label: string): string => {
                const scope = uniqueLedgerScope(label);
                scopesToClean.push(scope);

                return scope;
            };

            const defaultStatePathFor = (scope: string): string => defaultUsdaRateLedgerStateFilePath(scope);

            afterEach(() => {
                // Only this run's own files, never the directory: it is shared
                // with every other process on the host, which is the entire point
                // of the default being where it is.
                while (scopesToClean.length > 0) {
                    const scope = scopesToClean.pop() as string;
                    const statePath = defaultStatePathFor(scope);

                    fs.rmSync(`${statePath}.lock`, { force: true });
                    fs.rmSync(statePath, { force: true });
                }
            });

            it('keeps the default state file in one host-scoped directory outside every checkout', () => {
                const directory = defaultUsdaRateLedgerDirectory();
                const statePath = defaultUsdaRateLedgerStateFilePath();

                expect(directory).toBe(path.join(os.tmpdir(), 'soh-usda-rate-ledger'));
                expect(path.dirname(directory)).toBe(os.tmpdir());
                expect(path.dirname(statePath)).toBe(directory);
                expect(path.basename(statePath)).toBe(`usda-rate-ledger.${USDA_HOST}.json`);

                // Host-scoped is the requirement, because USDA's 1,000/hour
                // belongs to the KEY: two checkouts on one machine read the same
                // `USDA_API_KEY` and must therefore read the same ledger.
                expect(statePath.startsWith(`${BACKEND_ROOT}${path.sep}`)).toBe(false);
                // And install-independent: a path under `node_modules` loses the
                // hour's record to every `npm ci` or redeploy — the restart
                // boundary the durable ledger exists for.
                expect(statePath).not.toContain('node_modules');
                expect(statePath).not.toContain(path.join('scripts', 'lib'));
            });

            it('derives the same default state file path from two processes with different working directories', async () => {
                const scope = 'default.path.usda.invalid';
                const childScript = path.join(workspace, 'default-path-child.js');

                fs.writeFileSync(
                    childScript,
                    `'use strict';
const {
    defaultUsdaRateLedgerDirectory,
    defaultUsdaRateLedgerStateFilePath,
} = require(${JSON.stringify(RATE_LIMITER_MODULE)});

process.stdout.write(
    JSON.stringify({
        cwd: process.cwd(),
        directory: defaultUsdaRateLedgerDirectory(),
        statePath: defaultUsdaRateLedgerStateFilePath(process.argv[2]),
    }),
);
`,
                    'utf8',
                );

                // One inside the checkout, one outside it and nowhere near it.
                const [insideCheckout, elsewhere] = await Promise.all([
                    runChildProcess(childScript, [scope], BACKEND_ROOT),
                    runChildProcess(childScript, [scope], workspace),
                ]);

                expect({ status: insideCheckout.status, stderr: insideCheckout.stderr }).toEqual({
                    status: 0,
                    stderr: '',
                });
                expect({ status: elsewhere.status, stderr: elsewhere.stderr }).toEqual({ status: 0, stderr: '' });

                const first = JSON.parse(insideCheckout.stdout) as { cwd: string; directory: string; statePath: string };
                const second = JSON.parse(elsewhere.stdout) as { cwd: string; directory: string; statePath: string };

                // The premise of the test: the two really did run from different
                // directories.
                expect(first.cwd).not.toBe(second.cwd);
                expect(first.directory).toBe(second.directory);
                expect(first.statePath).toBe(second.statePath);
                // And the path this process derives is the same one again, so a
                // ledger constructed anywhere accounts against the same hour.
                expect(first.statePath).toBe(defaultUsdaRateLedgerStateFilePath(scope));
            });

            it(
                'admits at most the limit in aggregate across two real processes that were given no state path',
                async () => {
                    const scope = useUniqueScope('concurrent');
                    const statePath = defaultStatePathFor(scope);
                    const barrierPath = path.join(workspace, 'start');
                    const readyPrefix = 'ready.';
                    const limit = 6;

                    const childScript = path.join(workspace, 'default-reserve-child.js');
                    fs.writeFileSync(
                        childScript,
                        `'use strict';
const fs = require('fs');
const path = require('path');
const {
    createFileUsdaRateLedger,
    defaultUsdaRateLedgerStateFilePath,
} = require(${JSON.stringify(RATE_LIMITER_MODULE)});

const [scope, barrier, limit, attempts, nowMs] = process.argv.slice(2);

// The configuration under test: a scope and nothing else. No stateFilePath,
// so the ledger has to derive where it lives — which is the only way two
// importers launched independently land on one hour.
const ledger = createFileUsdaRateLedger({
    scope,
    lockAttempts: 2000,
    lockRetryDelayMs: 2,
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
    fs.writeFileSync(path.join(path.dirname(barrier), '${readyPrefix}' + process.pid), '', 'utf8');

    const deadline = Date.now() + 30000;
    while (!fs.existsSync(barrier)) {
        if (Date.now() > deadline) {
            throw new Error('barrier never appeared');
        }
    }

    let admitted = 0;
    for (let index = 0; index < Number(attempts); index += 1) {
        const reservation = await ledger.reserve({
            nowMs: Number(nowMs),
            limit: Number(limit),
            windowMs: ${RATE_WINDOW_MS},
        });

        if (reservation.admitted) {
            admitted += 1;
        }

        await pause(3);
    }

    process.stdout.write(
        JSON.stringify({
            admitted,
            cwd: process.cwd(),
            statePath: defaultUsdaRateLedgerStateFilePath(scope),
        }),
    );
};

main().then(
    () => process.exit(0),
    (error) => {
        process.stderr.write(String(error && error.message));
        process.exit(1);
    },
);
`,
                        'utf8',
                    );

                    const args = [scope, barrierPath, `${limit}`, `${limit}`, `${T0}`];
                    // Different working directories, so nothing but the module's
                    // own derivation can be putting them on the same ledger.
                    const children = [
                        runChildProcess(childScript, args, BACKEND_ROOT),
                        runChildProcess(childScript, args, workspace),
                    ];

                    await waitForCondition(
                        () => fs.readdirSync(workspace).filter((entry) => entry.startsWith(readyPrefix)).length === 2,
                        CHILD_TIMEOUT_MS / 2,
                        'both children to signal readiness',
                    );
                    fs.writeFileSync(barrierPath, 'go', 'utf8');

                    const [first, second] = await Promise.all(children);

                    expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: '' });
                    expect({ status: second.status, stderr: second.stderr }).toEqual({ status: 0, stderr: '' });

                    const firstReport = JSON.parse(first.stdout) as { admitted: number; cwd: string; statePath: string };
                    const secondReport = JSON.parse(second.stdout) as { admitted: number; cwd: string; statePath: string };

                    expect(firstReport.cwd).not.toBe(secondReport.cwd);
                    // Two processes, two working directories, one allowance
                    // between them, each having asked for all of it.
                    expect(firstReport.admitted + secondReport.admitted).toBeLessThanOrEqual(limit);
                    expect(firstReport.admitted + secondReport.admitted).toBe(limit);

                    // The ledger they shared is the host-scoped default one, and
                    // it is where the stamps actually are.
                    expect(firstReport.statePath).toBe(statePath);
                    expect(secondReport.statePath).toBe(statePath);
                    expect(path.dirname(statePath)).toBe(defaultUsdaRateLedgerDirectory());
                    expect(fs.existsSync(statePath)).toBe(true);
                    expect(readStamps(statePath)).toHaveLength(limit);
                    expect(readStateDocument(statePath).scope).toBe(scope);
                    // No lock and no half-written temp file left in a directory
                    // other importers use.
                    expect(
                        fs
                            .readdirSync(defaultUsdaRateLedgerDirectory())
                            .filter((entry) => entry.startsWith(path.basename(statePath)) && entry !== path.basename(statePath)),
                    ).toEqual([]);
                },
                CHILD_TIMEOUT_MS,
            );

            it('does not hand a restart inside the hour a fresh allowance over the default path', async () => {
                const RATE = 3;
                const scope = useUniqueScope('restart');
                const statePath = defaultStatePathFor(scope);
                const clock = createClock();

                // `createUsdaRateLimiter` with no `ledger` and no
                // `ledgerStateFilePath`: the durable-by-default wiring, over the
                // path an operator gets.
                const before = createUsdaRateLimiter({
                    requestsPerHour: RATE,
                    burstCapacity: RATE,
                    now: clock.read,
                    sleep: clock.sleep,
                    ledgerScope: scope,
                });

                for (let index = 0; index < RATE; index += 1) {
                    await before.acquire();
                }

                expect(before.stats().ledgerKind).toBe('file');
                expect(before.stats().ledgerScope).toBe(scope);
                expect(before.stats().attempts).toBe(RATE);
                expect(clock.sleeps).toEqual([]);
                expect(readStamps(statePath)).toHaveLength(RATE);

                // A quarter of an hour later the operator restarts the importer.
                clock.advance(900_000);

                const pausedFor: number[] = [];
                const after = createUsdaRateLimiter({
                    requestsPerHour: RATE,
                    burstCapacity: RATE,
                    now: clock.read,
                    sleep: async (ms: number): Promise<void> => {
                        pausedFor.push(ms);
                        throw new Error('restarted importer paused');
                    },
                    ledgerScope: scope,
                });

                await expect(after.acquire()).rejects.toThrow('restarted importer paused');

                // Refused, and the wait is the remainder of the hour measured from
                // the oldest stamp the process before the restart wrote — not a
                // fresh 900.
                expect(pausedFor).toEqual([RATE_WINDOW_MS - 900_000]);
                expect(after.stats().attempts).toBe(0);
                expect(after.stats().attemptsInWindow).toBe(RATE);
                expect(readStamps(statePath)).toHaveLength(RATE);
                expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
            });
        });

        // -----------------------------------------------------------------------
        // The ledger port and its two implementations.
        // -----------------------------------------------------------------------

        describe('the ledgers and the pure window rules', () => {
            it('reaches the same decisions the exported rules do, for both implementations', async () => {
                const limit = 3;
                const stateFilePath = statePathFor();
                const ledgers: UsdaRateLedger[] = [
                    createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE }),
                    fileLedgerOver(stateFilePath),
                ];

                for (const ledger of ledgers) {
                    // The expectations are computed independently from the exported
                    // rules, so a ledger that grew its own copy of the rolling-hour
                    // arithmetic would fail here.
                    let expected: number[] = [];

                    for (const nowMs of [T0, T0 + 10, T0 + 20, T0 + 30, T0 + RATE_WINDOW_MS + 40]) {
                        const pruned = pruneAttemptWindow(expected, nowMs, RATE_WINDOW_MS);
                        const expectedWaitMs = windowWaitMs(pruned, nowMs, limit, RATE_WINDOW_MS);
                        const reservation = await reserveOnce(ledger, nowMs, limit);

                        expect(reservation.admitted).toBe(expectedWaitMs === 0);
                        expect(reservation.waitMs).toBe(expectedWaitMs);

                        expected = expectedWaitMs === 0 ? recordAttemptWindow(pruned, nowMs, RATE_WINDOW_MS) : pruned;

                        expect(reservation.attemptsInWindow).toBe(expected.length);
                    }
                }

                // Only the last attempt is still inside the hour by the end of
                // that sequence, and the file says so.
                expect(readStamps(stateFilePath)).toEqual([T0 + RATE_WINDOW_MS + 40]);
            });

            it('reports its kind and scope', () => {
                expect(createProcessLocalUsdaRateLedger().describe()).toEqual({
                    kind: 'process_local',
                    scope: DEFAULT_USDA_RATE_LEDGER_SCOPE,
                });
                expect(createFileUsdaRateLedger({ stateFilePath: statePathFor(), scope: 'Shared.KEY' }).describe()).toEqual({
                    kind: 'file',
                    scope: 'shared.key',
                });
            });

            it('refuses a blank scope rather than pooling unrelated credentials into one ledger', () => {
                expect(() => createFileUsdaRateLedger({ scope: '   ' })).toThrow(RateLimitConfigError);
                expect(() => createProcessLocalUsdaRateLedger({ scope: '' })).toThrow(RateLimitConfigError);
            });

            it('refuses lock settings that would make every lock look fresh or every reservation fail', () => {
                const stateFilePath = statePathFor();

                expect(() => createFileUsdaRateLedger({ stateFilePath, lockStaleMs: Number.NaN })).toThrow(
                    RateLimitConfigError,
                );
                expect(() => createFileUsdaRateLedger({ stateFilePath, lockAttempts: 0 })).toThrow(RateLimitConfigError);
                expect(() => createFileUsdaRateLedger({ stateFilePath, lockAttempts: 1.5 })).toThrow(RateLimitConfigError);
                expect(() => createFileUsdaRateLedger({ stateFilePath, lockRetryDelayMs: -1 })).toThrow(
                    RateLimitConfigError,
                );
            });

            it('is honest about the process-local ledger not surviving a restart', async () => {
                const limit = 2;

                const first = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });
                expect((await reserveOnce(first, T0, limit)).admitted).toBe(true);
                expect((await reserveOnce(first, T0, limit)).admitted).toBe(true);
                expect((await reserveOnce(first, T0, limit)).admitted).toBe(false);

                // A second instance stands in for a second process, and it knows
                // nothing — which is precisely why the importer does not use it.
                const second = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });
                expect((await reserveOnce(second, T0, limit)).admitted).toBe(true);
            });

            it('touches the filesystem only on the first reservation', async () => {
                const stateFilePath = path.join(workspace, 'nested', 'deeper', 'ledger.json');
                const ledger = fileLedgerOver(stateFilePath);

                expect(fs.existsSync(path.dirname(stateFilePath))).toBe(false);

                await reserveOnce(ledger, T0, 1);

                expect(fs.existsSync(stateFilePath)).toBe(true);
            });

            it('keeps the state file bounded by the limit however long the run lasts', async () => {
                const stateFilePath = statePathFor();
                const limit = 3;
                const ledger = fileLedgerOver(stateFilePath);

                // Six hours of attempts, one every half hour: the window never
                // holds more than the limit and the file never grows past it.
                for (let index = 0; index < 12; index += 1) {
                    const reservation = await reserveOnce(ledger, T0 + index * 1_800_000, limit);

                    expect(reservation.admitted).toBe(true);
                    expect(readStamps(stateFilePath).length).toBeLessThanOrEqual(limit);
                }
            });

            it('persists the pruning it does while a run is waiting out the hour', async () => {
                const stateFilePath = statePathFor();
                const ledger = fileLedgerOver(stateFilePath);

                // Three attempts under a rate of three, the first of them early
                // enough to age out before the others.
                await reserveOnce(ledger, T0, 3);
                await reserveOnce(ledger, T0 + RATE_WINDOW_MS - 2_000, 3);
                await reserveOnce(ledger, T0 + RATE_WINDOW_MS - 1_000, 3);
                expect(readStamps(stateFilePath)).toHaveLength(3);

                // The operator then lowers the rate to two and the run waits. The
                // refusal still has to persist what aged out, or a long wait would
                // leave the file holding expired entries for the rest of the run.
                const refused = await reserveOnce(ledger, T0 + RATE_WINDOW_MS + 1, 2);

                expect(refused.admitted).toBe(false);
                expect(refused.attemptsInWindow).toBe(2);
                expect(readStamps(stateFilePath)).toEqual([
                    T0 + RATE_WINDOW_MS - 2_000,
                    T0 + RATE_WINDOW_MS - 1_000,
                ]);
            });
        });

        // -----------------------------------------------------------------------
        // Mutual exclusion.
        // -----------------------------------------------------------------------

        describe('the state lock', () => {
            // A lock file as an abandoned holder leaves it: a token, aged past the
            // staleness threshold.
            const abandonLock = (lockFilePath: string, token: string, ageMs: number = 120_000): void => {
                fs.writeFileSync(lockFilePath, token, 'utf8');

                const abandonedAt = new Date(Date.now() - ageMs);
                fs.utimesSync(lockFilePath, abandonedAt, abandonedAt);
            };

            it('breaks a lock older than the staleness threshold instead of deadlocking the run', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                abandonLock(lockFilePath, 'usda-rate-ledger.999999.1.abandoned\n');

                const ledger = createFileUsdaRateLedger({
                    stateFilePath,
                    scope: TEST_SCOPE,
                    lockStaleMs: 30_000,
                    sleep: instantSleep,
                });

                const reservation = await reserveOnce(ledger, T0, 1);

                expect(reservation.admitted).toBe(true);
                expect(readStamps(stateFilePath)).toEqual([T0]);
                expect(fs.existsSync(lockFilePath)).toBe(false);
            });

            it('breaks a stale lock that carries no token at all', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                // What a process that died between creating the lock file and
                // stamping it leaves behind — and what an older build's lock looks
                // like. Unbreakable, it would wedge every later run for good.
                abandonLock(lockFilePath, '');

                const ledger = createFileUsdaRateLedger({
                    stateFilePath,
                    scope: TEST_SCOPE,
                    lockStaleMs: 30_000,
                    sleep: instantSleep,
                });

                expect((await reserveOnce(ledger, T0, 1)).admitted).toBe(true);
                expect(fs.existsSync(lockFilePath)).toBe(false);
            });

            it('stamps each acquisition with its own token and holds it across the critical section', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                const ledger = fileLedgerOver(stateFilePath);
                const tokensHeldDuringTheWrite: string[] = [];

                // `renameSync` is the last step inside the critical section, so
                // reading the lock file here reads what the reservation is holding.
                const actualRename = fs.renameSync;
                const rename = jest
                    .spyOn(fs, 'renameSync')
                    .mockImplementation((from: fs.PathLike, to: fs.PathLike): void => {
                        tokensHeldDuringTheWrite.push(fs.readFileSync(lockFilePath, 'utf8'));
                        actualRename(from, to);
                    });

                try {
                    expect((await reserveOnce(ledger, T0, 5)).admitted).toBe(true);
                    expect((await reserveOnce(ledger, T0 + 1, 5)).admitted).toBe(true);
                } finally {
                    rename.mockRestore();
                }

                expect(tokensHeldDuringTheWrite).toHaveLength(2);

                for (const token of tokensHeldDuringTheWrite) {
                    // The pid is what distinguishes two live holders; the clock and
                    // the random tail distinguish two acquisitions by one process.
                    expect(token).toContain(`.${process.pid}.`);
                    expect(token.trim().length).toBeGreaterThan(`${process.pid}`.length);
                }

                expect(tokensHeldDuringTheWrite[0]).not.toBe(tokensHeldDuringTheWrite[1]);
            });

            it('respects a fresh lock and refuses rather than stealing it', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                fs.writeFileSync(lockFilePath, '', 'utf8');

                const retries: number[] = [];
                const ledger = createFileUsdaRateLedger({
                    stateFilePath,
                    scope: TEST_SCOPE,
                    lockStaleMs: 30_000,
                    lockAttempts: 3,
                    lockRetryDelayMs: 7,
                    sleep: async (ms: number): Promise<void> => {
                        retries.push(ms);
                    },
                });

                const thrown = await reserveOnce(ledger, T0, 1).catch((error: unknown) => error);

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                const failure = thrown as UsdaRateLedgerError;
                expect(failure.name).toBe('UsdaRateLedgerError');
                expect(failure.code).toBe('lock_unavailable');
                expect(failure.stateFilePath).toBe(stateFilePath);
                expect(failure.scope).toBe(TEST_SCOPE);
                expect(retries).toEqual([7, 7, 7]);
                // The holder's lock is left exactly as it was, and nothing was
                // admitted or recorded.
                expect(fs.existsSync(lockFilePath)).toBe(true);
                expect(fs.existsSync(stateFilePath)).toBe(false);
            });

            it('releases the lock after every reservation, admitted or not', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                const ledger = fileLedgerOver(stateFilePath);

                expect((await reserveOnce(ledger, T0, 1)).admitted).toBe(true);
                expect(fs.existsSync(lockFilePath)).toBe(false);

                expect((await reserveOnce(ledger, T0, 1)).admitted).toBe(false);
                expect(fs.existsSync(lockFilePath)).toBe(false);
            });

            it('refuses rather than holding a lock it could not stamp', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                const ledger = fileLedgerOver(stateFilePath);

                // The stamp is the only write that goes to a descriptor rather
                // than a path, so failing those and nothing else is exactly the
                // "lock created, token never landed" case.
                const actualWriteFileSync = fs.writeFileSync;
                const writeFile = jest.spyOn(fs, 'writeFileSync').mockImplementation(((
                    target: Parameters<typeof fs.writeFileSync>[0],
                    data: Parameters<typeof fs.writeFileSync>[1],
                    options?: Parameters<typeof fs.writeFileSync>[2],
                ) => {
                    if (typeof target === 'number') {
                        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
                    }

                    return actualWriteFileSync(target, data, options);
                }) as typeof fs.writeFileSync);

                try {
                    const thrown = await reserveOnce(ledger, T0, 1).catch((error: unknown) => error);

                    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                    const failure = thrown as UsdaRateLedgerError;
                    expect(failure.code).toBe('lock_unavailable');
                    expect(failure.message).toContain('could not be stamped');
                } finally {
                    writeFile.mockRestore();
                }

                // Nothing admitted, and no unidentifiable lock left to block the
                // next run for the staleness threshold.
                expect(fs.existsSync(lockFilePath)).toBe(false);
                expect(fs.existsSync(stateFilePath)).toBe(false);
                expect((await reserveOnce(ledger, T0, 1)).admitted).toBe(true);
            });

            it('refuses when a lock that exists cannot be read, rather than assuming it is gone', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                abandonLock(lockFilePath, 'usda-rate-ledger.999999.4.other-user\n');

                // What a second OS user meets under the 0700/0600 modes of the
                // default directory. Reading it as "no lock" is how that user
                // would hand itself a second allowance against one key.
                const actualReadFileSync = fs.readFileSync;
                const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                    target: Parameters<typeof fs.readFileSync>[0],
                    options?: Parameters<typeof fs.readFileSync>[1],
                ) => {
                    if (target === lockFilePath) {
                        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
                    }

                    return actualReadFileSync(target, options);
                }) as typeof fs.readFileSync);

                try {
                    const thrown = await reserveOnce(fileLedgerOver(stateFilePath), T0, 1).catch(
                        (error: unknown) => error,
                    );

                    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                    const failure = thrown as UsdaRateLedgerError;
                    expect(failure.code).toBe('lock_unavailable');
                    expect(failure.message).toContain('exists but could not be read');
                } finally {
                    readFile.mockRestore();
                }

                expect(fs.existsSync(lockFilePath)).toBe(true);
                expect(fs.existsSync(stateFilePath)).toBe(false);
            });

            it('leaves a stale lock alone when its token changed between the age check and the unlink', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                abandonLock(lockFilePath, 'usda-rate-ledger.999999.1.first\n');

                // Every read of the lock file answers with a different holder, so
                // the token the staleness was measured on is never the token that
                // would be unlinked — the case in which unlinking would tear the
                // lock out from under a live holder that took it a moment ago.
                const actualReadFileSync = fs.readFileSync;
                let holder = 0;
                const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                    target: Parameters<typeof fs.readFileSync>[0],
                    options?: Parameters<typeof fs.readFileSync>[1],
                ) => {
                    if (target === lockFilePath) {
                        holder += 1;

                        return `usda-rate-ledger.999999.1.holder-${holder}\n`;
                    }

                    return actualReadFileSync(target, options);
                }) as typeof fs.readFileSync);

                const retries: number[] = [];
                const ledger = createFileUsdaRateLedger({
                    stateFilePath,
                    scope: TEST_SCOPE,
                    lockStaleMs: 30_000,
                    lockAttempts: 3,
                    lockRetryDelayMs: 5,
                    sleep: async (ms: number): Promise<void> => {
                        retries.push(ms);
                    },
                });

                try {
                    const thrown = await reserveOnce(ledger, T0, 1).catch((error: unknown) => error);

                    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);
                    expect((thrown as UsdaRateLedgerError).code).toBe('lock_unavailable');
                    // Waited its bounded attempts out rather than stealing it, and
                    // the lock file is still there for its holder.
                    expect(retries).toEqual([5, 5, 5]);
                    expect(fs.existsSync(lockFilePath)).toBe(true);
                    expect(fs.existsSync(stateFilePath)).toBe(false);
                } finally {
                    readFile.mockRestore();
                }
            });

            it('refuses to report an admission when another importer took the lock after the record was written', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                const ledger = fileLedgerOver(stateFilePath);
                const foreignToken = 'usda-rate-ledger.999999.2.foreign\n';

                // The one outcome the token exists to make impossible: a breaker
                // removed this reservation's lock and took its own while the
                // reservation was inside the critical section. The write may
                // already be on disk — which is the safe direction — but the
                // caller must not be told it may spend the slot.
                const actualRename = fs.renameSync;
                const rename = jest
                    .spyOn(fs, 'renameSync')
                    .mockImplementationOnce((from: fs.PathLike, to: fs.PathLike): void => {
                        actualRename(from, to);
                        fs.writeFileSync(lockFilePath, foreignToken, 'utf8');
                    });

                try {
                    const thrown = await reserveOnce(ledger, T0, 5).catch((error: unknown) => error);

                    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                    const failure = thrown as UsdaRateLedgerError;
                    expect(failure.code).toBe('lock_unavailable');
                    expect(failure.message).toContain('after this attempt was recorded');
                    expect(failure.message).toContain('was not exclusive');
                } finally {
                    rename.mockRestore();
                }

                // Over-charged rather than under-charged: the stamp is on disk for
                // an attempt the caller was never cleared to make.
                expect(readStamps(stateFilePath)).toEqual([T0]);
                // And the foreign holder's lock was left exactly as it was, so the
                // failure does not cascade into a third process's critical section.
                expect(fs.readFileSync(lockFilePath, 'utf8')).toBe(foreignToken);
            });

            it('refuses to report an admission when the lock disappeared after the record was written', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                const ledger = fileLedgerOver(stateFilePath);

                const actualRename = fs.renameSync;
                const rename = jest
                    .spyOn(fs, 'renameSync')
                    .mockImplementationOnce((from: fs.PathLike, to: fs.PathLike): void => {
                        actualRename(from, to);
                        fs.rmSync(lockFilePath, { force: true });
                    });

                try {
                    const thrown = await reserveOnce(ledger, T0, 5).catch((error: unknown) => error);

                    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);
                    expect((thrown as UsdaRateLedgerError).code).toBe('lock_unavailable');
                    expect((thrown as UsdaRateLedgerError).message).toContain('had been removed');
                } finally {
                    rename.mockRestore();
                }

                expect(readStamps(stateFilePath)).toEqual([T0]);
            });

            it('refuses to report an admission when another importer overwrote the document it just wrote', async () => {
                const stateFilePath = statePathFor();
                const ledger = fileLedgerOver(stateFilePath);
                const clobbered = { version: USDA_RATE_LEDGER_STATE_VERSION, scope: TEST_SCOPE, attempts: [] };

                // The residual case the lock check alone cannot see: the lock file
                // is untouched, but the document this reservation wrote is not the
                // document on disk, so its attempt is not accounted for anywhere.
                const actualRename = fs.renameSync;
                const rename = jest
                    .spyOn(fs, 'renameSync')
                    .mockImplementationOnce((from: fs.PathLike, to: fs.PathLike): void => {
                        actualRename(from, to);
                        writeStateDocument(stateFilePath, clobbered);
                    });

                try {
                    const thrown = await reserveOnce(ledger, T0, 5).catch((error: unknown) => error);

                    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                    const failure = thrown as UsdaRateLedgerError;
                    expect(failure.code).toBe('lock_unavailable');
                    expect(failure.message).toContain('not accounted for');
                } finally {
                    rename.mockRestore();
                }

                expect(readStamps(stateFilePath)).toEqual([]);
            });

            it('refuses to report an admission when the document cannot be read back', async () => {
                const stateFilePath = statePathFor();
                const ledger = fileLedgerOver(stateFilePath);

                // The first read is the reservation's own load of the document;
                // the read-back after the write is the one that fails here.
                const actualReadFileSync = fs.readFileSync;
                let stateReads = 0;
                const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                    target: Parameters<typeof fs.readFileSync>[0],
                    options?: Parameters<typeof fs.readFileSync>[1],
                ) => {
                    if (target === stateFilePath) {
                        stateReads += 1;

                        if (stateReads > 1) {
                            throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
                        }
                    }

                    return actualReadFileSync(target, options);
                }) as typeof fs.readFileSync);

                try {
                    const thrown = await reserveOnce(ledger, T0, 5).catch((error: unknown) => error);

                    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                    const failure = thrown as UsdaRateLedgerError;
                    expect(failure.code).toBe('state_unreadable');
                    expect(failure.message).toContain('cannot be shown to be accounted for');
                    expect(stateReads).toBe(2);
                } finally {
                    readFile.mockRestore();
                }
            });

            it('will not prune another holder\u2019s document when its own lock has been taken', async () => {
                const stateFilePath = statePathFor();
                const lockFilePath = `${stateFilePath}.lock`;
                const ledger = fileLedgerOver(stateFilePath);

                // Two stamps, the older of which has aged out by the instant the
                // reservation below reads it while the newer still fills the
                // window — so the reservation refuses AND wants to persist the
                // pruning.
                writeStateDocument(stateFilePath, {
                    version: USDA_RATE_LEDGER_STATE_VERSION,
                    scope: TEST_SCOPE,
                    attempts: [T0, T0 + 1],
                });

                const actualReadFileSync = fs.readFileSync;
                const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                    target: Parameters<typeof fs.readFileSync>[0],
                    options?: Parameters<typeof fs.readFileSync>[1],
                ) => {
                    if (target === lockFilePath) {
                        return 'usda-rate-ledger.999999.3.foreign\n';
                    }

                    return actualReadFileSync(target, options);
                }) as typeof fs.readFileSync);

                try {
                    const thrown = await reserveOnce(ledger, T0 + RATE_WINDOW_MS + 1, 1).catch(
                        (error: unknown) => error,
                    );

                    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                    const failure = thrown as UsdaRateLedgerError;
                    expect(failure.code).toBe('lock_unavailable');
                    expect(failure.message).toContain('before the aged-out stamps were pruned');
                } finally {
                    readFile.mockRestore();
                }

                // The document is untouched: a reservation that lost the critical
                // section rewrites nothing, not even a prune.
                expect(readStamps(stateFilePath)).toEqual([T0, T0 + 1]);
            });
        });

        // -----------------------------------------------------------------------
        // The ownership verdict every decision about the lock is made on.
        // -----------------------------------------------------------------------

        describe('ledgerLockOwnership', () => {
            const TOKEN = 'usda-rate-ledger.4242.1700000000000.k3j4h5';

            it('reads an unchanged token as still held, trailing newline included', () => {
                expect(ledgerLockOwnership(TOKEN, TOKEN)).toBe('held');
                expect(ledgerLockOwnership(`${TOKEN}\n`, TOKEN)).toBe('held');
                expect(ledgerLockOwnership(`  ${TOKEN}  `, `${TOKEN}\n`)).toBe('held');
            });

            it('reads a missing lock file as released', () => {
                expect(ledgerLockOwnership(null, TOKEN)).toBe('released');
            });

            it('reads any other token as reacquired by somebody else', () => {
                expect(ledgerLockOwnership(`${TOKEN}x`, TOKEN)).toBe('reacquired');
                expect(ledgerLockOwnership('usda-rate-ledger.4243.1700000000000.k3j4h5', TOKEN)).toBe('reacquired');
            });

            it('never reads a blank lock file as ours', () => {
                // A lock whose stamp never landed cannot be mistaken for a
                // reservation's own lock — a minted token is never blank.
                expect(ledgerLockOwnership('', TOKEN)).toBe('reacquired');
                expect(ledgerLockOwnership('\n', TOKEN)).toBe('reacquired');
            });

            it('reads two blank observations as the same lock, so a token-less lock stays breakable', () => {
                expect(ledgerLockOwnership('', '')).toBe('held');
                expect(ledgerLockOwnership('\n', '')).toBe('held');
            });
        });

        // -----------------------------------------------------------------------
        // Fail closed: never an empty ledger, never an unpaced request.
        // -----------------------------------------------------------------------

        describe('state that cannot be trusted', () => {
            const limiterOver = (ledger: UsdaRateLedger): UsdaRateLimiter =>
                createUsdaRateLimiter({
                    requestsPerHour: 5,
                    burstCapacity: 5,
                    now: () => T0,
                    sleep: instantSleep,
                    ledger,
                });

            const expectRefusal = async (
                stateFilePath: string,
                code: string,
                prepare: (target: string) => void,
            ): Promise<UsdaRateLedgerError> => {
                prepare(stateFilePath);

                const limiter = limiterOver(fileLedgerOver(stateFilePath));

                const thrown = await limiter.acquire().then(
                    () => null,
                    (error: unknown) => error,
                );

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                const failure = thrown as UsdaRateLedgerError;
                expect(failure.code).toBe(code);
                expect(failure.name).toBe('UsdaRateLedgerError');
                // The path the operator has to decide about, and what deleting it
                // costs them, are both in the message.
                expect(failure.message).toContain(stateFilePath);
                expect(failure.message).toContain('forfeits');
                expect(failure.stateFilePath).toBe(stateFilePath);
                expect(failure.scope).toBe(TEST_SCOPE);
                // Nothing went out: the request was refused, not admitted unpaced.
                expect(limiter.stats().attempts).toBe(0);

                return failure;
            };

            it('refuses a state file that is not JSON', async () => {
                await expectRefusal(statePathFor(), 'state_unparsable', (target) => {
                    fs.writeFileSync(target, '{ not json', 'utf8');
                });
            });

            it('refuses a state file that is not a JSON object', async () => {
                await expectRefusal(statePathFor(), 'state_unparsable', (target) => {
                    writeStateDocument(target, [T0]);
                });
            });

            it('refuses a state file written by a newer shape version', async () => {
                await expectRefusal(statePathFor(), 'state_version_unsupported', (target) => {
                    writeStateDocument(target, {
                        version: USDA_RATE_LEDGER_STATE_VERSION + 1,
                        scope: TEST_SCOPE,
                        attempts: [],
                    });
                });
            });

            it('refuses a state file scoped to another credential', async () => {
                const failure = await expectRefusal(statePathFor(), 'state_scope_mismatch', (target) => {
                    writeStateDocument(target, {
                        version: USDA_RATE_LEDGER_STATE_VERSION,
                        scope: 'other.key',
                        attempts: [],
                    });
                });

                expect(failure.message).toContain('other.key');
            });

            it('refuses an attempt list that is not all finite numbers', async () => {
                // `null` is what JSON.stringify writes for a NaN, so this is what a
                // corrupted stamp looks like on disk. Dropping it silently would
                // hand back allowance that was already spent.
                await expectRefusal(statePathFor(), 'state_unparsable', (target) => {
                    writeStateDocument(target, {
                        version: USDA_RATE_LEDGER_STATE_VERSION,
                        scope: TEST_SCOPE,
                        attempts: [T0, null],
                    });
                });
            });

            it('refuses a state file carrying no scope', async () => {
                await expectRefusal(statePathFor(), 'state_unparsable', (target) => {
                    writeStateDocument(target, { version: USDA_RATE_LEDGER_STATE_VERSION, attempts: [] });
                });
            });

            it('refuses a state directory that cannot be created', async () => {
                const blocker = path.join(workspace, 'not-a-directory');
                fs.writeFileSync(blocker, 'in the way', 'utf8');

                await expectRefusal(path.join(blocker, 'ledger.json'), 'state_directory_unusable', () => undefined);
            });

            it('refuses a state file that exists but cannot be read', async () => {
                const stateFilePath = statePathFor();
                writeStateDocument(stateFilePath, {
                    version: USDA_RATE_LEDGER_STATE_VERSION,
                    scope: TEST_SCOPE,
                    attempts: [],
                });

                // Scoped to the ledger's own file: a blanket failure would also
                // break whatever else reads a file during the test.
                const actualReadFileSync = fs.readFileSync;
                const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                    target: Parameters<typeof fs.readFileSync>[0],
                    options?: Parameters<typeof fs.readFileSync>[1],
                ) => {
                    if (target === stateFilePath) {
                        throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
                    }

                    return actualReadFileSync(target, options);
                }) as typeof fs.readFileSync);

                try {
                    await expectRefusal(stateFilePath, 'state_unreadable', () => undefined);
                } finally {
                    readFile.mockRestore();
                }
            });

            it('treats an absent state file as a first run rather than a failure', async () => {
                const stateFilePath = statePathFor();
                const limiter = limiterOver(fileLedgerOver(stateFilePath));

                await expect(limiter.acquire()).resolves.toBeUndefined();
                expect(limiter.stats().attempts).toBe(1);
                expect(readStamps(stateFilePath)).toEqual([T0]);
            });
        });

        // -----------------------------------------------------------------------
        // Durability of the write itself.
        // -----------------------------------------------------------------------

        describe('the state write', () => {
            it('writes a temp file in the same directory and renames it over the state file', async () => {
                const stateFilePath = statePathFor();
                const writeFile = jest.spyOn(fs, 'writeFileSync');
                const rename = jest.spyOn(fs, 'renameSync');

                try {
                    await reserveOnce(fileLedgerOver(stateFilePath), T0, 2);

                    // The first write of the reservation is the lock stamp, and it
                    // goes to a DESCRIPTOR rather than a path — which is what
                    // keeps it from ever landing in another holder's lock file.
                    expect(typeof writeFile.mock.calls[0]?.[0]).toBe('number');

                    const pathWrites = writeFile.mock.calls
                        .map((call) => call[0])
                        .filter((target): target is string => typeof target === 'string');
                    const writtenPath = String(pathWrites[0]);

                    expect(path.dirname(writtenPath)).toBe(path.dirname(stateFilePath));
                    expect(path.basename(writtenPath).startsWith(`${path.basename(stateFilePath)}.`)).toBe(true);
                    expect(writtenPath.endsWith('.tmp')).toBe(true);
                    expect(rename.mock.calls).toEqual([[writtenPath, stateFilePath]]);
                    // The state file itself is never written in place, so no reader
                    // can observe a truncated document.
                    expect(writeFile.mock.calls.map((call) => String(call[0]))).not.toContain(stateFilePath);
                } finally {
                    writeFile.mockRestore();
                    rename.mockRestore();
                }
            });

            it('never leaves a state file that fails to parse, at any point in a run', async () => {
                const stateFilePath = statePathFor();
                const limit = 4;
                const ledger = fileLedgerOver(stateFilePath);

                for (let index = 0; index < limit * 2; index += 1) {
                    await reserveOnce(ledger, T0 + index, limit);

                    const document = readStateDocument(stateFilePath);
                    const attempts = document.attempts as number[];

                    expect(document.version).toBe(USDA_RATE_LEDGER_STATE_VERSION);
                    expect(document.scope).toBe(TEST_SCOPE);
                    expect(attempts.every((stamp) => Number.isFinite(stamp))).toBe(true);
                    expect(attempts.length).toBeLessThanOrEqual(limit);
                }

                expect(fs.readdirSync(workspace)).toEqual([path.basename(stateFilePath)]);
            });

            it('leaves the previous document intact and reports the failure when the rename fails', async () => {
                const stateFilePath = statePathFor();
                const ledger = fileLedgerOver(stateFilePath);

                await reserveOnce(ledger, T0, 5);
                const before = readStamps(stateFilePath);

                const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
                    throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
                });

                try {
                    const thrown = await reserveOnce(ledger, T0 + 1, 5).catch((error: unknown) => error);

                    expect(thrown).toBeInstanceOf(UsdaRateLedgerError);
                    expect((thrown as UsdaRateLedgerError).code).toBe('state_write_failed');
                } finally {
                    rename.mockRestore();
                }

                // The previous document survives, the temp file is gone, and the
                // lock was released — so the run is recoverable rather than wedged.
                expect(readStamps(stateFilePath)).toEqual(before);
                expect(fs.readdirSync(workspace)).toEqual([path.basename(stateFilePath)]);
                expect((await reserveOnce(ledger, T0 + 2, 5)).admitted).toBe(true);
            });
        });

        // -----------------------------------------------------------------------
        // The limiter's defaulting and its concurrency.
        // -----------------------------------------------------------------------

        describe('createUsdaRateLimiter', () => {
            it('is durable by default when only a rate and a logger are passed', () => {
                const { logger } = createRecordingLogger();
                const limiter = createUsdaRateLimiter({
                    requestsPerHour: DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR,
                    logger,
                });

                const stats = limiter.stats();

                expect(stats.ledgerKind).toBe('file');
                expect(stats.ledgerScope).toBe(USDA_HOST);
                expect(stats.attemptsInWindow).toBe(0);
                // Every pre-existing field keeps its name and its meaning.
                expect(stats).toMatchObject({
                    configuredPerHour: DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR,
                    vendorCapPerHour: USDA_VENDOR_CAP_PER_HOUR,
                    burstCapacity: DEFAULT_BURST_CAPACITY,
                    attempts: 0,
                    pauses: 0,
                    totalPausedMs: 0,
                    longestPauseMs: 0,
                    firstAttemptAt: null,
                    lastAttemptAt: null,
                });
            });

            it('reports an injected ledger rather than the default', () => {
                const limiter = createUsdaRateLimiter({
                    requestsPerHour: 10,
                    ledger: createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE }),
                });

                expect(limiter.stats().ledgerKind).toBe('process_local');
                expect(limiter.stats().ledgerScope).toBe(TEST_SCOPE);
            });

            it('derives its default state file from the scope alone, wherever it was constructed from', () => {
                const statePath = defaultUsdaRateLedgerStateFilePath('shared.key.usda.invalid');

                // The location of this module, the working directory and the
                // package's `node_modules` are all absent from the derivation —
                // see 'the default configuration' above for why each of them
                // being absent is the requirement rather than an accident.
                expect(statePath).toBe(
                    path.join(defaultUsdaRateLedgerDirectory(), 'usda-rate-ledger.shared.key.usda.invalid.json'),
                );
                expect(statePath).not.toContain(BACKEND_ROOT);
                expect(statePath).not.toContain(path.join(BACKEND_ROOT, 'data'));
                expect(statePath).not.toContain(path.join(BACKEND_ROOT, 'scripts'));
            });

            it('sanitises a scope into the state file name so it cannot steer the path', () => {
                const statePath = defaultUsdaRateLedgerStateFilePath('../../etc/passwd');

                expect(path.dirname(statePath)).toBe(defaultUsdaRateLedgerDirectory());
                // Every path separator is gone, so the scope names a file in the
                // cache directory and cannot climb out of it.
                expect(path.basename(statePath)).toBe('usda-rate-ledger..._.._etc_passwd.json');
                expect(path.basename(statePath)).not.toContain(path.sep);
            });

            it('uses an overridden state file path without an injected ledger', async () => {
                const stateFilePath = statePathFor('overridden.json');
                const limiter = createUsdaRateLimiter({
                    requestsPerHour: 2,
                    burstCapacity: 2,
                    now: () => T0,
                    sleep: instantSleep,
                    ledgerScope: TEST_SCOPE,
                    ledgerStateFilePath: stateFilePath,
                });

                await limiter.acquire();

                expect(limiter.stats().ledgerKind).toBe('file');
                expect(limiter.stats().ledgerScope).toBe(TEST_SCOPE);
                expect(readStamps(stateFilePath)).toEqual([T0]);
            });

            it('serialises concurrent acquisitions so they cannot over-spend the burst', async () => {
                const clock = createClock();
                const { lines, logger } = createRecordingLogger();
                const reserveOrder: number[] = [];
                const inner = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });

                // A ledger that yields to the event loop before answering, which is
                // what a durable one does on every reservation. Without the FIFO
                // queue all three callers would clear the two-token bucket check
                // before any of them had spent a token.
                const ledger: UsdaRateLedger = {
                    reserve: async (input) => {
                        await Promise.resolve();
                        const reservation = await inner.reserve(input);
                        reserveOrder.push(reservation.attemptsInWindow);

                        return reservation;
                    },
                    describe: () => inner.describe(),
                };

                const limiter = createUsdaRateLimiter({
                    requestsPerHour: 900,
                    burstCapacity: 2,
                    now: clock.read,
                    sleep: clock.sleep,
                    logger,
                    ledger,
                });

                await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

                const expectedBurstWaitMs = waitMsForToken(
                    { tokens: 0, lastRefillMs: T0 },
                    T0,
                    900 / RATE_WINDOW_MS,
                    2,
                );

                expect(limiter.stats().attempts).toBe(3);
                expect(reserveOrder).toEqual([1, 2, 3]);
                // The third acquisition found the bucket empty and waited for a
                // token instead of borrowing one that did not exist.
                expect(limiter.stats().pauses).toBe(1);
                expect(clock.sleeps).toEqual([expectedBurstWaitMs]);

                const pauses = lines.filter((line) => line.event === 'usda_rate_limit_pause');
                expect(pauses).toHaveLength(1);
                expect(pauses[0]?.fields.reason).toBe('burst');
                expect(pauses[0]?.fields.waitMs).toBe(expectedBurstWaitMs);
            });

            it('pauses on the burst first and then the hourly ceiling, and keeps waiting rather than failing', async () => {
                const clock = createClock();
                const { lines, logger } = createRecordingLogger();
                const limiter = createUsdaRateLimiter({
                    requestsPerHour: 2,
                    burstCapacity: 2,
                    now: clock.read,
                    sleep: clock.sleep,
                    logger,
                    ledger: fileLedgerOver(statePathFor()),
                });

                await limiter.acquire();
                await limiter.acquire();
                await limiter.acquire();

                const burstWaitMs = waitMsForToken({ tokens: 0, lastRefillMs: T0 }, T0, 2 / RATE_WINDOW_MS, 2);
                const pauses = lines.filter((line) => line.event === 'usda_rate_limit_pause');

                // The bucket is checked first, so the third request waits for a
                // token, then for the hour, then for the one millisecond the
                // inclusive far boundary withholds. It is never refused.
                expect(pauses.map((pause) => [pause.fields.reason, pause.fields.waitMs])).toEqual([
                    ['burst', burstWaitMs],
                    ['hourly_ceiling', RATE_WINDOW_MS - burstWaitMs],
                    ['hourly_ceiling', 1],
                ]);
                expect(pauses[1]?.fields.attemptsInWindow).toBe(2);
                expect(limiter.stats().attempts).toBe(3);
                expect(limiter.stats().pauses).toBe(3);
                expect(limiter.stats().totalPausedMs).toBe(RATE_WINDOW_MS + 1);
                expect(clock.read()).toBe(T0 + RATE_WINDOW_MS + 1);
            });

            it('lets a later acquisition succeed after one failed on the ledger', async () => {
                let failNext = true;
                const inner = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });
                const ledger: UsdaRateLedger = {
                    reserve: async (input) => {
                        if (failNext) {
                            failNext = false;
                            throw new UsdaRateLedgerError('state_unparsable', 'corrupt', statePathFor(), TEST_SCOPE);
                        }

                        return inner.reserve(input);
                    },
                    describe: () => inner.describe(),
                };

                const limiter = createUsdaRateLimiter({
                    requestsPerHour: 5,
                    burstCapacity: 5,
                    now: () => T0,
                    sleep: instantSleep,
                    ledger,
                });

                await expect(limiter.acquire()).rejects.toBeInstanceOf(UsdaRateLedgerError);
                // The queue must not carry one caller's rejection to the next.
                await expect(limiter.acquire()).resolves.toBeUndefined();
                expect(limiter.stats().attempts).toBe(1);
            });

            it('does not spin when an injected ledger refuses without a usable wait', async () => {
                const clock = createClock();
                let refusals = 0;
                const ledger: UsdaRateLedger = {
                    reserve: async () => {
                        refusals += 1;

                        return refusals > 2
                            ? { admitted: true, waitMs: 0, attemptsInWindow: refusals }
                            : { admitted: false, waitMs: Number.NaN, attemptsInWindow: refusals };
                    },
                    describe: () => ({ kind: 'database', scope: TEST_SCOPE }),
                };

                const limiter = createUsdaRateLimiter({
                    requestsPerHour: 900,
                    burstCapacity: 20,
                    now: clock.read,
                    sleep: clock.sleep,
                    ledger,
                });

                await limiter.acquire();

                expect(clock.sleeps).toEqual([1, 1]);
                expect(limiter.stats().attempts).toBe(1);
                expect(limiter.stats().ledgerKind).toBe('database');
            });
        });

        // -----------------------------------------------------------------------
        // Regression cover for what must not change.
        // -----------------------------------------------------------------------

        describe('what the CLI scripts already depend on', () => {
            const originalFetch = globalThis.fetch;

            afterEach(() => {
                globalThis.fetch = originalFetch;
            });

            const installedLimiter = (): { limiter: UsdaRateLimiter; transport: jest.Mock } => {
                const transport = jest.fn(async () => ({ ok: true }) as unknown as Response);
                globalThis.fetch = transport as unknown as typeof globalThis.fetch;

                return {
                    limiter: createUsdaRateLimiter({
                        requestsPerHour: 10,
                        burstCapacity: 10,
                        now: () => T0,
                        sleep: instantSleep,
                        ledger: createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE }),
                    }),
                    transport,
                };
            };

            it('passes non-USDA traffic through unpaced and with no stats movement', async () => {
                const { limiter, transport } = installedLimiter();
                const restore = limiter.install();

                try {
                    await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions');
                    await globalThis.fetch('https://pubmed.ncbi.nlm.nih.gov/12345678/');

                    expect(transport).toHaveBeenCalledTimes(2);
                    expect(limiter.stats().attempts).toBe(0);
                    expect(limiter.stats().attemptsInWindow).toBe(0);
                    expect(limiter.stats().pauses).toBe(0);

                    await globalThis.fetch(`https://${USDA_HOST}/fdc/v1/foods/search?query=egg`);

                    expect(limiter.stats().attempts).toBe(1);
                    expect(limiter.stats().attemptsInWindow).toBe(1);
                } finally {
                    restore();
                }
            });

            it('treats a second install as the same installation', async () => {
                const { limiter } = installedLimiter();
                const restore = limiter.install();
                const wrapper = globalThis.fetch;

                try {
                    expect(limiter.install()).toBe(restore);
                    expect(globalThis.fetch).toBe(wrapper);

                    await globalThis.fetch(`https://${USDA_HOST}/fdc/v1/food/12345`);

                    // One token per request, not two: a wrapped wrapper would have
                    // silently halved the configured rate.
                    expect(limiter.stats().attempts).toBe(1);
                } finally {
                    restore();
                }
            });

            it('restores ownership-safely when something else owns fetch', () => {
                const { limiter, transport } = installedLimiter();
                const restore = limiter.install();
                const wrapper = globalThis.fetch;
                const foreign = jest.fn(async () => ({ ok: true }) as unknown as Response);

                globalThis.fetch = foreign as unknown as typeof globalThis.fetch;
                restore();
                expect(globalThis.fetch).toBe(foreign);

                // Once the newer owner steps down, a later restore still succeeds.
                globalThis.fetch = wrapper;
                restore();
                expect(globalThis.fetch).toBe(transport);
            });

            it('matches the paced host the way it always has', () => {
                expect(isUsdaRequestUrl(`https://${USDA_HOST}/fdc/v1/foods`)).toBe(true);
                expect(isUsdaRequestUrl(`https://${USDA_HOST.toUpperCase()}./fdc/v1/foods`)).toBe(true);
                expect(isUsdaRequestUrl(new URL(`https://${USDA_HOST}/fdc/v1/foods`))).toBe(true);
                expect(isUsdaRequestUrl({ url: `https://${USDA_HOST}/fdc/v1/foods` })).toBe(true);
                expect(isUsdaRequestUrl('https://api.nal.usda.gov.evil.test/fdc/v1/foods')).toBe(false);
                expect(isUsdaRequestUrl('not a url')).toBe(false);
                expect(isUsdaRequestUrl(null)).toBe(false);
            });

            it('reads the documented rate forms and refuses the rest', () => {
                expect(getUsdaImportRateLimitPerHour({})).toBe(DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR);
                expect(getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: '  ' })).toBe(
                    DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR,
                );
                expect(getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: '450' })).toBe(450);
                // The ceiling is the IMPORT's, not the vendor's: exactly 900 is
                // the most this stage may ask for.
                expect(
                    getUsdaImportRateLimitPerHour({
                        USDA_IMPORT_RATE_LIMIT_PER_HOUR: `${USDA_IMPORT_POLICY_CAP_PER_HOUR}`,
                    }),
                ).toBe(USDA_IMPORT_POLICY_CAP_PER_HOUR);

                // 901-1,000 is legal for USDA and illegal here: the top 100/hour
                // are the running API's share of the same key (AAP §0.7.1
                // Group 1), so accepting them would remove the headroom this
                // number exists to reserve.
                for (const raw of [
                    '0',
                    '-1',
                    '901',
                    `${USDA_VENDOR_CAP_PER_HOUR}`,
                    '1001',
                    '1e3',
                    '0x10',
                    '+7',
                    '8.',
                    '\u00a0900',
                    'many',
                ]) {
                    expect(() => getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: raw })).toThrow(
                        RateLimitConfigError,
                    );
                }
            });

            it('names both numbers and the reason when it refuses a rate above the ceiling', () => {
                // The message is what an operator acts on, so it has to say
                // which bound was broken and why it exists — a bare "invalid"
                // sends them back to the vendor's 1,000.
                let caught: RateLimitConfigError | null = null;
                try {
                    getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: '1000' });
                } catch (error) {
                    caught = error as RateLimitConfigError;
                }

                expect(caught).toBeInstanceOf(RateLimitConfigError);
                expect(caught?.message).toContain(`${USDA_IMPORT_POLICY_CAP_PER_HOUR}`);
                expect(caught?.message).toContain(`${USDA_VENDOR_CAP_PER_HOUR}`);
                expect(caught?.message).toContain('reserved');
                // The violated bound travels on the error, so a caller can
                // report it without re-parsing the message.
                expect(caught?.vendorCapPerHour).toBe(USDA_IMPORT_POLICY_CAP_PER_HOUR);
            });

            it('still refuses a configuration it cannot honour', () => {
                const ledger = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });

                expect(() => createUsdaRateLimiter({ requestsPerHour: 0, ledger })).toThrow(RateLimitConfigError);
                expect(() => createUsdaRateLimiter({ requestsPerHour: 1.5, ledger })).toThrow(RateLimitConfigError);
                expect(() => createUsdaRateLimiter({ requestsPerHour: USDA_VENDOR_CAP_PER_HOUR + 1, ledger })).toThrow(
                    RateLimitConfigError,
                );
                // The limiter is the second gate on the import ceiling, so a
                // rate the env getter would have refused is refused here too —
                // including the whole 901-1,000 band the vendor allows.
                expect(
                    () => createUsdaRateLimiter({ requestsPerHour: USDA_IMPORT_POLICY_CAP_PER_HOUR + 1, ledger }),
                ).toThrow(RateLimitConfigError);
                expect(() => createUsdaRateLimiter({ requestsPerHour: USDA_VENDOR_CAP_PER_HOUR, ledger })).toThrow(
                    RateLimitConfigError,
                );
                // And a caller cannot raise the ceiling by declaring a higher
                // one: the option exists to pace SLOWER.
                expect(
                    () =>
                        createUsdaRateLimiter({
                            requestsPerHour: 950,
                            policyCapPerHour: USDA_VENDOR_CAP_PER_HOUR,
                            ledger,
                        }),
                ).toThrow(RateLimitConfigError);
                // Lowering it is honoured, and reported.
                expect(
                    createUsdaRateLimiter({ requestsPerHour: 100, policyCapPerHour: 200, ledger }).stats()
                        .policyCapPerHour,
                ).toBe(200);
                expect(() => createUsdaRateLimiter({ requestsPerHour: 300, policyCapPerHour: 200, ledger })).toThrow(
                    RateLimitConfigError,
                );
                expect(() => createUsdaRateLimiter({ requestsPerHour: 10, burstCapacity: 11, ledger })).toThrow(
                    RateLimitConfigError,
                );
                expect(() => createUsdaRateLimiter({ requestsPerHour: 10, host: '   ', ledger })).toThrow(
                    RateLimitConfigError,
                );
            });

            it('keeps the exported window and bucket rules unchanged', () => {
                expect(refillBucket({ tokens: 0, lastRefillMs: T0 }, T0 + 1_000, 1 / 1_000, 20)).toEqual({
                    tokens: 1,
                    lastRefillMs: T0 + 1_000,
                });
                expect(waitMsForToken({ tokens: 0, lastRefillMs: T0 }, T0, 1 / 1_000, 20)).toBe(1_000);
                expect(pruneAttemptWindow([T0 - RATE_WINDOW_MS - 1, T0 - RATE_WINDOW_MS, T0], T0, RATE_WINDOW_MS)).toEqual([
                    T0 - RATE_WINDOW_MS,
                    T0,
                ]);
                expect(windowWaitMs([T0], T0, 1, RATE_WINDOW_MS)).toBe(RATE_WINDOW_MS);
                expect(recordAttemptWindow([T0], T0 - 50, RATE_WINDOW_MS)).toEqual([T0, T0]);
            });
        });

        // -----------------------------------------------------------------------
        // The status split the release request ledger quotes.
        //
        // Two things needed direct cover. `usdaStatusClass` is a pure branching
        // rule whose boundaries decide what an operator reads about a run: 400,
        // 408 and 429 are counted EXACTLY and the rest of 4xx together, so a
        // `>= 400` written the wrong way round would file a throttling report
        // as a bad-key report. And the report test above injects an
        // already-populated stats object, so it would pass even if the limiter
        // never incremented a bucket — the counting itself is held here.
        // -----------------------------------------------------------------------

        describe('the status split the request ledger is built from', () => {
            describe('usdaStatusClass', () => {
                it('counts the three transient statuses exactly, never as a range', () => {
                    expect(usdaStatusClass(400)).toBe('retryable400');
                    expect(usdaStatusClass(408)).toBe('timeout408');
                    expect(usdaStatusClass(429)).toBe('throttled429');

                    // Their immediate neighbours are not them. This is the
                    // assertion an off-by-one comparison fails.
                    for (const status of [399, 401, 407, 409, 428, 430]) {
                        expect(['retryable400', 'timeout408', 'throttled429']).not.toContain(
                            usdaStatusClass(status),
                        );
                    }
                });

                it('classes each range at its boundaries', () => {
                    expect(usdaStatusClass(200)).toBe('ok2xx');
                    expect(usdaStatusClass(299)).toBe('ok2xx');
                    // 401/403 is a bad key and 404 a missing id — different
                    // operator actions from a 429, which is why they are apart.
                    expect(usdaStatusClass(401)).toBe('otherClientError');
                    expect(usdaStatusClass(403)).toBe('otherClientError');
                    expect(usdaStatusClass(404)).toBe('otherClientError');
                    expect(usdaStatusClass(499)).toBe('otherClientError');
                    expect(usdaStatusClass(500)).toBe('serverError');
                    expect(usdaStatusClass(503)).toBe('serverError');
                    expect(usdaStatusClass(599)).toBe('serverError');
                    // Still a server answer rather than "unreadable".
                    expect(usdaStatusClass(600)).toBe('serverError');
                });

                it('files 1xx, 3xx and anything unreadable under otherStatus instead of dropping it', () => {
                    for (const status of [100, 199, 300, 302, 399]) {
                        expect(usdaStatusClass(status)).toBe('otherStatus');
                    }

                    // The attempt has already been charged to the hour by the
                    // time this is asked, so a status that is not a finite
                    // number must still land somewhere: dropping it is what
                    // would break the identity the report is checked by.
                    for (const status of [undefined, null, NaN, Infinity, -Infinity, '200', {}, [], true]) {
                        expect(usdaStatusClass(status)).toBe('otherStatus');
                    }
                });
            });

            describe('the limiter counting attempts it actually paced', () => {
                const originalFetch = globalThis.fetch;

                afterEach(() => {
                    globalThis.fetch = originalFetch;
                });

                const usdaUrl = (id: number): string => `https://${USDA_HOST}/fdc/v1/food/${id}`;

                /**
                 * A limiter installed over a transport that answers with the
                 * given statuses in order; an `Error` in the list is a
                 * transport that never produced a response at all.
                 */
                const limiterOver = (
                    ...answers: ReadonlyArray<number | Error>
                ): { limiter: UsdaRateLimiter; transport: jest.Mock } => {
                    const queue = [...answers];
                    const transport = jest.fn(async () => {
                        const answer = queue.shift();
                        if (answer === undefined) {
                            throw new Error('the transport was called more times than it was given answers for');
                        }
                        if (answer instanceof Error) {
                            throw answer;
                        }

                        // Only `status` is read by the accounting, so only
                        // `status` is offered: a stub that also carried a body
                        // would let a body-reading regression pass unnoticed.
                        return { status: answer } as unknown as Response;
                    });
                    globalThis.fetch = transport as unknown as typeof globalThis.fetch;

                    return {
                        limiter: createUsdaRateLimiter({
                            requestsPerHour: 20,
                            burstCapacity: 20,
                            now: () => T0,
                            sleep: instantSleep,
                            ledger: createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE }),
                        }),
                        transport,
                    };
                };

                it('charges every answered attempt to exactly one bucket', async () => {
                    const { limiter } = limiterOver(200, 204, 400, 408, 429, 429, 404, 500, 302);
                    const restore = limiter.install();

                    try {
                        for (let index = 0; index < 9; index += 1) {
                            await globalThis.fetch(usdaUrl(index));
                        }

                        const stats = limiter.stats();

                        expect(stats.statusClassCounts).toEqual({
                            ok2xx: 2,
                            retryable400: 1,
                            timeout408: 1,
                            throttled429: 2,
                            otherClientError: 1,
                            serverError: 1,
                            otherStatus: 1,
                        });
                        expect(stats.transportFailures).toBe(0);
                        expect(stats.attempts).toBe(9);
                    } finally {
                        restore();
                    }
                });

                it('counts a transport that never answered, and rethrows it unchanged', async () => {
                    const outage = new Error('socket hang up');
                    const { limiter } = limiterOver(200, 429, outage, 503);
                    const restore = limiter.install();

                    try {
                        await globalThis.fetch(usdaUrl(1));
                        await globalThis.fetch(usdaUrl(2));
                        // The SAME error object, not a wrapped or reshaped one:
                        // usda.service.ts decides what a failure means, and an
                        // error rebuilt here would change that decision (§9).
                        await expect(globalThis.fetch(usdaUrl(3))).rejects.toBe(outage);
                        await globalThis.fetch(usdaUrl(4));

                        const stats = limiter.stats();

                        expect(stats.transportFailures).toBe(1);
                        expect(stats.attempts).toBe(4);
                        // The identity the committed report is checked by.
                        const summed =
                            Object.values(stats.statusClassCounts).reduce((total, count) => total + count, 0) +
                            stats.transportFailures;
                        expect(summed).toBe(stats.attempts);
                    } finally {
                        restore();
                    }
                });

                it('moves no bucket for traffic it does not pace', async () => {
                    const { limiter } = limiterOver(200, 500);
                    const restore = limiter.install();

                    try {
                        await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions');

                        const stats = limiter.stats();

                        expect(stats.attempts).toBe(0);
                        expect(stats.transportFailures).toBe(0);
                        expect(Object.values(stats.statusClassCounts).every((count) => count === 0)).toBe(true);
                    } finally {
                        restore();
                    }
                });

                it('hands back a copy of the counters rather than the live ones', async () => {
                    const { limiter } = limiterOver(200, 200);
                    const restore = limiter.install();

                    try {
                        await globalThis.fetch(usdaUrl(1));

                        const first = limiter.stats().statusClassCounts;

                        // A fresh object each call, and a caller that writes to
                        // what it was given cannot alter what the run then
                        // reports about itself — the importer spreads this
                        // straight into a committed artefact.
                        expect(limiter.stats().statusClassCounts).not.toBe(first);
                        first.ok2xx = 999;

                        await globalThis.fetch(usdaUrl(2));

                        expect(limiter.stats().statusClassCounts.ok2xx).toBe(2);
                    } finally {
                        restore();
                    }
                });
            });
        });

        // -----------------------------------------------------------------------
        // The suite's own guard. The default ledger directory is HOST-scoped, so
        // it is shared with every other checkout's suite and with any real
        // importer on the machine: a test given a `stateFilePath` must write
        // nowhere else, and the tests that do use the default path must confine
        // themselves to their own run-unique scope (they clean up after
        // themselves in 'the default configuration' above).
        // -----------------------------------------------------------------------

        describe('the suite itself', () => {
            it('creates no ledger state outside the path it was given', async () => {
                const stateFilePath = statePathFor();
                const sharedStatePath = defaultUsdaRateLedgerStateFilePath();
                // Existence, not absence: this is a shared directory, so the
                // assertion is that the reservation below did not CHANGE what is
                // in it — a real importer's ledger may legitimately be there.
                const sharedStateExisted = fs.existsSync(sharedStatePath);
                fs.mkdirSync(path.join(workspace, 'nested'));

                await reserveOnce(fileLedgerOver(stateFilePath), T0, 1);

                expect(fs.readdirSync(workspace).sort()).toEqual(['ledger.json', 'nested']);
                expect(fs.existsSync(sharedStatePath)).toBe(sharedStateExisted);
                expect(fs.existsSync(`${sharedStatePath}.lock`)).toBe(false);
            });

            it('leaves nothing of its own behind in the shared default directory', () => {
                const directory = defaultUsdaRateLedgerDirectory();

                if (!fs.existsSync(directory)) {
                    // Nothing in this suite has had to create it, which is itself
                    // the guarantee being asserted.
                    return;
                }

                // Every file this suite writes there carries the `.test.invalid`
                // scope suffix `uniqueLedgerScope` appends, and every test that
                // writes one removes it. Anything left would be leakage into a
                // directory other processes on this host read.
                expect(fs.readdirSync(directory).filter((entry) => entry.includes('.test.invalid'))).toEqual([]);
            });
        });
    });
});

/**
 * THE TWO VERSION COUNTERS ON A CATALOG FOOD.
 *
 * `recipe_ingredients` freezes `snapshot_per_100g`, `snapshot_name`,
 * `snapshot_provenance`, `snapshot_allergen_tags` and `snapshot_diet_tags`
 * beside the two counters they were taken at, and
 * `src/services/recipe.logic.ts::isIngredientSnapshotStale` decides staleness by
 * comparing BOTH counters for inequality — nothing compares the values. So a
 * counter the import resets, or fails to move when its facts moved, is the
 * difference between a published recipe noticing that an ingredient's nutrition
 * or allergen set has changed and going on claiming the old one.
 *
 * The decision is pure, so the sets are pinned here with no database; the two
 * cases that need the WRITE — that the update branch writes the computed
 * counter rather than a literal, and that a field outside both sets moves
 * neither — go through `persistPreparedFood` against a fake `ImportDb`, which is
 * the seam this suite's charter names for upsert-vs-insert wiring.
 */
const versionedFacts = (overrides: Partial<StoredVersionedFacts> = {}): StoredVersionedFacts => ({
    nutrition_version: 1,
    metadata_version: 1,
    calories: 165,
    protein_g: 31,
    carbs_g: 0,
    fat_g: 3.6,
    fiber_g: null,
    nutrition_basis: 'per_100g',
    basis_amount: 100,
    density_g_per_ml: null,
    nutrition_provenance: 'source_backed',
    usda_fdc_id: 171077,
    usda_data_type: 'SR Legacy',
    source_version: 'SR Legacy 2019-04',
    canonical_name: 'chicken breast',
    display_name: 'Chicken breast',
    food_group: 'poultry',
    allergen_status: 'known',
    allergen_tags: [],
    diet_tags: ['omnivore'],
    ...overrides,
});

describe('nextCatalogFoodVersions', () => {
    it('starts a new source_key at 1 on both counters', () => {
        expect(nextCatalogFoodVersions(null, versionedFacts())).toEqual({
            nutritionVersion: 1,
            metadataVersion: 1,
            nutritionChanged: false,
            metadataChanged: false,
        });
    });

    it('preserves both stored counters when a rerun changes nothing', () => {
        // The defect this finding names: the import wrote `nutrition_version: 1`
        // unconditionally, so this row came back from a no-op rerun at 1 and
        // every recipe snapshot citing 3 silently read as current again.
        const stored = versionedFacts({ nutrition_version: 3, metadata_version: 2 });

        expect(nextCatalogFoodVersions(stored, versionedFacts())).toEqual({
            nutritionVersion: 3,
            metadataVersion: 2,
            nutritionChanged: false,
            metadataChanged: false,
        });
    });

    describe('the nutrition set moves nutrition_version and leaves metadata_version alone', () => {
        const changes: ReadonlyArray<readonly [string, Partial<StoredVersionedFacts>]> = [
            ['calories', { calories: 166 }],
            ['protein_g', { protein_g: 30 }],
            ['carbs_g', { carbs_g: 1 }],
            ['fat_g', { fat_g: 3.7 }],
            ['fiber_g', { fiber_g: 2 }],
            ['nutrition_basis', { nutrition_basis: 'per_100ml' }],
            ['basis_amount', { basis_amount: 50 }],
            ['density_g_per_ml', { density_g_per_ml: 1.03 }],
            ['nutrition_provenance', { nutrition_provenance: 'ingredient_derived' }],
            ['usda_fdc_id', { usda_fdc_id: 171078 }],
            ['usda_data_type', { usda_data_type: 'Foundation' }],
            ['source_version', { source_version: 'SR Legacy 2021-10' }],
        ];

        it.each(changes)('bumps on a changed %s', (_field, change) => {
            const stored = versionedFacts({ nutrition_version: 4, metadata_version: 2 });

            expect(nextCatalogFoodVersions(stored, versionedFacts(change))).toEqual({
                nutritionVersion: 5,
                metadataVersion: 2,
                nutritionChanged: true,
                metadataChanged: false,
            });
        });
    });

    describe('the metadata set moves metadata_version and leaves nutrition_version alone', () => {
        const changes: ReadonlyArray<readonly [string, Partial<StoredVersionedFacts>]> = [
            ['canonical_name', { canonical_name: 'chicken breast, skinless' }],
            // The omission the finding names by itself: a recipe's
            // `snapshot_name` freezes the displayed name, so a renamed food
            // whose counter never moved left every recipe showing the old one.
            ['display_name', { display_name: 'Chicken breast, skinless' }],
            ['food_group', { food_group: 'meat' }],
            ['allergen_status', { allergen_status: 'unknown' }],
            ['allergen_tags', { allergen_tags: ['milk'] }],
            ['diet_tags', { diet_tags: ['omnivore', 'gluten_free'] }],
        ];

        it.each(changes)('bumps on a changed %s', (_field, change) => {
            const stored = versionedFacts({ nutrition_version: 4, metadata_version: 2 });

            expect(nextCatalogFoodVersions(stored, versionedFacts(change))).toEqual({
                nutritionVersion: 4,
                metadataVersion: 3,
                nutritionChanged: false,
                metadataChanged: true,
            });
        });
    });

    it('treats an absent fact and a stored NULL as the same value', () => {
        // `fiber_g` is written as `?? null` and a caller that has no value for a
        // fact omits it. Reading those as different would bump both counters on
        // every rerun, which is the same defect from the other direction.
        const stored = versionedFacts({ nutrition_version: 7, metadata_version: 5, fiber_g: null });
        const next = { ...versionedFacts(), fiber_g: undefined };

        expect(nextCatalogFoodVersions(stored, next)).toMatchObject({
            nutritionVersion: 7,
            metadataVersion: 5,
        });
    });

    it('ignores the order the vendor returned a tag list in', () => {
        const stored = versionedFacts({
            nutrition_version: 2,
            metadata_version: 2,
            allergen_tags: ['milk', 'soy'],
            diet_tags: ['omnivore', 'gluten_free'],
        });
        const next = versionedFacts({ allergen_tags: ['soy', 'milk'], diet_tags: ['gluten_free', 'omnivore'] });

        expect(nextCatalogFoodVersions(stored, next)).toMatchObject({
            nutritionVersion: 2,
            metadataVersion: 2,
            nutritionChanged: false,
            metadataChanged: false,
        });
    });

    it('moves both counters when both sets moved', () => {
        const stored = versionedFacts({ nutrition_version: 2, metadata_version: 9 });
        const next = versionedFacts({ calories: 180, display_name: 'Chicken breast, raw' });

        expect(nextCatalogFoodVersions(stored, next)).toEqual({
            nutritionVersion: 3,
            metadataVersion: 10,
            nutritionChanged: true,
            metadataChanged: true,
        });
    });

    it('reads a counter the column never held as 1 rather than as zero', () => {
        // The columns are NOT NULL, so this is a hand-loaded or pre-column row.
        // Treating a missing counter as 0 would renumber a snapshot that already
        // cites 1 and make it read as current.
        const stored = versionedFacts({ nutrition_version: null, metadata_version: undefined });

        expect(nextCatalogFoodVersions(stored, versionedFacts({ calories: 200 }))).toMatchObject({
            nutritionVersion: 2,
            metadataVersion: 1,
        });
    });
});

describe('persistPreparedFood writes the counters the comparison decided', () => {
    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };
    const base = curatedEntries[0] as UsdaManifestFood & { fdcId: number };
    const fetchedAt = new Date('2026-09-14T08:30:00.000Z');

    const preparedFood = (cacheKeySuffix = ''): PreparedCatalogFood =>
        prepareCatalogFood(
            detailFor(base),
            { kind: 'curated', entry: base },
            manifest,
            fetchedAt,
            { ...retrieval([base.fdcId]), cacheKey: `${retrieval([base.fdcId]).cacheKey}${cacheKeySuffix}` },
        );

    type StoredFoodRow = { id: string; imported_at: Date | null } & StoredVersionedFacts;

    interface RecordedWrite {
        readonly kind: 'create' | 'update';
        readonly data: Record<string, unknown>;
    }

    /**
     * A fake `ImportDb` that records what the upsert was handed.
     *
     * The write is the only observable this case has: the counters are computed
     * from the stored row and written inside the transaction, so what proves the
     * update branch no longer writes a literal is the `data` it passed.
     */
    const recordingDb = (existing: StoredFoodRow | null): { db: ImportDb; writes: RecordedWrite[] } => {
        const writes: RecordedWrite[] = [];
        const db: ImportDb = {
            catalog_foods: {
                findUnique: async () => existing,
                create: async (args: unknown) => {
                    writes.push({ kind: 'create', data: (args as { data: Record<string, unknown> }).data });
                    return { id: 'food-1' };
                },
                update: async (args: unknown) => {
                    writes.push({ kind: 'update', data: (args as { data: Record<string, unknown> }).data });
                    return { id: existing?.id ?? 'food-1' };
                },
            },
            catalog_food_aliases: {
                deleteMany: async () => ({ count: 0 }),
                createMany: async () => ({ count: 0 }),
            },
            catalog_food_portions: {
                deleteMany: async () => ({ count: 0 }),
                createMany: async () => ({ count: 0 }),
            },
            catalog_validation_records: {
                upsert: async () => ({ id: 'record-1' }),
            },
            $transaction: async (work) => work(db),
        };

        return { db, writes };
    };

    const persist = async (existing: StoredFoodRow | null, prepared = preparedFood()): Promise<RecordedWrite> => {
        const { db, writes } = recordingDb(existing);
        const verdict = validateCatalogCandidate(prepared.candidate, policy);
        await persistPreparedFood(db, prepared, verdict, importPublicationStatus(prepared, verdict), fetchedAt);

        expect(writes).toHaveLength(1);
        return writes[0];
    };

    /** The stored row this food would have produced, at the counters given. */
    const storedFrom = (
        prepared: PreparedCatalogFood,
        nutritionVersion: number,
        metadataVersion: number,
    ): StoredFoodRow => ({
        id: 'food-1',
        imported_at: new Date('2026-09-01T00:00:00.000Z'),
        nutrition_version: nutritionVersion,
        metadata_version: metadataVersion,
        calories: prepared.candidate.calories,
        protein_g: prepared.candidate.protein_g,
        carbs_g: prepared.candidate.carbs_g,
        fat_g: prepared.candidate.fat_g,
        fiber_g: prepared.candidate.fiber_g ?? null,
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        density_g_per_ml: null,
        nutrition_provenance: 'source_backed',
        usda_fdc_id: prepared.fdcId,
        usda_data_type: prepared.row.usda_data_type,
        source_version: prepared.row.source_version,
        canonical_name: prepared.row.canonical_name,
        display_name: prepared.row.display_name,
        food_group: prepared.row.food_group,
        allergen_status: prepared.candidate.allergen_status,
        allergen_tags: prepared.candidate.allergen_tags ?? [],
        diet_tags: prepared.row.diet_tags,
    });

    it('creates a new food at 1 on both counters, with imported_at', async () => {
        const write = await persist(null);

        expect(write.kind).toBe('create');
        expect(write.data).toMatchObject({ nutrition_version: 1, metadata_version: 1, imported_at: fetchedAt });
    });

    /**
     * A record whose retrieval carried no observed HTTP status is held, however
     * clean its nutrient checks are.
     *
     * The status is a mandatory field of a retrieval record (AAP §0.3.2) and
     * §0.7.3 classes missing identity evidence as quarantine-tier, so
     * publishing such a record is the defect that put a null on all 11,046
     * released validation records. `usda.service.ts` re-fetches a pre-ledger
     * cache row rather than replaying it, so this should be unreachable — which
     * is exactly why it is enforced at the point of publication instead of
     * being assumed from the vendor boundary's current behaviour.
     */
    it('holds a record whose retrieval carried no status, instead of publishing it', async () => {
        const withoutStatus = prepareCatalogFood(
            detailFor(base),
            { kind: 'curated', entry: base },
            manifest,
            fetchedAt,
            { ...retrieval([base.fdcId]), httpStatus: null },
        );
        const statusBearing = preparedFood();
        const verdict = validateCatalogCandidate(statusBearing.candidate, policy);

        // ONE verdict, TWO records differing only in the retrieval status, so
        // the refusal can come from nothing but the retrieval. The same food
        // with a status is not held; without one it is.
        expect(withoutStatus.candidate).toEqual(statusBearing.candidate);
        expect(importEvidenceAssessment(statusBearing).complete).toBe(true);
        expect(importPublicationStatus(statusBearing, verdict)).not.toBe('quarantined');

        expect(evidenceGapCodes(importEvidenceAssessment(withoutStatus))).toEqual(['retrieval_status_missing']);
        expect(importPublicationStatus(withoutStatus, verdict)).toBe('quarantined');

        const write = await persist(null, withoutStatus);

        expect(write.data).toMatchObject({ publication_status: 'quarantined' });
    });

    it('preserves both counters on a rerun that changed nothing', async () => {
        const prepared = preparedFood();
        const write = await persist(storedFrom(prepared, 4, 3), prepared);

        expect(write.kind).toBe('update');
        expect(write.data).toMatchObject({ nutrition_version: 4, metadata_version: 3 });
        // `imported_at` is an insert-only column: rewriting it would change an
        // exported release's bytes on a rerun that changed nothing.
        expect(write.data).not.toHaveProperty('imported_at');
    });

    it('bumps nutrition_version alone when the stored nutrients differ', async () => {
        const prepared = preparedFood();
        const stored = { ...storedFrom(prepared, 4, 3), calories: 999 };

        expect((await persist(stored, prepared)).data).toMatchObject({ nutrition_version: 5, metadata_version: 3 });
    });

    it('bumps metadata_version alone when the stored display name differs', async () => {
        const prepared = preparedFood();
        const stored = { ...storedFrom(prepared, 4, 3), display_name: 'An older label' };

        expect((await persist(stored, prepared)).data).toMatchObject({ nutrition_version: 4, metadata_version: 3 + 1 });
    });

    it('moves neither counter when only the response cache key differs', async () => {
        // source_cache_key names the batch response this row was read out of.
        // Re-fetching the same food in a differently composed batch changes it
        // and changes no snapshot value, so versioning on it would version the
        // catalog by how the import grouped its requests.
        const prepared = preparedFood('#regrouped');
        const stored = storedFrom(preparedFood(), 6, 6);

        const write = await persist(stored, prepared);

        expect(write.data).toMatchObject({ nutrition_version: 6, metadata_version: 6 });
        // The new key IS written — the fact is stored, it is simply not
        // evidence that a frozen snapshot has stopped describing this food. It
        // is also not a field the comparison can even be handed: it is absent
        // from `StoredVersionedFacts` by design.
        expect(write.data.source_cache_key).toBe(prepared.row.source_cache_key);
        expect(write.data.source_cache_key).not.toBe(preparedFood().row.source_cache_key);
    });

    it('moves neither counter when only the category differs', async () => {
        // Category drives the grocery aisle, which is derived live from the
        // current row, so a recategorised food is already reported correctly and
        // no frozen snapshot reads it.
        const prepared = preparedFood();
        const recategorised: PreparedCatalogFood = { ...prepared, row: { ...prepared.row, category: 'other' } };
        const stored = storedFrom(prepared, 2, 2);

        const write = await persist(stored, recategorised);

        expect(write.data).toMatchObject({ nutrition_version: 2, metadata_version: 2, category: 'other' });
    });
});


/**
 * THE DURABLE BATCH LEDGER (and the checkpoint atomicity above it).
 *
 * `catalog_import_runs.counts` is merged by ADDITION, and `cursor` names the
 * next batch to do. Three defects met here, and all three were silent.
 *
 * THE INTERVAL WAS COUNTED INSTEAD OF THE WORK: the checkpoint added the save
 * INTERVAL — five — whatever the interval had actually covered, so a
 * seven-batch run recorded ten.
 *
 * The cursor and the counts were written by two separate transactions, neither
 * of them the one that wrote the batch's catalog rows, and only every fifth
 * batch. So a run could hold committed rows its cursor did not cover (up to
 * four batches' worth), and a run could say it had processed batches whose rows
 * a rolled-back transaction never wrote.
 *
 * And the closure — success or failure — merged the ATTEMPT's absolute totals on
 * top of that, so the four batches a retry reprocessed were counted twice, and
 * the overstatement grew with every retry. The overcount is durable: it is what
 * the run row says that run did, for the rest of the row's life.
 *
 * What replaces all three: one transaction per batch carrying the rows, the
 * cursor and that batch's counts, and a closure that merges nothing. These cases
 * therefore assert the pair TOGETHER — after every outcome, what the cursor
 * names and what the counts say describe the same set of batches.
 *
 * They go through the REAL run ledger, because the defect is in what the row
 * ends up holding and the merge that puts it there is the wiring under test
 * (this suite's charter names run bookkeeping as database-backed work). The
 * catalog writes are faked: an empty vendor response leaves the persistence path
 * with nothing to write, which keeps the cases about batch accounting alone.
 */
describe('the durable batch ledger a checkpoint records', () => {
    const FIXED_NOW = new Date('2026-09-14T09:00:00.000Z');

    /** Twenty ids per batch, so a limit is a batch count: 140 → 7, 60 → 3. */
    const BATCH_SIZE = 20;

    const scopeFor = (limit: number): string => importRunScope(manifest.usdaManifestVersion, options({ limit }));

    /**
     * A catalog client that can open the per-batch transaction and reach the run
     * ledger through it, and nothing else — see `ledgerOnlyCatalogDb`.
     */
    const transactionOnlyDb = (): ImportDb => ledgerOnlyCatalogDb('a batch-accounting case');

    /**
     * A catalog client that answers every batch with no records.
     *
     * The import then writes nothing and counts the ids as missing from the
     * vendor, which is a real outcome it handles — and it means these cases do
     * not depend on the shape of a single food. `failOnCall` is the interruption:
     * it throws on that (1-based) batch, leaving the run open at its last
     * checkpoint exactly as a vendor outage would.
     */
    const emptyVendor = (failOnCall: number | null = null): { calls: number[]; usda: RunImportDeps['usda'] } => {
        const calls: number[] = [];
        return {
            calls,
            usda: {
                listFoods: async (): Promise<UsdaFoodSummary[]> => [],
                fetchBatch: async (fdcIds) => {
                    calls.push(fdcIds.length);
                    if (failOnCall !== null && calls.length === failOnCall) {
                        throw new Error('vendor outage mid-run');
                    }
                    return batchFetch([], fdcIds);
                },
            },
        };
    };

    const runWith = async (
        limit: number,
        vendor: { usda: RunImportDeps['usda'] },
        db: ImportDb = transactionOnlyDb(),
        overrides: Partial<ImportOptions> = {},
    ): Promise<ReturnType<typeof runImport>> => {
        const deps = {
            db,
            runDb: prisma,
            usda: vendor.usda,
            manifest,
            coveragePlan,
            options: options({ limit, ...overrides }),
            logger: silentLogger,
            now: () => FIXED_NOW,
            installRateLimiter: () => (): void => undefined,
            writeReport: () => undefined,
        } as unknown as RunImportDeps;

        return runImport(deps);
    };

    /**
     * The scopes these cases claim, cleared before and after each one.
     *
     * Before, because a row left behind by an interrupted earlier run would be
     * resumed instead of opened; after, because a SUCCEEDED row makes the same
     * scope a permanent no-op and the next run of this suite would assert
     * against a run that did nothing (checkpoint.ts's THE CLAIM).
     */
    const claimedScopes = [scopeFor(140), scopeFor(60)];

    const clearClaimedRuns = async (): Promise<void> => {
        await prisma.catalog_import_runs.deleteMany({
            where: { kind: 'usda_import', manifest_version: { in: claimedScopes } },
        });
    };

    beforeEach(clearClaimedRuns);
    afterEach(clearClaimedRuns);

    interface DurableLedger {
        readonly batchesProcessed?: number;
        readonly missingFromVendor?: number;
        readonly planned?: number;
    }

    const durableLedger = async (runId: string): Promise<DurableLedger> => {
        const row = await prisma.catalog_import_runs.findUnique({
            where: { id: runId },
            select: { counts: true },
        });
        return (row?.counts ?? {}) as DurableLedger;
    };

    const durableCursor = async (runId: string): Promise<{ nextBatchIndex?: number }> => {
        const row = await prisma.catalog_import_runs.findUnique({
            where: { id: runId },
            select: { cursor: true },
        });
        return (row?.cursor ?? {}) as { nextBatchIndex?: number };
    };

    const durableBatchesProcessed = async (runId: string): Promise<number | undefined> =>
        (await durableLedger(runId)).batchesProcessed;

    it('records one batch per batch, with no interval left to overstate', async () => {
        // Seven batches, seven checkpoints. Ten was the overcount the interval
        // produced: 5 + 5, where the tail had covered two.
        const vendor = emptyVendor();
        const outcome = await runWith(140, vendor);

        const batches = 140 / BATCH_SIZE;
        expect(outcome.plannedBatches).toBe(batches);
        expect(outcome.processedBatches).toBe(batches);
        expect(vendor.calls).toHaveLength(batches);

        const ledger = await durableLedger(outcome.runId as string);
        expect(ledger.batchesProcessed).toBe(batches);
        // The whole per-batch delta is durable now, not just the batch count:
        // this vendor returns nothing, so every id it was asked for is missing,
        // and that is 20 per batch recorded inside the batch's own transaction.
        expect(ledger.missingFromVendor).toBe(140);
        // The plan's own total is recorded ONCE, when the row is opened — it
        // describes the work list rather than any batch, and the ledger merges
        // additively, so recording it per batch or per attempt would multiply it.
        expect(ledger.planned).toBe(140);
        // What the cursor names and what the counts say describe the same set of
        // batches. That pair is the invariant the two separate writes could not
        // keep.
        expect(await durableCursor(outcome.runId as string)).toMatchObject({ nextBatchIndex: batches });
    });

    it('records only this invocation’s batches when a resumed run finishes the tail', async () => {
        const interrupted = emptyVendor(6);
        await expect(runWith(140, interrupted)).rejects.toThrow('vendor outage mid-run');

        const openRunRow = await prisma.catalog_import_runs.findFirst({
            where: { kind: 'usda_import', manifest_version: scopeFor(140) },
        });
        // 'failed', not 'running': an interrupted attempt SETTLES its run row
        // with the reason, because a row left 'running' forever cannot be told
        // from one still in flight — which is precisely the read
        // catalog:validate's prerequisite check makes. The cursor and the
        // durable batch total are untouched by that closure, and
        // openOrResumeRun reopens a failed row through retryFailedRun, so the
        // resume below continues THIS row rather than opening a second one
        // beside it (checkpoint.ts's WHY A RETRY CONTINUES THE SAME ROW).
        expect(openRunRow?.status).toBe('failed');
        // The vendor throws on its sixth call, so five batches committed and the
        // sixth never opened a transaction. Cursor and counts agree on exactly
        // that, which is what makes the resume below correct rather than lucky.
        expect(openRunRow?.cursor).toMatchObject({ nextBatchIndex: 5 });
        const afterFailure = await durableLedger(openRunRow?.id as string);
        expect(afterFailure.batchesProcessed).toBe(5);
        expect(afterFailure.missingFromVendor).toBe(100);
        expect(afterFailure.planned).toBe(140);

        // The tail: two batches, on the same run row.
        const resumed = emptyVendor();
        const outcome = await runWith(140, { usda: resumed.usda }, transactionOnlyDb(), { resume: true });

        expect(outcome.runId).toBe(openRunRow?.id);
        expect(outcome.resumed).toBe(true);
        expect(outcome.processedBatches).toBe(2);
        expect(resumed.calls).toHaveLength(2);

        const ledger = await durableLedger(outcome.runId as string);
        // Seven, not twelve: each batch recorded itself once, in its own
        // transaction, so there is nothing for a second attempt to re-record.
        expect(ledger.batchesProcessed).toBe(7);
        expect(ledger.missingFromVendor).toBe(140);
        // ONE HUNDRED AND FORTY, NOT TWO HUNDRED AND EIGHTY. This is the
        // double-count the closure used to produce: the failed attempt's
        // absolute totals were merged when its run was closed, and the resumed
        // attempt's were merged again on success. Neither closure merges
        // anything now.
        expect(ledger.planned).toBe(140);
        expect(await durableCursor(outcome.runId as string)).toMatchObject({ nextBatchIndex: 7 });
    });

    it('stops with its cursor and its counts naming the same batch, wherever it stops', async () => {
        // Three batches with the vendor failing on the third: the interesting
        // case for the old interval, which saved nothing before batch five and
        // so reported a run that had processed two batches as having processed
        // none — while their rows were committed.
        const interrupted = emptyVendor(3);
        await expect(runWith(60, interrupted)).rejects.toThrow('vendor outage mid-run');

        const row = await prisma.catalog_import_runs.findFirst({
            where: { kind: 'usda_import', manifest_version: scopeFor(60) },
        });
        expect(row?.status).toBe('failed');
        expect(row?.cursor).toMatchObject({ nextBatchIndex: 2 });

        const ledger = await durableLedger(row?.id as string);
        expect(ledger.batchesProcessed).toBe(2);
        expect(ledger.missingFromVendor).toBe(2 * BATCH_SIZE);
        expect(ledger.planned).toBe(60);
    });

    it('refuses to continue an unfinished run unless it was asked to (--resume)', async () => {
        // The flag used to be parsed and then never consulted: an unfinished run
        // was continued either way, while the usage block said the default was
        // off. Refusing is the only other coherent reading — runs are keyed so a
        // repeat recognises completed work, so a second row beside the
        // unfinished one is not something the ledger can hold.
        const interrupted = emptyVendor(2);
        await expect(runWith(60, interrupted)).rejects.toThrow('vendor outage mid-run');

        const row = await prisma.catalog_import_runs.findFirst({
            where: { kind: 'usda_import', manifest_version: scopeFor(60) },
        });
        expect(row?.status).toBe('failed');

        const refused = emptyVendor();
        await expect(runWith(60, refused)).rejects.toThrow(CheckpointError);
        await expect(runWith(60, refused)).rejects.toThrow(/--resume/);
        // Refused before any work: no vendor call, and the run row is untouched.
        expect(refused.calls).toHaveLength(0);
        const untouched = await prisma.catalog_import_runs.findUnique({ where: { id: row?.id as string } });
        expect(untouched?.status).toBe('failed');
        expect(untouched?.cursor).toMatchObject({ nextBatchIndex: 1 });

        // With the flag, the same command continues the same row.
        const continued = emptyVendor();
        const outcome = await runWith(60, { usda: continued.usda }, transactionOnlyDb(), { resume: true });
        expect(outcome.runId).toBe(row?.id);
        expect(outcome.resumed).toBe(true);
        expect(continued.calls).toHaveLength(2);
        expect(await durableBatchesProcessed(outcome.runId as string)).toBe(3);
    });
});

/**
 * THE CHECKPOINT CONTRACT ITSELF.
 *
 * The cases above prove what the IMPORT does with the checkpoint. These prove
 * the checkpoint, because three other stages call the same module and the two
 * properties they depend on are invisible from the import's side.
 *
 * `saveCheckpoint` exists because `saveCursor` and `recordCounts` are each
 * their own transaction: a stage calling both recorded the work and the place
 * it had reached as two commits, and a crash between them leaves a run whose
 * counts claim work its cursor does not cover. It is also the only one of the
 * three that is useful inside a CALLER's transaction, which is what lets a
 * batch's rows, cursor and counts be one commit.
 *
 * `openOrResumeRun`'s new `resume` input is the other. An ABSENT flag permits
 * continuing, which is deliberate and load-bearing: `catalog-generate-ai`,
 * `catalog-validate` and `catalog-load` call this function without it and must
 * keep behaving exactly as they did. Only an explicit `false` — which the
 * import now passes from `--resume` — refuses.
 */
describe('the checkpoint writes a cursor and its counts together', () => {
    const SCOPE = 'v1+suite:checkpoint-contract';
    const FIXED_NOW = new Date('2026-09-14T09:00:00.000Z');

    const clearRuns = async (): Promise<void> => {
        await prisma.catalog_import_runs.deleteMany({
            where: { kind: 'usda_import', manifest_version: { startsWith: SCOPE } },
        });
    };

    beforeEach(clearRuns);
    afterEach(clearRuns);

    const openScope = async (
        scope: string,
    ): Promise<{ id: string }> => {
        const claim = await openOrResumeRun<{ at: number }>(prisma, {
            kind: 'usda_import',
            manifestVersion: scope,
            initialCursor: { at: 0 },
            logger: silentLogger,
            now: () => FIXED_NOW,
        });

        return { id: claim.run.id };
    };

    const runRow = async (runId: string): Promise<{ cursor: unknown; counts: unknown; status: string }> => {
        const row = await prisma.catalog_import_runs.findUnique({
            where: { id: runId },
            select: { cursor: true, counts: true, status: true },
        });
        expect(row).not.toBeNull();

        return row as { cursor: unknown; counts: unknown; status: string };
    };

    it('advances the cursor and adds the counts in one write', async () => {
        const run = await openScope(`${SCOPE}:together`);

        const merged = await saveCheckpoint(prisma, run.id, { cursor: { at: 3 }, counts: { inserted: 2 } });

        // Returned merged, so a caller can log what the run now says without
        // reading the row a second time.
        expect(merged).toMatchObject({ inserted: 2 });
        const row = await runRow(run.id);
        expect(row.cursor).toEqual({ at: 3 });
        expect(row.counts).toMatchObject({ inserted: 2 });
    });

    it('adds to what the row already holds rather than replacing it', async () => {
        const run = await openScope(`${SCOPE}:additive`);

        await saveCheckpoint(prisma, run.id, { cursor: { at: 1 }, counts: { inserted: 2, updated: 1 } });
        const merged = await saveCheckpoint(prisma, run.id, { cursor: { at: 2 }, counts: { inserted: 3 } });

        // The ledger is a running total, which is what makes a resumed run's
        // row describe the whole run instead of its last attempt — and what
        // makes merging an attempt's ABSOLUTE totals into it a double-count.
        expect(merged).toMatchObject({ inserted: 5, updated: 1 });
        expect((await runRow(run.id)).cursor).toEqual({ at: 2 });
    });

    /**
     * THE ONE SHAPE ADDITION CANNOT EXPRESS (CATIMP-additive-run-counters).
     *
     * A resume whose saved cursor belongs to a different plan restarts from the
     * beginning, so the abandoned attempt's totals describe records this
     * attempt is about to redo. Merged, they overstate every figure an operator
     * reads off the row — QA measured `candidates` at twice the row count with
     * `inserted` and `updated` each equal to it — and the previous plan's own
     * `skipped*` keys linger beside the new plan's.
     */
    it('replaces the row’s counts when this attempt abandoned what the last one measured', async () => {
        const run = await openScope(`${SCOPE}:replace`);
        await saveCheckpoint(prisma, run.id, {
            cursor: { at: 4 },
            counts: { planned: 90, inserted: 40, updated: 40, skippedRuleOfTheOldPlan: 7 },
        });

        const restarted = await saveCheckpoint(prisma, run.id, {
            cursor: { at: 0 },
            counts: { planned: 12, inserted: 0, updated: 0 },
            countsMode: 'replace',
        });

        // Equality, not a subset: the old plan's `skippedRuleOfTheOldPlan` is
        // GONE rather than left at 7, because a row carrying keys from two work
        // lists describes neither.
        expect(restarted).toEqual({ planned: 12, inserted: 0, updated: 0 });
        const row = await runRow(run.id);
        expect(row.counts).toEqual({ planned: 12, inserted: 0, updated: 0 });
        // One statement: the cursor the replacement was written with is the
        // cursor on the row, so the counters and the position they describe
        // cannot disagree.
        expect(row.cursor).toEqual({ at: 0 });
    });

    it('accumulates again on the next checkpoint, because the mode is per call and not per run', async () => {
        const run = await openScope(`${SCOPE}:replace-then-add`);
        await saveCheckpoint(prisma, run.id, { cursor: { at: 9 }, counts: { inserted: 40 } });
        await saveCheckpoint(prisma, run.id, {
            cursor: { at: 0 },
            counts: { planned: 12, inserted: 0 },
            countsMode: 'replace',
        });

        const merged = await saveCheckpoint(prisma, run.id, { cursor: { at: 1 }, counts: { inserted: 3 } });

        expect(merged).toEqual({ planned: 12, inserted: 3 });
    });

    it('adds when the mode is absent or stated as merge, so every existing caller is unchanged', async () => {
        const run = await openScope(`${SCOPE}:merge-default`);

        // The five other stages call this without a mode; `merge` stated
        // explicitly must mean exactly what absent means.
        await saveCheckpoint(prisma, run.id, { cursor: { at: 1 }, counts: { inserted: 2 } });
        const stated = await saveCheckpoint(prisma, run.id, {
            cursor: { at: 2 },
            counts: { inserted: 2 },
            countsMode: 'merge',
        });

        expect(stated).toEqual({ inserted: 4 });
    });

    it('applies the same value guards in both modes', () => {
        // Replacement is `mergeCounts` with the stored map discarded, so the
        // guards are not a second implementation that can drift from the first.
        expect(resolveCounts({ inserted: 2 }, { inserted: 3 }, 'merge')).toEqual({ inserted: 5 });
        expect(resolveCounts({ inserted: 2, stale: 9 }, { inserted: 3 }, 'replace')).toEqual({ inserted: 3 });
        // A broken number is dropped rather than stored, in the mode that
        // writes the caller's values verbatim as much as in the one that adds.
        expect(
            resolveCounts({ inserted: 2 }, { inserted: Number.NaN, updated: 1 } as Record<string, number>, 'replace'),
        ).toEqual({ updated: 1 });
        const prototypeKey = resolveCounts(
            {},
            JSON.parse('{"__proto__": 5, "inserted": 1}') as Record<string, number>,
            'replace',
        );
        expect(Object.prototype.hasOwnProperty.call(prototypeKey, '__proto__')).toBe(false);
        expect(prototypeKey).toEqual({ inserted: 1 });
        // A stored shape that is not a counter map reads as "no counters yet"
        // in either mode rather than throwing inside a checkpoint write.
        expect(resolveCounts(null, { inserted: 1 }, 'merge')).toEqual({ inserted: 1 });
        expect(resolveCounts('not a map', { inserted: 1 }, 'replace')).toEqual({ inserted: 1 });
    });

    it('takes a cursor-only checkpoint, for a caller with no counts to add', async () => {
        const run = await openScope(`${SCOPE}:cursor-only`);
        await saveCheckpoint(prisma, run.id, { cursor: { at: 1 }, counts: { inserted: 4 } });

        await saveCheckpoint(prisma, run.id, { cursor: { at: 9 } });

        const row = await runRow(run.id);
        expect(row.cursor).toEqual({ at: 9 });
        // An absent `counts` adds nothing; it does not clear what is there.
        expect(row.counts).toMatchObject({ inserted: 4 });
    });

    it('commits with the caller’s transaction, and rolls back with it', async () => {
        const run = await openScope(`${SCOPE}:in-transaction`);

        // The property the per-batch transaction rests on: handed a `tx`, the
        // checkpoint runs IN it, so the caller's rollback takes the cursor and
        // the counts with it. Without this, a rolled-back batch would leave a
        // ledger describing rows that do not exist.
        await expect(
            prisma.$transaction(async (tx) => {
                await saveCheckpoint(tx, run.id, { cursor: { at: 7 }, counts: { inserted: 5 } });
                throw new Error('the caller rolled back');
            }),
        ).rejects.toThrow('the caller rolled back');

        const row = await runRow(run.id);
        expect(row.cursor).toEqual({ at: 0 });
        expect(row.counts ?? {}).not.toMatchObject({ inserted: 5 });

        // And the same call inside a transaction that COMMITS is durable, so
        // the rollback above is about the transaction and not about the
        // checkpoint refusing to write.
        await prisma.$transaction(async (tx) => {
            await saveCheckpoint(tx, run.id, { cursor: { at: 8 }, counts: { inserted: 5 } });
        });
        expect((await runRow(run.id)).cursor).toEqual({ at: 8 });
    });

    it('refuses to checkpoint a run that is no longer open', async () => {
        const run = await openScope(`${SCOPE}:closed`);
        await finishRun(prisma, run.id, 'succeeded', { logger: silentLogger });

        // The `status = running` predicate on the write, surfaced as a typed
        // error: a stage writing to a settled run would move a ledger an
        // operator has already read as final.
        await expect(saveCheckpoint(prisma, run.id, { cursor: { at: 1 } })).rejects.toBeInstanceOf(CheckpointError);
    });

    it('permits continuing an unfinished run when no resume flag is given, and refuses on an explicit false', async () => {
        const scope = `${SCOPE}:resume-default`;
        const run = await openScope(scope);
        await saveCheckpoint(prisma, run.id, { cursor: { at: 4 } });

        // ABSENT PERMITS. `catalog-generate-ai`, `catalog-validate` and
        // `catalog-load` all call `openOrResumeRun` without a `resume` input,
        // and their behaviour must be byte-identical to what it was before the
        // flag existed — so this case is what keeps the import's new refusal
        // from becoming every stage's.
        const permitted = await openOrResumeRun<{ at: number }>(prisma, {
            kind: 'usda_import',
            manifestVersion: scope,
            initialCursor: { at: 0 },
            logger: silentLogger,
            now: () => FIXED_NOW,
        });
        expect(permitted.run.id).toBe(run.id);
        expect(permitted.resumed).toBe(true);
        expect(permitted.run.cursor).toEqual({ at: 4 });

        // EXPLICIT FALSE REFUSES, which is what `--resume` being off means:
        // the flag was parsed and never reached the claim, so the usage line
        // describing a default of "off" described no code.
        const refused = await openOrResumeRun<{ at: number }>(prisma, {
            kind: 'usda_import',
            manifestVersion: scope,
            initialCursor: { at: 0 },
            logger: silentLogger,
            now: () => FIXED_NOW,
            resume: false,
        }).then(
            () => null,
            (error: unknown) => error,
        );
        expect(refused).toBeInstanceOf(CheckpointError);
        expect((refused as CheckpointError).code).toBe('run_resume_not_requested');
        // The message names the run and how to continue it, because refusing
        // without saying how would leave an operator with no next command.
        expect((refused as CheckpointError).message).toContain('--resume');

        // And an explicit true continues, same row, same cursor.
        const continued = await openOrResumeRun<{ at: number }>(prisma, {
            kind: 'usda_import',
            manifestVersion: scope,
            initialCursor: { at: 0 },
            logger: silentLogger,
            now: () => FIXED_NOW,
            resume: true,
        });
        expect(continued.run.id).toBe(run.id);
        expect(continued.run.cursor).toEqual({ at: 4 });
    });

    it('still recognises a completed scope without a resume flag, because that is not a resume', async () => {
        const scope = `${SCOPE}:completed`;
        const run = await openScope(scope);
        await finishRun(prisma, run.id, 'succeeded', { logger: silentLogger });

        // A SUCCEEDED run is a permanent no-op, and refusing it for want of
        // `--resume` would turn "already done" into an error an operator has to
        // work around. `alreadyCompleted` is the answer, with or without the
        // flag.
        for (const resume of [undefined, false, true]) {
            const claim = await openOrResumeRun<{ at: number }>(prisma, {
                kind: 'usda_import',
                manifestVersion: scope,
                initialCursor: { at: 0 },
                logger: silentLogger,
                now: () => FIXED_NOW,
                ...(resume === undefined ? {} : { resume }),
            });
            expect(claim.alreadyCompleted).toBe(true);
            expect(claim.run.id).toBe(run.id);
        }
    });
});


/**
 * VALIDATION'S RUN IDENTITY AND THE FACTS IT JUDGES FROM.
 *
 * Two defects met in one function. THE DISCARDED CLAIM: the claim's
 * `alreadyCompleted` was discarded, so re-running a succeeded pass rewrote every
 * considered food's `updated_at`, every record's `reviewed_at` and `history` and
 * the report, beneath a closed run whose counts never moved — and a `--category`
 * pass shared the canonical run key, so a partial pass could close it. THE
 * VERDICT ON FACTS IT NO LONGER HELD: the verdict was computed from a set-wide
 * read and written by id, so a concurrent import could replace the nutrients
 * and metadata in between and the row was republished on checks derived from
 * facts it no longer had.
 *
 * The run ledger is real here, because the claim IS the thing under test. The
 * catalog side is an in-memory `ValidateDb`, which is what makes the races
 * deterministic: the "concurrent writer" is a hook that commits at an exact
 * point instead of a second process that might not land there.
 */
const validateOptions = (overrides: Partial<ValidateOptions> = {}): ValidateOptions => ({
    help: false,
    categories: [],
    revalidateQuarantined: false,
    // The stage's own defaults, so a case that names neither flag exercises the
    // pass an operator gets from a bare `npm run catalog:validate`: judged on
    // the deterministic checks alone, with no model call and every write made.
    review: false,
    dryRun: false,
    // The committed curator-decision artefact, which is what a bare
    // `npm run catalog:validate` judges review-tier holds with and the only
    // value that leaves the pass unrestricted (validationRunScope).
    curatorDecisionsPath: DEFAULT_CURATOR_DECISIONS_PATH,
    ...overrides,
});

/**
 * WHICH CATALOG A VALIDATION RUN ANSWERS FOR.
 *
 * The run key names two things and has to name both. Keyed on the coverage plan
 * alone, one successful pass answers "validation succeeded for v1" for ever, so
 * a later import under the same plan is met with the completed-run no-op and its
 * rows are never judged — which contradicts AAP §0.5.1 ("a refresh re-runs
 * validation") and, worse, deadlocks the release: catalog-release asks for a
 * validation newer than the last ingest, and that run can no longer happen.
 */
describe('catalogInputIdentity and the canonical run key', () => {
    const at = (iso: string): Date => new Date(iso);

    const ingest = (overrides: Partial<CatalogInputRunRow> = {}): CatalogInputRunRow => ({
        kind: 'usda_import',
        manifest_version: 'v1',
        status: 'succeeded',
        finished_at: at('2026-09-14T08:00:00.000Z'),
        ...overrides,
    });

    it('names the graph an empty ledger describes as having no input', () => {
        expect(catalogInputIdentity([])).toBe(NO_CATALOG_INPUT);
    });

    it('names the newest completed ingest', () => {
        expect(
            catalogInputIdentity([
                ingest({ finished_at: at('2026-09-14T08:00:00.000Z') }),
                ingest({ kind: 'release_load', manifest_version: 'v2', finished_at: at('2026-09-14T09:00:00.000Z') }),
            ]),
        ).toBe('release_load:v2:2026-09-14T09:00:00.000Z');
    });

    it.each(['usda_import', 'ai_generation', 'release_load'])('counts a %s run as catalog input', (kind) => {
        expect(catalogInputIdentity([ingest({ kind })])).toContain(kind);
    });

    it('does NOT count validation as input, or no pass could ever be complete', () => {
        // Validation moves publication_status and writes records; it never
        // changes a food's facts. Were it input, every pass would change the
        // identity of the catalog it was judging.
        expect(catalogInputIdentity([ingest({ kind: 'validation' })])).toBe(NO_CATALOG_INPUT);
    });

    it.each([
        ['running', 'running'],
        ['failed', 'failed'],
    ])('ignores a %s ingest, which left a graph nobody has vouched for', (_label, status) => {
        expect(catalogInputIdentity([ingest({ status, finished_at: null })])).toBe(NO_CATALOG_INPUT);
        expect(catalogInputIdentity([ingest({ status })])).toBe(NO_CATALOG_INPUT);
    });

    it('is a function of the ledger content, not of the order it came back in', () => {
        const rows = [
            ingest({ manifest_version: 'a' }),
            ingest({ kind: 'ai_generation', manifest_version: 'b' }),
            ingest({ kind: 'release_load', manifest_version: 'c' }),
        ];

        expect(catalogInputIdentity(rows)).toBe(catalogInputIdentity([...rows].reverse()));
    });

    it('gives a different canonical key to a different catalog input', () => {
        const before = canonicalValidationRunKey('v1', catalogInputIdentity([ingest()]));
        const after = canonicalValidationRunKey(
            'v1',
            catalogInputIdentity([ingest(), ingest({ manifest_version: 'v2', finished_at: at('2026-09-14T10:00:00.000Z') })]),
        );

        expect(after).not.toBe(before);
    });

    it('gives a different canonical key to a different coverage plan over the same input', () => {
        const identity = catalogInputIdentity([ingest()]);

        expect(canonicalValidationRunKey('v2', identity)).not.toBe(canonicalValidationRunKey('v1', identity));
    });

    it('stays short enough for an operator to read in a terminal', () => {
        const key = canonicalValidationRunKey('v1', catalogInputIdentity([ingest()]));

        expect(key.startsWith('v1@')).toBe(true);
        expect(key.length).toBeLessThanOrEqual('v1@'.length + 12);
    });

    it('does not read a canonical key as restricted', () => {
        expect(isRestrictedValidationRunKey(canonicalValidationRunKey('v1', 'none'))).toBe(false);
    });
});

describe('validationRunScope', () => {
    const version = coveragePlan.coveragePlanVersion;
    const INPUT = 'usda_import:v1:2026-09-14T08:00:00.000Z';
    const canonical = canonicalValidationRunKey(version, INPUT);

    it('claims the canonical key — plan AND catalog input — for the full pass', () => {
        expect(validationRunScope(version, validateOptions(), INPUT)).toBe(canonical);
    });

    it('claims a new key when the catalog input changed, so a refresh is judged (AAP 0.5.1)', () => {
        const afterRefresh = validationRunScope(
            version,
            validateOptions(),
            'usda_import:v1:2026-09-14T11:00:00.000Z',
        );

        expect(afterRefresh).not.toBe(canonical);
        expect(isRestrictedValidationRunKey(afterRefresh)).toBe(false);
    });

    it('claims a separate key for a category-restricted pass, so it cannot close the canonical one', () => {
        const scoped = validationRunScope(version, validateOptions({ categories: ['protein_poultry'] }), INPUT);

        expect(scoped).not.toBe(canonical);
        expect(scoped.startsWith(`${canonical}+scope:`)).toBe(true);
        expect(isRestrictedValidationRunKey(scoped)).toBe(true);
    });

    it('claims a separate key for --revalidate-quarantined', () => {
        const scoped = validationRunScope(version, validateOptions({ revalidateQuarantined: true }), INPUT);

        expect(scoped).not.toBe(canonical);
        expect(scoped).not.toBe(
            validationRunScope(version, validateOptions({ categories: ['protein_poultry'] }), INPUT),
        );
        expect(isRestrictedValidationRunKey(scoped)).toBe(true);
    });

    it('gives the same restriction the same key however the operator ordered it', () => {
        expect(validationRunScope(version, validateOptions({ categories: ['dairy', 'grain'] }), INPUT)).toBe(
            validationRunScope(version, validateOptions({ categories: ['grain', 'dairy'] }), INPUT),
        );
    });

    it('gives the same restriction the same key however many times the operator repeated a flag', () => {
        // `--category dairy --category dairy` considers exactly what
        // `--category dairy` considers. A second key for the same considered set
        // would walk straight past the completed-run no-op and re-judge it.
        expect(validationRunScope(version, validateOptions({ categories: ['dairy', 'dairy'] }), INPUT)).toBe(
            validationRunScope(version, validateOptions({ categories: ['dairy'] }), INPUT),
        );
        expect(
            validationRunScope(version, validateOptions({ categories: ['grain', 'dairy', 'grain'] }), INPUT),
        ).toBe(validationRunScope(version, validateOptions({ categories: ['dairy', 'grain'] }), INPUT));
    });

    it('separates two different restrictions', () => {
        expect(validationRunScope(version, validateOptions({ categories: ['dairy'] }), INPUT)).not.toBe(
            validationRunScope(version, validateOptions({ categories: ['grain'] }), INPUT),
        );
    });

    it('separates the same restriction over two different catalog inputs', () => {
        expect(validationRunScope(version, validateOptions({ categories: ['dairy'] }), INPUT)).not.toBe(
            validationRunScope(
                version,
                validateOptions({ categories: ['dairy'] }),
                'usda_import:v1:2026-09-14T11:00:00.000Z',
            ),
        );
    });
});

/**
 * ONE HISTORY ENTRY PER RUN PER FOOD.
 *
 * The status write and the history commit together; the cursor that says "done"
 * commits after them. Something has to be true in that window, and an
 * unconditional append would leave two entries claiming the same transition —
 * in the audit trail this stage exists to produce.
 */
describe('appendValidationHistory is idempotent per run and food', () => {
    const NOW = new Date('2026-09-14T10:15:00.000Z');
    const LATER = new Date('2026-09-14T10:16:00.000Z');
    const RUN = 'run-a';

    const verdict = {
        publicationStatus: 'published',
        outcome: 'accepted',
        decidingCheckNames: [],
        reviewFlags: [],
        checks: [],
    } as unknown as Parameters<typeof appendValidationHistory>[2];

    const rowWithHistory = (history: unknown[]): ValidationFoodRow =>
        ({
            publication_status: 'candidate',
            catalog_validation_records: { id: 'r', history, canonical_identity: {}, nutrition_assumptions: null },
        }) as unknown as ValidationFoodRow;

    it('records the run that judged the food', () => {
        const history = appendValidationHistory(rowWithHistory([]), 'published', verdict, NOW, RUN);

        expect(history).toHaveLength(1);
        expect(history[0]).toMatchObject({ run: RUN, from: 'candidate', to: 'published' });
    });

    it('REPLACES its own earlier entry when the same run judges the food again', () => {
        const first = appendValidationHistory(rowWithHistory([]), 'quarantined', verdict, NOW, RUN);
        const second = appendValidationHistory(rowWithHistory(first), 'published', verdict, LATER, RUN);

        expect(second).toHaveLength(1);
        expect(second[0]).toMatchObject({ run: RUN, to: 'published', at: LATER.toISOString() });
    });

    it('keeps another run\u2019s entry, because that judgement did happen', () => {
        const earlier = appendValidationHistory(rowWithHistory([]), 'published', verdict, NOW, 'run-old');
        const later = appendValidationHistory(rowWithHistory(earlier), 'quarantined', verdict, LATER, RUN);

        expect(later).toHaveLength(2);
        expect(later.map((entry) => (entry as { run: string }).run)).toEqual(['run-old', RUN]);
    });

    it('never matches an entry an older release wrote without a run, so existing history survives', () => {
        const legacy = [{ at: '2026-01-01T00:00:00.000Z', from: 'candidate', to: 'published' }];
        const history = appendValidationHistory(rowWithHistory(legacy), 'published', verdict, NOW, RUN);

        expect(history).toHaveLength(2);
        expect(history[0]).toEqual(legacy[0]);
    });

    it('reports whether a run has judged a food, which is the queue\u2019s own predicate', () => {
        const judged = appendValidationHistory(rowWithHistory([]), 'published', verdict, NOW, RUN);

        expect(runHasJudgedFood(rowWithHistory(judged), RUN)).toBe(true);
        expect(runHasJudgedFood(rowWithHistory(judged), 'run-b')).toBe(false);
        expect(runHasJudgedFood(rowWithHistory([]), RUN)).toBe(false);
        // A record that does not exist yet cannot have been judged.
        expect(runHasJudgedFood({ catalog_validation_records: null } as unknown as ValidationFoodRow, RUN)).toBe(false);
    });

    it.each([
        ['a non-object entry', 'not-an-entry'],
        ['null', null],
        ['an entry with no run', { at: 'x' }],
        ['an entry whose run is not a string', { run: 7 }],
    ])('does not read %s as belonging to a run', (_label, entry) => {
        expect(historyEntryBelongsToRun(entry, RUN)).toBe(false);
    });
});

describe('identityGroupMoved', () => {
    const facts = {
        source_key: 'usda:171077',
        canonical_name: 'chicken breast',
        food_state: 'raw',
        identity_source: 'usda',
    };

    it('is false for the same identity', () => {
        expect(identityGroupMoved(facts, { ...facts })).toBe(false);
    });

    it('is false for a purely cosmetic re-spelling, which does not move the group key', () => {
        expect(identityGroupMoved(facts, { ...facts, canonical_name: '  Chicken   Breast ' })).toBe(false);
    });

    it.each([
        ['source_key', { source_key: 'usda:171078' }],
        ['canonical_name', { canonical_name: 'chicken thigh' }],
        ['food_state', { food_state: 'cooked' }],
        ['identity_source', { identity_source: 'ai_generated' }],
    ])('is true when %s moved', (_field, change) => {
        expect(identityGroupMoved(facts, { ...facts, ...change })).toBe(true);
    });
});

describe('runValidation', () => {
    const FIXED_NOW = new Date('2026-09-14T10:15:00.000Z');
    const CATEGORY = 'protein_poultry';
    const scopedOptions = validateOptions({ categories: [CATEGORY] });
    // These cases claim a RESTRICTED key, so they can never close the canonical
    // one for this database however they end. The ledger they run against holds
    // no ingest, so the input identity they resolve is NO_CATALOG_INPUT — the
    // suite deletes its own run rows around every case (below), which keeps that
    // true whatever else has run.
    const runScope = validationRunScope(coveragePlan.coveragePlanVersion, scopedOptions, NO_CATALOG_INPUT);

    /**
     * One complete retrieval record, in the column vocabulary the importer
     * writes it in.
     *
     * Present on every fixture below because publication depends on it:
     * `judgeRow` holds a row whose validation record does not state a
     * verifiable retrieval — a URL, the host, an OBSERVED 2xx status, a body
     * digest, the snippet naming the food, the time, and for a USDA row the
     * cache key and this food's own record digest (scripts/lib/catalogEvidence.ts).
     * A fixture without one is a QUARANTINED row rather than a passing one, so
     * these cases would be asserting the floor instead of the version predicate
     * and the run accounting they are about.
     */
    const identityEvidence = (matchedSnippet: string): Record<string, unknown>[] => [
        {
            url: 'https://api.nal.usda.gov/fdc/v1/foods',
            final_host: 'api.nal.usda.gov',
            http_status: 200,
            body_sha256: 'd'.repeat(64),
            record_sha256: 'e'.repeat(64),
            // The cache row the BATCH response is recorded under, which is what
            // the column names; the per-food digest above is what makes it
            // evidence for this food rather than for the twenty it carried.
            source_cache_key: 'usda:foods:harness-batch',
            matched_snippet: matchedSnippet,
            fetched_at: FIXED_NOW.toISOString(),
        },
    ];

    /** A row every deterministic check passes, so its verdict is `published`. */
    const validationRow = (overrides: Partial<ValidationFoodRow> = {}): ValidationFoodRow => ({
        id: '00000000-0000-4000-8000-000000000001',
        source_key: 'usda:900001',
        canonical_name: 'chicken breast',
        display_name: 'Chicken breast',
        category: CATEGORY,
        food_state: 'raw',
        identity_source: 'usda',
        identity_status: 'verified',
        nutrition_provenance: 'source_backed',
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        calories: 165,
        protein_g: 31,
        carbs_g: 0,
        fat_g: 3.6,
        fiber_g: null,
        density_g_per_ml: null,
        allergen_status: 'known',
        allergen_tags: [],
        publication_status: 'candidate',
        nutrition_version: 1,
        metadata_version: 1,
        catalog_food_aliases: [],
        catalog_food_portions: [
            { description: '1 breast', amount: 1, unit: 'each', gram_weight: 174, is_default: true, source: 'usda_food_portion' },
        ],
        // READ AND EMPTY, which is not the same fact as unread. The component
        // floor holds a row whose composition nobody looked at — an absent
        // relation is assessed rather than assumed empty, so a caller that
        // forgets to select it cannot publish a food on scalars nothing checked
        // (scripts/lib/catalogEvidence.ts, and `componentDerivationFor`'s own
        // comment). These fixtures are single-ingredient USDA records with no
        // composition, so they state the empty set the way the stage's own
        // `selection` returns it; without it every row here would quarantine
        // and these cases would be asserting the floor instead of the version
        // predicate and the run accounting they are about.
        catalog_food_components: [],
        catalog_validation_records: {
            id: 'record-1',
            history: [],
            canonical_identity: { source_key: 'usda:900001', curator_review_required: false },
            nutrition_assumptions: null,
            // The review the row's last judgement recorded. `null` is "no
            // review was consulted", which is what reviewOwedByRun reads to
            // recover a stopped review's debt from the rows themselves.
            llm_review: null,
            identity_evidence: identityEvidence('chicken breast, raw'),
        },
        ...overrides,
    });

    /**
     * A distinct identity per row, because `dedupeIdentity` groups on the
     * normalized canonical name and the state: three rows sharing one name are
     * duplicates of each other, which is a different verdict than these cases
     * are about.
     */
    const rowAt = (index: number, overrides: Partial<ValidationFoodRow> = {}): ValidationFoodRow =>
        validationRow({
            id: `00000000-0000-4000-8000-00000000000${index}`,
            source_key: `usda:90000${index}`,
            canonical_name: `chicken cut ${index}`,
            display_name: `Chicken cut ${index}`,
            ...overrides,
        });

    interface FakeValidateHooks {
        /**
         * Commits a change between the set-wide read and the locked re-read,
         * which is the window the locked re-read exists to close. Applied where
         * the row lock is taken, so it lands on exactly the food being judged
         * and on no other.
         */
        readonly raceAfterSetRead?: (id: string, store: Map<string, ValidationFoodRow>) => void;
        /** Commits a change after the locked re-read and before the guarded write. */
        readonly raceBeforeWrite?: (id: string, store: Map<string, ValidationFoodRow>) => void;
        /** Ids whose row lock finds nothing, i.e. the row was deleted under the pass. */
        readonly vanished?: ReadonlySet<string>;
        /** Throws when that food's transaction opens, which is how a pass is interrupted. */
        readonly failOnId?: string;
    }

    interface FakeValidateDb {
        readonly db: ValidateDb;
        readonly store: Map<string, ValidationFoodRow>;
        /** Every `history` array written, by food id, so a second judgement is visible. */
        readonly historyWrites: Map<string, unknown[][]>;
        readonly statusWrites: Map<string, string[]>;
    }

    const inMemoryValidateDb = (rows: readonly ValidationFoodRow[], hooks: FakeValidateHooks = {}): FakeValidateDb => {
        const store = new Map(rows.map((row) => [row.id, row]));
        const historyWrites = new Map<string, unknown[][]>();
        const statusWrites = new Map<string, string[]>();

        const recordHistory = (id: string, history: unknown, llmReview: unknown = null): void => {
            const written = historyWrites.get(id) ?? [];
            const entries = Array.isArray(history) ? (history as unknown[]) : [];
            written.push(entries);
            historyWrites.set(id, written);

            // Written BACK into the row, as the database does. Without this the
            // store would forget every judgement the moment the transaction
            // returned, and a resumed pass built from it could not tell that
            // this run had already judged the food — which is the whole
            // mechanism under test. `llm_review` is mirrored for the same
            // reason: it is the column reviewOwedByRun reads to recover a
            // stopped review's debt from the rows themselves.
            const row = store.get(id);
            if (row !== undefined) {
                const record = row.catalog_validation_records;
                store.set(id, {
                    ...row,
                    catalog_validation_records:
                        record === null
                            ? {
                                  id: 'record-created',
                                  history: entries,
                                  canonical_identity: {},
                                  nutrition_assumptions: null,
                                  llm_review: llmReview,
                              }
                            : { ...record, history: entries, llm_review: llmReview },
                });
            }
        };

        const db: ValidateDb = {
            catalog_foods: {
                findMany: async (args: unknown) => {
                    const statuses = (args as { where: { publication_status: { in: string[] } } }).where
                        .publication_status.in;
                    return [...store.values()]
                        .filter((row) => statuses.includes(row.publication_status))
                        .sort((left, right) => (left.source_key < right.source_key ? -1 : 1));
                },
                findUnique: async (args: unknown) => {
                    const { id } = (args as { where: { id: string } }).where;
                    return store.get(id) ?? null;
                },
                updateMany: async (args: unknown) => {
                    const { where, data } = args as {
                        where: {
                            id: string;
                            nutrition_version: number;
                            metadata_version: number;
                            publication_status: string;
                        };
                        data: { publication_status: string };
                    };
                    hooks.raceBeforeWrite?.(where.id, store);
                    const row = store.get(where.id);
                    if (
                        row === undefined ||
                        row.nutrition_version !== where.nutrition_version ||
                        row.metadata_version !== where.metadata_version ||
                        row.publication_status !== where.publication_status
                    ) {
                        return { count: 0 };
                    }
                    store.set(where.id, { ...row, publication_status: data.publication_status });
                    const written = statusWrites.get(where.id) ?? [];
                    written.push(data.publication_status);
                    statusWrites.set(where.id, written);
                    return { count: 1 };
                },
            },
            catalog_food_aliases: {
                createMany: async () => ({ count: 0 }),
                findMany: async () => [],
            },
            catalog_validation_records: {
                create: async (args: unknown) => {
                    const { data } = args as {
                        data: { catalog_food_id: string; history: unknown; llm_review?: unknown };
                    };
                    recordHistory(data.catalog_food_id, data.history, data.llm_review ?? null);
                    return { id: 'record-created' };
                },
                update: async (args: unknown) => {
                    const { where, data } = args as {
                        where: { catalog_food_id: string };
                        data: { history: unknown; llm_review?: unknown };
                    };
                    recordHistory(where.catalog_food_id, data.history, data.llm_review ?? null);
                    return { id: 'record-updated' };
                },
                updateMany: async () => ({ count: 0 }),
            },
            // The row lock is the first statement of the judgement transaction
            // and it binds the food's id, so this is where a "concurrent writer"
            // is made exact: the hooks fire against the id actually being
            // judged, never against a guess at which one that is.
            $queryRaw: async <TRows>(_query: TemplateStringsArray, ...values: unknown[]): Promise<TRows> => {
                const id = String(values[0]);
                if (hooks.failOnId === id) {
                    throw new Error(`interrupted while judging ${id}`);
                }
                hooks.raceAfterSetRead?.(id, store);
                const present = store.has(id) && !(hooks.vanished?.has(id) ?? false);
                return (present ? [{ id }] : []) as TRows;
            },
            $transaction: async (work) => work(db),
        };

        return { db, store, historyWrites, statusWrites };
    };

    const run = async (fake: FakeValidateDb, options = scopedOptions): Promise<{
        outcome: Awaited<ReturnType<typeof runValidation>>;
        reports: unknown[];
    }> => {
        const reports: unknown[] = [];
        const deps = {
            db: fake.db,
            runDb: prisma,
            coveragePlan,
            options,
            logger: silentLogger,
            now: () => FIXED_NOW,
            writeReport: (report: unknown) => {
                reports.push(report);
            },
        } as unknown as RunValidationDeps;

        return { outcome: await runValidation(deps), reports };
    };

    /**
     * Leaves the ledger in the one state these cases are written against: no
     * validation run for the key they claim, and no ingest at all.
     *
     * The ingest rows matter because the run key now names the catalog input
     * (see validationRunScope): a leftover succeeded import would change the key
     * `runValidation` computes, and the suite would then look up a run row that
     * the pass never claimed. Deleting them makes the resolved identity
     * deterministically NO_CATALOG_INPUT rather than a function of which suite
     * ran first.
     */
    const clearClaimedRuns = async (): Promise<void> => {
        await prisma.catalog_import_runs.deleteMany({
            where: {
                OR: [
                    { kind: 'validation' },
                    { kind: { in: ['usda_import', 'ai_generation', 'release_load'] } },
                ],
            },
        });
    };

    beforeEach(clearClaimedRuns);
    afterEach(clearClaimedRuns);

    const runRow = async (): Promise<{ id: string; status: string; cursor: unknown; counts: unknown } | null> =>
        prisma.catalog_import_runs.findFirst({
            where: { kind: 'validation', manifest_version: runScope },
            select: { id: true, status: true, cursor: true, counts: true },
        });

    describe('a succeeded run is a no-op', () => {
        it('reads nothing and writes nothing when the claim comes back completed', async () => {
            const settled = await openRun(prisma, { kind: 'validation', manifestVersion: runScope });
            await finishRun(prisma, settled.id, 'succeeded', { counts: { considered: 12, published: 9 } });

            // Any access at all fails by name. A pass that re-judged would have
            // to reach this client to read the graph, let alone write it, so
            // refusing every property IS the zero-write assertion.
            const forbiddenDb = new Proxy(
                {},
                {
                    get: (_target, property) => {
                        throw new Error(`a completed validation run reached the catalog: db.${String(property)}`);
                    },
                },
            ) as unknown as ValidateDb;

            const reports: unknown[] = [];
            const outcome = await runValidation({
                db: forbiddenDb,
                runDb: prisma,
                coveragePlan,
                options: scopedOptions,
                logger: silentLogger,
                now: () => FIXED_NOW,
                writeReport: (report: unknown) => {
                    reports.push(report);
                },
            } as unknown as RunValidationDeps);

            expect(outcome.alreadyCompleted).toBe(true);
            expect(outcome.runId).toBe(settled.id);
            expect(outcome.counts).toMatchObject({ considered: 12, published: 9 });
            expect(outcome.unjudged).toBe(0);
            // No report file either: the report describes a pass, and this
            // invocation did not make one.
            expect(reports).toEqual([]);

            const after = await prisma.catalog_import_runs.findUnique({
                where: { id: settled.id },
                select: { status: true, finished_at: true, counts: true },
            });
            expect(after?.status).toBe('succeeded');
            expect(after?.counts).toEqual({ considered: 12, published: 9 });
        });
    });

    describe('an interrupted pass resumes without judging a row twice', () => {
        it('picks up at the cursor and appends one history entry per food', async () => {
            const rows = [rowAt(1), rowAt(2), rowAt(3)];

            const interrupted = inMemoryValidateDb(rows, { failOnId: rows[1].id });
            await expect(run(interrupted)).rejects.toThrow(`interrupted while judging ${rows[1].id}`);

            const open = await runRow();
            expect(open?.status).toBe('running');
            expect(open?.cursor).toMatchObject({ nextIndex: 1 });
            expect(interrupted.historyWrites.get(rows[0].id)).toHaveLength(1);
            expect(interrupted.historyWrites.has(rows[1].id)).toBe(false);

            // The resumed pass carries the store forward — the first row is
            // already judged and published in it — and must start at index 1.
            const resumed = inMemoryValidateDb([...interrupted.store.values()]);
            const { outcome, reports } = await run(resumed);

            expect(outcome.alreadyCompleted).toBe(false);
            expect(outcome.unjudged).toBe(0);
            expect(resumed.historyWrites.has(rows[0].id)).toBe(false);
            expect(resumed.historyWrites.get(rows[1].id)).toHaveLength(1);
            expect(resumed.historyWrites.get(rows[2].id)).toHaveLength(1);

            const closed = await runRow();
            expect(closed?.status).toBe('succeeded');
            // One set considered, counted once however many attempts closed it.
            expect(closed?.counts).toMatchObject({ considered: rows.length, judged: rows.length });

            // WHERE IT RESUMED FROM, asserted on its own.
            //
            // Not a duplicate of the history assertions above: those hold even
            // if the cursor is ignored entirely, because the queue also filters
            // on "this run already judged this food" (below) and that filter
            // alone keeps a restart-from-zero correct. What the cursor still
            // buys is the WORK bound — a pass that restarts at 0 on every
            // resume re-reads and re-filters the whole considered set, which on
            // a 10,000-row catalog turns a resumable pass into quadratic work
            // across its resumes. The report states where it began, so that is
            // where the property is pinned.
            expect(reports).toHaveLength(1);
            expect((reports[0] as { invocation: { resumed: boolean; startIndex: number } }).invocation).toMatchObject({
                resumed: true,
                startIndex: 1,
            });
        });
    });

    describe('the verdict is computed from the facts the write locked', () => {
        it('re-judges on nutrients a concurrent writer committed after the set-wide read', async () => {
            const row = rowAt(1);
            const fake = inMemoryValidateDb([row], {
                // Physically impossible once committed: the macro mass now
                // exceeds the basis, which is a reject-tier check. The verdict
                // from the older read said `published`.
                raceAfterSetRead: (id, store) => {
                    const current = store.get(id) as ValidationFoodRow;
                    store.set(id, { ...current, protein_g: 500 });
                },
            });

            const { outcome } = await run(fake);

            expect(fake.statusWrites.get(row.id)).toEqual(['rejected']);
            expect(outcome.counts.rejected).toBe(1);
            expect(outcome.counts.published).toBe(0);
            expect(outcome.unjudged).toBe(0);
        });

        it('re-applies the identity floor to the locked row', async () => {
            const row = rowAt(1);
            const fake = inMemoryValidateDb([row], {
                raceAfterSetRead: (id, store) => {
                    const current = store.get(id) as ValidationFoodRow;
                    store.set(id, { ...current, identity_status: 'ambiguous' });
                },
            });

            const { outcome } = await run(fake);

            expect(fake.statusWrites.get(row.id)).toEqual(['quarantined']);
            expect(outcome.counts.identityNotVerified).toBe(1);
        });

        it('leaves the row unjudged when the guarded write loses to a racing version bump', async () => {
            const row = rowAt(1);
            const fake = inMemoryValidateDb([row], {
                // Committed between the locked re-read and the guarded write, so
                // the predicate no longer matches: without it this judgement
                // would land on facts that had already moved.
                raceBeforeWrite: (id, store) => {
                    const current = store.get(id) as ValidationFoodRow;
                    store.set(id, { ...current, nutrition_version: current.nutrition_version + 1 });
                },
            });

            const { outcome, reports } = await run(fake);

            expect(outcome.counts.raced).toBe(1);
            expect(outcome.unjudged).toBe(1);
            expect(fake.statusWrites.has(row.id)).toBe(false);
            expect(fake.historyWrites.has(row.id)).toBe(false);
            expect((reports[0] as { skipped: { raced: string[] } }).skipped.raced).toEqual([row.source_key]);

            // An incomplete judgement of its set is not a completed run: closing
            // it succeeded would make the no-op above answer every later
            // invocation and strand this row at its old status.
            const closed = await runRow();
            expect(closed?.status).toBe('failed');
            expect(closed?.cursor).toMatchObject({ unjudged: [0] });
        });

        it('leaves the row unjudged when its identity group moved under the duplicate pass', async () => {
            const row = rowAt(1);
            const fake = inMemoryValidateDb([row], {
                raceAfterSetRead: (id, store) => {
                    const current = store.get(id) as ValidationFoodRow;
                    store.set(id, { ...current, canonical_name: 'a different food entirely' });
                },
            });

            const { outcome } = await run(fake);

            expect(outcome.counts.identityGroupMoved).toBe(1);
            expect(outcome.unjudged).toBe(1);
            expect(fake.statusWrites.has(row.id)).toBe(false);
        });

        it('counts a row deleted under the pass rather than writing it', async () => {
            const row = rowAt(1);
            const fake = inMemoryValidateDb([row], { vanished: new Set([row.id]) });

            const { outcome } = await run(fake);

            expect(outcome.counts.vanished).toBe(1);
            expect(outcome.unjudged).toBe(1);
            expect(fake.statusWrites.has(row.id)).toBe(false);
            expect(fake.historyWrites.has(row.id)).toBe(false);
        });
    });

    /**
     * THE WINDOW BETWEEN THE JUDGEMENT AND THE CURSOR.
     *
     * The status write, the validation record and the history commit in one
     * transaction; the cursor that says "this food is done" is a separate write
     * after it. These cases are the two ways a row ends up judged but not
     * pointed past — a crash in that window, and a considered list the pass's own
     * writes reshaped — and both assert the same thing: the food carries exactly
     * one history entry for the run, because the entry is keyed by run and food
     * rather than appended blindly.
     */
    describe('a row judged but not yet pointed past is not judged twice', () => {
        it('leaves one history entry when the pass dies AFTER the judgement commits', async () => {
            const rows = [rowAt(1), rowAt(2)];

            // The cursor write is what fails, so row 1's judgement is committed
            // and durable while the pointer still says "start at 0" — precisely
            // the interval an interruption test that fails at the next
            // transaction never enters. The wrapper reaches into the transaction
            // the cursor is written in, because that is where the write is.
            const firstAttempt = inMemoryValidateDb(rows);
            const reports: unknown[] = [];
            let cursorWrites = 0;

            const loseCursorWrites = (base: unknown): unknown =>
                new Proxy(base as object, {
                    get: (target, property) => {
                        if (property === '$transaction') {
                            const runner = Reflect.get(target, property) as (
                                work: (tx: unknown) => Promise<unknown>,
                            ) => Promise<unknown>;
                            return (work: (tx: unknown) => Promise<unknown>) =>
                                runner.call(target, (tx: unknown) => work(loseCursorWrites(tx)));
                        }
                        if (property === 'catalog_import_runs') {
                            const model = Reflect.get(target, property) as Record<string, unknown>;
                            return new Proxy(model, {
                                get: (modelTarget, modelProperty) => {
                                    if (modelProperty === 'updateMany') {
                                        return async (args: { data?: Record<string, unknown> }) => {
                                            if (args.data !== undefined && 'cursor' in args.data) {
                                                cursorWrites += 1;
                                                throw new Error('cursor write lost');
                                            }
                                            return (
                                                Reflect.get(modelTarget, modelProperty) as (
                                                    a: unknown,
                                                ) => Promise<unknown>
                                            ).call(modelTarget, args);
                                        };
                                    }
                                    const value = Reflect.get(modelTarget, modelProperty);
                                    return typeof value === 'function' ? value.bind(modelTarget) : value;
                                },
                            });
                        }
                        const value = Reflect.get(target, property);
                        return typeof value === 'function' ? value.bind(target) : value;
                    },
                });

            await expect(
                runValidation({
                    db: firstAttempt.db,
                    runDb: loseCursorWrites(prisma),
                    coveragePlan,
                    options: scopedOptions,
                    logger: silentLogger,
                    now: () => FIXED_NOW,
                    writeReport: (report: unknown) => {
                        reports.push(report);
                    },
                } as unknown as RunValidationDeps),
            ).rejects.toThrow('cursor write lost');

            expect(cursorWrites).toBe(1);
            // Judged and committed, with no cursor to show for it.
            expect(firstAttempt.historyWrites.get(rows[0].id)).toHaveLength(1);
            const open = await runRow();
            expect(open?.cursor ?? null).toBeNull();

            // The resumed attempt therefore reconsiders row 1 from index 0 — and
            // must recognise, from the row's own record, that this run already
            // judged it.
            const resumed = inMemoryValidateDb([...firstAttempt.store.values()]);
            const { outcome } = await run(resumed);

            expect(outcome.alreadyCompleted).toBe(false);
            expect(resumed.historyWrites.has(rows[0].id)).toBe(false);
            expect(resumed.historyWrites.get(rows[1].id)).toHaveLength(1);
        });

        it('does not re-judge a row when its own rejection reshaped the considered list', async () => {
            // Validation moves a candidate to `rejected`, and a rejected row is
            // NOT in the status filter the considered list is built from. So the
            // list — and every position in it — shifts as a result of the pass's
            // own writes, which is what makes a saved index name a different
            // food and sends an interrupted attempt down the restart branch.
            const doomed = rowAt(1, { protein_g: 500 });
            const healthy = rowAt(2);
            const third = rowAt(3);

            const first = inMemoryValidateDb([doomed, healthy, third], { failOnId: third.id });
            await expect(run(first)).rejects.toThrow(`interrupted while judging ${third.id}`);

            expect(first.statusWrites.get(doomed.id)).toEqual(['rejected']);
            expect(first.historyWrites.get(healthy.id)).toHaveLength(1);

            const open = await runRow();
            const resumed = inMemoryValidateDb([...first.store.values()]);
            const { outcome } = await run(resumed);

            // The rejected row has dropped out of the considered set, so the
            // remaining list is shorter and `healthy` now sits where `doomed`
            // did. It must still not be judged again.
            expect(resumed.historyWrites.has(healthy.id)).toBe(false);
            expect(resumed.historyWrites.get(third.id)).toHaveLength(1);
            expect(outcome.unjudged).toBe(0);
        });
    });

    /**
     * A CATALOG REFRESH IS NEW WORK.
     *
     * AAP §0.5.1: "a refresh re-runs validation". Keyed on the coverage plan
     * alone, the pass that judged the catalog before the refresh would answer
     * for the one after it, and catalog-release — which wants a validation newer
     * than the last ingest — would wait on a run that could never happen.
     */
    describe('a newer catalog input is judged rather than answered for', () => {
        const fullOptions = validateOptions();

        it('no-ops a re-run against the same catalog, and judges again after an import', async () => {
            const row = rowAt(1);

            // Nothing imported yet: the canonical key names an empty input.
            const first = inMemoryValidateDb([row]);
            const initial = await run(first, fullOptions);
            expect(initial.outcome.alreadyCompleted).toBe(false);
            expect(first.statusWrites.get(row.id)).toEqual(['published']);

            // Same catalog, same plan: the completed-run no-op answers.
            const repeat = inMemoryValidateDb([...first.store.values()]);
            const again = await run(repeat, fullOptions);
            expect(again.outcome.alreadyCompleted).toBe(true);
            expect(repeat.statusWrites.size).toBe(0);

            // An import lands. The graph it left is a different catalog, so the
            // key is different and the rows are judged.
            await prisma.catalog_import_runs.create({
                data: {
                    kind: 'usda_import',
                    manifest_version: 'refresh-v1',
                    status: 'succeeded',
                    started_at: new Date('2026-09-14T11:00:00.000Z'),
                    finished_at: new Date('2026-09-14T11:05:00.000Z'),
                },
            });

            const afterRefresh = inMemoryValidateDb([...first.store.values()]);
            const refreshed = await run(afterRefresh, fullOptions);

            expect(refreshed.outcome.alreadyCompleted).toBe(false);
            expect(refreshed.outcome.runId).not.toBe(initial.outcome.runId);
            expect(afterRefresh.statusWrites.get(row.id)).toEqual(['published']);
            // A second entry, because this is a second run — which is exactly
            // what the audit trail should say.
            expect(afterRefresh.historyWrites.get(row.id)).toHaveLength(1);
        });
    });

    /**
     * A ROW THAT PASSED, AND THEN CHANGED BEFORE THE PASS CAME BACK.
     *
     * The judgement-skipping rule is "this run already judged this food", so on
     * its own it would let a row judged by attempt 1, then rewritten by an
     * import, be skipped by attempt 2 and published on facts nobody checked.
     * What stops that is a composition of three things, and these cases are
     * that composition rather than any one of them:
     *
     *   * the exclusive stage lock means an import cannot land DURING a pass,
     *     only between two invocations of it (proven against PostgreSQL below);
     *   * an import that SUCCEEDED changes the catalog input, so the next
     *     invocation claims a different key and judges the row afresh;
     *   * an import that failed or was abandoned does NOT change the input — so
     *     the row is skipped — but the release prerequisite refuses on that
     *     ledger, so the stale judgement cannot be exported.
     *
     * Both halves are asserted, because the safety of the second depends
     * entirely on the refusal and a test of the skip alone would read as a bug.
     */
    describe('a row whose facts changed after it passed', () => {
        const fullOptions = validateOptions();

        /** The nutrients an import would write back, with the version bump that goes with them. */
        const rewritten = (row: ValidationFoodRow): ValidationFoodRow => ({
            ...row,
            // Impossible per 100 g, so a pass that DOES judge these facts
            // rejects the row — which is how "were they judged?" is read off
            // the verdict rather than inferred from a call count.
            protein_g: 500,
            nutrition_version: row.nutrition_version + 1,
            publication_status: 'candidate',
        });

        it('judges the new facts under a new run when the import that wrote them succeeded', async () => {
            const row = rowAt(1);

            const first = inMemoryValidateDb([row]);
            const initial = await run(first, fullOptions);
            expect(initial.outcome.alreadyCompleted).toBe(false);
            expect(first.statusWrites.get(row.id)).toEqual(['published']);

            // The import lands between the two invocations, succeeds, and
            // leaves the food carrying nutrients the earlier verdict never saw.
            await prisma.catalog_import_runs.create({
                data: {
                    kind: 'usda_import',
                    manifest_version: 'rewrote-the-row',
                    status: 'succeeded',
                    started_at: new Date('2026-09-14T11:00:00.000Z'),
                    finished_at: new Date('2026-09-14T11:05:00.000Z'),
                },
            });

            const mutated = rewritten(first.store.get(row.id) as ValidationFoodRow);
            const second = inMemoryValidateDb([mutated]);
            const after = await run(second, fullOptions);

            expect(after.outcome.alreadyCompleted).toBe(false);
            expect(after.outcome.runId).not.toBe(initial.outcome.runId);
            // Judged again, and on the NEW facts: 500 g of protein per 100 g
            // fails the mass check, so the row is rejected rather than left
            // published on the strength of the old verdict.
            expect(second.historyWrites.get(row.id)).toHaveLength(1);
            expect(second.statusWrites.get(row.id)).toEqual(['rejected']);
        });

        it('skips the row when the import left no completed record — and the release then refuses', async () => {
            const row = rowAt(1);

            const first = inMemoryValidateDb([row, rowAt(2)], { failOnId: rowAt(2).id });
            await expect(run(first, fullOptions)).rejects.toThrow('interrupted while judging');
            expect(first.statusWrites.get(row.id)).toEqual(['published']);

            // A crashed import: the row is left 'running', so it names no
            // completed graph and the catalog input is unchanged.
            await prisma.catalog_import_runs.create({
                data: {
                    kind: 'usda_import',
                    manifest_version: 'crashed-mid-write',
                    status: 'running',
                    started_at: new Date('2026-09-14T11:00:00.000Z'),
                },
            });

            const mutated = rewritten(first.store.get(row.id) as ValidationFoodRow);
            const second = inMemoryValidateDb([mutated, first.store.get(rowAt(2).id) as ValidationFoodRow]);
            const resumed = await run(second, fullOptions);

            // Same run, so the food this run already judged is skipped. Its
            // rewritten facts therefore stand on the earlier verdict — which is
            // safe only because of the assertion that follows.
            expect(resumed.outcome.runId).toBe(
                (
                    await prisma.catalog_import_runs.findFirstOrThrow({
                        where: {
                            kind: 'validation',
                            manifest_version: validationRunScope(
                                coveragePlan.coveragePlanVersion,
                                fullOptions,
                                NO_CATALOG_INPUT,
                            ),
                        },
                        select: { id: true },
                    })
                ).id,
            );
            expect(second.historyWrites.has(row.id)).toBe(false);

            // THE GUARANTEE. That ledger cannot be released: the import is open,
            // so the export would freeze a graph mid-write, and the refusal
            // names the command that settles it.
            const ledger = (await loadPipelineRuns(prisma as unknown as ReleaseDb)) as ReleaseRunRow[];
            const reason = releaseStalenessReason(
                ledger,
                canonicalValidationRunKey(
                    coveragePlan.coveragePlanVersion,
                    catalogInputIdentity(ledger as CatalogInputRunRow[]),
                ),
                silentLogger,
            );

            expect(reason).not.toBeNull();
            expect(reason).toContain('usda_import run for crashed-mid-write');
            expect(reason).toContain('still marked running');
            expect(reason).toContain('npm run catalog:import');
        });
    });

    /**
     * THE DEADLOCK A KEY THAT NAMES ITS INPUT WOULD OTHERWISE CREATE.
     *
     * Keying the run on the catalog input is what makes a refresh new work, and
     * it has one consequence that has to be handled rather than accepted: a
     * pass interrupted BEFORE an import can never be resumed, because
     * re-running the stage now claims a different key and nothing will ever
     * come back for the old one. Left alone that row is 'running' for good — and
     * catalog-release refuses on any open mutating run, naming
     * "npm run catalog:validate" as the way to settle it, which is advice that
     * cannot work if the stage claims a different key every time.
     *
     * So the stage settles exactly those rows, and the refusal's remedy holds.
     * The narrowness is the substance of the rule: settling a row for the
     * CURRENT input would close a concurrent attempt's work, and settling one
     * under another coverage plan would reach into a deliberate policy change.
     */
    describe('a pass settles validation runs that can never be resumed', () => {
        const fullOptions = validateOptions();
        const currentKey = validationRunScope(coveragePlan.coveragePlanVersion, fullOptions, NO_CATALOG_INPUT);
        const currentInputPart = validationRunKeyInputPart(currentKey);
        const otherInputKey = canonicalValidationRunKey(
            coveragePlan.coveragePlanVersion,
            'usda_import:manifest-that-was-replaced:2026-01-01T00:00:00.000Z',
        );

        const openValidationRun = async (manifestVersion: string): Promise<string> =>
            (await openRun(prisma, { kind: 'validation', manifestVersion })).id;

        const statusOf = async (id: string): Promise<string> =>
            (await prisma.catalog_import_runs.findFirstOrThrow({ where: { id }, select: { status: true } })).status;

        const settle = async (): Promise<number> =>
            settleUnresumableValidationRuns({
                runDb: prisma,
                coveragePlanVersion: coveragePlan.coveragePlanVersion,
                currentInputPart,
                logger: silentLogger,
                now: () => FIXED_NOW,
            });

        it('closes an open run whose key names a catalog input that is gone', async () => {
            const stranded = await openValidationRun(otherInputKey);

            expect(await settle()).toBe(1);
            expect(await statusOf(stranded)).toBe('failed');
        });

        it('records WHY on the run it closed, because nobody cancelled it', async () => {
            const stranded = await openValidationRun(otherInputKey);
            await settle();

            const { log } = await prisma.catalog_import_runs.findFirstOrThrow({
                where: { id: stranded },
                select: { log: true },
            });

            // An operator meeting a 'failed' row with no explanation has no way
            // to tell an abandoned pass from a settled one. The explanation is
            // the CLASS and the CODE, which say exactly that and say it to a
            // reader's tooling as well as to a reader: this run's catalog input
            // was superseded, so it was closed rather than abandoned. The
            // rendered sentence is not stored, because the same field would
            // then carry a driver's or a vendor's prose on every failure that
            // is not this one — see `safeError` in `scripts/lib/logger.ts`.
            expect(JSON.stringify(log)).toContain('ValidationRunSupersededError');
            expect(JSON.stringify(log)).toContain('validation_run_superseded');
            expect(JSON.stringify(log)).not.toContain('"message"');
        });

        it('leaves an open run for the CURRENT input alone, which is resumable work or a live attempt', async () => {
            const mine = await openValidationRun(currentKey);

            expect(await settle()).toBe(0);
            expect(await statusOf(mine)).toBe('running');
        });

        it('leaves an open run under a different coverage plan alone', async () => {
            const otherPlan = await openValidationRun(
                canonicalValidationRunKey('some-other-plan-version', 'usda_import:x:2026-01-01T00:00:00.000Z'),
            );

            expect(await settle()).toBe(0);
            expect(await statusOf(otherPlan)).toBe('running');
        });

        it('touches only OPEN runs: a settled one for a gone input keeps its outcome', async () => {
            const done = await openValidationRun(otherInputKey);
            await finishRun(prisma, done, 'succeeded', { counts: { considered: 3 } });

            expect(await settle()).toBe(0);
            expect(await statusOf(done)).toBe('succeeded');
        });

        it('settles every stranded run, not just the first', async () => {
            const first = await openValidationRun(otherInputKey);
            const second = await openValidationRun(
                canonicalValidationRunKey(
                    coveragePlan.coveragePlanVersion,
                    'ai_generation:another-replaced-input:2026-02-01T00:00:00.000Z',
                ),
            );

            expect(await settle()).toBe(2);
            expect(await statusOf(first)).toBe('failed');
            expect(await statusOf(second)).toBe('failed');
        });

        it('runs as part of an ordinary pass, so the release refusal names a remedy that works', async () => {
            const stranded = await openValidationRun(otherInputKey);

            // The refusal an operator is looking at before doing anything.
            const before = (await loadPipelineRuns(prisma as unknown as ReleaseDb)) as ReleaseRunRow[];
            expect(
                releaseStalenessReason(
                    before,
                    canonicalValidationRunKey(
                        coveragePlan.coveragePlanVersion,
                        catalogInputIdentity(before as CatalogInputRunRow[]),
                    ),
                    silentLogger,
                ),
            ).toContain('npm run catalog:validate');

            // Which is exactly this — no flag, no argument, the stage as the
            // message tells them to run it.
            const fake = inMemoryValidateDb([rowAt(1)]);
            const { outcome } = await run(fake, fullOptions);

            expect(outcome.alreadyCompleted).toBe(false);
            expect(await statusOf(stranded)).toBe('failed');

            // And the open-run refusal is gone: what remains is this pass's own
            // succeeded run, which is the canonical one for this catalog.
            const after = (await loadPipelineRuns(prisma as unknown as ReleaseDb)) as ReleaseRunRow[];
            expect(
                releaseStalenessReason(
                    after,
                    canonicalValidationRunKey(
                        coveragePlan.coveragePlanVersion,
                        catalogInputIdentity(after as CatalogInputRunRow[]),
                    ),
                    silentLogger,
                ),
            ).toBeNull();
        });
    });

    /* ---------------------------------------------------------------------- *
     * A STOPPED ADVISORY REVIEW LEAVES WORK THE SAME RUN KEY CAN FINISH.
     *
     * Closing such a run `failed` is only half of what a stopped review needs.
     * The other half is that the work is RETRYABLE: `--review` is part of
     * validationRunScope, so this key is the review pass, and the rows it
     * passed over were judged into `quarantined` — which the default considered
     * filter excludes. Unless the retry widens that filter and exempts the rows
     * it owes from the already-judged filter, raising the cap and running the
     * same command reopens the same failed run and still cannot review them.
     * `--revalidate-quarantined` is not the remedy either: it is in the run
     * scope, so it claims a different run.
     * ---------------------------------------------------------------------- */

    describe('a stopped review is worked off by the same run key', () => {
        const reviewOptions = validateOptions({ categories: [CATEGORY], review: true });
        const reviewRunScope = validationRunScope(
            coveragePlan.coveragePlanVersion,
            reviewOptions,
            NO_CATALOG_INPUT,
        );

        /**
         * A generated candidate held by review-tier flags ALONE, which is the
         * only population `advisoryReviewApplies` accepts: `allergen_status:
         * 'unknown'` is the review-tier flag every AI-generated food carries,
         * and every other check passes.
         */
        const reviewableRow = (ordinal: number): ValidationFoodRow =>
            validationRow({
                id: `00000000-0000-4000-8000-0000000009${String(ordinal).padStart(2, '0')}`,
                source_key: `ai:${CATEGORY}:reviewable ${ordinal}:cooked`,
                canonical_name: `reviewable ${ordinal}`,
                display_name: `Reviewable ${ordinal}`,
                food_state: 'cooked',
                identity_source: 'ai_generated',
                allergen_status: 'unknown',
                allergen_tags: [],
                catalog_validation_records: {
                    id: `record-9${ordinal}`,
                    history: [],
                    canonical_identity: {
                        source_key: `ai:${CATEGORY}:reviewable ${ordinal}:cooked`,
                        curator_review_required: false,
                    },
                    nutrition_assumptions: null,
                    llm_review: null,
                    identity_evidence: identityEvidence(`reviewable ${ordinal}`),
                },
            });

        /** A ledger whose reservation refuses: the shared cap is spent. */
        const exhaustedBudget = (): ValidationBudget => ({
            reserve: async () => {
                throw new ModelBudgetError('budget_exhausted', 'CATALOG_MODEL_CALL_BUDGET of 0 is exhausted', 0, 0);
            },
            record: async () => undefined,
        });

        /** A ledger with headroom, counting what it was asked to spend. */
        const workingBudget = (spend: { reserved: number; recorded: number }): ValidationBudget => ({
            reserve: async () => {
                spend.reserved += 1;
                return { reserved: spend.reserved, remaining: 100 - spend.reserved };
            },
            record: async () => {
                spend.recorded += 1;
            },
        });

        const runReview = async (
            fake: FakeValidateDb,
            seam: { budget: ValidationBudget; calls: string[]; confirm: boolean },
        ): Promise<{ outcome: Awaited<ReturnType<typeof runValidation>>; reports: unknown[] }> => {
            const reports: unknown[] = [];
            const deps = {
                db: fake.db,
                runDb: prisma,
                coveragePlan,
                options: reviewOptions,
                logger: silentLogger,
                now: () => FIXED_NOW,
                writeReport: (report: unknown) => {
                    reports.push(report);
                },
                review: {
                    call: async (_system: string, userContent: string) => {
                        seam.calls.push(userContent);
                        // `confirmed_checks: []` is the answer that LIFTS the
                        // held flag; naming the flag confirms it. Either way the
                        // review is COMPLETE, which is what settles the debt.
                        return { confirmed_checks: seam.confirm ? ['allergens_unknown'] : [] };
                    },
                } as ValidationReviewClient,
                budget: seam.budget,
                reviewModel: 'test/review-model',
                modelCallBudget: 100,
            } as unknown as RunValidationDeps;

            return { outcome: await runValidation(deps), reports };
        };

        const reviewRun = async (): Promise<{ status: string; cursor: Record<string, unknown> } | null> => {
            const row = await prisma.catalog_import_runs.findFirst({
                where: { kind: 'validation', manifest_version: reviewRunScope },
            });
            return row === null
                ? null
                : { status: row.status, cursor: (row.cursor ?? {}) as Record<string, unknown> };
        };

        it('stops, fails and names the debt, then settles it when the same command is re-run', async () => {
            const rows = [reviewableRow(1), reviewableRow(2)];
            const exhausted = inMemoryValidateDb(rows);
            const firstCalls: string[] = [];

            const first = await runReview(exhausted, {
                budget: exhaustedBudget(),
                calls: firstCalls,
                confirm: true,
            });

            // NOTHING WAS SPENT AND NOTHING WAS REVIEWED, and the pass is not a
            // completed review of its set.
            expect(firstCalls).toHaveLength(0);
            expect(first.outcome.unresolvedReviews).toBe(2);
            expect(first.outcome.reviewStopReason).toBe('budget_exhausted');
            expect([...exhausted.store.values()].map((row) => row.publication_status)).toEqual([
                'quarantined',
                'quarantined',
            ]);

            const afterFirst = await reviewRun();
            expect(afterFirst?.status).toBe('failed');
            expect(afterFirst?.cursor.reviewUnresolved).toEqual(rows.map((row) => row.source_key).sort());
            expect(afterFirst?.cursor.reviewUnresolvedOverflow).toBe(0);
            // The cause is durable, so a later attempt reports the one that
            // created the debt rather than one of its own.
            expect(afterFirst?.cursor.reviewStopCause).toBe('budget_exhausted');

            // THE IDENTICAL COMMAND, with the cap raised. No new flag, no new
            // argument — so it claims this same run key and continues this same
            // failed run.
            const spend = { reserved: 0, recorded: 0 };
            const retryCalls: string[] = [];
            const retried = inMemoryValidateDb([...exhausted.store.values()]);
            const second = await runReview(retried, {
                budget: workingBudget(spend),
                calls: retryCalls,
                confirm: false,
            });

            // The rows the first attempt quarantined were reviewed after all:
            // the retry widened its considered set because the debt exists, and
            // re-judged exactly the rows it owed.
            expect(retryCalls).toHaveLength(2);
            expect(spend).toEqual({ reserved: 2, recorded: 2 });
            expect(second.outcome.unresolvedReviews).toBe(0);
            expect(second.outcome.reviewStopReason).toBeNull();
            expect(second.outcome.unjudged).toBe(0);

            const afterSecond = await reviewRun();
            expect(afterSecond?.status).toBe('succeeded');
            // AND THE DEBT IS GONE FROM THE ROW, so no later attempt widens its
            // set for work that no longer exists.
            expect(afterSecond?.cursor.reviewUnresolved).toEqual([]);
            expect(afterSecond?.cursor.reviewUnresolvedOverflow).toBe(0);
            expect(afterSecond?.cursor.reviewStopCause).toBeNull();
        });

        it('works off debt the cursor could not name, which a count alone never could', async () => {
            // THE STATE A STOPPED REVIEW OF MORE FOODS THAN THE CURSOR CAN NAME
            // LEAVES BEHIND. `reviewUnresolved` is capped at
            // REVIEW_UNRESOLVED_CURSOR_LIMIT names and the remainder is only
            // counted, so these two rows stand for the ones past that cap:
            // named nowhere, and recoverable only from the review their own
            // judgement recorded. Simulated rather than driven with 501 rows so
            // the case states the mechanism instead of the constant.
            const rows = [reviewableRow(1), reviewableRow(2)];
            const exhausted = inMemoryValidateDb(rows);
            const firstCalls: string[] = [];
            await runReview(exhausted, { budget: exhaustedBudget(), calls: firstCalls, confirm: true });

            await prisma.catalog_import_runs.updateMany({
                where: { kind: 'validation', manifest_version: reviewRunScope },
                data: {
                    cursor: {
                        fingerprint: 'stale-fingerprint',
                        nextIndex: 0,
                        unjudged: [],
                        reviewUnresolved: [],
                        reviewUnresolvedOverflow: 2,
                        reviewStopCause: 'budget_exhausted',
                    },
                },
            });

            const spend = { reserved: 0, recorded: 0 };
            const retryCalls: string[] = [];
            const retried = inMemoryValidateDb([...exhausted.store.values()]);
            const second = await runReview(retried, {
                budget: workingBudget(spend),
                calls: retryCalls,
                confirm: false,
            });

            // Both unnamed rows were found and reviewed, and the count that
            // stood for them is discharged rather than carried for ever.
            expect(retryCalls).toHaveLength(2);
            expect(second.outcome.unresolvedReviews).toBe(0);
            const after = await reviewRun();
            expect(after?.status).toBe('succeeded');
            expect(after?.cursor.reviewUnresolvedOverflow).toBe(0);
        });

        it('keeps reporting the cause that created a debt it cannot reach', async () => {
            const rows = [reviewableRow(1)];
            const exhausted = inMemoryValidateDb(rows);
            await runReview(exhausted, { budget: exhaustedBudget(), calls: [], confirm: true });

            // The row is gone from the catalog before the retry, so the debt is
            // genuinely beyond this attempt. Nothing stops the review THIS time
            // — there is nothing to review — and without the carried cause the
            // closure would report a missing review client for a run whose
            // budget was exhausted.
            const spend = { reserved: 0, recorded: 0 };
            const retryCalls: string[] = [];
            const second = await runReview(inMemoryValidateDb([]), {
                budget: workingBudget(spend),
                calls: retryCalls,
                confirm: false,
            });

            expect(retryCalls).toHaveLength(0);
            expect(second.outcome.unresolvedReviews).toBe(1);
            expect(second.outcome.reviewStopReason).toBe('budget_exhausted');
            expect((await reviewRun())?.status).toBe('failed');
        });
    });
});


/**
 * THE STAGE LOCK: WHAT ONE PROCESS MAY DO TO THE CATALOG GRAPH WHILE ANOTHER IS
 * WRITING IT.
 *
 * The run claim already stopped two processes from sharing one run row, and
 * `checkpoint.ts`'s own THE CLAIM said what it could not do: the claim lock is
 * transaction-scoped, so it "does NOT grant exclusive processing for the run's
 * lifetime" — and no entry point took a lock that did. Two stages could
 * therefore write the graph at once under two different run rows, which is the
 * window this stage lock closes.
 *
 * The decisions are pure and are checked with no database at all. Exclusion
 * itself is not a decision but a PostgreSQL behaviour, so it is checked against
 * the real test database: a fake that returned `false` from `try_lock` would
 * prove only that the fake was written to.
 */
describe('the stage lock', () => {
    describe('the mode each stage takes the graph in', () => {
        it.each(['usda_import', 'ai_generation', 'validation', 'release_load'] as const)(
            '%s writes the graph, so it takes the lock exclusively',
            (stage) => {
                expect(catalogStageLockMode(stage)).toBe('exclusive');
            },
        );

        it('an export reads the graph, so it takes the lock shared and two exports can run together', () => {
            expect(catalogStageLockMode('release')).toBe('shared');
        });

        // The search benchmark is the second read-only stage: it measures search
        // against the published graph and writes the acceptance-evidence report,
        // so it must not observe a graph a mutator is rewriting, and two
        // benchmark runs of one database still do not contend.
        it('the benchmark reads the graph, so it takes the lock shared as well', () => {
            expect(catalogStageLockMode('benchmark')).toBe('shared');
        });

        it('assumes an unknown stage writes, which is the safe direction', () => {
            expect(catalogStageLockMode('a_stage_this_table_has_not_heard_of' as never)).toBe('exclusive');
        });

        it('states a mode for every stage name, so no stage can reach the graph unclaimed', () => {
            const stages: readonly string[] = [
                'usda_import',
                'ai_generation',
                'validation',
                'release_load',
                'release',
                'benchmark',
            ];
            expect(Object.keys(CATALOG_STAGE_LOCK_MODES).sort()).toEqual([...stages].sort());
        });
    });

    describe('the advisory functions a mode maps onto', () => {
        it('pairs the exclusive try-lock with the exclusive unlock', () => {
            expect(catalogStageLockFunctions('exclusive')).toEqual({
                tryLock: 'pg_try_advisory_lock',
                unlock: 'pg_advisory_unlock',
            });
        });

        it('pairs the shared try-lock with the SHARED unlock', () => {
            // Not interchangeable: `pg_advisory_unlock` against a lock taken
            // with the shared function releases nothing and only warns, so a
            // mismatched pair would hold the graph until the process exited.
            expect(catalogStageLockFunctions('shared')).toEqual({
                tryLock: 'pg_try_advisory_lock_shared',
                unlock: 'pg_advisory_unlock_shared',
            });
        });

        it('never blocks: every acquisition goes through a try-lock', () => {
            for (const mode of ['exclusive', 'shared'] as const) {
                expect(catalogStageLockFunctions(mode).tryLock.startsWith('pg_try_')).toBe(true);
            }
        });
    });

    describe('the key every stage contends on', () => {
        it('is one class id and one object name for the whole graph', () => {
            expect(catalogStageLockKey()).toEqual({ classId: 0x434154, objectName: 'catalog-graph' });
        });

        it('takes no stage argument, because a per-stage key would not exclude anything', () => {
            expect(catalogStageLockKey.length).toBe(0);
        });
    });

    describe('the bounds on how long acquisition may wait', () => {
        it.each([
            ['undefined', undefined],
            ['zero', 0],
            ['negative', -1],
            ['NaN, which compares false against every bound', Number.NaN],
        ])('refuses at once for %s', (_label, waitMs) => {
            expect(normalizeStageLockWaitMs(waitMs as number | undefined)).toBe(0);
        });

        it('honours a requested wait', () => {
            expect(normalizeStageLockWaitMs(1_500)).toBe(1_500);
        });

        it('floors a fractional wait to whole milliseconds', () => {
            expect(normalizeStageLockWaitMs(1_500.9)).toBe(1_500);
        });

        it('caps an hour, and refuses to honour Infinity as "wait forever"', () => {
            expect(normalizeStageLockWaitMs(Number.POSITIVE_INFINITY)).toBe(3_600_000);
            expect(normalizeStageLockWaitMs(9_999_999)).toBe(3_600_000);
        });

        it.each([
            ['undefined', undefined],
            ['zero, which would be a busy loop', 0],
            ['a sub-millisecond interval', 0.4],
            ['Infinity', Number.POSITIVE_INFINITY],
            ['NaN', Number.NaN],
        ])('falls back to the default poll interval for %s', (_label, pollIntervalMs) => {
            expect(normalizeStageLockPollMs(pollIntervalMs as number | undefined)).toBe(500);
        });

        it('honours a requested poll interval', () => {
            expect(normalizeStageLockPollMs(50)).toBe(50);
        });
    });

    describe('acquisition drives the injected connection', () => {
        interface FakeConnection extends CatalogStageLockConnection {
            readonly statements: { text: string; values: readonly unknown[] }[];
            readonly ended: () => number;
        }

        /** @param results one entry per try-lock attempt, in order. */
        const fakeConnection = (results: readonly (boolean | null)[]): FakeConnection => {
            const statements: { text: string; values: readonly unknown[] }[] = [];
            let attempt = 0;
            let ends = 0;

            return {
                statements,
                ended: () => ends,
                connect: async () => undefined,
                query: async <TRow>(text: string, values?: readonly unknown[]) => {
                    statements.push({ text, values: values ?? [] });
                    if (text.includes('pg_try_advisory_lock')) {
                        const locked = results[Math.min(attempt, results.length - 1)] ?? null;
                        attempt += 1;
                        return { rows: [{ locked }] as unknown as TRow[] };
                    }
                    return { rows: [{ released: true }] as unknown as TRow[] };
                },
                end: async () => {
                    ends += 1;
                },
            };
        };

        it('binds the class id and the name, and computes the object id with hashtext IN PostgreSQL', async () => {
            const connection = fakeConnection([true]);
            const lock = await acquireCatalogStageLock({
                stage: 'usda_import',
                openConnection: () => connection,
            });

            const [attempt] = connection.statements;
            expect(attempt.text).toContain('pg_try_advisory_lock($1::int4, hashtext($2::text))');
            // Two arguments, not one: the one-argument advisory keyspace is
            // where the request path's per-user lock lives, and an hours-long
            // stage lock colliding with it would block a user's own write.
            expect(attempt.values).toEqual([0x434154, 'catalog-graph']);
            expect(lock.stage).toBe('usda_import');
            expect(lock.mode).toBe('exclusive');

            await lock.release();
        });

        it('releases with the matching function and closes the connection', async () => {
            const connection = fakeConnection([true]);
            const lock = await acquireCatalogStageLock({ stage: 'release', openConnection: () => connection });

            expect(lock.mode).toBe('shared');
            await lock.release();

            expect(connection.statements.some(({ text }) => text.includes('pg_advisory_unlock_shared'))).toBe(true);
            expect(connection.ended()).toBe(1);
        });

        it('is safe to release twice, and unlocks only once', async () => {
            const connection = fakeConnection([true]);
            const lock = await acquireCatalogStageLock({ stage: 'validation', openConnection: () => connection });

            await lock.release();
            await expect(lock.release()).resolves.toBeUndefined();

            const unlocks = connection.statements.filter(({ text }) => text.includes('pg_advisory_unlock'));
            expect(unlocks).toHaveLength(1);
            expect(connection.ended()).toBe(1);
        });

        it('refuses at once when the lock is held and the default wait applies', async () => {
            const connection = fakeConnection([false]);
            const sleep = jest.fn(async () => undefined);

            await expect(
                acquireCatalogStageLock({ stage: 'validation', openConnection: () => connection, sleep }),
            ).rejects.toMatchObject({ code: 'catalog_stage_locked' });

            // One attempt, no sleep, and the connection closed: a refused lock
            // must not leave a session behind.
            expect(connection.statements.filter(({ text }) => text.includes('pg_try_advisory_lock'))).toHaveLength(1);
            expect(sleep).not.toHaveBeenCalled();
            expect(connection.ended()).toBe(1);
        });

        it('throws CheckpointError, so the entry point reports a code rather than matching a message', async () => {
            const connection = fakeConnection([false]);

            const error = await acquireCatalogStageLock({
                stage: 'usda_import',
                openConnection: () => connection,
            }).catch((thrown: unknown) => thrown);

            expect(error).toBeInstanceOf(CheckpointError);
            expect((error as CheckpointError).code).toBe('catalog_stage_locked');
        });

        it('polls while a bounded wait is left, then gives up on the deadline', async () => {
            const connection = fakeConnection([false, false, true]);
            let clock = 0;
            const sleep = jest.fn(async (ms: number) => {
                clock += ms;
            });

            const lock = await acquireCatalogStageLock({
                stage: 'validation',
                waitMs: 1_000,
                pollIntervalMs: 100,
                openConnection: () => connection,
                now: () => new Date(clock),
                sleep,
            });

            expect(sleep).toHaveBeenCalledTimes(2);
            expect(sleep).toHaveBeenLastCalledWith(100);
            await lock.release();
        });

        it('stops on the deadline rather than polling forever against a clock that never moves', async () => {
            // A fake clock that does not advance is exactly the case an
            // elapsed-time deadline alone cannot terminate, so the attempt
            // count is the second bound.
            const connection = fakeConnection([false]);
            const sleep = jest.fn(async () => undefined);

            await expect(
                acquireCatalogStageLock({
                    stage: 'validation',
                    waitMs: 1_000,
                    pollIntervalMs: 100,
                    openConnection: () => connection,
                    now: () => new Date(0),
                    sleep,
                }),
            ).rejects.toMatchObject({ code: 'catalog_stage_locked' });

            expect(sleep.mock.calls.length).toBeLessThanOrEqual(11);
            expect(connection.ended()).toBe(1);
        });

        it('treats a null answer from the lock function as "not acquired"', async () => {
            const connection = fakeConnection([null]);

            await expect(
                acquireCatalogStageLock({ stage: 'validation', openConnection: () => connection }),
            ).rejects.toMatchObject({ code: 'catalog_stage_locked' });
        });

        it('closes the connection when connecting fails, and reports the connection error', async () => {
            const connection = fakeConnection([true]);
            const failing: CatalogStageLockConnection = {
                ...connection,
                connect: async () => {
                    throw new Error('connection refused');
                },
            };

            await expect(
                acquireCatalogStageLock({ stage: 'validation', openConnection: () => failing }),
            ).rejects.toThrow('connection refused');
        });
    });

    describe('withCatalogStageLock', () => {
        const alwaysAcquires = (): CatalogStageLockConnection & { unlocks: () => number } => {
            let unlocks = 0;
            return {
                unlocks: () => unlocks,
                connect: async () => undefined,
                query: async <TRow>(text: string) => {
                    if (text.includes('pg_advisory_unlock')) {
                        unlocks += 1;
                    }
                    return { rows: [{ locked: true, released: true }] as unknown as TRow[] };
                },
                end: async () => undefined,
            };
        };

        it('runs the work while holding the lock and returns its value', async () => {
            const connection = alwaysAcquires();
            const held: string[] = [];

            const result = await withCatalogStageLock(
                { stage: 'usda_import', openConnection: () => connection },
                async (lock) => {
                    held.push(`${lock.stage}:${lock.mode}`);
                    return 'imported';
                },
            );

            expect(result).toBe('imported');
            expect(held).toEqual(['usda_import:exclusive']);
            expect(connection.unlocks()).toBe(1);
        });

        it('releases the lock when the work throws, so a failed stage does not hold the graph', async () => {
            const connection = alwaysAcquires();

            await expect(
                withCatalogStageLock({ stage: 'validation', openConnection: () => connection }, async () => {
                    throw new Error('the stage failed');
                }),
            ).rejects.toThrow('the stage failed');

            expect(connection.unlocks()).toBe(1);
        });

        it('does not run the work at all when the lock is refused', async () => {
            const refuses: CatalogStageLockConnection = {
                connect: async () => undefined,
                query: async <TRow>() => ({ rows: [{ locked: false }] as unknown as TRow[] }),
                end: async () => undefined,
            };
            const work = jest.fn(async () => 'should not run');

            await expect(
                withCatalogStageLock({ stage: 'validation', openConnection: () => refuses }, work),
            ).rejects.toMatchObject({ code: 'catalog_stage_locked' });

            expect(work).not.toHaveBeenCalled();
        });
    });

    /**
     * EXCLUSION ITSELF, against PostgreSQL.
     *
     * Everything above drives an injected connection, which can prove what
     * statements are issued but not that the database refuses the second
     * caller. These take the real lock on the test database. They are the
     * WIRING case the file's own rules allow a database for: the guarantee is
     * PostgreSQL's, and no fake can stand in for it.
     */
    describe('exclusion, against PostgreSQL', () => {
        const held: { release(): Promise<void> }[] = [];

        const take = async (
            stage: 'usda_import' | 'validation' | 'release' | 'release_load',
        ): Promise<{ release(): Promise<void> }> => {
            const lock = await acquireCatalogStageLock({ stage });
            held.push(lock);
            return lock;
        };

        const refused = async (stage: 'usda_import' | 'validation' | 'release'): Promise<unknown> =>
            acquireCatalogStageLock({ stage }).catch((error: unknown) => error);

        afterEach(async () => {
            while (held.length > 0) {
                await held.pop()?.release();
            }
        });

        const advisoryLockCount = async (): Promise<number> => {
            // `count(*)::int` rather than the bigint PostgreSQL returns by
            // default: the build targets below ES2020, where a BigInt literal
            // is not available to compare against.
            //
            // SCOPED TO THIS DATABASE, which is not optional. pg_locks is a
            // CLUSTER-wide view, and advisory locks in it carry the database
            // they were taken in; the catalog classid is the same constant in
            // every database. Without this predicate the count includes locks
            // held by another database on the same server — a second checkout
            // running this very suite — so "did MY holder release?" would be
            // answered by somebody else's lock and fail at random.
            const rows = await prisma.$queryRaw<{ count: number }[]>`
                SELECT count(*)::int AS count
                FROM pg_locks
                WHERE locktype = 'advisory'
                  AND classid = ${0x434154}::int4
                  AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
            `;
            return Number(rows[0]?.count ?? 0);
        };

        it('refuses a second mutating stage while one holds the graph exclusively', async () => {
            await take('usda_import');

            expect(await refused('validation')).toMatchObject({ code: 'catalog_stage_locked' });
        });

        it('refuses an export while a mutating stage is writing the graph', async () => {
            await take('validation');

            expect(await refused('release')).toMatchObject({ code: 'catalog_stage_locked' });
        });

        it('lets two exports read the graph at the same time', async () => {
            await take('release');

            const second = await acquireCatalogStageLock({ stage: 'release' });
            held.push(second);
            expect(second.mode).toBe('shared');
        });

        it('refuses a mutating stage while an export is reading the graph', async () => {
            await take('release');

            expect(await refused('usda_import')).toMatchObject({ code: 'catalog_stage_locked' });
        });

        it('frees the graph when the holder releases', async () => {
            const first = await acquireCatalogStageLock({ stage: 'usda_import' });
            await first.release();

            const second = await acquireCatalogStageLock({ stage: 'validation' });
            held.push(second);
            expect(second.stage).toBe('validation');
        });

        it('leaves no advisory lock behind once every holder has released', async () => {
            const lock = await acquireCatalogStageLock({ stage: 'validation' });
            expect(await advisoryLockCount()).toBeGreaterThan(0);

            await lock.release();
            expect(await advisoryLockCount()).toBe(0);
        });

        it('does not contend with the request path, which locks in the ONE-argument keyspace', async () => {
            // §0.5.1's per-user lock is `pg_advisory_xact_lock(hashtext(...))`.
            // The two keyspaces are distinct in PostgreSQL, and this is what
            // keeps an hours-long catalog stage from blocking a user's write
            // through a hashtext collision.
            await take('usda_import');

            const granted = await prisma.$queryRaw<{ locked: boolean }[]>`
                SELECT pg_try_advisory_lock(hashtext('catalog-graph')) AS locked
            `;
            expect(granted[0]?.locked).toBe(true);
            await prisma.$queryRaw`SELECT pg_advisory_unlock(hashtext('catalog-graph'))`;
        });

        it('surfaces the connection failure when the lock cannot reach a database, never "locked"', async () => {
            const error = await acquireCatalogStageLock({
                stage: 'validation',
                connectionString: 'postgresql://soh:soh@127.0.0.1:1/definitely-not-there',
            }).catch((thrown: unknown) => thrown);

            // The driver's own error, reported as itself. Reading an
            // unreachable database as `catalog_stage_locked` would tell an
            // operator to go and find a holder that does not exist. The class
            // is the driver's, so the assertion is on the substance rather than
            // on `instanceof Error`, which compares unequal across realms.
            expect(typeof (error as { message?: unknown }).message).toBe('string');
            expect((error as { code?: string }).code).not.toBe('catalog_stage_locked');
        });

        it('refuses a lock it has no connection string for, rather than letting the driver choose one', async () => {
            // `new Client({connectionString: undefined})` falls back to the
            // libpq environment and can connect somewhere nobody named, which
            // for an exclusive catalog-graph lock is the worst possible
            // silent success.
            const error = await acquireCatalogStageLock({
                stage: 'validation',
                connectionString: '   ',
            }).catch((thrown: unknown) => thrown);

            expect(error).toBeInstanceOf(CheckpointError);
            expect((error as CheckpointError).code).toBe('catalog_stage_lock_unavailable');
        });
    });
});

/**
 * THE EXPORT'S OWN REFUSAL.
 *
 * The shared lock keeps a live mutator from overlapping an export. It cannot
 * speak for two other situations, and both would ship a catalog nobody has
 * fully judged:
 *
 *   * a stage that CRASHED and left its run row marked running — that work is
 *     genuinely half-done; and
 *   * a validation row that is not the canonical one for THIS catalog. A run key
 *     names the coverage plan and the catalog input it judged, and a restricted
 *     pass carries a `+scope:` suffix precisely because it judged a fraction of
 *     the plan. Choosing "the newest validation row" lets an old full pass, then
 *     an import, then a category-only pass read as ready — the release then
 *     freezes a catalog most of which was judged before the import touched it,
 *     stamped with the current coverage plan version.
 *
 * Pure over the ledger rows, so every rule is checkable with no database.
 */
/**
 * WHICH ROWS THE REFUSAL GETS TO SEE.
 *
 * The rules below are pure over the rows they are handed, so a row the query
 * filters out is a rule that cannot fire. A FAILED validation attempt of the
 * current catalog is the most important row in the ledger — without it, an
 * earlier success for the same key reads as "validation passed" — so the read
 * is asserted against the real table rather than assumed.
 */
describe('loadPipelineRuns', () => {
    const MARKER = 'load-pipeline-runs-test';

    const clear = async (): Promise<void> => {
        await prisma.catalog_import_runs.deleteMany({ where: { manifest_version: { startsWith: MARKER } } });
    };

    beforeEach(clear);
    afterEach(clear);

    it('returns failed runs as well as succeeded and running ones', async () => {
        const seed = async (kind: string, status: string, finishedAt: Date | null): Promise<void> => {
            await prisma.catalog_import_runs.create({
                data: {
                    kind,
                    manifest_version: `${MARKER}:${kind}:${status}`,
                    status,
                    started_at: new Date('2026-09-14T08:00:00.000Z'),
                    finished_at: finishedAt,
                },
            });
        };

        await seed('validation', 'succeeded', new Date('2026-09-14T09:00:00.000Z'));
        await seed('validation', 'failed', new Date('2026-09-14T10:00:00.000Z'));
        await seed('usda_import', 'running', null);

        const rows = (await loadPipelineRuns(prisma as unknown as ReleaseDb)).filter((row) =>
            row.manifest_version.startsWith(MARKER),
        );

        expect(rows.map((row) => `${row.kind}:${row.status}`).sort()).toEqual([
            'usda_import:running',
            'validation:failed',
            'validation:succeeded',
        ]);
    });
});

describe('releaseStalenessReason', () => {
    const at = (iso: string): Date => new Date(iso);

    const INPUT_AT = '2026-09-14T08:00:00.000Z';
    const PLAN = 'v1';

    /** The ledger row for the ingest that produced the catalog being released. */
    const ingestRow = (overrides: Partial<ReleaseRunRow> = {}): ReleaseRunRow => ({
        kind: 'usda_import',
        manifest_version: 'v1',
        status: 'succeeded',
        finished_at: at(INPUT_AT),
        ...overrides,
    });

    const run = (overrides: Partial<ReleaseRunRow> = {}): ReleaseRunRow => ({
        kind: 'validation',
        manifest_version: 'v1',
        status: 'succeeded',
        finished_at: at('2026-09-14T09:00:00.000Z'),
        ...overrides,
    });

    /**
     * Resolves the expected canonical key from the ledger exactly as runRelease
     * does, so these cases exercise the pairing rather than a key written down
     * beside them.
     */
    const expectedKeyFor = (runs: readonly ReleaseRunRow[]): string =>
        canonicalValidationRunKey(PLAN, catalogInputIdentity(runs as CatalogInputRunRow[]));

    const decide = (runs: readonly ReleaseRunRow[]): string | null =>
        releaseStalenessReason(runs, expectedKeyFor(runs), silentLogger);

    /** The canonical validation row for a ledger — the one that should satisfy the prerequisite. */
    const canonicalValidation = (runs: readonly ReleaseRunRow[], overrides: Partial<ReleaseRunRow> = {}): ReleaseRunRow =>
        run({ manifest_version: expectedKeyFor(runs), ...overrides });

    it('releases a database whose canonical validation is the last thing that ran', () => {
        const ledger = [ingestRow()];

        expect(decide([...ledger, canonicalValidation(ledger)])).toBeNull();
    });

    it('releases a validated database with no ingest of its own (a loaded bundle)', () => {
        const ledger: ReleaseRunRow[] = [];

        expect(decide([...ledger, canonicalValidation(ledger)])).toBeNull();
    });

    it.each(['usda_import', 'ai_generation', 'validation', 'release_load'])(
        'refuses while a %s run is still marked running',
        (kind) => {
            const ledger = [ingestRow()];
            const reason = decide([
                ...ledger,
                canonicalValidation(ledger),
                run({ kind, status: 'running', finished_at: null }),
            ]);

            expect(reason).not.toBeNull();
            expect(reason).toContain(kind);
            expect(reason).toContain('still marked running');
        },
    );

    it.each([
        ['usda_import', 'npm run catalog:import'],
        ['ai_generation', 'npm run catalog:generate'],
        ['validation', 'npm run catalog:validate'],
        ['release_load', 'npm run catalog:load -- --release <release>'],
    ])('names the command that settles an abandoned %s run', (kind, command) => {
        const reason = decide([run({ kind, status: 'running', finished_at: null })]);

        // Without a stated remedy an abandoned row blocks every future release
        // and the operator's only visible option is editing the table by hand.
        expect(reason).toContain(command);
    });

    it('checks the open run BEFORE everything else, because a moving graph makes the rest unanswerable', () => {
        const ledger = [ingestRow()];
        const reason = decide([
            ...ledger,
            canonicalValidation(ledger),
            run({ kind: 'ai_generation', status: 'running', finished_at: null }),
        ]);

        expect(reason).toContain('still marked running');
    });

    it('names the same run every time, whatever order the ledger came back in', () => {
        const open = [
            run({ kind: 'validation', manifest_version: 'v2', status: 'running', finished_at: null }),
            run({ kind: 'usda_import', manifest_version: 'v1', status: 'running', finished_at: null }),
            run({ kind: 'usda_import', manifest_version: 'v0', status: 'running', finished_at: null }),
        ];

        const forwards = releaseStalenessReason(open, 'irrelevant', silentLogger);
        const backwards = releaseStalenessReason([...open].reverse(), 'irrelevant', silentLogger);

        expect(forwards).toBe(backwards);
        expect(forwards).toContain('usda_import run for v0');
        expect(forwards).toContain('3 mutating runs are open');
    });

    it('refuses a database nothing has ever judged', () => {
        expect(decide([ingestRow()])).toContain('no successful catalog:validate run is on record');
    });

    describe('only the canonical validation for this catalog counts', () => {
        it('refuses when the only validation is a category-restricted pass', () => {
            const ledger = [ingestRow()];
            const scopedKey = `${expectedKeyFor(ledger)}+scope:abc123abc123abc1`;

            const reason = decide([...ledger, run({ manifest_version: scopedKey })]);

            expect(reason).not.toBeNull();
            expect(reason).toContain('restricted run');
            expect(reason).toContain('only part of the plan');
            expect(reason).toContain('no --category');
        });

        it('refuses the exact sequence that used to pass: old full pass, newer import, category-only pass', () => {
            // The reproduction from the review. The category-only row is the
            // NEWEST validation and is newer than the import, so an
            // order-only rule sees nothing wrong.
            const oldIngest = ingestRow({ finished_at: at('2026-09-10T08:00:00.000Z') });
            const oldValidation = run({
                manifest_version: canonicalValidationRunKey(PLAN, catalogInputIdentity([oldIngest] as CatalogInputRunRow[])),
                finished_at: at('2026-09-10T09:00:00.000Z'),
            });
            const newIngest = ingestRow({ manifest_version: 'v2', finished_at: at('2026-09-12T08:00:00.000Z') });
            const ledger = [oldIngest, oldValidation, newIngest];
            const categoryOnly = run({
                manifest_version: `${expectedKeyFor(ledger)}+scope:0123456789abcdef`,
                finished_at: at('2026-09-13T09:00:00.000Z'),
            });

            const reason = decide([...ledger, categoryOnly]);

            expect(reason).not.toBeNull();
            expect(reason).toContain('restricted run');
        });

        it('refuses when the only full pass judged a different catalog input', () => {
            const oldIngest = ingestRow({ finished_at: at('2026-09-10T08:00:00.000Z') });
            const oldValidation = run({
                manifest_version: canonicalValidationRunKey(PLAN, catalogInputIdentity([oldIngest] as CatalogInputRunRow[])),
                finished_at: at('2026-09-10T09:00:00.000Z'),
            });
            const newIngest = ingestRow({ manifest_version: 'v2', finished_at: at('2026-09-12T08:00:00.000Z') });

            const reason = decide([oldIngest, oldValidation, newIngest]);

            expect(reason).not.toBeNull();
            expect(reason).toContain('different catalog input');
        });

        it('says a pre-identity run is SILENT about the catalog, not that an import has run since', () => {
            // A validation row recorded before the key named the input. The
            // remedy is one more validation run; telling the operator an import
            // has happened when none has would be a lie the tool tells about
            // its own history.
            const ledger = [ingestRow()];
            const reason = decide([...ledger, run({ manifest_version: PLAN })]);

            expect(reason).not.toBeNull();
            expect(reason).toContain('predate validation runs naming the catalog');
            expect(reason).not.toContain('an import or load has run since');
            expect(reason).toContain('no-op thereafter');
        });

        it('refuses a full pass taken under an older coverage plan, and says so precisely', () => {
            const ledger = [ingestRow()];
            const olderPlan = canonicalValidationRunKey(
                'v0',
                catalogInputIdentity(ledger as CatalogInputRunRow[]),
            );

            const reason = decide([...ledger, run({ manifest_version: olderPlan })]);

            expect(reason).not.toBeNull();
            // Same catalog, different bounds — a different remedy from "an
            // import has run since", so the message must not say that.
            expect(reason).toContain('different coverage plan');
            expect(reason).not.toContain('an import or load has run since');
        });

        it('names the key it wanted, so the operator can see which run is missing', () => {
            const ledger = [ingestRow()];

            expect(decide([...ledger, run({ manifest_version: `${expectedKeyFor(ledger)}+scope:aaaaaaaaaaaaaaaa` })])).toContain(
                expectedKeyFor(ledger),
            );
        });
    });

    describe('a later failed attempt of the canonical run is not hidden', () => {
        it('refuses when the canonical run failed after succeeding', () => {
            const ledger = [ingestRow()];
            const key = expectedKeyFor(ledger);
            const reason = decide([
                ...ledger,
                run({ manifest_version: key, status: 'succeeded', finished_at: at('2026-09-14T09:00:00.000Z') }),
                run({ manifest_version: key, status: 'failed', finished_at: at('2026-09-14T10:00:00.000Z') }),
            ]);

            expect(reason).not.toBeNull();
            expect(reason).toContain('FAILED');
            expect(reason).toContain('kept the status they');
            expect(reason).toContain('catalog:validate again');
        });

        it('releases when the failure came BEFORE the success, which is a retry that worked', () => {
            const ledger = [ingestRow()];
            const key = expectedKeyFor(ledger);

            expect(
                decide([
                    ...ledger,
                    run({ manifest_version: key, status: 'failed', finished_at: at('2026-09-14T09:00:00.000Z') }),
                    run({ manifest_version: key, status: 'succeeded', finished_at: at('2026-09-14T10:00:00.000Z') }),
                ]),
            ).toBeNull();
        });

        it('does not read a failed RESTRICTED attempt as a failed attempt of the canonical run', () => {
            // This rule turns on `manifest_version === expectedKey`, and a
            // `+scope:` row is a different run key — so it must not produce the
            // canonical-failure refusal, whose remedy ("catalog:validate again"
            // resumes that same run) would be wrong for it.
            //
            // The row IS refused, by the restricted-pass rule instead: it
            // finished after the canonical success against this same catalog
            // input and its ledger records no judged/unchanged counts, and a
            // pass commits each food's new status before tallying it, so an
            // absent count cannot show the published set is intact. What this
            // case pins is WHICH rule speaks.
            const ledger = [ingestRow()];
            const key = expectedKeyFor(ledger);

            const reason = decide([
                ...ledger,
                run({ manifest_version: key, status: 'succeeded', finished_at: at('2026-09-14T09:00:00.000Z') }),
                run({
                    manifest_version: `${key}+scope:ffffffffffffffff`,
                    status: 'failed',
                    finished_at: at('2026-09-14T10:00:00.000Z'),
                }),
            ]);

            expect(reason).toContain('restricted catalog:validate run');
            expect(reason).toContain('records no judged/unchanged counts');
            // Not the canonical-failure rule: it never saw this row. Asserted on
            // that rule's own wording, which the restricted refusal's remedy
            // cannot accidentally contain.
            expect(reason).not.toContain('the most recent catalog:validate attempt');
            expect(reason).not.toContain('kept the status they');
            expect(reason).not.toContain('it resumes that same run');
        });
    });

    it('still refuses when an ingest finished after the canonical validation', () => {
        // Belt and braces: the key check above already refuses, because a newer
        // ingest changes the expected key. This states the ordering in the terms
        // an operator recognises for the case where it is the identity that ties.
        const ledger = [ingestRow()];
        const key = expectedKeyFor(ledger);
        const reason = releaseStalenessReason(
            [
                run({ manifest_version: key, finished_at: at('2026-09-14T09:00:00.000Z') }),
                ingestRow({ finished_at: at('2026-09-14T10:00:00.000Z') }),
            ],
            key,
            silentLogger,
        );

        expect(reason).toContain('after the last');
        expect(reason).toContain('catalog:validate');
    });

    it('ignores an unfinished run when judging ORDER, which is why the open-run rule is separate', () => {
        // `finished_at: null` says nothing about order. Were the two rules
        // folded together, this row would be read as an ingest that finished
        // at the epoch.
        const ledger = [ingestRow()];
        const key = expectedKeyFor(ledger);

        expect(
            releaseStalenessReason(
                [
                    run({ manifest_version: key, finished_at: at('2026-09-14T09:00:00.000Z') }),
                    ingestRow({ status: 'succeeded', finished_at: null }),
                ],
                key,
                silentLogger,
            ),
        ).toBeNull();
    });

    /**
     * A GRAPH MUTATOR THAT FAILED AFTER THE VALIDATION.
     *
     * `catalogInputIdentity` counts SUCCEEDED runs only, and says why: a failed
     * ingest left a graph nobody vouched for, so naming it would mint a run key
     * for a half-written catalog. It states outright that the release
     * prerequisite refuses on such a row separately — so this is that rule, and
     * without it the delegation lands nowhere. A run that failed partway still
     * wrote back everything it reached before it died, as candidates.
     */
    describe('a graph mutator that failed after the validation still blocks the release', () => {
        it.each(['usda_import', 'ai_generation', 'release_load'])(
            'refuses when a %s run FAILED after the canonical validation succeeded',
            (kind) => {
                // The failed row does not change the input identity, so the key
                // check passes and this is the only rule left to catch it.
                const ledger = [ingestRow()];
                const key = expectedKeyFor(ledger);
                const withFailure: ReleaseRunRow[] = [
                    ...ledger,
                    run({ manifest_version: key, finished_at: at('2026-09-14T09:00:00.000Z') }),
                    run({
                        kind,
                        manifest_version: 'half-written',
                        status: 'failed',
                        finished_at: at('2026-09-14T10:00:00.000Z'),
                    }),
                ];

                // Pinned: the failure really is invisible to the identity, so
                // the expected key is unchanged and rule 2 cannot be what fires.
                expect(expectedKeyFor(withFailure)).toBe(key);

                const reason = releaseStalenessReason(withFailure, key, silentLogger);

                expect(reason).not.toBeNull();
                expect(reason).toContain(kind);
                expect(reason).toContain('FAILED');
                expect(reason).toContain('wrote back everything it reached before it died');
                expect(reason).toContain('catalog:validate');
            },
        );

        it('releases when the failed mutator finished BEFORE the validation, which is what a retry looks like', () => {
            const ledger = [ingestRow({ finished_at: at('2026-09-14T09:00:00.000Z') })];
            const key = expectedKeyFor(ledger);

            expect(
                releaseStalenessReason(
                    [
                        ingestRow({
                            manifest_version: 'first-attempt',
                            status: 'failed',
                            finished_at: at('2026-09-14T08:00:00.000Z'),
                        }),
                        ...ledger,
                        run({ manifest_version: key, finished_at: at('2026-09-14T10:00:00.000Z') }),
                    ],
                    key,
                    silentLogger,
                ),
            ).toBeNull();
        });

        it('does not read a failed VALIDATION as a mutator, which would compare the canonical run with itself', () => {
            // Validation is absent from GRAPH_MUTATING_RUN_KINDS on purpose. A
            // failed validation attempt is judged by its own rules; read as a
            // mutator it would make every successful pass look stale.
            //
            // This row is refused by the restricted-pass rule — same catalog
            // input, finished after the canonical success, no judged/unchanged
            // counts — and what this case pins is that the refusal is NOT the
            // graph-mutator one, whose wording and remedy belong to an import or
            // a load that wrote the catalog back as candidates.
            const ledger = [ingestRow()];
            const key = expectedKeyFor(ledger);

            const reason = releaseStalenessReason(
                [
                    ...ledger,
                    run({
                        manifest_version: `${key}+scope:ffffffffffffffff`,
                        status: 'failed',
                        finished_at: at('2026-09-14T10:00:00.000Z'),
                    }),
                    run({ manifest_version: key, finished_at: at('2026-09-14T09:00:00.000Z') }),
                ],
                key,
                silentLogger,
            );

            expect(reason).toContain('restricted catalog:validate run');
            expect(reason).not.toContain('wrote back everything it reached before it died');
        });

        it('releases when that same restricted pass states that it changed nothing', () => {
            // The other side of the rule above, kept here so the pair reads
            // together: a scoped row is not waved through for being scoped, and
            // it is not refused for being scoped either — its own counts decide.
            const ledger = [ingestRow()];
            const key = expectedKeyFor(ledger);

            expect(
                releaseStalenessReason(
                    [
                        ...ledger,
                        run({
                            manifest_version: `${key}+scope:ffffffffffffffff`,
                            status: 'failed',
                            finished_at: at('2026-09-14T10:00:00.000Z'),
                            counts: { judged: 4, unchanged: 4 },
                        }),
                        run({ manifest_version: key, finished_at: at('2026-09-14T09:00:00.000Z') }),
                    ],
                    key,
                    silentLogger,
                ),
            ).toBeNull();
        });
    });
});

/**
 * THE PAIRING INSIDE runRelease.
 *
 * `releaseStalenessReason` is pure and exhaustively covered above, but it is
 * only as good as the key it is HANDED — and the defect these cases pin was
 * precisely that the caller never worked out which run it should be looking
 * for. That pairing is three lines inside `runRelease`
 * (`canonicalValidationRunKey(plan, catalogInputIdentity(snapshot.pipelineRuns))`),
 * they are not reachable from any pure test, and a version of them that passed
 * a hard-coded plan version would leave every test above green. So the function
 * is driven: real ledger rows in the test database, a real Repeatable Read
 * snapshot, in-memory files, and the refusal read off what it throws.
 */
describe('runRelease resolves the validation it demands from its own snapshot', () => {
    const RELEASE = 'v-newneg01';
    const INGEST_FINISHED = new Date('2026-09-14T08:00:00.000Z');

    /** Files stay in memory: this exercises the prerequisite, not the filesystem. */
    const releaseDeps = (): RunReleaseDeps & { readonly files: Map<string, string> } => {
        const files = new Map<string, string>();
        return {
            db: prisma as unknown as ReleaseDb,
            coveragePlan,
            release: RELEASE,
            logger: silentLogger,
            now: () => new Date('2026-09-14T12:00:00.000Z'),
            releaseDir: (release: string) => `/tmp/blitzy-unused-release/${release}`,
            writeFile: (absolutePath: string, contents: string) => {
                files.set(absolutePath, contents);
            },
            readFileBytes: (absolutePath: string) => Buffer.from(files.get(absolutePath) ?? '', 'utf-8'),
            ensureDir: () => undefined,
            files,
        };
    };

    const clearLedger = async (): Promise<void> => {
        await prisma.catalog_import_runs.deleteMany({
            where: { kind: { in: ['validation', 'usda_import', 'ai_generation', 'release_load'] } },
        });
    };

    beforeEach(clearLedger);
    afterEach(clearLedger);

    const recordRun = async (input: {
        kind: string;
        manifestVersion: string;
        status: string;
        finishedAt: Date | null;
    }): Promise<void> => {
        await prisma.catalog_import_runs.create({
            data: {
                kind: input.kind,
                manifest_version: input.manifestVersion,
                status: input.status,
                started_at: new Date('2026-09-14T07:00:00.000Z'),
                finished_at: input.finishedAt,
            },
        });
    };

    /** The key runRelease must derive, computed here from the same two facts. */
    const canonicalKey = (): string =>
        canonicalValidationRunKey(
            coveragePlan.coveragePlanVersion,
            catalogInputIdentity([
                {
                    kind: 'usda_import',
                    manifest_version: 'the-import',
                    status: 'succeeded',
                    finished_at: INGEST_FINISHED,
                } as CatalogInputRunRow,
            ]),
        );

    it('refuses when the only validation is scoped, naming the canonical run it wanted', async () => {
        await recordRun({
            kind: 'usda_import',
            manifestVersion: 'the-import',
            status: 'succeeded',
            finishedAt: INGEST_FINISHED,
        });
        await recordRun({
            kind: 'validation',
            manifestVersion: `${canonicalKey()}+scope:aaaaaaaaaaaaaaaa`,
            status: 'succeeded',
            finishedAt: new Date('2026-09-14T09:00:00.000Z'),
        });

        const deps = releaseDeps();
        await expect(runRelease(deps)).rejects.toThrow(ReleaseIntegrityError);
        // The key in the message is the one derived from the ledger, so a
        // caller that guessed it would be visible here.
        await expect(runRelease(deps)).rejects.toThrow(canonicalKey());
        // Nothing written: the refusal precedes every export byte.
        expect(deps.files.size).toBe(0);
    });

    it('gets past the prerequisite once the canonical run for that same input has succeeded', async () => {
        await recordRun({
            kind: 'usda_import',
            manifestVersion: 'the-import',
            status: 'succeeded',
            finishedAt: INGEST_FINISHED,
        });
        await recordRun({
            kind: 'validation',
            manifestVersion: canonicalKey(),
            status: 'succeeded',
            finishedAt: new Date('2026-09-14T09:00:00.000Z'),
        });

        // Asserted as "not this refusal" rather than as success: the database
        // holds no published food, so what the export does next is not this
        // rule's business and pinning it here would couple the two.
        const deps = releaseDeps();
        await runRelease(deps).catch((error: unknown) => {
            expect(String((error as Error).message)).not.toContain('catalog:validate run is on record');
        });
        expect(deps.files.size).toBeGreaterThan(0);
    });
});

/**
 * THE SEAM ITSELF: EVERY CLI ENTRY POINT TAKES THE CLAIM.
 *
 * The lock's behaviour is proven above, but a lock nothing calls excludes
 * nothing — and that was precisely the defect: `checkpoint.ts` said the run
 * claim "does NOT grant exclusive processing for the run's lifetime" and named
 * the CLI entry point as where such a lock belongs, while no entry point took
 * one. Whether `main()` takes it cannot be asserted by importing the module —
 * every script guards `main()` behind `require.main === module` — so it is
 * asserted the only way it can be: the parent holds the graph, a real CLI
 * process is launched, and its exit status and reported code are read.
 *
 * A missing wrapper is visible rather than silent. Each stage would get past
 * this point and fail, or succeed, for some entirely different reason; the
 * assertion is on `catalog_stage_locked` specifically, which only the wrapper
 * produces. The four children cost about half a second each and make no vendor
 * call: every one of them refuses before reaching its work.
 */
describe('every catalog CLI refuses to run while another stage holds the graph', () => {
    /**
     * A child over one of the pipeline's CLI entry points, with the environment
     * it needs to reach `main()` and nothing more.
     *
     * Separate from `runChildProcess` above on purpose: that harness withholds
     * `DATABASE_URL` because the rate-ledger children must not reach a
     * database, and these children must. `CATALOG_MODEL_CALL_BUDGET` is set
     * because validation's prerequisite check runs before the lock and would
     * otherwise stop the child short of the thing under test — the budget is
     * never spent, since the lock refuses first.
     *
     * The two vendor keys are set for that same reason, and are the reason this
     * block cannot simply inherit `process.env`: `jestSetup.ts` DELETES
     * `USDA_API_KEY` and `OPENROUTER_API_KEY` so that an unintercepted vendor
     * call fails closed, and each stage's `preflight` reports the missing key
     * as a prerequisite gap BEFORE any lock is taken. Without them the import
     * and validation children exit on `stage_prerequisites_unmet` and never
     * reach the refusal under test. The values are deliberately unusable
     * placeholders rather than the real credentials: the lock refuses first, so
     * neither child ever opens a vendor request, and a real key here would put
     * a live credential in a child's environment for no behaviour at all.
     *
     * AND THAT REFUSAL IS ENFORCED IN THE CHILD, not assumed. "The lock refuses
     * first" is the behaviour under test, which makes it exactly the thing that
     * cannot be relied upon while testing it: a regression that skips the lock,
     * or stops checking prerequisites, would have one of these children begin a
     * real import against `api.nal.usda.gov` from a unit test, with whatever
     * key the environment holds. `vendorNetworkDeny` is therefore required into
     * every child here and refuses `fetch` and `http`/`https` outright —
     * leaving `net`, `tls` and DNS alone so PostgreSQL still connects — and
     * appends what it did to a per-child log each case then asserts.
     */
    /** Per-run temporary directory holding one deny log per child. */
    let stageChildLogs = '';

    const denyLogFor = (label: string): string =>
        path.join(stageChildLogs, `${label.replace(/[^a-zA-Z0-9]+/g, '-')}.log`);

    /**
     * One child in the stage-lock environment, over whatever Node arguments it
     * is given.
     *
     * Separated from `runStageCli` so the anti-vacuity case below can launch a
     * child with the same requires and the same environment but its own code,
     * and prove the hook INTERCEPTS rather than merely loads.
     *
     * ORDER: THE DENY IS FIRST, AHEAD OF ts-node. Node runs `--require` hooks
     * left to right, and the keys are in the child's environment from the
     * moment it starts — so anything that ran before the deny would run with
     * them and without protection. It used to sit second, because it was
     * TypeScript and ts-node has to own the `.ts` extension before a `.ts` hook
     * can resolve; the hook is dependency-free CommonJS now precisely so that
     * constraint is gone. Registering ts-node opens no socket today, which is
     * an argument for why second was survivable and not one for why it was
     * right: "the code before the guard happens not to need guarding" is a
     * property of today's ts-node, not a property of this suite. First is the
     * position that stays correct when that changes — and it also protects a
     * child running compiled js, which needs no ts-node hook at all.
     */
    const spawnStageChild = (nodeArgs: readonly string[], denyLog: string): Promise<ChildOutcome> =>
        new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                ['--require', VENDOR_NETWORK_DENY_MODULE, '--require', TS_NODE_REGISTER, ...nodeArgs],
                {
                    cwd: BACKEND_ROOT,
                    timeout: CHILD_TIMEOUT_MS,
                    env: {
                        PATH: process.env.PATH,
                        HOME: process.env.HOME,
                        NODE_ENV: 'test',
                        DATABASE_URL: process.env.DATABASE_URL,
                        CATALOG_MODEL_CALL_BUDGET: '1',
                        USDA_API_KEY: 'not-a-real-key-the-stage-lock-refuses-first',
                        OPENROUTER_API_KEY: 'not-a-real-key-the-stage-lock-refuses-first',
                        [VENDOR_NETWORK_DENY_LOG_VAR]: denyLog,
                        TS_NODE_PROJECT: SCRIPTS_TSCONFIG,
                        TS_NODE_TRANSPILE_ONLY: '1',
                    },
                },
            );

            let stdout = '';
            let stderr = '';
            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');
            child.stdout.on('data', (chunk: string) => {
                stdout += chunk;
            });
            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });
            child.on('error', reject);
            child.on('close', (status) => {
                resolve({ status, stdout, stderr });
            });
        });

    /** One CLI entry point, in that environment, with its own deny log. */
    const runStageCli = (script: string, args: readonly string[]): Promise<ChildOutcome> =>
        spawnStageChild([path.join(BACKEND_ROOT, 'scripts', script), ...args], denyLogFor(script));

    /**
     * Reads one child's deny log and returns the attempts it recorded.
     *
     * The `installed` line is asserted here rather than by each caller, because
     * it is the assertion that gives "no attempts" its meaning: a hook that
     * failed to load writes nothing at all, and an empty file would otherwise
     * read as a clean result.
     */
    const vendorAttempts = (label: string): VendorNetworkDenyEvent[] => {
        const events = readVendorNetworkDenyLog(fs.readFileSync(denyLogFor(label), 'utf8'));
        expect(events.map((event) => event.event)).toContain('installed');

        return events.filter((event) => event.event === 'attempt');
    };

    let graph: { release(): Promise<void> } | null = null;

    beforeAll(async () => {
        stageChildLogs = fs.mkdtempSync(path.join(os.tmpdir(), 'catalog-stage-child-'));
        // One mutating stage, holding the graph for the duration, exactly as a
        // long import would.
        graph = await acquireCatalogStageLock({ stage: 'usda_import' });
    });

    afterAll(async () => {
        await graph?.release();
        graph = null;
        fs.rmSync(stageChildLogs, { recursive: true, force: true });
    });

    /**
     * The database `--confirm-target` has to name, read from the URL the suite
     * is pointed at rather than written down: the name differs per checkout and
     * per environment (a clone-scoped `soh_test_<n>` locally, `ci` in CI), and a
     * literal would pass in exactly one of them.
     */
    const targetDatabaseName = (): string => {
        const url = process.env.DATABASE_URL ?? '';
        const name = url.slice(url.lastIndexOf('/') + 1).split('?')[0];
        expect(name.length).toBeGreaterThan(0);
        return name;
    };

    it.each([
        // `--release v99` is deliberately an id that does not exist: the lock
        // refuses before the export reads or writes anything, so no release
        // directory is created by this test.
        //
        // The expectation is the STAGE and the MODE as typed log fields, not a
        // clause of the refusal's rendered sentence. `stage_failed` carries no
        // `message` \u2014 see `checkpointErrorFields` in `scripts/lib/checkpoint.ts`
        // \u2014 because the same field would otherwise carry prose from a driver or
        // a vendor on every other failure; the two facts this case is about are
        // reported as data instead, which is also a stricter assertion than a
        // substring of English.
        ['catalog-import-usda.ts', [], 'usda_import', 'exclusive'],
        ['catalog-validate.ts', [], 'validation', 'exclusive'],
        ['catalog-release.ts', ['--release', 'v99'], 'release', 'shared'],
        ['catalog-load.ts', ['--release', 'v1', '--confirm-target'], 'release_load', 'exclusive'],
    ] as [string, string[], string, string][])('%s refuses, and says which lock it could not take', async (
        script,
        argTemplate,
        expectedStage,
        expectedMode,
    ) => {
        // The loader is the one stage that must be told which database it is
        // writing, so its flag takes the value from the environment.
        const args =
            argTemplate[argTemplate.length - 1] === '--confirm-target'
                ? [...argTemplate, targetDatabaseName()]
                : argTemplate;

        const outcome = await runStageCli(script, args);
        const output = `${outcome.stdout}${outcome.stderr}`;

        expect(outcome.status).not.toBe(0);
        // The machine-readable code an operator's tooling reads, not the prose.
        expect(output).toContain('"code":"catalog_stage_locked"');
        // WHICH lock, and in which mode — because an export taking the lock
        // exclusively would serialise two harmless reads while a mutator taking
        // it shared would run beside another writer, and those are the two
        // mistakes this case names apart. Read as typed fields of the
        // `stage_failed` line, which is where they now live.
        expect(output).toContain(`"lockStage":"${expectedStage}"`);
        expect(output).toContain(`"lockMode":"${expectedMode}"`);
        // And the line carries no free-form message for them to have come from,
        // which is the property that keeps a driver's or a vendor's prose off
        // this same field on every other failure.
        expect(output).not.toContain('"message"');

        // AND IT SPENT NOTHING AT THE VENDOR GETTING THERE. Asserted from the
        // child's own deny log, whose `installed` line `vendorAttempts` checks
        // first — so this is "the hook was live and caught nothing", not "the
        // file was empty". The message carries the attempts because a failure
        // here is a real escape and the channel and host are what identify it.
        expect(vendorAttempts(script)).toEqual([]);
    });

    it('would have caught a request had one been made, so the empty logs above mean something', async () => {
        // THE ANTI-VACUITY CASE. Every assertion above is that a log holds no
        // attempt, and a hook that loads but intercepts nothing would satisfy
        // all of them. This child runs in the same environment, with the same
        // two `--require` hooks, and deliberately opens both channels a vendor
        // call can leave through — so what it proves is that the interception
        // in THAT configuration works, which is the one thing the other cases
        // cannot establish about themselves.
        const attempt = [
            'const https = require("https");',
            'const done = [];',
            'fetch("https://api.nal.usda.gov/fdc/v1/food/12345?api_key=secret")',
            '  .then(() => done.push("fetch-resolved"), (error) => done.push("fetch-" + error.message))',
            '  .then(() => { try { https.get("https://openrouter.ai/api/v1/chat/completions"); done.push("https-returned"); }',
            '                 catch (error) { done.push("https-" + error.message); }',
            '                 process.stdout.write(JSON.stringify(done)); });',
        ].join('\n');

        const log = denyLogFor('anti-vacuity');
        const outcome = await spawnStageChild(['-e', attempt], log);

        // Both channels refused, in the child's own words.
        expect(outcome.stdout).toContain('fetch-vendor network denied: fetch to https://api.nal.usda.gov/fdc/v1/food/12345');
        expect(outcome.stdout).toContain('https-vendor network denied: https.get to https://openrouter.ai/api/v1/chat/completions');
        expect(outcome.stdout).not.toContain('fetch-resolved');
        expect(outcome.stdout).not.toContain('https-returned');

        // And both were recorded, which is the channel the cases above read.
        const events = readVendorNetworkDenyLog(fs.readFileSync(log, 'utf8'));
        expect(events[0]).toEqual({ event: 'installed' });
        expect(events.slice(1)).toEqual([
            {
                event: 'attempt',
                channel: 'fetch',
                target: 'https://api.nal.usda.gov/fdc/v1/food/12345',
            },
            {
                event: 'attempt',
                channel: 'https.get',
                target: 'https://openrouter.ai/api/v1/chat/completions',
            },
        ]);
        // The `api_key` in the requested URL is not in the record: this log is
        // printed in failure messages, so it carries origin and path only.
        expect(fs.readFileSync(log, 'utf8')).not.toContain('secret');
    });

    it('installs the deny before ts-node, so nothing runs ahead of the guard', async () => {
        // Asserted from INSIDE a child, against its own `process.execArgv`,
        // because that is the only place the effective order is a fact rather
        // than a reading of the spawn call. Node runs `--require` hooks left to
        // right and the vendor keys are present from the child's first
        // instruction, so a hook in second place leaves everything ahead of it
        // unguarded.
        const report = [
            'const args = process.execArgv;',
            'const at = (needle) => args.findIndex((a) => a.includes(needle));',
            'process.stdout.write(JSON.stringify({',
            '  deny: at("vendorNetworkDeny"),',
            '  tsNode: at("ts-node"),',
            '  fetchReplaced: globalThis.fetch.toString().includes("refusal"),',
            '}));',
        ].join('\n');

        const outcome = await spawnStageChild(['-e', report], denyLogFor('require-order'));
        const seen = JSON.parse(outcome.stdout) as { deny: number; tsNode: number; fetchReplaced: boolean };

        expect(seen.deny).toBeGreaterThanOrEqual(0);
        expect(seen.tsNode).toBeGreaterThanOrEqual(0);
        expect(seen.deny).toBeLessThan(seen.tsNode);
        // And the guard was actually in force by the time the entry code ran,
        // not merely listed first.
        expect(seen.fetchReplaced).toBe(true);
    });

    it('keeps the deny loadable in first place: Node built-ins only', () => {
        // The property that ALLOWS first place, asserted rather than assumed. A
        // relative or package `require` added to the hook would either need
        // ts-node (putting it back behind the thing it must precede) or fail
        // outright in a child launched from outside the checkout.
        const source = fs.readFileSync(VENDOR_NETWORK_DENY_MODULE, 'utf8');
        const required = [...source.matchAll(/require\(\s*'([^']+)'\s*\)/g)].map((match) => match[1]);

        expect(required.length).toBeGreaterThan(0);
        expect(required.filter((id) => id.startsWith('.') || id.startsWith('/'))).toEqual([]);
        for (const id of required) {
            expect(['fs', 'http', 'https']).toContain(id);
        }
    });

    it('names the log variable identically on both sides of the pair', () => {
        // The installer cannot import the reader (it must load before ts-node),
        // so the one string they share is duplicated. This is the tie that
        // stops the duplication from drifting: a rename on either side leaves
        // the deny writing to a file nobody reads, which would make every
        // "no attempt was recorded" assertion above vacuously true.
        const source = fs.readFileSync(VENDOR_NETWORK_DENY_MODULE, 'utf8');

        expect(source).toContain(`const LOG_VAR = '${VENDOR_NETWORK_DENY_LOG_VAR}'`);
    });

    it('leaves the graph lock with its one holder, so a refused CLI released what it opened', async () => {
        // Scoped to this database for the same reason as advisoryLockCount
        // above: pg_locks is cluster-wide, so an unscoped count answers this
        // question with another checkout's lock.
        const rows = await prisma.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count
            FROM pg_locks
            WHERE locktype = 'advisory'
              AND classid = ${0x434154}::int4
              AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        `;

        expect(Number(rows[0]?.count ?? 0)).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// THE IMPORT AS A RUN, AGAINST THE REAL CATALOG TABLES.
//
// Everything above this line proves a decision: a pure function's answer, a
// redaction, a ledger's arithmetic, a checkpoint's accounting. What none of it
// proves is the WIRING — that `runImport` fetching a batch, normalising it and
// upserting it converges on one row per vendor id, that a second identical run
// writes nothing new, that an interruption leaves the work it finished behind,
// and that a completed stage stays completed. Those are properties of the
// orchestration and of nothing smaller, which is why they need a database
// (Rule backend-architecture §11: integration coverage is for the wiring, and
// a rule that needs a database is in the wrong layer).
//
// WHAT IS DELIBERATELY NOT ASSERTED HERE. No bound, tolerance or verdict:
// `catalog.logic.test.ts` owns every check's threshold, and a second copy of
// those numbers here would be two places to update and one to forget. The
// cases below read a verdict only as a STATUS the run wrote — `candidate` or
// `quarantined` — never as a judgement re-derived from the nutrients. The USDA
// cache-key shapes and the service's own retry ladder belong to
// `usda.service.test.ts`; what this section owns of the limiter is only the
// accounting the SCRIPT wires, through `installRateLimiter`.
// ---------------------------------------------------------------------------

/**
 * The run scope every case in this section claims.
 *
 * NOT the shipped `v1`, and that is load-bearing rather than tidy.
 * `openOrResumeRun` claims `(kind, manifestVersion)` and `finishRun` closes it
 * `succeeded`, after which that pair is a permanent no-op (checkpoint.ts's THE
 * CLAIM). A case here that claimed `v1` and succeeded would therefore leave
 * this database's canonical import key closed for ever, and the next real
 * `npm run catalog:import` against it would report "already completed" and
 * write nothing. Scoping the injected manifest's own version string keeps
 * every claim below in a namespace no operator command can ever address.
 */
const IMPORT_RUN_SCOPE = 'v1+suite:run-import-orchestration';

/** One fixed instant for every injected clock, so no assertion reads a wall clock. */
const IMPORT_AT = new Date('2026-09-14T09:00:00.000Z');

/**
 * Nutrients that pass every check for the two categories the subjects below are
 * drawn from, so a `quarantined` status anywhere in this section means the
 * orchestration put it there rather than the numbers.
 *
 * The energy value is stated AND consistent with the macros: 4·3.09 + 4·3.26 +
 * 9·0.34 is 28.46 against a stated 22, inside the plan's absolute 30 kcal
 * energy-vs-macro allowance, and 22 sits inside both categories' review ranges.
 * The two facts are asserted in `the subjects this section imports` below
 * rather than trusted, because a coverage-plan edit that moved either range
 * would otherwise turn every case here red for a reason none of them is about.
 */
const CLEAN_PROTEIN_G = 3.09;
const CLEAN_CARBS_G = 3.26;
const CLEAN_FAT_G = 0.34;
const CLEAN_CALORIES = 22;

/** 4·P + 4·C + 9·F, rounded as `prepareCatalogFood` rounds it. */
const DERIVED_CALORIES =
    Math.round((4 * CLEAN_PROTEIN_G + 4 * CLEAN_CARBS_G + 9 * CLEAN_FAT_G) * 100) / 100;

type CuratedEntry = UsdaManifestFood & { fdcId: number };

const curatedIn = (category: string): CuratedEntry[] =>
    curatedEntries.filter((entry) => entry.category === category);

/**
 * Twenty-eight curated entries: eighteen vegetables and ten fruits, which is
 * what makes the plan two batches at the manifest's twenty-per-batch limit
 * rather than one. Both categories accept the nutrients above, so the split is
 * free of any per-category special case.
 */
const IMPORT_SUBJECTS: readonly CuratedEntry[] = [
    ...curatedIn('produce_vegetable'),
    ...curatedIn('produce_fruit'),
];

const DETAIL_BATCH_SIZE = manifest.importLimits.detailBatchSize;

/** A per-100 g record for one curated entry, in the search-flattened nutrient shape. */
const cleanDetail = (entry: CuratedEntry, overrides: Partial<UsdaFoodDetail> = {}): UsdaFoodDetail => ({
    fdcId: entry.fdcId,
    description: entry.expectedUsdaDescription ?? entry.displayName,
    dataType: entry.usdaDataType,
    publicationDate: '4/1/2019',
    foodNutrients: [
        { nutrientNumber: manifest.nutrientNumbers.protein, value: CLEAN_PROTEIN_G },
        { nutrientNumber: manifest.nutrientNumbers.fat, value: CLEAN_FAT_G },
        { nutrientNumber: manifest.nutrientNumbers.carbs, value: CLEAN_CARBS_G },
        { nutrientNumber: manifest.nutrientNumbers.calories, value: CLEAN_CALORIES },
    ],
    foodPortions: [],
    ...overrides,
});

/**
 * The manifest `runImport` is handed: this section's own scope, the chosen
 * entries, and no dataset sweeps.
 *
 * Dropping the sweeps is what makes the plan exactly the entries passed in —
 * `buildImportPlan` walks the curated list and then each sweep, so an empty
 * sweep list means `listFoods` is never called and the batch membership is the
 * argument rather than a vendor listing.
 */
const narrowedManifest = (entries: readonly CuratedEntry[], scope: string = IMPORT_RUN_SCOPE): UsdaManifest => ({
    ...manifest,
    usdaManifestVersion: scope,
    foods: entries,
    datasetSweeps: [],
});

/**
 * A second scope in the same namespace, for the one property that needs two
 * runs the CLAIM does not collapse.
 *
 * `openOrResumeRun` keys on (kind, manifestVersion), so a second run of
 * {@link IMPORT_RUN_SCOPE} is answered at the claim and writes nothing — which
 * is the correct behaviour and is asserted in its own case. The upsert
 * convergence AAP §0.9.2 requires ("repeat imports create no duplicate foods")
 * therefore cannot be observed under one scope: it is what happens when a
 * LATER manifest version covers records the catalog already holds, which is
 * exactly what a refreshed `usda-manifest` is. This is that later version.
 */
const IMPORT_RERUN_SCOPE = 'v2+suite:run-import-orchestration';

/** A vendor client that answers from a table of records and records what it was asked. */
interface RecordingVendor {
    readonly usda: RunImportDeps['usda'];
    /** One entry per `fetchBatch` call, in call order, each the ids requested. */
    readonly batchCalls: number[][];
    readonly listCalls: number;
}

interface RecordingVendorOptions {
    /** Answers for the ids requested; an id absent from the map is "missing from vendor". */
    readonly records: ReadonlyMap<number, UsdaFoodDetail>;
    /** Throws on this 1-based `fetchBatch` call, leaving earlier batches committed. */
    readonly failOnCall?: number;
    /** What the failure throws. Defaults to the vendor boundary's own error shape. */
    readonly failWith?: () => Error;
}

const vendorError = (message: string): Error => {
    const error = new Error(message);
    // The boundary's class is matched by name, never by identity: importing
    // `usda.service.ts`'s value side constructs a Prisma client, which is the
    // load this script defers on purpose (see `isUsdaError` in the stage).
    error.name = 'UsdaError';

    return error;
};

const recordingVendor = (options: RecordingVendorOptions): RecordingVendor => {
    const batchCalls: number[][] = [];
    const state = { listCalls: 0 };
    const fail = options.failWith ?? (() => vendorError('USDA returned 503 for this batch'));

    const vendor: RecordingVendor = {
        batchCalls,
        get listCalls(): number {
            return state.listCalls;
        },
        usda: {
            listFoods: async (): Promise<UsdaFoodSummary[]> => {
                state.listCalls += 1;

                return [];
            },
            fetchBatch: async (fdcIds): Promise<ImportBatchFetch> => {
                batchCalls.push([...fdcIds]);
                if (options.failOnCall !== undefined && batchCalls.length === options.failOnCall) {
                    throw fail();
                }

                return batchFetch(
                    fdcIds
                        .map((fdcId) => options.records.get(fdcId))
                        .filter((record): record is UsdaFoodDetail => record !== undefined),
                    fdcIds,
                );
            },
        },
    };

    return vendor;
};

const recordsFor = (
    entries: readonly CuratedEntry[],
    overrides: ReadonlyMap<number, UsdaFoodDetail> = new Map(),
): Map<number, UsdaFoodDetail> => {
    const records = new Map<number, UsdaFoodDetail>();
    for (const entry of entries) {
        records.set(entry.fdcId, overrides.get(entry.fdcId) ?? cleanDetail(entry));
    }

    return records;
};

interface ImportRunHarness {
    readonly deps: RunImportDeps;
    readonly reports: unknown[];
    readonly installs: number;
    readonly restores: number;
}

interface ImportRunOptions {
    readonly entries: readonly CuratedEntry[];
    /**
     * Anything that answers the stage's vendor seam. Narrowed to the seam
     * itself rather than to `RecordingVendor`, because the pacing cases below
     * hand it a client that reaches the transport instead of one that records
     * the ids it was asked for.
     */
    readonly vendor: { readonly usda: RunImportDeps['usda'] };
    readonly options?: Partial<ImportOptions>;
    readonly logger?: ScriptLogger;
    readonly installRateLimiter?: () => () => void;
    readonly rateLimiterStats?: () => UsdaRequestStats;
    /**
     * The catalog client the stage writes rows through. Defaults to the real
     * one; a case that needs a write to fail part-way through a batch supplies
     * a client whose transaction is real and whose Nth write is not.
     */
    readonly db?: ImportDb;
    /** The manifest version this invocation claims. Defaults to {@link IMPORT_RUN_SCOPE}. */
    readonly scope?: string;
}

/**
 * The deps one case runs with, typed as `RunImportDeps` so a drift in the
 * stage's declared seam fails `npm run typecheck:test` rather than at runtime.
 *
 * Only the Prisma client is cast, and only to `ImportDb`: the stage declares
 * that seam structurally over four models, while the generated client's
 * accessors are generic over their `select`, so the two are compatible in
 * behaviour without being assignable in TypeScript. Every field this file
 * authors stays checked.
 */
const importHarness = (runOptions: ImportRunOptions): ImportRunHarness => {
    const reports: unknown[] = [];
    const counters = { installs: 0, restores: 0 };

    const installRateLimiter =
        runOptions.installRateLimiter ??
        ((): (() => void) => {
            counters.installs += 1;

            return (): void => {
                counters.restores += 1;
            };
        });

    const deps: RunImportDeps = {
        db: runOptions.db ?? (prisma as unknown as ImportDb),
        runDb: prisma,
        usda: runOptions.vendor.usda,
        manifest: narrowedManifest(runOptions.entries, runOptions.scope),
        coveragePlan,
        options: options(runOptions.options),
        logger: runOptions.logger ?? silentLogger,
        now: () => IMPORT_AT,
        installRateLimiter,
        rateLimiterStats: runOptions.rateLimiterStats,
        writeReport: (report: unknown) => {
            reports.push(report);
        },
    };

    return {
        deps,
        reports,
        get installs(): number {
            return counters.installs;
        },
        get restores(): number {
            return counters.restores;
        },
    };
};

interface StoredFoodRow {
    id: string;
    source_key: string;
    usda_fdc_id: number | null;
    publication_status: string;
    canonical_name: string;
    nutrition_basis: string;
    basis_amount: number | null;
    calories: number | null;
    identity_source: string;
    nutrition_provenance: string;
    imported_at: Date | null;
    updated_at: Date | null;
}

const storedFoods = async (): Promise<StoredFoodRow[]> =>
    prisma.catalog_foods.findMany({
        where: { identity_source: 'usda' },
        orderBy: { source_key: 'asc' },
        select: {
            id: true,
            source_key: true,
            usda_fdc_id: true,
            publication_status: true,
            canonical_name: true,
            nutrition_basis: true,
            basis_amount: true,
            calories: true,
            identity_source: true,
            nutrition_provenance: true,
            imported_at: true,
            updated_at: true,
        },
    }) as unknown as Promise<StoredFoodRow[]>;

const storedFood = async (sourceKey: string): Promise<StoredFoodRow> => {
    const rows = await storedFoods();
    const row = rows.find((candidate) => candidate.source_key === sourceKey);
    expect(row).toBeDefined();

    return row as StoredFoodRow;
};

const importRunRow = async (
    scope: string = IMPORT_RUN_SCOPE,
): Promise<{
    id: string;
    status: string;
    cursor: unknown;
    counts: unknown;
    finished_at: Date | null;
} | null> =>
    prisma.catalog_import_runs.findFirst({
        where: { kind: 'usda_import', manifest_version: scope },
        select: { id: true, status: true, cursor: true, counts: true, finished_at: true },
    }) as unknown as Promise<{
        id: string;
        status: string;
        cursor: unknown;
        counts: unknown;
        finished_at: Date | null;
    } | null>;

describe('the subjects this section imports', () => {
    it('draws two batches of curated entries from categories the nutrients suit', () => {
        expect(IMPORT_SUBJECTS.length).toBeGreaterThan(DETAIL_BATCH_SIZE);
        expect(new Set(IMPORT_SUBJECTS.map((entry) => entry.fdcId)).size).toBe(IMPORT_SUBJECTS.length);

        // The premise the whole section rests on: these nutrients are inside
        // every subject category's review range, so nothing below is
        // quarantined by a bound. Asserted from the coverage plan rather than
        // restated, so a plan edit reports itself here instead of as a dozen
        // unexplained failures.
        const ranges = [...new Set(IMPORT_SUBJECTS.map((entry) => entry.category))].map((category) => {
            const row = coveragePlan.categories.find((candidate) => candidate.category === category);
            expect(row).toBeDefined();

            return row as { kcalReviewRange: { min: number; max: number } };
        });

        for (const range of ranges) {
            expect(CLEAN_CALORIES).toBeGreaterThanOrEqual(range.kcalReviewRange.min);
            expect(CLEAN_CALORIES).toBeLessThanOrEqual(range.kcalReviewRange.max);
            expect(DERIVED_CALORIES).toBeGreaterThanOrEqual(range.kcalReviewRange.min);
            expect(DERIVED_CALORIES).toBeLessThanOrEqual(range.kcalReviewRange.max);
        }
    });

    it('keeps this section’s run scope away from the canonical import key', () => {
        expect(IMPORT_RUN_SCOPE).not.toBe(manifest.usdaManifestVersion);
        // Unrestricted options, so the scope is the manifest version verbatim —
        // which is exactly why the injected version has to be the scoped one.
        expect(importRunScope(IMPORT_RUN_SCOPE, options())).toBe(IMPORT_RUN_SCOPE);
    });
});

/**
 * "REPEAT IMPORTS CREATE NO DUPLICATE FOODS" (AAP §0.9.2), end to end.
 *
 * The stage's whole re-run safety rests on one claim in its header — "every
 * write is an upsert on a key derived from the vendor's own id" — and that
 * claim is about the orchestration, not about `persistPreparedFood` in
 * isolation: the source key has to be derived, carried through the plan, and
 * used as the conflict target, and `imported_at` has to survive the second
 * write. A rerun that produced a second row, or the same row with a new
 * identity, would break every `recipe_ingredients` and `meal_entries`
 * reference pointing at the first one.
 *
 * Row IDENTITY is therefore asserted, not just row count: the repository's
 * precedent for this is `food.service.ts`'s `findOrCreateBrandedFood`, which
 * finds on the natural key before it creates, and the property that matters
 * downstream is that the id a reference was taken against still resolves.
 */
describe('a repeated import converges on the same rows', () => {
    const subjects = IMPORT_SUBJECTS.slice(0, 2);

    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('writes one row per vendor id, with its aliases, portions and validation record', async () => {
        const vendor = recordingVendor({ records: recordsFor(subjects) });
        const harness = importHarness({ entries: subjects, vendor });

        const outcome = await runImport(harness.deps);

        expect(outcome.runId).not.toBeNull();
        expect(outcome.resumed).toBe(false);
        expect(outcome.plannedBatches).toBe(1);
        expect(outcome.processedBatches).toBe(1);
        expect(outcome.counts.planned).toBe(subjects.length);
        expect(outcome.counts.inserted).toBe(subjects.length);
        expect(outcome.counts.updated).toBe(0);
        expect(outcome.counts.missingFromVendor).toBe(0);
        // The stage does not publish, by design: a record every check accepts
        // is a `candidate`, because the duplicate-identity decision needs a
        // view of the whole table that a batch-at-a-time import cannot have.
        // `catalog:validate` is the only stage that JUDGES a candidate and
        // promotes it — publication as a decision belongs there and nowhere
        // else. (`catalog:load` also writes published rows, and retires and
        // restores them, but it applies the status a reviewed release artefact
        // already states rather than deciding one, so nothing about this
        // import's candidates reaches `published` without validation.)
        expect(outcome.counts.candidates).toBe(subjects.length);
        expect(outcome.counts.quarantined).toBe(0);
        expect(outcome.counts.rejected).toBe(0);

        const rows = await storedFoods();
        expect(rows).toHaveLength(subjects.length);
        expect(rows.map((row) => row.source_key)).toEqual(
            subjects.map((entry) => `usda:${entry.fdcId}`).sort(),
        );

        for (const entry of subjects) {
            const row = await storedFood(`usda:${entry.fdcId}`);
            expect(row.usda_fdc_id).toBe(entry.fdcId);
            expect(row.publication_status).toBe('candidate');
            expect(row.canonical_name).toBe(entry.canonicalName);
            expect(row.identity_source).toBe('usda');
            // Every record this stage writes is source-backed by construction:
            // an AI-estimated food can only come from `catalog:generate`.
            expect(row.nutrition_provenance).toBe('source_backed');
            expect(row.nutrition_basis).toBe('per_100g');
            expect(Number(row.basis_amount)).toBe(100);
            expect(Number(row.calories)).toBeCloseTo(CLEAN_CALORIES, 6);
            expect(row.imported_at).toEqual(IMPORT_AT);

            const aliases = await prisma.catalog_food_aliases.findMany({
                where: { catalog_food_id: row.id },
                select: { alias: true },
            });
            expect(aliases.length).toBeGreaterThan(0);

            const portions = await prisma.catalog_food_portions.findMany({
                where: { catalog_food_id: row.id },
                select: { description: true, gram_weight: true, is_default: true, source: true },
            });
            // Exactly one default, always: `catalog_food_portions` carries a
            // partial unique index on `(catalog_food_id) WHERE is_default`, so
            // a second default is a write that FAILS the run's transaction
            // rather than a row a later check could report.
            expect(portions.filter((portion) => portion.is_default)).toHaveLength(1);
            for (const portion of portions) {
                expect(Number(portion.gram_weight)).toBeGreaterThan(0);
            }

            const record = await prisma.catalog_validation_records.findUnique({
                where: { catalog_food_id: row.id },
                select: { outcome: true, publication_status: true },
            });
            // AAP §0.1.1 requires a machine-readable validation record for
            // every item, so the row and its record are written together or
            // not at all.
            expect(record).not.toBeNull();
            expect(record?.publication_status).toBe('candidate');
        }
    });

    it('leaves the generated search vector to the database and still lands searchable', async () => {
        const vendor = recordingVendor({ records: recordsFor(subjects) });
        const harness = importHarness({ entries: subjects, vendor });

        await runImport(harness.deps);

        // `search_vector` is `GENERATED ALWAYS AS ... STORED`, so PostgreSQL
        // rejects any write that names it. The import completing at all is
        // therefore the proof that it supplies only `search_text` — and the
        // vector being populated is the proof the column is doing its job
        // rather than sitting empty behind a column the stage forgot.
        const rows = await prisma.$queryRaw<{ source_key: string; lexemes: number; search_text: string | null }[]>`
            SELECT source_key,
                   coalesce(array_length(tsvector_to_array(search_vector), 1), 0)::int AS lexemes,
                   search_text
            FROM catalog_foods
            WHERE identity_source = 'usda'
            ORDER BY source_key
        `;

        expect(rows).toHaveLength(subjects.length);
        for (const row of rows) {
            expect(row.search_text).not.toBeNull();
            expect(Number(row.lexemes)).toBeGreaterThan(0);
        }
    });

    it('answers a second run of a completed scope without fetching or writing again', async () => {
        const first = importHarness({
            entries: subjects,
            vendor: recordingVendor({ records: recordsFor(subjects) }),
        });
        const firstOutcome = await runImport(first.deps);
        const before = await storedFoods();
        const runBefore = await importRunRow();
        expect(runBefore?.status).toBe('succeeded');

        // A fresh vendor and a fresh harness, so nothing carries over but the
        // database — which is the only thing a real second invocation shares.
        const secondVendor = recordingVendor({ records: recordsFor(subjects) });
        const second = importHarness({ entries: subjects, vendor: secondVendor });
        const secondOutcome = await runImport(second.deps);
        const after = await storedFoods();
        const runAfter = await importRunRow();

        // A SUCCEEDED (kind, manifestVersion) pair is a permanent no-op, and
        // the stage stops at the claim rather than redoing the scope: so the
        // second invocation spends no vendor request at all. This is the
        // cheapest and most decisive evidence that nothing was rewritten —
        // stronger than comparing timestamps, which a fixed clock would make
        // equal either way.
        expect(secondVendor.batchCalls).toEqual([]);
        expect(secondOutcome.resumed).toBe(true);
        expect(secondOutcome.processedBatches).toBe(0);
        expect(secondOutcome.runId).toBe(firstOutcome.runId);

        // NO-OP COUNTS, because this invocation wrote nothing (AAP §0.7.1
        // Group 3: "an identical rerun (no-op counts)"). It used to replay the
        // first run's stored totals here, so a second invocation reported
        // inserts it had not performed and nothing distinguished it from an
        // import that really did the work.
        expect(secondOutcome.alreadyCompleted).toBe(true);
        expect(secondOutcome.counts.inserted).toBe(0);
        expect(secondOutcome.counts.updated).toBe(0);
        expect(secondOutcome.counts.candidates).toBe(0);
        expect(secondOutcome.counts.quarantined).toBe(0);
        expect(secondOutcome.counts.rejected).toBe(0);
        expect(secondOutcome.counts.missingFromVendor).toBe(0);
        // Its own plan, though: the plan is built before the claim is read, so
        // `planned` is a fact about work this invocation really did.
        expect(secondOutcome.counts.planned).toBe(firstOutcome.counts.planned);
        // Every key the working path reports is present, so a consumer reading
        // `counts.inserted` finds it either way rather than `undefined`.
        expect(Object.keys(secondOutcome.counts).sort()).toEqual(Object.keys(firstOutcome.counts).sort());

        // The scope's durable totals are still available — beside the
        // invocation's counts, where they cannot be mistaken for them.
        expect(secondOutcome.historicalCounts).not.toBeNull();
        expect(secondOutcome.historicalCounts?.inserted).toBe(firstOutcome.counts.inserted);
        // And the run that did the work reports no history of its own.
        expect(firstOutcome.alreadyCompleted).toBe(false);
        expect(firstOutcome.historicalCounts).toBeNull();

        expect(runAfter?.id).toBe(runBefore?.id);
        expect(runAfter?.status).toBe('succeeded');
        expect(runAfter?.finished_at).toEqual(runBefore?.finished_at);
        expect(runAfter?.counts).toEqual(runBefore?.counts);

        expect(after).toHaveLength(before.length);
        expect(after.map((row) => row.id)).toEqual(before.map((row) => row.id));
        // `imported_at` is written once on insert and never on update, so it is
        // the field that would betray a row having been recreated.
        expect(after.map((row) => row.imported_at)).toEqual(before.map((row) => row.imported_at));
    });

    it('collapses the same vendor id listed twice in the manifest to one row', async () => {
        const [entry] = subjects;
        const listedTwice = [entry, entry];
        const vendor = recordingVendor({ records: recordsFor([entry]) });
        const harness = importHarness({ entries: listedTwice, vendor });

        const outcome = await runImport(harness.deps);

        // Collapsed in the PLAN, not merely deduplicated by the upsert: the
        // record is fetched once and counted once, so the duplicate costs no
        // vendor request. Counting it twice would also overstate every
        // per-category total in the report.
        expect(outcome.counts.planned).toBe(1);
        expect(outcome.counts.skippedDuplicateInPlan).toBe(1);
        expect(outcome.counts.inserted).toBe(1);
        expect(vendor.batchCalls).toEqual([[entry.fdcId]]);

        const rows = await storedFoods();
        expect(rows).toHaveLength(1);
        expect(rows[0].source_key).toBe(`usda:${entry.fdcId}`);
    });

    it('records a vendor id the batch did not answer for without writing a row', async () => {
        const [present, absent] = subjects;
        // The vendor answers for one of the two ids it was asked about, which
        // FoodData Central really does when an id has been withdrawn.
        const vendor = recordingVendor({ records: recordsFor([present]) });
        const harness = importHarness({ entries: subjects, vendor });

        const outcome = await runImport(harness.deps);

        expect(outcome.counts.missingFromVendor).toBe(1);
        expect(outcome.counts.inserted).toBe(1);

        const rows = await storedFoods();
        expect(rows).toHaveLength(1);
        expect(rows[0].source_key).toBe(`usda:${present.fdcId}`);
        // A missing record is an absence, never a placeholder row: a food with
        // no nutrients would reach search as a real result.
        expect(rows.map((row) => row.source_key)).not.toContain(`usda:${absent.fdcId}`);
    });
});


/**
 * AN INTERRUPTION LEAVES THE WORK IT FINISHED BEHIND.
 *
 * The stage checkpoints so that "an interruption resumes rather than restarts",
 * and the durable arithmetic of that — which cursor index is saved and how the
 * batch totals accumulate — is pinned by the durable batch-ledger cases above,
 * which run against a vendor that returns no records and a database that
 * refuses every catalog write. This is the other half, and the half those cases
 * cannot see:
 * the batches that DID complete wrote rows inside their own transactions, and
 * those rows have to still be there afterwards. A stage that rolled them back
 * would make a twelve-thousand-record import an all-or-nothing operation, which
 * is precisely what checkpointing exists to avoid.
 *
 * WHAT A BATCH IS NOW, AND WHY THESE CASES CHANGED SHAPE. The rows, the cursor
 * and the counts are one commit per batch. Two consequences are asserted here
 * and were not assertable before, when the cursor was written every fifth batch
 * and the rows in a commit of their own:
 *
 *   - A batch that completes is durable AND accounted for, so the resume starts
 *     at the batch after it. It does not re-fetch or rewrite what committed —
 *     which is the property `--resume` is for, and the reason the old case here
 *     (which asserted the resume re-processing the first batch) described a
 *     defect rather than a contract: up to four committed batches were invisible
 *     to the saved cursor.
 *   - A batch that fails part-way through leaves NOTHING behind, and its cursor
 *     does not move. `rolls back a batch that failed after writing part of
 *     itself` drives that from inside the transaction, which is the only place
 *     a partial batch can be observed at all.
 *
 * The upsert convergence AAP §0.9.2 requires is still proven, on the path that
 * still reaches it: a LATER manifest version covering records the catalog
 * already holds. Under one scope a second run is answered at the claim, so
 * convergence there would be a statement about the claim and not about the
 * upserts.
 */
describe('an interrupted import keeps what it already wrote', () => {
    const subjects = IMPORT_SUBJECTS;
    const firstBatchIds = subjects.slice(0, DETAIL_BATCH_SIZE).map((entry) => entry.fdcId);
    const secondBatchIds = subjects.slice(DETAIL_BATCH_SIZE).map((entry) => entry.fdcId);

    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('plans two batches at the manifest’s batch size', () => {
        expect(secondBatchIds.length).toBeGreaterThan(0);
        expect(firstBatchIds).toHaveLength(DETAIL_BATCH_SIZE);
        expect(firstBatchIds.length + secondBatchIds.length).toBe(subjects.length);
    });

    it('fails on the second batch as its own error, naming the batch that stopped', async () => {
        const vendor = recordingVendor({ records: recordsFor(subjects), failOnCall: 2 });
        const harness = importHarness({ entries: subjects, vendor });

        const failure = await runImport(harness.deps).then(
            () => null,
            (error: unknown) => error,
        );

        // Wrapped at the boundary (§9), so nothing upstream is left reading a
        // shape `usda.service.ts` owns. The enumeration side of this is proven
        // above and defers the batch side to a run against the real client —
        // this is that run, and the batch context is what the vendor's own
        // error cannot carry.
        expect(failure).toBeInstanceOf(CatalogImportError);
        const wrapped = failure as CatalogImportError;
        expect(wrapped.code).toBe('usda_request_failed');
        expect(wrapped.context.batchIndex).toBe(1);
        expect(wrapped.context.fdcIds).toEqual(secondBatchIds);
        expect((wrapped.underlying as Error).name).toBe('UsdaError');
        expect(describeFailure(wrapped).code).toBe('usda_request_failed');
    });

    it('settles the run as failed and keeps the first batch’s rows', async () => {
        const vendor = recordingVendor({ records: recordsFor(subjects), failOnCall: 2 });
        const harness = importHarness({ entries: subjects, vendor });

        await expect(runImport(harness.deps)).rejects.toBeInstanceOf(CatalogImportError);

        const run = await importRunRow();
        // 'failed', not 'running': a row left running for ever cannot be told
        // from an attempt still in flight, which is exactly the read
        // `catalog:validate`'s prerequisite check makes.
        expect(run?.status).toBe('failed');
        expect(run?.finished_at).not.toBeNull();

        const rows = await storedFoods();
        expect(rows).toHaveLength(firstBatchIds.length);
        expect(rows.map((row) => row.source_key).sort()).toEqual(
            firstBatchIds.map((fdcId) => `usda:${fdcId}`).sort(),
        );

        // And they are complete rows, not half-written ones: the per-batch
        // transaction commits a food with its aliases, portions and validation
        // record together or not at all.
        for (const row of rows) {
            expect(row.publication_status).toBe('candidate');
            const portions = await prisma.catalog_food_portions.count({ where: { catalog_food_id: row.id } });
            const record = await prisma.catalog_validation_records.count({ where: { catalog_food_id: row.id } });
            expect(portions).toBeGreaterThan(0);
            expect(record).toBe(1);
        }
    });

    it('resumes into the tail, without re-fetching or rewriting the batch that committed', async () => {
        const interrupted = recordingVendor({ records: recordsFor(subjects), failOnCall: 2 });
        await expect(runImport(importHarness({ entries: subjects, vendor: interrupted }).deps)).rejects.toBeInstanceOf(
            CatalogImportError,
        );

        const before = await storedFoods();
        expect(before).toHaveLength(firstBatchIds.length);
        const failedRun = await importRunRow();
        expect(failedRun?.status).toBe('failed');
        // The failure is between batches, so batch one is durable and the
        // cursor says exactly that: the resume below starts at index 1.
        expect(failedRun?.cursor).toMatchObject({ nextBatchIndex: 1 });
        expect(failedRun?.counts).toMatchObject({ batchesProcessed: 1, inserted: firstBatchIds.length });

        const resumed = recordingVendor({ records: recordsFor(subjects) });
        const outcome = await runImport(
            importHarness({ entries: subjects, vendor: resumed, options: { resume: true } }).deps,
        );

        // The same run row is continued rather than a second one opened beside
        // it: `openOrResumeRun` reopens a failed row through its retry path.
        expect(outcome.resumed).toBe(true);
        expect(outcome.runId).toBe(failedRun?.id);
        const settledRun = await importRunRow();
        expect(settledRun?.id).toBe(failedRun?.id);
        expect(settledRun?.status).toBe('succeeded');

        // THE SAVED CURSOR IS TRUSTED, BECAUSE IT CAN BE. Batch one's rows and
        // batch one's cursor were one commit, so the resume spends no vendor
        // request on it and rewrites none of its rows — twenty records of
        // fetch-and-upsert saved per resumed batch on a real 12,000-record
        // import, and no second `updated_at` on rows nothing changed about.
        expect(resumed.batchCalls).toEqual([secondBatchIds]);

        // THE RETURNED COUNTS ARE THIS ATTEMPT'S, and the ledger's are the
        // run's. The distinction is what a merge-free closure buys: the attempt
        // inserted the eight records it processed, and the ROW says twenty-eight
        // because the twenty from the first attempt were already durable when
        // it stopped.
        // A closure that merged this attempt's absolute totals into the row
        // instead would read forty-eight.
        expect(outcome.processedBatches).toBe(1);
        expect(outcome.counts.inserted).toBe(secondBatchIds.length);
        expect(outcome.counts.updated).toBe(0);
        expect(settledRun?.counts).toMatchObject({
            planned: subjects.length,
            inserted: subjects.length,
            updated: 0,
            batchesProcessed: 2,
        });
        expect(settledRun?.cursor).toMatchObject({ nextBatchIndex: 2 });

        const after = await storedFoods();
        expect(after).toHaveLength(subjects.length);

        // Identity survives the interruption, which is what every
        // `recipe_ingredients` and `meal_entries` reference taken against the
        // first attempt depends on.
        const byKey = new Map(after.map((row) => [row.source_key, row]));
        for (const row of before) {
            const survivor = byKey.get(row.source_key);
            expect(survivor?.id).toBe(row.id);
            expect(survivor?.imported_at).toEqual(row.imported_at);
        }

        // One row per vendor id across the whole plan, and one default portion
        // each — the two invariants a re-processing resume would break first.
        expect(new Set(after.map((row) => row.source_key)).size).toBe(after.length);
        for (const row of after) {
            const defaults = await prisma.catalog_food_portions.count({
                where: { catalog_food_id: row.id, is_default: true },
            });
            expect(defaults).toBe(1);
        }
    });

    it('rolls back a batch that failed after writing part of itself, and re-does exactly that batch', async () => {
        // The second food of the SECOND batch: batch one's twenty writes come
        // first, then one complete food, then the food whose record write this
        // rejects. So the transaction has written two food rows with their
        // aliases and portions, and one validation record, before it fails.
        const failing = failAfterPartialBatchWrite({
            failOnValidationRecordWrite: firstBatchIds.length + 2,
            message: 'validation record write lost mid-batch',
        });
        const interrupted = recordingVendor({ records: recordsFor(subjects) });

        await expect(
            runImport(importHarness({ entries: subjects, vendor: interrupted, db: failing.db }).deps),
        ).rejects.toThrow('validation record write lost mid-batch');

        // Both batches were fetched — the failure is in persistence, not in the
        // vendor — which is what makes this a different path from the cases
        // above rather than a restatement of them.
        expect(interrupted.batchCalls).toEqual([firstBatchIds, secondBatchIds]);

        // A PARTIAL BATCH EXISTED. Read from inside the aborted transaction, so
        // it counts rows that were really written: batch one's twenty plus the
        // two this batch had got to. Without this the rollback assertion below
        // would be satisfied just as well by a stage that failed before writing
        // anything, and the contract would go untested.
        const partial = failing.partialWrite;
        expect(partial).not.toBeNull();
        expect(partial?.foods).toBe(firstBatchIds.length + 2);
        expect(partial?.validationRecords).toBe(firstBatchIds.length + 1);
        expect(partial?.aliases).toBeGreaterThan(0);
        expect(partial?.portions).toBeGreaterThan(0);

        // AND IT IS GONE. Not one of the two, not the complete one: the batch
        // is atomic, so a food whose validation record could not be written
        // leaves no food row either — which is the invariant
        // `catalog:validate` reads the catalog under (AAP §0.1.1: every item
        // has a machine-readable validation record).
        const afterFailure = await storedFoods();
        expect(afterFailure).toHaveLength(firstBatchIds.length);
        expect(afterFailure.map((row) => row.source_key).sort()).toEqual(
            firstBatchIds.map((fdcId) => `usda:${fdcId}`).sort(),
        );

        // THE CURSOR DID NOT MOVE PAST IT, and the counts do not claim it. The
        // checkpoint is the transaction's last statement, so it rolled back
        // with the rows: the ledger cannot describe work the database does not
        // hold, in either direction.
        const failedRun = await importRunRow();
        expect(failedRun?.status).toBe('failed');
        expect(failedRun?.cursor).toMatchObject({ nextBatchIndex: 1 });
        expect(failedRun?.counts).toMatchObject({
            batchesProcessed: 1,
            inserted: firstBatchIds.length,
        });

        // The retry gets a working client and re-does the rolled-back batch —
        // exactly it, exactly once.
        const retried = recordingVendor({ records: recordsFor(subjects) });
        const outcome = await runImport(
            importHarness({ entries: subjects, vendor: retried, options: { resume: true } }).deps,
        );

        expect(outcome.runId).toBe(failedRun?.id);
        expect(retried.batchCalls).toEqual([secondBatchIds]);
        // INSERTED, not updated: the rolled-back batch left nothing for the
        // retry to recognise, so its eight records are new rows. `updated: 0`
        // is therefore the second, independent witness to the rollback — a
        // batch that had half-committed would show updates here.
        expect(outcome.counts.inserted).toBe(secondBatchIds.length);
        expect(outcome.counts.updated).toBe(0);
        const settledRun = await importRunRow();
        expect(settledRun?.status).toBe('succeeded');
        expect(settledRun?.counts).toMatchObject({
            planned: subjects.length,
            inserted: subjects.length,
            updated: 0,
            batchesProcessed: 2,
        });

        const settled = await storedFoods();
        expect(settled).toHaveLength(subjects.length);
        expect(new Set(settled.map((row) => row.source_key)).size).toBe(settled.length);
        for (const row of settled) {
            const record = await prisma.catalog_validation_records.count({ where: { catalog_food_id: row.id } });
            const defaults = await prisma.catalog_food_portions.count({
                where: { catalog_food_id: row.id, is_default: true },
            });
            expect(record).toBe(1);
            expect(defaults).toBe(1);
        }
    });

    it('converges on the same rows when a later manifest version re-imports the same records', async () => {
        const first = recordingVendor({ records: recordsFor(subjects) });
        const firstOutcome = await runImport(importHarness({ entries: subjects, vendor: first }).deps);
        const before = await storedFoods();
        expect(before).toHaveLength(subjects.length);

        // A second scope, so this is a genuine second import of the same vendor
        // records rather than a claim answered as already completed.
        const again = recordingVendor({ records: recordsFor(subjects) });
        const outcome = await runImport(
            importHarness({ entries: subjects, vendor: again, scope: IMPORT_RERUN_SCOPE }).deps,
        );

        // Its own run row, not a resume of the first: two manifest versions are
        // two claims, and each closes only its own.
        expect(outcome.runId).not.toBe(firstOutcome.runId);
        expect(outcome.resumed).toBe(false);
        expect((await importRunRow(IMPORT_RERUN_SCOPE))?.status).toBe('succeeded');
        expect((await importRunRow())?.status).toBe('succeeded');
        expect(again.batchCalls).toEqual([firstBatchIds, secondBatchIds]);

        // Every record recognised and rewritten in place. If the repeat had
        // inserted instead of updating, this would read 28 and 0 — and the
        // table would carry two rows per vendor id.
        expect(outcome.counts.updated).toBe(subjects.length);
        expect(outcome.counts.inserted).toBe(0);

        const after = await storedFoods();
        expect(after).toHaveLength(subjects.length);
        expect(new Set(after.map((row) => row.source_key)).size).toBe(after.length);

        // Same row, same `imported_at`: the identity a recipe ingredient or a
        // diary entry took against the first import still resolves, and the
        // exported release stays byte-identical across the rerun.
        const byKey = new Map(after.map((row) => [row.source_key, row]));
        for (const row of before) {
            const survivor = byKey.get(row.source_key);
            expect(survivor?.id).toBe(row.id);
            expect(survivor?.imported_at).toEqual(row.imported_at);
        }

        // Children replaced wholesale rather than accumulated, which is the
        // other way a rerun duplicates: one default portion, one record.
        for (const row of after) {
            const defaults = await prisma.catalog_food_portions.count({
                where: { catalog_food_id: row.id, is_default: true },
            });
            const records = await prisma.catalog_validation_records.count({
                where: { catalog_food_id: row.id },
            });
            expect(defaults).toBe(1);
            expect(records).toBe(1);
        }
    });
});

/**
 * A RESUMED RUN REPORTS THE RUN, NOT THE LAST ATTEMPT.
 *
 * The pure arithmetic is pinned above. What only a real resume can show is the
 * WIRING: that the figures were written into the cursor alongside the batch
 * index, that the resume read them back, and that the final artefact states
 * carried plus this attempt with the basis it was arrived at by.
 */
describe('a resumed import reports the whole run', () => {
    const subjects = IMPORT_SUBJECTS;
    const secondBatchIds = subjects.slice(DETAIL_BATCH_SIZE).map((entry) => entry.fdcId);

    const clearRuns = async (): Promise<void> => {
        await prisma.catalog_import_runs.deleteMany({
            where: { kind: 'usda_import', manifest_version: IMPORT_RUN_SCOPE },
        });
    };

    beforeEach(async () => {
        await truncateFeatureTables();
        await clearRuns();
    });

    afterEach(clearRuns);

    /** The fingerprint the resume matches its cursor against. */
    const planFingerprint = async (): Promise<string> => {
        const plan = await buildImportPlan(
            narrowedManifest(subjects),
            coveragePlan,
            async (): Promise<UsdaFoodSummary[]> => [],
            options(),
            silentLogger,
        );
        return plan.fingerprint;
    };

    const carried: ImportReportSnapshot = {
        attempts: 1,
        throughBatchIndex: 1,
        processedBatches: 1,
        counts: { inserted: 20, updated: 0, candidates: 20, quarantined: 0, rejected: 0, missingFromVendor: 0 },
        byCategory: { produce_fruit: 20 },
        byCheck: {},
        byIdentityStatus: { verified: 20 },
        byNutritionMethod: { usda_record: 20 },
        byCategoryOutcome: { produce_fruit: { written: 20, candidates: 20, quarantined: 0, rejected: 0 } },
        refused: [],
    };

    it('adds this attempt to the figures the cursor carried, and states the basis', async () => {
        const fingerprint = await planFingerprint();
        await prisma.catalog_import_runs.create({
            data: {
                kind: 'usda_import',
                manifest_version: IMPORT_RUN_SCOPE,
                status: 'running',
                counts: {},
                log: [],
                cursor: { fingerprint, nextBatchIndex: 1, report: carried } as unknown as object,
            },
        });

        // The resume is ASKED FOR, because continuing an unfinished run is now
        // explicit: without the flag the claim refuses the row this case just
        // created and writes nothing (`run_resume_not_requested` — see
        // “refuses to continue an unfinished run unless it was asked to”). An
        // operator continuing an interrupted import passes `--resume`, and that
        // is the invocation whose report this case reads.
        const harness = importHarness({
            entries: subjects,
            vendor: recordingVendor({ records: recordsFor(subjects) }),
            options: { resume: true },
        });
        const outcome = await runImport(harness.deps);

        expect(outcome.resumed).toBe(true);
        const report = harness.reports[0] as Record<string, unknown>;
        const counts = report.counts as Record<string, number>;
        const aggregation = report.runAggregation as Record<string, unknown>;

        // The cursor said batch 1, so only the second batch was fetched — and
        // the figures still cover both.
        expect(counts.inserted).toBe(carried.counts.inserted + secondBatchIds.length);
        expect(report.processedBatches).toBe(2);
        expect((report.byCategory as Record<string, number>).produce_fruit).toBeGreaterThanOrEqual(
            carried.byCategory.produce_fruit,
        );

        // And the report says how it got there, so a reader can tell a
        // resumed run from a single attempt instead of inferring it from a
        // batch count that does not add up.
        expect(aggregation.carriedFromEarlierAttempts).toBe(true);
        expect(aggregation.carriedThroughBatchIndex).toBe(1);
        expect(aggregation.attempts).toBe(2);
        expect(aggregation.resumedFromBatchIndex).toBe(1);
        expect(aggregation.batchesThisAttempt).toBe(1);
        expect(aggregation.figuresCoverWholeRun).toBe(true);
        expect(String(aggregation.basis)).toContain('the snapshot the cursor carried');
        // Plan-time figures are recomputed identically by every attempt, so
        // carrying them would double them.
        expect(aggregation.countsExcludedFromCarry).toContain('planned');
    });

    it('says the figures cover one attempt when the cursor carried none', async () => {
        const fingerprint = await planFingerprint();
        await prisma.catalog_import_runs.create({
            data: {
                kind: 'usda_import',
                manifest_version: IMPORT_RUN_SCOPE,
                status: 'running',
                counts: {},
                log: [],
                cursor: { fingerprint, nextBatchIndex: 1 } as unknown as object,
            },
        });

        // Asked for, as above: the row is unfinished, so the attempt that
        // continues it is one that passed `--resume`.
        const harness = importHarness({
            entries: subjects,
            vendor: recordingVendor({ records: recordsFor(subjects) }),
            options: { resume: true },
        });
        await runImport(harness.deps);

        const aggregation = (harness.reports[0] as Record<string, unknown>).runAggregation as Record<string, unknown>;

        // A cursor from an earlier revision of this stage carries no snapshot.
        // The run's work is committed, so it reports what it can measure and
        // states plainly that the figures understate the run — and says so in
        // a field, not only in prose, because the prose is for a human and the
        // flag is for whatever reads the artefact next.
        expect(aggregation.carriedFromEarlierAttempts).toBe(false);
        expect(aggregation.carriedThroughBatchIndex).toBeNull();
        expect(aggregation.attempts).toBe(1);
        expect(aggregation.resumedFromBatchIndex).toBe(1);
        expect(aggregation.figuresCoverWholeRun).toBe(false);
        expect(String(aggregation.basis)).toContain('carried no report snapshot');
        expect(String(aggregation.basis)).toContain('understate');
    });

    /**
     * A FINGERPRINT MISMATCH RESTARTS THE COUNTERS WITH THE WORK
     * (CATIMP-additive-run-counters).
     *
     * The run ledger merges additively, which is what makes a resumed run's
     * row describe the whole run. A resume whose cursor names a DIFFERENT plan
     * is the one case where that is wrong: the attempt restarts at batch 0, so
     * the abandoned attempt's totals count records this attempt is about to
     * plan again. Left in place they overstate every figure on the row — QA
     * measured `candidates` at twice the row count with `inserted` and
     * `updated` each equal to it — and the old plan's own keys linger beside
     * the new plan's.
     */
    it('restarts the run row’s counters when the saved cursor belongs to another plan', async () => {
        const abandoned = {
            planned: 999,
            inserted: 999,
            updated: 999,
            candidates: 999,
            batchesProcessed: 9,
            skippedRuleOfTheOldPlan: 7,
        };
        await prisma.catalog_import_runs.create({
            data: {
                kind: 'usda_import',
                manifest_version: IMPORT_RUN_SCOPE,
                status: 'running',
                counts: abandoned,
                log: [],
                cursor: {
                    fingerprint: 'a-fingerprint-from-another-plan',
                    nextBatchIndex: 1,
                    report: carried,
                } as unknown as object,
            },
        });

        const warnings: { event: string; fields?: Record<string, unknown> }[] = [];
        const recordingLogger: ScriptLogger = {
            ...silentLogger,
            warn: (event: string, fields?: Record<string, unknown>) => {
                warnings.push({ event, fields });
            },
            child: () => recordingLogger,
        };

        const harness = importHarness({
            entries: subjects,
            vendor: recordingVendor({ records: recordsFor(subjects) }),
            options: { resume: true },
            logger: recordingLogger,
        });
        const outcome = await runImport(harness.deps);

        // The restart is announced, and BOTH sides of it: a counter that fell
        // is as confusing as one that overstates, so the discarded totals are
        // named beside the restarted ones.
        const events = warnings.map((entry) => entry.event);
        expect(events).toContain('cursor_plan_changed');
        expect(events).toContain('run_counts_restarted');
        const restarted = warnings.find((entry) => entry.event === 'run_counts_restarted');
        expect(String(restarted?.fields?.discardedCounts)).toContain('999');
        expect(String(restarted?.fields?.counts)).toContain(`"planned":${subjects.length}`);

        // The row now states THIS attempt's work and nothing else: it
        // re-processed every batch, so `inserted` is the subject count rather
        // than 999 plus it, and the abandoned plan's own key is gone.
        const row = await importRunRow();
        const counts = (row?.counts ?? {}) as Record<string, number>;
        expect(counts.planned).toBe(subjects.length);
        expect(counts.inserted).toBe(subjects.length);
        expect(counts.updated).toBe(0);
        expect(counts.candidates).toBe(subjects.length);
        expect(counts.batchesProcessed).toBe(2);
        expect(counts.skippedRuleOfTheOldPlan).toBeUndefined();
        expect(outcome.counts.inserted).toBe(subjects.length);

        // And the durable run log says it, so an operator reading the row
        // afterwards sees the reset rather than inferring a lost update.
        const logged = await prisma.catalog_import_runs.findUnique({
            where: { id: row?.id as string },
            select: { log: true },
        });
        const entries = ((logged?.log ?? []) as Record<string, unknown>[]).filter(
            (entry) => entry.event === 'run_counts_restarted',
        );
        expect(entries).toHaveLength(1);
        expect((entries[0].counts as Record<string, number>).planned).toBe(subjects.length);
    });

    it('writes the figures into the cursor it saves, so the next attempt can carry them', async () => {
        const harness = importHarness({ entries: subjects, vendor: recordingVendor({ records: recordsFor(subjects) }) });
        await runImport(harness.deps);

        const run = await importRunRow();
        const snapshotOnDisk = readImportReportSnapshot(run?.cursor);

        // The cursor and the figures are written together, so the two can
        // never describe different amounts of work.
        expect(snapshotOnDisk).not.toBeNull();
        expect(snapshotOnDisk?.throughBatchIndex).toBe(2);
        expect(snapshotOnDisk?.processedBatches).toBe(2);
        expect(snapshotOnDisk?.counts.inserted).toBe(subjects.length);
        expect(snapshotOnDisk?.attempts).toBe(1);

        // A single pass over the whole work list reads as covering the run.
        const aggregation = (harness.reports[0] as Record<string, unknown>).runAggregation as Record<string, unknown>;
        expect(aggregation.figuresCoverWholeRun).toBe(true);
        expect(String(aggregation.basis)).toContain('A single pass over the whole work list');
    });
});


/**
 * THE RECORDED VENDOR SHAPES, DRIVEN THROUGH THE RUN.
 *
 * `data/meal-planning/fixtures/usda-detail-samples.json` records the response
 * shapes FoodData Central really returns, including the five awkward ones its
 * own notes mark MANDATORY EDGE CASE. The cases below take those payloads
 * verbatim and assert what the ORCHESTRATION does with them — which
 * `publication_status` the row lands in, which counter moves, what reaches
 * `catalog_food_portions`. What a check's bound is, and whether a number sits
 * inside it, belongs to `catalog.logic.test.ts` and is not re-derived here.
 *
 * Only the `payload` member of a sample is vendor JSON. Every sibling — `note`,
 * `endpoint`, `consumedBy`, `expected*` — is annotation written for a reader,
 * and passing one to the stage would be asserting against the fixture's prose
 * rather than against USDA's shape. The fixture's own `readingGuide` states
 * that rule; these cases follow it.
 */
interface FixtureSample {
    readonly payload: UsdaFoodDetail;
}

interface DetailSamplesFixture {
    readonly fixtureVersion: string;
    readonly nutrientNumbers: {
        readonly protein: string;
        readonly fat: string;
        readonly carbs: string;
        readonly calories: string;
        readonly caloriesFallbackFormula: string;
    };
    readonly portionSamples: Readonly<Record<string, FixtureSample>>;
    readonly detailResponses: Readonly<Record<string, FixtureSample>>;
}

const detailSamples: DetailSamplesFixture = readJsonFile<DetailSamplesFixture>(
    fixturePath('usda-detail-samples.json'),
);

const portionSample = (name: string): UsdaFoodDetail => {
    const sample = detailSamples.portionSamples[name];
    expect(sample).toBeDefined();
    expect(sample.payload).toBeDefined();

    return sample.payload;
};

/**
 * A curated entry standing in for a recorded payload's vendor id.
 *
 * The category comes from a real reviewed entry, so the record is judged
 * against a real category's bounds rather than one invented here, and the
 * payload supplies everything the import actually reads from the vendor: the
 * per-100 g nutrients and the portions.
 */
const entryStandingIn = (category: string, fdcId: number): CuratedEntry => {
    const base = curatedIn(category)[0];
    expect(base).toBeDefined();

    return { ...base, fdcId };
};

const withoutNutrient = (detail: UsdaFoodDetail, nutrientNumber: string): UsdaFoodDetail => ({
    ...detail,
    foodNutrients: (detail.foodNutrients ?? []).filter(
        (entry) => String(entry.nutrient?.number ?? entry.nutrientNumber ?? '') !== nutrientNumber,
    ),
});

const nutrientAmount = (detail: UsdaFoodDetail, nutrientNumber: string): number => {
    const found = (detail.foodNutrients ?? []).find(
        (entry) => String(entry.nutrient?.number ?? entry.nutrientNumber ?? '') === nutrientNumber,
    );
    expect(found).toBeDefined();
    const amount = found?.amount ?? found?.value;
    expect(typeof amount).toBe('number');

    return amount as number;
};

interface SingleRecordRun {
    readonly outcome: Awaited<ReturnType<typeof runImport>>;
    readonly row: StoredFoodRow;
}

const importOneRecord = async (entry: CuratedEntry, payload: UsdaFoodDetail): Promise<SingleRecordRun> => {
    const records = new Map<number, UsdaFoodDetail>([[entry.fdcId, payload]]);
    const harness = importHarness({ entries: [entry], vendor: recordingVendor({ records }) });
    const outcome = await runImport(harness.deps);

    return { outcome, row: await storedFood(`usda:${entry.fdcId}`) };
};

const portionsOf = async (foodId: string): Promise<{ description: string; gram_weight: unknown; is_default: boolean; source: string | null }[]> =>
    prisma.catalog_food_portions.findMany({
        where: { catalog_food_id: foodId },
        orderBy: { description: 'asc' },
        select: { description: true, gram_weight: true, is_default: true, source: true },
    }) as unknown as Promise<{ description: string; gram_weight: unknown; is_default: boolean; source: string | null }[]>;

const assumptionsOf = async (foodId: string): Promise<string[]> => {
    const record = await prisma.catalog_validation_records.findUnique({
        where: { catalog_food_id: foodId },
        select: { nutrition_assumptions: true },
    });
    const raw = (record as { nutrition_assumptions?: string | null } | null)?.nutrition_assumptions;
    if (raw === null || raw === undefined) {
        return [];
    }

    // A JSON-encoded array in a TEXT column, which is what the release
    // exporter parses back to the array the release format states.
    const parsed: unknown = JSON.parse(raw);

    return Array.isArray(parsed) ? parsed.map((entry) => String(entry)) : [];
};

describe('the recorded vendor shapes the import has to survive', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('reads the fixture the manifest points at, at the version it declares', () => {
        expect(detailSamples.fixtureVersion).toBe('v1');
        // The numbers the stage selects on are the manifest's, and the fixture
        // records the same four. A divergence between the two documents would
        // make every case below assert against a nutrient nobody reads.
        expect(detailSamples.nutrientNumbers.protein).toBe(manifest.nutrientNumbers.protein);
        expect(detailSamples.nutrientNumbers.carbs).toBe(manifest.nutrientNumbers.carbs);
        expect(detailSamples.nutrientNumbers.fat).toBe(manifest.nutrientNumbers.fat);
        expect(detailSamples.nutrientNumbers.calories).toBe(manifest.nutrientNumbers.calories);
        expect(detailSamples.nutrientNumbers.caloriesFallbackFormula).toBe(manifest.caloriesFallback);
    });

    it('takes per-100 g nutrients from the nested detail shape', async () => {
        const payload = portionSample('srLegacyPortions');
        const entry = entryStandingIn('produce_vegetable', payload.fdcId);

        const { outcome, row } = await importOneRecord(entry, payload);

        // A detail record nests the descriptor — `nutrient.number` with
        // `amount` — where a search result flattens it. Both shapes reach this
        // stage, and reading only the flat one would leave every Foundation and
        // SR Legacy record with no nutrients at all.
        expect(outcome.counts.inserted).toBe(1);
        expect(Number(row.calories)).toBeCloseTo(nutrientAmount(payload, manifest.nutrientNumbers.calories), 6);
        expect(row.nutrition_basis).toBe('per_100g');
        expect(Number(row.basis_amount)).toBe(100);
    });

    describe('a record the source states no energy for', () => {
        it('derives calories from the manifest’s documented fallback and records the assumption', async () => {
            const complete = portionSample('srLegacyPortions');
            const payload = withoutNutrient(complete, manifest.nutrientNumbers.calories);
            const entry = entryStandingIn('produce_vegetable', payload.fdcId);

            const protein = nutrientAmount(payload, manifest.nutrientNumbers.protein);
            const carbs = nutrientAmount(payload, manifest.nutrientNumbers.carbs);
            const fat = nutrientAmount(payload, manifest.nutrientNumbers.fat);
            const expected = Math.round((4 * protein + 4 * carbs + 9 * fat) * 100) / 100;

            const { outcome, row } = await importOneRecord(entry, payload);

            // Imported, not refused: energy is the one core nutrient the stage
            // can honestly reconstruct, because the manifest documents the
            // formula it reconstructs it with.
            expect(outcome.counts.inserted).toBe(1);
            expect(outcome.counts.candidates).toBe(1);
            expect(outcome.counts.quarantined).toBe(0);
            expect(outcome.counts.rejected).toBe(0);
            expect(row.publication_status).toBe('candidate');
            expect(Number(row.calories)).toBeCloseTo(expected, 6);

            // A derived number has to say so. The validation record is where a
            // reader learns this food's energy was computed rather than stated,
            // and a silent derivation would be indistinguishable from a
            // source-stated value.
            const assumptions = await assumptionsOf(row.id);
            expect(assumptions.some((line) => line.includes(manifest.caloriesFallback))).toBe(true);
        });
    });

    describe('a record whose portions carry no usable gram weight', () => {
        /**
         * Three distinct shapes, and the fixture keeps them separate because a
         * guard written one way catches some and not others: a portion with no
         * `gramWeight` member, one with an explicit `0`, one with a
         * non-numeric string, plus the absent key and the empty array.
         */
        const weightless: readonly [string, string][] = [
            ['portionsWithoutUsableGramWeight', 'produce_fruit'],
            ['noFoodPortionsKey', 'grain'],
            ['emptyFoodPortionsArray', 'produce_fruit'],
        ];

        it.each(weightless)('writes no weightless portion row for %s', async (sampleName, category) => {
            const payload = portionSample(sampleName);
            const entry = entryStandingIn(category, payload.fdcId);

            const { row } = await importOneRecord(entry, payload);
            const portions = await portionsOf(row.id);

            // `gram_weight` is NOT NULL, so an unusable portion is not
            // persisted as a zero that would later read as a fact and
            // propagate into recipe nutrition and grocery quantities.
            for (const portion of portions) {
                expect(Number(portion.gram_weight)).toBeGreaterThan(0);
            }

            // What the food keeps instead is the source's own basis restated:
            // the manifest's 100 g basis portion, which becomes the default
            // only when the record states no household portion at all. That is
            // the manifest's declared policy — "a 100 g portion is the source's
            // own basis restated, not an invented weight" — and it is what lets
            // a record with no published portions carry a default without one
            // being fabricated.
            const basis = manifest.sweepPortionPolicy.basisPortion;
            const defaults = portions.filter((portion) => portion.is_default);
            expect(defaults).toHaveLength(1);
            expect(defaults[0].description).toBe(basis.description);
            expect(Number(defaults[0].gram_weight)).toBe(basis.gramWeight);
            expect(defaults[0].source).toBe(basis.source);
        });
    });

    describe('a record missing a core nutrient', () => {
        it('is quarantined, counted, and still written with its validation record', async () => {
            const complete = portionSample('srLegacyPortions');
            const payload = withoutNutrient(complete, manifest.nutrientNumbers.protein);
            const entry = entryStandingIn('produce_vegetable', payload.fdcId);

            const { outcome, row } = await importOneRecord(entry, payload);

            // Quarantined rather than dropped: the row and its machine-readable
            // record are what let an operator see WHY it is unpublishable and
            // re-judge it on the next pass once the source fills the gap.
            expect(row.publication_status).toBe('quarantined');
            expect(outcome.counts.quarantined).toBe(1);
            expect(outcome.counts.candidates).toBe(0);
            expect(outcome.counts.inserted).toBe(1);

            const record = await prisma.catalog_validation_records.findUnique({
                where: { catalog_food_id: row.id },
                select: { publication_status: true, outcome: true },
            });
            expect(record?.publication_status).toBe('quarantined');

            // A missing nutrient is unknown, never zero: zero is a claim about
            // the food and would reach a recipe as a real value.
            expect(row.calories).not.toBeNull();
            const stored = await prisma.catalog_foods.findUnique({
                where: { id: row.id },
                select: { protein_g: true },
            });
            expect(stored?.protein_g).toBeNull();
        });
    });

    /**
     * THE TWO NUTRIENT FAMILIES, WHICH MUST NEVER BE INTERCHANGED.
     *
     * The fixture's own reading guide calls this "the distinction the whole
     * file turns on": a search result carries per-100 g nutrients in
     * `foodNutrients`, while a detail response carries `labelNutrients` that
     * are ALREADY per serving and are never scaled. The import reads
     * `foodNutrients` and stores the row on a per-100 g basis; the running
     * API's branded path reads `labelNutrients`. Confusing the two would not
     * fail loudly — it would publish a plausible number on the wrong basis, and
     * every recipe gram weight and grocery quantity derived from it afterwards
     * would be wrong by the serving size. Nothing else in the suite would catch
     * it, which is why this case exists.
     */
    describe('the per-100 g and per-serving families are never interchanged', () => {
        it('ignores a per-serving label block sitting beside the per-100 g nutrients', async () => {
            const perHundredGrams = portionSample('srLegacyPortions');
            const decoy = detailSamples.detailResponses.brandedDetailComplete;
            expect(decoy?.payload.labelNutrients).toBeDefined();

            const payload: UsdaFoodDetail = {
                ...perHundredGrams,
                // A real recorded per-serving label block, carried alongside a
                // real recorded per-100 g nutrient array, with the serving size
                // that would scale it.
                servingSize: decoy.payload.servingSize,
                servingSizeUnit: decoy.payload.servingSizeUnit,
                labelNutrients: decoy.payload.labelNutrients,
            };
            const entry = entryStandingIn('produce_vegetable', payload.fdcId);

            const perServingCalories = decoy.payload.labelNutrients?.calories?.value;
            const per100gCalories = nutrientAmount(perHundredGrams, manifest.nutrientNumbers.calories);
            // The premise: the two families disagree, so the assertion below
            // can tell which one was read.
            expect(perServingCalories).toBeDefined();
            expect(perServingCalories).not.toBe(per100gCalories);

            const { row } = await importOneRecord(entry, payload);

            expect(Number(row.calories)).toBeCloseTo(per100gCalories, 6);
            expect(Number(row.calories)).not.toBeCloseTo(perServingCalories as number, 6);
            expect(row.nutrition_basis).toBe('per_100g');
            expect(Number(row.basis_amount)).toBe(100);
        });

        it('imports a generic record that carries no label block at all', async () => {
            const payload = portionSample('foundationPortions');
            expect(payload.labelNutrients).toBeUndefined();
            const entry = entryStandingIn('produce_vegetable', payload.fdcId);

            const { outcome, row } = await importOneRecord(entry, payload);

            // Every Foundation and SR Legacy record is this shape, so a stage
            // that needed `labelNutrients` would import none of them.
            expect(outcome.counts.inserted).toBe(1);
            expect(row.publication_status).toBe('candidate');
            expect(Number(row.calories)).toBeCloseTo(
                nutrientAmount(payload, manifest.nutrientNumbers.calories),
                6,
            );
        });

        it('is unaffected by a serving size the branded search path would refuse', async () => {
            const payload: UsdaFoodDetail = { ...portionSample('srLegacyPortions'), servingSize: 0, servingSizeUnit: 'g' };
            const entry = entryStandingIn('produce_vegetable', payload.fdcId);

            const { outcome, row } = await importOneRecord(entry, payload);

            // A zero serving size is fatal on the per-serving path — scaling by
            // it would publish a zero-calorie food — and inert here, because
            // this stage never derives its basis from `servingSize`. The two
            // paths reading the same field differently is the point.
            expect(outcome.counts.inserted).toBe(1);
            expect(row.publication_status).toBe('candidate');
            expect(Number(row.calories)).toBeCloseTo(
                nutrientAmount(payload, manifest.nutrientNumbers.calories),
                6,
            );
        });
    });
});

// ---------------------------------------------------------------------------
// THE PACING A RUN INSTALLS, AND WHERE IT SITS.
//
// `runImport` calls `deps.installRateLimiter()` once and takes it down in a
// `finally`, and an installed limiter IS a replaced `globalThis.fetch`. WHERE
// that gate sits is the contract: at the transport it sees every physical
// attempt, so a logical call USDA answers unusably three times costs four
// tokens; wrapped around the accessor instead it would see one token per
// logical call and undercount by up to four. On a key with 1,000 requests an
// hour that is the difference between staying inside the ceiling and being cut
// off partway through a 10,000-record import.
//
// WHAT IS NOT ASSERTED HERE. The retry ladder's own rules — which statuses are
// retried, how long it backs off, when it gives up — belong to
// `src/services/usda.service.ts` and are asserted in `usda.service.test.ts`;
// the client below reproduces the SHAPE only, driven by the statuses the
// manifest documents, and exists solely to make one logical call cost several
// physical ones. The limiter's own arithmetic, its pauses under an empty
// bucket, its refusals, its URL matching and its configuration reading are all
// proven above with no database at all. What is left, and lives only here, is
// the wiring: the gate this stage installs counts attempts rather than calls,
// spends nothing on a call that never leaves the process, and is taken back
// down even when the run fails.
// ---------------------------------------------------------------------------

/**
 * The retry policy the manifest documents. Read from the same document
 * `loadUsdaManifest()` reads rather than restated here, and read through a
 * local type because `UsdaImportLimits` does not declare these fields yet —
 * so the numbers the cases below compute with are the reviewed ones, and a
 * manifest edit reports itself in the premise case rather than as arithmetic
 * that quietly stopped matching.
 */
interface UsdaRetryPolicy {
    readonly maxPhysicalAttemptsPerRequest: number;
    readonly retriedStatuses: readonly number[];
    readonly limiterCountsPhysicalAttempts: boolean;
}

const usdaRetryPolicy: UsdaRetryPolicy = readJsonFile<{ readonly importLimits: UsdaRetryPolicy }>(
    dataPath(USDA_MANIFEST_FILE),
).importLimits;

interface PacedTransport {
    /** One entry per PHYSICAL call, in call order. */
    readonly urls: string[];
    readonly fetch: typeof globalThis.fetch;
}

/**
 * A transport answering with the given statuses in order, then `fallbackStatus`
 * once they run out. The ladder below branches on `ok`, so the number of
 * physical attempts a logical call costs is decided by these answers rather
 * than by a count written into the client.
 */
const pacedTransport = (answers: readonly number[], fallbackStatus: number = 200): PacedTransport => {
    const urls: string[] = [];
    const queue = [...answers];

    const transport = async (input: unknown): Promise<Response> => {
        urls.push(typeof input === 'string' ? input : String(input));
        const status = queue.length > 0 ? (queue.shift() as number) : fallbackStatus;

        return { ok: status >= 200 && status < 300, status } as unknown as Response;
    };

    return { urls, fetch: transport as unknown as typeof globalThis.fetch };
};

interface PacedVendor {
    readonly usda: RunImportDeps['usda'];
    /** Logical `fetchBatch` calls, however many physical attempts each cost. */
    readonly logicalCalls: number;
}

interface PacedVendorOptions {
    readonly records: ReadonlyMap<number, UsdaFoodDetail>;
    /** When true the client answers from its own cache and reaches no transport. */
    readonly servedFromCache?: boolean;
}

const pacedVendor = (options: PacedVendorOptions): PacedVendor => {
    const state = { logicalCalls: 0 };

    // `fetchFromUsda`'s shape in miniature: retry a documented status verbatim
    // up to the manifest's ceiling, then give up as the vendor boundary's own
    // error. Reproducing the shape is what makes one logical call cost more
    // than one physical attempt; the rules it imitates are asserted elsewhere.
    const reachVendor = async (fdcIds: readonly number[]): Promise<void> => {
        const url = `https://${USDA_HOST}/fdc/v1/foods`;

        for (let attempt = 1; attempt <= usdaRetryPolicy.maxPhysicalAttemptsPerRequest; attempt += 1) {
            const response = await globalThis.fetch(url);
            if (response.ok) {
                return;
            }
            if (
                attempt === usdaRetryPolicy.maxPhysicalAttemptsPerRequest ||
                !usdaRetryPolicy.retriedStatuses.includes(response.status)
            ) {
                throw vendorError(`USDA returned ${response.status} for ${fdcIds.length} ids`);
            }
        }
    };

    return {
        get logicalCalls(): number {
            return state.logicalCalls;
        },
        usda: {
            listFoods: async (): Promise<UsdaFoodSummary[]> => [],
            fetchBatch: async (fdcIds): Promise<ImportBatchFetch> => {
                state.logicalCalls += 1;
                if (options.servedFromCache !== true) {
                    await reachVendor(fdcIds);
                }

                return batchFetch(
                    fdcIds
                        .map((fdcId) => options.records.get(fdcId))
                        .filter((record): record is UsdaFoodDetail => record !== undefined),
                    fdcIds,
                );
            },
        },
    };
};

interface PacedInstallation {
    readonly limiter: UsdaRateLimiter;
    readonly transport: PacedTransport;
    /** What `globalThis.fetch` must be again once the run has taken its gate down. */
    readonly underlying: typeof globalThis.fetch;
    readonly installRateLimiter: () => () => void;
}

/**
 * The shipped configuration over a transport this file owns: the manifest's
 * 900 requests an hour and the module's default burst, both far above the
 * handful of attempts any case here makes, so nothing below pauses. Time is
 * injected all the same, so a case that did pause would not wait for it.
 */
const pacedInstallation = (answers: readonly number[], fallbackStatus?: number): PacedInstallation => {
    const transport = pacedTransport(answers, fallbackStatus);
    globalThis.fetch = transport.fetch;

    const clock = createClock();
    const limiter = createUsdaRateLimiter({
        requestsPerHour: manifest.importLimits.configuredRequestsPerHour,
        burstCapacity: DEFAULT_BURST_CAPACITY,
        now: clock.read,
        sleep: clock.sleep,
        ledger: createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE }),
    });

    return {
        limiter,
        transport,
        underlying: transport.fetch,
        installRateLimiter: (): (() => void) => limiter.install(),
    };
};

const reportedUsdaRequests = (report: unknown): Record<string, unknown> =>
    (report as { usdaRequests: Record<string, unknown> }).usdaRequests;

describe('the pacing a run installs at the transport', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(async () => {
        await truncateFeatureTables();
    });

    // Unconditional, and not tidiness. An installed limiter is a replaced
    // `globalThis.fetch`, and Jest runs every suite in this file in one
    // process: a gate left standing would pace — and once its bucket emptied,
    // stall for an hour of injected time it no longer controls — the fetch of
    // every later suite, none of which asked to be paced.
    afterEach(() => {
        globalThis.fetch = originalFetch;
    });

    it('takes the physical-attempt policy from the manifest that documents it', () => {
        // The premise the arithmetic below rests on, read rather than restated:
        // a retryable answer is retried verbatim, so the token cost of one
        // logical call is not one, and the limiter is declared to count the
        // attempts rather than the calls.
        expect(usdaRetryPolicy.limiterCountsPhysicalAttempts).toBe(true);
        expect(usdaRetryPolicy.maxPhysicalAttemptsPerRequest).toBeGreaterThan(1);
        expect(usdaRetryPolicy.retriedStatuses.length).toBeGreaterThanOrEqual(
            usdaRetryPolicy.maxPhysicalAttemptsPerRequest,
        );
    });

    it('spends one token per physical attempt, not one per logical call', async () => {
        const entry = IMPORT_SUBJECTS[0];
        // One unusable answer short of the ceiling, drawn from the statuses the
        // manifest documents, so the attempt that finally succeeds is the last
        // one the policy allows: the most expensive logical call there is.
        const answers = usdaRetryPolicy.retriedStatuses.slice(
            0,
            usdaRetryPolicy.maxPhysicalAttemptsPerRequest - 1,
        );
        const paced = pacedInstallation(answers);
        const vendor = pacedVendor({ records: new Map([[entry.fdcId, cleanDetail(entry)]]) });
        const harness = importHarness({
            entries: [entry],
            vendor,
            installRateLimiter: paced.installRateLimiter,
            rateLimiterStats: () => paced.limiter.stats(),
        });

        const outcome = await runImport(harness.deps);
        const expected = usdaRetryPolicy.maxPhysicalAttemptsPerRequest;

        // The premise: one logical batch call that cost four physical fetches,
        // because the transport answered unusably three times first.
        expect(vendor.logicalCalls).toBe(1);
        expect(paced.transport.urls).toHaveLength(expected);

        const stats = paced.limiter.stats();
        expect(stats.attempts).toBe(expected);
        expect(stats.attempts).not.toBe(vendor.logicalCalls);
        expect(stats.attemptsInWindow).toBe(expected);
        expect(stats.pauses).toBe(0);
        expect(stats.totalPausedMs).toBe(0);

        // A retried answer is a successful call that cost more than one token,
        // never a failed import.
        expect(outcome.counts.inserted).toBe(1);
        const row = await storedFood(`usda:${entry.fdcId}`);
        expect(row.publication_status).toBe('candidate');

        // The counters the report carries come from the limiter this run
        // installed, which is what makes the reported figure the one the key's
        // hour was really charged.
        const block = reportedUsdaRequests(harness.reports[0]);
        expect(block.attempts).toBe(expected);
        expect(block.unmeasured).toBe(false);

        expect(globalThis.fetch).toBe(paced.underlying);
    });

    it('spends nothing on a logical call it answers without reaching the vendor', async () => {
        const entry = IMPORT_SUBJECTS[0];
        const paced = pacedInstallation([]);
        const vendor = pacedVendor({
            records: new Map([[entry.fdcId, cleanDetail(entry)]]),
            servedFromCache: true,
        });
        const harness = importHarness({
            entries: [entry],
            vendor,
            installRateLimiter: paced.installRateLimiter,
            rateLimiterStats: () => paced.limiter.stats(),
        });

        const outcome = await runImport(harness.deps);

        // The logical call was made and the record landed, so the allowance was
        // not saved by the stage simply doing less.
        expect(vendor.logicalCalls).toBe(1);
        expect(outcome.counts.inserted).toBe(1);

        // A gate around the accessor would have charged the key's hour for a
        // call that never left the process — and on a cache-warm rerun of the
        // whole curation, for the entire hour.
        expect(paced.transport.urls).toHaveLength(0);

        const stats = paced.limiter.stats();
        expect(stats.attempts).toBe(0);
        expect(stats.attemptsInWindow).toBe(0);
        expect(stats.firstAttemptAt).toBeNull();
        expect(stats.lastAttemptAt).toBeNull();

        // Reported as a measured zero, which here is a fact rather than an
        // absence: the limiter was installed for the whole run and saw nothing.
        const block = reportedUsdaRequests(harness.reports[0]);
        expect(block.unmeasured).toBe(false);
        expect(block.attempts).toBe(0);
    });

    it('takes its gate back down when the run fails', async () => {
        const entry = IMPORT_SUBJECTS[0];
        // Unusable on every attempt, so the ladder exhausts the ceiling and the
        // vendor boundary gives up rather than the queue quietly running out.
        const paced = pacedInstallation([], 503);
        const vendor = pacedVendor({ records: new Map([[entry.fdcId, cleanDetail(entry)]]) });
        const harness = importHarness({
            entries: [entry],
            vendor,
            installRateLimiter: paced.installRateLimiter,
        });

        // That a vendor failure arrives as this stage's own error, naming the
        // batch it stopped on, is asserted where the batch path is. Here it is
        // only the precondition that the run really did fail.
        await expect(runImport(harness.deps)).rejects.toBeInstanceOf(CatalogImportError);

        // The point of the case: `restoreFetch()` sits in a `finally`, so a run
        // that throws leaves no paced fetch behind for whatever runs next in
        // the same process — the importer's own `main()` included.
        expect(globalThis.fetch).toBe(paced.underlying);

        // Allowance spent is allowance spent. The attempts USDA answered
        // unusably still came off the key's hour, and a ledger that forgot them
        // would let the next run overspend the ceiling by exactly what the
        // failed one had already used.
        expect(vendor.logicalCalls).toBe(1);
        expect(paced.transport.urls).toHaveLength(usdaRetryPolicy.maxPhysicalAttemptsPerRequest);
        expect(paced.limiter.stats().attempts).toBe(usdaRetryPolicy.maxPhysicalAttemptsPerRequest);

        const run = await importRunRow();
        expect(run?.status).toBe('failed');
    });
});

// ---------------------------------------------------------------------------
// WHAT A FAILING RUN RECORDS, AND WHAT IT IS ALLOWED TO SAY.
//
// The redaction functions are proven above, exhaustively and without a
// database, and so is the code every error class is reported under. Neither of
// those proves the one thing an operator depends on: that a run which really
// failed puts its reason somewhere durable, and that nothing it prints or
// stores carries the credential the failure was quoting. Every case above runs
// on `silentLogger` or on a recorder that captures field OBJECTS before they
// are serialised, so a stage that logged `error` instead of `safeError(error)`
// — or put the request URL in a field of its own — would pass all of them.
//
// This is the seam where the three writers meet: the thrown value a caller
// pattern-matches, the JSON line a terminal and CI keep, and the entry
// `finishRun` stores in `catalog_import_runs.log` for a reader who was not
// there. They have to agree, and none of them may leak.
// ---------------------------------------------------------------------------

/**
 * A fictional vendor key and the request URL that would carry it.
 *
 * The value matches no real provider's format on purpose; the SHAPE is what
 * matters. `usda.service.ts` puts `api_key` in the query string of every
 * request it builds, so a value thrown from that boundary can quote the
 * credential verbatim — and this stage's output is read in a terminal, retained
 * by CI and stored in a JSONB column that gets copied into committed reports.
 */
const FAKE_VENDOR_KEY = 'zzNOTAREALKEYzzNOTAREALKEYzz0001';
const VENDOR_REQUEST_URL = `https://${USDA_HOST}/fdc/v1/foods?api_key=${FAKE_VENDOR_KEY}&format=full`;

interface CapturedLines {
    readonly raw: string[];
    readonly parsed: Record<string, unknown>[];
    readonly logger: ScriptLogger;
}

/** The real `createLogger`, writing to this file instead of to a terminal. */
const capturingLogger = (): CapturedLines => {
    const raw: string[] = [];
    const parsed: Record<string, unknown>[] = [];

    const logger = createLogger('catalog-import', {
        write: (line: string): void => {
            raw.push(line);
            parsed.push(JSON.parse(line) as Record<string, unknown>);
        },
        now: (): Date => IMPORT_AT,
    });

    return { raw, parsed, logger };
};

const emittedLine = (captured: CapturedLines, event: string): Record<string, unknown> => {
    const found = captured.parsed.filter((line) => line.event === event);
    expect(found).toHaveLength(1);

    return found[0];
};

interface StoredRunLogEntry {
    readonly at?: unknown;
    readonly event?: unknown;
    readonly error?: Record<string, unknown>;
}

const failedRunRecord = async (): Promise<{
    status: string;
    counts: Record<string, number>;
    log: StoredRunLogEntry[];
    rawLog: string;
}> => {
    const row = await prisma.catalog_import_runs.findFirst({
        where: { kind: 'usda_import', manifest_version: IMPORT_RUN_SCOPE },
        select: { status: true, counts: true, log: true },
    });
    expect(row).not.toBeNull();
    const found = row as unknown as { status: string; counts: unknown; log: unknown };

    return {
        status: found.status,
        counts: (found.counts ?? {}) as Record<string, number>,
        log: Array.isArray(found.log) ? (found.log as StoredRunLogEntry[]) : [],
        rawLog: JSON.stringify(found.log ?? null),
    };
};

describe('what a failing run records and emits', () => {
    beforeEach(async () => {
        await truncateFeatureTables();
    });

    it('leaves a durable failure record, in the same words it printed', async () => {
        const entry = IMPORT_SUBJECTS[0];
        const captured = capturingLogger();
        const vendor = recordingVendor({
            records: recordsFor([entry]),
            failOnCall: 1,
            failWith: () => vendorError(`USDA returned 503 for ${VENDOR_REQUEST_URL}`),
        });
        const harness = importHarness({ entries: [entry], vendor, logger: captured.logger });

        const failure = await runImport(harness.deps).then(
            () => null,
            (error: unknown) => error,
        );

        // Class and typed field, never message text — and the vendor's own
        // class reaches no caller (§9).
        expect(failure).toBeInstanceOf(CatalogImportError);
        expect((failure as CatalogImportError).code).toBe('usda_request_failed');
        expect((failure as Error).name).not.toBe('UsdaError');

        // THE DURABLE HALF. `finishRun` writes the reason in the same statement
        // as the status, so a crashed attempt is distinguishable from one still
        // in flight by a reader who was not at the terminal — which is exactly
        // what `catalog:validate`'s prerequisite read has to decide.
        const run = await failedRunRecord();
        expect(run.status).toBe('failed');

        const stored = run.log.filter((line) => line.event === 'run_failed');
        expect(stored).toHaveLength(1);
        // Members, not order. `sanitizeRunLogEntry` writes `at` and `event`
        // first and says so, but the entry lands in a JSONB column and
        // PostgreSQL keeps JSONB keys sorted by length then bytes, so a
        // writer's ordering does not survive the round trip and asserting it
        // here would pin a contract the database does not offer. The PRINTED
        // line is a string and does keep its order; that is asserted below.
        expect(Object.keys(stored[0]).sort()).toEqual(['at', 'error', 'event']);
        expect(typeof stored[0].at).toBe('string');
        // A CLOSED set of machine-readable members, which is what "never the
        // raw error object" (§8) amounts to on the wire: a raw `Error`
        // serialises to `{}`, a renderer keeping the stack would serialise it,
        // and a renderer keeping the MESSAGE would put the vendor's sentence —
        // here one quoting the request URL — into a JSONB column that outlives
        // the run. The class and its code are what a later reader acts on.
        expect(Object.keys(stored[0].error ?? {}).sort()).toEqual(['code', 'name']);
        expect(stored[0].error).not.toHaveProperty('message');

        // The partial work survives the closure. A run closed `failed` with an
        // empty `counts` would say a run that planned work planned none.
        expect(run.counts.planned).toBe(1);
        expect(run.counts.inserted).toBe(0);

        // THE PRINTED HALF, through the real logger: JSON Lines, and the four
        // envelope members leading every line. A reader — or a CI log parser —
        // gets the same four fields from every line this stage ever writes.
        expect(captured.raw).not.toHaveLength(0);
        for (const line of captured.parsed) {
            expect(Object.keys(line).slice(0, 4)).toEqual(['ts', 'level', 'scope', 'event']);
            expect(line.scope).toBe('catalog-import');
            expect(line.ts).toBe(IMPORT_AT.toISOString());
        }

        const printed = emittedLine(captured, 'run_failed');
        expect(printed.level).toBe('error');
        expect(printed.code).toBe('usda_request_failed');
        expect(Object.keys(printed.error as Record<string, unknown>).sort()).toEqual(['code', 'name']);
        expect(printed.error).not.toHaveProperty('message');

        // The two writers have to agree: an operator reading the terminal and
        // one reading the row months later must be reading the same failure,
        // not two renderings that diverged. Compared as the whole rendered
        // value rather than one field of it, so a member added to one writer
        // and not the other fails here.
        expect(printed.error).toEqual(stored[0].error);

        for (const line of captured.raw) {
            expect(line).not.toContain(FAKE_VENDOR_KEY);
        }
        expect(run.rawLog).not.toContain(FAKE_VENDOR_KEY);

        // WHAT MUST STILL APPEAR, and where it now appears. "Which service
        // refused" and "which work item stopped" are the two things an operator
        // needs, and both survive — as TYPED FIELDS on the printed line rather
        // than inside a rendered sentence. `usda_request_failed` names the
        // service, and `batchIndex` is what `--resume` continues from.
        expect(printed.code).toBe('usda_request_failed');
        expect(printed.batchIndex).toBe(0);
        expect(printed.fdcIds).toEqual([entry.fdcId]);

        // THE ONE FACT THAT DOES NOT SURVIVE, asserted so the gap is visible
        // rather than assumed. `importErrorFields` reports `vendorStatus`
        // whenever the wrapped vendor error carries a typed status, and
        // `src/services/usda.service.ts`'s `UsdaError` carries none — it holds
        // the HTTP status only inside its message, which is the field withheld
        // here. Giving that class a typed `status` belongs to the vendor
        // boundary, not to this stage; the moment it has one, this expectation
        // is what fails and tells the next reader the field now flows.
        expect(printed).not.toHaveProperty('vendorStatus');

        // AND THE REQUEST URL IS NOWHERE, which is the point of moving them
        // there. The message that used to carry this failure quoted the URL
        // `usda.service.ts` builds, and that URL's query string carries
        // `api_key=`; the scrub rules reduced the credential but left the rest
        // legible, so the channel existed. It no longer does: no line and no
        // stored entry mentions the host, the query parameter or the key.
        const everything = `${captured.raw.join('\n')}\n${run.rawLog}`;
        expect(everything).not.toContain(hostOf(VENDOR_REQUEST_URL));
        expect(everything).not.toContain('api_key=');
        expect(everything).not.toContain(FAKE_VENDOR_KEY);
    });
});

// ---------------------------------------------------------------------------
// This section's own guard, declared last so it runs last.
//
// `globalThis.fetch` is process-wide and the cases above replace it twice over
// — once with a transport of their own, once more when the stage installs its
// limiter over it. Jest runs every suite in this file in one process, so a
// single unrestored installation would silently pace, and then stall, whatever
// ran next. Each case restores, but "each case restores" is a claim, and this
// is the one place it can be checked rather than asserted in a comment.
// ---------------------------------------------------------------------------
/**
 * THE ROW THE RULE LANDS ON (VALREP-rejected-outcome-mismatch).
 *
 * The precedence itself is pinned above with no database. This is the same
 * decision seen where it actually matters — in `catalog_validation_records`,
 * written through `persistPreparedFood` against PostgreSQL — because the
 * committed evidence artefact is built from that column, and 33 of its
 * withheld-rejected identities carried a `quarantined` outcome beside a
 * `rejected` status and reject-tier evidence.
 *
 * Last in the file, and with its own truncation, so the write cannot disturb a
 * section that measures row counts.
 */
describe('the persisted validation record states the outcome its status implies', () => {
    const entry = IMPORT_SUBJECTS[0];
    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };
    const persistedAt = new Date('2026-09-14T08:30:00.000Z');

    beforeEach(truncateFeatureTables);

    /** The curated record, optionally over the reject-tier energy ceiling. */
    const record = (calories: number): PreparedCatalogFood => {
        const prepared = prepareCatalogFood(
            cleanDetail(entry),
            { kind: 'curated', entry },
            manifest,
            persistedAt,
            retrieval([entry.fdcId]),
        );

        return {
            ...prepared,
            // What an unclassified swept record carries, and the floor that
            // used to decide the outcome on its own.
            curatorReviewRequired: true,
            candidate: { ...prepared.candidate, calories },
        };
    };

    const persist = async (one: PreparedCatalogFood): Promise<{ outcome: string; status: string }> => {
        const verdict = validateCatalogCandidate(one.candidate, policy);
        await persistPreparedFood(
            prisma as unknown as ImportDb,
            one,
            verdict,
            importPublicationStatus(one, verdict),
            persistedAt,
        );

        const food = await prisma.catalog_foods.findUnique({
            where: { source_key: one.sourceKey },
            select: { id: true, publication_status: true },
        });
        expect(food).not.toBeNull();
        const stored = await prisma.catalog_validation_records.findUnique({
            where: { catalog_food_id: (food as { id: string }).id },
            select: { outcome: true, publication_status: true },
        });

        return {
            outcome: String((stored as { outcome: string }).outcome),
            status: String((food as { publication_status: string }).publication_status),
        };
    };

    it('writes rejected on a row a reject-tier check disqualified, floor or no floor', async () => {
        // 5,000 kcal/100 g is over the reject ceiling, so the row is stored
        // `rejected` — and `catalog-validate` never revisits a rejected row,
        // which is why a wrong outcome here would be permanent.
        expect(await persist(record(5000))).toEqual({ outcome: 'rejected', status: 'rejected' });
    });

    it('writes quarantined on a row only the floor held, which is unchanged', async () => {
        expect(await persist(record(CLEAN_CALORIES))).toEqual({ outcome: 'quarantined', status: 'candidate' });
    });
});

describe('this section leaves the process as it found it', () => {
    // Captured while Jest is still collecting, so it is the reference the
    // process started with rather than whatever some case left installed. The
    // check is IDENTITY, not callability: a paced wrapper is callable too, and
    // on Node 22 `globalThis.fetch` is itself a JavaScript function over
    // undici rather than native code, so there is no shape to recognise — only
    // the original object.
    const pristineFetch = globalThis.fetch;

    it('hands back the transport every other suite shares', () => {
        expect(globalThis.fetch).toBe(pristineFetch);
    });
});

