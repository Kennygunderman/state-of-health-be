/**
 * The recipe seed stage: `scripts/recipes-seed.ts`.
 *
 * WHAT THIS SUITE SETTLES. Agent Action Plan §0.7.1 Group 4 names six scenarios
 * for this stage, and each has a describe block below: a first seed, a no-op
 * rerun, a content change promoting a new version, a declared-versus-derived
 * mismatch, an unlisted oil named in the instructions, and an unknown
 * `source_key`. Two more are added because they are the ones a reviewer of the
 * schema would ask about: a STALE ingredient snapshot — separately for the
 * nutrition counter and for the metadata counter — must promote a version just
 * as changed content does (§0.5.1), and a single invalid file must leave the
 * whole run unpublished.
 *
 * WHY IT DRIVES `runSeed(deps)` RATHER THAN THE COMMAND. The stage's own
 * `main()` reads `process.argv`, classifies the ambient `DATABASE_URL` and calls
 * `process.exit`, none of which a test may do. `runSeed` takes its Prisma
 * client, its recipe directory, its clock and its report path as dependencies
 * for exactly this reason, so every scenario here runs the production code path
 * with nothing stubbed but those four seams. The argument parser, the preflight
 * check and the pure helpers are covered directly, as pure functions.
 *
 * WHY THE CATALOG IS SYNTHETIC. The stage resolves ingredients against
 * `catalog_foods`, and the committed v1 release is 13 MB of foods against which
 * this suite would be a load test rather than a unit of behaviour. Five
 * hand-written rows exercise every clause of the publication gate — published,
 * source-backed, allergen-known, finite macros, one default portion with a
 * positive gram weight — and the REAL 42-recipe corpus against the REAL release
 * is `src/__tests__/api/seed-rerun.test.ts`'s subject.
 *
 * WHY THE DECLARED VALUES ARE GENERATED. Each fixture payload's `dietTags`,
 * `allergenTags`, `allergenStatus`, `badges` and `budgetTier` are produced by
 * `recipe.logic.ts::deriveRecipeVersionFields` over the same ingredient set the
 * seed will resolve, so a fixture cannot fail the declared-versus-derived gate
 * by accident and every failure below is the one the test is named for. The
 * mismatch scenario overrides one of them deliberately, which is what proves
 * the gate is live.
 *
 * SAFETY AND ISOLATION. Every block truncates through
 * `setup/testDb.ts::truncateFeatureTables`, which re-runs the identity guard
 * (`NODE_ENV=test`, `ALLOW_DB_TRUNCATE=true`, a `_test`-class name on a local
 * host) and the schema-freshness gate, and the temporary recipe directory lives
 * under `os.tmpdir()` so no run can touch the committed corpus or the committed
 * coverage report. Run it with:
 *
 *   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
 *     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test \
 *     npx jest --ci --runInBand src/__tests__/scripts/recipes-seed.test.ts
 */
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { loadCoveragePlan, writeJsonFile } from '../../../scripts/lib/manifest';
import type { CoveragePlan } from '../../../scripts/lib/manifest';
import type { ScriptLogger } from '../../../scripts/lib/logger';
import {
    buildIngredientVocabulary,
    deriveCoverageReport,
    describeFailure,
    equivalentContent,
    findUnlistedInstructionTerms,
    foldPluralToken,
    isRecipeFileName,
    normalizeVocabularyText,
    parseArgs,
    parseRecipePayload,
    preflight,
    RecipeSeedError,
    runSeed,
    sameStoredNumber,
} from '../../../scripts/recipes-seed';
import type {
    CoverageRecipe,
    SeedDb,
    SeedDeps,
    SeedOutcome,
    SeedPreflightDeps,
} from '../../../scripts/recipes-seed';
import { prisma } from '../../prisma/client';
import { deriveRecipeVersionFields } from '../../services/recipe.logic';
import type { RecipeAllergenStatus, RecipePublicationIngredient } from '../../services/recipe.logic';
import { truncateFeatureTables } from '../setup/testDb';

/** Database work per block is a handful of small statements; a hang is worth failing. */
const BLOCK_TIMEOUT_MS = 120_000;

/** A `ts-node` child process pays its compiler startup once. */
const CHILD_TIMEOUT_MS = 180_000;

/**
 * The publication instant, pinned like every other database-backed suite's
 * clock so `published_at` and `retired_at` are exactly assertable values rather
 * than ones that move with the run.
 */
const PUBLISHED_AT = new Date('2026-09-13T12:00:00.000Z');

/** A second instant, so a promotion's `retired_at` is distinguishable from the first publication. */
const PROMOTED_AT = new Date('2026-09-14T08:30:00.000Z');

const silentLogger: ScriptLogger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => silentLogger,
};

/** A logger that keeps what the stage reported, for the assertions that read it. */
const recordingLogger = (recorded: { event: string; fields?: Record<string, unknown> }[]): ScriptLogger => {
    const record = (event: string, fields?: Record<string, unknown>): void => {
        recorded.push({ event, fields });
    };

    const logger: ScriptLogger = {
        debug: record,
        info: record,
        warn: record,
        error: record,
        child: () => logger,
    };

    return logger;
};

const coveragePlan: CoveragePlan = loadCoveragePlan();

/* ---------------------------------------------------------------------------
 * The synthetic catalog
 * ------------------------------------------------------------------------- */

interface FoodFixture {
    readonly source_key: string;
    readonly canonical_name: string;
    readonly display_name: string;
    readonly category: string;
    readonly food_group: string;
    readonly publication_status: string;
    readonly nutrition_provenance: string;
    readonly allergen_status: string;
    readonly allergen_tags: readonly string[];
    readonly diet_tags: readonly string[];
    readonly calories: number | null;
    readonly protein_g: number | null;
    readonly carbs_g: number | null;
    readonly fat_g: number | null;
    readonly fiber_g: number | null;
    readonly cost_class: number;
}

const PLANT_DIET_TAGS: readonly string[] = ['gluten_free', 'pescatarian', 'vegan', 'vegetarian'];

const FOODS: readonly FoodFixture[] = [
    {
        source_key: 'test:tofu-firm',
        canonical_name: 'tofu, firm',
        display_name: 'Tofu, firm',
        category: 'protein_plant',
        food_group: 'tofu',
        publication_status: 'published',
        nutrition_provenance: 'source_backed',
        allergen_status: 'known',
        allergen_tags: ['soy'],
        diet_tags: PLANT_DIET_TAGS,
        calories: 144,
        protein_g: 17.3,
        carbs_g: 2.8,
        fat_g: 8.7,
        fiber_g: 2.3,
        cost_class: 1,
    },
    {
        source_key: 'test:broccoli-raw',
        canonical_name: 'broccoli',
        display_name: 'Broccoli, raw',
        category: 'produce_vegetable',
        food_group: 'broccoli',
        publication_status: 'published',
        nutrition_provenance: 'source_backed',
        allergen_status: 'known',
        allergen_tags: [],
        diet_tags: PLANT_DIET_TAGS,
        calories: 34,
        protein_g: 2.8,
        carbs_g: 6.6,
        fat_g: 0.37,
        fiber_g: 2.6,
        cost_class: 1,
    },
    {
        source_key: 'test:canola-oil',
        canonical_name: 'canola oil',
        display_name: 'Canola oil',
        category: 'oil_fat',
        food_group: 'vegetable_oil',
        publication_status: 'published',
        nutrition_provenance: 'source_backed',
        allergen_status: 'known',
        allergen_tags: [],
        diet_tags: PLANT_DIET_TAGS,
        calories: 884,
        protein_g: 0,
        carbs_g: 0,
        fat_g: 100,
        fiber_g: 0,
        cost_class: 1,
    },
    {
        source_key: 'test:chicken-breast',
        canonical_name: 'chicken breast, cooked',
        display_name: 'Chicken breast, cooked',
        category: 'protein_poultry',
        food_group: 'chicken',
        publication_status: 'published',
        nutrition_provenance: 'source_backed',
        allergen_status: 'known',
        allergen_tags: [],
        diet_tags: ['gluten_free'],
        calories: 165,
        protein_g: 31,
        carbs_g: 0,
        fat_g: 3.6,
        fiber_g: 0,
        cost_class: 2,
    },
    {
        // Never published, so it may not back a NEW version — the publication
        // gate's first clause, and the reason this row exists.
        source_key: 'test:quinoa-candidate',
        canonical_name: 'quinoa, cooked',
        display_name: 'Quinoa, cooked',
        category: 'grain',
        food_group: 'quinoa',
        publication_status: 'candidate',
        nutrition_provenance: 'source_backed',
        allergen_status: 'known',
        allergen_tags: [],
        diet_tags: PLANT_DIET_TAGS,
        calories: 120,
        protein_g: 4.4,
        carbs_g: 21.3,
        fat_g: 1.9,
        fiber_g: 2.8,
        cost_class: 2,
    },
];

const FOODS_BY_KEY = new Map(FOODS.map((food) => [food.source_key, food]));

/** Empties the feature tables and inserts the synthetic catalog with one default portion each. */
const resetCatalog = async (): Promise<void> => {
    await truncateFeatureTables();

    for (const food of FOODS) {
        await prisma.catalog_foods.create({
            data: {
                source_key: food.source_key,
                canonical_name: food.canonical_name,
                display_name: food.display_name,
                category: food.category,
                food_state: 'cooked',
                food_group: food.food_group,
                identity_source: 'usda',
                identity_status: 'verified',
                nutrition_provenance: food.nutrition_provenance,
                publication_status: food.publication_status,
                nutrition_basis: 'per_100g',
                basis_amount: 100,
                calories: food.calories,
                protein_g: food.protein_g,
                carbs_g: food.carbs_g,
                fat_g: food.fat_g,
                fiber_g: food.fiber_g,
                allergen_tags: [...food.allergen_tags],
                allergen_status: food.allergen_status,
                diet_tags: [...food.diet_tags],
                cost_class: food.cost_class,
                nutrition_version: 1,
                metadata_version: 1,
                catalog_food_portions: {
                    create: [
                        {
                            description: '100 g',
                            amount: 100,
                            unit: 'g',
                            gram_weight: 100,
                            is_default: true,
                            source: 'fixture',
                        },
                    ],
                },
            },
        });
    }
};

/* ---------------------------------------------------------------------------
 * The synthetic corpus
 * ------------------------------------------------------------------------- */

interface PayloadOptions {
    readonly slug: string;
    readonly mealSlots: readonly string[];
    readonly instructions: readonly string[];
    readonly ingredientKeys: readonly string[];
    readonly prepMinutes?: number;
    readonly cookMinutes?: number;
    readonly yieldServings?: number;
    /** Applied last, so a scenario can break exactly one declared field. */
    readonly overrides?: Record<string, unknown>;
}

const ingredientRows = (keys: readonly string[]): Record<string, unknown>[] =>
    keys.map((sourceKey, index) => ({
        sourceKey,
        quantity: 1,
        unit: 'cups',
        gramWeight: 120 + index * 10,
        displayText: '1 cup',
        sortOrder: index,
        isOptional: false,
    }));

const publicationIngredient = (row: Record<string, unknown>): RecipePublicationIngredient => {
    const sourceKey = row.sourceKey as string;
    const food = FOODS_BY_KEY.get(sourceKey);
    if (food === undefined) {
        throw new Error(`the fixture builder has no food for "${sourceKey}"`);
    }

    return {
        catalog_food_id: sourceKey,
        snapshot_name: food.display_name,
        snapshot_provenance: 'source_backed',
        snapshot_allergen_tags: [...food.allergen_tags],
        snapshot_diet_tags: [...food.diet_tags],
        is_optional: row.isOptional as boolean,
        food_group: food.food_group,
        allergen_status: food.allergen_status as RecipeAllergenStatus,
        cost_class: food.cost_class,
        catalog_nutrition_version: 1,
        catalog_metadata_version: 1,
        snapshot_per_100g: {
            calories: food.calories as number,
            protein_g: food.protein_g as number,
            carbs_g: food.carbs_g as number,
            fat_g: food.fat_g as number,
            fiber_g: food.fiber_g,
        },
        quantity: row.quantity as number,
        unit: row.unit as string,
        gram_weight: row.gramWeight as number,
        display_text: row.displayText as string,
        sort_order: row.sortOrder as number,
        nutrition_basis: 'per_100g',
        density_g_per_ml: null,
    };
};

/**
 * One recipe payload whose declarations agree with the derivation by
 * construction — see the header.
 */
const buildPayload = (options: PayloadOptions): Record<string, unknown> => {
    const rows = ingredientRows(options.ingredientKeys);
    const yieldServings = options.yieldServings ?? 2;
    const prepMinutes = options.prepMinutes ?? 5;
    const cookMinutes = options.cookMinutes ?? 10;
    const derived = deriveRecipeVersionFields(
        rows.map(publicationIngredient),
        yieldServings,
        prepMinutes,
        cookMinutes,
    );

    return {
        slug: options.slug,
        name: `Fixture ${options.slug}`,
        description: `A fixture recipe for ${options.slug}.`,
        iconKey: 'bowl',
        instructions: [...options.instructions],
        yieldServings,
        servingDescription: '1 bowl',
        prepMinutes,
        cookMinutes,
        mealSlots: [...options.mealSlots],
        dietTags: derived.dietTags,
        allergenTags: derived.allergenTags,
        allergenStatus: derived.allergenStatus,
        budgetTier: derived.budgetTier,
        badges: derived.badges,
        ingredients: rows,
        ...options.overrides,
    };
};

const TOFU_BOWL_INSTRUCTIONS: readonly string[] = [
    'Press the tofu dry and cut it into bite-size pieces.',
    'Warm the canola oil in a wide pan over medium heat.',
    'Add the broccoli and cook for four minutes until crisp-tender.',
    'Fold the tofu back in and divide between two bowls.',
];

const CHICKEN_PLATE_INSTRUCTIONS: readonly string[] = [
    'Warm the canola oil in a wide pan over medium heat.',
    'Sear the chicken for six minutes a side, then rest it.',
    'Add the broccoli and cook for four minutes until crisp-tender.',
    'Slice the chicken and plate it beside the broccoli.',
];

const tofuBowl = (overrides: Partial<PayloadOptions> = {}): Record<string, unknown> =>
    buildPayload({
        slug: 'tofu-broccoli-bowl',
        mealSlots: ['lunch', 'dinner'],
        instructions: TOFU_BOWL_INSTRUCTIONS,
        ingredientKeys: ['test:tofu-firm', 'test:broccoli-raw', 'test:canola-oil'],
        ...overrides,
    });

const chickenPlate = (overrides: Partial<PayloadOptions> = {}): Record<string, unknown> =>
    buildPayload({
        slug: 'chicken-broccoli-plate',
        mealSlots: ['dinner'],
        instructions: CHICKEN_PLATE_INSTRUCTIONS,
        ingredientKeys: ['test:chicken-breast', 'test:broccoli-raw', 'test:canola-oil'],
        prepMinutes: 10,
        cookMinutes: 20,
        ...overrides,
    });

/* ---------------------------------------------------------------------------
 * The seams
 * ------------------------------------------------------------------------- */

let recipesDirectory: string;
let reportDirectory: string;

const reportPath = (): string => path.join(reportDirectory, 'coverage-report.json');

/** Replaces the temporary corpus with exactly these payloads. */
const writeCorpus = (payloads: readonly Record<string, unknown>[]): void => {
    for (const entry of fs.readdirSync(recipesDirectory)) {
        fs.rmSync(path.join(recipesDirectory, entry));
    }
    for (const payload of payloads) {
        fs.writeFileSync(
            path.join(recipesDirectory, `${payload.slug as string}.json`),
            `${JSON.stringify(payload, null, 2)}\n`,
            'utf8',
        );
    }
};

const seedDeps = (overrides: Partial<SeedDeps> = {}): SeedDeps => ({
    prisma: prisma as unknown as SeedDb,
    recipesDir: recipesDirectory,
    now: () => PUBLISHED_AT,
    options: { help: false, only: [], dryRun: false },
    logger: silentLogger,
    coveragePlan,
    reportPath: reportPath(),
    writeReport: writeJsonFile,
    ...overrides,
});

interface StoredState {
    readonly recipes: number;
    readonly versions: number;
    readonly currentVersions: number;
    readonly retiredVersions: number;
    readonly ingredients: number;
}

const readCounts = async (): Promise<StoredState> => ({
    recipes: await prisma.recipes.count(),
    versions: await prisma.recipe_versions.count(),
    currentVersions: await prisma.recipe_versions.count({ where: { status: 'current' } }),
    retiredVersions: await prisma.recipe_versions.count({ where: { status: 'retired' } }),
    ingredients: await prisma.recipe_ingredients.count(),
});

const readRecipe = async (slug: string) =>
    prisma.recipes.findUniqueOrThrow({
        where: { slug },
        include: {
            current_version: { include: { recipe_ingredients: { orderBy: { sort_order: 'asc' } } } },
            recipe_versions: { orderBy: { version: 'asc' } },
        },
    });

/** The refusal `runSeed` threw, as a `RecipeSeedError`, or a failure naming what it threw instead. */
const refusalFrom = async (deps: SeedDeps): Promise<RecipeSeedError> => {
    try {
        await runSeed(deps);
    } catch (error) {
        if (error instanceof RecipeSeedError) {
            return error;
        }
        throw error;
    }

    throw new Error('runSeed resolved where the scenario requires it to refuse');
};

beforeAll(() => {
    recipesDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-seed-corpus-'));
    reportDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-seed-report-'));
});

afterAll(async () => {
    await truncateFeatureTables();
    fs.rmSync(recipesDirectory, { recursive: true, force: true });
    fs.rmSync(reportDirectory, { recursive: true, force: true });
});

/* -------------------------------------------------------------------------- */

describe('the first seed', () => {
    let outcome: SeedOutcome;

    beforeAll(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl(), chickenPlate()]);
        outcome = await runSeed(seedDeps());
    }, BLOCK_TIMEOUT_MS);

    it('publishes one version 1 per file and reports it as created', () => {
        expect(outcome.created).toEqual(['chicken-broccoli-plate', 'tofu-broccoli-bowl']);
        expect(outcome.promoted).toEqual([]);
        expect(outcome.unchanged).toEqual([]);
        expect(outcome.ingredientRows).toBe(6);
    });

    it('stores every recipe with exactly one current version and no retired one', async () => {
        expect(await readCounts()).toEqual({
            recipes: 2,
            versions: 2,
            currentVersions: 2,
            retiredVersions: 0,
            ingredients: 6,
        });
    });

    it('moves current_version_id to the version it published, stamped with the injected clock', async () => {
        const recipe = await readRecipe('tofu-broccoli-bowl');

        expect(recipe.current_version).not.toBeNull();
        expect(recipe.current_version_id).toBe(recipe.current_version?.id);
        expect(recipe.current_version?.version).toBe(1);
        expect(recipe.current_version?.status).toBe('current');
        expect(recipe.current_version?.published_at).toEqual(PUBLISHED_AT);
        expect(recipe.current_version?.retired_at).toBeNull();
    });

    it('writes the ingredient snapshot columns from the resolved catalog rows', async () => {
        const recipe = await readRecipe('tofu-broccoli-bowl');
        const rows = recipe.current_version?.recipe_ingredients ?? [];
        const tofu = await prisma.catalog_foods.findUniqueOrThrow({ where: { source_key: 'test:tofu-firm' } });

        expect(rows.map((row) => row.snapshot_name)).toEqual(['Tofu, firm', 'Broccoli, raw', 'Canola oil']);
        expect(rows[0]).toMatchObject({
            catalog_food_id: tofu.id,
            catalog_nutrition_version: 1,
            catalog_metadata_version: 1,
            snapshot_provenance: 'source_backed',
            snapshot_allergen_tags: ['soy'],
            snapshot_diet_tags: [...PLANT_DIET_TAGS],
            quantity: 1,
            unit: 'cups',
            gram_weight: 120,
            display_text: '1 cup',
            sort_order: 0,
            is_optional: false,
        });
        expect(rows[0].snapshot_per_100g).toEqual({
            calories: 144,
            protein_g: 17.3,
            carbs_g: 2.8,
            fat_g: 8.7,
            fiber_g: 2.3,
        });
    });

    it('publishes the DERIVED version columns rather than the file\'s declarations', async () => {
        const recipe = await readRecipe('tofu-broccoli-bowl');
        const version = recipe.current_version;
        const derived = deriveRecipeVersionFields(
            ingredientRows(['test:tofu-firm', 'test:broccoli-raw', 'test:canola-oil']).map(publicationIngredient),
            2,
            5,
            10,
        );

        expect(version?.total_minutes).toBe(derived.totalMinutes);
        expect(version?.diet_tags).toEqual(derived.dietTags);
        expect(version?.allergen_tags).toEqual(derived.allergenTags);
        expect(version?.allergen_status).toBe(derived.allergenStatus);
        expect(version?.badges).toEqual(derived.badges);
        expect(version?.budget_tier).toBe(derived.budgetTier);
        expect(version?.nutrition_provenance).toBe(derived.nutritionProvenance);
        expect(version?.per_serving_calories).toBeCloseTo(derived.perServing.calories, 9);
        expect(version?.per_serving_protein_g).toBeCloseTo(derived.perServing.protein, 9);
        expect(version?.per_serving_carbs_g).toBeCloseTo(derived.perServing.carbs, 9);
        expect(version?.per_serving_fat_g).toBeCloseTo(derived.perServing.fat, 9);
        // The one list the file owns, because it is not derivable.
        expect(version?.meal_slots).toEqual(['lunch', 'dinner']);
    });

    it('writes the coverage report to the injected path, and the committed artefact is untouched', () => {
        expect(outcome.reportPath).toBe(reportPath());
        expect(outcome.reportSkippedReason).toBeNull();
        expect(fs.existsSync(reportPath())).toBe(true);
        expect(outcome.report?.recipeCount).toBe(2);
        expect(outcome.report?.eligibleCounts).toHaveLength(640);
        expect(outcome.report?.guaranteedCells).toHaveLength(140);
        expect(outcome.report?.reducedCells).toHaveLength(124);
    });
});

describe('an identical rerun', () => {
    let first: SeedOutcome;
    let second: SeedOutcome;
    let firstVersionIds: string[];
    let secondVersionIds: string[];
    let firstReport: string;
    let secondReport: string;

    beforeAll(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl(), chickenPlate()]);

        first = await runSeed(seedDeps());
        firstReport = fs.readFileSync(reportPath(), 'utf8');
        firstVersionIds = (await prisma.recipe_versions.findMany({ orderBy: { id: 'asc' } })).map((row) => row.id);

        second = await runSeed(seedDeps({ now: () => PROMOTED_AT }));
        secondReport = fs.readFileSync(reportPath(), 'utf8');
        secondVersionIds = (await prisma.recipe_versions.findMany({ orderBy: { id: 'asc' } })).map((row) => row.id);
    }, BLOCK_TIMEOUT_MS);

    it('publishes nothing and reports every recipe unchanged', () => {
        expect(first.created).toHaveLength(2);
        expect(second.created).toEqual([]);
        expect(second.promoted).toEqual([]);
        expect(second.unchanged).toEqual(['chicken-broccoli-plate', 'tofu-broccoli-bowl']);
        expect(second.ingredientRows).toBe(0);
    });

    it('leaves the same rows in place, by id, so no plan or diary reference is invalidated', async () => {
        expect(secondVersionIds).toEqual(firstVersionIds);
        expect(await readCounts()).toEqual({
            recipes: 2,
            versions: 2,
            currentVersions: 2,
            retiredVersions: 0,
            ingredients: 6,
        });
    });

    it('re-emits a byte-identical coverage report', () => {
        expect(secondReport).toBe(firstReport);
    });
});

describe('a content change', () => {
    let outcome: SeedOutcome;

    beforeAll(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl(), chickenPlate()]);
        await runSeed(seedDeps());

        // A longer prep time: it moves `total_minutes`, which is a column the
        // seed owns, so the stored version no longer describes the file.
        writeCorpus([tofuBowl({ prepMinutes: 25 }), chickenPlate()]);
        outcome = await runSeed(seedDeps({ now: () => PROMOTED_AT }));
    }, BLOCK_TIMEOUT_MS);

    it('promotes only the changed recipe', () => {
        expect(outcome.promoted).toEqual(['tofu-broccoli-bowl']);
        expect(outcome.created).toEqual([]);
        expect(outcome.unchanged).toEqual(['chicken-broccoli-plate']);
    });

    it('publishes version 2 as current and leaves exactly one retired version', async () => {
        const recipe = await readRecipe('tofu-broccoli-bowl');
        const versions = recipe.recipe_versions;

        expect(versions.map((version) => version.version)).toEqual([1, 2]);
        expect(versions.map((version) => version.status)).toEqual(['retired', 'current']);
        expect(versions[0].retired_at).toEqual(PROMOTED_AT);
        expect(versions[0].published_at).toEqual(PUBLISHED_AT);
        expect(versions[1].retired_at).toBeNull();
        expect(versions[1].published_at).toEqual(PROMOTED_AT);
        expect(recipe.current_version_id).toBe(versions[1].id);
        expect(await prisma.recipe_versions.count({ where: { status: 'current' } })).toBe(2);
    });

    it('never edits the retired version\'s content, and keeps its ingredient rows', async () => {
        const recipe = await readRecipe('tofu-broccoli-bowl');
        const [retired, current] = recipe.recipe_versions;

        expect(retired.total_minutes).toBe(15);
        expect(current.total_minutes).toBe(35);
        expect(await prisma.recipe_ingredients.count({ where: { recipe_version_id: retired.id } })).toBe(3);
        expect(await prisma.recipe_ingredients.count({ where: { recipe_version_id: current.id } })).toBe(3);
    });
});

describe('a stale ingredient snapshot', () => {
    beforeEach(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl()]);
        await runSeed(seedDeps());
    }, BLOCK_TIMEOUT_MS);

    it.each([
        ['nutrition_version', 'nutrition'],
        ['metadata_version', 'metadata'],
    ])(
        'promotes a new version when %s moved under an unchanged file',
        async (column: string, change: string) => {
            await prisma.catalog_foods.update({
                where: { source_key: 'test:tofu-firm' },
                data: { [column]: 2 },
            });

            const recorded: { event: string; fields?: Record<string, unknown> }[] = [];
            const outcome = await runSeed(
                seedDeps({ now: () => PROMOTED_AT, logger: recordingLogger(recorded) }),
            );

            expect(outcome.promoted).toEqual(['tofu-broccoli-bowl']);
            expect(outcome.unchanged).toEqual([]);

            // The refusal to leave a stale snapshot published is reported with
            // the ingredient and the counter that moved, which is what tells an
            // operator why a file nobody edited produced a new version.
            const promotion = recorded.find((entry) => entry.event === 'recipe_version_promoted');
            expect(String(promotion?.fields?.reason)).toContain('stale ingredient snapshot');
            expect(String(promotion?.fields?.reason)).toContain(`Tofu, firm (${change})`);

            const recipe = await readRecipe('tofu-broccoli-bowl');
            expect(recipe.recipe_versions.map((version) => version.status)).toEqual(['retired', 'current']);
            expect(recipe.current_version?.version).toBe(2);
            // The new snapshot records the counter it was taken from, so the
            // next run is a no-op rather than a second promotion.
            const snapshot = recipe.current_version?.recipe_ingredients.find(
                (row) => row.snapshot_name === 'Tofu, firm',
            );
            expect(
                column === 'nutrition_version'
                    ? snapshot?.catalog_nutrition_version
                    : snapshot?.catalog_metadata_version,
            ).toBe(2);

            const settled = await runSeed(seedDeps({ now: () => PROMOTED_AT }));
            expect(settled.unchanged).toEqual(['tofu-broccoli-bowl']);
            expect(await prisma.recipe_versions.count()).toBe(2);
        },
        BLOCK_TIMEOUT_MS,
    );
});

describe('a declared value the derivation contradicts', () => {
    let refusal: RecipeSeedError;

    beforeAll(async () => {
        await resetCatalog();
        writeCorpus([
            tofuBowl(),
            chickenPlate({ overrides: { dietTags: ['vegan'] } }),
        ]);
        refusal = await refusalFrom(seedDeps());
    }, BLOCK_TIMEOUT_MS);

    it('refuses loudly, naming the recipe, its file, the field and the offending ingredient', () => {
        expect(refusal.code).toBe('recipes_invalid');
        // BOTH directions of the disagreement are reported: the claim the
        // ingredients do not support, and the tag they produce that the file
        // then no longer declares.
        expect(refusal.problems).toHaveLength(2);
        for (const problem of refusal.problems) {
            expect(problem).toContain('chicken-broccoli-plate (recipes/chicken-broccoli-plate.json)');
            expect(problem).toContain('diet_tags');
        }
        expect(refusal.problems).toContainEqual(
            expect.stringContaining('declares "vegan", which the ingredients do not support: Chicken breast, cooked.'),
        );
        expect(refusal.message).toContain('nothing was published');
    });

    it('publishes no recipe at all, including the file that was valid', async () => {
        expect(await readCounts()).toEqual({
            recipes: 0,
            versions: 0,
            currentVersions: 0,
            retiredVersions: 0,
            ingredients: 0,
        });
    });
});

describe('an ingredient the instructions name but the list omits', () => {
    let refusal: RecipeSeedError;

    beforeAll(async () => {
        await resetCatalog();
        // The oil is dropped from the list and kept in the prose: AAP §0.7.3's
        // unlisted tablespoon of oil, which is ~120 uncounted kcal.
        writeCorpus([
            tofuBowl({ ingredientKeys: ['test:tofu-firm', 'test:broccoli-raw'] }),
        ]);
        refusal = await refusalFrom(seedDeps());
    }, BLOCK_TIMEOUT_MS);

    it('refuses naming the term and the step that names it', () => {
        expect(refusal.code).toBe('recipes_invalid');
        expect(refusal.problems).toHaveLength(1);
        expect(refusal.problems[0]).toContain('tofu-broccoli-bowl');
        expect(refusal.problems[0]).toContain('instructions name "canola oil"');
        expect(refusal.problems[0]).toContain('Warm the canola oil in a wide pan over medium heat.');
    });

    it('publishes nothing', async () => {
        expect(await prisma.recipes.count()).toBe(0);
    });

    it('accepts the same prose once the ingredient is listed', async () => {
        writeCorpus([tofuBowl()]);
        const outcome = await runSeed(seedDeps());

        expect(outcome.created).toEqual(['tofu-broccoli-bowl']);
    }, BLOCK_TIMEOUT_MS);
});

describe('an ingredient the catalog cannot back', () => {
    beforeEach(async () => {
        await resetCatalog();
    }, BLOCK_TIMEOUT_MS);

    it('refuses an unknown source_key, naming the recipe and the key', async () => {
        writeCorpus([
            tofuBowl({
                overrides: {
                    ingredients: ingredientRows(['test:tofu-firm', 'test:broccoli-raw', 'test:canola-oil']).map(
                        (row, index) => (index === 2 ? { ...row, sourceKey: 'test:not-in-the-catalog' } : row),
                    ),
                },
            }),
        ]);

        const refusal = await refusalFrom(seedDeps());

        expect(refusal.code).toBe('recipes_invalid');
        expect(refusal.problems).toHaveLength(1);
        expect(refusal.problems[0]).toContain('tofu-broccoli-bowl');
        expect(refusal.problems[0]).toContain('test:not-in-the-catalog');
        expect(refusal.problems[0]).toContain('resolves to no catalog_foods row');
        expect(await prisma.recipes.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);

    it('refuses a food that is not published, naming its publication_status', async () => {
        writeCorpus([
            buildPayload({
                slug: 'quinoa-bowl',
                mealSlots: ['lunch'],
                instructions: ['Warm the quinoa through and serve it in a bowl.'],
                ingredientKeys: ['test:quinoa-candidate'],
            }),
        ]);

        const refusal = await refusalFrom(seedDeps());

        expect(refusal.code).toBe('recipes_invalid');
        expect(refusal.problems.join('\n')).toContain('test:quinoa-candidate');
        expect(refusal.problems.join('\n')).toContain('publication_status is "candidate"');
        expect(await prisma.recipes.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);

    it('refuses a food whose default portion is missing', async () => {
        await prisma.catalog_food_portions.deleteMany({
            where: { catalog_foods: { source_key: 'test:canola-oil' } },
        });
        writeCorpus([tofuBowl()]);

        const refusal = await refusalFrom(seedDeps());

        expect(refusal.problems.join('\n')).toContain('test:canola-oil');
        expect(refusal.problems.join('\n')).toContain('0 default catalog_food_portions rows');
        expect(await prisma.recipes.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);
});

describe('a narrowed or dry run', () => {
    beforeEach(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl(), chickenPlate()]);
    }, BLOCK_TIMEOUT_MS);

    it('validates everything and writes nothing on a dry run', async () => {
        fs.rmSync(reportPath(), { force: true });

        const outcome = await runSeed(seedDeps({ options: { help: false, only: [], dryRun: true } }));

        expect(outcome.dryRun).toBe(true);
        expect(outcome.selected).toEqual(['chicken-broccoli-plate', 'tofu-broccoli-bowl']);
        expect(outcome.created).toEqual([]);
        expect(outcome.reportSkippedReason).toContain('dry run');
        expect(fs.existsSync(reportPath())).toBe(false);
        expect(await prisma.recipes.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);

    it('seeds only the named slug and refuses to rewrite the whole-corpus report', async () => {
        fs.rmSync(reportPath(), { force: true });

        const outcome = await runSeed(
            seedDeps({ options: { help: false, only: ['tofu-broccoli-bowl'], dryRun: false } }),
        );

        expect(outcome.created).toEqual(['tofu-broccoli-bowl']);
        expect(outcome.reportPath).toBeNull();
        expect(outcome.reportSkippedReason).toContain('narrowed');
        expect(fs.existsSync(reportPath())).toBe(false);
        expect(await prisma.recipes.count()).toBe(1);
    }, BLOCK_TIMEOUT_MS);
});

describe('importing the module', () => {
    it('runs no stage, opens no client and writes nothing', () => {
        const backendRoot = path.resolve(__dirname, '..', '..', '..');
        const probe =
            "const m = require('./scripts/recipes-seed.ts');" +
            "process.stdout.write(JSON.stringify({" +
            'runSeed: typeof m.runSeed,' +
            'parseArgs: typeof m.parseArgs,' +
            "prismaLoaded: Object.keys(require.cache).some((key) => key.includes('src/prisma/client'))" +
            '}));';

        // A child process is the only honest form of this assertion: this file
        // has already imported the module, so nothing in-process can show what
        // that import did on its own. `require.main` is not the module under
        // `-e`, and dbGuard's module-load enforcement no-ops because argv[1]
        // names no known script — the same path that lets this suite import it.
        const child = spawnSync(
            process.execPath,
            ['--require', 'ts-node/register/transpile-only', '-e', probe],
            {
                cwd: backendRoot,
                encoding: 'utf8',
                timeout: CHILD_TIMEOUT_MS,
                env: { ...process.env, TS_NODE_PROJECT: 'tsconfig.scripts.json' },
            },
        );

        expect(child.error).toBeUndefined();
        expect(child.status).toBe(0);
        expect(JSON.parse(child.stdout)).toEqual({
            runSeed: 'function',
            parseArgs: 'function',
            prismaLoaded: false,
        });
    }, CHILD_TIMEOUT_MS);
});

/* ---------------------------------------------------------------------------
 * The pure surface
 * ------------------------------------------------------------------------- */

describe('parseArgs', () => {
    it('defaults to the whole corpus and a real run', () => {
        expect(parseArgs([])).toEqual({ ok: true, options: { help: false, only: [], dryRun: false } });
    });

    it('collects --only, accepts --slug as its alias, and deduplicates', () => {
        expect(parseArgs(['--only', 'a', '--slug', 'b', '--only=a'])).toEqual({
            ok: true,
            options: { help: false, only: ['a', 'b'], dryRun: false },
        });
    });

    it('reads --dry-run as a switch', () => {
        expect(parseArgs(['--dry-run'])).toEqual({
            ok: true,
            options: { help: false, only: [], dryRun: true },
        });
    });

    it('consumes --confirm-target and its value without interpreting either', () => {
        expect(parseArgs(['--confirm-target', 'soh_test', '--only', 'a'])).toEqual({
            ok: true,
            options: { help: false, only: ['a'], dryRun: false },
        });
    });

    it('refuses --only with no value, and any flag it does not accept', () => {
        expect(parseArgs(['--only'])).toEqual({
            ok: false,
            errors: [{ flag: '--only', message: '--only requires a recipe slug' }],
        });
        expect(parseArgs(['--force'])).toEqual({
            ok: false,
            errors: [{ flag: '--force', message: '--force is not a flag recipes-seed accepts' }],
        });
    });

    it('answers help before anything else', () => {
        for (const argv of [['--help'], ['-h'], ['--only', 'a', '--help']]) {
            expect(parseArgs(argv)).toEqual({ ok: true, options: { help: true, only: [], dryRun: false } });
        }
    });
});

describe('preflight', () => {
    const deps = (overrides: Partial<SeedPreflightDeps> = {}): SeedPreflightDeps => ({
        env: {},
        recipesDir: () => '/data/meal-planning/recipes',
        listDirectory: () => ['tofu-broccoli-bowl.json', 'coverage-report.json'],
        fileExists: () => true,
        ...overrides,
    });

    it('reports no gap when the directory holds a recipe and the logic module is present', () => {
        expect(preflight(deps())).toEqual([]);
    });

    it('distinguishes an absent directory from an empty one', () => {
        expect(preflight(deps({ listDirectory: () => null })).map((gap) => gap.code)).toEqual([
            'recipes_directory_absent',
        ]);
        // The report is this stage's own output, so a directory holding only it
        // holds no recipe.
        expect(preflight(deps({ listDirectory: () => ['coverage-report.json'] })).map((gap) => gap.code)).toEqual([
            'recipes_directory_empty',
        ]);
    });

    it('reports the derivation module when it is missing', () => {
        expect(preflight(deps({ fileExists: () => false })).map((gap) => gap.code)).toEqual(['recipe_logic_absent']);
    });
});

describe('isRecipeFileName', () => {
    it('accepts a recipe payload and rejects this stage\'s own output', () => {
        expect(isRecipeFileName('tofu-broccoli-bowl.json')).toBe(true);
        expect(isRecipeFileName('coverage-report.json')).toBe(false);
        expect(isRecipeFileName('README.md')).toBe(false);
    });
});

describe('parseRecipePayload', () => {
    const valid = (): Record<string, unknown> => tofuBowl();

    it('requires the slug to equal the file name', () => {
        expect(() => parseRecipePayload('other-name.json', valid())).toThrow(
            /slug "tofu-broccoli-bowl" must equal the file's name "other-name"/,
        );
    });

    it('accepts an empty dietTags list as the derivation\'s own answer', () => {
        const payload = parseRecipePayload('tofu-broccoli-bowl.json', { ...valid(), dietTags: [] });

        expect(payload.dietTags).toEqual([]);
    });

    it.each([
        ['name', { name: '' }, /name must be a non-empty string/],
        ['yieldServings', { yieldServings: 0 }, /yieldServings must be greater than zero/],
        ['prepMinutes', { prepMinutes: 1.5 }, /prepMinutes must be an integer/],
        ['cookMinutes', { cookMinutes: -1 }, /cookMinutes must not be negative/],
        ['instructions', { instructions: [] }, /instructions must hold at least one entry/],
        ['mealSlots', { mealSlots: [] }, /mealSlots must hold at least one entry/],
        ['badges', { badges: 'quick' }, /badges must be an array of strings/],
        ['ingredients', { ingredients: [] }, /ingredients must hold at least one entry/],
    ])('refuses a malformed %s', (_field: string, override: Record<string, unknown>, message: RegExp) => {
        expect(() => parseRecipePayload('tofu-broccoli-bowl.json', { ...valid(), ...override })).toThrow(message);
    });

    it('refuses an ingredient with a non-positive gram weight, naming its index', () => {
        const payload = {
            ...valid(),
            ingredients: ingredientRows(['test:tofu-firm']).map((row) => ({ ...row, gramWeight: 0 })),
        };

        expect(() => parseRecipePayload('tofu-broccoli-bowl.json', payload)).toThrow(
            /ingredient 0: gramWeight must be greater than zero/,
        );
    });
});

describe('the ingredient vocabulary', () => {
    it('folds English plurals symmetrically on both sides', () => {
        expect(foldPluralToken('berries')).toBe('berry');
        expect(foldPluralToken('tomatoes')).toBe('tomato');
        expect(foldPluralToken('oils')).toBe('oil');
        // Short tokens and double-s endings are left alone.
        expect(foldPluralToken('oats')).toBe('oat');
        expect(foldPluralToken('gas')).toBe('gas');
        expect(foldPluralToken('glass')).toBe('glass');
    });

    it('normalises punctuation, case and accents to a single spelling', () => {
        expect(normalizeVocabularyText('Tofu, FIRM')).toBe('tofu firm');
        expect(normalizeVocabularyText('olive_oil')).toBe('olive oil');
        expect(normalizeVocabularyText('  Jalapeño   Peppers  ')).toBe('jalapeno pepper');
    });

    it('splits the vocabulary by shape, because the two shapes match differently', () => {
        const vocabulary = buildIngredientVocabulary(['vegetable_oil', 'tofu'], ['Canola oil', 'Oats, rolled']);

        expect([...vocabulary.singleWordTerms].sort()).toEqual(['tofu']);
        expect(vocabulary.multiWordTerms).toEqual(['canola oil', 'oat rolled', 'vegetable oil']);
    });

    const vocabulary = buildIngredientVocabulary(
        coveragePlan.foodGroups.map((entry) => entry.foodGroup),
        ['canola oil', 'tofu, firm', 'broccoli'],
    );
    const listed = [
        { foodGroup: 'tofu', canonicalName: 'tofu, firm', displayName: 'Tofu, firm' },
        { foodGroup: 'broccoli', canonicalName: 'broccoli', displayName: 'Broccoli, raw' },
    ];

    it('names a multi-word term the list does not account for, with its step', () => {
        expect(findUnlistedInstructionTerms(TOFU_BOWL_INSTRUCTIONS, listed, vocabulary)).toEqual([
            { term: 'canola oil', instruction: 'Warm the canola oil in a wide pan over medium heat.' },
        ]);
    });

    it('accounts for a term through the ingredient name, in either direction', () => {
        expect(
            findUnlistedInstructionTerms(
                ['Press the tofu dry and add the broccoli.'],
                listed,
                vocabulary,
            ),
        ).toEqual([]);
    });

    it('accounts for a term through the ingredient\'s food group', () => {
        expect(
            findUnlistedInstructionTerms(
                ['Stir the tofu through.'],
                [{ foodGroup: 'tofu', canonicalName: 'bean curd', displayName: 'Bean curd' }],
                vocabulary,
            ),
        ).toEqual([]);
    });

    it('does not fire on a single-word term inside a longer word', () => {
        // "oat" inside "coated" and "rice" inside "priced" are the false
        // positives whole-token matching exists to prevent.
        expect(
            findUnlistedInstructionTerms(['Serve the tofu coated and sensibly priced.'], listed, vocabulary),
        ).toEqual([]);
    });

    it('reports an unaccounted term once, however many steps name it', () => {
        const repeated = ['Warm the canola oil.', 'Add more canola oil.'];

        expect(findUnlistedInstructionTerms(repeated, listed, vocabulary)).toHaveLength(1);
    });
});

describe('comparing a stored value with the value that was written', () => {
    it('treats a one-ulp DOUBLE PRECISION round trip as the same number', () => {
        expect(sameStoredNumber(177.793, 177.79299999999998)).toBe(true);
        expect(sameStoredNumber(177.793, 177.8)).toBe(false);
        expect(sameStoredNumber(0, 0)).toBe(true);
        expect(sameStoredNumber(Number.NaN, Number.NaN)).toBe(false);
    });

    it('compares jsonb objects by key rather than by serialised order', () => {
        expect(
            equivalentContent(
                { fat_g: 1, calories: 2, fiber_g: null },
                { calories: 2, fiber_g: null, fat_g: 1 },
            ),
        ).toBe(true);
        expect(equivalentContent({ fiber_g: null }, {})).toBe(false);
        expect(equivalentContent([1, 2], [2, 1])).toBe(false);
    });
});

describe('deriveCoverageReport', () => {
    const recipe = (
        slug: string,
        mealSlots: readonly string[],
        dietTags: readonly string[],
        allergenTags: readonly string[],
        totalMinutes: number,
    ): CoverageRecipe => ({
        slug,
        mealSlots,
        dietTags,
        version: {
            status: 'current',
            nutrition_provenance: 'source_backed',
            allergen_status: 'known',
            total_minutes: totalMinutes,
            meal_slots: mealSlots,
            ingredients: [
                {
                    catalog_food_id: `${slug}-ingredient`,
                    snapshot_name: `${slug} ingredient`,
                    snapshot_provenance: 'source_backed',
                    snapshot_allergen_tags: allergenTags,
                    snapshot_diet_tags: dietTags,
                    is_optional: false,
                    food_group: 'tofu',
                    allergen_status: 'known',
                },
            ],
        },
    });

    const report = deriveCoverageReport([
        recipe('vegan-quick', ['breakfast'], [...PLANT_DIET_TAGS], [], 10),
        recipe('vegetarian-slow', ['breakfast', 'lunch'], ['pescatarian', 'vegetarian'], ['milk'], 50),
        recipe('omnivore', ['dinner'], [], [], 30),
    ]);

    it('states every dimension of the table and one cell per combination', () => {
        expect(report.dimensions).toEqual({
            diets: ['none', 'vegetarian', 'vegan', 'pescatarian'],
            allergens: ['none', 'milk', 'eggs', 'peanuts', 'tree_nuts', 'soy', 'wheat', 'fish', 'shellfish', 'sesame'],
            slots: ['breakfast', 'lunch', 'dinner', 'snack'],
            mainSlots: ['breakfast', 'lunch', 'dinner'],
            timeTiers: [15, 30, 45, 60],
        });
        expect(report.eligibleCounts).toHaveLength(4 * 10 * 4 * 4);
        expect(report.recipeCount).toBe(3);
        expect(report.crossListedRecipeCount).toBe(1);
    });

    it('counts a cell through the production eligibility rule', () => {
        const countAt = (diet: string, allergen: string, slot: string, timeTier: number): number | undefined =>
            report.eligibleCounts.find(
                (cell) =>
                    cell.diet === diet &&
                    cell.allergen === allergen &&
                    cell.slot === slot &&
                    cell.timeTier === timeTier,
            )?.count;

        // Both breakfast recipes at the loosest tier; only the 10-minute one at
        // the tightest; the milk-bearing one disappears when milk is excluded;
        // and the vegan one is the only breakfast a vegan may plan.
        expect(countAt('none', 'none', 'breakfast', 60)).toBe(2);
        expect(countAt('none', 'none', 'breakfast', 15)).toBe(1);
        expect(countAt('none', 'milk', 'breakfast', 60)).toBe(1);
        expect(countAt('vegan', 'none', 'breakfast', 60)).toBe(1);
    });

    it('marks the guaranteed and reduced cells §0.7.3 names, and nothing else', () => {
        expect(report.guaranteedCells).toHaveLength(140);
        expect(report.reducedCells).toHaveLength(124);
        expect(report.guaranteedCells.every((cell) => cell.threshold === 4)).toBe(true);
        expect(report.reducedCells.every((cell) => cell.threshold === 2)).toBe(true);

        const key = (cell: { diet: string; allergen: string; slot: string; timeTier: number }): string =>
            `${cell.diet}|${cell.allergen}|${cell.slot}|${cell.timeTier}`;
        const guaranteed = new Set(report.guaranteedCells.map(key));
        expect(report.reducedCells.some((cell) => guaranteed.has(key(cell)))).toBe(false);

        expect(report.guaranteedCells[0]).toMatchObject({
            diet: 'none',
            allergen: 'none',
            slot: 'breakfast',
            timeTier: 45,
        });
        expect(report.reducedCells[0]).toMatchObject({
            diet: 'vegetarian',
            allergen: 'milk',
            slot: 'breakfast',
            timeTier: 45,
        });
    });

    it('splits each slot into the four strata and records the floors §0.7.3 states', () => {
        expect(report.slotComposition.breakfast).toEqual({
            dedicatedToSlot: 1,
            totalEligible: 2,
            composition: {
                vegan: { floor: 4, count: 1 },
                furtherVegetarian: { floor: 3, count: 1 },
                furtherPescatarian: { floor: 2, count: 0 },
                furtherOmnivore: { floor: 3, count: 0 },
            },
        });
        // A floor of null is "§0.7.3 states none", which is not a floor of zero.
        expect(report.slotComposition.snack.composition.furtherPescatarian.floor).toBeNull();
    });

    it('carries the self-describing members the committed artefact is reviewed with', () => {
        expect(report.schemaVersion).toBe(1);
        expect(report.eligibilityRule.mirrors).toBe('src/services/recipe.logic.ts::isEligibleForPlanning');
        expect(report.repeatRule).toMatchObject({
            maxUsesPerWeek: 2,
            consecutiveDaysAllowed: false,
            minEligiblePerSlotForFullWeek: 4,
        });
        expect(report.boundary).toContain('supported at runtime but not guaranteed');
        expect(report.boundary).toContain('no_matching_meals');
        expect(report.boundary).toContain('editStep');
    });
});

describe('describeFailure', () => {
    it('reports the stage\'s own refusal under its code', () => {
        expect(describeFailure(new RecipeSeedError('unknown_slug', 'no such slug')).code).toBe('unknown_slug');
        expect(describeFailure(new RecipeSeedError('recipes_invalid', 'bad', ['one', 'two'])).error.message).toContain(
            'one',
        );
    });

    it('reports anything unrecognised as unexpected rather than swallowing it', () => {
        expect(describeFailure(new Error('boom'))).toEqual({
            code: 'unexpected_error',
            error: { name: 'Error', message: 'boom' },
        });
    });
});
