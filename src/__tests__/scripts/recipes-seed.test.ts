/**
 * The recipe seed stage: `scripts/recipes-seed.ts`.
 *
 * WHAT THIS SUITE SETTLES. Agent Action Plan §0.7.1 Group 4 names six scenarios
 * for this stage, and each has a describe block below: a first seed, a no-op
 * rerun, a content change promoting a new version, a declared-versus-derived
 * mismatch, an unlisted oil named in the instructions, and an unknown
 * `source_key`. The rest are the ones a reviewer of the schema would ask about:
 * a STALE ingredient snapshot — separately for the nutrition counter and for
 * the metadata counter — must promote a version just as changed content does
 * (§0.5.1); a single invalid file must leave the whole run unpublished; the
 * promotion must be ONE transaction, so a failure part-way through it must
 * leave the recipe exactly as current as it was; the version chain must
 * accumulate rather than be pruned; every clause of the publication gate must
 * refuse on its own; and the stage's `development_or_confirmed` database policy
 * must hold.
 *
 * WHAT THIS SUITE DELIBERATELY DOES NOT SETTLE. The coverage matrix — every
 * diet x single-allergen x slot x time-tier cell, the §0.7.3 guaranteed and
 * reduced thresholds, the slot-composition floors, and equality with the
 * committed `data/meal-planning/recipes/coverage-report.json` — belongs to
 * `src/__tests__/api/seed-rerun.test.ts`, which computes it from the REAL
 * 42-recipe corpus. Restating a cell of it here would assert the same rule
 * twice over a synthetic corpus that cannot satisfy it. What this suite keeps
 * of the report is the WIRING only: that it was written to the injected path,
 * that the committed artefact was left alone, and that a narrowed or dry run
 * writes none. Recipe nutrition, badge derivation, provenance rollup and
 * `isEligibleForPlanning` are pure functions owned by
 * `src/services/__tests__/recipe.logic.test.ts`.
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

import {
    assertScriptDatabase,
    classifyDatabaseOrigin,
    DatabaseOriginError,
    entryScriptName,
    SCRIPT_DATABASE_POLICIES,
} from '../../../scripts/lib/dbGuard';
import { createLogger, safeError } from '../../../scripts/lib/logger';
import { loadCoveragePlan, recipesDir, writeJsonFile } from '../../../scripts/lib/manifest';
import type { CoveragePlan } from '../../../scripts/lib/manifest';
import type { LogLevel, ScriptLogger } from '../../../scripts/lib/logger';
import {
    buildIngredientVocabulary,
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
import type { SeedDb, SeedDeps, SeedOutcome, SeedPreflightDeps } from '../../../scripts/recipes-seed';
import { prisma } from '../../prisma/client';
import { deriveRecipeVersionFields } from '../../services/recipe.logic';
import type { RecipeAllergenStatus, RecipePublicationIngredient } from '../../services/recipe.logic';
import { RECIPE_BADGES, RECIPE_ICON_KEYS } from '../../types/recipe';
import type { RecipeBadge, RecipeIconKey } from '../../types/recipe';
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

/** A third, so a chain of promotions is ordered by assertable timestamps rather than by row order. */
const THIRD_PUBLISHED_AT = new Date('2026-09-15T17:45:00.000Z');

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
        // Publishable, and the one row whose diet tags do NOT include
        // `gluten_free`: intersected with the chicken's `['gluten_free']` it
        // derives an EMPTY diet-tag list, which is a real answer rather than a
        // missing one (`deriveDietTags` over a disjoint pair).
        source_key: 'test:wheat-flour',
        canonical_name: 'wheat flour',
        display_name: 'Wheat flour',
        category: 'grain',
        food_group: 'wheat_grain',
        publication_status: 'published',
        nutrition_provenance: 'source_backed',
        allergen_status: 'known',
        allergen_tags: ['wheat'],
        diet_tags: ['pescatarian', 'vegan', 'vegetarian'],
        calories: 364,
        protein_g: 10.3,
        carbs_g: 76.3,
        fat_g: 1,
        fiber_g: 2.7,
        cost_class: 1,
    },
    // One row per clause of the publication gate, each differing from a
    // publishable row in exactly ONE column, so a refusal below is attributable
    // to that column and to nothing else.
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
    {
        // Published once and withdrawn by a later catalog release. It keeps
        // backing the versions that already reference it — which is what makes
        // a historical plan and its diary entries readable, and why a release
        // retires rather than deletes — but a NEW version built on it would be
        // unplannable from the moment it published.
        source_key: 'test:barley-retired',
        canonical_name: 'barley, pearled',
        display_name: 'Barley, pearled',
        category: 'grain',
        food_group: 'wheat_grain',
        publication_status: 'retired',
        nutrition_provenance: 'source_backed',
        allergen_status: 'known',
        allergen_tags: ['wheat'],
        diet_tags: ['pescatarian', 'vegan', 'vegetarian'],
        calories: 123,
        protein_g: 2.3,
        carbs_g: 28.2,
        fat_g: 0.4,
        fiber_g: 3.8,
        cost_class: 1,
    },
    {
        source_key: 'test:peanut-sauce-estimated',
        canonical_name: 'peanut sauce',
        display_name: 'Peanut sauce',
        category: 'condiment_sauce',
        food_group: 'peanut',
        publication_status: 'published',
        nutrition_provenance: 'ai_estimated',
        allergen_status: 'known',
        allergen_tags: ['peanuts'],
        diet_tags: ['vegan', 'vegetarian'],
        calories: 220,
        protein_g: 7.2,
        carbs_g: 12.4,
        fat_g: 16.1,
        fiber_g: 1.8,
        cost_class: 2,
    },
    {
        source_key: 'test:vegetable-broth-derived',
        canonical_name: 'vegetable broth',
        display_name: 'Vegetable broth',
        category: 'condiment_sauce',
        food_group: 'soup',
        publication_status: 'published',
        nutrition_provenance: 'ingredient_derived',
        allergen_status: 'known',
        allergen_tags: [],
        diet_tags: PLANT_DIET_TAGS,
        calories: 6,
        protein_g: 0.3,
        carbs_g: 1,
        fat_g: 0.1,
        fiber_g: 0,
        cost_class: 1,
    },
    {
        source_key: 'test:blue-cheese-unreviewed',
        canonical_name: 'blue cheese',
        display_name: 'Blue cheese',
        category: 'dairy',
        food_group: 'blue_cheese',
        publication_status: 'published',
        nutrition_provenance: 'source_backed',
        // Nobody has reviewed it, so it cannot be certified safe for any user
        // whatever they selected — the tags being empty is not an absence of
        // allergens, it is an absence of a review.
        allergen_status: 'unknown',
        allergen_tags: [],
        diet_tags: ['vegetarian'],
        calories: 353,
        protein_g: 21.4,
        carbs_g: 2.3,
        fat_g: 28.7,
        fiber_g: 0,
        cost_class: 3,
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

/**
 * Typed against the closed set rather than written as a string, so a key this
 * stage would refuse cannot reach a fixture through `typecheck:test`. The
 * scenarios that DO need a refused value pass it through `overrides`, which is
 * the honest shape for a value arriving from JSON.
 */
const FIXTURE_ICON_KEY: RecipeIconKey = 'bowl';

interface PayloadOptions {
    readonly slug: string;
    readonly mealSlots: readonly string[];
    readonly instructions: readonly string[];
    readonly ingredientKeys: readonly string[];
    readonly prepMinutes?: number;
    readonly cookMinutes?: number;
    readonly yieldServings?: number;
    readonly iconKey?: RecipeIconKey;
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
        iconKey: options.iconKey ?? FIXTURE_ICON_KEY,
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

const BREADED_CHICKEN_INSTRUCTIONS: readonly string[] = [
    'Toss the chicken in the wheat flour until evenly coated.',
    'Bake for twenty minutes, turning once, until cooked through.',
];

/** The one pair in the fixture catalog whose diet claims do not overlap. */
const breadedChicken = (overrides: Partial<PayloadOptions> = {}): Record<string, unknown> =>
    buildPayload({
        slug: 'breaded-chicken-bake',
        mealSlots: ['dinner'],
        instructions: BREADED_CHICKEN_INSTRUCTIONS,
        ingredientKeys: ['test:chicken-breast', 'test:wheat-flour'],
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

/**
 * The corpus this stage ships, reached through the manifest's own resolver
 * rather than a relative path. Nothing here reads a recipe from it — the
 * temporary directory is the corpus under test — and the ONE thing it is used
 * for is proving the committed coverage report was not rewritten.
 */
const COMMITTED_REPORT = path.join(recipesDir(), 'coverage-report.json');

let committedReportModifiedAt: number;

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

/**
 * The failure the atomicity scenario injects, as a class rather than a string
 * so the assertion names a type (§8) and cannot pass on an unrelated error that
 * happens to carry similar prose.
 */
class InjectedPublishFailure extends Error {
    constructor(public readonly afterWrite: string) {
        super(`injected failure after ${afterWrite}`);
        this.name = 'InjectedPublishFailure';
    }
}

/**
 * The real client, with one write inside the publication transaction replaced by
 * a throw.
 *
 * Injection through `SeedDeps.prisma` rather than a module mock: `publishRecipe`
 * receives its client as an argument for exactly this reason, and the wrapper
 * delegates `$transaction` to the real one so the rollback under test is
 * PostgreSQL's, not a fake's.
 */
const failingAfter = (write: 'retire' | 'insert'): SeedDb => {
    const real = prisma as unknown as SeedDb;

    const wrapTx = (tx: SeedDb): SeedDb => ({
        catalog_foods: tx.catalog_foods,
        recipes: {
            findUnique<Row>(args: unknown): Promise<Row | null> {
                return tx.recipes.findUnique<Row>(args);
            },
            findMany<Row>(args: unknown): Promise<Row[]> {
                return tx.recipes.findMany<Row>(args);
            },
            create(args: unknown): Promise<{ id: string }> {
                return tx.recipes.create(args);
            },
            // The `current_version_id` move, which is a promotion's last write:
            // failing here is what a caller that committed the retire and the
            // insert in an earlier transaction would survive.
            update(args: unknown): Promise<{ id: string }> {
                return write === 'insert'
                    ? Promise.reject(new InjectedPublishFailure('the new version was inserted'))
                    : tx.recipes.update(args);
            },
        },
        recipe_versions: {
            create(args: unknown): Promise<{ id: string; version: number }> {
                return write === 'retire'
                    ? Promise.reject(new InjectedPublishFailure('the previous version was retired'))
                    : tx.recipe_versions.create(args);
            },
            update(args: unknown): Promise<{ id: string }> {
                return tx.recipe_versions.update(args);
            },
        },
        $transaction<T>(work: (inner: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T> {
            return tx.$transaction(work, options);
        },
    });

    return {
        catalog_foods: real.catalog_foods,
        recipes: real.recipes,
        recipe_versions: real.recipe_versions,
        $transaction<T>(work: (tx: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T> {
            return real.$transaction((tx) => work(wrapTx(tx)), options);
        },
    };
};

interface CapturedLine {
    readonly level: LogLevel;
    readonly line: string;
    readonly entry: Record<string, unknown>;
}

/**
 * A real `ScriptLogger` over a captured sink, so an assertion reads the bytes
 * the stage would have emitted rather than the fields it passed in — the only
 * form in which "the reason is reported and the connection string is not" is
 * actually checkable.
 */
const capturingLogger = (captured: CapturedLine[]): ScriptLogger =>
    createLogger('recipes-seed', {
        level: 'debug',
        now: () => PUBLISHED_AT,
        write: (line, level) => {
            captured.push({ level, line, entry: JSON.parse(line) as Record<string, unknown> });
        },
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

interface StoredIdentity {
    readonly recipes: { id: string; slug: string; current_version_id: string | null }[];
    readonly versions: string[];
    readonly ingredients: string[];
}

/** Every row's id, so a rerun can be shown to have reused rows rather than replaced them. */
const readIdentity = async (): Promise<StoredIdentity> => ({
    recipes: (await prisma.recipes.findMany({ orderBy: { slug: 'asc' } })).map((row) => ({
        id: row.id,
        slug: row.slug,
        current_version_id: row.current_version_id,
    })),
    versions: (await prisma.recipe_versions.findMany({ orderBy: { id: 'asc' } })).map((row) => row.id),
    ingredients: (await prisma.recipe_ingredients.findMany({ orderBy: { id: 'asc' } })).map((row) => row.id),
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
    committedReportModifiedAt = fs.statSync(COMMITTED_REPORT).mtimeMs;
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

    // `icon_key` is TEXT with no constraint behind it, and the mobile client
    // decodes an unrecognised key leniently into MealBowlIcon rather than
    // failing — so this stage is the only place a key outside the set is ever
    // caught, and what it stored is the fact that contract rests on.
    it('stores an icon key and badges inside the closed sets the client decodes against', async () => {
        const version = (await readRecipe('tofu-broccoli-bowl')).current_version;

        expect(version?.icon_key).toBe(FIXTURE_ICON_KEY);
        expect(RECIPE_ICON_KEYS as readonly string[]).toContain(version?.icon_key);
        expect(version?.badges.length).toBeGreaterThan(0);
        expect((version?.badges ?? []).filter((badge) => !(RECIPE_BADGES as readonly string[]).includes(badge))).toEqual(
            [],
        );
    });

    // The report's CONTENT — every cell of the diet x allergen x slot x
    // time-tier table and the §0.7.3 thresholds over it — is
    // src/__tests__/api/seed-rerun.test.ts's subject, against the real corpus.
    // What is wiring, and so belongs here, is where the file went.
    it('writes the coverage report to the injected path, and the committed artefact is untouched', () => {
        expect(outcome.reportPath).toBe(reportPath());
        expect(outcome.reportSkippedReason).toBeNull();
        expect(fs.existsSync(reportPath())).toBe(true);
        expect(outcome.report?.recipeCount).toBe(2);
        expect((JSON.parse(fs.readFileSync(reportPath(), 'utf8')) as { recipeCount: number }).recipeCount).toBe(2);
        expect(fs.statSync(COMMITTED_REPORT).mtimeMs).toBe(committedReportModifiedAt);
    });
});

describe('the catalog moving on under a published version', () => {
    beforeAll(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl()]);
        await runSeed(seedDeps());

        // Corrected nutrition, a renamed food and a re-reviewed allergen set,
        // all WITHOUT touching either version counter: the shape of a catalog
        // edit that has not yet been published as a new catalog version.
        await prisma.catalog_foods.update({
            where: { source_key: 'test:tofu-firm' },
            data: {
                calories: 999,
                protein_g: 1.1,
                carbs_g: 2.2,
                fat_g: 3.3,
                fiber_g: 4.4,
                display_name: 'Tofu, extra firm',
                allergen_tags: ['soy', 'sesame'],
                diet_tags: [],
            },
        });
    }, BLOCK_TIMEOUT_MS);

    // A version records what a plan was built from and what a diary entry
    // logged, so it is immutable: a plan generated last week must still read
    // back the numbers it was planned against, whatever the catalog says today.
    it('leaves the published snapshot exactly as it was taken', async () => {
        const version = (await readRecipe('tofu-broccoli-bowl')).current_version;
        const tofu = version?.recipe_ingredients.find((row) => row.sort_order === 0);

        expect(tofu?.snapshot_name).toBe('Tofu, firm');
        expect(tofu?.snapshot_per_100g).toEqual({
            calories: 144,
            protein_g: 17.3,
            carbs_g: 2.8,
            fat_g: 8.7,
            fiber_g: 2.3,
        });
        expect(tofu?.snapshot_allergen_tags).toEqual(['soy']);
        expect(tofu?.snapshot_diet_tags).toEqual([...PLANT_DIET_TAGS]);
        expect(version?.allergen_tags).toEqual(['soy']);
        expect(version?.diet_tags).toEqual([...PLANT_DIET_TAGS]);
    });

    it('still points the frozen row at the live catalog food', async () => {
        const version = (await readRecipe('tofu-broccoli-bowl')).current_version;
        const tofu = version?.recipe_ingredients.find((row) => row.sort_order === 0);
        const live = await prisma.catalog_foods.findUniqueOrThrow({ where: { source_key: 'test:tofu-firm' } });

        expect(tofu?.catalog_food_id).toBe(live.id);
        expect(live.display_name).toBe('Tofu, extra firm');
        expect(live.calories).toBe(999);
    });

    // Validation reads the LIVE catalog, not the snapshot, so the same file
    // that published cleanly is now inconsistent with the food it names: an
    // ingredient that has lost `vegan` and gained `sesame` makes the recipe's
    // declarations false. The refusal is the point — publishing the file's own
    // claims would ship a dish labelled vegan and sesame-free that is neither.
    it('refuses the next run, naming the live ingredient the declarations no longer match', async () => {
        const refusal = await refusalFrom(seedDeps({ now: () => PROMOTED_AT }));
        const reported = refusal.problems.join('\n');

        expect(refusal.code).toBe('recipes_invalid');
        expect(reported).toContain('tofu-broccoli-bowl (recipes/tofu-broccoli-bowl.json)');
        expect(reported).toContain('Tofu, extra firm');
        expect(reported).toContain('allergen_tags does not declare "sesame"');
        expect(reported).toContain('diet_tags declares "vegan"');

        // And the already-published version survives the refusal intact, which
        // is what keeps the plans and diary entries pointing at it readable.
        expect(await readCounts()).toEqual({
            recipes: 1,
            versions: 1,
            currentVersions: 1,
            retiredVersions: 0,
            ingredients: 3,
        });
    }, BLOCK_TIMEOUT_MS);
});

describe('a recipe whose ingredients share no diet claim', () => {
    let outcome: SeedOutcome;

    beforeAll(async () => {
        await resetCatalog();
        writeCorpus([breadedChicken()]);
        outcome = await runSeed(seedDeps());
    }, BLOCK_TIMEOUT_MS);

    // The chicken claims `gluten_free` and the flour claims the three plant
    // diets, so the intersection is empty. An empty list is the derivation's
    // ANSWER — "no diet claim holds for every part of this dish" — and not a
    // value that failed to arrive, so the declared-versus-derived gate has to
    // accept a file that declares it.
    it('publishes it with an empty diet_tags list and the unioned allergens', async () => {
        expect(outcome.created).toEqual(['breaded-chicken-bake']);

        const version = (await readRecipe('breaded-chicken-bake')).current_version;

        expect(version?.diet_tags).toEqual([]);
        expect(version?.allergen_tags).toEqual(['wheat']);
        expect(version?.allergen_status).toBe('known');
    });
});

describe('an identical rerun', () => {
    let first: SeedOutcome;
    let second: SeedOutcome;
    let firstIdentity: StoredIdentity;
    let secondIdentity: StoredIdentity;
    let firstReport: string;
    let secondReport: string;

    beforeAll(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl(), chickenPlate()]);

        first = await runSeed(seedDeps());
        firstReport = fs.readFileSync(reportPath(), 'utf8');
        firstIdentity = await readIdentity();

        second = await runSeed(seedDeps({ now: () => PROMOTED_AT }));
        secondReport = fs.readFileSync(reportPath(), 'utf8');
        secondIdentity = await readIdentity();
    }, BLOCK_TIMEOUT_MS);

    it('publishes nothing and reports every recipe unchanged', () => {
        expect(first.created).toHaveLength(2);
        expect(second.created).toEqual([]);
        expect(second.promoted).toEqual([]);
        expect(second.unchanged).toEqual(['chicken-broccoli-plate', 'tofu-broccoli-bowl']);
        expect(second.ingredientRows).toBe(0);
    });

    // Identity, not just counts. A rerun that deleted a version's ingredient
    // rows and recreated them — the reconciliation shape catalog-load.ts uses
    // legitimately for aliases and portions — would keep every count and every
    // version id while handing out six new `recipe_ingredients` ids, and a
    // count-only assertion would call that a no-op.
    it('leaves the same rows in place, by id, so no plan or diary reference is invalidated', async () => {
        expect(secondIdentity).toEqual(firstIdentity);
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

describe('a promotion that fails part-way through', () => {
    let published: StoredIdentity;

    beforeEach(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl()]);
        await runSeed(seedDeps());
        published = await readIdentity();
        writeCorpus([tofuBowl({ prepMinutes: 25 })]);
    }, BLOCK_TIMEOUT_MS);

    // "One transaction" is the claim §0.5.1 makes and the partial unique index
    // on (recipe_id) WHERE status = 'current' is only half of what enforces it:
    // the index stops a SECOND current row, and nothing but the transaction
    // stops a run that retired version 1 and then died from leaving the recipe
    // with NO current version at all — unplannable, and invisible until a user
    // opened their week.
    it.each([
        ['the previous version was retired', 'retire' as const],
        ['the new version was inserted', 'insert' as const],
    ])('rolls the whole promotion back when it fails after %s', async (_after: string, write) => {
        await expect(runSeed(seedDeps({ prisma: failingAfter(write), now: () => PROMOTED_AT }))).rejects.toThrow(
            InjectedPublishFailure,
        );

        expect(await readIdentity()).toEqual(published);
        expect(await readCounts()).toEqual({
            recipes: 1,
            versions: 1,
            currentVersions: 1,
            retiredVersions: 0,
            ingredients: 3,
        });

        const recipe = await readRecipe('tofu-broccoli-bowl');
        expect(recipe.current_version?.version).toBe(1);
        expect(recipe.current_version?.status).toBe('current');
        expect(recipe.current_version?.retired_at).toBeNull();
        expect(recipe.current_version?.total_minutes).toBe(15);
    }, BLOCK_TIMEOUT_MS);

    // A rollback has to leave the recipe publishable, not wedged: the retry
    // that follows a transient fault must produce ONE promotion, not a second
    // version 2 beside a half-written first attempt.
    it('publishes exactly one promotion once the fault is removed', async () => {
        await expect(runSeed(seedDeps({ prisma: failingAfter('insert'), now: () => PROMOTED_AT }))).rejects.toThrow(
            InjectedPublishFailure,
        );

        const outcome = await runSeed(seedDeps({ now: () => PROMOTED_AT }));

        expect(outcome.promoted).toEqual(['tofu-broccoli-bowl']);

        const recipe = await readRecipe('tofu-broccoli-bowl');
        expect(recipe.recipe_versions.map((version) => version.version)).toEqual([1, 2]);
        expect(recipe.recipe_versions.map((version) => version.status)).toEqual(['retired', 'current']);
        expect(recipe.current_version_id).toBe(recipe.recipe_versions[1].id);
    }, BLOCK_TIMEOUT_MS);
});

describe('a third change to the same recipe', () => {
    beforeAll(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl()]);
        await runSeed(seedDeps());
        writeCorpus([tofuBowl({ prepMinutes: 25 })]);
        await runSeed(seedDeps({ now: () => PROMOTED_AT }));
        writeCorpus([tofuBowl({ prepMinutes: 25, cookMinutes: 40 })]);
        await runSeed(seedDeps({ now: () => THIRD_PUBLISHED_AT }));
    }, BLOCK_TIMEOUT_MS);

    // The chain accumulates rather than being pruned: version 1 stays retired
    // beside version 2 because a plan built in week one and the diary entries
    // logged from it still reference it, and a version is never edited or
    // deleted to tidy the table.
    it('leaves versions 1 and 2 retired under version 3, each with its own timestamps', async () => {
        const versions = (await readRecipe('tofu-broccoli-bowl')).recipe_versions;

        expect(versions.map((version) => version.version)).toEqual([1, 2, 3]);
        expect(versions.map((version) => version.status)).toEqual(['retired', 'retired', 'current']);
        expect(versions.map((version) => version.published_at)).toEqual([
            PUBLISHED_AT,
            PROMOTED_AT,
            THIRD_PUBLISHED_AT,
        ]);
        expect(versions.map((version) => version.retired_at)).toEqual([PROMOTED_AT, THIRD_PUBLISHED_AT, null]);
        expect(versions.map((version) => version.total_minutes)).toEqual([15, 35, 65]);
    });

    it('keeps exactly one current version for the recipe, and its ingredient rows for every retired one', async () => {
        const recipe = await readRecipe('tofu-broccoli-bowl');
        const current = recipe.recipe_versions.filter((version) => version.status === 'current');

        expect(current).toHaveLength(1);
        expect(recipe.current_version_id).toBe(current[0].id);

        for (const version of recipe.recipe_versions) {
            expect(await prisma.recipe_ingredients.count({ where: { recipe_version_id: version.id } })).toBe(3);
        }
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

    // The gram weight every unit conversion and every grocery line is derived
    // from. A portion that exists and states zero is worse than a missing one,
    // because it divides rather than announcing itself.
    it('refuses a food whose default portion states no positive gram weight', async () => {
        await prisma.catalog_food_portions.updateMany({
            where: { catalog_foods: { source_key: 'test:canola-oil' } },
            data: { gram_weight: 0 },
        });
        writeCorpus([tofuBowl()]);

        const refusal = await refusalFrom(seedDeps());

        expect(refusal.code).toBe('recipes_invalid');
        expect(refusal.problems.join('\n')).toContain('test:canola-oil');
        expect(refusal.problems.join('\n')).toContain('gram_weight 0, which is not positive');
        expect(await prisma.recipes.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);

    // An estimate never enters planning, so a recipe built on one could never be
    // planned either — and its calories would be labelled as calculated from
    // source-backed ingredients when they are not.
    it.each([
        ['an AI estimate', 'test:peanut-sauce-estimated', 'peanut sauce', 'ai_estimated'],
        ['a figure derived from a composition', 'test:vegetable-broth-derived', 'vegetable broth', 'ingredient_derived'],
    ])('refuses %s, naming the provenance it states', async (_case, sourceKey, name, provenance) => {
        writeCorpus([
            buildPayload({
                slug: 'estimated-ingredient-bowl',
                mealSlots: ['lunch'],
                instructions: [`Stir the ${name} through the warm broccoli and serve.`],
                ingredientKeys: ['test:broccoli-raw', sourceKey],
            }),
        ]);

        const refusal = await refusalFrom(seedDeps());

        expect(refusal.code).toBe('recipes_invalid');
        expect(refusal.problems.join('\n')).toContain('estimated-ingredient-bowl');
        expect(refusal.problems.join('\n')).toContain(sourceKey);
        expect(refusal.problems.join('\n')).toContain(`nutrition_provenance is "${provenance}", not "source_backed"`);
        expect(await prisma.recipes.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);

    // Unreviewed is not the same as free of allergens: a food nobody has
    // reviewed cannot be certified safe for any user whatever they selected, so
    // an empty `allergen_tags` beside `allergen_status = 'unknown'` must refuse
    // rather than read as "contains nothing".
    it('refuses a food whose allergens have never been reviewed', async () => {
        writeCorpus([
            buildPayload({
                slug: 'blue-cheese-broccoli-bake',
                mealSlots: ['dinner'],
                instructions: ['Scatter the blue cheese over the broccoli and bake until bubbling.'],
                ingredientKeys: ['test:broccoli-raw', 'test:blue-cheese-unreviewed'],
            }),
        ]);

        const refusal = await refusalFrom(seedDeps());

        expect(refusal.code).toBe('recipes_invalid');
        expect(refusal.problems.join('\n')).toContain('test:blue-cheese-unreviewed');
        expect(refusal.problems.join('\n')).toContain('allergen_status is "unknown", not "known"');
        expect(await prisma.recipes.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);

    // How a food withdrawn by a later catalog release surfaces in this stage.
    // The asymmetry is the whole point, and it is why a release retires rather
    // than deletes: the retired row must keep backing the versions that already
    // reference it — `recipe_ingredients` → `catalog_foods` is RESTRICT, and a
    // historical plan and its diary entries read through those rows — while a
    // NEW version built on it would be unplannable from the moment it published.
    // catalog-load.test.ts owns retirement's effect on search and on the
    // foreign keys; this is the seed-time half.
    it('refuses a food a later release retired, while the versions already on it survive', async () => {
        const barleyBowl = (): Record<string, unknown> =>
            buildPayload({
                slug: 'barley-broccoli-bowl',
                mealSlots: ['lunch'],
                instructions: ['Simmer the barley, fold the broccoli through and serve.'],
                ingredientKeys: ['test:barley-retired', 'test:broccoli-raw'],
            });

        // Published while the food was still current...
        await prisma.catalog_foods.update({
            where: { source_key: 'test:barley-retired' },
            data: { publication_status: 'published' },
        });
        writeCorpus([barleyBowl()]);
        expect((await runSeed(seedDeps())).created).toEqual(['barley-broccoli-bowl']);

        // ...and the release that retires it does not reach back into that version.
        await prisma.catalog_foods.update({
            where: { source_key: 'test:barley-retired' },
            data: { publication_status: 'retired', metadata_version: 2 },
        });

        const refusal = await refusalFrom(seedDeps({ now: () => PROMOTED_AT }));

        expect(refusal.code).toBe('recipes_invalid');
        expect(refusal.problems.join('\n')).toContain('test:barley-retired');
        expect(refusal.problems.join('\n')).toContain('publication_status is "retired", not "published"');

        const recipe = await readRecipe('barley-broccoli-bowl');
        expect(recipe.current_version?.version).toBe(1);
        expect(recipe.current_version?.status).toBe('current');
        expect(recipe.current_version?.recipe_ingredients).toHaveLength(2);
    }, BLOCK_TIMEOUT_MS);
});

describe('a declaration outside a closed set', () => {
    beforeEach(async () => {
        await resetCatalog();
    }, BLOCK_TIMEOUT_MS);

    // The mobile client decodes an unrecognised `iconKey` leniently, and an
    // unrecognised badge code is dropped, precisely so a future server value
    // never breaks a whole response. That leniency is what makes strictness
    // HERE the only gate: a typo published by this stage would render as a
    // default bowl and a silently missing badge on every device, forever.
    it('refuses an icon key outside RECIPE_ICON_KEYS, naming the permitted values', async () => {
        writeCorpus([tofuBowl({ overrides: { iconKey: 'spatula' } })]);

        const refusal = await refusalFrom(seedDeps());

        // Exactly one problem: the only thing wrong with this file is the key,
        // which is what makes the refusal attributable to it.
        expect(refusal.code).toBe('recipes_invalid');
        expect(refusal.problems).toHaveLength(1);
        expect(refusal.problems[0]).toContain('tofu-broccoli-bowl (recipes/tofu-broccoli-bowl.json)');
        expect(refusal.problems[0]).toContain('icon_key "spatula" is not one of');
        for (const key of RECIPE_ICON_KEYS) {
            expect(refusal.problems[0]).toContain(key);
        }
        expect(await prisma.recipes.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);

    it('refuses a badge outside RECIPE_BADGES while accepting the earned ones beside it', async () => {
        // The derived badges plus one invented code, so the file disagrees with
        // the derivation in exactly one place.
        // Annotated, not inferred: the derivation's badge list must stay the
        // closed union, so a widening of it to `string[]` fails typecheck here
        // rather than reaching a device as a badge the client silently drops.
        const earned: readonly RecipeBadge[] = deriveRecipeVersionFields(
            ingredientRows(['test:tofu-firm', 'test:broccoli-raw', 'test:canola-oil']).map(publicationIngredient),
            2,
            5,
            10,
        ).badges;
        writeCorpus([tofuBowl({ overrides: { badges: [...earned, 'keto'] } })]);

        const refusal = await refusalFrom(seedDeps());

        expect(refusal.code).toBe('recipes_invalid');
        expect(refusal.problems).toHaveLength(1);
        expect(refusal.problems[0]).toContain('tofu-broccoli-bowl (recipes/tofu-broccoli-bowl.json)');
        expect(refusal.problems[0]).toContain('badges declares keto, which is not one of');
        for (const badge of RECIPE_BADGES) {
            expect(refusal.problems[0]).toContain(badge);
        }
        expect(await prisma.recipes.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);
});

describe('what a refusal reports', () => {
    let refusal: RecipeSeedError;
    let captured: CapturedLine[];

    beforeAll(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl(), chickenPlate({ overrides: { dietTags: ['vegan'] } })]);
        captured = [];
        refusal = await refusalFrom(seedDeps({ logger: capturingLogger(captured) }));
    }, BLOCK_TIMEOUT_MS);

    // An operator fixing the corpus wants every defect, not the first, so the
    // list travels on one error-level line as well as on the error.
    it('emits every defect once, at error level, on a line an operator can grep', () => {
        const rejected = captured.filter((entry) => entry.entry.event === 'recipes_rejected');

        expect(rejected).toHaveLength(1);
        expect(rejected[0].level).toBe('error');
        expect(rejected[0].entry.problemCount).toBe(refusal.problems.length);
        expect(rejected[0].entry.problems).toEqual([...refusal.problems]);
        expect(rejected[0].entry.stage).toBe('recipes-seed');
    });

    // §8: never the raw error object. `safeError` is the shape the stage reports
    // a failure in, and it carries exactly two members — a stack or a `cause`
    // chain reaching a log is how a connection string escapes.
    it('reduces the failure to a scrubbed name and message, with no stack', () => {
        expect(describeFailure(refusal)).toEqual({ code: 'recipes_invalid', error: safeError(refusal) });
        expect(Object.keys(safeError(refusal)).sort()).toEqual(['message', 'name']);
        expect(safeError(refusal).name).toBe('RecipeSeedError');

        for (const entry of captured) {
            expect(entry.line).not.toContain('"stack"');
        }
    });

    // The run that refused wrote nothing at all, which is what makes the
    // validate-everything-then-write order worth having: the valid file in the
    // same run stays unpublished rather than leaving a half-seeded corpus the
    // planner would answer from.
    it('leaves the database exactly as it found it', async () => {
        expect(await readCounts()).toEqual({
            recipes: 0,
            versions: 0,
            currentVersions: 0,
            retiredVersions: 0,
            ingredients: 0,
        });
        expect(captured.some((entry) => entry.entry.event === 'recipe_published')).toBe(false);
    });
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

    // `deriveDietTags` intersects its ingredients' tags, so a genuinely
    // disjoint pair — chicken and wheat flour share no diet — derives nothing.
    // Empty is that answer, not a missing declaration, and a parser that read
    // it as absent would refuse real recipes.
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

/* ---------------------------------------------------------------------------
 * The database this stage is allowed to write to
 * ------------------------------------------------------------------------- */

// WHAT IS THIS BLOCK'S AND WHAT IS NOT. The verdict function's generic
// mechanics under this policy — each refusal code, the accepted-logging shape —
// are `catalog-load.test.ts`'s, asserted there over `evaluateScriptDatabase`.
// What belongs here is the BINDING: `SCRIPT_DATABASE_POLICIES` is data, one
// entry per script, and the entry that governs THIS stage has to be the
// confirmed one and has to be in force through the callable the stage actually
// reaches at module load. A reviewer asking "is recipes-seed guarded?" is not
// answered by "catalog-load is".
describe('the database policy the stage runs under', () => {
    const SCRIPT = 'recipes-seed';

    // `process.env` is never written here. The guard takes `argv` and `env` as
    // arguments for exactly this reason, and mutating the real environment
    // would break the identity check jestSetup.ts made before this file loaded.
    const guard = (databaseUrl: string, argv: readonly string[] = [], logger?: ScriptLogger): void => {
        assertScriptDatabase({
            script: SCRIPT,
            argv: ['node', 'jest', ...argv],
            env: { DATABASE_URL: databaseUrl },
            logger,
        });
    };

    const refusalOf = (databaseUrl: string, argv: readonly string[] = []): DatabaseOriginError => {
        try {
            guard(databaseUrl, argv);
        } catch (error) {
            if (error instanceof DatabaseOriginError) {
                return error;
            }
            throw error;
        }
        throw new Error('the guard allowed a target the scenario requires it to refuse');
    };

    // Synthetic, and deliberately not the ambient DATABASE_URL: the guard is
    // being asked to classify a STRING, so a real credential would be a
    // committed secret for no gain. `fixture-only` is what the logging
    // assertion below looks for the absence of.
    const CREDENTIALS = 'seeduser:fixture-only';
    const DEVELOPMENT_URL = `postgresql://${CREDENTIALS}@127.0.0.1:5432/soh_dev`;
    const TEST_URL = `postgresql://${CREDENTIALS}@127.0.0.1:5432/soh_test`;
    const REMOTE_URL = `postgresql://${CREDENTIALS}@db.internal.example.com:5432/soh_production`;

    it('is development_or_confirmed, because the stage writes shared catalog-derived rows', () => {
        expect(SCRIPT_DATABASE_POLICIES[SCRIPT]).toBe('development_or_confirmed');
    });

    it('allows a development origin with no flag at all', () => {
        expect(() => guard(DEVELOPMENT_URL)).not.toThrow();
        expect(classifyDatabaseOrigin(DEVELOPMENT_URL).originClass).toBe('development');
    });

    it('refuses a recognised non-development origin until the operator names it', () => {
        const refusal = refusalOf(TEST_URL);

        expect(refusal.code).toBe('confirmation_required');
        expect(refusal.origin).toMatchObject({
            originClass: 'test',
            host: '127.0.0.1',
            database: 'soh_test',
        });
        // The remedy is in the message, with the name to type.
        expect(refusal.message).toContain('--confirm-target soh_test');
    });

    it('refuses a flag that names a different database than the URL points at', () => {
        // The operator typed the development database's name while the URL
        // pointed at the test one — the near miss the flag exists to catch.
        const refusal = refusalOf(TEST_URL, ['--confirm-target', 'soh_dev']);

        expect(refusal.code).toBe('confirmation_mismatch');
        expect(refusal.message).toContain('soh_dev');
        expect(refusal.message).toContain('soh_test');
    });

    it('allows the same origin once the flag names it exactly', () => {
        expect(() => guard(TEST_URL, ['--confirm-target', 'soh_test'])).not.toThrow();
        expect(() => guard(TEST_URL, ['--confirm-target=soh_test'])).not.toThrow();
    });

    // There is no door for an origin the guard cannot classify: the flag
    // confirms WHICH recognised database, never that an unknown one is safe.
    it('refuses an unrecognised origin even when the flag names it correctly', () => {
        const refusal = refusalOf(REMOTE_URL, ['--confirm-target', 'soh_production']);

        expect(refusal.code).toBe('unrecognised_origin');
        expect(refusal.origin.originClass).toBe('unknown');
    });

    it('reports the classification it accepted and never the connection string', () => {
        const captured: CapturedLine[] = [];

        guard(TEST_URL, ['--confirm-target', 'soh_test'], capturingLogger(captured));

        const accepted = captured.filter((entry) => entry.entry.event === 'database_origin_accepted');
        expect(accepted).toHaveLength(1);
        expect(accepted[0].entry).toMatchObject({
            script: SCRIPT,
            policy: 'development_or_confirmed',
            originClass: 'test',
            host: '127.0.0.1',
            database: 'soh_test',
        });

        // The classification, never the URL it came from: the scheme, the user
        // and the password are each absent from every line the guard emitted.
        for (const entry of captured) {
            expect(entry.line).not.toContain('postgresql://');
            expect(entry.line).not.toContain('seeduser');
            expect(entry.line).not.toContain('fixture-only');
        }
    });

    it('is reached through the injected argv because the module-load guard no-ops under Jest', () => {
        // dbGuard enforces at import time keyed on `entryScriptName(process.argv)`,
        // and under Jest argv[1] is the jest binary — which is deliberate and
        // load-bearing: importing a script for its `run*(deps)` entry point must
        // never end a test run. The out-of-process proof of the guard that DOES
        // protect this suite belongs to src/__tests__/setup/testDb.test.ts.
        expect(entryScriptName(process.argv)).toBeNull();
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
