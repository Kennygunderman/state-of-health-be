/**
 * Regression cover for the three import-stage defects a review of the produced
 * v1 release found, each of which is a property of a pure function in
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
 */
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
import type { ScriptLogger } from '../../../scripts/lib/logger';

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
