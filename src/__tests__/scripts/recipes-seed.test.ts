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
 * HOW THE COVERAGE REPORT IS SPLIT BETWEEN THIS SUITE AND THE API ONE. The
 * table's own invariants are `deriveCoverageReport`'s, so they are pinned HERE,
 * as pure tests over hand-written recipes with no database: the dimension
 * lists, one cell per combination of them (640), the 140 guaranteed and 124
 * reduced cells §0.7.3 CLAIMS with their thresholds and their disjointness, the
 * four slot-composition strata and their floors, and the artefact's
 * self-describing members.
 *
 * AND THE FEASIBILITY GATE, which is the half a count cannot express. A cell is
 * certified only when a day the planner would accept EXISTS for it at every
 * sampled calorie target on every schedule its slot belongs to, and when enough
 * distinct recipes are USABLE in such a day to fill a week; a claimed cell that
 * fails is demoted to `eligibleNotPlannableCells` with the reason. Its own
 * block below states each outcome over a fixture built for it: a plannable
 * corpus that certifies, a corpus of four eligible-but-oversized recipes per
 * slot that cannot compose a day at all, a corpus where a day exists but only
 * one recipe per slot can appear in one, and an evaluation budget lowered far
 * enough to prove that an exhausted search reports itself as exhausted rather
 * than as a thin corpus. Those are properties of the derivation and are
 * unreachable from counts, which is why counting alone once certified a vegan
 * profile no vegan user could plan.
 *
 * What this suite cannot settle is whether the REAL 42-recipe corpus
 * against the REAL release satisfies those cells and reproduces the committed
 * `data/meal-planning/recipes/coverage-report.json` byte for byte — that is
 * `src/__tests__/api/seed-rerun.test.ts`'s subject, and it is an acceptance
 * check over real data rather than a property of the derivation. What this
 * suite keeps of the report beyond the pure block is the WIRING: that it was
 * written to the injected path, that the committed artefact was left alone, and
 * that a narrowed or dry run writes none. Recipe nutrition, badge derivation,
 * provenance rollup and `isEligibleForPlanning` are pure functions owned by
 * `src/services/__tests__/recipe.logic.test.ts`.
 *
 * WHAT ELSE IT SETTLES ABOUT CONCURRENCY AND RECOVERY. The stage publishes one
 * transaction per recipe against a catalog another stage can rewrite, so two
 * blocks below cover what that costs: the catalog hold (a shared graph lock for
 * the whole run, the per-publication re-read that refuses a drifted ingredient,
 * and the refusal when another stage owns the graph) and the run ledger (a
 * succeeded run with its fingerprint, watermark and counts; a failed one at the
 * watermark an interruption reached; a killed run refused while its lease is
 * live and resumed once it lapses).
 *
 * WHY IT DRIVES `runSeed(deps)` RATHER THAN THE COMMAND. The stage's own
 * `main()` reads `process.argv`, classifies the ambient `DATABASE_URL` and calls
 * `process.exit`, none of which a test may do. `runSeed` takes everything it
 * touches as an injected dependency for exactly this reason — `SeedDeps` in
 * `scripts/recipes-seed.ts` is the authority on the full set — and every
 * scenario here runs the production code path with only those seams replaced.
 * The ones that shape the scenarios below are the temporary recipe directory,
 * the pinned clock, the coverage report's path and writer, the separable run
 * LEDGER client (`runDb`, so a scenario can fault the publication client
 * without destroying the row that records the failure), and the two lock holds
 * (`runUnderCatalogLock`, `runUnderWriterLock`), which are seams because a
 * shared hold and a ZOMBIE session are otherwise unreachable from a test. The
 * argument parser, the preflight check and the pure helpers are covered
 * directly, as pure functions.
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
import {
    CATALOG_STAGE_LOCK_MODES,
    catalogStageLockMode,
    CheckpointError,
} from '../../../scripts/lib/checkpoint';
import type { CatalogRunKind, CatalogStageName } from '../../../scripts/lib/checkpoint';
import {
    UNEXPECTED_FAILURE_REMEDY,
    classifyInfrastructureFailure,
    createLogger,
    safeError,
} from '../../../scripts/lib/logger';
import { loadCoveragePlan, ManifestError, recipesDir, writeJsonFile } from '../../../scripts/lib/manifest';
import type { CoveragePlan } from '../../../scripts/lib/manifest';
import type { LogLevel, ScriptLogger } from '../../../scripts/lib/logger';
import {
    buildIngredientVocabulary,
    CATALOG_READER_STAGE,
    feasibilityWindow,
    CATALOG_READER_STAGE_MODE,
    describeFailure,
    deriveCoverageReport,
    equivalentContent,
    findUnlistedInstructionTerms,
    foldPluralToken,
    isRecipeFileName,
    normalizeVocabularyText,
    parseArgs,
    parseRecipePayload,
    preflight,
    RECIPE_SEED_RUN_KIND,
    RECIPE_SEED_RUN_LEASE_MS,
    RecipeSeedError,
    runSeed,
    sameStoredNumber,
} from '../../../scripts/recipes-seed';
import type {
    CoverageRecipe,
    CoverageReport,
    RecipeSeedCursor,
    SeedDb,
    SeedDeps,
    SeedOutcome,
    SeedPreflightDeps,
} from '../../../scripts/recipes-seed';
import { prisma } from '../../prisma/client';
import { evaluateDayTolerance } from '../../services/mealPlan.logic';
import { deriveRecipeVersionFields } from '../../services/recipe.logic';
import { deriveMacroTargets } from '../../services/targets.logic';
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

/** Replaces the corpus in `directory` with exactly these payloads. */
const writeCorpusInto = (directory: string, payloads: readonly Record<string, unknown>[]): void => {
    for (const entry of fs.readdirSync(directory)) {
        fs.rmSync(path.join(directory, entry));
    }
    for (const payload of payloads) {
        fs.writeFileSync(
            path.join(directory, `${payload.slug as string}.json`),
            `${JSON.stringify(payload, null, 2)}\n`,
            'utf8',
        );
    }
};

/** Replaces the temporary corpus with exactly these payloads. */
const writeCorpus = (payloads: readonly Record<string, unknown>[]): void => {
    writeCorpusInto(recipesDirectory, payloads);
};

const seedDeps = (overrides: Partial<SeedDeps> = {}): SeedDeps => ({
    prisma: prisma as unknown as SeedDb,
    // The REAL client, always, even in the scenarios that fault `prisma`: the
    // ledger row is what records that a faulted run failed, so a suite that
    // faulted it too would destroy the evidence it is asserting. Production
    // passes the same singleton for both (see `main`), and the one scenario that
    // omits it deliberately is the probe refusal below.
    runDb: prisma,
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
        // Forwarded, not stubbed: the publication re-reads and locks its
        // ingredient rows through this seam inside the very transaction the
        // fault interrupts, so a wrapper that dropped it would fail the run
        // before reaching the write under test.
        $queryRaw<TRows>(query: TemplateStringsArray, ...values: unknown[]): Promise<TRows> {
            return tx.$queryRaw<TRows>(query, ...values);
        },
        $transaction<T>(work: (inner: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T> {
            return tx.$transaction(work, options);
        },
    });

    return {
        catalog_foods: real.catalog_foods,
        recipes: real.recipes,
        recipe_versions: real.recipe_versions,
        $queryRaw<TRows>(query: TemplateStringsArray, ...values: unknown[]): Promise<TRows> {
            return real.$queryRaw<TRows>(query, ...values);
        },
        $transaction<T>(work: (tx: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T> {
            return real.$transaction((tx) => work(wrapTx(tx)), options);
        },
    };
};

/**
 * The real client with the Nth publication transaction refused outright.
 *
 * Unlike `failingAfter`, which faults one write INSIDE a transaction, this
 * refuses the whole transaction — the recipes before it are committed and the
 * ones after it are never attempted, which is what an interruption part-way
 * through the corpus looks like. `runSeed` opens exactly one transaction per
 * recipe and none of its own, so the counter is a count of publications.
 */
const failingOnPublication = (nth: number): SeedDb => {
    const real = prisma as unknown as SeedDb;
    let publications = 0;

    return {
        catalog_foods: real.catalog_foods,
        recipes: real.recipes,
        recipe_versions: real.recipe_versions,
        $queryRaw<TRows>(query: TemplateStringsArray, ...values: unknown[]): Promise<TRows> {
            return real.$queryRaw<TRows>(query, ...values);
        },
        $transaction<T>(work: (tx: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T> {
            publications += 1;
            return publications === nth
                ? Promise.reject(new InjectedPublishFailure(`publication ${nth} of the corpus`))
                : real.$transaction(work, options);
        },
    };
};

/**
 * The real client with a catalog change committed just before the first
 * publication transaction opens.
 *
 * This is the concurrency the per-publication re-read exists for, in the one
 * form a single-process test can produce it: the validation pass read the
 * catalog, and by the time the first recipe is written a catalog stage has
 * moved a row underneath it. The mutation runs through the real client and
 * commits, so the publication's own re-read sees exactly what a concurrent
 * `catalog-load` would have left.
 */
const mutatingCatalogBeforeFirstPublication = (mutate: () => Promise<void>): SeedDb => {
    const real = prisma as unknown as SeedDb;
    let mutated = false;

    return {
        catalog_foods: real.catalog_foods,
        recipes: real.recipes,
        recipe_versions: real.recipe_versions,
        $queryRaw<TRows>(query: TemplateStringsArray, ...values: unknown[]): Promise<TRows> {
            return real.$queryRaw<TRows>(query, ...values);
        },
        async $transaction<T>(work: (tx: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T> {
            if (!mutated) {
                mutated = true;
                await mutate();
            }
            return real.$transaction(work, options);
        },
    };
};

/** What was held, on each of the stage's two session locks, at one observation point. */
interface ObservedHolds {
    /** Modes on lib/checkpoint.ts's catalog-graph stage lock. */
    readonly graph: readonly string[];
    /** Modes on `recipes-seed.ts`'s own recipe-seed writer lock. */
    readonly writer: readonly string[];
}

/**
 * The real client that reports which locks were held when the stage took its
 * FIRST catalog read — the read every publication's facts come from.
 *
 * Both classes are captured at the same instant because the two holds are only
 * meaningful together: the graph hold must be SHARED (this stage reads the
 * catalog) and the writer hold must be EXCLUSIVE (this stage writes the recipe
 * tables), and a reading that could not tell them apart would let either one
 * disappear unnoticed.
 */
const observingFirstCatalogRead = (observed: ObservedHolds[]): SeedDb => {
    const real = prisma as unknown as SeedDb;

    return {
        catalog_foods: {
            async findMany<Row>(args: unknown): Promise<Row[]> {
                if (observed.length === 0) {
                    observed.push({ graph: await heldGraphLockModes(), writer: await heldWriterLockModes() });
                }
                return real.catalog_foods.findMany<Row>(args);
            },
        },
        recipes: real.recipes,
        recipe_versions: real.recipe_versions,
        $queryRaw<TRows>(query: TemplateStringsArray, ...values: unknown[]): Promise<TRows> {
            return real.$queryRaw<TRows>(query, ...values);
        },
        $transaction<T>(work: (tx: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T> {
            return real.$transaction(work, options);
        },
    };
};

/**
 * The advisory class ids the two session locks this stage takes live under.
 *
 * Two-integer advisory keys report their class in `pg_locks.classid` and are
 * identified as that keyspace by `objsubid = 2`; the one-argument form
 * (`objsubid = 1`) is where the request path's per-user lock and this stage's
 * run-claim lock live, so neither can appear in either reading below.
 *
 * The two classes are DISTINCT ON PURPOSE and the assertions depend on telling
 * them apart: `0x434154` ('CAT') is lib/checkpoint.ts's catalog-graph stage lock,
 * which this stage holds SHARED for the whole run, while `0x525344` ('RSD') is
 * `recipes-seed.ts`'s own recipe-seed writer lock, which it holds EXCLUSIVELY
 * over the same window. A single query over the whole keyspace would return both
 * and could not say which mode belonged to which question.
 */
const CATALOG_GRAPH_LOCK_CLASS_ID = 0x434154;
const RECIPE_SEED_WRITER_LOCK_CLASS_ID = 0x525344;

/**
 * Advisory locks granted on THIS database under one two-integer class id.
 *
 * The database is pinned because `pg_locks` is cluster-wide and sibling
 * databases hold locks of their own.
 */
const heldAdvisoryModes = async (classId: number): Promise<string[]> => {
    const rows = await prisma.$queryRaw<{ mode: string }[]>`
        SELECT mode FROM pg_locks
        WHERE locktype = 'advisory'
          AND objsubid = 2
          AND classid = ${classId}
          AND granted
          AND database = (SELECT oid FROM pg_database WHERE datname = current_database())
        ORDER BY mode
    `;

    return rows.map((row) => row.mode);
};

/** The modes held on lib/checkpoint.ts's catalog-graph stage lock. */
const heldGraphLockModes = (): Promise<string[]> => heldAdvisoryModes(CATALOG_GRAPH_LOCK_CLASS_ID);

/** The modes held on this stage's own recipe-seed writer lock. */
const heldWriterLockModes = (): Promise<string[]> => heldAdvisoryModes(RECIPE_SEED_WRITER_LOCK_CLASS_ID);

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

/** The refusal a started `runSeed` threw, as a `RecipeSeedError`, or a failure naming what it threw instead. */
const refusalOf = async (run: Promise<SeedOutcome>): Promise<RecipeSeedError> => {
    try {
        await run;
    } catch (error) {
        if (error instanceof RecipeSeedError) {
            return error;
        }
        throw error;
    }

    throw new Error('runSeed resolved where the scenario requires it to refuse');
};

/** The refusal `runSeed` threw, as a `RecipeSeedError`, or a failure naming what it threw instead. */
const refusalFrom = (deps: SeedDeps): Promise<RecipeSeedError> => refusalOf(runSeed(deps));

/* ---------------------------------------------------------------------------
 * Orchestrating two writers
 *
 * Every contention scenario below is settled by a HANDSHAKE and never by a
 * sleep: one side signals that it has reached the state under test, and the
 * other only acts then. A wall-clock wait would make the outcome depend on the
 * runner's scheduling, which is the one thing a concurrency test must not do.
 * The only timeout in this section is a hang guard — it exists so a scenario
 * that never reaches its rendezvous fails with its own message instead of the
 * suite's, and it is never what an assertion reads.
 * ------------------------------------------------------------------------- */

/** A one-shot handshake. `signal()` is idempotent: resolving a promise twice is a no-op. */
interface Rendezvous {
    readonly reached: Promise<void>;
    readonly signal: () => void;
}

const rendezvous = (): Rendezvous => {
    let signal: () => void = () => undefined;
    const reached = new Promise<void>((resolve) => {
        signal = resolve;
    });

    return { reached, signal };
};

/** Generous, because it is a hang guard and not a timing assumption. */
const RENDEZVOUS_TIMEOUT_MS = 60_000;

/** Awaits a rendezvous, failing with a named error rather than hanging the block. */
const arriveAt = async (reached: Promise<void>, what: string): Promise<void> => {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const guard = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
            () => reject(new Error(`timed out after ${RENDEZVOUS_TIMEOUT_MS} ms waiting for ${what}`)),
            RENDEZVOUS_TIMEOUT_MS,
        );
    });

    try {
        await Promise.race([reached, guard]);
    } finally {
        if (timer !== undefined) {
            clearTimeout(timer);
        }
    }
};

/**
 * A `runUnderCatalogLock` seam that parks the stage the instant it is inside the
 * WRITER hold.
 *
 * It works as a proof of that because of the order `runSeed` composes the two:
 * the writer lock is acquired, and only then is this seam called. So a signal
 * from here is evidence the exclusive hold is live, with no polling and no
 * assumption. The graph hold is the thing given up by injecting here, and it is
 * the right one to give up: it is SHARED, so it is irrelevant to whether a
 * second seed is refused.
 */
const parkedInsideTheWriterHold =
    (entered: Rendezvous, release: Rendezvous) =>
    async <T>(work: () => Promise<T>): Promise<T> => {
        entered.signal();
        await release.reached;
        return work();
    };

/** What the contender got, and what was true of the database while it was refused. */
interface Contention {
    readonly refusal: RecipeSeedError;
    readonly holding: SeedOutcome;
    /** Modes observed on this stage's own advisory class while the holder held it. */
    readonly writerModesWhileHeld: readonly string[];
    readonly runRowsWhileHeld: number;
    readonly recipesWhileHeld: number;
}

/**
 * Parks one writer inside the writer hold, runs a second against it, and reports
 * what the second one got.
 *
 * The holder is released only after the contender has settled, so there is no
 * interleaving in which the contender could have arrived before the lock was
 * taken or after it was dropped.
 */
const refusedWhileAnotherWriterHolds = async (
    holderOverrides: Partial<SeedDeps>,
    contenderOverrides: Partial<SeedDeps>,
): Promise<Contention> => {
    const entered = rendezvous();
    const release = rendezvous();

    const holder = runSeed(
        seedDeps({ ...holderOverrides, runUnderCatalogLock: parkedInsideTheWriterHold(entered, release) }),
    );

    try {
        await arriveAt(entered.reached, 'the holding writer to take the recipe-seed writer lock');

        const writerModesWhileHeld = await heldWriterLockModes();
        const runRowsWhileHeld = await prisma.catalog_import_runs.count();
        const recipesWhileHeld = await prisma.recipes.count();
        const refusal = await refusalFrom(seedDeps(contenderOverrides));

        release.signal();

        return { refusal, holding: await holder, writerModesWhileHeld, runRowsWhileHeld, recipesWhileHeld };
    } catch (error) {
        // The holder is parked on a promise nothing else will resolve, so it is
        // released and awaited even on the failing path — a left-behind writer
        // would hold the lock into the next test.
        release.signal();
        await holder.catch(() => undefined);
        throw error;
    }
};

/** Where in the publication loop a paused client stops. */
type PublicationPausePoint = 'before' | 'after';

interface PausedPublications {
    readonly db: SeedDb;
    /** Resolves when the chosen boundary of the Nth publication is reached. */
    readonly reached: Promise<void>;
    readonly resume: () => void;
    /** How many publication transactions this client has been asked to open. */
    readonly attempted: () => number;
}

/**
 * The real client, parked at a publication boundary.
 *
 * `before` parks just before the Nth publication transaction opens — which is
 * after the (N-1)th cursor write — so the parked run's next act is a
 * PUBLICATION. `after` parks the moment the Nth transaction has COMMITTED and
 * before the loop's cursor write, so its next act is a CURSOR WRITE. Those are
 * two of the writes the attempt fence has to refuse independently, and one pause
 * point could only ever exercise one of them.
 *
 * `runSeed` opens exactly one transaction per recipe through this seam and none
 * of its own — the ledger's transactions go through `runDb`, which is the real
 * client — so the counter is a count of publications, the same property
 * `failingOnPublication` relies on.
 */
const pausingAtPublication = (nth: number, when: PublicationPausePoint): PausedPublications => {
    const real = prisma as unknown as SeedDb;
    const at = rendezvous();
    const go = rendezvous();
    let publications = 0;

    return {
        reached: at.reached,
        resume: go.signal,
        attempted: () => publications,
        db: {
            catalog_foods: real.catalog_foods,
            recipes: real.recipes,
            recipe_versions: real.recipe_versions,
            $queryRaw<TRows>(query: TemplateStringsArray, ...values: unknown[]): Promise<TRows> {
                return real.$queryRaw<TRows>(query, ...values);
            },
            async $transaction<T>(work: (tx: SeedDb) => Promise<T>, options?: { timeout?: number }): Promise<T> {
                publications += 1;
                const thisOne = publications;

                if (thisOne === nth && when === 'before') {
                    at.signal();
                    await go.reached;
                }

                const result = await real.$transaction(work, options);

                if (thisOne === nth && when === 'after') {
                    at.signal();
                    await go.reached;
                }

                return result;
            },
        },
    };
};

/** Everything both attempts did in a takeover, plus the ledger state between them. */
interface Supersession {
    readonly zombieRefusal: RecipeSeedError;
    /** Every event the superseded attempt's logger recorded, in order. */
    readonly zombieEvents: readonly string[];
    /** How many publication transactions the superseded attempt opened. */
    readonly zombiePublications: number;
    /**
     * The run row as it stood the instant AFTER the superseded attempt failed
     * and BEFORE the new attempt finished — the only window in which "the
     * zombie's close was refused" is observable rather than inferred.
     */
    readonly runWhileTakenOver: { readonly status: string; readonly cursorAttempt: number };
    readonly takeover: SeedOutcome;
}

/**
 * The zombie scenario: a superseded attempt resuming after its run was taken
 * over, and being refused at the write it resumes into.
 *
 * WHAT MAKES A ZOMBIE, AND WHY IT NEEDS A SEAM. The writer lock is
 * session-scoped, so a process that dies releases it — which is exactly why no
 * LIVE second writer can exist. The case that leaves is a process whose LOCK
 * SESSION died while the process itself kept a working connection pool, and no
 * test can produce that by killing something: killing the process takes the pool
 * with it. A pass-through `runUnderWriterLock` IS that process, and it is the
 * only honest way to reach the state the fence exists for.
 *
 * WHY THE SUCCESSOR IS ALSO PARKED. It is parked immediately after its claim and
 * before its first publication, so when the zombie resumes the row is still
 * `running` under a ROTATED TOKEN. That is the one state in which the token
 * comparison itself is what refuses the zombie — had the successor been allowed
 * to finish first, the closed-status check would have refused it and the token
 * would never have been compared.
 */
const zombieResumesAfterTakeover = async (zombiePause: {
    readonly nth: number;
    readonly when: PublicationPausePoint;
}): Promise<Supersession> => {
    const zombie = pausingAtPublication(zombiePause.nth, zombiePause.when);
    const zombieLog: { event: string; fields?: Record<string, unknown> }[] = [];
    const zombieRun = runSeed(
        seedDeps({
            prisma: zombie.db,
            logger: recordingLogger(zombieLog),
            runUnderWriterLock: <T>(work: () => Promise<T>): Promise<T> => work(),
        }),
    );

    try {
        await arriveAt(
            zombie.reached,
            `the superseded attempt to park ${zombiePause.when} publication ${zombiePause.nth}`,
        );

        const successor = pausingAtPublication(1, 'before');
        const successorRun = runSeed(seedDeps({ prisma: successor.db, now: () => PROMOTED_AT }));

        try {
            await arriveAt(successor.reached, 'the new attempt to take the run over');

            zombie.resume();

            const zombieRefusal = await refusalOf(zombieRun);
            const taken = await prisma.catalog_import_runs.findFirstOrThrow({
                where: { kind: RECIPE_SEED_RUN_KIND },
                orderBy: { started_at: 'asc' },
            });

            successor.resume();

            return {
                zombieRefusal,
                zombieEvents: zombieLog.map((entry) => entry.event),
                zombiePublications: zombie.attempted(),
                runWhileTakenOver: {
                    status: taken.status,
                    cursorAttempt: (taken.cursor as unknown as RecipeSeedCursor).attempt,
                },
                takeover: await successorRun,
            };
        } catch (error) {
            successor.resume();
            await successorRun.catch(() => undefined);
            throw error;
        }
    } catch (error) {
        zombie.resume();
        await zombieRun.catch(() => undefined);
        throw error;
    }
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

    // WHERE THE REPORT'S CLAIMS LIVE, since two suites hold different halves of
    // them. The exact TABLE INVARIANTS — the dimension lists, the 640 cells, the
    // 140 guaranteed and 124 reduced cells with their thresholds and their
    // disjointness, the four composition strata and their §0.7.3 floors — are
    // pinned in this file, over plain objects, by the `deriveCoverageReport`
    // block in the pure surface below: they are properties of the derivation and
    // need no database. `src/__tests__/api/seed-rerun.test.ts` holds the
    // complementary claim, which this suite cannot make: that the REAL
    // 42-recipe corpus against the REAL release satisfies those cells and
    // reproduces the committed artefact byte for byte. What belongs HERE, in
    // this block, is the wiring: where the file went, and that the committed one
    // was left alone.
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
    // a failure in, and it carries a CLOSED set of machine-readable members —
    // the class name and the code it declares. Neither the message nor a stack
    // nor a `cause` chain travels through THAT field, because each of those is
    // how a connection string or a fragment of a foreign document escapes into
    // a log.
    it('reduces the failure itself to a scrubbed name and its code, with no message or stack', () => {
        expect(describeFailure(refusal).error).toEqual(safeError(refusal));
        expect(Object.keys(safeError(refusal)).sort()).toEqual(['code', 'name']);
        expect(safeError(refusal).name).toBe('RecipeSeedError');
        expect(safeError(refusal)).not.toHaveProperty('message');

        for (const entry of captured) {
            expect(entry.line).not.toContain('"stack"');
        }
    });

    // …and the sentence the stage COMPOSED travels beside it, under a member
    // named for its provenance.
    //
    // This is the half the closed field set above cannot carry and the half an
    // operator acts on: §0.7.3 requires the seed to fail loudly "with the
    // offending recipe and ingredient", and a `recipes_invalid` code names
    // neither. `recipes_rejected` above carries the same defects as a list, but
    // that line is only written on the path that reaches the validation pass —
    // the fatal reporter in `main` is what an operator sees when a refusal ends
    // the process, and it used to print the code alone.
    it('carries its own rendered sentence and the defect count beside the code', () => {
        const described = describeFailure(refusal);
        const forwarded = String(described.detail?.firstPartyMessage);

        expect(described.code).toBe('recipes_invalid');
        expect(described.detail?.problemCount).toBe(refusal.problems.length);
        expect(forwarded).toContain('nothing was published');
        // Every defect, and each one still naming the file it is in: the list
        // the class rendered into its message is the list the operator fixes.
        for (const problem of refusal.problems) {
            expect(forwarded).toContain(problem);
        }
        expect(forwarded).toContain('recipes/chicken-broccoli-plate.json');
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

describe('the stage label this seed borrows for its catalog hold', () => {
    /**
     * The stage's header (THE BORROWED READER STAGE) justifies taking the graph
     * lock under an EXISTING label rather than adding one of its own, and it
     * states the shape of `CATALOG_STAGE_LOCK_MODES` to do so: four mutating run
     * kinds exclusive, and exactly two read-only labels — `release`, the export, and
     * `benchmark`, the search-acceptance measurement — both shared. That is a
     * claim about scripts/lib/checkpoint.ts, which this file does not own, so it
     * is asserted here against the table itself: a reader label added, removed
     * or re-moded there fails these three cases rather than silently leaving the
     * rationale describing a table that no longer exists.
     */
    const mutatingStages: readonly CatalogRunKind[] = ['usda_import', 'ai_generation', 'validation', 'release_load'];

    const readerLabels = (): readonly CatalogStageName[] =>
        (Object.keys(CATALOG_STAGE_LOCK_MODES) as readonly CatalogStageName[]).filter(
            (stage) => !(mutatingStages as readonly string[]).includes(stage),
        );

    it('leaves exactly two read-only labels in the table, and both take the lock shared', () => {
        expect([...readerLabels()].sort()).toEqual(['benchmark', 'release']);
        expect(readerLabels().map((stage) => CATALOG_STAGE_LOCK_MODES[stage])).toEqual(['shared', 'shared']);
    });

    it('keeps every mutating run kind exclusive, which is what a shared hold is refused by', () => {
        expect(mutatingStages.map((stage) => CATALOG_STAGE_LOCK_MODES[stage])).toEqual([
            'exclusive',
            'exclusive',
            'exclusive',
            'exclusive',
        ]);
    });

    it('borrows `release` from those two, so the mode this stage passes is the shared one', () => {
        expect(CATALOG_READER_STAGE).toBe('release');
        expect(readerLabels()).toContain(CATALOG_READER_STAGE);
        // Both halves: the constant this stage passes to withCatalogStageLock,
        // and what checkpoint.ts itself resolves that label to — so the hold
        // stays shared whether the table is consulted or the mode is passed.
        expect(CATALOG_READER_STAGE_MODE).toBe('shared');
        expect(catalogStageLockMode(CATALOG_READER_STAGE)).toBe(CATALOG_READER_STAGE_MODE);
    });
});

describe('the catalog hold the run publishes under', () => {
    /**
     * §0.7.3 lets a `current` recipe version exist only on ingredients that are
     * published, source-backed and allergen-known at the version it cites. The
     * facts behind that are read once, for the whole corpus, before the first
     * publication — so the stage holds the catalog graph's stage lock SHARED for
     * the whole run, and every publication re-reads and locks its own
     * ingredients inside its transaction. This block settles both halves plus the
     * refusal, because either half alone leaves a window.
     */
    beforeEach(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl(), chickenPlate()]);
        fs.rmSync(reportPath(), { force: true });
    }, BLOCK_TIMEOUT_MS);

    it('holds the graph lock shared and its own writer lock exclusively, and releases both', async () => {
        const observed: ObservedHolds[] = [];

        // NO lock seam injected on either hold: these are the production locks,
        // each taken on its own dedicated connection — the graph hold by
        // lib/checkpoint.ts and the writer hold by `recipes-seed.ts` itself —
        // and both are observed from pg_locks through a third.
        await runSeed(seedDeps({ prisma: observingFirstCatalogRead(observed) }));

        expect(observed).toHaveLength(1);
        expect(observed[0].graph).toContain('ShareLock');
        expect(observed[0].graph).not.toContain('ExclusiveLock');
        // EXCLUSIVE, and on a different advisory class: the graph hold is shared
        // and therefore compatible with itself, so it is not and cannot be what
        // keeps a second seed out (see the stage's ONE RECIPE-SEED WRITER).
        expect(observed[0].writer).toEqual(['ExclusiveLock']);

        expect(await heldGraphLockModes()).toEqual([]);
        expect(await heldWriterLockModes()).toEqual([]);
    }, BLOCK_TIMEOUT_MS);

    it('wraps the whole stage in the hold, from before the first read to after the report', async () => {
        const atEntry: { recipes: number; report: boolean } = { recipes: -1, report: true };
        const atExit: { recipes: number; report: boolean } = { recipes: -1, report: false };
        let held = 0;

        await runSeed(
            seedDeps({
                runUnderCatalogLock: async <T>(work: () => Promise<T>): Promise<T> => {
                    held += 1;
                    atEntry.recipes = await prisma.recipes.count();
                    atEntry.report = fs.existsSync(reportPath());
                    try {
                        return await work();
                    } finally {
                        atExit.recipes = await prisma.recipes.count();
                        atExit.report = fs.existsSync(reportPath());
                    }
                },
            }),
        );

        expect(held).toBe(1);
        // Nothing had been read or written when the hold was taken, and both
        // recipes plus the report were in place before it was released.
        expect(atEntry).toEqual({ recipes: 0, report: false });
        expect(atExit).toEqual({ recipes: 2, report: true });
    }, BLOCK_TIMEOUT_MS);

    it('refuses before any write when another stage holds the graph', async () => {
        const refusal = await refusalFrom(
            seedDeps({
                runUnderCatalogLock: () =>
                    Promise.reject(
                        new CheckpointError('catalog_stage_locked', '', undefined, {
                            stage: 'release',
                            mode: 'shared',
                            waitedMs: 0,
                        }),
                    ),
            }),
        );

        expect(refusal.code).toBe('catalog_locked');
        expect(refusal.message).toContain('holds the lock on the catalog graph');
        expect(describeFailure(refusal).code).toBe('catalog_locked');
        expect(await readCounts()).toEqual({
            recipes: 0,
            versions: 0,
            currentVersions: 0,
            retiredVersions: 0,
            ingredients: 0,
        });
        expect(await prisma.catalog_import_runs.count()).toBe(0);
        expect(fs.existsSync(reportPath())).toBe(false);
    }, BLOCK_TIMEOUT_MS);

    it('refuses the publication when an ingredient stops being publishable under it', async () => {
        const refusal = await refusalFrom(
            seedDeps({
                prisma: mutatingCatalogBeforeFirstPublication(async () => {
                    await prisma.catalog_foods.update({
                        where: { source_key: 'test:broccoli-raw' },
                        data: { publication_status: 'retired' },
                    });
                }),
            }),
        );

        expect(refusal.code).toBe('catalog_drifted');
        expect(refusal.message).toContain('the catalog moved under it');
        expect(refusal.problems.join('\n')).toContain('publication_status "retired"');
        expect(refusal.problems.join('\n')).toContain('test:broccoli-raw');
        // NOTHING published: the refusal happens before the first write of the
        // first publication, and the report is a whole-corpus claim that is
        // never reached.
        expect(await readCounts()).toEqual({
            recipes: 0,
            versions: 0,
            currentVersions: 0,
            retiredVersions: 0,
            ingredients: 0,
        });
        expect(fs.existsSync(reportPath())).toBe(false);
    }, BLOCK_TIMEOUT_MS);

    it('refuses the publication when an ingredient is re-versioned under it', async () => {
        const refusal = await refusalFrom(
            seedDeps({
                prisma: mutatingCatalogBeforeFirstPublication(async () => {
                    await prisma.catalog_foods.update({
                        where: { source_key: 'test:tofu-firm' },
                        data: { metadata_version: { increment: 1 }, allergen_tags: ['soy', 'sesame'] },
                    });
                }),
            }),
        );

        expect(refusal.code).toBe('catalog_drifted');
        expect(refusal.problems.join('\n')).toContain('moved metadata_version 1 -> 2');
        expect(refusal.problems.join('\n')).toContain('tofu-broccoli-bowl');

        // The tofu is only in ONE of the two recipes, and the corpus publishes
        // in slug order — so the chicken plate, whose ingredients did not move,
        // keeps the transaction it committed before the drift was met, and the
        // bowl that would have cited the stale metadata version has no row at
        // all. That asymmetry is the point of refusing per publication: the run
        // fails and says which recipe it could not publish, rather than
        // publishing a version whose allergen tags are a snapshot of a row that
        // has since gained `sesame`.
        expect(
            (await prisma.recipes.findMany({ select: { slug: true }, orderBy: { slug: 'asc' } })).map(
                (row) => row.slug,
            ),
        ).toEqual(['chicken-broccoli-plate']);
        expect(fs.existsSync(reportPath())).toBe(false);
        expect(
            (
                await prisma.catalog_import_runs.findMany({
                    where: { kind: RECIPE_SEED_RUN_KIND },
                    select: { status: true, counts: true },
                })
            )[0],
        ).toEqual({ status: 'failed', counts: expect.objectContaining({ recipes_settled: 1 }) });
    }, BLOCK_TIMEOUT_MS);

    it('leaves an unchanged rerun a no-op even when the catalog moves during it', async () => {
        await runSeed(seedDeps());
        const published = await readIdentity();

        // The drift check belongs to the writing paths only: a rerun that
        // decides `unchanged` must not become a refusal, because a retired food
        // may legitimately keep backing the version it was already published
        // into.
        const outcome = await runSeed(
            seedDeps({
                now: () => PROMOTED_AT,
                prisma: mutatingCatalogBeforeFirstPublication(async () => {
                    await prisma.catalog_foods.update({
                        where: { source_key: 'test:broccoli-raw' },
                        data: { publication_status: 'retired' },
                    });
                }),
            }),
        );

        expect(outcome.unchanged).toEqual(['chicken-broccoli-plate', 'tofu-broccoli-bowl']);
        expect(outcome.created).toEqual([]);
        expect(outcome.promoted).toEqual([]);
        expect(await readIdentity()).toEqual(published);
    }, BLOCK_TIMEOUT_MS);
});

describe('the writer lock that makes this stage the only seed', () => {
    /**
     * The remaining half of what the graph hold cannot settle. That hold is
     * SHARED, so it is compatible with itself; the run ledger's lease is keyed
     * on the CORPUS FINGERPRINT, so two different revisions of the files never
     * meet on it, and an `--only`-narrowed run claims no ledger row at all.
     * Two seeds could therefore publish overlapping slugs in separate
     * transactions and race the coverage report. This block settles the lock
     * that stops them: one
     * exclusive, session-scoped hold on a constant key, taken for every non-dry
     * run whatever corpus it names and however narrow it is.
     *
     * Each case observes the REFUSAL, and observes the hold it was refused by
     * from `pg_locks` — not the absence of a second publication, which a passing
     * race would also produce.
     */
    let otherDirectory: string;
    let otherReportPath: string;

    /** A second corpus on disk, so "a different corpus" is a different fingerprint and not a claim. */
    const otherCorpusDeps = (overrides: Partial<SeedDeps> = {}): Partial<SeedDeps> => ({
        recipesDir: otherDirectory,
        reportPath: otherReportPath,
        ...overrides,
    });

    beforeEach(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl(), chickenPlate()]);
        fs.rmSync(reportPath(), { force: true });

        otherDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'recipes-seed-other-corpus-'));
        otherReportPath = path.join(otherDirectory, 'coverage-report.json');
        // ONE file where the shared corpus has two: a different digest set, so
        // `deriveCorpusFingerprint` gives it a different `manifest_version` and
        // the two runs address two different ledger rows.
        writeCorpusInto(otherDirectory, [tofuBowl()]);
    }, BLOCK_TIMEOUT_MS);

    afterEach(() => {
        fs.rmSync(otherDirectory, { recursive: true, force: true });
    });

    it('refuses a second writer on a DIFFERENT corpus while the first holds the lock', async () => {
        const contention = await refusedWhileAnotherWriterHolds({}, otherCorpusDeps());

        expect(contention.refusal.code).toBe('seed_writer_locked');
        expect(contention.refusal.message).toContain('another recipe seed is publishing');
        expect(describeFailure(contention.refusal).code).toBe('seed_writer_locked');
        // The hold it was refused by, read from pg_locks rather than assumed.
        expect(contention.writerModesWhileHeld).toEqual(['ExclusiveLock']);
        // Refused before it read, claimed or wrote anything: the holder is parked
        // before its own first read, so a corpus or a ledger row at this instant
        // could only be the contender's.
        expect(contention.runRowsWhileHeld).toBe(0);
        expect(contention.recipesWhileHeld).toBe(0);

        // The holder finished its own corpus untouched by the refusal.
        expect(contention.holding.created).toEqual(['chicken-broccoli-plate', 'tofu-broccoli-bowl']);

        // And the two really are different work rather than two views of one
        // corpus: run the refused one on its own and its fingerprint differs, so
        // the fingerprint-keyed claim lock could never have separated them.
        const other = await runSeed(seedDeps(otherCorpusDeps({ now: () => THIRD_PUBLISHED_AT })));

        expect(other.run?.manifestVersion).not.toBe(contention.holding.run?.manifestVersion);
        expect(await heldWriterLockModes()).toEqual([]);
    }, BLOCK_TIMEOUT_MS);

    it('refuses a whole-corpus writer while a --only writer holds the lock', async () => {
        const contention = await refusedWhileAnotherWriterHolds(
            { options: { help: false, only: ['tofu-broccoli-bowl'], dryRun: false } },
            {},
        );

        expect(contention.refusal.code).toBe('seed_writer_locked');
        expect(contention.writerModesWhileHeld).toEqual(['ExclusiveLock']);
        // The narrowed holder claims NO ledger row — which is precisely why the
        // lease cannot be what separates these two, and why the lock is taken
        // for a narrowed run all the same.
        expect(contention.holding.run).toBeNull();
        expect(contention.holding.created).toEqual(['tofu-broccoli-bowl']);
        expect(contention.runRowsWhileHeld).toBe(0);
    }, BLOCK_TIMEOUT_MS);

    it('refuses a --only writer while a whole-corpus writer holds the lock', async () => {
        const contention = await refusedWhileAnotherWriterHolds(
            {},
            { options: { help: false, only: ['tofu-broccoli-bowl'], dryRun: false } },
        );

        expect(contention.refusal.code).toBe('seed_writer_locked');
        expect(contention.writerModesWhileHeld).toEqual(['ExclusiveLock']);
        expect(contention.holding.created).toEqual(['chicken-broccoli-plate', 'tofu-broccoli-bowl']);
        // The narrowed contender published nothing: exactly one version per
        // recipe, all of them the holder's.
        expect(await readCounts()).toMatchObject({ recipes: 2, versions: 2, currentVersions: 2, retiredVersions: 0 });
    }, BLOCK_TIMEOUT_MS);

    it('refuses when no DATABASE_URL resolves, rather than letting the driver pick a database', async () => {
        // `new pg.Client({connectionString: undefined})` falls back to the libpq
        // environment and can connect somewhere nobody named, so the writer lock
        // would be taken against an unknown database — or against none — while
        // this seed published as though it were exclusive. dbGuard refuses an
        // unset DATABASE_URL at module load, so reaching here means a caller
        // bypassed it, and the refusal is what makes that bypass loud instead of
        // silently unexclusive.
        const configured = process.env.DATABASE_URL;
        delete process.env.DATABASE_URL;

        try {
            const refusal = await refusalOf(runSeed(seedDeps({})));

            expect(refusal.code).toBe('seed_writer_lock_unavailable');
            expect(refusal.message).toContain('no DATABASE_URL is set');
            // Refused before the stage read, claimed or wrote anything: the
            // writer hold is the outermost wrapper, so nothing below it ran.
            expect(await prisma.recipes.count()).toBe(0);
            expect(await prisma.catalog_import_runs.count()).toBe(0);
            expect(await heldWriterLockModes()).toEqual([]);
        } finally {
            process.env.DATABASE_URL = configured;
        }
    }, BLOCK_TIMEOUT_MS);

    it('takes no writer lock for a dry run, and a dry run is not refused by one', async () => {
        const entered = rendezvous();
        const release = rendezvous();
        const holder = runSeed(seedDeps({ runUnderCatalogLock: parkedInsideTheWriterHold(entered, release) }));

        try {
            await arriveAt(entered.reached, 'the holding writer to take the recipe-seed writer lock');

            const dry = await runSeed(seedDeps({ options: { help: false, only: [], dryRun: true } }));

            // Validated everything and was refused by nothing: a dry run
            // publishes no row and no report, so it owns nothing and waits for
            // nobody.
            expect(dry.dryRun).toBe(true);
            expect(dry.selected).toEqual(['chicken-broccoli-plate', 'tofu-broccoli-bowl']);
            expect(dry.report).toBeNull();
            // STILL exactly one hold: the dry run took none of its own, so a
            // second dry run could not be refused by a first either.
            expect(await heldWriterLockModes()).toEqual(['ExclusiveLock']);
            expect(await prisma.recipes.count()).toBe(0);

            release.signal();
            await holder;
        } catch (error) {
            release.signal();
            await holder.catch(() => undefined);
            throw error;
        }

        expect(await heldWriterLockModes()).toEqual([]);
    }, BLOCK_TIMEOUT_MS);
});

describe('the run this stage records', () => {
    /**
     * §0.7.1's interruption-and-recovery requirement. The corpus publishes one
     * transaction per recipe, so this block settles what an operator and the
     * next invocation can learn from the ledger afterwards: a terminal status,
     * the counts that really committed, a cursor at the watermark, and whether
     * a run is still live.
     */
    const readRuns = async () =>
        prisma.catalog_import_runs.findMany({
            where: { kind: RECIPE_SEED_RUN_KIND },
            orderBy: { started_at: 'asc' },
        });

    const cursorOf = (row: { cursor: unknown }): RecipeSeedCursor => row.cursor as RecipeSeedCursor;

    beforeEach(async () => {
        await resetCatalog();
        writeCorpus([tofuBowl(), chickenPlate()]);
        fs.rmSync(reportPath(), { force: true });
    }, BLOCK_TIMEOUT_MS);

    it('closes one succeeded run naming the corpus, its watermark and its committed counts', async () => {
        const outcome = await runSeed(seedDeps());
        const runs = await readRuns();

        expect(outcome.run).not.toBeNull();
        expect(outcome.runSkippedReason).toBeNull();
        expect(outcome.run).toMatchObject({
            manifestVersion: outcome.run?.manifestVersion ?? '',
            resumed: false,
            attempt: 1,
            previousSucceededRunId: null,
        });
        // The fingerprint names the coverage plan version and then a digest of
        // the selected bytes, so an operator reading the column sees the policy
        // it was judged under.
        expect(outcome.run?.manifestVersion).toMatch(
            new RegExp(`^${coveragePlan.coveragePlanVersion}@[0-9a-f]{12}$`),
        );

        expect(runs).toHaveLength(1);
        expect(runs[0].id).toBe(outcome.run?.runId);
        expect(runs[0].manifest_version).toBe(outcome.run?.manifestVersion);
        expect(runs[0].status).toBe('succeeded');
        expect(runs[0].finished_at).not.toBeNull();
        expect(runs[0].counts).toEqual({
            recipes_settled: 2,
            recipes_created: 2,
            recipes_promoted: 0,
            recipes_unchanged: 0,
            ingredient_rows: outcome.ingredientRows,
        });
        expect(cursorOf(runs[0])).toMatchObject({
            attempt: 1,
            corpusSlugs: 2,
            settledSlugs: 2,
            // The corpus is published in slug order, so the watermark is the
            // last slug alphabetically.
            lastSlug: 'tofu-broccoli-bowl',
            lastAction: 'created',
            created: 2,
        });
    }, BLOCK_TIMEOUT_MS);

    it('opens a new run for a rerun of the same corpus, naming the one that already succeeded', async () => {
        const first = await runSeed(seedDeps());
        const second = await runSeed(seedDeps({ now: () => PROMOTED_AT }));
        const runs = await readRuns();

        // Reconciled again rather than reported complete: the fingerprint names
        // the corpus and this stage's other input is the catalog, so a
        // completed-run no-op keyed on the files alone would refuse for ever the
        // republication §0.5.1 requires when an ingredient snapshot goes stale.
        expect(second.run?.previousSucceededRunId).toBe(first.run?.runId);
        expect(second.run?.runId).not.toBe(first.run?.runId);
        expect(second.run?.resumed).toBe(false);
        expect(second.run?.manifestVersion).toBe(first.run?.manifestVersion);
        expect(second.unchanged).toHaveLength(2);
        expect(second.created).toEqual([]);

        expect(runs.map((row) => row.status)).toEqual(['succeeded', 'succeeded']);
        expect(runs[1].counts).toEqual({
            recipes_settled: 2,
            recipes_created: 0,
            recipes_promoted: 0,
            recipes_unchanged: 2,
            ingredient_rows: 0,
        });
    }, BLOCK_TIMEOUT_MS);

    it('closes the run failed at the watermark it reached when the corpus is interrupted', async () => {
        await expect(runSeed(seedDeps({ prisma: failingOnPublication(2) }))).rejects.toThrow(InjectedPublishFailure);

        const runs = await readRuns();

        expect(runs).toHaveLength(1);
        expect(runs[0].status).toBe('failed');
        expect(runs[0].finished_at).not.toBeNull();
        // The counts are what COMMITTED — one recipe, not the two the corpus
        // holds — and the cursor names which one, so a repair starts from a fact
        // rather than from a guess.
        expect(runs[0].counts).toMatchObject({
            recipes_settled: 1,
            recipes_created: 1,
            recipes_unchanged: 0,
        });
        expect(cursorOf(runs[0])).toMatchObject({
            attempt: 1,
            corpusSlugs: 2,
            settledSlugs: 1,
            lastSlug: 'chicken-broccoli-plate',
            lastAction: 'created',
        });
        expect((runs[0].log as { event: string }[]).map((entry) => entry.event)).toContain('run_failed');
        // Exactly the half-published corpus the ledger now describes.
        expect(await prisma.recipes.count()).toBe(1);
        expect(fs.existsSync(reportPath())).toBe(false);
    }, BLOCK_TIMEOUT_MS);

    describe('a run whose process was killed before its finalizer', () => {
        /**
         * The one exit through which a run stays `running`: the process dies, so
         * nothing closes the row. The kill is simulated by reopening the row the
         * interrupted attempt closed and clearing the counts it managed to
         * write — a killed process never writes counts, because only the close
         * does — which leaves exactly the state a `kill -9` leaves: `running`,
         * no terminal counts, and a cursor whose lease is the last thing it
         * committed.
         */
        let killedRunId: string;

        beforeEach(async () => {
            await expect(runSeed(seedDeps({ prisma: failingOnPublication(2) }))).rejects.toThrow(
                InjectedPublishFailure,
            );

            const runs = await readRuns();
            killedRunId = runs[0].id;
            await prisma.catalog_import_runs.update({
                where: { id: killedRunId },
                data: { status: 'running', finished_at: null, counts: {} },
            });
        }, BLOCK_TIMEOUT_MS);

        it('refuses a second seed while that run\'s lease is still live', async () => {
            const cursor = cursorOf(await prisma.catalog_import_runs.findUniqueOrThrow({ where: { id: killedRunId } }));

            expect(new Date(cursor.leaseUntil).getTime()).toBe(PUBLISHED_AT.getTime() + RECIPE_SEED_RUN_LEASE_MS);

            const refusal = await refusalFrom(seedDeps());

            expect(refusal.code).toBe('seed_in_progress');
            expect(refusal.message).toContain(killedRunId);
            // Refused before the corpus was touched: the one recipe the killed
            // attempt committed is still the only one.
            expect(await prisma.recipes.count()).toBe(1);
            expect((await readRuns()).map((row) => row.status)).toEqual(['running']);
        }, BLOCK_TIMEOUT_MS);

        it('resumes that same run once the lease has lapsed and closes it succeeded', async () => {
            const outcome = await runSeed(seedDeps({ now: () => PROMOTED_AT }));
            const runs = await readRuns();

            expect(outcome.run?.runId).toBe(killedRunId);
            expect(outcome.run?.resumed).toBe(true);
            expect(outcome.run?.attempt).toBe(2);
            // The corpus is FINISHED: the recipe the killed attempt never
            // reached is published, and the one it had committed is reconciled
            // rather than skipped — the cursor is an interruption record, not a
            // list of slugs to trust unchecked.
            expect(outcome.created).toEqual(['tofu-broccoli-bowl']);
            expect(outcome.unchanged).toEqual(['chicken-broccoli-plate']);
            expect(await prisma.recipes.count()).toBe(2);

            expect(runs).toHaveLength(1);
            expect(runs[0].status).toBe('succeeded');
            expect(runs[0].counts).toEqual({
                recipes_settled: 2,
                recipes_created: 1,
                recipes_promoted: 0,
                recipes_unchanged: 1,
                ingredient_rows: outcome.ingredientRows,
            });
            expect(cursorOf(runs[0])).toMatchObject({ attempt: 2, settledSlugs: 2 });
            // The killed attempt's watermark survives its cursor being
            // overwritten.
            const events = (runs[0].log as { event: string }[]).map((entry) => entry.event);
            expect(events).toContain('recipe_seed_attempt_taken_over');
        }, BLOCK_TIMEOUT_MS);
    });

    describe('a superseded attempt that resumes after its run was taken over', () => {
        /**
         * The residue the session lock cannot cover, and the reason the run row
         * carries an attempt token as well.
         *
         * A writer lock held on a session is released when the process dies —
         * which is what makes a second LIVE writer impossible. What it leaves is
         * the process whose LOCK SESSION died while the process itself kept a
         * working connection pool: a dropped connection, a suspended host, a
         * statement that came back after an age. That process holds no lock, so
         * a later invocation legitimately takes the lock, finds the lease lapsed
         * and takes the run over — and the first one can then wake up and keep
         * writing. Every write it tries must be refused, and these two cases
         * refuse it at the two writes it can wake up into: a PUBLICATION and a
         * CURSOR WRITE. Its terminal close is refused in both.
         *
         * `zombieResumesAfterTakeover` parks the successor between its takeover
         * and its first publication, so the row is `running` under a rotated
         * token when the zombie resumes — which is the only state in which the
         * TOKEN COMPARISON is what refuses it, rather than the closed-status
         * check that would have refused it anyway.
         */
        const expectTheTakeoverOwnsEverything = async (observed: Supersession): Promise<void> => {
            // Refused by the token, not by a closed row: the row was still
            // `running` under attempt 2 at the instant the zombie failed, so the
            // zombie's own terminal close did not land either.
            expect(observed.zombieRefusal.code).toBe('run_attempt_superseded');
            expect(observed.zombieRefusal.message).toContain('taken over by a later attempt (now attempt 2)');
            expect(describeFailure(observed.zombieRefusal).code).toBe('run_attempt_superseded');
            expect(observed.zombieEvents).toContain('run_close_refused');
            expect(observed.zombieEvents).not.toContain('run_close_failed');
            expect(observed.zombieEvents).not.toContain('run_finished');
            expect(observed.runWhileTakenOver).toEqual({ status: 'running', cursorAttempt: 2 });

            // The corpus is the successor's and complete: the recipe the zombie
            // had committed is reconciled rather than skipped, the one it never
            // reached is published, and no recipe carries a second version —
            // which is what a zombie publishing beside the takeover would have
            // produced.
            expect(observed.takeover.run?.resumed).toBe(true);
            expect(observed.takeover.run?.attempt).toBe(2);
            expect(observed.takeover.created).toEqual(['tofu-broccoli-bowl']);
            expect(observed.takeover.unchanged).toEqual(['chicken-broccoli-plate']);
            expect(await readCounts()).toEqual({
                recipes: 2,
                versions: 2,
                currentVersions: 2,
                retiredVersions: 0,
                ingredients: await prisma.recipe_ingredients.count(),
            });

            // ONE run row, closed by the attempt that owns it, with that
            // attempt's counts and cursor — not the zombie's.
            const runs = await readRuns();

            expect(runs).toHaveLength(1);
            expect(runs[0].status).toBe('succeeded');
            expect(runs[0].counts).toEqual({
                recipes_settled: 2,
                recipes_created: 1,
                recipes_promoted: 0,
                recipes_unchanged: 1,
                ingredient_rows: observed.takeover.ingredientRows,
            });
            expect(cursorOf(runs[0])).toMatchObject({
                attempt: 2,
                corpusSlugs: 2,
                settledSlugs: 2,
                lastSlug: 'tofu-broccoli-bowl',
            });
            expect((runs[0].log as { event: string }[]).map((entry) => entry.event)).toContain(
                'recipe_seed_attempt_taken_over',
            );
            // Nothing is holding the writer lock once both attempts are done.
            expect(await heldWriterLockModes()).toEqual([]);
        };

        it('refuses the PUBLICATION it resumes into, and its close', async () => {
            const observed = await zombieResumesAfterTakeover({ nth: 2, when: 'before' });

            // It opened a SECOND publication transaction — it really did try to
            // publish — and that transaction is what the fence refused, as its
            // first statement and before it took a single ingredient row lock.
            expect(observed.zombiePublications).toBe(2);

            await expectTheTakeoverOwnsEverything(observed);
        }, BLOCK_TIMEOUT_MS);

        it('refuses the CURSOR WRITE it resumes into, and its close', async () => {
            const observed = await zombieResumesAfterTakeover({ nth: 1, when: 'after' });

            // It opened exactly ONE publication transaction, which COMMITTED —
            // so the write it resumed into is the cursor update that follows a
            // settled recipe, and that is what was refused. The committed recipe
            // is not lost: the successor reconciles it as `unchanged` above.
            expect(observed.zombiePublications).toBe(1);

            await expectTheTakeoverOwnsEverything(observed);
        }, BLOCK_TIMEOUT_MS);
    });

    it('claims no run for a dry run or a narrowed run', async () => {
        const dry = await runSeed(seedDeps({ options: { help: false, only: [], dryRun: true } }));

        expect(dry.run).toBeNull();
        expect(dry.runSkippedReason).toContain('dry run');
        expect(await prisma.catalog_import_runs.count()).toBe(0);

        const narrowed = await runSeed(
            seedDeps({ options: { help: false, only: ['tofu-broccoli-bowl'], dryRun: false } }),
        );

        expect(narrowed.created).toEqual(['tofu-broccoli-bowl']);
        expect(narrowed.run).toBeNull();
        expect(narrowed.runSkippedReason).toContain('narrowed');
        // A narrowed run publishes one recipe and claims nothing, so it can
        // neither describe the corpus in the ledger nor block the real seed
        // through the lease.
        expect(await prisma.catalog_import_runs.count()).toBe(0);
    }, BLOCK_TIMEOUT_MS);

    it('refuses to publish at all when it has no ledger it can write to', async () => {
        const refusal = await refusalFrom(
            // `failingAfter`'s wrapper is a narrow SeedDb with no
            // catalog_import_runs delegate, and no separate ledger client is
            // injected — the one configuration in which the run could not be
            // recorded.
            seedDeps({ prisma: failingAfter('retire'), runDb: undefined }),
        );

        expect(refusal.code).toBe('run_ledger_unavailable');
        expect(refusal.message).toContain('SeedDeps.runDb');
        expect(await prisma.recipes.count()).toBe(0);
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

/**
 * `deriveCoverageReport`, over plain objects and with no database.
 *
 * WHY THESE ARE HERE RATHER THAN IN THE API SUITE. The table's SHAPE — which
 * dimensions it has, that it carries one cell per combination of them, which
 * cells §0.7.3 calls guaranteed and which reduced, at what thresholds, that the
 * two sets are disjoint, how a slot splits into the four strata and which
 * floors each carries — is a property of this pure derivation and of nothing
 * else. Pinned here, three recipes are enough to state every one of them
 * exactly, and a change to the derivation fails a named assertion.
 * `src/__tests__/api/seed-rerun.test.ts` asserts the complementary thing: that
 * the real 42-recipe corpus against the real release SATISFIES those cells and
 * reproduces the committed artefact. It measures the corpus against whatever the
 * report currently emits, so it cannot notice a dimension that disappeared or a
 * threshold that moved — which is exactly what these tests are for.
 */
/**
 * A per-serving macro set shaped 30/40/30 by ENERGY, which is exactly the split
 * `targets.logic.ts::deriveMacroTargets` sets for every calorie target.
 *
 * That is what makes a fixture built from it plannable across the whole sampled
 * band rather than at one lucky point: scaling a macro-proportional recipe by
 * any multiplier keeps the day proportional, so a day whose CALORIES land inside
 * the ±10 % window lands inside the protein, carb and fat bands too. 500 kcal a
 * serving over three slots reaches 750–3,000 kcal at the offered multipliers,
 * which spans the 1,200–3,000 band the report samples.
 */
const PROPORTIONAL_PER_SERVING = { calories: 500, protein: 38, carbs: 50, fat: 17 } as const;

/** A serving no multiplier can fit into any sampled day: 0.5 x 6000 already overshoots 3,000 kcal. */
const OVERSIZED_PER_SERVING = { calories: 6000, protein: 456, carbs: 600, fat: 204 } as const;

const coverageRecipe = (
    slug: string,
    mealSlots: readonly string[],
    dietTags: readonly string[],
    allergenTags: readonly string[],
    totalMinutes: number,
    perServing: CoverageRecipe['perServing'] = PROPORTIONAL_PER_SERVING,
): CoverageRecipe => ({
    slug,
    mealSlots,
    dietTags,
    versionNumber: 1,
    budgetTier: 1,
    perServing,
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

describe('deriveCoverageReport', () => {
    const report = deriveCoverageReport([
        coverageRecipe('vegan-quick', ['breakfast'], [...PLANT_DIET_TAGS], [], 10),
        coverageRecipe('vegetarian-slow', ['breakfast', 'lunch'], ['pescatarian', 'vegetarian'], ['milk'], 50),
        coverageRecipe('omnivore', ['dinner'], [], [], 30),
    ]);

    it('states every dimension of the table and one cell per combination', () => {
        expect(report.dimensions).toEqual({
            diets: ['none', 'vegetarian', 'vegan', 'pescatarian'],
            allergens: ['none', 'milk', 'eggs', 'peanuts', 'tree_nuts', 'soy', 'wheat', 'fish', 'shellfish', 'sesame'],
            slots: ['breakfast', 'lunch', 'dinner', 'snack'],
            mainSlots: ['breakfast', 'lunch', 'dinner'],
            timeTiers: [15, 30, 45, 60],
        });
        // 4 x 10 x 4 x 4 = 640, stated as the product AND as the number, so a
        // dimension that silently lost a member fails here rather than passing a
        // length check that derived itself from the same list.
        expect(report.eligibleCounts).toHaveLength(4 * 10 * 4 * 4);
        expect(report.eligibleCounts).toHaveLength(640);
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

    it('claims the cells §0.7.3 names at its thresholds, certifying none of them from three recipes', () => {
        // The CLAIMED set is the union of the three lists: certification moves a
        // cell between them and never drops one, so §0.7.3's 140 + 124 cells
        // are all still accounted for.
        const claimed = [...report.guaranteedCells, ...report.reducedCells, ...report.eligibleNotPlannableCells];
        expect(claimed).toHaveLength(140 + 124);
        expect(claimed).toHaveLength(264);
        expect(report.feasibility.certification).toEqual({
            guaranteedClaimed: 140,
            guaranteedCertified: 0,
            reducedClaimed: 124,
            reducedCertified: 0,
        });

        // Three recipes reach no threshold, so nothing is certified and every
        // claim is demoted — which is the point of the gate: a cell is in
        // `guaranteedCells` because it was established, not because §0.7.3
        // names it.
        expect(report.guaranteedCells).toEqual([]);
        expect(report.reducedCells).toEqual([]);
        expect(report.eligibleNotPlannableCells.filter((cell) => cell.threshold === 4)).toHaveLength(140);
        expect(report.eligibleNotPlannableCells.filter((cell) => cell.threshold === 2)).toHaveLength(124);

        // No cell is claimed twice, which is what the guaranteed and reduced
        // clauses' disjointness amounts to now that both are filtered.
        const key = (cell: { diet: string; allergen: string; slot: string; timeTier: number }): string =>
            `${cell.diet}|${cell.allergen}|${cell.slot}|${cell.timeTier}`;
        expect(new Set(claimed.map(key)).size).toBe(claimed.length);

        // The claim order the two clauses state them in is preserved.
        expect(report.eligibleNotPlannableCells[0]).toMatchObject({
            diet: 'none',
            allergen: 'none',
            slot: 'breakfast',
            timeTier: 45,
            threshold: 4,
        });
        expect(report.eligibleNotPlannableCells[140]).toMatchObject({
            diet: 'vegetarian',
            allergen: 'milk',
            slot: 'breakfast',
            timeTier: 45,
            threshold: 2,
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
        expect(report.slotComposition.snack.composition.furtherOmnivore.floor).toBeNull();
        expect(report.slotComposition.snack.composition.vegan.floor).toBe(4);
        expect(report.slotComposition.snack.composition.furtherVegetarian.floor).toBe(2);
    });

    it('carries the self-describing members the committed artefact is reviewed with', () => {
        expect(report.schemaVersion).toBe(2);
        expect(report.eligibilityRule.mirrors).toBe('src/services/recipe.logic.ts::isEligibleForPlanning');
        // The five axes the rule is decided on, in the order the artefact states
        // them. The rule block has since grown prose members beside `clauses`,
        // so the axis list is asserted rather than the whole object.
        expect(report.eligibilityRule.clauses.map((clause) => clause.axis)).toEqual([
            'slot',
            'diet',
            'allergen',
            'allergenStatus',
            'time',
        ]);
        expect(report.eligibilityRule.timeTiersCumulative).toContain('cumulative');
        expect(report.repeatRule).toMatchObject({
            maxUsesPerWeek: 2,
            consecutiveDaysAllowed: false,
            minEligiblePerSlotForFullWeek: 4,
        });
        // The notes that explain the stratum table to a reader of the file:
        // that the four strata partition the slot's eligible set, and that a
        // null floor is not a zero one.
        expect(report.slotCompositionNotes.strata).toContain('partition');
        expect(report.slotCompositionNotes.floors).toContain('not the same as a floor of zero');
        expect(report.boundary).toContain('supported at runtime but not guaranteed');
        expect(report.boundary).toContain('no_matching_meals');
        expect(report.boundary).toContain('editStep');

        // The feasibility half is self-describing for the same reason: a
        // reviewer must be able to read what a certified cell claims out of the
        // committed file.
        expect(report.feasibility.rule.mirrors).toContain('evaluateDayTolerance');
        expect(report.feasibility.rule.usable).toContain('strictly stronger than eligible');
        expect(report.feasibility.rule.certification).toContain('ONLY cells that pass');
        expect(report.feasibility.rule.searchBound).toContain('is not a proof that the corpus cannot');
        expect(report.feasibility.schedules).toEqual(['three', 'three_plus_snack']);
        // ceil(7 days / 2 uses a week), which is `repeatRule`'s own figure.
        expect(report.feasibility.weekFillMinUsableRecipesPerSlot).toBe(4);
        expect(report.feasibility.weekFillMinUsableRecipesPerSlot).toBe(
            report.repeatRule.minEligiblePerSlotForFullWeek,
        );
        expect(report.feasibility.evaluationCapPerProbe).toBeGreaterThan(0);
    });
});

/* ---------------------------------------------------------------------------
 * The feasibility gate — the half a count cannot express
 * ------------------------------------------------------------------------- */

/**
 * WHY THIS BLOCK EXISTS. A cell can hold well over its threshold of eligible
 * recipes and still be unplannable, and the shipped corpus proved it: the vegan
 * cells held 4 eligible breakfasts, 6 lunches and 8 dinners — comfortably over
 * the threshold of 4 — while no assignment of them reached the protein target
 * at ANY calorie target in the sampled band, so every vegan user was answered
 * `422 no_matching_meals` by a profile `coverage-report.json` called guaranteed.
 * Counting is therefore not a sufficient certification, and these tests pin the
 * four outcomes the gate must distinguish.
 *
 * Each fixture is built here rather than read from
 * `data/meal-planning/recipes/`: the corpus is authored independently of this
 * derivation and a test that asserted against its file count or its macros
 * would fail whenever a recipe was added, which is neither a defect nor
 * something this suite can settle.
 */
/**
 * The search's pruning window against the verdict it must never contradict.
 *
 * THE ONE WAY THE GATE COULD LIE. `feasibilityWindow` restates the SHAPE of
 * `evaluateDayTolerance`'s four bands — a ratio on calories, an asymmetric pair
 * on protein, the larger of an absolute and a relative band on carbs and fat —
 * from that module's own constants, so that a partial day outside the window can
 * be abandoned without completing it. If the window were ever NARROWER than the
 * verdict, the search would abandon days the planner would accept and the report
 * would call a plannable cell unplannable, which is the same class of false
 * claim as the counting-only certification this gate replaced.
 *
 * So the property asserted here is containment, at every sampled target and over
 * a fine sweep of each macro: whatever `evaluateDayTolerance` ACCEPTS lies
 * inside the window. It holds for any band shape, so it keeps holding if
 * `mealPlan.logic.ts` changes one — and fails loudly if a change makes the two
 * disagree.
 */
describe('the pruning window the day search abandons a partial day on', () => {
    const SAMPLED_TARGETS: readonly number[] = [1200, 1500, 1800, 2100, 2400, 2700, 3000];
    const MACROS: readonly ('calories' | 'protein' | 'carbs' | 'fat')[] = ['calories', 'protein', 'carbs', 'fat'];

    it('never excludes a day the production verdict accepts', () => {
        const contradictions: string[] = [];
        let acceptedInside = 0;
        let rejectedOutside = 0;

        for (const calories of SAMPLED_TARGETS) {
            const targets = deriveMacroTargets(calories);
            const window = feasibilityWindow(targets);

            for (const macro of MACROS) {
                const target = targets[macro];
                // Wide enough to leave every band, and stepped finely enough to
                // land on both sides of each edge.
                const step = target / 200;
                for (let value = 0; value <= target * 2; value += step) {
                    const totals = { ...targets, [macro]: value };
                    const accepted = evaluateDayTolerance(totals, targets).withinTolerance;
                    const inside = value >= window.low[macro] && value <= window.high[macro];

                    if (accepted && !inside) {
                        contradictions.push(
                            `${macro} ${value.toFixed(3)} at a ${calories} kcal target is within tolerance but outside ` +
                                `the pruning window [${window.low[macro].toFixed(3)}, ${window.high[macro].toFixed(3)}]`,
                        );
                    }
                    if (accepted) {
                        acceptedInside += 1;
                    } else if (!inside) {
                        rejectedOutside += 1;
                    }
                }
            }
        }

        expect(contradictions).toEqual([]);
        // Non-vacuity: the sweep really does cross both edges of every band, so
        // the containment above is not passing on an empty or all-inside sweep.
        expect(acceptedInside).toBeGreaterThan(0);
        expect(rejectedOutside).toBeGreaterThan(0);
    });

    it('is wider than the verdict rather than equal to it, on every macro', () => {
        const targets = deriveMacroTargets(2100);
        const window = feasibilityWindow(targets);

        for (const macro of MACROS) {
            expect(window.low[macro]).toBeLessThan(targets[macro]);
            expect(window.high[macro]).toBeGreaterThan(targets[macro]);
            // Just outside the window is refused by the verdict too, so the
            // window is not merely permissive.
            expect(
                evaluateDayTolerance({ ...targets, [macro]: window.low[macro] - 1 }, targets).breaches,
            ).toContain(macro);
            expect(
                evaluateDayTolerance({ ...targets, [macro]: window.high[macro] + 1 }, targets).breaches,
            ).toContain(macro);
        }

        // Protein's band is asymmetric on purpose — 15 g under, 25 g over — and
        // the window carries that rather than a symmetric approximation of it.
        expect(targets.protein - window.low.protein).toBeLessThan(window.high.protein - targets.protein);
    });
});

describe('the coverage report\'s feasibility gate', () => {
    const slotsInOrder: readonly string[] = ['breakfast', 'lunch', 'dinner', 'snack'];

    /** Four recipes dedicated to each slot: enough for the week-fill floor of 4, with no slot borrowing another's. */
    const corpus = (
        perServing: CoverageRecipe['perServing'] = PROPORTIONAL_PER_SERVING,
        overrides: Readonly<Record<string, CoverageRecipe['perServing']>> = {},
    ): CoverageRecipe[] =>
        slotsInOrder.flatMap((slot) =>
            [1, 2, 3, 4].map((index) =>
                coverageRecipe(
                    `${slot}-${index}`,
                    [slot],
                    [],
                    [],
                    10,
                    overrides[`${slot}-${index}`] ?? perServing,
                ),
            ),
        );

    const cellIn = (
        cells: readonly { diet: string; allergen: string; slot: string; timeTier: number }[],
        slot: string,
        timeTier = 45,
    ): { diet: string; allergen: string; slot: string; timeTier: number } | undefined =>
        cells.find(
            (cell) => cell.diet === 'none' && cell.allergen === 'none' && cell.slot === slot && cell.timeTier === timeTier,
        );

    const probeIn = (
        report: CoverageReport,
        schedule: string,
        timeTier = 45,
    ): CoverageReport['feasibility']['probes'][number] => {
        const probe = report.feasibility.probes.find(
            (candidate) =>
                candidate.diet === 'none' &&
                candidate.allergen === 'none' &&
                candidate.timeTier === timeTier &&
                candidate.schedule === schedule,
        );

        if (probe === undefined) {
            throw new Error(`no none/none/${timeTier}min/${schedule} probe was derived`);
        }

        return probe;
    };

    describe('a corpus that can compose a day at every sampled target', () => {
        const report = deriveCoverageReport(corpus());

        it('records the sampled band, its macros and which of it was plannable', () => {
            // The band is spelled out rather than read back from the report,
            // deliberately: this is the gate that stops the sampled set being
            // narrowed silently, and a self-referential assertion would gate
            // nothing. It spans the WHOLE band `targets.logic.ts` can emit —
            // the 1,200 kcal female floor to the 5,000 kcal `CALORIE_CEILING` —
            // because a band that stops below what the product hands the
            // planner certifies a promise for some users and never tests it for
            // the rest.
            expect(report.feasibility.sampledTargets.map((target) => target.calories)).toEqual([
                1200, 1500, 1800, 2100, 2400, 2700, 3000, 3500, 4000, 4500, 5000,
            ]);
            // The macros are `deriveMacroTargets`', not this file's: 30/40/30
            // of energy at 4/4/9 kcal a gram. Both ends are pinned, so neither
            // the floor nor the ceiling can drift.
            expect(report.feasibility.sampledTargets[0]).toEqual({
                calories: 1200,
                protein: 90,
                carbs: 120,
                fat: 40,
            });
            expect(report.feasibility.sampledTargets[6]).toEqual({
                calories: 3000,
                protein: 225,
                carbs: 300,
                fat: 100,
            });
            expect(report.feasibility.sampledTargets[10]).toEqual({
                calories: 5000,
                protein: 375,
                carbs: 500,
                fat: 167,
            });

            // THIS FIXTURE'S REACH, and why it is not the whole band. The
            // corpus here is four small synthetic recipes per slot, so the most
            // a day can reach is the portion cap times their sum — comfortably
            // the lower band, part of the extended one, and honestly not the
            // 5,000 kcal ceiling. The measured boundary sits inside the high
            // band rather than at its first step, which is why the assertions
            // below name the floor and the partition and leave the boundary to
            // the probe. The property under test is that the probe SAYS SO per
            // target rather
            // than collapsing the cell to a yes or a no: every sampled target
            // lands in exactly one of the two lists, the two together are the
            // band in its own order, and the search completed in both cases.
            const sampled = report.feasibility.sampledTargets.map((target) => target.calories);

            // WHICH high targets it reaches is deliberately not asserted, and
            // the reason is worth stating: it depends on the fixture's serving
            // sizes AND on the schedule (a snack is a fourth meal, so the
            // snack schedule reaches one target further), so pinning a list
            // here would assert a property of the fixture's arithmetic rather
            // than of the derivation. What must hold is the partition and the
            // floor.
            for (const schedule of ['three', 'three_plus_snack']) {
                const probe = probeIn(report, schedule);

                expect([...probe.plannableTargets, ...probe.unplannableTargets].sort((a, b) => a - b)).toEqual(
                    sampled,
                );
                // Every target of the original band is reachable: this fixture
                // is the healthy one, and a regression that lost the lower band
                // would be a defect in the day search rather than a small
                // corpus.
                expect(probe.plannableTargets).toEqual(expect.arrayContaining([1200, 1500, 1800, 2100, 2400, 2700, 3000]));
                // And whatever it cannot reach is in the extended high band
                // only, never below it.
                expect(probe.unplannableTargets.length).toBeGreaterThan(0);
                expect(probe.unplannableTargets.every((target) => target > 3000)).toBe(true);
                expect(probe.searchExhausted).toBe(false);
                expect(probe.evaluations).toBeGreaterThan(0);
            }
        });

        it('demotes only for the targets it cannot reach, and names the target in the reason', () => {
            // A CELL IS CERTIFIED OR IT IS NOT, at every sampled target: one
            // unreachable target demotes the cell, which is the whole point of
            // gating on plannability instead of on an eligible count. This
            // fixture's four small synthetic recipes per slot cannot compose a
            // day at the top of the band (see the band comment above), so its
            // cells demote — and the assertion is that they demote FOR THAT
            // REASON, naming the target that failed, rather than for a shortage
            // of recipes.
            //
            // The named target is the FIRST one that cell's own probe could not
            // reach, so it varies by schedule and by cooking-time tier; the
            // assertion accepts any target of the extended high band and
            // rejects a detail that names one the fixture demonstrably reaches.
            const highBandTargets = report.feasibility.sampledTargets
                .map((sample) => sample.calories)
                .filter((calories) => calories > 3000);

            const demotions = report.eligibleNotPlannableCells.filter(
                (cell) => cell.diet === 'none' && cell.allergen === 'none',
            );

            expect(demotions.length).toBeGreaterThan(0);
            expect(highBandTargets.length).toBeGreaterThan(0);

            for (const cell of demotions) {
                expect(cell.reason).toBe('no_feasible_day');
                expect(cell.detail).toContain('satisfies the tolerance');
                expect(
                    highBandTargets.some((calories) => cell.detail.includes(`${calories} kcal target`)),
                ).toBe(true);
                // Not a depth problem: every recipe of the slot IS usable, in
                // the days the fixture can compose. A demotion that also
                // reported a shortage would be describing a different corpus.
                expect(cell.usable).toBe(cell.count);
            }

            // And the lower band it CAN compose is still measured per slot: the
            // usable counts come from the day search, not from the eligible
            // count, which is what made the vegan cells honest.
            for (const schedule of ['three', 'three_plus_snack']) {
                expect(probeIn(report, schedule).slots.every((slot) => slot.usable === 4)).toBe(true);
            }
        });

        it('counts the usable recipes of a slot through the day search, per schedule', () => {
            for (const schedule of ['three', 'three_plus_snack']) {
                const probe = probeIn(report, schedule);
                expect(probe.slots.map((slot) => slot.slot)).toEqual(
                    schedule === 'three' ? ['breakfast', 'lunch', 'dinner'] : slotsInOrder,
                );
                expect(probe.slots.every((slot) => slot.usable === 4 && slot.eligible === 4)).toBe(true);
            }
        });

        it('probes the snack slot on the schedule that has one, and only there', () => {
            expect(
                report.feasibility.probes.some(
                    (probe) => probe.schedule === 'three' && probe.slots.some((slot) => slot.slot === 'snack'),
                ),
            ).toBe(false);
            expect(probeIn(report, 'three_plus_snack').slots.map((slot) => slot.slot)).toContain('snack');
        });

        it('emits a byte-identical document on a rerun, and on the same recipes in another order', () => {
            expect(JSON.stringify(deriveCoverageReport(corpus()))).toBe(JSON.stringify(report));
            // Order independence is what makes the artefact reviewable as a
            // diff: the corpus is read `orderBy: slug`, but nothing in the
            // derivation may depend on that.
            expect(JSON.stringify(deriveCoverageReport([...corpus()].reverse()))).toBe(JSON.stringify(report));
        });
    });

    describe('a corpus whose eligible recipes cannot compose any day', () => {
        // Four eligible recipes per slot — every counting clause satisfied —
        // and half a serving of any of them already overshoots the largest
        // sampled day.
        const report = deriveCoverageReport(corpus(OVERSIZED_PER_SERVING));

        it('counts the recipes as eligible', () => {
            for (const slot of slotsInOrder) {
                expect(
                    report.eligibleCounts.find(
                        (cell) =>
                            cell.diet === 'none' && cell.allergen === 'none' && cell.slot === slot && cell.timeTier === 45,
                    )?.count,
                ).toBe(4);
            }
        });

        it('certifies nothing, and demotes each cell naming the target it cannot reach', () => {
            expect(report.guaranteedCells).toEqual([]);
            expect(report.reducedCells).toEqual([]);

            const demoted = cellIn(report.eligibleNotPlannableCells, 'breakfast') as
                | (typeof report.eligibleNotPlannableCells)[number]
                | undefined;
            expect(demoted).toMatchObject({ threshold: 4, count: 4, usable: 0, reason: 'no_feasible_day' });
            expect(demoted?.detail).toContain('1200 kcal target');
            expect(demoted?.detail).toContain('satisfies the tolerance');
        });

        it('reports the search as complete, because this is a proven impossibility rather than an exhausted search', () => {
            expect(report.feasibility.probes.every((probe) => !probe.searchExhausted)).toBe(true);
            expect(probeIn(report, 'three').plannableTargets).toEqual([]);
            // Every sampled target, however many the band holds — taken from
            // the report so extending the band does not need this line edited,
            // while the band itself is pinned by name in the test above.
            expect(probeIn(report, 'three').unplannableTargets).toHaveLength(
                report.feasibility.sampledTargets.length,
            );
        });
    });

    describe('a corpus where a day exists but only one recipe per slot can appear in one', () => {
        // Three of each slot's four recipes are unusable at any multiplier, so
        // every slot holds four ELIGIBLE recipes and one USABLE one — the
        // arithmetic that makes seven days impossible under the repeat rule
        // however healthy the count looks.
        const oversizedExceptTheFirst = Object.fromEntries(
            slotsInOrder.flatMap((slot) =>
                [2, 3, 4].map((index) => [`${slot}-${index}`, OVERSIZED_PER_SERVING] as const),
            ),
        );
        const report = deriveCoverageReport(corpus(PROPORTIONAL_PER_SERVING, oversizedExceptTheFirst));

        it('still finds a day at every sampled target', () => {
            expect(probeIn(report, 'three').unplannableTargets).toEqual([]);
            expect(probeIn(report, 'three_plus_snack').unplannableTargets).toEqual([]);
        });

        it('counts one usable recipe per slot against four eligible', () => {
            for (const probe of [probeIn(report, 'three'), probeIn(report, 'three_plus_snack')]) {
                expect(probe.slots.every((slot) => slot.eligible === 4 && slot.usable === 1)).toBe(true);
            }
        });

        it('refuses the guaranteed cells for want of usable recipes, naming the shortfall', () => {
            expect(report.guaranteedCells).toEqual([]);

            const demoted = cellIn(report.eligibleNotPlannableCells, 'dinner') as
                | (typeof report.eligibleNotPlannableCells)[number]
                | undefined;
            expect(demoted).toMatchObject({
                threshold: 4,
                count: 4,
                usable: 1,
                reason: 'insufficient_usable_recipes',
            });
            expect(demoted?.detail).toBe(
                '1 of 4 eligible dinner recipes can appear in a feasible three day, short of the 4 this cell is ' +
                    'measured against',
            );
        });

        it('still certifies the reduced cells, whose threshold of two §0.7.3 measures differently', () => {
            // One usable recipe is below the reduced threshold of 2 as well, so
            // nothing is certified here either — stated explicitly so the two
            // thresholds are not silently conflated.
            expect(report.reducedCells).toEqual([]);
            expect(report.eligibleNotPlannableCells.filter((cell) => cell.threshold === 2).length).toBe(124);
        });
    });

    describe('a probe that runs out of evaluations', () => {
        // One completed-day evaluation is nowhere near enough to decide a cell,
        // and a corpus this plannable proves the branch is about the BUDGET and
        // not about the recipes: at the production cap the same fixture
        // certifies.
        const report = deriveCoverageReport(corpus(), { maxEvaluationsPerProbe: 1 });

        it('records the cap it ran under', () => {
            expect(report.feasibility.evaluationCapPerProbe).toBe(1);
            expect(report.feasibility.probes.every((probe) => probe.evaluations <= 1)).toBe(true);
        });

        it('says the search was exhausted rather than reporting the cell unplannable', () => {
            const probe = probeIn(report, 'three');
            expect(probe.searchExhausted).toBe(true);
            // Neither list claims the undecided targets: an exhausted probe
            // reports what it established and no more.
            expect(probe.plannableTargets.length + probe.unplannableTargets.length).toBeLessThan(7);
        });

        it('certifies nothing and demotes with `search_exhausted`, which is not a claim about the corpus', () => {
            expect(report.guaranteedCells).toEqual([]);
            expect(report.reducedCells).toEqual([]);
            expect(
                report.eligibleNotPlannableCells.every(
                    (cell) => cell.reason === 'search_exhausted' || cell.count < cell.threshold,
                ),
            ).toBe(true);

            const demoted = cellIn(report.eligibleNotPlannableCells, 'lunch') as
                | (typeof report.eligibleNotPlannableCells)[number]
                | undefined;
            expect(demoted).toMatchObject({ reason: 'search_exhausted', count: 4 });
            expect(demoted?.detail).toContain('spent its budget of 1 day evaluations');
            expect(demoted?.detail).toContain('neither proven able nor unable');
        });

        it('refuses a cap that could decide nothing at all', () => {
            expect(() => deriveCoverageReport(corpus(), { maxEvaluationsPerProbe: 0 })).toThrow(RecipeSeedError);
            expect(() => deriveCoverageReport(corpus(), { maxEvaluationsPerProbe: 2.5 })).toThrow(
                /whole number of at least 1/,
            );
        });
    });

    it('agrees with the counting half on how many recipes a slot holds', () => {
        // Two independent paths to the same number — `isEligibleForPlanning`
        // over the recipes for `eligibleCounts`, and
        // `eligibleRecipeCountForSlot` over the built candidates for the probe
        // — so a divergence between what the table counts and what the probe
        // searches cannot pass unnoticed.
        const report = deriveCoverageReport(corpus());
        const disagreements: string[] = [];

        for (const probe of report.feasibility.probes) {
            for (const slot of probe.slots) {
                const counted = report.eligibleCounts.find(
                    (cell) =>
                        cell.diet === probe.diet &&
                        cell.allergen === probe.allergen &&
                        cell.slot === slot.slot &&
                        cell.timeTier === probe.timeTier,
                )?.count;

                if (counted !== slot.eligible) {
                    disagreements.push(
                        `${probe.diet}/${probe.allergen}/${slot.slot}/${probe.timeTier}min: table ${String(counted)}, probe ${slot.eligible}`,
                    );
                }
            }
        }

        expect(disagreements).toEqual([]);
        expect(report.feasibility.probes.length).toBeGreaterThan(0);
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
            // Which half of the rule certified it: this URL's database name is
            // what matched, so the typed `--confirm-target` above had a name to
            // agree with.
            match: 'name',
        });

        // NEITHER HALF OF THE TARGET, by name or by value. This line is written
        // on every accepted run of every stage, so it reaches CI logs and
        // whatever ships them onward; a host and a database name there describe
        // the deployment's topology to every later reader (CWE-532) without
        // telling an operator anything the classification does not already say.
        // The digest keeps two runs distinguishable without naming either
        // target — `dbGuard.test.ts` owns that pair of assertions.
        expect(Object.keys(accepted[0].entry)).not.toContain('host');
        expect(Object.keys(accepted[0].entry)).not.toContain('database');
        expect(accepted[0].entry.targetDigest).toMatch(/^[0-9a-f]{12}$/);

        // The classification, never the URL it came from: the scheme, the user,
        // the password, the host and the database name are each absent from
        // every line the guard emitted.
        for (const entry of captured) {
            expect(entry.line).not.toContain('postgresql://');
            expect(entry.line).not.toContain('seeduser');
            expect(entry.line).not.toContain('fixture-only');
            expect(entry.line).not.toContain('127.0.0.1');
            expect(entry.line).not.toContain('soh_test');
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
        // The CODE carries the class of refusal and the reported `error` stays
        // closed at the name and the code (§8: never the raw error object).
        // The per-defect prose is this repository's own and travels beside it,
        // under the member named for that provenance — see the block below.
        expect(describeFailure(new RecipeSeedError('recipes_invalid', 'bad', ['one', 'two']))).toEqual({
            code: 'recipes_invalid',
            error: { name: 'RecipeSeedError', code: 'recipes_invalid' },
            detail: { problemCount: 2, firstPartyMessage: 'bad\n  - one\n  - two' },
        });
    });

    it('reports anything unrecognised as unexpected rather than swallowing it', () => {
        // An unrecognised failure is the case where withholding the MESSAGE
        // matters most: nothing here knows what threw, so its prose could be a
        // driver's connection error quoting the DSN or a parser quoting the
        // document. The code says "this stage did not anticipate it" and the
        // shared remedy says what to do with that, which is the actionable
        // half; the foreign sentence stays out.
        expect(describeFailure(new Error('boom'))).toEqual({
            code: 'unexpected_error',
            error: { name: 'Error' },
            detail: { remedy: UNEXPECTED_FAILURE_REMEDY },
        });
    });

    /**
     * THE DATABASE ARM, and the finding that added it.
     *
     * A seed takes its writer lock and the catalog graph hold through a raw
     * `pg` session (runUnderWriterHold, lib/checkpoint.ts) BEFORE Prisma has
     * opened anything, so a database that will not serve the run fails there,
     * with nothing in between to translate it: what arrives is a node-postgres
     * `DatabaseError` whose `name` is the literal lower-case `'error'` and whose
     * `code` is a five-character SQLSTATE. It matched none of this stage's
     * classes, so the most ordinary failure an operator can cause — a host at
     * `max_connections` — was reported as
     * `{"code":"unexpected_error","error":{"name":"error"}}`: no class, no
     * SQLSTATE, no remedy, and triage by guesswork. The taxonomy itself lives in
     * scripts/lib/logger.ts so every stage answers a SQLSTATE the same way;
     * what is asserted here is that this stage consults it, and where.
     */
    describe('a database that will not serve the run', () => {
        const driverFailure = (code: string): Error => {
            // The shape node-postgres really throws: `name` is `'error'`, and
            // the SQLSTATE is on `code`. A real 53300 is driven through the
            // command itself by the CLI evidence for this finding; what matters
            // here is that the reporter answers it, and these two members are
            // what decides that.
            const error = new Error(`connection failure (${code})`);
            error.name = 'error';
            (error as unknown as { code: string }).code = code;

            return error;
        };

        it('names a refused connection rather than reporting a surprise', () => {
            const described = describeFailure(driverFailure('53300'));

            expect(described.code).toBe('database_unavailable');
            // The SQLSTATE survives beside the name, which is the one
            // machine-readable fact the driver supplied.
            expect(described.error).toEqual({ name: 'error', code: '53300' });
            expect(String(described.detail?.remedy)).toContain('connection limit');
        });

        it.each([
            ['3D000', 'database_missing', 'a database that does not exist'],
            ['28P01', 'database_authentication_failed', 'a rejected password'],
            ['42P01', 'database_error', 'a target that was never migrated'],
            ['ECONNREFUSED', 'database_unavailable', 'a target that refused the socket'],
        ])('reports %s as %s — %s', (code, expected) => {
            const described = describeFailure(driverFailure(code));

            expect(described.code).toBe(expected);
            expect(described.error.code).toBe(code);
            // Every one of the four carries a remedy that ends in an action.
            // Three of them name DATABASE_URL as the thing to correct;
            // `database_error` names the SQLSTATE table instead, because the
            // connection string is not what is wrong there.
            expect(String(described.detail?.remedy)).toContain('run the stage again');
        });

        it('names DATABASE_URL on the three failures an operator fixes there', () => {
            for (const code of ['53300', '3D000', '28P01']) {
                expect(String(describeFailure(driverFailure(code)).detail?.remedy)).toContain('DATABASE_URL');
            }
            // And sends a refused STATEMENT to the error-code table instead,
            // which is where that answer lives.
            expect(String(describeFailure(driverFailure('42P01')).detail?.remedy)).toContain(
                'PostgreSQL error-code table',
            );
        });

        // The clause the shared taxonomy cannot know, and the one place this
        // stage must NOT copy `catalog-import-usda.ts`: an import continues
        // from its checkpoint with `--resume`, and this stage has no such flag.
        // What it has instead is idempotency by slug, so the same command is
        // the whole recovery procedure — and the one thing that can delay it is
        // the interrupted attempt's own ledger lease.
        it('appends what re-running THIS stage actually does, and never an --resume it does not have', () => {
            const remedy = String(describeFailure(driverFailure('08006')).detail?.remedy);

            expect(remedy).toContain('needs no --resume');
            expect(remedy).toContain('idempotent by slug');
            expect(remedy).toContain('seed_in_progress');
            expect(remedy).toContain(`${RECIPE_SEED_RUN_LEASE_MS / 1000} seconds`);
        });

        it('gives the same answer when Prisma is the client that failed', () => {
            // Two clients reach this database on a seed — the lock sessions'
            // raw `pg` and the publication client's Prisma — and an operator's
            // fix does not depend on which one noticed.
            const prismaFailure = new Error('cannot reach database server');
            prismaFailure.name = 'PrismaClientInitializationError';
            (prismaFailure as unknown as { code: string }).code = 'P1001';

            expect(describeFailure(prismaFailure).code).toBe('database_unavailable');
        });

        it('does not file a Prisma query error as infrastructure', () => {
            // P2002 is a unique-constraint violation: on this stage that is a
            // corpus or a publication defect wearing a database code — two
            // recipe files claiming one slug, or a promotion racing itself —
            // and reporting it under the one heading an operator reads as "not
            // your code" would send them to the wrong place.
            const violation = new Error('unique constraint failed on recipes.slug');
            violation.name = 'PrismaClientKnownRequestError';
            (violation as unknown as { code: string }).code = 'P2002';

            const described = describeFailure(violation);

            expect(described.code).toBe('unexpected_error');
            // The code is still reported, because `safeError` carries it: the
            // operator is told P2002 and told that the stage did not classify
            // it, which is the honest pair.
            expect(described.error.code).toBe('P2002');
            expect(described.detail?.remedy).toBe(UNEXPECTED_FAILURE_REMEDY);
        });

        it('reports no driver prose on any of them, so the widening cost nothing', () => {
            // The remedy is fixed prose from this repository and the SQLSTATE is
            // five characters the driver assigned. Neither is vendor text, and
            // the driver's own sentence — which quotes the database name and,
            // on a connection failure, the target it could not reach — is still
            // absent.
            const described = describeFailure(driverFailure('3D000'));

            expect(described.error).not.toHaveProperty('message');
            expect(JSON.stringify(described)).not.toContain('connection failure');
            expect(Object.keys(described.detail ?? {})).toEqual(['remedy']);
        });

        it('classifies nothing that is not a database failure, so the arm cannot swallow the ladder', () => {
            // Anti-vacuity from the other side: the classifier is what decides
            // whether this arm runs at all, and it must return null for the
            // classes above it. Typed as its own return type so the comparisons
            // below are the real narrowing the production code performs.
            const unclassified: ReturnType<typeof classifyInfrastructureFailure> =
                classifyInfrastructureFailure(new RecipeSeedError('recipes_invalid', 'bad'));

            expect(unclassified).toBeNull();
            expect(classifyInfrastructureFailure(new Error('boom'))).toBeNull();
            expect(classifyInfrastructureFailure(driverFailure('53300'))).not.toBeNull();
        });
    });

    /**
     * The arms that forward their OWN sentence, and the one that must not.
     *
     * `safeError` carries no `message` because that field is where a driver's
     * connection string or a vendor's document reaches a log (CWE-532). That
     * rule is about text this repository did not author. A seed refusal is the
     * opposite case: it names the recipe file, the declared field that
     * disagreed with the derivation and the ingredient `source_key` that could
     * not be resolved — §0.7.3's "fails loudly with the offending recipe and
     * ingredient" — so it travels under its own member, scrubbed and bounded,
     * at the sites that have already narrowed to a first-party class.
     * `DatabaseOriginError` is first-party too and is still withheld, because
     * its sentence is the host and database the guard refused.
     */
    describe('the sentences a first-party failure is allowed to carry', () => {
        it('names the file and the unresolvable ingredient a seed refusal was about', () => {
            const described = describeFailure(
                new RecipeSeedError('recipes_invalid', '1 problem in the selected recipe files; nothing was published', [
                    'tofu-broccoli-bowl (recipes/tofu-broccoli-bowl.json): ingredient "test:sesame-oil" resolves to no catalog_foods row; load the catalog release that carries it',
                ]),
            );

            expect(described.detail?.problemCount).toBe(1);
            expect(String(described.detail?.firstPartyMessage)).toContain('recipes/tofu-broccoli-bowl.json');
            expect(String(described.detail?.firstPartyMessage)).toContain('test:sesame-oil');
        });

        it('omits the count for a refusal that carries no defect list', () => {
            // Absent rather than `0`: the omit-when-absent convention
            // `safeError` follows, so a member that never existed does not read
            // as one that was lost.
            expect(describeFailure(new RecipeSeedError('unknown_slug', '--only named no file'))).toEqual({
                code: 'unknown_slug',
                error: { name: 'RecipeSeedError', code: 'unknown_slug' },
                detail: { firstPartyMessage: '--only named no file' },
            });
        });

        it('scrubs that sentence even though this repository wrote it', () => {
            // The narrowing obligation is not the only defence: a first-party
            // message can still interpolate a DSN, and `run_ledger_unavailable`
            // is exactly the refusal whose author might reach for one.
            const described = describeFailure(
                new RecipeSeedError('run_ledger_unavailable', 'cannot record the run through postgresql://user:pa@ss@localhost:5433/db'),
            );
            const forwarded = String(described.detail?.firstPartyMessage);

            expect(forwarded).toBe('cannot record the run through postgresql://***@localhost:5433/db');
            // Aimed at the forwarded VALUE, because the credential's fragments
            // are short: `ss` occurs in the key `firstPartyMessage` itself, so
            // asserting over the rendered document would be an assertion about
            // this member's NAME rather than about the password.
            for (const fragment of ['pa@ss', 'pa', 'ss', 'user:', 'user']) {
                expect(forwarded).not.toContain(fragment);
            }
            for (const fragment of ['pa@ss', 'user:', ':pa']) {
                expect(JSON.stringify(described)).not.toContain(fragment);
            }
        });

        it('carries a manifest refusal\'s sentence, which is the half an operator acts on', () => {
            const described = describeFailure(
                new ManifestError(
                    'version_mismatch',
                    'data/meal-planning/coverage-plan.v1.json declares coveragePlanVersion v2, expected v1',
                ),
            );

            expect(described.code).toBe('version_mismatch');
            expect(described.detail?.firstPartyMessage).toBe(
                'data/meal-planning/coverage-plan.v1.json declares coveragePlanVersion v2, expected v1',
            );
        });

        it('withholds a database-origin refusal\'s sentence, because it names the target', () => {
            const described = describeFailure(
                new DatabaseOriginError(
                    'recipes-seed refuses database "state_of_health" on host "db.example.com"',
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
    });
});
