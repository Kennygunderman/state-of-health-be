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

import { loadCoveragePlan, loadUsdaManifest } from '../../../scripts/lib/manifest';
import type { UsdaManifest, UsdaManifestFood } from '../../../scripts/lib/manifest';
import type { UsdaFoodDetail, UsdaFoodPortion, UsdaFoodSummary } from '../../services/usda.service';
import {
    buildImportPlan,
    describeFailure,
    importRunScope,
    matchSelectorPortion,
    parsePortionLabel,
    prepareCatalogFood,
    runImport,
} from '../../../scripts/catalog-import-usda';
import type {
    ImportAssignment,
    ImportOptions,
    RunImportDeps,
    UsdaBatchRetrieval,
} from '../../../scripts/catalog-import-usda';
// One statement for the logger module, covering both of its roles in this file:
// the `ScriptLogger` the import stage is handed, and the functions whose
// redaction contract is what makes handing it anything safe.
import {
    createLogger,
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
    waitMsForToken,
    windowWaitMs,
    type UsdaRateLedger,
    type UsdaRateLimiter,
    type UsdaRateReservation,
} from '../../../scripts/lib/rateLimiter';
// The version decision and the persistence it feeds (DB-F08), plus the batch
// accounting (DB-F11). `nextCatalogFoodVersions` is pure, so most of that
// contract is proven with no database at all; `persistPreparedFood` is where it
// meets the write, and a fake `ImportDb` is how the write is observed.
import { importPublicationStatus, nextCatalogFoodVersions, persistPreparedFood } from '../../../scripts/catalog-import-usda';
import type { ImportDb, PreparedCatalogFood, StoredVersionedFacts } from '../../../scripts/catalog-import-usda';
// The stage lock (DB-F09) and the run identity a validation pass claims
// (DB-F10) both live with run state, which is what they are about.
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
    openRun,
    validationRunKeyInputPart,
    withCatalogStageLock,
} from '../../../scripts/lib/checkpoint';
import type { CatalogInputRunRow, CatalogStageLockConnection } from '../../../scripts/lib/checkpoint';
// Validation's run identity and completed-run no-op (DB-F10) and its per-food
// lock/re-read/CAS (DB-F09). Importing this module runs nothing: like the import
// script it guards `main()` behind `require.main === module`.
import {
    appendValidationHistory,
    historyEntryBelongsToRun,
    identityGroupMoved,
    runHasJudgedFood,
    runValidation,
    settleUnresumableValidationRuns,
    validationRunScope,
} from '../../../scripts/catalog-validate';
import type { RunValidationDeps, ValidateDb, ValidateOptions, ValidationFoodRow } from '../../../scripts/catalog-validate';
// The release's refusal rule (DB-F09, NEW-01), which is pure over the run
// ledger, and the read that decides which rows it gets to see.
import { ReleaseIntegrityError, loadPipelineRuns, releaseStalenessReason, runRelease } from '../../../scripts/catalog-release';
import type { ReleaseDb, ReleaseRunRow, RunReleaseDeps } from '../../../scripts/catalog-release';
import { validateCatalogCandidate } from '../../services/catalog.logic';
import type { CatalogValidationPolicy } from '../../services/catalog.logic';
import { prisma } from '../../prisma/client';

const manifest: UsdaManifest = loadUsdaManifest();
const coveragePlan = loadCoveragePlan();

const silentLogger: ScriptLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
};

const options = (overrides: Partial<ImportOptions> = {}): ImportOptions => ({
    help: false,
    categories: [],
    limit: null,
    resume: false,
    dryRun: false,
    ...overrides,
});

const retrieval = (fdcIds: readonly number[]): UsdaBatchRetrieval => ({
    requestedFdcIds: [...fdcIds],
    cacheKey: `POST /foods?#{"fdcIds":[${fdcIds.join(',')}],"format":"full"}`,
    responseSha256: 'a'.repeat(64),
    source: 'usda_api_cache',
    cachedAt: new Date('2026-09-13T09:11:40.243Z'),
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

const curatedEntries = manifest.foods.filter(
    (entry): entry is UsdaManifestFood & { fdcId: number } => entry.fdcId !== undefined,
);

const entryCarrying = (allergen: string): (UsdaManifestFood & { fdcId: number }) | undefined =>
    curatedEntries.find(
        (entry) => entry.reviewedSafety?.allergenStatus === 'known' && entry.reviewedSafety.allergenTags.includes(allergen),
    ) ?? curatedEntries.find((entry) => entry.reviewedSafety?.allergenTags.includes(allergen));

describe('reviewed allergen and diet metadata (N01)', () => {
    it('gives every curated manifest entry a reviewed safety determination', () => {
        const missing = curatedEntries.filter((entry) => entry.reviewedSafety === undefined);
        expect(missing.map((entry) => entry.canonicalName)).toEqual([]);
    });

    it('states the curated-safety contract in the manifest itself', () => {
        expect(typeof manifest.curatedSafetyContract).toBe('string');
        expect((manifest.curatedSafetyContract ?? '').length).toBeGreaterThan(0);
    });

    // One case per allergen class the product asks about, so a change that
    // erases any single class fails on that class by name rather than on a
    // count that could be met by the other eight.
    const classes = manifest.sweepAllergenDietRules.allergenVocabulary;
    it.each(classes)('carries the reviewed %s determination onto the row', (allergen) => {
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

describe('nutrition method agrees with the assumptions (w043-F06)', () => {
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

describe('identity evidence records the retrieval that happened (w043-F06)', () => {
    const base = curatedEntries[0] as UsdaManifestFood;

    const prepared = (source: UsdaBatchRetrieval['source'], cachedAt: Date | null, digest: string | null) =>
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

    it('reports the cache row\'s own retrieval time, and no HTTP status, when served from cache', () => {
        const one = prepared('usda_api_cache', new Date('2026-09-13T09:11:40.243Z'), 'b'.repeat(64));
        expect(one.evidence.fetched_at).toBe('2026-09-13T09:11:40.243Z');
        expect(one.evidence.fetched_at_source).toContain('usda_api_cache.fetched_at');
        expect(one.evidence.http_status).toBeNull();
        expect(one.evidence.body_sha256).toBe('b'.repeat(64));
        expect(one.row.source_cache_key).toBe(one.evidence.source_cache_key);
    });

    it('falls back to its own clock, and says so, when nothing was recorded to read', () => {
        const one = prepared('import_run', null, null);
        expect(one.evidence.fetched_at).toBe('2026-09-13T11:00:00.000Z');
        expect(one.evidence.fetched_at_source).toContain('import run clock');
        expect(one.evidence.http_status).toBe(200);
        expect(one.evidence.body_sha256).toBeNull();
        expect(one.evidence.body_sha256_subject).toContain('nothing to digest');
    });

    it('digests the food\'s own record separately and names both digests', () => {
        const one = prepared('usda_api_cache', new Date('2026-09-13T09:11:40.243Z'), 'b'.repeat(64));
        expect(one.evidence.record_sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(one.evidence.record_sha256).not.toBe(one.evidence.body_sha256);
        expect(one.evidence.record_sha256_subject).toContain("this food's own record");
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
                getFoodsBatch: async () => {
                    throw new Error('a dry run fetched vendor records');
                },
                describeBatchRetrieval: async () => {
                    throw new Error('a dry run described a retrieval that never happened');
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
        const plan = await buildImportPlan(manifest, listFoods, options({ limit: curatedCount + 5 }), silentLogger);

        expect(plan.assignments.size).toBe(curatedCount + 5);
        const batched = plan.batches.reduce((total, batch) => total + batch.fdcIds.length, 0);
        // The planned count and the number of records actually batched for
        // fetching are the same number, which is what "one budget" means.
        expect(batched).toBe(plan.assignments.size);
    });

    it('spends the whole budget on curated entries when it is smaller than that set', async () => {
        const listFoods = async (): Promise<UsdaFoodSummary[]> => sweptRows(40);
        const plan = await buildImportPlan(manifest, listFoods, options({ limit: 5 }), silentLogger);

        expect(plan.assignments.size).toBe(5);
        expect([...plan.assignments.values()].every((assignment) => assignment.kind === 'curated')).toBe(true);
    });

    it('plans every record when no limit is given', async () => {
        const listFoods = async (_dataType: string, _pageSize: number, page: number): Promise<UsdaFoodSummary[]> =>
            page === 1 ? sweptRows(40) : [];
        const plan = await buildImportPlan(manifest, listFoods, options(), silentLogger);

        expect(plan.assignments.size).toBeGreaterThan(curatedEntries.length);
        const batched = plan.batches.reduce((total, batch) => total + batch.fdcIds.length, 0);
        expect(batched).toBe(plan.assignments.size);
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
        expect(described.error).toEqual({ name: 'UsdaError', message: 'USDA returned 403' });
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
        // The rule this file replaced was a regex, and a regex form of it either
        // rescans from every offset (measured in the module's own comments at
        // 19,758 ms for an unbounded scheme body on this length) or pays ~60 ms for
        // one global pass. The scan measures single-digit milliseconds on all three
        // inputs below. The assertion is deliberately two orders of magnitude
        // looser than the measurement so a loaded CI runner cannot make it flap
        // while a return to a rescanning form — seconds, not milliseconds — still
        // fails it.
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

        it('scrubs a DSN quoted by an error message', () => {
            const rendered = safeError(new Error(`connect failed for ${DSN_WITH_AT_IN_PASSWORD}`));

            expect(rendered).toEqual({ name: 'Error', message: `connect failed for ${DSN_REDACTED}` });
            // The rendered VALUES, not a serialization of them: the field name
            // `message` itself contains the two-character fragment `ss`.
            expectNoCredentialFragment(`${rendered.name} ${rendered.message}`);
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
                expect(
                    getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: `${USDA_VENDOR_CAP_PER_HOUR}` }),
                ).toBe(USDA_VENDOR_CAP_PER_HOUR);

                for (const raw of ['0', '-1', '1001', '1e3', '0x10', '+7', '8.', '\u00a0900', 'many']) {
                    expect(() => getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: raw })).toThrow(
                        RateLimitConfigError,
                    );
                }
            });

            it('still refuses a configuration it cannot honour', () => {
                const ledger = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });

                expect(() => createUsdaRateLimiter({ requestsPerHour: 0, ledger })).toThrow(RateLimitConfigError);
                expect(() => createUsdaRateLimiter({ requestsPerHour: 1.5, ledger })).toThrow(RateLimitConfigError);
                expect(() => createUsdaRateLimiter({ requestsPerHour: USDA_VENDOR_CAP_PER_HOUR + 1, ledger })).toThrow(
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
 * THE TWO VERSION COUNTERS ON A CATALOG FOOD (DB-F08).
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

describe('nextCatalogFoodVersions (DB-F08)', () => {
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

describe('persistPreparedFood writes the counters the comparison decided (DB-F08)', () => {
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
 * THE DURABLE BATCH TOTAL (DB-F11).
 *
 * `batchesProcessed` lives in `catalog_import_runs.counts`, which
 * `checkpoint.ts::recordCounts` merges by ADDITION. The checkpoint used to add
 * the save interval — five — whatever the interval had actually covered, so a
 * seven-batch run recorded ten and a resumed tail recorded its predecessor's
 * batches a second time. The overcount is durable: it is what the run row says
 * that run did, for the rest of the row's life.
 *
 * These cases go through the REAL run ledger, because the defect is in what the
 * row ends up holding and the merge that puts it there is the wiring under test
 * (this suite's charter names run bookkeeping as database-backed work). The
 * catalog writes are faked: an empty vendor response leaves the persistence path
 * with nothing to write, which keeps the cases about batch accounting alone.
 */
describe('the durable batch total a checkpoint records (DB-F11)', () => {
    const FIXED_NOW = new Date('2026-09-14T09:00:00.000Z');

    /** Twenty ids per batch, so a limit is a batch count: 140 → 7, 100 → 5. */
    const BATCH_SIZE = 20;

    const scopeFor = (limit: number): string => importRunScope(manifest.usdaManifestVersion, options({ limit }));

    /**
     * A catalog client that can open the per-batch transaction and nothing else.
     *
     * The import opens one transaction per batch whether or not the vendor
     * returned anything, so `$transaction` has to work; every model accessor
     * fails by name, which is the assertion that no food, alias, portion or
     * validation record was written while these batches were being accounted.
     */
    const transactionOnlyDb = (): ImportDb => {
        const db = new Proxy(
            {},
            {
                get: (_target, property) => {
                    if (property === '$transaction') {
                        return async (work: (tx: ImportDb) => Promise<unknown>) => work(db);
                    }
                    throw new Error(`a batch-accounting case reached catalog state: db.${String(property)}`);
                },
            },
        ) as unknown as ImportDb;

        return db;
    };

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
                getFoodsBatch: async (fdcIds) => {
                    calls.push(fdcIds.length);
                    if (failOnCall !== null && calls.length === failOnCall) {
                        throw new Error('vendor outage mid-run');
                    }
                    return [];
                },
                describeBatchRetrieval: async (fdcIds) => retrieval(fdcIds),
            },
        };
    };

    const runWith = async (
        limit: number,
        vendor: { usda: RunImportDeps['usda'] },
        db: ImportDb = transactionOnlyDb(),
    ): Promise<ReturnType<typeof runImport>> => {
        const deps = {
            db,
            runDb: prisma,
            usda: vendor.usda,
            manifest,
            coveragePlan,
            options: options({ limit }),
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
    const claimedScopes = [scopeFor(140), scopeFor(100)];

    const clearClaimedRuns = async (): Promise<void> => {
        await prisma.catalog_import_runs.deleteMany({
            where: { kind: 'usda_import', manifest_version: { in: claimedScopes } },
        });
    };

    beforeEach(clearClaimedRuns);
    afterEach(clearClaimedRuns);

    const durableBatchesProcessed = async (runId: string): Promise<number | undefined> => {
        const row = await prisma.catalog_import_runs.findUnique({
            where: { id: runId },
            select: { counts: true },
        });
        return (row?.counts as { batchesProcessed?: number } | null)?.batchesProcessed;
    };

    it('records what the final partial checkpoint actually covered, not the save interval', async () => {
        // Seven batches: checkpoints at 5 (covering 5) and at 7 (covering 2).
        const vendor = emptyVendor();
        const outcome = await runWith(140, vendor);

        expect(outcome.plannedBatches).toBe(140 / BATCH_SIZE);
        expect(outcome.processedBatches).toBe(140 / BATCH_SIZE);
        expect(vendor.calls).toHaveLength(140 / BATCH_SIZE);
        // Ten was the overcount: 5 + 5, where the tail covered two.
        expect(await durableBatchesProcessed(outcome.runId as string)).toBe(140 / BATCH_SIZE);
    });

    it('records only this invocation’s batches when a resumed run finishes the tail', async () => {
        const interrupted = emptyVendor(6);
        await expect(runWith(140, interrupted)).rejects.toThrow('vendor outage mid-run');

        const openRunRow = await prisma.catalog_import_runs.findFirst({
            where: { kind: 'usda_import', manifest_version: scopeFor(140) },
        });
        expect(openRunRow?.status).toBe('running');
        expect(openRunRow?.cursor).toMatchObject({ nextBatchIndex: 5 });
        expect(await durableBatchesProcessed(openRunRow?.id as string)).toBe(5);

        // The tail: two batches, on the same run row.
        const resumed = emptyVendor();
        const outcome = await runWith(140, resumed);

        expect(outcome.runId).toBe(openRunRow?.id);
        expect(outcome.resumed).toBe(true);
        expect(outcome.processedBatches).toBe(2);
        expect(resumed.calls).toHaveLength(2);
        // Seven, not twelve: the resumed invocation starts its accounting at the
        // index it resumed from, so it cannot record the five its predecessor
        // already recorded.
        expect(await durableBatchesProcessed(outcome.runId as string)).toBe(7);
    });

    it('records the interval itself when the batch count is an exact multiple of it', async () => {
        const vendor = emptyVendor();
        const outcome = await runWith(100, vendor);

        expect(outcome.plannedBatches).toBe(100 / BATCH_SIZE);
        expect(await durableBatchesProcessed(outcome.runId as string)).toBe(100 / BATCH_SIZE);
    });
});


/**
 * VALIDATION'S RUN IDENTITY AND THE FACTS IT JUDGES FROM (DB-F10, DB-F09).
 *
 * Two defects met in one function. DB-F10: the claim's `alreadyCompleted` was
 * discarded, so re-running a succeeded pass rewrote every considered food's
 * `updated_at`, every record's `reviewed_at` and `history` and the report,
 * beneath a closed run whose counts never moved — and a `--category` pass shared
 * the canonical run key, so a partial pass could close it. DB-F09: the verdict
 * was computed from a set-wide read and written by id, so a concurrent import
 * could replace the nutrients and metadata in between and the row was
 * republished on checks derived from facts it no longer had.
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
    ...overrides,
});

/**
 * WHICH CATALOG A VALIDATION RUN ANSWERS FOR (DB-F10).
 *
 * The run key names two things and has to name both. Keyed on the coverage plan
 * alone, one successful pass answers "validation succeeded for v1" for ever, so
 * a later import under the same plan is met with the completed-run no-op and its
 * rows are never judged — which contradicts AAP §0.5.1 ("a refresh re-runs
 * validation") and, worse, deadlocks the release: catalog-release asks for a
 * validation newer than the last ingest, and that run can no longer happen.
 */
describe('catalogInputIdentity and the canonical run key (DB-F10)', () => {
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

describe('validationRunScope (DB-F10)', () => {
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
 * ONE HISTORY ENTRY PER RUN PER FOOD (DB-F10).
 *
 * The status write and the history commit together; the cursor that says "done"
 * commits after them. Something has to be true in that window, and an
 * unconditional append would leave two entries claiming the same transition —
 * in the audit trail this stage exists to produce.
 */
describe('appendValidationHistory is idempotent per run and food (DB-F10)', () => {
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

describe('identityGroupMoved (DB-F09)', () => {
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

describe('runValidation (DB-F10, DB-F09)', () => {
    const FIXED_NOW = new Date('2026-09-14T10:15:00.000Z');
    const CATEGORY = 'protein_poultry';
    const scopedOptions = validateOptions({ categories: [CATEGORY] });
    // These cases claim a RESTRICTED key, so they can never close the canonical
    // one for this database however they end. The ledger they run against holds
    // no ingest, so the input identity they resolve is NO_CATALOG_INPUT — the
    // suite deletes its own run rows around every case (below), which keeps that
    // true whatever else has run.
    const runScope = validationRunScope(coveragePlan.coveragePlanVersion, scopedOptions, NO_CATALOG_INPUT);

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
        catalog_validation_records: {
            id: 'record-1',
            history: [],
            canonical_identity: { source_key: 'usda:900001', curator_review_required: false },
            nutrition_assumptions: null,
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
         * which is the window DB-F09 is about. Applied where the row lock is
         * taken, so it lands on exactly the food being judged and on no other.
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

        const recordHistory = (id: string, history: unknown): void => {
            const written = historyWrites.get(id) ?? [];
            const entries = Array.isArray(history) ? (history as unknown[]) : [];
            written.push(entries);
            historyWrites.set(id, written);

            // Written BACK into the row, as the database does. Without this the
            // store would forget every judgement the moment the transaction
            // returned, and a resumed pass built from it could not tell that
            // this run had already judged the food — which is the whole
            // mechanism under test.
            const row = store.get(id);
            if (row !== undefined) {
                const record = row.catalog_validation_records;
                store.set(id, {
                    ...row,
                    catalog_validation_records:
                        record === null
                            ? { id: 'record-created', history: entries, canonical_identity: {}, nutrition_assumptions: null }
                            : { ...record, history: entries },
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
                    const { data } = args as { data: { catalog_food_id: string; history: unknown } };
                    recordHistory(data.catalog_food_id, data.history);
                    return { id: 'record-created' };
                },
                update: async (args: unknown) => {
                    const { where, data } = args as {
                        where: { catalog_food_id: string };
                        data: { history: unknown };
                    };
                    recordHistory(where.catalog_food_id, data.history);
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

    describe('a succeeded run is a no-op (DB-F10)', () => {
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

    describe('an interrupted pass resumes without judging a row twice (DB-F10)', () => {
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

    describe('the verdict is computed from the facts the write locked (DB-F09)', () => {
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
     * THE WINDOW BETWEEN THE JUDGEMENT AND THE CURSOR (DB-F10).
     *
     * The status write, the validation record and the history commit in one
     * transaction; the cursor that says "this food is done" is a separate write
     * after it. These cases are the two ways a row ends up judged but not
     * pointed past — a crash in that window, and a considered list the pass's own
     * writes reshaped — and both assert the same thing: the food carries exactly
     * one history entry for the run, because the entry is keyed by run and food
     * rather than appended blindly.
     */
    describe('a row judged but not yet pointed past is not judged twice (DB-F10)', () => {
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
     * A CATALOG REFRESH IS NEW WORK (DB-F10).
     *
     * AAP §0.5.1: "a refresh re-runs validation". Keyed on the coverage plan
     * alone, the pass that judged the catalog before the refresh would answer
     * for the one after it, and catalog-release — which wants a validation newer
     * than the last ingest — would wait on a run that could never happen.
     */
    describe('a newer catalog input is judged rather than answered for (DB-F10)', () => {
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
     * A ROW THAT PASSED, AND THEN CHANGED BEFORE THE PASS CAME BACK (DB-F10).
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
    describe('a row whose facts changed after it passed (DB-F10)', () => {
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
     * THE DEADLOCK A KEY THAT NAMES ITS INPUT WOULD OTHERWISE CREATE (DB-F10).
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
    describe('a pass settles validation runs that can never be resumed (DB-F10)', () => {
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
            // to tell an abandoned pass from a settled one.
            expect(JSON.stringify(log)).toContain('ValidationRunSupersededError');
            expect(JSON.stringify(log)).toContain('can never be resumed');
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
});


/**
 * THE STAGE LOCK: WHAT ONE PROCESS MAY DO TO THE CATALOG GRAPH WHILE ANOTHER IS
 * WRITING IT (DB-F09).
 *
 * The run claim already stopped two processes from sharing one run row, and
 * `checkpoint.ts`'s own THE CLAIM said what it could not do: the claim lock is
 * transaction-scoped, so it "does NOT grant exclusive processing for the run's
 * lifetime" — and no entry point took a lock that did. Two stages could
 * therefore write the graph at once under two different run rows, which is the
 * window every other part of DB-F09 is a symptom of.
 *
 * The decisions are pure and are checked with no database at all. Exclusion
 * itself is not a decision but a PostgreSQL behaviour, so it is checked against
 * the real test database: a fake that returned `false` from `try_lock` would
 * prove only that the fake was written to.
 */
describe('the stage lock (DB-F09)', () => {
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

        it('assumes an unknown stage writes, which is the safe direction', () => {
            expect(catalogStageLockMode('a_stage_this_table_has_not_heard_of' as never)).toBe('exclusive');
        });

        it('states a mode for every stage name, so no stage can reach the graph unclaimed', () => {
            const stages: readonly string[] = ['usda_import', 'ai_generation', 'validation', 'release_load', 'release'];
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
            const rows = await prisma.$queryRaw<{ count: number }[]>`
                SELECT count(*)::int AS count
                FROM pg_locks
                WHERE locktype = 'advisory' AND classid = ${0x434154}::int4
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
 * THE EXPORT'S OWN REFUSAL (DB-F09, NEW-01).
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
 * WHICH ROWS THE REFUSAL GETS TO SEE (NEW-01).
 *
 * The rules below are pure over the rows they are handed, so a row the query
 * filters out is a rule that cannot fire. A FAILED validation attempt of the
 * current catalog is the most important row in the ledger — without it, an
 * earlier success for the same key reads as "validation passed" — so the read
 * is asserted against the real table rather than assumed.
 */
describe('loadPipelineRuns (NEW-01)', () => {
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

describe('releaseStalenessReason (DB-F09, NEW-01)', () => {
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

    describe('only the canonical validation for this catalog counts (NEW-01)', () => {
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

    describe('a later failed attempt of the canonical run is not hidden (NEW-01)', () => {
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

        it('ignores a failed attempt of a DIFFERENT run, which says nothing about this catalog', () => {
            const ledger = [ingestRow()];
            const key = expectedKeyFor(ledger);

            expect(
                decide([
                    ...ledger,
                    run({ manifest_version: key, status: 'succeeded', finished_at: at('2026-09-14T09:00:00.000Z') }),
                    run({
                        manifest_version: `${key}+scope:ffffffffffffffff`,
                        status: 'failed',
                        finished_at: at('2026-09-14T10:00:00.000Z'),
                    }),
                ]),
            ).toBeNull();
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
     * A GRAPH MUTATOR THAT FAILED AFTER THE VALIDATION (NEW-01).
     *
     * `catalogInputIdentity` counts SUCCEEDED runs only, and says why: a failed
     * ingest left a graph nobody vouched for, so naming it would mint a run key
     * for a half-written catalog. It states outright that the release
     * prerequisite refuses on such a row separately — so this is that rule, and
     * without it the delegation lands nowhere. A run that failed partway still
     * wrote back everything it reached before it died, as candidates.
     */
    describe('a graph mutator that failed after the validation still blocks the release (NEW-01)', () => {
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
            // failed validation attempt is judged by its own rule (above); read
            // as a mutator it would make every successful pass look stale.
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
 * THE PAIRING INSIDE runRelease (NEW-01).
 *
 * `releaseStalenessReason` is pure and exhaustively covered above, but it is
 * only as good as the key it is HANDED — and the defect NEW-01 named was
 * precisely that the caller never worked out which run it should be looking
 * for. That pairing is three lines inside `runRelease`
 * (`canonicalValidationRunKey(plan, catalogInputIdentity(snapshot.pipelineRuns))`),
 * they are not reachable from any pure test, and a version of them that passed
 * a hard-coded plan version would leave every test above green. So the function
 * is driven: real ledger rows in the test database, a real Repeatable Read
 * snapshot, in-memory files, and the refusal read off what it throws.
 */
describe('runRelease resolves the validation it demands from its own snapshot (NEW-01)', () => {
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
 * THE SEAM ITSELF: EVERY CLI ENTRY POINT TAKES THE CLAIM (DB-F09).
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
describe('every catalog CLI refuses to run while another stage holds the graph (DB-F09)', () => {
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
     */
    const runStageCli = (script: string, args: readonly string[]): Promise<ChildOutcome> =>
        new Promise((resolve, reject) => {
            const child = spawn(
                process.execPath,
                ['--require', TS_NODE_REGISTER, path.join(BACKEND_ROOT, 'scripts', script), ...args],
                {
                    cwd: BACKEND_ROOT,
                    timeout: CHILD_TIMEOUT_MS,
                    env: {
                        PATH: process.env.PATH,
                        HOME: process.env.HOME,
                        NODE_ENV: 'test',
                        DATABASE_URL: process.env.DATABASE_URL,
                        CATALOG_MODEL_CALL_BUDGET: '1',
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

    let graph: { release(): Promise<void> } | null = null;

    beforeAll(async () => {
        // One mutating stage, holding the graph for the duration, exactly as a
        // long import would.
        graph = await acquireCatalogStageLock({ stage: 'usda_import' });
    });

    afterAll(async () => {
        await graph?.release();
        graph = null;
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
        ['catalog-import-usda.ts', [], 'usda_import cannot take it exclusively'],
        ['catalog-validate.ts', [], 'validation cannot take it exclusively'],
        ['catalog-release.ts', ['--release', 'v99'], 'release cannot take it shared'],
        ['catalog-load.ts', ['--release', 'v1', '--confirm-target'], 'release_load cannot take it exclusively'],
    ] as [string, string[], string][])('%s refuses, and says which lock it could not take', async (
        script,
        argTemplate,
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
        // And the mode, because an export taking the lock exclusively would
        // serialise two harmless reads while a mutator taking it shared would
        // run beside another writer — the two mistakes this names apart.
        expect(output).toContain(expectedMode);
    });

    it('leaves the graph lock with its one holder, so a refused CLI released what it opened', async () => {
        const rows = await prisma.$queryRaw<{ count: number }[]>`
            SELECT count(*)::int AS count
            FROM pg_locks
            WHERE locktype = 'advisory' AND classid = ${0x434154}::int4
        `;

        expect(Number(rows[0]?.count ?? 0)).toBe(1);
    });
});
