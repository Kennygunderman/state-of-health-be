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
