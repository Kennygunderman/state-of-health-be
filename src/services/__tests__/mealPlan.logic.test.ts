// Unit tests for the planning rules. No database, no mocks, no clock: every
// rule takes its data as arguments, "today" is always passed in, and the only
// randomness is the seeded stream the module derives itself — so each test
// states a whole scenario and asserts a returned value.
//
// Five fixtures carry most of the weight, because each pins a property a future
// change could plausibly "simplify" away:
//
//  * the TIE fixture — equal scores must be separated by the shuffle rank and
//    by nothing else;
//  * the GREEDY DEAD-END fixture — the best-scored prefix of a day leaves no
//    valid last slot, and the day must still be found;
//  * the WEEK-LEVEL fixture — a catalog no day-by-day pass can solve, proven
//    against a reference solver that backtracks inside a day but never revisits
//    one, so completing the week can only have come from backtracking into an
//    EARLIER DAY;
//  * the BUDGET fixture — running out of evaluations is a feasibility verdict,
//    never a server error;
//  * the INFEASIBLE-RETRY fixture — retrying changes nothing, because the
//    idempotency key cannot reach the seed; only a preference change can.
//
// Recipe nutrition is built with `proportional`, which keeps every recipe on the
// target's own macro ratio. That collapses the four-dimensional day tolerance
// into a single calorie window — day totals in [1800, 2200] against the 2,000
// kcal target below — so a fixture can be reasoned about exactly instead of
// approximately. Tests that exercise the tolerance bands themselves do not use
// it, and assert each band directly.

import { readFileSync } from 'fs';
import { join } from 'path';

import {
    BUDGET_TIER_1_MAX_PER_MEAL,
    BUDGET_TIER_2_MAX_PER_MEAL,
    CALORIE_TOLERANCE_RATIO,
    DEFAULT_PORTION_POLICY,
    EXTENDED_PORTION_POLICY,
    GeneratedPlan,
    MACRO_TOLERANCE_ABSOLUTE_G,
    MACRO_TOLERANCE_RATIO,
    MAIN_SLOT_PORTION_MULTIPLIERS,
    MAX_EVALUATIONS_PER_DAY,
    MAX_EVALUATIONS_PER_PLAN,
    MAX_RECIPE_USES_PER_WEEK,
    MEAL_PLAN_FIELD_CODES,
    MIN_ELIGIBLE_RECIPES_PER_SLOT,
    MealPlanInputError,
    PLAN_DAY_COUNT,
    PROTEIN_TOLERANCE_OVER_G,
    PROTEIN_TOLERANCE_UNDER_G,
    PlanCandidate,
    PlanGenerationPreferences,
    PlanRecipeCandidate,
    PlanSearchBudget,
    PlanSearchOutcome,
    PlannedMealAssignment,
    PlanSeedInputs,
    REUSE_BONUS_CAP,
    SNACK_PORTION_MULTIPLIERS,
    ScoredCandidate,
    addDaysToDayKey,
    analyzeLimitingConstraints,
    baselineCandidateRanks,
    budgetPenalty,
    buildPlanCandidates,
    candidatesForSlot,
    checkStartDateWindow,
    compareCandidateMoves,
    computeDayTotals,
    daysBetweenDayKeys,
    derivePlanSeed,
    derivePortionUnit,
    eligibleRecipeCountForSlot,
    evaluateDayTolerance,
    findOverlappingActivePlan,
    findUpcomingActivePlan,
    generateWeeklyPlan,
    isDayKey,
    isDayWithinTolerance,
    isPlanActiveStatus,
    isPlanEnded,
    isPlanWritable,
    localDayKey,
    nextCookingTimeTier,
    parseAffectedMealsPath,
    parseGeneratePlanRequest,
    parseGeneratePlanSyntax,
    parseMealPlanDayPath,
    parseRegeneratePlanRequest,
    parseRegenerateRequest,
    planCandidateIdentity,
    planDatesFrom,
    planEndDate,
    plansOverlap,
    portableCandidateIdentity,
    portionMultipliersForSlot,
    requireNonConflictingWeek,
    requireWritablePlan,
    resolveCurrentAndUpcoming,
    resolveReportedTargets,
    resolveSlotSchedule,
    resolveUserBudgetTier,
    reuseBonus,
    sameMacroTotals,
    scoreCandidate,
    scheduleCumulativeShares,
    scheduleSlots,
    searchPlanWeek,
    startDateWindow,
    targetProximity,
    toPlanningPreferences,
    violatesRepetitionRule,
} from '../mealPlan.logic';
// The DTO boundary these rules feed: the mapper composes `derivePortionUnit`
// into `portionText` and delegates the display round, so the rule and the
// string or number it produces are asserted together at the end of this file.
// Both modules are pure, so nothing is mocked.
import {
    MealPlanMappingError,
    PlanMealRow,
    formatPortionText,
    groupLoggedPlannedEntries,
    readPlannedTotals,
    readTargetsSnapshot,
    toMealPlanDayResponse,
    toMealPlanMealResponse,
    toPlanLifecycleState,
} from '../mealPlan.mapper';
import { RecipeVersionRow } from '../recipe.mapper';
// The grocery side of the plan -> grocery gram hop asserted at the end of this
// file. Both modules are pure, so nothing is mocked.
import { plannedIngredientGrams } from '../grocery.logic';
// The one bound every revision parser in this layer shares, imported from the
// module that publishes it rather than restated as a literal here.
import { MAX_REVISION } from '../preferences.logic';
import {
    NoMatchingMealsError,
    PlanGenerationError,
    PlanNotActiveError,
    PlanOverlapError,
    UpcomingExistsError,
} from '../mealPlanning.errors';
// The seed's one consumer, imported to prove the derived number is a number the
// generator can actually draw from. The PRNG itself is tested in
// `src/utils/__tests__/seededRandom.test.ts`, not here.
import { mulberry32 } from '../../utils/seededRandom';
import type { MealPlanMacroTotals, MealTimeEntry } from '../../types/mealPlanning';
import type { MealSlot } from '../../types/recipe';

/* ---------------------------------------------------------------------------
 * The shared fixture graph
 *
 * `data/meal-planning/fixtures/catalog-foods.fixture.json` and
 * `recipes.fixture.json` are the referentially closed pair the Agent Action
 * Plan §0.3.3 commits — fixed uuid keys, fixed timestamps, snake_case rows —
 * and they are the same rows the recipe, grocery and planned-log suites read.
 * `planCandidateOf` below turns one committed `recipe_versions` row into the
 * planner's own candidate shape without inventing a value, so version,
 * catalog-state, metadata and ingredient identity continue unbroken from the
 * recipe domain into this one.
 *
 * Read off disk rather than transcribed (the convention
 * `evidence.logic.test.ts` uses), and re-parsed per accessor so a case that
 * mutates a row cannot leak into the next.
 * ------------------------------------------------------------------------- */

const FIXTURE_DIRECTORY = join(__dirname, '..', '..', '..', 'data', 'meal-planning', 'fixtures');

const CATALOG_FOODS_JSON = readFileSync(join(FIXTURE_DIRECTORY, 'catalog-foods.fixture.json'), 'utf8');
const RECIPES_JSON = readFileSync(join(FIXTURE_DIRECTORY, 'recipes.fixture.json'), 'utf8');

/** The `catalog_foods` columns this suite reads back off the fixture. */
interface FixtureCatalogFood {
    id: string;
    source_key: string;
    display_name: string;
    food_group: string;
    publication_status: string;
}

/** The `recipe_versions` columns a planner candidate is built from. */
interface FixtureRecipeVersion {
    id: string;
    recipe_id: string;
    recipe_slug: string;
    version: number;
    yield_servings: number;
    total_minutes: number;
    meal_slots: MealSlot[];
    allergen_status: 'known' | 'unknown';
    budget_tier: number;
    nutrition_provenance: PlanRecipeCandidate['nutrition_provenance'];
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
    status: 'current' | 'retired';
}

/**
 * A `recipe_ingredients` row. `resolved_catalog_facts` is the fixture's
 * documented non-column field: the `catalog_foods` facts the table does not
 * snapshot, which is where the planner's `food_group` and the eligibility
 * check's `allergen_status` come from.
 */
interface FixtureRecipeIngredient {
    recipe_version_id: string;
    food_source_key: string;
    catalog_food_id: string;
    snapshot_name: string;
    snapshot_provenance: Ingredient['snapshot_provenance'];
    snapshot_allergen_tags: string[];
    snapshot_diet_tags: string[];
    gram_weight: number;
    sort_order: number;
    is_optional: boolean;
    resolved_catalog_facts: {
        allergen_status: 'known' | 'unknown';
        food_group: string;
        publication_status: string;
    };
}

interface CatalogFixtureDocument {
    foods: FixtureCatalogFood[];
}

interface RecipeFixtureDocument {
    counts: { recipe_versions: number; plannable_versions: number };
    recipe_versions: FixtureRecipeVersion[];
    recipe_ingredients: FixtureRecipeIngredient[];
}

const readCatalogFixture = (): CatalogFixtureDocument => JSON.parse(CATALOG_FOODS_JSON) as CatalogFixtureDocument;

const readRecipeFixture = (): RecipeFixtureDocument => JSON.parse(RECIPES_JSON) as RecipeFixtureDocument;

/** The catalog food with this `source_key`, or a failure naming the key. */
const catalogFood = (sourceKey: string): FixtureCatalogFood => {
    const food = readCatalogFixture().foods.find((row) => row.source_key === sourceKey);
    if (!food) {
        throw new Error(`catalog-foods.fixture.json carries no food with source_key ${sourceKey}`);
    }

    return food;
};

/** The `(slug, version)` recipe version, or a failure naming the pair. */
const recipeVersionRow = (slug: string, version: number): FixtureRecipeVersion => {
    const row = readRecipeFixture().recipe_versions.find(
        (candidate) => candidate.recipe_slug === slug && candidate.version === version,
    );
    if (!row) {
        throw new Error(`recipes.fixture.json carries no ${slug} v${version}`);
    }

    return row;
};

/** The ingredient rows of one fixture version, in the fixture's own row order. */
const fixtureIngredientRows = (slug: string, version: number): FixtureRecipeIngredient[] => {
    const versionId = recipeVersionRow(slug, version).id;
    const rows = readRecipeFixture().recipe_ingredients.filter((row) => row.recipe_version_id === versionId);
    if (rows.length === 0) {
        throw new Error(`recipes.fixture.json carries no ingredients for ${slug} v${version}`);
    }

    return rows;
};

/**
 * One committed version as a planner candidate. Every field is the fixture's;
 * `overrides` exists for the focused deltas a planner scenario needs — widening
 * `meal_slots` so one slot can be fed entirely by committed recipes is the only
 * use below, and it is stated at the call site.
 */
const planCandidateOf = (
    slug: string,
    version: number,
    overrides: Partial<PlanRecipeCandidate> = {},
): PlanRecipeCandidate => {
    const row = recipeVersionRow(slug, version);

    return {
        recipe_version_id: row.id,
        recipe_id: row.recipe_id,
        slug: row.recipe_slug,
        version: row.version,
        status: row.status,
        nutrition_provenance: row.nutrition_provenance,
        allergen_status: row.allergen_status,
        total_minutes: row.total_minutes,
        meal_slots: row.meal_slots,
        budget_tier: row.budget_tier,
        per_serving: {
            calories: row.per_serving_calories,
            protein: row.per_serving_protein_g,
            carbs: row.per_serving_carbs_g,
            fat: row.per_serving_fat_g,
        },
        ingredients: fixtureIngredientRows(slug, version).map(
            (ingredient): Ingredient => ({
                catalog_food_id: ingredient.catalog_food_id,
                snapshot_name: ingredient.snapshot_name,
                snapshot_provenance: ingredient.snapshot_provenance,
                snapshot_allergen_tags: ingredient.snapshot_allergen_tags,
                snapshot_diet_tags: ingredient.snapshot_diet_tags,
                is_optional: ingredient.is_optional,
                food_group: ingredient.resolved_catalog_facts.food_group,
                allergen_status: ingredient.resolved_catalog_facts.allergen_status,
            }),
        ),
        ...overrides,
    };
};

/** Every committed version as a planner candidate, retired one included. */
const fixtureCatalog = (): PlanRecipeCandidate[] =>
    readRecipeFixture().recipe_versions.map((row) => planCandidateOf(row.recipe_slug, row.version));

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

const TARGETS: MealPlanMacroTotals = { calories: 2000, protein: 150, carbs: 200, fat: 65 };

const START_DATE = '2026-07-05';

/** A recipe on the target's own macro ratio, so only its calories vary. */
const proportional = (calories: number): MealPlanMacroTotals => ({
    calories,
    protein: calories * (TARGETS.protein / TARGETS.calories),
    carbs: calories * (TARGETS.carbs / TARGETS.calories),
    fat: calories * (TARGETS.fat / TARGETS.calories),
});

type Ingredient = PlanRecipeCandidate['ingredients'][number];

interface RecipeSpec {
    slug: string;
    calories: number;
    /**
     * An explicit per-serving profile, for fixtures that need the day tolerance
     * to bind on more than calories. Omitted, the recipe sits on the target's
     * own ratio via {@link proportional}.
     */
    nutrition?: MealPlanMacroTotals;
    slots?: MealSlot[];
    version?: number;
    totalMinutes?: number;
    budgetTier?: number;
    ingredientIds?: string[];
    status?: 'current' | 'retired';
    provenance?: 'source_backed' | 'ingredient_derived' | 'ai_estimated';
    allergenTags?: string[];
    allergenStatus?: 'known' | 'unknown';
    dietTags?: string[];
    foodGroups?: string[];
}

/**
 * The focused-delta builder for the search mechanics: a slot's worth of
 * interchangeable recipes at chosen calories, which is what the tie, dead-end,
 * week-level and budget fixtures are made of.
 *
 * Its ingredient identities stay synthetic ON PURPOSE, and this is the one
 * place in the four domain suites where that is true. `reuseBonus` scores a
 * candidate by how many of its `catalog_food_id`s the day has already planned,
 * and the search applies it while choosing — so two mechanics recipes sharing a
 * food id would quietly change which candidate wins. These fixtures need
 * dozens of mutually disjoint ingredient sets; the shared catalog fixture
 * publishes twenty-four foods, so drawing from it would force collisions and
 * make a scoring fixture depend on which two recipes happened to collide.
 *
 * Everything about identity, version, catalog state and ingredient continuity
 * is therefore asserted against the committed graph instead, in "the committed
 * catalog and recipe graph" at the end of this file, where `planCandidateOf`
 * supplies real rows.
 */
const makeRecipe = (spec: RecipeSpec): PlanRecipeCandidate => {
    const ingredientIds = spec.ingredientIds ?? [`${spec.slug}-food`];
    const provenance = spec.provenance ?? 'source_backed';
    const allergenStatus = spec.allergenStatus ?? 'known';

    const ingredients: Ingredient[] = ingredientIds.map((catalogFoodId, index) => ({
        catalog_food_id: catalogFoodId,
        snapshot_name: catalogFoodId,
        snapshot_provenance: provenance,
        snapshot_allergen_tags: spec.allergenTags ?? [],
        snapshot_diet_tags: spec.dietTags ?? ['vegan'],
        is_optional: false,
        food_group: spec.foodGroups?.[index] ?? `${catalogFoodId}-group`,
        allergen_status: allergenStatus,
    }));

    return {
        recipe_version_id: `${spec.slug}-version-${spec.version ?? 1}`,
        recipe_id: `${spec.slug}-recipe`,
        slug: spec.slug,
        version: spec.version ?? 1,
        status: spec.status ?? 'current',
        nutrition_provenance: provenance,
        allergen_status: allergenStatus,
        total_minutes: spec.totalMinutes ?? 20,
        meal_slots: spec.slots ?? ['breakfast', 'lunch', 'dinner', 'snack'],
        ingredients,
        budget_tier: spec.budgetTier ?? 1,
        per_serving: spec.nutrition ?? proportional(spec.calories),
    };
};

const THREE_MEAL_TIMES: MealTimeEntry[] = [
    { slot: 'breakfast', time: '08:00' },
    { slot: 'lunch', time: '12:30' },
    { slot: 'dinner', time: '18:30' },
];

const SNACK_MEAL_TIMES: MealTimeEntry[] = [
    ...THREE_MEAL_TIMES,
    { slot: 'snack', time: '15:30' },
];

const makePreferences = (
    overrides: Partial<PlanGenerationPreferences> = {},
): PlanGenerationPreferences => ({
    diet: null,
    allergens: [],
    disliked_food_ids: [],
    disliked_food_groups: [],
    cooking_time_limit_min: null,
    meal_schedule: 'three',
    meal_times: THREE_MEAL_TIMES,
    budget: null,
    no_budget_preference: true,
    ...overrides,
});

const makeSeedInputs = (overrides: Partial<PlanSeedInputs> = {}): PlanSeedInputs => ({
    userId: 'user-1',
    startDate: START_DATE,
    preferencesRevision: 3,
    targetsRevision: 2,
    generationAttempt: 1,
    ...overrides,
});

/** Four interchangeable recipes per main slot; every day sums to exactly 2,000. */
const feasibleCatalog = (): PlanRecipeCandidate[] => [
    ...['b1', 'b2', 'b3', 'b4'].map((slug) =>
        makeRecipe({ slug, slots: ['breakfast'], calories: 500 }),
    ),
    ...['l1', 'l2', 'l3', 'l4'].map((slug) => makeRecipe({ slug, slots: ['lunch'], calories: 700 })),
    ...['d1', 'd2', 'd3', 'd4'].map((slug) => makeRecipe({ slug, slots: ['dinner'], calories: 800 })),
];

/** Every `(slug, version, portionMultiplier)` triple the plan placed, per slot. */
const portableIdentities = (plan: GeneratedPlan): string[] =>
    plan.days.flatMap((day) =>
        day.meals.map(
            (meal) => `${day.dayIndex}:${meal.slot}:${meal.slug}:${meal.version}:${meal.portionMultiplier}`,
        ),
    );

const plannedCalories = (plan: GeneratedPlan): number[] =>
    plan.days.map((day) => day.plannedTotals.calories);

const scored = (candidate: PlanCandidate, score: number): ScoredCandidate => ({ candidate, score });

const zeroTotals: MealPlanMacroTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };

const plan = (
    recipes: PlanRecipeCandidate[],
    preferences: PlanGenerationPreferences = makePreferences(),
    seedInputs: PlanSeedInputs = makeSeedInputs(),
    shouldAbort?: () => boolean,
): GeneratedPlan =>
    generateWeeklyPlan({ seedInputs, preferences, targets: TARGETS, recipes, shouldAbort });

/**
 * The same week `generateWeeklyPlan` runs, exposed as the search's own outcome.
 *
 * Assembled from the module's exported pieces exactly as generation assembles
 * them, so a fixture driven through here is the fixture generation would have
 * run — the only difference is that the evaluation guards, the frontier and the
 * evaluation count are readable instead of collapsed into a thrown error.
 */
const searchFor = (
    recipes: PlanRecipeCandidate[],
    budget?: PlanSearchBudget,
    preferences: PlanGenerationPreferences = makePreferences(),
): PlanSearchOutcome => {
    const seedInputs = makeSeedInputs();
    const slots = resolveSlotSchedule(preferences.meal_schedule, preferences.meal_times);
    const candidates = buildPlanCandidates(recipes, preferences, derivePlanSeed(seedInputs));
    const candidatesBySlot = new Map(
        slots.map((slot) => [slot.slot, candidatesForSlot(candidates, preferences, slot.slot)] as const),
    );

    return searchPlanWeek({
        dates: planDatesFrom(seedInputs.startDate),
        slots,
        candidatesBySlot,
        targets: TARGETS,
        userBudgetTier: resolveUserBudgetTier(
            preferences.budget,
            preferences.no_budget_preference,
            preferences.meal_schedule,
        ),
        budget,
    });
};

/* ---------------------------------------------------------------------------
 * derivePlanSeed — the reduction, and what may not reach it
 * ------------------------------------------------------------------------- */

describe('derivePlanSeed', () => {
    it('is stable for identical inputs', () => {
        expect(derivePlanSeed(makeSeedInputs())).toBe(derivePlanSeed(makeSeedInputs()));
    });

    it('pins the documented reduction, so an "improvement" to it fails here', () => {
        // SHA-1 of 'user-1|2026-07-05|3|2|1', first four bytes big-endian.
        expect(derivePlanSeed(makeSeedInputs())).toBe(0x80cd7adb);
    });

    it('returns an unsigned 32-bit integer', () => {
        const seed = derivePlanSeed(makeSeedInputs());

        expect(Number.isInteger(seed)).toBe(true);
        expect(seed).toBeGreaterThanOrEqual(0);
        expect(seed).toBeLessThanOrEqual(0xffffffff);
    });

    it('is a seed the generator can draw from, not a digest it would have to parse', () => {
        const draw = mulberry32(derivePlanSeed(makeSeedInputs()))();

        expect(Number.isFinite(draw)).toBe(true);
        expect(draw).toBeGreaterThanOrEqual(0);
        expect(draw).toBeLessThan(1);
    });

    it('replays one stream for one set of inputs and another for a changed one', () => {
        const streamFor = (overrides: Partial<PlanSeedInputs> = {}): number[] => {
            const draw = mulberry32(derivePlanSeed(makeSeedInputs(overrides)));

            return [draw(), draw(), draw()];
        };

        expect(streamFor()).toEqual(streamFor());
        expect(streamFor({ generationAttempt: 2 })).not.toEqual(streamFor());
    });

    it.each([
        ['userId', { userId: 'user-2' }],
        ['startDate', { startDate: '2026-07-12' }],
        ['preferencesRevision', { preferencesRevision: 4 }],
        ['targetsRevision', { targetsRevision: 3 }],
        ['generationAttempt', { generationAttempt: 2 }],
    ])('changes when %s changes', (_field, override: Partial<PlanSeedInputs>) => {
        expect(derivePlanSeed(makeSeedInputs(override))).not.toBe(derivePlanSeed(makeSeedInputs()));
    });

    it('ignores any property that is not one of the five inputs, so no key can reach it', () => {
        const withKey = {
            ...makeSeedInputs(),
            idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
        } as PlanSeedInputs;
        const withAnotherKey = {
            ...makeSeedInputs(),
            idempotencyKey: 'c3a9b2d1-4e5f-4a6b-8c7d-9e0f1a2b3c4d',
        } as PlanSeedInputs;

        expect(derivePlanSeed(withKey)).toBe(derivePlanSeed(makeSeedInputs()));
        expect(derivePlanSeed(withKey)).toBe(derivePlanSeed(withAnotherKey));
    });
});

/* ---------------------------------------------------------------------------
 * Candidates — portable pre-order and one seeded walk
 * ------------------------------------------------------------------------- */

describe('buildPlanCandidates', () => {
    const seed = derivePlanSeed(makeSeedInputs());

    it('produces one candidate per eligible recipe and multiplier', () => {
        const candidates = buildPlanCandidates(feasibleCatalog(), makePreferences(), seed);

        expect(candidates).toHaveLength(12 * MAIN_SLOT_PORTION_MULTIPLIERS.length);
    });

    it('returns candidates in portable identity order, never in input order', () => {
        const candidates = buildPlanCandidates(
            [
                makeRecipe({ slug: 'zucchini-bake', calories: 500 }),
                makeRecipe({ slug: 'apple-oats', calories: 500, version: 2 }),
                makeRecipe({ slug: 'apple-oats', calories: 500, version: 1 }),
            ],
            makePreferences(),
            seed,
        );

        const identities = candidates.map(
            (candidate) =>
                `${candidate.recipe.slug}:${candidate.recipe.version}:${candidate.portionMultiplier}`,
        );

        expect(identities[0]).toBe('apple-oats:1:0.5');
        expect(identities[MAIN_SLOT_PORTION_MULTIPLIERS.length]).toBe('apple-oats:2:0.5');
        expect(identities[identities.length - 1]).toBe('zucchini-bake:1:2');
    });

    it('assigns every candidate a distinct shuffle rank covering 0..n-1', () => {
        const candidates = buildPlanCandidates(feasibleCatalog(), makePreferences(), seed);
        const ranks = candidates.map((candidate) => candidate.shuffleRank).sort((a, b) => a - b);

        expect(ranks).toEqual(candidates.map((_candidate, index) => index));
    });

    it('scales per-serving nutrition by the multiplier at full precision', () => {
        const candidates = buildPlanCandidates(
            [makeRecipe({ slug: 'b1', calories: 500 })],
            makePreferences(),
            seed,
        );
        const half = candidates.find((candidate) => candidate.portionMultiplier === 0.5);

        expect(half?.nutrition).toEqual(proportional(250));
    });

    it('drops recipes eligibility refuses, delegating every clause to recipe.logic', () => {
        const preferences = makePreferences({
            diet: 'vegan',
            allergens: ['Milk'],
            disliked_food_ids: ['disliked-food'],
            disliked_food_groups: ['disliked-group'],
            cooking_time_limit_min: 30,
        });

        const recipes = [
            makeRecipe({ slug: 'keeper', calories: 500 }),
            makeRecipe({ slug: 'retired', calories: 500, status: 'retired' }),
            makeRecipe({ slug: 'estimated', calories: 500, provenance: 'ai_estimated' }),
            makeRecipe({ slug: 'unreviewed', calories: 500, allergenStatus: 'unknown' }),
            makeRecipe({ slug: 'milky', calories: 500, allergenTags: ['milk'] }),
            makeRecipe({ slug: 'not-vegan', calories: 500, dietTags: ['pescatarian'] }),
            makeRecipe({ slug: 'disliked-id', calories: 500, ingredientIds: ['disliked-food'] }),
            makeRecipe({ slug: 'disliked-group', calories: 500, foodGroups: ['disliked-group'] }),
            makeRecipe({ slug: 'too-slow', calories: 500, totalMinutes: 45 }),
        ];

        const slugs = new Set(
            buildPlanCandidates(recipes, preferences, seed).map((candidate) => candidate.recipe.slug),
        );

        expect([...slugs]).toEqual(['keeper']);
    });

    it('gives a different shuffle for a different seed', () => {
        const preferences = makePreferences();
        const first = buildPlanCandidates(feasibleCatalog(), preferences, seed);
        const second = buildPlanCandidates(
            feasibleCatalog(),
            preferences,
            derivePlanSeed(makeSeedInputs({ generationAttempt: 2 })),
        );

        expect(second.map((candidate) => candidate.shuffleRank)).not.toEqual(
            first.map((candidate) => candidate.shuffleRank),
        );
    });

    it('assigns the same rank to the same identity however the input was ordered', () => {
        const preferences = makePreferences();
        const forward = feasibleCatalog();
        const reversed = [...forward].reverse();

        const rankByIdentity = (recipes: PlanRecipeCandidate[]): Record<string, number> => {
            const ranks: Record<string, number> = {};

            for (const candidate of buildPlanCandidates(recipes, preferences, seed)) {
                ranks[`${candidate.recipe.slug}:${candidate.portionMultiplier}`] = candidate.shuffleRank;
            }

            return ranks;
        };

        expect(rankByIdentity(reversed)).toEqual(rankByIdentity(forward));
    });

    describe('baseline ranks — what a counterfactual probe may not move', () => {
        // One recipe the user's 30-minute limit refuses, so the relaxed set is
        // the baseline plus exactly one recipe's worth of candidates. Every
        // shared candidate must come out on the rank it already had: a probe
        // whose shared candidates were reshuffled can succeed on the
        // baseline's own candidates in a new move order, and the analysis would
        // then blame the relaxed preference for a week it had no part in.
        const catalog = (): PlanRecipeCandidate[] => [
            ...feasibleCatalog(),
            makeRecipe({ slug: 'slow-dinner', slots: ['dinner'], calories: 800, totalMinutes: 45 }),
        ];

        const restricted = makePreferences({ cooking_time_limit_min: 30 });
        const relaxed = makePreferences({ cooking_time_limit_min: 45 });

        it('keeps every shared identity on its exact baseline rank', () => {
            const baseline = buildPlanCandidates(catalog(), restricted, seed);
            const baselineRanks = baselineCandidateRanks(baseline);
            const widened = buildPlanCandidates(
                catalog(),
                relaxed,
                seed,
                DEFAULT_PORTION_POLICY,
                baselineRanks,
            );

            const shared = widened.filter((candidate) =>
                baselineRanks.has(planCandidateIdentity(candidate)),
            );

            expect(shared).toHaveLength(baseline.length);

            for (const candidate of shared) {
                expect(candidate.shuffleRank).toBe(baselineRanks.get(planCandidateIdentity(candidate)));
            }
        });

        it('ranks the newcomers, and only the newcomers, above every baseline rank', () => {
            const baseline = buildPlanCandidates(catalog(), restricted, seed);
            const baselineRanks = baselineCandidateRanks(baseline);
            const highestBaselineRank = Math.max(
                ...baseline.map((candidate) => candidate.shuffleRank),
            );
            const widened = buildPlanCandidates(
                catalog(),
                relaxed,
                seed,
                DEFAULT_PORTION_POLICY,
                baselineRanks,
            );

            const newcomerRanks = widened
                .filter((candidate) => !baselineRanks.has(planCandidateIdentity(candidate)))
                .map((candidate) => candidate.shuffleRank);

            // The one recipe the limit refused, at every main-slot multiplier.
            expect(newcomerRanks).toHaveLength(MAIN_SLOT_PORTION_MULTIPLIERS.length);
            expect(new Set(newcomerRanks).size).toBe(newcomerRanks.length);

            for (const rank of newcomerRanks) {
                expect(rank).toBeGreaterThan(highestBaselineRank);
            }
        });

        it('keeps the extended portion set stable on the multipliers it shares', () => {
            const baseline = buildPlanCandidates(feasibleCatalog(), makePreferences(), seed);
            const baselineRanks = baselineCandidateRanks(baseline);
            const extended = buildPlanCandidates(
                feasibleCatalog(),
                makePreferences(),
                seed,
                EXTENDED_PORTION_POLICY,
                baselineRanks,
            );

            for (const candidate of extended) {
                const identity = planCandidateIdentity(candidate);

                if (baselineRanks.has(identity)) {
                    expect(candidate.shuffleRank).toBe(baselineRanks.get(identity));
                } else {
                    expect(MAIN_SLOT_PORTION_MULTIPLIERS).not.toContain(candidate.portionMultiplier);
                    expect(candidate.shuffleRank).toBeGreaterThan(baseline.length - 1);
                }
            }
        });

        it('assigns the ranks generation assigns when there is no baseline to keep', () => {
            // The generation path is the no-baseline path, and an empty map is
            // the same thing said explicitly — so neither may drift from the
            // single seeded walk that defines a plan.
            const withoutBaseline = buildPlanCandidates(feasibleCatalog(), makePreferences(), seed);
            const withEmptyBaseline = buildPlanCandidates(
                feasibleCatalog(),
                makePreferences(),
                seed,
                DEFAULT_PORTION_POLICY,
                new Map<string, number>(),
            );

            expect(withEmptyBaseline.map((candidate) => candidate.shuffleRank)).toEqual(
                withoutBaseline.map((candidate) => candidate.shuffleRank),
            );
        });

        it('spells one identity for a candidate and for a meal the search placed', () => {
            const [candidate] = buildPlanCandidates(
                [makeRecipe({ slug: 'b1', slots: ['breakfast'], calories: 500 })],
                makePreferences(),
                seed,
            );

            expect(planCandidateIdentity(candidate)).toBe(
                portableCandidateIdentity(
                    candidate.recipe.slug,
                    candidate.recipe.version,
                    candidate.portionMultiplier,
                ),
            );
            expect(planCandidateIdentity(candidate)).toBe('b1|1|0.5');
        });
    });

    it('widens the candidate set when asked for the extended portion policy', () => {
        const candidates = buildPlanCandidates(
            [makeRecipe({ slug: 'b1', calories: 500 })],
            makePreferences(),
            seed,
            EXTENDED_PORTION_POLICY,
        );

        expect(candidates.map((candidate) => candidate.portionMultiplier)).toEqual(
            EXTENDED_PORTION_POLICY.mainSlot,
        );
    });
});

describe('portionMultipliersForSlot', () => {
    it('narrows a snack to its own set', () => {
        expect(portionMultipliersForSlot('snack')).toEqual(SNACK_PORTION_MULTIPLIERS);
    });

    it.each<MealSlot>(['breakfast', 'lunch', 'dinner'])('gives %s the main set', (slot) => {
        expect(portionMultipliersForSlot(slot)).toEqual(MAIN_SLOT_PORTION_MULTIPLIERS);
    });

    it('reads the set from a supplied policy', () => {
        expect(portionMultipliersForSlot('snack', EXTENDED_PORTION_POLICY)).toEqual(
            EXTENDED_PORTION_POLICY.snack,
        );
    });
});

describe('candidatesForSlot', () => {
    const seed = derivePlanSeed(makeSeedInputs());

    it('keeps only recipes that declare the slot', () => {
        const candidates = buildPlanCandidates(feasibleCatalog(), makePreferences(), seed);
        const slugs = new Set(
            candidatesForSlot(candidates, makePreferences(), 'lunch').map(
                (candidate) => candidate.recipe.slug,
            ),
        );

        expect([...slugs].sort()).toEqual(['l1', 'l2', 'l3', 'l4']);
    });

    it('restricts a snack slot to the snack multipliers', () => {
        const candidates = buildPlanCandidates(
            [makeRecipe({ slug: 'nibble', calories: 250, slots: ['snack'] })],
            makePreferences(),
            seed,
        );
        const multipliers = candidatesForSlot(candidates, makePreferences(), 'snack').map(
            (candidate) => candidate.portionMultiplier,
        );

        expect(multipliers).toEqual([...SNACK_PORTION_MULTIPLIERS]);
    });
});

describe('eligibleRecipeCountForSlot', () => {
    const seed = derivePlanSeed(makeSeedInputs());

    it('counts distinct recipes rather than candidates', () => {
        const candidates = buildPlanCandidates(feasibleCatalog(), makePreferences(), seed);

        expect(eligibleRecipeCountForSlot(candidates, makePreferences(), 'dinner')).toBe(4);
    });

    it('is zero for a slot nothing declares', () => {
        const candidates = buildPlanCandidates(feasibleCatalog(), makePreferences(), seed);

        expect(eligibleRecipeCountForSlot(candidates, makePreferences(), 'snack')).toBe(0);
    });
});

/* ---------------------------------------------------------------------------
 * Repetition — hard, backward-looking, and never a score penalty
 * ------------------------------------------------------------------------- */

describe('violatesRepetitionRule', () => {
    const none: ReadonlySet<string> = new Set<string>();

    it('allows a first and a second use', () => {
        expect(violatesRepetitionRule('r', 0, none, none)).toBe(false);
        expect(violatesRepetitionRule('r', 1, none, none)).toBe(false);
    });

    it('refuses a third use at exactly the weekly cap', () => {
        expect(violatesRepetitionRule('r', MAX_RECIPE_USES_PER_WEEK, none, none)).toBe(true);
    });

    it('refuses a recipe used yesterday', () => {
        expect(violatesRepetitionRule('r', 1, new Set(['r']), none)).toBe(true);
    });

    it('ignores other recipes in either day', () => {
        expect(violatesRepetitionRule('r', 0, new Set(['other']), new Set(['another']))).toBe(false);
    });

    describe('§0.7.3 is two clauses — the same day is not a third', () => {
        // The rule the AAP states is "at most twice in the week and never on
        // consecutive days". Twice in ONE day, in two different slots, breaks
        // neither, and refusing it turned feasible weeks into
        // `no_matching_meals`.
        it('permits a second use on the day a recipe is already placed', () => {
            expect(violatesRepetitionRule('r', 1, none)).toBe(false);
        });

        it('still refuses the third use, wherever the first two fell', () => {
            expect(violatesRepetitionRule('r', MAX_RECIPE_USES_PER_WEEK, none)).toBe(true);
        });

        it('still refuses a same-day second use when yesterday holds the recipe', () => {
            // The spacing clause is independent of the cap: a recipe on day
            // n − 1 is refused on day n whether or not day n already holds it.
            expect(violatesRepetitionRule('r', 1, new Set(['r']))).toBe(true);
        });
    });

    describe('the optional caller-supplied exclusion set', () => {
        // A caller-chosen exclusion outside §0.7.3 that NO CURRENT CALLER
        // PASSES: the generator omits it, and so does `swap.logic.ts`, which
        // applies the same two clauses to the week with the meal being replaced
        // removed and narrows nothing further. Both halves of the parameter are
        // pinned here anyway — the exclusion it applies and the empty default —
        // so a caller that ever needs one inherits a tested rule instead of
        // spelling the repetition rule a second time.
        it('excludes a recipe the caller names, inside the rule', () => {
            expect(violatesRepetitionRule('r', 0, none, new Set(['r']))).toBe(true);
        });

        it('defaults to excluding nothing when the caller omits it', () => {
            expect(violatesRepetitionRule('r', 0, none)).toBe(false);
            expect(violatesRepetitionRule('r', 1, new Set(['other']))).toBe(false);
        });
    });
});

/* ---------------------------------------------------------------------------
 * Scoring — order only
 * ------------------------------------------------------------------------- */

describe('targetProximity', () => {
    it('is zero when the day so far sits exactly on its guidance point', () => {
        expect(targetProximity(proportional(500), TARGETS, 0.25)).toBeCloseTo(0, 12);
    });

    it('sums the four relative gaps', () => {
        // 1,000 kcal against a 0.6 share of 2,000 is 200 short on every axis
        // proportionally, i.e. 0.1 per term.
        expect(targetProximity(proportional(1000), TARGETS, 0.6)).toBeCloseTo(0.4, 12);
    });

    it('is symmetric about the guidance point', () => {
        expect(targetProximity(proportional(1400), TARGETS, 0.6)).toBeCloseTo(
            targetProximity(proportional(1000), TARGETS, 0.6),
            12,
        );
    });

    it.each(['calories', 'protein', 'carbs', 'fat'] as const)(
        'refuses a non-positive %s target rather than scoring everything Infinity',
        (field) => {
            expect(() => targetProximity(proportional(500), { ...TARGETS, [field]: 0 }, 0.25)).toThrow(
                MealPlanInputError,
            );
        },
    );
});

describe('budgetPenalty', () => {
    it('penalises one tier per band above the user', () => {
        expect(budgetPenalty(3, 1)).toBe(2);
    });

    it('does not reward a cheaper recipe', () => {
        expect(budgetPenalty(1, 3)).toBe(0);
    });

    it('is zero on the band itself', () => {
        expect(budgetPenalty(2, 2)).toBe(0);
    });
});

describe('reuseBonus', () => {
    const candidateWith = (ingredientIds: string[]): PlanCandidate =>
        buildPlanCandidates(
            [makeRecipe({ slug: 'shared', calories: 500, ingredientIds })],
            makePreferences(),
            1,
        )[0];

    it('counts ingredients already on the list', () => {
        expect(reuseBonus(candidateWith(['a', 'b', 'c']), new Set(['a', 'c']))).toBe(2);
    });

    it('counts a repeated ingredient once', () => {
        expect(reuseBonus(candidateWith(['a', 'a', 'a']), new Set(['a']))).toBe(1);
    });

    it('caps the bonus', () => {
        const ids = ['a', 'b', 'c', 'd', 'e', 'f'];

        expect(reuseBonus(candidateWith(ids), new Set(ids))).toBe(REUSE_BONUS_CAP);
    });

    it('is zero when nothing is shared', () => {
        expect(reuseBonus(candidateWith(['a']), new Set(['z']))).toBe(0);
    });
});

describe('scoreCandidate', () => {
    const candidate = (spec: RecipeSpec): PlanCandidate =>
        buildPlanCandidates([makeRecipe(spec)], makePreferences(), 1).filter(
            (built) => built.portionMultiplier === 1,
        )[0];

    it('is the weighted sum of proximity, budget penalty and reuse bonus', () => {
        const subject = candidate({ slug: 'x', calories: 500, budgetTier: 3, ingredientIds: ['a', 'b'] });

        const score = scoreCandidate(subject, zeroTotals, 0.25, TARGETS, 1, new Set(['a', 'b']));

        // proximity 0 (exactly on the share) + 0.5 × (3 − 1) − 0.25 × 2.
        expect(score).toBeCloseTo(0.5, 12);
    });

    it('prefers the candidate closer to the guidance point', () => {
        const onPoint = candidate({ slug: 'on-point', calories: 500 });
        const short = candidate({ slug: 'short', calories: 300 });
        const noFoods: ReadonlySet<string> = new Set<string>();

        expect(scoreCandidate(onPoint, zeroTotals, 0.25, TARGETS, 1, noFoods)).toBeLessThan(
            scoreCandidate(short, zeroTotals, 0.25, TARGETS, 1, noFoods),
        );
    });

    it('stops rewarding a shared ingredient at the fourth, so a long list cannot buy the slot', () => {
        const scoreWith = (ingredientIds: string[]): number => {
            const subject = candidate({ slug: 'shared', calories: 500, ingredientIds });

            return scoreCandidate(subject, zeroTotals, 0.25, TARGETS, 1, new Set(ingredientIds));
        };

        const atCap = scoreWith(['a', 'b', 'c', 'd']);

        expect(scoreWith(['a', 'b', 'c', 'd', 'e'])).toBeCloseTo(atCap, 12);
        expect(atCap).toBeLessThan(scoreWith(['a', 'b', 'c']));
    });

    it('still scores a candidate nowhere near its guidance point, rather than refusing it', () => {
        const farOff = candidate({ slug: 'far-off', calories: 1800 });
        const score = scoreCandidate(farOff, zeroTotals, 0.25, TARGETS, 1, new Set<string>());

        expect(Number.isFinite(score)).toBe(true);
        expect(score).toBeGreaterThan(
            scoreCandidate(
                candidate({ slug: 'on-point', calories: 500 }),
                zeroTotals,
                0.25,
                TARGETS,
                1,
                new Set<string>(),
            ),
        );
    });
});

describe('compareCandidateMoves — the tie fixture', () => {
    const [low, high] = buildPlanCandidates(
        [makeRecipe({ slug: 'a', calories: 500 }), makeRecipe({ slug: 'b', calories: 500 })],
        makePreferences(),
        7,
    )
        .filter((candidate) => candidate.portionMultiplier === 1)
        .sort((left, right) => left.shuffleRank - right.shuffleRank);

    it('orders by score when the scores differ', () => {
        expect(compareCandidateMoves(scored(high, 0.1), scored(low, 0.2))).toBeLessThan(0);
    });

    it('breaks an exact tie by shuffle rank, and by nothing else', () => {
        expect(compareCandidateMoves(scored(high, 0.5), scored(low, 0.5))).toBeGreaterThan(0);
        expect(compareCandidateMoves(scored(low, 0.5), scored(high, 0.5))).toBeLessThan(0);
    });

    it('treats scores equal within the epsilon as a tie', () => {
        expect(compareCandidateMoves(scored(high, 0.5), scored(low, 0.5 + 1e-12))).toBeGreaterThan(0);
    });

    it('does not fall back to slug order, so the seed decides ties', () => {
        const sorted = [scored(high, 0.5), scored(low, 0.5)].sort(compareCandidateMoves);

        expect(sorted[0].candidate.shuffleRank).toBeLessThan(sorted[1].candidate.shuffleRank);
    });
});

/* ---------------------------------------------------------------------------
 * Day tolerance — the only hard nutrition test
 * ------------------------------------------------------------------------- */

describe('evaluateDayTolerance', () => {
    const totals = (overrides: Partial<MealPlanMacroTotals> = {}): MealPlanMacroTotals => ({
        ...TARGETS,
        ...overrides,
    });

    it('accepts a day exactly on target', () => {
        expect(evaluateDayTolerance(totals(), TARGETS)).toEqual({ withinTolerance: true, breaches: [] });
    });

    it('accepts calories exactly on the ±10 % bound', () => {
        const band = CALORIE_TOLERANCE_RATIO * TARGETS.calories;

        expect(isDayWithinTolerance(totals({ calories: TARGETS.calories + band }), TARGETS)).toBe(true);
        expect(isDayWithinTolerance(totals({ calories: TARGETS.calories - band }), TARGETS)).toBe(true);
    });

    it('refuses calories just outside the bound', () => {
        const band = CALORIE_TOLERANCE_RATIO * TARGETS.calories;

        expect(evaluateDayTolerance(totals({ calories: TARGETS.calories + band + 1 }), TARGETS)).toEqual({
            withinTolerance: false,
            breaches: ['calories'],
        });
    });

    it('allows more protein above target than below, on purpose', () => {
        expect(
            isDayWithinTolerance(totals({ protein: TARGETS.protein + PROTEIN_TOLERANCE_OVER_G }), TARGETS),
        ).toBe(true);
        expect(
            isDayWithinTolerance(
                totals({ protein: TARGETS.protein + PROTEIN_TOLERANCE_OVER_G + 0.5 }),
                TARGETS,
            ),
        ).toBe(false);
        expect(
            isDayWithinTolerance(totals({ protein: TARGETS.protein - PROTEIN_TOLERANCE_UNDER_G }), TARGETS),
        ).toBe(true);
        expect(
            isDayWithinTolerance(
                totals({ protein: TARGETS.protein - PROTEIN_TOLERANCE_UNDER_G - 0.5 }),
                TARGETS,
            ),
        ).toBe(false);
    });

    it('uses the absolute band for a small fat target, where 15 % would be stricter', () => {
        const smallFat: MealPlanMacroTotals = { ...TARGETS, fat: 50 };

        expect(
            isDayWithinTolerance({ ...smallFat, fat: 50 + MACRO_TOLERANCE_ABSOLUTE_G }, smallFat),
        ).toBe(true);
        expect(
            isDayWithinTolerance({ ...smallFat, fat: 50 + MACRO_TOLERANCE_ABSOLUTE_G + 0.5 }, smallFat),
        ).toBe(false);
    });

    it('uses the relative band for a large carb target, where 15 g would be stricter', () => {
        const largeCarbs: MealPlanMacroTotals = { ...TARGETS, carbs: 400 };

        expect(isDayWithinTolerance({ ...largeCarbs, carbs: 400 + 60 }, largeCarbs)).toBe(true);
        expect(isDayWithinTolerance({ ...largeCarbs, carbs: 400 + 61 }, largeCarbs)).toBe(false);
    });

    it('reports every breach in declaration order', () => {
        expect(
            evaluateDayTolerance({ calories: 100, protein: 1, carbs: 1, fat: 1 }, TARGETS).breaches,
        ).toEqual(['calories', 'protein', 'carbs', 'fat']);
    });

    it('refuses a non-positive target', () => {
        expect(() => evaluateDayTolerance(totals(), { ...TARGETS, protein: 0 })).toThrow(
            MealPlanInputError,
        );
    });

    /**
     * Every band above is written in the positive form — `> band`, and
     * `< low || > high` — and every relational comparison with NaN is false. An
     * unguarded non-finite total therefore pushed NO breach and this function
     * answered `{withinTolerance: true, breaches: []}`: a day of corrupt
     * arithmetic declared acceptable, which the search would take as its first
     * feasible assignment and publish.
     *
     * The answer is a throw and not a breach. A breach is a feasibility verdict
     * the caller renders as "these preferences don't fit"; a non-finite stored
     * figure is a data fault, and telling the user their week is infeasible
     * would be both wrong and unactionable.
     */
    describe('non-finite totals', () => {
        const fieldOf = (act: () => unknown): string => {
            try {
                act();
            } catch (error) {
                if (error instanceof MealPlanInputError) {
                    return error.field;
                }

                throw error;
            }

            throw new Error('expected a MealPlanInputError');
        };

        it.each(['calories', 'protein', 'carbs', 'fat'] as const)(
            'refuses a NaN %s instead of reporting the day as within tolerance',
            (key) => {
                expect(() => evaluateDayTolerance(totals({ [key]: Number.NaN }), TARGETS)).toThrow(
                    MealPlanInputError,
                );
                expect(fieldOf(() => evaluateDayTolerance(totals({ [key]: Number.NaN }), TARGETS))).toBe(
                    `totals.${key}`,
                );
            },
        );

        it.each(['calories', 'protein', 'carbs', 'fat'] as const)(
            'refuses a missing %s, which arrives as undefined from a partial row',
            (key) => {
                const partial = totals({ [key]: undefined as unknown as number });

                expect(fieldOf(() => evaluateDayTolerance(partial, TARGETS))).toBe(`totals.${key}`);
            },
        );

        it('refuses an infinite total, which trips a band only by accident', () => {
            expect(fieldOf(() => evaluateDayTolerance(totals({ calories: Infinity }), TARGETS))).toBe(
                'totals.calories',
            );
            expect(fieldOf(() => evaluateDayTolerance(totals({ protein: -Infinity }), TARGETS))).toBe(
                'totals.protein',
            );
        });

        it('refuses a numeric string, rather than coercing it in a comparison', () => {
            expect(fieldOf(() => evaluateDayTolerance(totals({ calories: '2000' as unknown as number }), TARGETS))).toBe(
                'totals.calories',
            );
        });

        it('names the first bad total in declaration order when several are bad', () => {
            expect(
                fieldOf(() =>
                    evaluateDayTolerance(
                        { calories: Number.NaN, protein: Number.NaN, carbs: Number.NaN, fat: Number.NaN },
                        TARGETS,
                    ),
                ),
            ).toBe('totals.calories');
        });

        it('judges the target before the total, so an impossible target still names itself', () => {
            // Order matters for the message a controller renders: a request with
            // both a broken target and a broken total is a broken target first.
            expect(
                fieldOf(() =>
                    evaluateDayTolerance(totals({ calories: Number.NaN }), { ...TARGETS, protein: 0 }),
                ),
            ).toBe('targets.protein');
        });

        it('refuses the same inputs through the boolean the search calls', () => {
            expect(() => isDayWithinTolerance(totals({ calories: Number.NaN }), TARGETS)).toThrow(
                MealPlanInputError,
            );
        });

        it('still judges a legitimately zero or negative total rather than refusing it', () => {
            // Finite-only, deliberately not positive-only: an empty day sums to
            // zero and must be REPORTED as breaching, not thrown on.
            expect(evaluateDayTolerance(zeroTotals, TARGETS)).toEqual({
                withinTolerance: false,
                breaches: ['calories', 'protein', 'carbs', 'fat'],
            });
            expect(isDayWithinTolerance({ ...TARGETS, fat: -1 }, TARGETS)).toBe(false);
        });
    });
});

describe('computeDayTotals', () => {
    it('sums at full precision without rounding', () => {
        const totals = computeDayTotals([
            { planned: proportional(500) },
            { planned: proportional(700) },
            { planned: proportional(800.5) },
        ]);

        expect(totals.calories).toBeCloseTo(2000.5, 10);
        expect(totals.protein).toBeCloseTo(proportional(2000.5).protein, 10);
    });

    it('is zero for a day with no meals', () => {
        expect(computeDayTotals([])).toEqual(zeroTotals);
    });

    /**
     * A sum is where a non-finite figure stops being attributable: `400 + NaN`
     * and `NaN + 400` are the same value, so by the time the total reaches the
     * tolerance gate nothing can say which meal spoiled it. Guarding here names
     * the meal.
     */
    describe('non-finite planned figures', () => {
        const fieldOf = (act: () => unknown): string => {
            try {
                act();
            } catch (error) {
                if (error instanceof MealPlanInputError) {
                    return error.field;
                }

                throw error;
            }

            throw new Error('expected a MealPlanInputError');
        };

        it.each(['calories', 'protein', 'carbs', 'fat'] as const)(
            'refuses a NaN %s and names the meal it came from',
            (key) => {
                const meals = [{ planned: { ...proportional(500), [key]: Number.NaN } }];

                expect(fieldOf(() => computeDayTotals(meals))).toBe(`meals[0].planned.${key}`);
            },
        );

        it('names the offending meal by index, not the sum', () => {
            const meals = [
                { planned: proportional(500) },
                { planned: { ...proportional(700), fat: undefined as unknown as number } },
            ];

            expect(fieldOf(() => computeDayTotals(meals))).toBe('meals[1].planned.fat');
        });

        it('refuses an infinite planned figure', () => {
            const meals = [{ planned: { ...proportional(500), protein: Infinity } }];

            expect(fieldOf(() => computeDayTotals(meals))).toBe('meals[0].planned.protein');
        });

        it('still sums a zero-calorie meal, which is data rather than a fault', () => {
            expect(computeDayTotals([{ planned: zeroTotals }])).toEqual(zeroTotals);
        });
    });
});

/* ---------------------------------------------------------------------------
 * Day keys and plan dates
 * ------------------------------------------------------------------------- */

describe('isDayKey', () => {
    it.each(['2026-07-05', '2024-02-29', '2026-12-31'])('accepts the real date %s', (value) => {
        expect(isDayKey(value)).toBe(true);
    });

    it.each(['2026-02-30', '2026-13-01', '2026-00-10', '2026-7-05', '20260705', '', 'today'])(
        'refuses %s',
        (value) => {
            expect(isDayKey(value)).toBe(false);
        },
    );

    it.each([undefined, null, 20260705, {}])('refuses the non-string %p', (value) => {
        expect(isDayKey(value)).toBe(false);
    });

    /**
     * This predicate used to be its own round trip through
     * `Date.UTC(year, month - 1, day)`, which maps a year of 0–99 to 1900–1999:
     * it read `0004-02-29` as 1904, the round trip could not match, and the
     * whole band before 0100 was refused — while `preferences.logic.ts`'s
     * table-driven twin accepted it. The same date was a real day to the review
     * step and not a real day to the log route.
     *
     * It is now an alias of the shared rule, so the band is accepted and the
     * three names cannot diverge again. `preferences.logic.test.ts` asserts the
     * identity; these cases pin the behaviour at this name.
     */
    it.each(['0000-01-01', '0001-01-01', '0004-02-29', '0050-06-15', '0099-12-31'])(
        'accepts %s, which a Date-based check placed in the twentieth century',
        (value) => {
            expect(isDayKey(value)).toBe(true);
        },
    );

    it('applies the leap rule to those years too, rather than waiving it', () => {
        expect(isDayKey('0003-02-29')).toBe(false);
        expect(isDayKey('0100-02-29')).toBe(false);
    });
});

describe('addDaysToDayKey', () => {
    it('crosses a month boundary', () => {
        expect(addDaysToDayKey('2026-07-30', 3)).toBe('2026-08-02');
    });

    it('crosses a year boundary', () => {
        expect(addDaysToDayKey('2026-12-30', 3)).toBe('2027-01-02');
    });

    it('handles a leap day', () => {
        expect(addDaysToDayKey('2024-02-28', 1)).toBe('2024-02-29');
    });

    it('goes backwards', () => {
        expect(addDaysToDayKey('2026-01-01', -1)).toBe('2025-12-31');
    });

    it('refuses a malformed key and a fractional offset', () => {
        expect(() => addDaysToDayKey('2026-07-05', 1.5)).toThrow(MealPlanInputError);
        expect(() => addDaysToDayKey('2026-02-30', 1)).toThrow(MealPlanInputError);
    });

    /**
     * Arithmetic has to stay in the year it was handed, across the WHOLE range
     * {@link isDayKey} accepts.
     *
     * `Date.UTC(year, month - 1, day)` — the obvious way to turn a key into an
     * instant, and what this module used — maps a year of 0–99 to 1900–1999. It
     * was harmless only while the predicate refused that band; once the shared
     * rule accepts it, every step built on it would return a real but wrong
     * answer, silently: a step from `0004-02-28` would land in 1904, and
     * `swap.logic.ts`'s repetition window would compare the wrong neighbours
     * and stop spacing that recipe out. A wrong answer is worse than a refusal,
     * so these are pinned rather than left to the predicate's tests.
     */
    describe('years before 0100, which a Date-based conversion silently relocated', () => {
        it('steps within the year it was given', () => {
            expect(addDaysToDayKey('0004-02-28', 1)).toBe('0004-02-29');
            expect(addDaysToDayKey('0004-02-29', 1)).toBe('0004-03-01');
            expect(addDaysToDayKey('0050-06-15', 7)).toBe('0050-06-22');
        });

        it('crosses into and out of the band without jumping to the 1900s', () => {
            expect(addDaysToDayKey('0099-12-31', 1)).toBe('0100-01-01');
            expect(addDaysToDayKey('0100-01-01', -1)).toBe('0099-12-31');
        });

        it('measures a distance in that band correctly', () => {
            expect(daysBetweenDayKeys('0004-02-28', '0004-03-01')).toBe(2);
            expect(daysBetweenDayKeys('0099-12-31', '0100-01-01')).toBe(1);
        });

        it('lays out a plan week there without leaving the year', () => {
            expect(planDatesFrom('0004-02-26').map((date) => date.date)).toEqual([
                '0004-02-26',
                '0004-02-27',
                '0004-02-28',
                '0004-02-29',
                '0004-03-01',
                '0004-03-02',
                '0004-03-03',
            ]);
            expect(planEndDate('0004-02-26')).toBe('0004-03-03');
        });

        it('refuses a step out of the representable range instead of returning a fragment', () => {
            // Below year 0000 and above 9999, toISOString switches to the
            // expanded ±YYYYYY form, and slicing ten characters off that yields
            // a key-shaped fragment naming no day ('+0100', '-0000'). The
            // result is re-validated, so the fault surfaces here.
            expect(() => addDaysToDayKey('0000-01-01', -1)).toThrow(MealPlanInputError);
            expect(() => addDaysToDayKey('9999-12-31', 1)).toThrow(MealPlanInputError);
        });
    });
});

describe('daysBetweenDayKeys', () => {
    it('counts forwards and backwards', () => {
        expect(daysBetweenDayKeys('2026-07-05', '2026-07-11')).toBe(6);
        expect(daysBetweenDayKeys('2026-07-11', '2026-07-05')).toBe(-6);
        expect(daysBetweenDayKeys('2026-07-05', '2026-07-05')).toBe(0);
    });
});

describe('planDatesFrom', () => {
    it('gives seven explicit dates with the last one flagged', () => {
        const dates = planDatesFrom(START_DATE);

        expect(dates).toHaveLength(PLAN_DAY_COUNT);
        expect(dates.map((date) => date.date)).toEqual([
            '2026-07-05',
            '2026-07-06',
            '2026-07-07',
            '2026-07-08',
            '2026-07-09',
            '2026-07-10',
            '2026-07-11',
        ]);
        expect(dates.map((date) => date.dayIndex)).toEqual([0, 1, 2, 3, 4, 5, 6]);
        expect(dates.filter((date) => date.isLastDay).map((date) => date.date)).toEqual(['2026-07-11']);
    });

    it('refuses a date that does not exist', () => {
        expect(() => planDatesFrom('2026-02-30')).toThrow(MealPlanInputError);
    });
});

describe('planEndDate', () => {
    it('is six days after the start', () => {
        expect(planEndDate(START_DATE)).toBe('2026-07-11');
    });
});

/* ---------------------------------------------------------------------------
 * localDayKey — the user's calendar day, derived in the user's own zone
 *
 * Every rule below takes "today" as a day key, and this is where that key comes
 * from. The cases feed one INSTANT rather than a precomputed string, because a
 * precomputed string is exactly what a server-time implementation would also
 * pass: the only way to prove the zone is doing the work is to hand two zones
 * the same moment and require two different answers.
 * ------------------------------------------------------------------------- */

describe('localDayKey', () => {
    const AUCKLAND = 'Pacific/Auckland';
    const LOS_ANGELES = 'America/Los_Angeles';

    /**
     * 20:00 UTC on the last day of June: already 08:00 the next morning in
     * Auckland and still 13:00 the same afternoon in Los Angeles — so the two
     * users are on different calendar days, in different months, at the same
     * instant.
     */
    const JUNE_EVENING_UTC = new Date('2026-06-30T20:00:00Z');

    const dailyInstants = (firstIso: string): Date[] =>
        Array.from(
            { length: PLAN_DAY_COUNT },
            (_unused, dayIndex) => new Date(Date.parse(firstIso) + dayIndex * 86400000),
        );

    const localTimeOfDay = (instant: Date, timeZone: string): string =>
        new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).format(instant);

    it('resolves one instant to two different days in two stored zones', () => {
        expect(localDayKey(JUNE_EVENING_UTC, AUCKLAND)).toBe('2026-07-01');
        expect(localDayKey(JUNE_EVENING_UTC, LOS_ANGELES)).toBe('2026-06-30');
        // Asserted against each other as well as against literals, so the case
        // cannot pass on a server that happens to sit in one of the two zones.
        expect(localDayKey(JUNE_EVENING_UTC, AUCKLAND)).not.toBe(
            localDayKey(JUNE_EVENING_UTC, LOS_ANGELES),
        );
    });

    it('takes the instant as epoch milliseconds too', () => {
        expect(localDayKey(JUNE_EVENING_UTC.getTime(), AUCKLAND)).toBe('2026-07-01');
    });

    it('returns a key the rest of the module accepts as a calendar day', () => {
        expect(isDayKey(localDayKey(JUNE_EVENING_UTC, LOS_ANGELES))).toBe(true);
    });

    it.each(['America/Atlantis', 'Not/AZone', ''])('refuses the zone %p', (timeZone) => {
        expect(() => localDayKey(JUNE_EVENING_UTC, timeZone)).toThrow(MealPlanInputError);
    });

    it.each([Number.NaN, Number.POSITIVE_INFINITY, new Date('nonsense')])(
        'refuses the instant %p',
        (instant) => {
            expect(() => localDayKey(instant, AUCKLAND)).toThrow(MealPlanInputError);
        },
    );

    it('rethrows an engine fault instead of reporting it as an unknown zone', () => {
        // A runtime without time-zone data is an environment fault, not a zone
        // the user chose badly. Collapsing the catch to one branch would pass
        // every case above and break exactly this one.
        const realDateTimeFormat = Intl.DateTimeFormat;

        try {
            (Intl as { DateTimeFormat: unknown }).DateTimeFormat = () => {
                throw new TypeError('ICU data unavailable');
            };

            expect(() => localDayKey(JUNE_EVENING_UTC, AUCKLAND)).toThrow(TypeError);
            expect(() => localDayKey(JUNE_EVENING_UTC, AUCKLAND)).not.toThrow(MealPlanInputError);
        } finally {
            (Intl as { DateTimeFormat: unknown }).DateTimeFormat = realDateTimeFormat;
        }

        expect(localDayKey(JUNE_EVENING_UTC, AUCKLAND)).toBe('2026-07-01');
    });

    describe('the lifecycle rules follow the derived day', () => {
        const ending = {
            id: 'plan-ending',
            status: 'active',
            start_date: '2026-06-24',
            end_date: '2026-06-30',
            replacement_plan_id: null,
        };
        const following = {
            id: 'plan-following',
            status: 'active',
            start_date: '2026-07-01',
            end_date: '2026-07-07',
            replacement_plan_id: null,
        };

        const aucklandToday = (): string => localDayKey(JUNE_EVENING_UTC, AUCKLAND);
        const angelesToday = (): string => localDayKey(JUNE_EVENING_UTC, LOS_ANGELES);

        it('ends a plan for the Auckland user while it is still live in Los Angeles', () => {
            expect(isPlanEnded(ending, aucklandToday())).toBe(true);
            expect(isPlanEnded(ending, angelesToday())).toBe(false);
        });

        it('splits current from upcoming differently in the two zones', () => {
            const auckland = resolveCurrentAndUpcoming([ending, following], aucklandToday());
            const angeles = resolveCurrentAndUpcoming([ending, following], angelesToday());

            expect(auckland.current?.id).toBe('plan-following');
            expect(auckland.upcoming).toBeNull();
            expect(angeles.current?.id).toBe('plan-ending');
            expect(angeles.upcoming?.id).toBe('plan-following');
        });

        it('opens the start-date window on the day each user is actually on', () => {
            expect(startDateWindow(aucklandToday(), null)).toEqual({
                earliest: '2026-07-01',
                latest: '2026-07-31',
            });
            expect(startDateWindow(angelesToday(), null)).toEqual({
                earliest: '2026-06-30',
                latest: '2026-07-30',
            });
        });

        it('accepts a start date for one zone and refuses it for the other', () => {
            const body = {
                startDate: '2026-06-30',
                idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
                expectedPreferencesRevision: 3,
                expectedTargetsRevision: 2,
            };

            expect(
                parseGeneratePlanRequest(body, startDateWindow(angelesToday(), null)).kind,
            ).toBe('ok');
            expect(parseGeneratePlanRequest(body, startDateWindow(aucklandToday(), null))).toMatchObject({
                kind: 'error',
                details: [{ field: 'startDate', code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE }],
            });
        });
    });

    describe('seven local days across a daylight-saving transition', () => {
        // Los Angeles springs forward on 2026-03-08 and Auckland leaves summer
        // time on 2026-04-05, so each week below contains a day that is not 24
        // hours long. Day keys must still advance by exactly one, with none
        // dropped and none repeated — the failure mode of 24-hour arithmetic on
        // a local clock.
        const weeks: [string, string, string][] = [
            [LOS_ANGELES, '2026-03-05T20:00:00Z', '2026-03-05'],
            [AUCKLAND, '2026-04-02T00:00:00Z', '2026-04-02'],
        ];

        it.each(weeks)('advances one local day per daily instant in %s', (timeZone, firstIso, firstDay) => {
            const instants = dailyInstants(firstIso);
            const derived = instants.map((instant) => localDayKey(instant, timeZone));

            expect(derived[0]).toBe(firstDay);
            expect(new Set(derived).size).toBe(PLAN_DAY_COUNT);

            for (let dayIndex = 1; dayIndex < derived.length; dayIndex += 1) {
                expect(derived[dayIndex]).toBe(addDaysToDayKey(derived[dayIndex - 1], 1));
            }

            // The plan's own week, composed from the derived first day, is the
            // same seven days — so nothing is dropped between the zone-aware
            // derivation and the calendar arithmetic that follows it.
            expect(planDatesFrom(derived[0]).map((date) => date.date)).toEqual(derived);
        });

        it.each(weeks)('really straddles the transition in %s', (timeZone, firstIso) => {
            const instants = dailyInstants(firstIso);

            // Same UTC time of day at both ends of the week, a different local
            // clock time: the zone's offset moved inside these seven days.
            expect(localTimeOfDay(instants[0], timeZone)).not.toBe(
                localTimeOfDay(instants[PLAN_DAY_COUNT - 1], timeZone),
            );
        });
    });

    it('crosses a month boundary through the same composition', () => {
        expect(planDatesFrom(localDayKey(JUNE_EVENING_UTC, AUCKLAND)).map((date) => date.date)).toEqual([
            '2026-07-01',
            '2026-07-02',
            '2026-07-03',
            '2026-07-04',
            '2026-07-05',
            '2026-07-06',
            '2026-07-07',
        ]);
    });

    it('crosses a year boundary through the same composition', () => {
        const newYearEveUtc = new Date('2026-12-31T20:00:00Z');

        expect(localDayKey(newYearEveUtc, AUCKLAND)).toBe('2027-01-01');
        expect(localDayKey(newYearEveUtc, LOS_ANGELES)).toBe('2026-12-31');
        expect(planDatesFrom(localDayKey(newYearEveUtc, LOS_ANGELES)).map((date) => date.date)).toEqual([
            '2026-12-31',
            '2027-01-01',
            '2027-01-02',
            '2027-01-03',
            '2027-01-04',
            '2027-01-05',
            '2027-01-06',
        ]);
        expect(planEndDate(localDayKey(newYearEveUtc, LOS_ANGELES))).toBe('2027-01-06');
    });
});

/* ---------------------------------------------------------------------------
 * Schedule
 * ------------------------------------------------------------------------- */

describe('scheduleSlots and scheduleCumulativeShares', () => {
    it('plans three slots, ending on the whole day target', () => {
        expect(scheduleSlots('three')).toEqual(['breakfast', 'lunch', 'dinner']);
        expect(scheduleCumulativeShares('three')).toEqual([0.25, 0.6, 1]);
    });

    it('plans four slots with the snack last, ending on the whole day target', () => {
        expect(scheduleSlots('three_plus_snack')).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
        expect(scheduleCumulativeShares('three_plus_snack')).toEqual([0.22, 0.52, 0.87, 1]);
    });
});

describe('resolveSlotSchedule', () => {
    it('keeps the search in wire order while the day reads by the clock', () => {
        const schedule = resolveSlotSchedule('three_plus_snack', SNACK_MEAL_TIMES);

        expect(schedule.map((entry) => entry.slot)).toEqual([
            'breakfast',
            'lunch',
            'dinner',
            'snack',
        ]);
        expect(schedule.map((entry) => entry.searchIndex)).toEqual([0, 1, 2, 3]);
        // 15:30 puts the snack between lunch and dinner on screen.
        expect(schedule.map((entry) => entry.sortOrder)).toEqual([0, 1, 3, 2]);
    });

    it('carries each slot its saved time and guidance share', () => {
        const schedule = resolveSlotSchedule('three', THREE_MEAL_TIMES);

        expect(schedule.map((entry) => entry.time)).toEqual(['08:00', '12:30', '18:30']);
        expect(schedule.map((entry) => entry.cumulativeShare)).toEqual([0.25, 0.6, 1]);
    });

    it('keeps wire order when two slots share a time', () => {
        const schedule = resolveSlotSchedule('three', [
            { slot: 'breakfast', time: '08:00' },
            { slot: 'lunch', time: '08:00' },
            { slot: 'dinner', time: '18:30' },
        ]);

        expect(schedule.map((entry) => entry.sortOrder)).toEqual([0, 1, 2]);
    });

    it('refuses a schedule missing one of its slots rather than inventing a time', () => {
        expect(() => resolveSlotSchedule('three_plus_snack', THREE_MEAL_TIMES)).toThrow(
            MealPlanInputError,
        );
    });

    it.each(['8:00', '24:00', '12:60', 'noon'])('refuses the malformed time %s', (time) => {
        expect(() =>
            resolveSlotSchedule('three', [
                { slot: 'breakfast', time },
                { slot: 'lunch', time: '12:30' },
                { slot: 'dinner', time: '18:30' },
            ]),
        ).toThrow(MealPlanInputError);
    });
});

/* ---------------------------------------------------------------------------
 * Budget tier
 * ------------------------------------------------------------------------- */

describe('resolveUserBudgetTier', () => {
    const weeklyFor = (perMeal: number, mealsPerDay: number): number =>
        perMeal * mealsPerDay * PLAN_DAY_COUNT;

    it('puts a thin budget in the cheapest band', () => {
        expect(
            resolveUserBudgetTier(
                { amount: weeklyFor(BUDGET_TIER_1_MAX_PER_MEAL - 0.5, 3), currency: 'USD' },
                false,
                'three',
            ),
        ).toBe(1);
    });

    it('puts both band boundaries in the middle band', () => {
        expect(
            resolveUserBudgetTier(
                { amount: weeklyFor(BUDGET_TIER_1_MAX_PER_MEAL, 3), currency: 'USD' },
                false,
                'three',
            ),
        ).toBe(2);
        expect(
            resolveUserBudgetTier(
                { amount: weeklyFor(BUDGET_TIER_2_MAX_PER_MEAL, 3), currency: 'USD' },
                false,
                'three',
            ),
        ).toBe(2);
    });

    it('puts a generous budget in the top band', () => {
        expect(
            resolveUserBudgetTier(
                { amount: weeklyFor(BUDGET_TIER_2_MAX_PER_MEAL + 0.5, 3), currency: 'USD' },
                false,
                'three',
            ),
        ).toBe(3);
    });

    it('spreads the same amount over four meals a day, which can drop a band', () => {
        const amount = weeklyFor(BUDGET_TIER_1_MAX_PER_MEAL, 3);

        expect(resolveUserBudgetTier({ amount, currency: 'USD' }, false, 'three')).toBe(2);
        expect(resolveUserBudgetTier({ amount, currency: 'USD' }, false, 'three_plus_snack')).toBe(1);
    });

    it('never penalises an absent answer', () => {
        expect(resolveUserBudgetTier(null, false, 'three')).toBe(3);
        expect(resolveUserBudgetTier({ amount: 10, currency: 'USD' }, true, 'three')).toBe(3);
        expect(resolveUserBudgetTier({ amount: 0, currency: 'USD' }, false, 'three')).toBe(3);
        expect(resolveUserBudgetTier({ amount: Number.NaN, currency: 'USD' }, false, 'three')).toBe(3);
    });
});

/* ---------------------------------------------------------------------------
 * Generation — the happy path, determinism, and the four hard fixtures
 * ------------------------------------------------------------------------- */

describe('generateWeeklyPlan', () => {
    it('builds seven days of the scheduled slots, every day inside tolerance', () => {
        const result = plan(feasibleCatalog());

        expect(result.days).toHaveLength(PLAN_DAY_COUNT);
        expect(result.startDate).toBe(START_DATE);
        expect(result.endDate).toBe('2026-07-11');
        expect(result.seed).toBe(derivePlanSeed(makeSeedInputs()));

        for (const day of result.days) {
            expect(day.meals.map((meal) => meal.slot)).toEqual(['breakfast', 'lunch', 'dinner']);
            expect(isDayWithinTolerance(day.plannedTotals, TARGETS)).toBe(true);
        }

        expect(result.days.map((day) => day.date)).toEqual(
            planDatesFrom(START_DATE).map((date) => date.date),
        );
        expect(result.days[PLAN_DAY_COUNT - 1].isLastDay).toBe(true);
    });

    it('reports day totals as the sum of the meals it placed', () => {
        const result = plan(feasibleCatalog());

        for (const day of result.days) {
            expect(day.plannedTotals).toEqual(computeDayTotals(day.meals));
        }
    });

    // The one catalog whose slots CANNOT approach their guidance points: the
    // smallest breakfast the portion set can cut from an 1,800 kcal recipe is
    // 900, against a 500 kcal guidance point. Every other feasible fixture in
    // this file sits exactly on its points, so a guidance share promoted from a
    // move-order hint to a per-slot acceptance test would pass all of them —
    // and fail only here.
    it('plans a week whose slots cannot sit near their guidance points', () => {
        const breakfastCalories = 1800;
        const guidancePoint = scheduleCumulativeShares('three')[0] * TARGETS.calories;
        const smallestBreakfast = breakfastCalories * Math.min(...MAIN_SLOT_PORTION_MULTIPLIERS);

        expect(smallestBreakfast).toBeGreaterThan(guidancePoint * 1.5);

        const skewed = [
            ...['b1', 'b2', 'b3', 'b4'].map((slug) =>
                makeRecipe({ slug, slots: ['breakfast'], calories: breakfastCalories }),
            ),
            ...['l1', 'l2', 'l3', 'l4'].map((slug) =>
                makeRecipe({ slug, slots: ['lunch'], calories: 300 }),
            ),
            ...['d1', 'd2', 'd3', 'd4'].map((slug) =>
                makeRecipe({ slug, slots: ['dinner'], calories: 700 }),
            ),
        ];

        const result = plan(skewed);

        expect(result.days).toHaveLength(PLAN_DAY_COUNT);

        for (const day of result.days) {
            expect(isDayWithinTolerance(day.plannedTotals, TARGETS)).toBe(true);
            expect(day.meals[0].slot).toBe('breakfast');
            expect(day.meals[0].planned.calories).toBeGreaterThanOrEqual(smallestBreakfast);
        }
    });

    it('places a snack when the schedule has one, ordered by the clock', () => {
        const recipes = [
            ...feasibleCatalog(),
            ...['s1', 's2', 's3', 's4'].map((slug) =>
                makeRecipe({ slug, slots: ['snack'], calories: 260 }),
            ),
        ];
        const preferences = makePreferences({
            meal_schedule: 'three_plus_snack',
            meal_times: SNACK_MEAL_TIMES,
        });

        const result = plan(recipes, preferences);

        for (const day of result.days) {
            expect(day.meals.map((meal) => meal.slot)).toEqual([
                'breakfast',
                'lunch',
                'snack',
                'dinner',
            ]);
            expect(day.meals.map((meal) => meal.sortOrder)).toEqual([0, 1, 2, 3]);
            expect(isDayWithinTolerance(day.plannedTotals, TARGETS)).toBe(true);
        }
    });

    it('carries each meal its saved slot time and portable identity', () => {
        const [firstDay] = plan(feasibleCatalog()).days;
        const [breakfast] = firstDay.meals;

        expect(breakfast.slotTime).toBe('08:00');
        expect(breakfast.slug).toMatch(/^b[1-4]$/);
        expect(breakfast.version).toBe(1);
        expect(breakfast.recipeVersionId).toBe(`${breakfast.slug}-version-1`);
        expect(MAIN_SLOT_PORTION_MULTIPLIERS).toContain(breakfast.portionMultiplier);
    });

    it('is byte-identical for identical inputs', () => {
        expect(plan(feasibleCatalog())).toEqual(plan(feasibleCatalog()));
    });

    it('produces the same plan however the catalog was ordered — the pre-order guard', () => {
        const forward = plan(feasibleCatalog());
        const reversed = plan([...feasibleCatalog()].reverse());

        expect(portableIdentities(reversed)).toEqual(portableIdentities(forward));
        expect(plannedCalories(reversed)).toEqual(plannedCalories(forward));
    });

    it('produces the same plan when only the database ids differ', () => {
        const renamed = feasibleCatalog().map((recipe) => ({
            ...recipe,
            recipe_id: `zz-${recipe.recipe_id}`,
            recipe_version_id: `zz-${recipe.recipe_version_id}`,
        }));

        expect(portableIdentities(plan(renamed))).toEqual(portableIdentities(plan(feasibleCatalog())));
    });

    it('varies a regeneration through the generation attempt', () => {
        const first = plan(feasibleCatalog());
        const second = plan(
            feasibleCatalog(),
            makePreferences(),
            makeSeedInputs({ generationAttempt: 2 }),
        );

        expect(portableIdentities(second)).not.toEqual(portableIdentities(first));
    });

    it('honours the repetition rule across the whole week', () => {
        const result = plan(feasibleCatalog());

        const usesBySlug = new Map<string, number>();
        for (const day of result.days) {
            for (const meal of day.meals) {
                usesBySlug.set(meal.slug, (usesBySlug.get(meal.slug) ?? 0) + 1);
            }
        }

        for (const [, uses] of usesBySlug) {
            expect(uses).toBeLessThanOrEqual(MAX_RECIPE_USES_PER_WEEK);
        }

        for (let dayIndex = 1; dayIndex < result.days.length; dayIndex += 1) {
            const yesterday = new Set(result.days[dayIndex - 1].meals.map((meal) => meal.slug));

            for (const meal of result.days[dayIndex].meals) {
                expect(yesterday.has(meal.slug)).toBe(false);
            }
        }

        for (const day of result.days) {
            const slugs = day.meals.map((meal) => meal.slug);

            expect(new Set(slugs).size).toBe(slugs.length);
        }
    });

    it('refuses a non-positive target instead of planning against it', () => {
        expect(() =>
            generateWeeklyPlan({
                seedInputs: makeSeedInputs(),
                preferences: makePreferences(),
                targets: { ...TARGETS, calories: 0 },
                recipes: feasibleCatalog(),
            }),
        ).toThrow(MealPlanInputError);
    });

    it('reports an empty catalog as infeasible, naming every uncovered slot', () => {
        try {
            plan([]);
            throw new Error('expected NoMatchingMealsError');
        } catch (error) {
            expect(error).toBeInstanceOf(NoMatchingMealsError);

            const failure = error as NoMatchingMealsError;

            expect(failure.allergiesKept).toBe(true);
            expect(failure.limitingConstraints).toEqual([
                {
                    constraintKey: 'slot_coverage',
                    value: 0,
                    unit: 'recipes',
                    slots: ['breakfast', 'lunch', 'dinner'],
                    editStep: 'schedule',
                },
            ]);
        }
    });

    it('fails the whole plan when one slot has nothing, however rich the others are', () => {
        const withoutDinner = feasibleCatalog().filter((recipe) => !recipe.slug.startsWith('d'));

        expect(() => plan(withoutDinner)).toThrow(NoMatchingMealsError);
    });

    it('raises a generation failure, not an infeasibility, when the deadline fires', () => {
        expect(() => plan(feasibleCatalog(), makePreferences(), makeSeedInputs(), () => true)).toThrow(
            PlanGenerationError,
        );
    });

    it('unwinds a search already in progress when the deadline fires mid-week', () => {
        // Fires only after the search is several placements deep, so the abort
        // is observed while unwinding rather than before the first day starts.
        let checks = 0;
        const shouldAbort = (): boolean => {
            checks += 1;

            return checks > 6;
        };

        expect(() => plan(feasibleCatalog(), makePreferences(), makeSeedInputs(), shouldAbort)).toThrow(
            PlanGenerationError,
        );

        // A deadline is an abort, never a feasibility verdict: nothing about the
        // catalog changed, so a run without one still plans the week.
        expect(plan(feasibleCatalog()).days).toHaveLength(PLAN_DAY_COUNT);
    });

    describe('the greedy dead-end fixture', () => {
        // Breakfast lands on its 500 kcal guidance point and lunch on its 1,200
        // cumulative point, but dinner's smallest portion is 1,100 kcal — so the
        // best-scored prefix leaves the day needing at most 1,000 more and
        // nothing can supply it. A lighter lunch admits the same dinner.
        const catalog = (): PlanRecipeCandidate[] => [
            ...['b1', 'b2', 'b3', 'b4'].map((slug) =>
                makeRecipe({ slug, slots: ['breakfast'], calories: 500 }),
            ),
            ...['l1', 'l2'].map((slug) => makeRecipe({ slug, slots: ['lunch'], calories: 700 })),
            ...['l3', 'l4'].map((slug) => makeRecipe({ slug, slots: ['lunch'], calories: 500 })),
            ...['d1', 'd2', 'd3', 'd4'].map((slug) =>
                makeRecipe({ slug, slots: ['dinner'], calories: 2200 }),
            ),
        ];

        it('has no dinner that completes the best-scored breakfast and lunch', () => {
            const seed = derivePlanSeed(makeSeedInputs());
            const preferences = makePreferences();
            const candidates = buildPlanCandidates(catalog(), preferences, seed);
            const noFoods: ReadonlySet<string> = new Set<string>();

            const best = (slot: MealSlot, cumulative: MealPlanMacroTotals, share: number) =>
                candidatesForSlot(candidates, preferences, slot)
                    .map((candidate) => ({
                        candidate,
                        score: scoreCandidate(candidate, cumulative, share, TARGETS, 3, noFoods),
                    }))
                    .sort(compareCandidateMoves)[0].candidate;

            const breakfast = best('breakfast', zeroTotals, 0.25);
            const afterBreakfast = computeDayTotals([{ planned: breakfast.nutrition }]);
            const lunch = best('lunch', afterBreakfast, 0.6);
            const afterLunch = computeDayTotals([
                { planned: breakfast.nutrition },
                { planned: lunch.nutrition },
            ]);

            expect(breakfast.nutrition.calories).toBeCloseTo(500, 10);
            expect(lunch.nutrition.calories).toBeCloseTo(700, 10);

            const completions = candidatesForSlot(candidates, preferences, 'dinner').filter((dinner) =>
                isDayWithinTolerance(
                    computeDayTotals([
                        { planned: breakfast.nutrition },
                        { planned: lunch.nutrition },
                        { planned: dinner.nutrition },
                    ]),
                    TARGETS,
                ),
            );

            expect(afterLunch.calories).toBeCloseTo(1200, 10);
            expect(completions).toHaveLength(0);
        });

        it('still finds a valid day by backtracking out of that prefix', () => {
            const result = plan(catalog());

            for (const day of result.days) {
                expect(day.meals).toHaveLength(3);
                expect(isDayWithinTolerance(day.plannedTotals, TARGETS)).toBe(true);
            }

            // Every accepted day had to abandon the greedy 500 + 700 prefix.
            for (const day of result.days) {
                const [breakfast, lunch] = day.meals;

                expect(breakfast.planned.calories + lunch.planned.calories).not.toBeCloseTo(1200, 6);
            }

            expect(result.evaluations).toBeGreaterThan(PLAN_DAY_COUNT * 3);
        });
    });

    describe('the week-level cross-day backtracking fixture', () => {
        // Cross-day backtracking is asserted MECHANISM-AGNOSTICALLY: a reference
        // solver that backtracks freely inside a day but commits each day's
        // first feasible assignment permanently CANNOT solve this catalog, while
        // the real search can. Since the two differ in exactly one respect —
        // whether an earlier day may be revisited — a plan the real search
        // returns here can only have come from backtracking across a day
        // boundary. Asserting the property rather than a hand-traced day/slot
        // keeps the test honest if the move order ever shifts.
        //
        // The catalog mixes protein-, carb-, fat-dense, hearty, lean and balanced
        // profiles so the day tolerance binds on all four macros at once (these
        // recipes deliberately do NOT use `proportional`). A day therefore needs
        // a specific MIX, and because the no-consecutive-days rule decides which
        // recipes a day may draw on, one day's assignment constrains the next
        // day's — the coupling that makes a week-level dead end possible at all.
        const PROTEIN_DENSE: MealPlanMacroTotals = { calories: 600, protein: 80, carbs: 20, fat: 15 };
        const CARB_DENSE: MealPlanMacroTotals = { calories: 450, protein: 10, carbs: 85, fat: 6 };
        const FAT_DENSE: MealPlanMacroTotals = { calories: 600, protein: 20, carbs: 25, fat: 45 };
        const BALANCED: MealPlanMacroTotals = { calories: 800, protein: 55, carbs: 70, fat: 28 };
        const HEARTY: MealPlanMacroTotals = { calories: 700, protein: 45, carbs: 80, fat: 20 };
        const LEAN: MealPlanMacroTotals = { calories: 500, protein: 60, carbs: 45, fat: 10 };

        // Every recipe here is load-bearing: dropping ANY single one leaves the
        // real search unable to close the week at all (it exhausts the per-day
        // allowance), which is asserted below rather than left as a claim.
        // The slugs are load-bearing too — they ARE the portable pre-order, so
        // renaming them reshuffles the move order and the property is lost. The
        // suffix names the slots the recipe declares: b breakfast, l lunch,
        // d dinner.
        const catalog = (): PlanRecipeCandidate[] => [
            makeRecipe({
                slug: 'balanced-ld',
                slots: ['lunch', 'dinner'],
                calories: 0,
                nutrition: BALANCED,
            }),
            makeRecipe({
                slug: 'fat-bd',
                slots: ['breakfast', 'dinner'],
                calories: 0,
                nutrition: FAT_DENSE,
            }),
            makeRecipe({ slug: 'balanced-l', slots: ['lunch'], calories: 0, nutrition: BALANCED }),
            makeRecipe({
                slug: 'carb-bl',
                slots: ['breakfast', 'lunch'],
                calories: 0,
                nutrition: CARB_DENSE,
            }),
            makeRecipe({ slug: 'balanced-d', slots: ['dinner'], calories: 0, nutrition: BALANCED }),
            makeRecipe({ slug: 'protein-d', slots: ['dinner'], calories: 0, nutrition: PROTEIN_DENSE }),
            makeRecipe({ slug: 'hearty-l', slots: ['lunch'], calories: 0, nutrition: HEARTY }),
            makeRecipe({
                slug: 'lean-bd',
                slots: ['breakfast', 'dinner'],
                calories: 0,
                nutrition: LEAN,
            }),
            makeRecipe({
                slug: 'balanced-bl',
                slots: ['breakfast', 'lunch'],
                calories: 0,
                nutrition: BALANCED,
            }),
            makeRecipe({
                slug: 'lean-bl',
                slots: ['breakfast', 'lunch'],
                calories: 0,
                nutrition: LEAN,
            }),
            makeRecipe({
                slug: 'hearty-bl',
                slots: ['breakfast', 'lunch'],
                calories: 0,
                nutrition: HEARTY,
            }),
        ];

        /**
         * The real search minus cross-day backtracking, built from the module's
         * own exported rules so it cannot drift from them: same candidates, same
         * repetition rule, same move order, same tolerance. It backtracks freely
         * across the slots of the day it is on, then commits that day and never
         * reconsiders it.
         */
        const solveWithoutCrossDayBacktracking = (
            recipes: PlanRecipeCandidate[],
        ): { solved: boolean; failedDayIndex: number } => {
            const preferences = makePreferences();
            const candidates = buildPlanCandidates(recipes, preferences, derivePlanSeed(makeSeedInputs()));
            const schedule = resolveSlotSchedule('three', THREE_MEAL_TIMES);
            const userTier = resolveUserBudgetTier(null, true, 'three');
            const bySlot = new Map<MealSlot, PlanCandidate[]>(
                schedule.map((entry) => [entry.slot, candidatesForSlot(candidates, preferences, entry.slot)]),
            );
            const usesByRecipeId = new Map<string, number>();
            let previousDayRecipeIds = new Set<string>();

            for (let dayIndex = 0; dayIndex < PLAN_DAY_COUNT; dayIndex += 1) {
                const placed: PlanCandidate[] = [];
                // Counted, not a flag, for the reason `searchPlanWeek` counts:
                // §0.7.3 permits two same-day uses, so a day's membership
                // survives unwinding one of them.
                const currentDayRecipeCounts = new Map<string, number>();

                const fillSlot = (slotIndex: number): boolean => {
                    const soFar = computeDayTotals(placed.map((entry) => ({ planned: entry.nutrition })));

                    if (slotIndex === schedule.length) {
                        return isDayWithinTolerance(soFar, TARGETS);
                    }

                    const slot = schedule[slotIndex];
                    const plannedFoodIds = new Set<string>();

                    for (const entry of placed) {
                        for (const ingredient of entry.recipe.ingredients) {
                            plannedFoodIds.add(ingredient.catalog_food_id);
                        }
                    }

                    const moves: ScoredCandidate[] = (bySlot.get(slot.slot) ?? [])
                        .filter(
                            (candidate) =>
                                !violatesRepetitionRule(
                                    candidate.recipe.recipe_id,
                                    usesByRecipeId.get(candidate.recipe.recipe_id) ?? 0,
                                    previousDayRecipeIds,
                                ),
                        )
                        .map((candidate) => ({
                            candidate,
                            score: scoreCandidate(
                                candidate,
                                soFar,
                                slot.cumulativeShare,
                                TARGETS,
                                userTier,
                                plannedFoodIds,
                            ),
                        }))
                        .sort(compareCandidateMoves);

                    for (const move of moves) {
                        const recipeId = move.candidate.recipe.recipe_id;

                        placed.push(move.candidate);
                        currentDayRecipeCounts.set(recipeId, (currentDayRecipeCounts.get(recipeId) ?? 0) + 1);
                        usesByRecipeId.set(recipeId, (usesByRecipeId.get(recipeId) ?? 0) + 1);

                        if (fillSlot(slotIndex + 1)) {
                            return true;
                        }

                        placed.pop();

                        const remainingToday = (currentDayRecipeCounts.get(recipeId) ?? 1) - 1;
                        if (remainingToday <= 0) {
                            currentDayRecipeCounts.delete(recipeId);
                        } else {
                            currentDayRecipeCounts.set(recipeId, remainingToday);
                        }

                        usesByRecipeId.set(recipeId, (usesByRecipeId.get(recipeId) ?? 0) - 1);
                    }

                    return false;
                };

                if (!fillSlot(0)) {
                    return { solved: false, failedDayIndex: dayIndex };
                }

                previousDayRecipeIds = new Set(currentDayRecipeCounts.keys());
            }

            return { solved: true, failedDayIndex: -1 };
        };

        it('cannot be solved by a search that never revisits an earlier day', () => {
            const outcome = solveWithoutCrossDayBacktracking(catalog());

            // Days 0-5 each close on their own; day 6 is where committing those
            // earlier days becomes unrecoverable — the week-level dead end
            // §0.7.3 names.
            expect(outcome.solved).toBe(false);
            expect(outcome.failedDayIndex).toBe(PLAN_DAY_COUNT - 1);
        });

        it('needs every recipe in the catalog', () => {
            // The minimality claim above, asserted: with any one recipe removed
            // the real search cannot close the week at all, so no recipe here is
            // padding that could be masking the property.
            for (const removed of catalog()) {
                const withoutOne = catalog().filter((recipe) => recipe.slug !== removed.slug);

                expect(searchFor(withoutOne).days).toBeNull();
            }
        });

        it('completes the week by revisiting an earlier day', () => {
            const result = plan(catalog());

            expect(result.days).toHaveLength(PLAN_DAY_COUNT);

            // Far above the 21 evaluations a purely greedy pass would spend
            // (7 days x 3 slots), so the week was genuinely searched.
            expect(result.evaluations).toBeGreaterThan(PLAN_DAY_COUNT * 3);

            for (const day of result.days) {
                expect(day.meals).toHaveLength(3);
                expect(isDayWithinTolerance(day.plannedTotals, TARGETS)).toBe(true);
            }
        });

        it('honours the repetition rule across the whole week it backtracked through', () => {
            const result = plan(catalog());
            const usesBySlug = new Map<string, number>();

            result.days.forEach((day, dayIndex) => {
                for (const meal of day.meals) {
                    usesBySlug.set(meal.slug, (usesBySlug.get(meal.slug) ?? 0) + 1);
                }

                if (dayIndex === 0) {
                    return;
                }

                const yesterday = new Set(result.days[dayIndex - 1].meals.map((meal) => meal.slug));

                for (const meal of day.meals) {
                    expect(yesterday.has(meal.slug)).toBe(false);
                }
            });

            for (const uses of usesBySlug.values()) {
                expect(uses).toBeLessThanOrEqual(MAX_RECIPE_USES_PER_WEEK);
            }
        });

        it('places every meal on a recipe eligible for its slot', () => {
            const result = plan(catalog());
            const slotsBySlug = new Map(catalog().map((recipe) => [recipe.slug, recipe.meal_slots]));

            for (const day of result.days) {
                for (const meal of day.meals) {
                    expect(slotsBySlug.get(meal.slug)).toContain(meal.slot);
                }
            }
        });

        it('reaches the same week again from the same inputs', () => {
            const first = plan(catalog());
            const second = plan(catalog());

            const shape = (result: GeneratedPlan): string =>
                result.days
                    .map((day) =>
                        day.meals.map((meal) => `${meal.slot}:${meal.slug}@${meal.portionMultiplier}`).join(','),
                    )
                    .join('|');

            expect(shape(second)).toBe(shape(first));
            expect(second.evaluations).toBe(first.evaluations);
        });

        it('plans a recipe in two slots of one day, which §0.7.3 permits', () => {
            // The end-to-end half of the repetition rule: this week is closed
            // with same-day pairs, so a generator carrying the old unwritten
            // same-day ban could not have returned it at all. Both uses are
            // inside the weekly cap, which the test above asserts for the same
            // week.
            const result = plan(catalog());
            const daysWithARepeat = result.days.filter((day) => {
                const slugs = day.meals.map((meal) => meal.slug);

                return new Set(slugs).size < slugs.length;
            });

            expect(daysWithARepeat.length).toBeGreaterThan(0);

            for (const day of daysWithARepeat) {
                expect(isDayWithinTolerance(day.plannedTotals, TARGETS)).toBe(true);
            }
        });

        it('keeps the day-after exclusion for a recipe whose same-day pair was unwound', () => {
            // THE REFERENCE-COUNTING REGRESSION GUARD. Placing a recipe twice in
            // one day and then unwinding one of the two must leave the day still
            // holding it, or the following day's adjacent-day exclusion silently
            // stops seeing it — a consecutive-day repeat the rule forbids. This
            // catalog's search does place same-day pairs and does backtrack out
            // of placements (64 evaluations for 21 meals), so the unwind path is
            // exercised; with per-day membership kept as a plain set rather than
            // a count, the week below comes back with a recipe on two
            // consecutive days.
            const result = plan(catalog());

            result.days.forEach((day, dayIndex) => {
                if (dayIndex === 0) {
                    return;
                }

                const yesterday = new Set(result.days[dayIndex - 1].meals.map((meal) => meal.slug));

                for (const meal of day.meals) {
                    expect(yesterday.has(meal.slug)).toBe(false);
                }
            });
        });
    });

    describe('the budget fixture', () => {
        // Twenty recipes per slot, none of which can reach the day target at any
        // offered portion: the search has plenty to try and nothing that works,
        // so it spends its per-day allowance and stops.
        const catalog = (): PlanRecipeCandidate[] =>
            (['breakfast', 'lunch', 'dinner'] as MealSlot[]).flatMap((slot) =>
                Array.from({ length: 20 }, (_unused, index) =>
                    makeRecipe({
                        slug: `${slot}-${String(index).padStart(2, '0')}`,
                        slots: [slot],
                        calories: 60 + index,
                    }),
                ),
            );

        it('reports exhaustion as an infeasible week, never as a server failure', () => {
            let thrown: unknown;

            try {
                plan(catalog());
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeInstanceOf(NoMatchingMealsError);
            expect(thrown).not.toBeInstanceOf(PlanGenerationError);

            const failure = thrown as NoMatchingMealsError;

            expect(failure.limitingConstraints.map((constraint) => constraint.constraintKey)).toContain(
                'nutrition_tolerance',
            );
            expect(failure.allergiesKept).toBe(true);
        });
    });

    describe('the thin-slot exhaustion fixture', () => {
        // Twenty breakfasts and twenty lunches that can never reach the day
        // target, plus only THREE dinners — one short of
        // MIN_ELIGIBLE_RECIPES_PER_SLOT. Both things are true at once, which is
        // the whole point: the catalog is thin AND the search ran out of
        // evaluations, so a verdict built from the counts alone would blame the
        // dinner shelf for a week whose numbers were never settled.
        const catalog = (): PlanRecipeCandidate[] => [
            ...Array.from({ length: 20 }, (_unused, index) =>
                makeRecipe({
                    slug: `breakfast-${String(index).padStart(2, '0')}`,
                    slots: ['breakfast'],
                    calories: 60 + index,
                }),
            ),
            ...Array.from({ length: 20 }, (_unused, index) =>
                makeRecipe({
                    slug: `lunch-${String(index).padStart(2, '0')}`,
                    slots: ['lunch'],
                    calories: 60 + index,
                }),
            ),
            ...['dinner-0', 'dinner-1', 'dinner-2'].map((slug) =>
                makeRecipe({ slug, slots: ['dinner'], calories: 100 }),
            ),
        ];

        const failure = (): NoMatchingMealsError => {
            try {
                plan(catalog());
            } catch (error) {
                expect(error).toBeInstanceOf(NoMatchingMealsError);

                return error as NoMatchingMealsError;
            }

            throw new Error('expected NoMatchingMealsError');
        };

        it('is genuinely thin in one slot and genuinely exhausted', () => {
            const preferences = makePreferences();
            const candidates = buildPlanCandidates(catalog(), preferences, derivePlanSeed(makeSeedInputs()));

            expect(eligibleRecipeCountForSlot(candidates, preferences, 'dinner')).toBe(3);
            expect(eligibleRecipeCountForSlot(candidates, preferences, 'dinner')).toBeLessThan(
                MIN_ELIGIBLE_RECIPES_PER_SLOT,
            );
            expect(searchFor(catalog()).exhausted).toBe(true);
        });

        it('reports the thin shelf AND the tolerance, not the shelf alone', () => {
            const keys = failure().limitingConstraints.map((constraint) => constraint.constraintKey);

            // Order is the documented one: coverage is the more limiting row and
            // comes first, but it is no longer the only row.
            expect(keys).toEqual(['catalog_coverage', 'nutrition_tolerance']);
            expect(failure().limitingConstraints).toEqual(
                expect.arrayContaining([
                    {
                        constraintKey: 'nutrition_tolerance',
                        value: CALORIE_TOLERANCE_RATIO * 100,
                        unit: 'percent',
                        slots: [],
                        editStep: 'goal',
                    },
                ]),
            );
        });

        it('carries the search frontier on the error, where the wire cannot', () => {
            const thrown = failure();

            expect(thrown.searchDiagnostics).toEqual({
                exhausted: true,
                exhaustedBy: 'day',
                frontierDayIndex: 0,
                frontierDate: START_DATE,
                evaluations: MAX_EVALUATIONS_PER_DAY,
            });
            expect(thrown.allergiesKept).toBe(true);
            // Diagnostic and optional: a caller that never ran a search still
            // raises the same error, which is what keeps the field off the
            // wire contract rather than a member of it.
            expect(new NoMatchingMealsError([]).searchDiagnostics).toBeUndefined();
        });
    });

    describe('the empty-slot exhaustion fixture', () => {
        // The sibling case of the fixture above, and the boundary of what
        // exhaustion reopens: dinner has NO recipes, so the week is impossible
        // whatever the targets say — yet breakfast and lunch have enough
        // candidates to spend the whole per-day allowance being placed and
        // unplaced before the search gives up. Exhaustion is therefore true
        // here too, and the tolerance row must still stay away: a band cannot
        // be the open question for a slot nothing can fill, and offering it
        // would send the user to edit a target that was never the problem.
        const catalog = (): PlanRecipeCandidate[] => [
            ...Array.from({ length: 20 }, (_unused, index) =>
                makeRecipe({
                    slug: `breakfast-${String(index).padStart(2, '0')}`,
                    slots: ['breakfast'],
                    calories: 60 + index,
                }),
            ),
            ...Array.from({ length: 20 }, (_unused, index) =>
                makeRecipe({
                    slug: `lunch-${String(index).padStart(2, '0')}`,
                    slots: ['lunch'],
                    calories: 60 + index,
                }),
            ),
        ];

        it('exhausts the budget even with nothing to put in the slot', () => {
            const outcome = searchFor(catalog());

            expect(outcome.days).toBeNull();
            expect(outcome.exhausted).toBe(true);
            expect(outcome.exhaustedBy).toBe('day');
        });

        it('reports the uncovered slot alone, never the tolerance band', () => {
            let thrown: unknown;

            try {
                plan(catalog());
            } catch (error) {
                thrown = error;
            }

            const failure = thrown as NoMatchingMealsError;

            expect(failure.limitingConstraints).toEqual([
                {
                    constraintKey: 'slot_coverage',
                    value: 0,
                    unit: 'recipes',
                    slots: ['dinner'],
                    editStep: 'schedule',
                },
            ]);
            // The diagnostics still travel — the search did run out, and a log
            // reading "exhausted" beside a slot at zero is the true story.
            expect(failure.searchDiagnostics?.exhausted).toBe(true);
        });
    });

    describe('the infeasible-retry fixture', () => {
        // Every recipe takes 45 minutes and the user allowed 30, so nothing is
        // eligible. Retrying cannot help: the key is not an input to anything.
        const catalog = (): PlanRecipeCandidate[] =>
            feasibleCatalog().map((recipe) => ({ ...recipe, total_minutes: 45 }));

        const restricted = makePreferences({ cooking_time_limit_min: 30 });

        const constraintsFor = (preferences: PlanGenerationPreferences): NoMatchingMealsError => {
            try {
                plan(catalog(), preferences);
            } catch (error) {
                return error as NoMatchingMealsError;
            }

            throw new Error('expected NoMatchingMealsError');
        };

        it('reaches the same verdict on every attempt', () => {
            const first = constraintsFor(restricted);
            const second = constraintsFor(restricted);

            expect(second.limitingConstraints).toEqual(first.limitingConstraints);
        });

        it('names the cooking time as the constraint that would open the week', () => {
            const failure = constraintsFor(restricted);

            expect(failure.limitingConstraints).toEqual(
                expect.arrayContaining([
                    {
                        constraintKey: 'cooking_time',
                        value: 30,
                        unit: 'minutes',
                        slots: [],
                        editStep: 'cooking',
                    },
                ]),
            );
        });

        it('becomes feasible only once a preference actually changes', () => {
            const result = plan(catalog(), makePreferences({ cooking_time_limit_min: 45 }));

            expect(result.days).toHaveLength(PLAN_DAY_COUNT);
        });

        it('never suggests relaxing an allergy', () => {
            const failure = constraintsFor(
                makePreferences({ cooking_time_limit_min: 30, allergens: ['Milk', 'Peanuts'] }),
            );

            for (const constraint of failure.limitingConstraints) {
                expect(constraint.constraintKey).not.toBe('allergen');
                expect(JSON.stringify(constraint)).not.toContain('Milk');
            }
        });
    });
});

/* ---------------------------------------------------------------------------
 * searchPlanWeek — the two evaluation guards, told apart
 *
 * Under the shipped policy the per-plan cap is exactly seven per-day caps, so a
 * week that trips one would trip the other at the same moment and no fixture
 * could say which rule ended the search. The injected budget is what separates
 * them: give the days more than they can spend and the plan little, and only
 * the plan guard can fire — and the other way round.
 * ------------------------------------------------------------------------- */

describe('searchPlanWeek', () => {
    /** Twenty recipes per slot, none of which can reach the day target. */
    const unreachableCatalog = (): PlanRecipeCandidate[] =>
        (['breakfast', 'lunch', 'dinner'] as MealSlot[]).flatMap((slot) =>
            Array.from({ length: 20 }, (_unused, index) =>
                makeRecipe({
                    slug: `${slot}-${String(index).padStart(2, '0')}`,
                    slots: [slot],
                    calories: 60 + index,
                }),
            ),
        );

    /**
     * Four breakfasts, four lunches and only THREE dinners. Three recipes used
     * twice each cover six days, so days 0 to 5 close and the seventh cannot —
     * the search therefore spends evaluations across several days before it
     * fails, which is what a plan-wide guard needs in order to be the guard
     * that fires.
     */
    const sixCoverableDays = (): PlanRecipeCandidate[] => [
        ...['b1', 'b2', 'b3', 'b4'].map((slug) =>
            makeRecipe({ slug, slots: ['breakfast'], calories: 500 }),
        ),
        ...['l1', 'l2', 'l3', 'l4'].map((slug) => makeRecipe({ slug, slots: ['lunch'], calories: 700 })),
        ...['d1', 'd2', 'd3'].map((slug) => makeRecipe({ slug, slots: ['dinner'], calories: 800 })),
    ];

    /**
     * One dinner recipe, so day 1 can never place one: the recipe is on day 0
     * and the repetition rule forbids it on the next day. Day 1 therefore
     * dead-ends on every visit while day 0 keeps offering new assignments, and
     * day 1 is re-entered again and again — the fixture the accumulating
     * per-day counter is about.
     */
    const singleDinnerRecipe = (): PlanRecipeCandidate[] => [
        ...['b1', 'b2'].map((slug) => makeRecipe({ slug, slots: ['breakfast'], calories: 500 })),
        ...['l1', 'l2'].map((slug) => makeRecipe({ slug, slots: ['lunch'], calories: 700 })),
        makeRecipe({ slug: 'd1', slots: ['dinner'], calories: 800 }),
    ];

    it('spends exactly the per-day allowance on a day that cannot close', () => {
        const outcome = searchFor(unreachableCatalog());

        expect(outcome.days).toBeNull();
        expect(outcome.exhausted).toBe(true);
        expect(outcome.exhaustedBy).toBe('day');
        expect(outcome.evaluations).toBe(MAX_EVALUATIONS_PER_DAY);
        expect(outcome.frontierDayIndex).toBe(0);
        expect(outcome.aborted).toBe(false);
    });

    it('reports no exhaustion when the week closes inside the budget', () => {
        const outcome = searchFor(feasibleCatalog());

        expect(outcome.days).toHaveLength(PLAN_DAY_COUNT);
        expect(outcome.exhausted).toBe(false);
        expect(outcome.exhaustedBy).toBeNull();
        expect(outcome.evaluations).toBeLessThan(MAX_EVALUATIONS_PER_PLAN);
    });

    it('names the plan guard when the spend crossed day boundaries', () => {
        const perPlan = 200;
        const outcome = searchFor(sixCoverableDays(), { perDay: 1000000, perPlan });

        expect(outcome.days).toBeNull();
        expect(outcome.exhausted).toBe(true);
        expect(outcome.exhaustedBy).toBe('plan');
        expect(outcome.evaluations).toBe(perPlan);
        // Days before the frontier closed, so the 200 evaluations were spent
        // over several days rather than inside one.
        expect(outcome.frontierDayIndex).toBeGreaterThanOrEqual(1);
    });

    it('is the plan guard and not seven day guards, at the same number', () => {
        const cap = 200;
        const asPlanBudget = searchFor(sixCoverableDays(), { perDay: 1000000, perPlan: cap });
        const asDayBudget = searchFor(sixCoverableDays(), { perDay: cap, perPlan: 1000000 });

        // The same catalog, the same number, two different rules: the plan cap
        // stops the search at 200 placements in total, while giving every day
        // 200 of its own lets the week spend more than that before any single
        // day runs out. A per-plan counter that reset per day could not
        // produce the first answer.
        expect(asPlanBudget.exhaustedBy).toBe('plan');
        expect(asPlanBudget.evaluations).toBe(cap);
        expect(asDayBudget.exhaustedBy).toBe('day');
        expect(asDayBudget.evaluations).toBeGreaterThan(cap);
    });

    it('keeps one day spending the same allowance however often it is re-entered', () => {
        const preferences = makePreferences();
        const candidates = buildPlanCandidates(
            singleDinnerRecipe(),
            preferences,
            derivePlanSeed(makeSeedInputs()),
        );
        const breakfasts = candidatesForSlot(candidates, preferences, 'breakfast').length;
        const lunches = candidatesForSlot(candidates, preferences, 'lunch').length;

        // What ONE visit to day 1 can possibly spend: one evaluation per legal
        // breakfast, then one per (breakfast, lunch) pair, and nothing at
        // dinner because the only dinner recipe was used yesterday. A budget
        // one above that ceiling is unreachable within a single visit.
        const singleVisitCeiling = breakfasts + breakfasts * lunches;
        const outcome = searchFor(singleDinnerRecipe(), {
            perDay: singleVisitCeiling + 1,
            perPlan: 1000000,
        });

        expect(outcome.exhaustedBy).toBe('day');
        expect(outcome.frontierDayIndex).toBe(1);
        expect(outcome.evaluations).toBeGreaterThan(singleVisitCeiling);

        // And the fixture itself is finite: given room, the search explores the
        // whole tree and reports a settled infeasibility rather than a budget.
        const unbounded = searchFor(singleDinnerRecipe(), { perDay: 1000000, perPlan: 1000000 });

        expect(unbounded.exhausted).toBe(false);
        expect(unbounded.evaluations).toBeGreaterThan(singleVisitCeiling);
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses the per-day budget %p', (perDay) => {
        expect(() => searchFor(feasibleCatalog(), { perDay })).toThrow(MealPlanInputError);
    });

    it.each([0, -1, 1.5, Number.NaN])('refuses the per-plan budget %p', (perPlan) => {
        expect(() => searchFor(feasibleCatalog(), { perPlan })).toThrow(MealPlanInputError);
    });

    it('falls back to the shipped policy for a budget it was not given', () => {
        // An empty budget object is the production case spelled out: neither
        // cap is supplied, so both constants apply and the week still plans.
        expect(searchFor(feasibleCatalog(), {}).days).toHaveLength(PLAN_DAY_COUNT);
        expect(searchFor(unreachableCatalog(), { perPlan: MAX_EVALUATIONS_PER_PLAN }).evaluations).toBe(
            MAX_EVALUATIONS_PER_DAY,
        );
    });
});

/* ---------------------------------------------------------------------------
 * searchPlanWeek — §0.7.3's two repetition clauses, and only those two
 *
 * The rule permits a recipe twice in one week and forbids it on consecutive
 * days. Two slots of the SAME day are therefore a legal pair, and these two
 * fixtures are the ones that would fail under the unwritten same-day ban the
 * generator used to carry: the first because the day only closes with a pair,
 * the second because a pair that is partly unwound must still count against
 * the following day.
 *
 * Both run over a SHORT week rather than seven days. The day count is an input
 * to `searchPlanWeek`, and a short run is the smallest thing that can state
 * each property — one day for "the pair is what closes it", and three for "the
 * day after a partly unwound pair still sees it", which needs a day to pair on,
 * the day that must refuse it, and one more for the search to have somewhere to
 * backtrack from.
 * ------------------------------------------------------------------------- */

describe('searchPlanWeek — same-day repetition', () => {
    const CARB_DENSE: MealPlanMacroTotals = { calories: 450, protein: 10, carbs: 85, fat: 6 };
    const FAT_DENSE: MealPlanMacroTotals = { calories: 600, protein: 20, carbs: 25, fat: 45 };
    const HUGE: MealPlanMacroTotals = { calories: 1000, protein: 75, carbs: 100, fat: 33 };
    const BIG: MealPlanMacroTotals = { calories: 900, protein: 70, carbs: 95, fat: 30 };
    const BALANCED: MealPlanMacroTotals = { calories: 800, protein: 55, carbs: 70, fat: 28 };
    const LEAN: MealPlanMacroTotals = { calories: 500, protein: 60, carbs: 45, fat: 10 };
    const PROTEIN_DENSE: MealPlanMacroTotals = { calories: 600, protein: 80, carbs: 20, fat: 15 };

    /**
     * The production search over the first `dayCount` days of the week.
     *
     * Everything except `dates` is assembled exactly as {@link generateWeeklyPlan}
     * assembles it, so the rules under test are the shipped ones; the shorter
     * date list only keeps the fixtures small enough to reason about by hand.
     */
    const searchDays = (recipes: PlanRecipeCandidate[], dayCount: number): PlanSearchOutcome => {
        const seedInputs = makeSeedInputs();
        const preferences = makePreferences();
        const slots = resolveSlotSchedule(preferences.meal_schedule, preferences.meal_times);
        const candidates = buildPlanCandidates(recipes, preferences, derivePlanSeed(seedInputs));

        return searchPlanWeek({
            dates: planDatesFrom(seedInputs.startDate).slice(0, dayCount),
            slots,
            candidatesBySlot: new Map(
                slots.map((slot) => [slot.slot, candidatesForSlot(candidates, preferences, slot.slot)] as const),
            ),
            targets: TARGETS,
            userBudgetTier: resolveUserBudgetTier(
                preferences.budget,
                preferences.no_budget_preference,
                preferences.meal_schedule,
            ),
        });
    };

    describe('a day only a same-day pair can close', () => {
        // Four recipes, and the macro geometry admits no assignment of this day
        // that uses three DIFFERENT recipes — asserted below by enumerating
        // every candidate triple rather than asserted by construction. Under
        // the removed same-day clause this day, and so the whole week, was
        // `422 no_matching_meals`.
        const catalog = (): PlanRecipeCandidate[] => [
            makeRecipe({
                slug: 'carb-bl',
                slots: ['breakfast', 'lunch'],
                calories: 0,
                nutrition: CARB_DENSE,
            }),
            makeRecipe({ slug: 'fat-d', slots: ['dinner'], calories: 0, nutrition: FAT_DENSE }),
            makeRecipe({
                slug: 'fat-bd',
                slots: ['breakfast', 'dinner'],
                calories: 0,
                nutrition: FAT_DENSE,
            }),
            makeRecipe({
                slug: 'huge-bld',
                slots: ['breakfast', 'lunch', 'dinner'],
                calories: 0,
                nutrition: HUGE,
            }),
        ];

        const pools = (): PlanCandidate[][] => {
            const preferences = makePreferences();
            const candidates = buildPlanCandidates(catalog(), preferences, derivePlanSeed(makeSeedInputs()));

            return (['breakfast', 'lunch', 'dinner'] as MealSlot[]).map((slot) =>
                candidatesForSlot(candidates, preferences, slot),
            );
        };

        it('has more than one recipe in every slot, so this is not a coverage failure', () => {
            // The claim the removed clause rested on — "needing one recipe twice
            // in one day means a slot has fewer than two recipes" — stated and
            // refuted: every slot here offers two or three distinct recipes.
            const preferences = makePreferences();
            const candidates = buildPlanCandidates(catalog(), preferences, derivePlanSeed(makeSeedInputs()));

            for (const slot of ['breakfast', 'lunch', 'dinner'] as MealSlot[]) {
                expect(eligibleRecipeCountForSlot(candidates, preferences, slot)).toBeGreaterThan(1);
            }
        });

        it('has no assignment of three different recipes inside the day tolerance', () => {
            const [breakfasts, lunches, dinners] = pools();
            let feasible = 0;

            for (const breakfast of breakfasts) {
                for (const lunch of lunches) {
                    for (const dinner of dinners) {
                        const totals = computeDayTotals([
                            { planned: breakfast.nutrition },
                            { planned: lunch.nutrition },
                            { planned: dinner.nutrition },
                        ]);

                        if (!isDayWithinTolerance(totals, TARGETS)) {
                            continue;
                        }

                        feasible += 1;

                        const recipeIds = new Set([
                            breakfast.recipe.recipe_id,
                            lunch.recipe.recipe_id,
                            dinner.recipe.recipe_id,
                        ]);

                        expect(recipeIds.size).toBeLessThan(3);
                    }
                }
            }

            // The day IS closable — the assertion above would be vacuous for a
            // catalog nothing can close.
            expect(feasible).toBeGreaterThan(0);
        });

        it('closes the day with one recipe in two slots', () => {
            const outcome = searchDays(catalog(), 1);

            expect(outcome.aborted).toBe(false);
            expect(outcome.exhausted).toBe(false);
            expect(outcome.days).not.toBeNull();

            const day = (outcome.days as PlannedMealAssignment[][])[0];
            const slugs = day.map((meal) => meal.slug);

            expect(day).toHaveLength(3);
            expect(new Set(slugs).size).toBeLessThan(slugs.length);
            expect(isDayWithinTolerance(computeDayTotals(day), TARGETS)).toBe(true);
        });

        it('still holds the pair to the weekly cap', () => {
            const outcome = searchDays(catalog(), 1);
            const day = (outcome.days as PlannedMealAssignment[][])[0];
            const uses = new Map<string, number>();

            for (const meal of day) {
                uses.set(meal.slug, (uses.get(meal.slug) ?? 0) + 1);
            }

            for (const count of uses.values()) {
                expect(count).toBeLessThanOrEqual(MAX_RECIPE_USES_PER_WEEK);
            }
        });
    });

    describe('a same-day pair that is partly unwound', () => {
        // THE REFERENCE-COUNTING REGRESSION GUARD, and it is a real one: with
        // the per-day membership held as a plain set — added on every placement
        // and deleted on every unwind — this three-day search comes back with
        // `protein-bd` on day 1 AND day 2, because unwinding the second of a
        // same-day pair erased the recipe from the day while the first was still
        // placed, and day 2's adjacent-day exclusion then could not see it.
        // Counting the placements per day is what keeps that exclusion true.
        const catalog = (): PlanRecipeCandidate[] => [
            makeRecipe({
                slug: 'lean-bld',
                slots: ['breakfast', 'lunch', 'dinner'],
                calories: 0,
                nutrition: LEAN,
            }),
            makeRecipe({ slug: 'big-ld', slots: ['lunch', 'dinner'], calories: 0, nutrition: BIG }),
            makeRecipe({
                slug: 'balanced-ld',
                slots: ['lunch', 'dinner'],
                calories: 0,
                nutrition: BALANCED,
            }),
            makeRecipe({ slug: 'big-l', slots: ['lunch'], calories: 0, nutrition: BIG }),
            makeRecipe({
                slug: 'protein-bd',
                slots: ['breakfast', 'dinner'],
                calories: 0,
                nutrition: PROTEIN_DENSE,
            }),
            makeRecipe({ slug: 'carb-ld', slots: ['lunch', 'dinner'], calories: 0, nutrition: CARB_DENSE }),
        ];

        const week = (): PlannedMealAssignment[][] => {
            const outcome = searchDays(catalog(), 3);

            expect(outcome.days).not.toBeNull();

            return outcome.days as PlannedMealAssignment[][];
        };

        it('places a same-day pair, so the unwind path is exercised', () => {
            const days = week();
            const paired = days.filter((day) => {
                const slugs = day.map((meal) => meal.slug);

                return new Set(slugs).size < slugs.length;
            });

            expect(paired.length).toBeGreaterThan(0);
        });

        it('refuses the paired recipe on the following day', () => {
            const days = week();

            days.forEach((day, dayIndex) => {
                if (dayIndex === 0) {
                    return;
                }

                const yesterday = new Set(days[dayIndex - 1].map((meal) => meal.slug));

                for (const meal of day) {
                    expect(yesterday.has(meal.slug)).toBe(false);
                }
            });
        });

        it('keeps every day inside the tolerance it was accepted under', () => {
            for (const day of week()) {
                expect(day).toHaveLength(3);
                expect(isDayWithinTolerance(computeDayTotals(day), TARGETS)).toBe(true);
            }
        });
    });
});

/* ---------------------------------------------------------------------------
 * Limiting-constraint analysis
 * ------------------------------------------------------------------------- */

describe('analyzeLimitingConstraints', () => {
    /** The verdict's rows — what every case below is about. */
    const analyze = (
        recipes: PlanRecipeCandidate[],
        preferences: PlanGenerationPreferences = makePreferences(),
    ) =>
        analyzeLimitingConstraints({
            seedInputs: makeSeedInputs(),
            preferences,
            targets: TARGETS,
            recipes,
        }).constraints;

    const keys = (recipes: PlanRecipeCandidate[], preferences?: PlanGenerationPreferences) =>
        analyze(recipes, preferences).map((constraint) => constraint.constraintKey);

    it('names an uncovered slot first', () => {
        const withoutLunch = feasibleCatalog().filter((recipe) => !recipe.slug.startsWith('l'));
        const [first] = analyze(withoutLunch);

        expect(first).toEqual({
            constraintKey: 'slot_coverage',
            value: 0,
            unit: 'recipes',
            slots: ['lunch'],
            editStep: 'schedule',
        });
    });

    it('reports thin coverage measured on the real intersection', () => {
        const thinDinner = [
            ...feasibleCatalog().filter((recipe) => !recipe.slug.startsWith('d')),
            ...['d1', 'd2'].map((slug) => makeRecipe({ slug, slots: ['dinner'], calories: 800 })),
        ];

        expect(analyze(thinDinner)).toEqual([
            {
                constraintKey: 'catalog_coverage',
                value: 2,
                unit: 'recipes',
                slots: ['dinner'],
                editStep: 'schedule',
            },
        ]);
    });

    describe('the coverage threshold — three reports, four does not', () => {
        // MIN_ELIGIBLE_RECIPES_PER_SLOT is arithmetic: seven days, two uses per
        // recipe, never on consecutive days. Three recipes cannot cover a week
        // and four can, so the row turns on exactly that boundary — and the
        // count is taken on the user's REAL intersection, which is why this
        // dinner shelf carries three extra recipes that look available and are
        // not: one the diet refuses, one the allergy refuses, one the dislike
        // refuses. A check that measured the raw catalog would see six.
        const preferences = makePreferences({
            diet: 'vegan',
            allergens: ['Milk'],
            disliked_food_ids: ['blocked-food'],
        });

        const eligibleDinner = (slug: string): PlanRecipeCandidate =>
            makeRecipe({ slug, slots: ['dinner'], calories: 800 });

        const dinnerShelf = (eligibleSlugs: string[]): PlanRecipeCandidate[] => [
            ...eligibleSlugs.map(eligibleDinner),
            makeRecipe({ slug: 'd-not-vegan', slots: ['dinner'], calories: 800, dietTags: ['pescatarian'] }),
            makeRecipe({ slug: 'd-milk', slots: ['dinner'], calories: 800, allergenTags: ['milk'] }),
            makeRecipe({
                slug: 'd-disliked',
                slots: ['dinner'],
                calories: 800,
                ingredientIds: ['blocked-food'],
            }),
        ];

        const catalogWith = (eligibleSlugs: string[]): PlanRecipeCandidate[] => [
            ...feasibleCatalog().filter((recipe) => !recipe.slug.startsWith('d')),
            ...dinnerShelf(eligibleSlugs),
        ];

        const dinnerCount = (recipes: PlanRecipeCandidate[]): number =>
            eligibleRecipeCountForSlot(
                buildPlanCandidates(recipes, preferences, derivePlanSeed(makeSeedInputs())),
                preferences,
                'dinner',
            );

        it('measures the intersection rather than the shelf', () => {
            expect(dinnerShelf(['d1', 'd2', 'd3'])).toHaveLength(6);
            expect(dinnerCount(catalogWith(['d1', 'd2', 'd3']))).toBe(3);
            expect(dinnerCount(catalogWith(['d1', 'd2', 'd3', 'd4']))).toBe(4);
        });

        it('reports exactly one coverage row at three eligible recipes', () => {
            const catalog = catalogWith(['d1', 'd2', 'd3']);
            const constraints = analyze(catalog, preferences);
            const coverage = constraints.filter(
                (constraint) =>
                    constraint.constraintKey === 'catalog_coverage' ||
                    constraint.constraintKey === 'slot_coverage',
            );

            expect(dinnerCount(catalog)).toBe(MIN_ELIGIBLE_RECIPES_PER_SLOT - 1);
            expect(coverage).toEqual([
                {
                    constraintKey: 'catalog_coverage',
                    value: 3,
                    unit: 'recipes',
                    slots: ['dinner'],
                    editStep: 'dislikes',
                },
            ]);
        });

        it('reports no coverage row at four, one recipe later', () => {
            const catalog = catalogWith(['d1', 'd2', 'd3', 'd4']);

            expect(dinnerCount(catalog)).toBe(MIN_ELIGIBLE_RECIPES_PER_SLOT);
            expect(keys(catalog, preferences)).not.toContain('catalog_coverage');
            expect(keys(catalog, preferences)).not.toContain('slot_coverage');
        });
    });

    it('does not blame the numbers when coverage is the problem', () => {
        const thinDinner = [
            ...feasibleCatalog().filter((recipe) => !recipe.slug.startsWith('d')),
            ...['d1', 'd2'].map((slug) => makeRecipe({ slug, slots: ['dinner'], calories: 800 })),
        ];

        expect(keys(thinDinner)).not.toContain('nutrition_tolerance');
    });

    it('points a thin-coverage user at their widest lever', () => {
        const thinDinner = [
            ...feasibleCatalog().filter((recipe) => !recipe.slug.startsWith('d')),
            ...['d1'].map((slug) => makeRecipe({ slug, slots: ['dinner'], calories: 800 })),
        ];

        expect(analyze(thinDinner, makePreferences({ disliked_food_ids: ['x'] }))[0].editStep).toBe(
            'dislikes',
        );
        expect(analyze(thinDinner, makePreferences({ diet: 'vegan' }))[0].editStep).toBe('diet');
        expect(
            analyze(thinDinner, makePreferences({ cooking_time_limit_min: 30 }))[0].editStep,
        ).toBe('cooking');
    });

    it('reports a dislike that is holding the week back', () => {
        const catalog = feasibleCatalog().map((recipe) =>
            recipe.slug.startsWith('d')
                ? makeRecipe({
                      slug: recipe.slug,
                      slots: ['dinner'],
                      calories: 800,
                      ingredientIds: ['blocked-food'],
                  })
                : recipe,
        );

        const constraints = analyze(catalog, makePreferences({ disliked_food_ids: ['blocked-food'] }));

        expect(constraints).toEqual(
            expect.arrayContaining([
                {
                    constraintKey: 'dislikes',
                    value: 1,
                    unit: 'foods',
                    slots: [],
                    editStep: 'dislikes',
                },
            ]),
        );
    });

    it('counts a dislike once even though a selection stores its group too', () => {
        const catalog = feasibleCatalog().map((recipe) =>
            recipe.slug.startsWith('d')
                ? makeRecipe({
                      slug: recipe.slug,
                      slots: ['dinner'],
                      calories: 800,
                      ingredientIds: ['blocked-food'],
                      foodGroups: ['blocked-group'],
                  })
                : recipe,
        );

        const constraints = analyze(
            catalog,
            makePreferences({
                disliked_food_ids: ['blocked-food'],
                disliked_food_groups: ['blocked-group'],
            }),
        );
        const dislikes = constraints.find((constraint) => constraint.constraintKey === 'dislikes');

        expect(dislikes?.value).toBe(1);
    });

    it('reports a diet that is holding the week back, with no number to show', () => {
        const catalog = feasibleCatalog().map((recipe) =>
            recipe.slug.startsWith('d')
                ? makeRecipe({
                      slug: recipe.slug,
                      slots: ['dinner'],
                      calories: 800,
                      dietTags: ['pescatarian'],
                  })
                : recipe,
        );

        const constraints = analyze(catalog, makePreferences({ diet: 'vegan' }));

        expect(constraints).toEqual(
            expect.arrayContaining([
                { constraintKey: 'diet', value: null, unit: null, slots: [], editStep: 'diet' },
            ]),
        );
    });

    it('omits a relaxation that would not help', () => {
        const withoutDinner = feasibleCatalog().filter((recipe) => !recipe.slug.startsWith('d'));

        expect(keys(withoutDinner, makePreferences({ diet: 'vegan' }))).not.toContain('diet');
    });

    it('reports the tolerance band when eligibility held but no week fit', () => {
        const tooLight = feasibleCatalog().map((recipe) => ({
            ...recipe,
            per_serving: proportional(80),
        }));

        expect(analyze(tooLight)).toEqual([
            {
                constraintKey: 'nutrition_tolerance',
                value: CALORIE_TOLERANCE_RATIO * 100,
                unit: 'percent',
                slots: [],
                editStep: 'goal',
            },
        ]);
    });

    it('reports the portion limits when only a wider set would have closed the week', () => {
        // Each slot needs 2.5 servings to reach its share, which the offered
        // multipliers stop short of and the extended set reaches.
        const catalog = [
            ...['b1', 'b2', 'b3', 'b4'].map((slug) =>
                makeRecipe({ slug, slots: ['breakfast'], calories: 200 }),
            ),
            ...['l1', 'l2', 'l3', 'l4'].map((slug) =>
                makeRecipe({ slug, slots: ['lunch'], calories: 280 }),
            ),
            ...['d1', 'd2', 'd3', 'd4'].map((slug) =>
                makeRecipe({ slug, slots: ['dinner'], calories: 320 }),
            ),
        ];

        expect(keys(catalog)).toContain('portion_limits');
    });

    it('never reports portion limits while a slot is empty', () => {
        expect(keys([])).not.toContain('portion_limits');
    });

    it('always returns at least one actionable row', () => {
        expect(analyze(feasibleCatalog()).length).toBeGreaterThan(0);
    });

    describe('attribution — a row is a claim about its own preference', () => {
        // Every case here sets a preference that blocks NOTHING in the catalog:
        // the week closes with the preference in force, so relaxing it admits
        // no recipe the baseline lacked. A probe that succeeded on the
        // baseline's own candidates in a shuffled move order would report these
        // preferences as what is holding the week back, which is the false
        // attribution the witness rule exists to refuse.
        it('does not blame a dislike that removes nothing', () => {
            expect(keys(feasibleCatalog(), makePreferences({ disliked_food_ids: ['never-used'] }))).not.toContain(
                'dislikes',
            );
        });

        it('does not blame the portions when the offered multipliers close the week', () => {
            expect(keys(feasibleCatalog())).not.toContain('portion_limits');
        });

        it('does not blame a diet every recipe already satisfies', () => {
            expect(keys(feasibleCatalog(), makePreferences({ diet: 'vegan' }))).not.toContain('diet');
        });

        it('does not blame a cooking limit every recipe already meets', () => {
            expect(
                keys(feasibleCatalog(), makePreferences({ cooking_time_limit_min: 30 })),
            ).not.toContain('cooking_time');
        });

        it('still blames the dislike that a relaxation genuinely needs', () => {
            // The positive half of the same rule, and the reason the four cases
            // above are not simply "never report anything": here the relaxed
            // week can only be built from the recipes the dislike removed, so
            // the witness holds and the row is earned.
            const catalog = feasibleCatalog().map((recipe) =>
                recipe.slug.startsWith('d')
                    ? makeRecipe({
                          slug: recipe.slug,
                          slots: ['dinner'],
                          calories: 800,
                          ingredientIds: ['blocked-food'],
                      })
                    : recipe,
            );

            expect(keys(catalog, makePreferences({ disliked_food_ids: ['blocked-food'] }))).toContain(
                'dislikes',
            );
        });

        it('reaches an identical list on repeated runs', () => {
            const catalog = feasibleCatalog().map((recipe) =>
                recipe.slug.startsWith('d')
                    ? makeRecipe({
                          slug: recipe.slug,
                          slots: ['dinner'],
                          calories: 800,
                          dietTags: ['pescatarian'],
                      })
                    : recipe,
            );
            const preferences = makePreferences({
                diet: 'vegan',
                disliked_food_ids: ['blocked-food'],
                cooking_time_limit_min: 30,
            });

            expect(analyze(catalog, preferences)).toEqual(analyze(catalog, preferences));
        });
    });

    it('keeps relaxation probes quiet once the deadline has passed', () => {
        const { constraints } = analyzeLimitingConstraints({
            seedInputs: makeSeedInputs(),
            preferences: makePreferences({ cooking_time_limit_min: 30 }),
            targets: TARGETS,
            recipes: feasibleCatalog().map((recipe) => ({ ...recipe, total_minutes: 45 })),
            shouldAbort: () => true,
        });

        expect(constraints.map((constraint) => constraint.constraintKey)).not.toContain('cooking_time');
        expect(constraints.length).toBeGreaterThan(0);
    });

    describe('the request-scoped probe budget', () => {
        /**
         * Sixty recipes no portion of which can reach the day target, all at 45
         * cooking minutes. Against a 30-minute limit every slot is EMPTY, so the
         * relaxation to the 45-minute tier is the probe that runs — and it
         * searches a catalog it cannot close, which is what makes it spend
         * whatever allowance it is given instead of a handful of evaluations.
         */
        const unclosableAt45Minutes = (): PlanRecipeCandidate[] =>
            (['breakfast', 'lunch', 'dinner'] as MealSlot[]).flatMap((slot) =>
                Array.from({ length: 20 }, (_unused, index) =>
                    makeRecipe({
                        slug: `${slot}-${String(index).padStart(2, '0')}`,
                        slots: [slot],
                        calories: 60 + index,
                        totalMinutes: 45,
                    }),
                ),
            );

        /** Two relaxations to probe, in the order the verdict tries them. */
        const twoProbePreferences = makePreferences({
            cooking_time_limit_min: 30,
            disliked_food_ids: ['blocked-food'],
        });

        it('runs no probe at all once the primary search has spent the per-plan bound', () => {
            const verdict = analyzeLimitingConstraints({
                seedInputs: makeSeedInputs(),
                preferences: twoProbePreferences,
                targets: TARGETS,
                recipes: unclosableAt45Minutes(),
                diagnostics: {
                    exhausted: true,
                    exhaustedBy: 'plan',
                    frontierDayIndex: 0,
                    evaluations: MAX_EVALUATIONS_PER_PLAN,
                },
            });

            expect(verdict.probeEvaluations).toBe(0);
            expect(verdict.probeOutcome).toBe('budget_exhausted');

            // The verdict still answers. An exhausted pool costs rows that
            // needed a witness, never the response's promise of something to act
            // on.
            expect(verdict.constraints.length).toBeGreaterThan(0);
        });

        it('holds every probe together to the remaining allowance', () => {
            const remaining = 120;
            const verdict = analyzeLimitingConstraints({
                seedInputs: makeSeedInputs(),
                preferences: twoProbePreferences,
                targets: TARGETS,
                recipes: unclosableAt45Minutes(),
                probeEvaluationBudget: remaining,
            });

            expect(verdict.probeEvaluations).toBeLessThanOrEqual(remaining);

            // The first probe spends the pool and the second never runs, which
            // is the state `budget_exhausted` names.
            expect(verdict.probeEvaluations).toBe(remaining);
            expect(verdict.probeOutcome).toBe('budget_exhausted');
            expect(verdict.constraints.length).toBeGreaterThan(0);
        });

        it('refuses a pool that is not a whole number of evaluations', () => {
            for (const probeEvaluationBudget of [-1, 1.5, Number.NaN]) {
                expect(() =>
                    analyzeLimitingConstraints({
                        seedInputs: makeSeedInputs(),
                        preferences: twoProbePreferences,
                        targets: TARGETS,
                        recipes: unclosableAt45Minutes(),
                        probeEvaluationBudget,
                    }),
                ).toThrow(MealPlanInputError);
            }
        });

        it('keeps the primary search and the probes inside one per-plan bound', () => {
            // The statement §0.7.3 actually makes about a request, asserted end
            // to end: the search that failed plus every probe that explained it.
            // This catalog is the only one here that makes both halves spend —
            // twenty unclosable recipes per slot INSIDE the 30-minute limit, so
            // the primary search burns its allowance, and twenty more per slot
            // at 45 minutes, so the relaxation probe has a larger unclosable
            // catalog of its own to burn through.
            const bothHalvesSpend = (): PlanRecipeCandidate[] => [
                ...unclosableAt45Minutes(),
                ...(['breakfast', 'lunch', 'dinner'] as MealSlot[]).flatMap((slot) =>
                    Array.from({ length: 20 }, (_unused, index) =>
                        makeRecipe({
                            slug: `quick-${slot}-${String(index).padStart(2, '0')}`,
                            slots: [slot],
                            calories: 60 + index,
                            totalMinutes: 20,
                        }),
                    ),
                ),
            ];

            const primary = searchFor(bothHalvesSpend(), undefined, twoProbePreferences);

            expect(primary.days).toBeNull();
            expect(primary.exhausted).toBe(true);

            const verdict = analyzeLimitingConstraints({
                seedInputs: makeSeedInputs(),
                preferences: twoProbePreferences,
                targets: TARGETS,
                recipes: bothHalvesSpend(),
                diagnostics: {
                    exhausted: primary.exhausted,
                    exhaustedBy: primary.exhaustedBy,
                    frontierDayIndex: primary.frontierDayIndex,
                    evaluations: primary.evaluations,
                },
            });

            expect(verdict.probeEvaluations).toBeGreaterThan(0);
            expect(primary.evaluations + verdict.probeEvaluations).toBeLessThanOrEqual(
                MAX_EVALUATIONS_PER_PLAN,
            );
            expect(verdict.probeEvaluations).toBeLessThanOrEqual(
                MAX_EVALUATIONS_PER_PLAN - primary.evaluations,
            );
        });

        it('leaves the probes only what a nearly spent primary search did not use', () => {
            // The case the bound exists for: a primary search that spent almost
            // the whole per-plan allowance. The probes get the remainder and
            // nothing more, so the request still totals no more than
            // MAX_EVALUATIONS_PER_PLAN — where a probe with its own fresh
            // budget would add thousands on top.
            const spentByPrimary = MAX_EVALUATIONS_PER_PLAN - 50;
            const verdict = analyzeLimitingConstraints({
                seedInputs: makeSeedInputs(),
                preferences: twoProbePreferences,
                targets: TARGETS,
                recipes: unclosableAt45Minutes(),
                diagnostics: {
                    exhausted: true,
                    exhaustedBy: 'plan',
                    frontierDayIndex: PLAN_DAY_COUNT - 1,
                    evaluations: spentByPrimary,
                },
            });

            expect(verdict.probeEvaluations).toBe(50);
            expect(spentByPrimary + verdict.probeEvaluations).toBe(MAX_EVALUATIONS_PER_PLAN);
            expect(verdict.probeOutcome).toBe('budget_exhausted');
        });

        describe('an aborted probe is inconclusive, never a negative claim', () => {
            // A catalog whose dinners all carry the disliked food, so ignoring
            // the dislike is a relaxation that genuinely opens the week and earns
            // its row — which is what makes the row's ABSENCE below evidence
            // that the probe never ran.
            const dislikeBlockedCatalog = (): PlanRecipeCandidate[] =>
                feasibleCatalog().map((recipe) =>
                    recipe.slug.startsWith('d')
                        ? makeRecipe({
                              slug: recipe.slug,
                              slots: ['dinner'],
                              calories: 800,
                              ingredientIds: ['blocked-food'],
                          })
                        : recipe,
                );

            /** Aborts the first probe only, leaving later ones free to run. */
            const abortOnce = (): (() => boolean) => {
                let fired = false;

                return () => {
                    if (fired) {
                        return false;
                    }

                    fired = true;

                    return true;
                };
            };

            it('earns the dislikes row when no deadline interferes', () => {
                const verdict = analyzeLimitingConstraints({
                    seedInputs: makeSeedInputs(),
                    preferences: twoProbePreferences,
                    targets: TARGETS,
                    recipes: dislikeBlockedCatalog(),
                });

                expect(verdict.constraints.map((constraint) => constraint.constraintKey)).toContain(
                    'dislikes',
                );
                expect(verdict.probeOutcome).toBe('complete');
            });

            it('reports the abort and stops, rather than reporting a relaxation as tested', () => {
                const verdict = analyzeLimitingConstraints({
                    seedInputs: makeSeedInputs(),
                    preferences: twoProbePreferences,
                    targets: TARGETS,
                    recipes: dislikeBlockedCatalog(),
                    shouldAbort: abortOnce(),
                });

                expect(verdict.probeOutcome).toBe('aborted');

                // The cooking-time probe took the abort; the dislikes probe that
                // would have earned its row never ran, so neither row is
                // claimed — and the status is what says the absence is
                // ignorance rather than a finding.
                expect(verdict.constraints.map((constraint) => constraint.constraintKey)).not.toContain(
                    'cooking_time',
                );
                expect(verdict.constraints.map((constraint) => constraint.constraintKey)).not.toContain(
                    'dislikes',
                );
                expect(verdict.constraints.length).toBeGreaterThan(0);
            });

            it('turns a deadline that first fires inside a probe into the 502, not a 422', () => {
                // THE REQUEST BOUNDARY, not just the verdict. §0.7.3 and this
                // module's header put the rule plainly: only an ABORTED search
                // is a 5xx, and a probe IS a search. So a deadline that expires
                // after the primary search has honestly concluded "no week",
                // while the analysis is still deciding WHICH constraint to
                // blame, has to reach the user as "we couldn't finish your
                // plan" — never as a `no_matching_meals` naming whichever
                // constraints happened to be measured before the clock ran out.
                // Recording the abort in the verdict is not enough if
                // `generateWeeklyPlan` then drops it.
                //
                // WHERE THE PRIMARY SEARCH ENDS IS MEASURED, NEVER ASSUMED. How
                // often either phase consults `shouldAbort` is an internal
                // cadence this test must not encode, so it is derived in three
                // steps below and a deadline is armed exactly one poll after
                // the primary's last one. That is what makes "fires inside the
                // first probe" a fact here rather than a hope.
                const recipes = dislikeBlockedCatalog();
                const counter = (): { polls: () => number; shouldAbort: () => boolean } => {
                    let polls = 0;

                    return {
                        polls: () => polls,
                        shouldAbort: () => {
                            polls += 1;

                            return false;
                        },
                    };
                };

                // 1. The primary search on its own: it must finish, and find
                //    nothing. Its diagnostics are also what bounds the probes,
                //    so passing them on in step 2 reproduces the real pool.
                const primary = searchFor(recipes, undefined, twoProbePreferences);

                expect(primary.aborted).toBe(false);
                expect(primary.days).toBeNull();

                const diagnostics = {
                    exhausted: primary.exhausted,
                    exhaustedBy: primary.exhaustedBy,
                    frontierDayIndex: primary.frontierDayIndex,
                    evaluations: primary.evaluations,
                };

                // 2. The analysis alone, polled but never aborting.
                const probeOnly = counter();

                analyzeLimitingConstraints({
                    seedInputs: makeSeedInputs(),
                    preferences: twoProbePreferences,
                    targets: TARGETS,
                    recipes,
                    diagnostics,
                    shouldAbort: probeOnly.shouldAbort,
                });

                // 3. The whole call, polled the same way. The difference is the
                //    primary search's share.
                const whole = counter();

                expect(() =>
                    plan(recipes, twoProbePreferences, makeSeedInputs(), whole.shouldAbort),
                ).toThrow(NoMatchingMealsError);

                const primaryPolls = whole.polls() - probeOnly.polls();

                // Guards, so a future change of shape fails here loudly instead
                // of leaving the assertion below passing for the wrong reason:
                // the probes must actually poll, and the primary's share cannot
                // be negative.
                expect(probeOnly.polls()).toBeGreaterThan(0);
                expect(primaryPolls).toBeGreaterThanOrEqual(0);

                // The deadline fires on the poll straight after the primary's
                // last — the first poll any probe makes.
                let polls = 0;
                const deadlineInFirstProbe = (): boolean => {
                    polls += 1;

                    return polls > primaryPolls;
                };

                expect(() =>
                    plan(recipes, twoProbePreferences, makeSeedInputs(), deadlineInFirstProbe),
                ).toThrow(PlanGenerationError);
            });
        });
    });
});

describe('nextCookingTimeTier', () => {
    it.each([
        [15, 30],
        [30, 45],
        [45, 60],
    ])('raises %i to %i', (limit, expected) => {
        expect(nextCookingTimeTier(limit)).toBe(expected);
    });

    it('has nothing above the top tier', () => {
        expect(nextCookingTimeTier(60)).toBeNull();
    });

    it('has nothing to raise when there is no limit', () => {
        expect(nextCookingTimeTier(null)).toBeNull();
    });

    it('raises an off-ladder limit to the next tier above it', () => {
        expect(nextCookingTimeTier(20)).toBe(30);
    });
});

/* ---------------------------------------------------------------------------
 * Plan lifecycle
 * ------------------------------------------------------------------------- */

describe('plan lifecycle', () => {
    const TODAY = '2026-07-08';

    const planState = (overrides: Partial<Parameters<typeof isPlanWritable>[0]> = {}) => ({
        id: 'plan-current',
        status: 'active',
        start_date: '2026-07-05',
        end_date: '2026-07-11',
        replacement_plan_id: null,
        ...overrides,
    });

    describe('isPlanEnded', () => {
        it('is false on the last day itself', () => {
            expect(isPlanEnded({ end_date: '2026-07-08' }, TODAY)).toBe(false);
        });

        it('is true the day after the last day', () => {
            expect(isPlanEnded({ end_date: '2026-07-07' }, TODAY)).toBe(true);
        });

        it('refuses a malformed key rather than comparing nonsense', () => {
            expect(() => isPlanEnded({ end_date: 'later' }, TODAY)).toThrow(MealPlanInputError);
            expect(() => isPlanEnded({ end_date: '2026-07-07' }, 'now')).toThrow(MealPlanInputError);
        });
    });

    describe('isPlanActiveStatus and isPlanWritable', () => {
        it('reads the stored status', () => {
            expect(isPlanActiveStatus({ status: 'active' })).toBe(true);
            expect(isPlanActiveStatus({ status: 'superseded' })).toBe(false);
        });

        it('needs both an active status and a live week', () => {
            expect(isPlanWritable(planState(), TODAY)).toBe(true);
            expect(isPlanWritable(planState({ status: 'superseded' }), TODAY)).toBe(false);
            expect(
                isPlanWritable(planState({ start_date: '2026-06-01', end_date: '2026-06-07' }), TODAY),
            ).toBe(false);
        });
    });

    describe('requireWritablePlan', () => {
        it('returns the plan untouched when it may be written to', () => {
            const subject = planState();

            expect(requireWritablePlan(subject, TODAY)).toBe(subject);
        });

        it('points a superseded plan at its replacement', () => {
            try {
                requireWritablePlan(
                    planState({ status: 'superseded', replacement_plan_id: 'plan-next' }),
                    TODAY,
                );
                throw new Error('expected PlanNotActiveError');
            } catch (error) {
                expect(error).toBeInstanceOf(PlanNotActiveError);
                expect((error as PlanNotActiveError).data).toEqual({ replacementPlanId: 'plan-next' });
            }
        });

        it('treats a superseded plan with no resolvable replacement as a data fault, not a 409', () => {
            // Regeneration links the successor in the same transaction that
            // supersedes the old plan, so this state contradicts itself. The
            // superseded variant promises the replacement id, so it is never
            // answered without one: the alternatives would be a 409 whose body
            // omits what it promises, or a false claim that the week ended.
            expect(() => requireWritablePlan(planState({ status: 'superseded' }), TODAY)).toThrow(
                MealPlanInputError,
            );
        });

        it('reports an ended plan as ended, even though it is still stored active', () => {
            try {
                requireWritablePlan(
                    planState({ start_date: '2026-06-01', end_date: '2026-06-07' }),
                    TODAY,
                );
                throw new Error('expected PlanNotActiveError');
            } catch (error) {
                expect((error as PlanNotActiveError).data).toEqual({ reason: 'ended' });
            }
        });
    });

    describe('plansOverlap', () => {
        it('overlaps on a single shared day', () => {
            expect(
                plansOverlap(
                    { start_date: '2026-07-05', end_date: '2026-07-11' },
                    { start_date: '2026-07-11', end_date: '2026-07-17' },
                ),
            ).toBe(true);
        });

        it('does not overlap on adjacent weeks', () => {
            expect(
                plansOverlap(
                    { start_date: '2026-07-05', end_date: '2026-07-11' },
                    { start_date: '2026-07-12', end_date: '2026-07-18' },
                ),
            ).toBe(false);
        });

        it('is symmetric', () => {
            const left = { start_date: '2026-07-05', end_date: '2026-07-11' };
            const right = { start_date: '2026-07-08', end_date: '2026-07-14' };

            expect(plansOverlap(left, right)).toBe(plansOverlap(right, left));
        });
    });

    describe('findOverlappingActivePlan', () => {
        const range = { start_date: '2026-07-05', end_date: '2026-07-11' };

        it('finds a live plan covering the same week', () => {
            expect(findOverlappingActivePlan([planState()], range, TODAY)?.id).toBe('plan-current');
        });

        it('ignores the plan being regenerated, which always overlaps itself', () => {
            expect(findOverlappingActivePlan([planState()], range, TODAY, 'plan-current')).toBeNull();
        });

        it('still finds every other conflict while regenerating', () => {
            const other = planState({ id: 'plan-other', start_date: '2026-07-08', end_date: '2026-07-14' });

            expect(findOverlappingActivePlan([planState(), other], range, TODAY, 'plan-current')?.id).toBe(
                'plan-other',
            );
        });

        it('ignores superseded and ended plans', () => {
            const superseded = planState({ id: 'plan-old', status: 'superseded' });
            const ended = planState({
                id: 'plan-ancient',
                start_date: '2026-06-01',
                end_date: '2026-06-07',
            });

            expect(
                findOverlappingActivePlan(
                    [superseded, ended],
                    { start_date: '2026-06-01', end_date: '2026-07-11' },
                    TODAY,
                ),
            ).toBeNull();
        });

        it('resolves two conflicts to the earlier one, deterministically', () => {
            const later = planState({ id: 'plan-b', start_date: '2026-07-09', end_date: '2026-07-15' });
            const earlier = planState({ id: 'plan-a' });

            expect(findOverlappingActivePlan([later, earlier], range, TODAY)?.id).toBe('plan-a');
            expect(findOverlappingActivePlan([earlier, later], range, TODAY)?.id).toBe('plan-a');
        });
    });

    describe('findUpcomingActivePlan', () => {
        const upcoming = planState({
            id: 'plan-next',
            start_date: '2026-07-12',
            end_date: '2026-07-18',
        });

        it('finds a plan that starts after today', () => {
            expect(findUpcomingActivePlan([planState(), upcoming], TODAY)?.id).toBe('plan-next');
        });

        it('does not count the current week as upcoming', () => {
            expect(findUpcomingActivePlan([planState()], TODAY)).toBeNull();
        });

        it('ignores the plan being regenerated', () => {
            expect(findUpcomingActivePlan([upcoming], TODAY, 'plan-next')).toBeNull();
        });
    });

    describe('requireNonConflictingWeek', () => {
        it('accepts a week nothing else covers', () => {
            expect(() =>
                requireNonConflictingWeek([planState()], '2026-07-12', TODAY),
            ).not.toThrow();
        });

        it('reports the colliding plan', () => {
            try {
                requireNonConflictingWeek([planState()], '2026-07-05', TODAY);
                throw new Error('expected PlanOverlapError');
            } catch (error) {
                expect(error).toBeInstanceOf(PlanOverlapError);
                expect((error as PlanOverlapError).conflictingPlanId).toBe('plan-current');
            }
        });

        it('refuses a second upcoming plan', () => {
            const upcoming = planState({
                id: 'plan-next',
                start_date: '2026-07-12',
                end_date: '2026-07-18',
            });

            expect(() => requireNonConflictingWeek([upcoming], '2026-07-19', TODAY)).toThrow(
                UpcomingExistsError,
            );
        });

        it('lets a plan replace itself, which is what regeneration is', () => {
            expect(() =>
                requireNonConflictingWeek([planState()], '2026-07-05', TODAY, 'plan-current'),
            ).not.toThrow();
        });
    });

    describe('resolveCurrentAndUpcoming', () => {
        it('splits the week containing today from the one after it', () => {
            const upcoming = planState({
                id: 'plan-next',
                start_date: '2026-07-12',
                end_date: '2026-07-18',
            });

            expect(resolveCurrentAndUpcoming([upcoming, planState()], TODAY)).toEqual({
                current: planState(),
                upcoming,
            });
        });

        it('treats a finished week as neither, though it is still stored active', () => {
            const ended = planState({ start_date: '2026-06-01', end_date: '2026-06-07' });

            expect(resolveCurrentAndUpcoming([ended], TODAY)).toEqual({
                current: null,
                upcoming: null,
            });
        });

        it('ignores a superseded plan', () => {
            expect(
                resolveCurrentAndUpcoming([planState({ status: 'superseded' })], TODAY),
            ).toEqual({ current: null, upcoming: null });
        });

        it('has neither when there are no plans', () => {
            expect(resolveCurrentAndUpcoming([], TODAY)).toEqual({ current: null, upcoming: null });
        });

        it('breaks a shared start date by id, so a read never depends on row order', () => {
            // A partial unique index makes this state unreachable through the
            // API, which is exactly why the tie-break is asserted here: if it
            // ever does occur, every read must resolve to the same plan instead
            // of to whichever row the database returned first.
            const first = planState({ id: 'plan-aaa' });
            const second = planState({ id: 'plan-bbb' });

            expect(resolveCurrentAndUpcoming([first, second], TODAY).current).toEqual(first);
            expect(resolveCurrentAndUpcoming([second, first], TODAY).current).toEqual(first);
        });

        it('is unmoved by the same plan appearing twice', () => {
            expect(resolveCurrentAndUpcoming([planState(), planState()], TODAY)).toEqual({
                current: planState(),
                upcoming: null,
            });
        });

        it('breaks a shared upcoming start date by id too', () => {
            const upcomingA = planState({
                id: 'plan-next-aaa',
                start_date: '2026-07-12',
                end_date: '2026-07-18',
            });
            const upcomingB = planState({
                id: 'plan-next-bbb',
                start_date: '2026-07-12',
                end_date: '2026-07-18',
            });

            expect(resolveCurrentAndUpcoming([upcomingB, upcomingA], TODAY).upcoming).toEqual(upcomingA);
            expect(resolveCurrentAndUpcoming([upcomingA, upcomingB], TODAY).upcoming).toEqual(upcomingA);
        });
    });
});

/* ---------------------------------------------------------------------------
 * Request parsing
 * ------------------------------------------------------------------------- */

describe('startDateWindow', () => {
    const TODAY = '2026-07-08';

    it('opens today and closes thirty days out with no active plan', () => {
        expect(startDateWindow(TODAY, null)).toEqual({
            earliest: TODAY,
            latest: '2026-08-07',
        });
    });

    it('keeps the thirty-day horizon when the successor week is nearer', () => {
        expect(startDateWindow(TODAY, '2026-07-11').latest).toBe('2026-08-07');
    });

    it('always admits the successor week, however far out the plan ends', () => {
        expect(startDateWindow(TODAY, '2026-09-30').latest).toBe('2026-10-01');
    });

    it('refuses malformed keys', () => {
        expect(() => startDateWindow('soon', null)).toThrow(MealPlanInputError);
        expect(() => startDateWindow(TODAY, '2026-02-30')).toThrow(MealPlanInputError);
    });
});

describe('parseGeneratePlanRequest', () => {
    const window = startDateWindow('2026-07-08', null);

    const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        startDate: '2026-07-12',
        idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
        expectedPreferencesRevision: 3,
        expectedTargetsRevision: 2,
        ...overrides,
    });

    it('accepts a complete request', () => {
        expect(parseGeneratePlanRequest(body(), window)).toEqual({
            kind: 'ok',
            payload: {
                startDate: '2026-07-12',
                idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
                expectedPreferencesRevision: 3,
                expectedTargetsRevision: 2,
            },
        });
    });

    it('ignores a key it does not know, and never carries one into the payload', () => {
        // The payload is what `mealPlanningAction.logic.ts` fingerprints, so a
        // leaked key would make two requests of the same intent, carrying
        // different junk, look like two different intents to the replay gate.
        const verdict = parseGeneratePlanRequest(
            body({ expectedPlanRevision: 9, timeZone: 'Pacific/Auckland' }),
            window,
        );

        expect(verdict).toEqual({
            kind: 'ok',
            payload: {
                startDate: '2026-07-12',
                idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
                expectedPreferencesRevision: 3,
                expectedTargetsRevision: 2,
            },
        });
    });

    it.each([undefined, null, 'not-an-object', 42, []])('requires a body object, not %p', (value) => {
        const verdict = parseGeneratePlanRequest(value, window);

        expect(verdict.kind).toBe('error');
    });

    it('reports a missing start date', () => {
        const verdict = parseGeneratePlanRequest(body({ startDate: undefined }), window);

        expect(verdict).toMatchObject({
            kind: 'error',
            code: 'invalid_request',
            details: [{ field: 'startDate', code: MEAL_PLAN_FIELD_CODES.REQUIRED }],
        });
    });

    it('reports an impossible start date as a date problem', () => {
        const verdict = parseGeneratePlanRequest(body({ startDate: '2026-02-30' }), window);

        expect(verdict).toMatchObject({
            details: [{ field: 'startDate', code: MEAL_PLAN_FIELD_CODES.INVALID_DATE }],
        });
    });

    it.each(['2026-07-07', '2026-08-08'])('reports %s as outside the window', (startDate) => {
        const verdict = parseGeneratePlanRequest(body({ startDate }), window);

        expect(verdict).toMatchObject({
            details: [{ field: 'startDate', code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE }],
        });
    });

    it('accepts both ends of the window', () => {
        expect(parseGeneratePlanRequest(body({ startDate: window.earliest }), window).kind).toBe('ok');
        expect(parseGeneratePlanRequest(body({ startDate: window.latest }), window).kind).toBe('ok');
    });

    it.each([
        ['not-a-uuid', MEAL_PLAN_FIELD_CODES.INVALID_ID],
        ['8f1f4d7e-0d2c-1a0b-9f3e-2b6a1c5d4e7f', MEAL_PLAN_FIELD_CODES.INVALID_ID],
    ])('refuses the idempotency key %s', (idempotencyKey, code) => {
        const verdict = parseGeneratePlanRequest(body({ idempotencyKey }), window);

        expect(verdict).toMatchObject({ details: [{ field: 'idempotencyKey', code }] });
    });

    it('requires an idempotency key', () => {
        const verdict = parseGeneratePlanRequest(body({ idempotencyKey: null }), window);

        expect(verdict).toMatchObject({
            details: [{ field: 'idempotencyKey', code: MEAL_PLAN_FIELD_CODES.REQUIRED }],
        });
    });

    it.each([
        [undefined, MEAL_PLAN_FIELD_CODES.REQUIRED],
        ['3', MEAL_PLAN_FIELD_CODES.INVALID_TYPE],
        [3.5, MEAL_PLAN_FIELD_CODES.INVALID_TYPE],
        [-1, MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE],
    ])('refuses the preferences revision %p', (expectedPreferencesRevision, code) => {
        const verdict = parseGeneratePlanRequest(
            body({ expectedPreferencesRevision }),
            window,
        );

        expect(verdict).toMatchObject({
            details: [{ field: 'expectedPreferencesRevision', code }],
        });
    });

    it('accepts revision zero, which a user without a preferences row has', () => {
        expect(
            parseGeneratePlanRequest(body({ expectedTargetsRevision: 0 }), window).kind,
        ).toBe('ok');
    });

    it('reports every problem at once', () => {
        const verdict = parseGeneratePlanRequest(
            { startDate: 'nope', idempotencyKey: 'nope' },
            window,
        );

        expect(verdict.kind).toBe('error');
        expect(verdict.kind === 'error' ? verdict.details : []).toHaveLength(4);
    });

    it('reports an out-of-window date together with the other problems, in one verdict', () => {
        // The reason the composed form exists at all: a caller that already
        // knows the window gets one round trip's worth of problems, including
        // the range, rather than the range on a second attempt.
        const verdict = parseGeneratePlanRequest(
            body({ startDate: '2026-08-08', idempotencyKey: 'nope' }),
            window,
        );

        expect(verdict).toMatchObject({
            kind: 'error',
            details: [
                { field: 'startDate', code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE },
                { field: 'idempotencyKey', code: MEAL_PLAN_FIELD_CODES.INVALID_ID },
            ],
        });
    });
});

/* ---------------------------------------------------------------------------
 * The generation parse, split in two
 *
 * `parseGeneratePlanSyntax` judges a request against ITSELF and touches no
 * clock and no database; `checkStartDateWindow` judges it against a window
 * derived from today in the user's zone and from their active plan. The split
 * is what lets `mealPlan.service.ts::generatePlan` fingerprint a request and
 * ask the idempotency ledger whether it already committed BEFORE it measures
 * that request against anything mutable (AAP §0.5.1). Without it, a same-key
 * retry sent after the user's local midnight is refused `invalid_request` for a
 * start date that has fallen behind `window.earliest`, and can never be given
 * the `201` its first attempt already stored.
 *
 * So these tests pin two things: that the syntax half accepts exactly the dates
 * the window half is left to judge, and that the two halves together say
 * precisely what the one-call form says.
 * ------------------------------------------------------------------------- */

describe('parseGeneratePlanSyntax', () => {
    const WINDOW = startDateWindow('2026-07-08', null);

    const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        startDate: '2026-07-12',
        idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
        expectedPreferencesRevision: 3,
        expectedTargetsRevision: 2,
        ...overrides,
    });

    it('accepts a complete request and yields the payload a fingerprint is built from', () => {
        expect(parseGeneratePlanSyntax(body())).toEqual({
            kind: 'ok',
            payload: {
                startDate: '2026-07-12',
                idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
                expectedPreferencesRevision: 3,
                expectedTargetsRevision: 2,
            },
        });
    });

    it.each([
        ['a day before the window', '2026-07-07'],
        ['the day after the window', '2026-08-08'],
        ['a year before the window', '2025-07-12'],
        ['a decade after the window', '2036-07-12'],
    ])('accepts %s, because the range is not its question', (_label, startDate) => {
        // THE POINT OF THIS FUNCTION. A retried generation whose start date has
        // fallen out of the window must still produce a payload, because the
        // payload is what the request fingerprint — and therefore the replay —
        // is built from.
        expect(parseGeneratePlanSyntax(body({ startDate }))).toEqual({
            kind: 'ok',
            payload: expect.objectContaining({ startDate }),
        });
        expect(startDate < WINDOW.earliest || startDate > WINDOW.latest).toBe(true);
    });

    it.each([undefined, null, 'not-an-object', 42, []])('requires a body object, not %p', (value) => {
        expect(parseGeneratePlanSyntax(value).kind).toBe('error');
    });

    it('still refuses a date that is not a real calendar day', () => {
        // Shape, not range: `2026-02-30` would become an Invalid Date that a
        // query compares as NULL, so it is refused before any I/O even though
        // the window is not consulted.
        expect(parseGeneratePlanSyntax(body({ startDate: '2026-02-30' }))).toMatchObject({
            details: [{ field: 'startDate', code: MEAL_PLAN_FIELD_CODES.INVALID_DATE }],
        });
    });

    it('still requires a start date', () => {
        expect(parseGeneratePlanSyntax(body({ startDate: undefined }))).toMatchObject({
            details: [{ field: 'startDate', code: MEAL_PLAN_FIELD_CODES.REQUIRED }],
        });
    });

    it.each([
        ['not-a-uuid', MEAL_PLAN_FIELD_CODES.INVALID_ID],
        [null, MEAL_PLAN_FIELD_CODES.REQUIRED],
    ])('still judges the idempotency key %p', (idempotencyKey, code) => {
        expect(parseGeneratePlanSyntax(body({ idempotencyKey }))).toMatchObject({
            details: [{ field: 'idempotencyKey', code }],
        });
    });

    it.each([
        ['expectedPreferencesRevision', '3', MEAL_PLAN_FIELD_CODES.INVALID_TYPE],
        ['expectedPreferencesRevision', -1, MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE],
        ['expectedTargetsRevision', undefined, MEAL_PLAN_FIELD_CODES.REQUIRED],
        ['expectedTargetsRevision', 1e30, MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE],
    ])('still judges %s = %p', (field, value, code) => {
        expect(parseGeneratePlanSyntax(body({ [field]: value }))).toMatchObject({
            details: [{ field, code }],
        });
    });

    it('agrees with the composed parser on every request the window admits', () => {
        // One rule, two entry points: the composed form may only ADD the range
        // detail, never report a different verdict for the same request.
        for (const startDate of ['2026-07-08', '2026-07-12', '2026-08-07']) {
            expect(parseGeneratePlanSyntax(body({ startDate }))).toEqual(
                parseGeneratePlanRequest(body({ startDate }), WINDOW),
            );
        }
    });
});

describe('checkStartDateWindow', () => {
    const WINDOW = startDateWindow('2026-07-08', null);

    it('accepts both ends of the window', () => {
        expect(checkStartDateWindow(WINDOW.earliest, WINDOW)).toEqual({ kind: 'ok' });
        expect(checkStartDateWindow(WINDOW.latest, WINDOW)).toEqual({ kind: 'ok' });
    });

    it('accepts a date inside it', () => {
        expect(checkStartDateWindow('2026-07-12', WINDOW).kind).toBe('ok');
    });

    it.each(['2026-07-07', '2026-08-08'])('refuses %s as out of range', (startDate) => {
        expect(checkStartDateWindow(startDate, WINDOW)).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'The plan request is not valid',
            details: [{ field: 'startDate', code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE }],
        });
    });

    it('reports exactly what the composed parser reports for the same date', () => {
        // The two forms share one comparison, so a start date the one-call form
        // refuses is refused by the separate check with the same field, code and
        // message — which is what makes splitting the parse safe.
        const startDate = '2026-08-08';
        const composed = parseGeneratePlanRequest(
            {
                startDate,
                idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
                expectedPreferencesRevision: 3,
                expectedTargetsRevision: 2,
            },
            WINDOW,
        );

        expect(checkStartDateWindow(startDate, WINDOW)).toEqual(composed);
    });

    it('moves with the clock, which is why it cannot run before the replay gate', () => {
        // The same request, judged against yesterday's window and today's: the
        // start date was admissible when the first attempt was made and is not
        // when the retry arrives. `generatePlan` therefore asks the ledger
        // first, and only a request with no stored answer reaches this check.
        const startDate = '2026-07-08';

        expect(checkStartDateWindow(startDate, startDateWindow('2026-07-08', null)).kind).toBe('ok');
        expect(checkStartDateWindow(startDate, startDateWindow('2026-07-09', null))).toMatchObject({
            kind: 'error',
            details: [{ field: 'startDate', code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE }],
        });
    });
});

describe('parseRegeneratePlanRequest', () => {
    const PLAN_ID = 'b3c9f2e1-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

    const body = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
        expectedPlanRevision: 1,
        expectedPreferencesRevision: 3,
        expectedTargetsRevision: 2,
        ...overrides,
    });

    it('accepts a complete request', () => {
        expect(parseRegeneratePlanRequest({ planId: PLAN_ID }, body())).toEqual({
            kind: 'ok',
            planId: PLAN_ID,
            payload: {
                idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
                expectedPlanRevision: 1,
                expectedPreferencesRevision: 3,
                expectedTargetsRevision: 2,
            },
        });
    });

    it('ignores an unknown key here too, and drops the start date a regeneration may not move', () => {
        const verdict = parseRegeneratePlanRequest(
            { planId: PLAN_ID },
            body({ startDate: '2026-08-02', reason: 'diet changed' }),
        );

        expect(verdict).toEqual({
            kind: 'ok',
            planId: PLAN_ID,
            payload: {
                idempotencyKey: '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f',
                expectedPlanRevision: 1,
                expectedPreferencesRevision: 3,
                expectedTargetsRevision: 2,
            },
        });
    });

    it('refuses a malformed plan id', () => {
        const verdict = parseRegeneratePlanRequest({ planId: 'plan-1' }, body());

        expect(verdict).toMatchObject({
            details: [{ field: 'planId', code: MEAL_PLAN_FIELD_CODES.INVALID_ID }],
        });
    });

    it('reports the missing id and the missing body together', () => {
        const verdict = parseRegeneratePlanRequest({}, undefined);

        expect(verdict.kind === 'error' ? verdict.details : []).toEqual([
            { field: 'planId', code: MEAL_PLAN_FIELD_CODES.INVALID_ID },
            { field: 'idempotencyKey', code: MEAL_PLAN_FIELD_CODES.REQUIRED },
        ]);
    });

    it('requires a plan revision of at least one, because stored revisions start there', () => {
        expect(
            parseRegeneratePlanRequest({ planId: PLAN_ID }, body({ expectedPlanRevision: 0 })),
        ).toMatchObject({
            details: [{ field: 'expectedPlanRevision', code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE }],
        });
    });

    it.each([[undefined], [null]])(
        'requires an idempotency key, given %p, because a retry has nothing to match on otherwise',
        (idempotencyKey) => {
            expect(
                parseRegeneratePlanRequest({ planId: PLAN_ID }, body({ idempotencyKey })),
            ).toMatchObject({
                details: [{ field: 'idempotencyKey', code: MEAL_PLAN_FIELD_CODES.REQUIRED }],
            });
        },
    );

    it.each([
        ['not-a-uuid'],
        // A v1 UUID: well formed, wrong version.
        ['8f1f4d7e-0d2c-1a0b-9f3e-2b6a1c5d4e7f'],
        [42],
    ])('refuses the idempotency key %p', (idempotencyKey) => {
        expect(parseRegeneratePlanRequest({ planId: PLAN_ID }, body({ idempotencyKey }))).toMatchObject({
            details: [{ field: 'idempotencyKey', code: MEAL_PLAN_FIELD_CODES.INVALID_ID }],
        });
    });

    it('is reachable under the specification\'s shorter name, as the same parser', () => {
        expect(parseRegenerateRequest).toBe(parseRegeneratePlanRequest);
        expect(parseRegenerateRequest({ planId: PLAN_ID }, body()).kind).toBe('ok');
    });

    it('accepts no start date, because a regeneration keeps the same week', () => {
        const verdict = parseRegeneratePlanRequest(
            { planId: PLAN_ID },
            body({ startDate: '2026-07-12' }),
        );

        expect(verdict.kind).toBe('ok');
        expect(verdict.kind === 'ok' ? Object.keys(verdict.payload).sort() : []).toEqual([
            'expectedPlanRevision',
            'expectedPreferencesRevision',
            'expectedTargetsRevision',
            'idempotencyKey',
        ]);
    });
});

/* ---------------------------------------------------------------------------
 * Revision magnitudes
 *
 * The bound `preferences.logic.ts` publishes as `MAX_REVISION`, asserted on
 * every revision field of both write bodies. `Number.isInteger(1e30)` is true,
 * so without the safe-integer half such a value would pass the parser and fail
 * later — in `buildRequestFingerprint` as a TypeError, or in Prisma as an
 * out-of-range `Int`. Both are 500s for a plainly malformed request.
 * ------------------------------------------------------------------------- */

describe('revision magnitudes', () => {
    const WINDOW = startDateWindow('2026-07-08', null);
    const PLAN_ID = 'b3c9f2e1-4d5a-4b6c-8d7e-9f0a1b2c3d4e';
    const IDEMPOTENCY_KEY = '8f1f4d7e-0d2c-4a0b-9f3e-2b6a1c5d4e7f';

    const generateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        startDate: '2026-07-12',
        idempotencyKey: IDEMPOTENCY_KEY,
        expectedPreferencesRevision: 3,
        expectedTargetsRevision: 2,
        ...overrides,
    });

    const regenerateBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        idempotencyKey: IDEMPOTENCY_KEY,
        expectedPlanRevision: 1,
        expectedPreferencesRevision: 3,
        expectedTargetsRevision: 2,
        ...overrides,
    });

    /** The codes reported for one field, so the assertions read as the contract. */
    const codesFor = (
        verdict: { kind: string; details?: { field: string; code: string }[] },
        field: string,
    ): string[] =>
        (verdict.details ?? []).filter((detail) => detail.field === field).map((detail) => detail.code);

    const UNSTORABLE: [string, unknown][] = [
        ['one above the column maximum', MAX_REVISION + 1],
        // Whole by `Number.isInteger`, exactly representable by neither the
        // column nor the comparison.
        ['1e30', 1e30],
        ['two above the safe-integer ceiling', Number.MAX_SAFE_INTEGER + 2],
    ];

    it('pins the bound to the integer column revisions live in', () => {
        expect(MAX_REVISION).toBe(2_147_483_647);
    });

    describe('POST /meal-planning/plans', () => {
        it.each(['expectedPreferencesRevision', 'expectedTargetsRevision'])(
            'accepts %s at the column maximum',
            (field) => {
                expect(parseGeneratePlanRequest(generateBody({ [field]: MAX_REVISION }), WINDOW).kind).toBe(
                    'ok',
                );
            },
        );

        it.each([
            ['expectedPreferencesRevision', 'one above the column maximum', MAX_REVISION + 1],
            ['expectedPreferencesRevision', '1e30', 1e30],
            [
                'expectedPreferencesRevision',
                'two above the safe-integer ceiling',
                Number.MAX_SAFE_INTEGER + 2,
            ],
            ['expectedTargetsRevision', 'one above the column maximum', MAX_REVISION + 1],
            ['expectedTargetsRevision', '1e30', 1e30],
            ['expectedTargetsRevision', 'two above the safe-integer ceiling', Number.MAX_SAFE_INTEGER + 2],
        ])('refuses %s %s as out of range', (field, _label, value) => {
            const verdict = parseGeneratePlanRequest(generateBody({ [field]: value }), WINDOW);

            expect(verdict.kind).toBe('error');
            expect(codesFor(verdict, field)).toEqual([MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE]);
        });

        it('answers both ends of the window with one code, so the client maps one message', () => {
            const below = parseGeneratePlanRequest(
                generateBody({ expectedTargetsRevision: -1 }),
                WINDOW,
            );
            const above = parseGeneratePlanRequest(
                generateBody({ expectedTargetsRevision: MAX_REVISION + 1 }),
                WINDOW,
            );

            expect(codesFor(below, 'expectedTargetsRevision')).toEqual([
                MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE,
            ]);
            expect(codesFor(above, 'expectedTargetsRevision')).toEqual([
                MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE,
            ]);
        });
    });

    describe('POST /meal-planning/plans/:planId/regenerate', () => {
        it.each(['expectedPlanRevision', 'expectedPreferencesRevision', 'expectedTargetsRevision'])(
            'accepts %s at the column maximum',
            (field) => {
                expect(
                    parseRegeneratePlanRequest({ planId: PLAN_ID }, regenerateBody({ [field]: MAX_REVISION }))
                        .kind,
                ).toBe('ok');
            },
        );

        it.each([
            'expectedPlanRevision',
            'expectedPreferencesRevision',
            'expectedTargetsRevision',
        ])('refuses every unstorable magnitude of %s', (field) => {
            for (const [, value] of UNSTORABLE) {
                const verdict = parseRegeneratePlanRequest(
                    { planId: PLAN_ID },
                    regenerateBody({ [field]: value }),
                );

                expect(verdict.kind).toBe('error');
                expect(codesFor(verdict, field)).toEqual([MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE]);
            }
        });

        it('reports all three unstorable revisions in one verdict', () => {
            const verdict = parseRegeneratePlanRequest(
                { planId: PLAN_ID },
                regenerateBody({
                    expectedPlanRevision: 1e30,
                    expectedPreferencesRevision: MAX_REVISION + 1,
                    expectedTargetsRevision: Number.MAX_SAFE_INTEGER + 2,
                }),
            );

            expect(verdict.kind === 'error' ? verdict.details : []).toEqual([
                { field: 'expectedPlanRevision', code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE },
                { field: 'expectedPreferencesRevision', code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE },
                { field: 'expectedTargetsRevision', code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE },
            ]);
        });
    });
});

/* ---------------------------------------------------------------------------
 * Path parsing
 *
 * Both read routes are judged before any I/O: a malformed plan id reaches a
 * PostgreSQL `uuid` predicate and a malformed day key reaches
 * `new Date(`${dayKey}T00:00:00.000Z`)`, and each becomes a generic 500 where
 * the contract promises a 400 naming the field.
 * ------------------------------------------------------------------------- */

describe('parseMealPlanDayPath', () => {
    const PLAN_ID = 'b3c9f2e1-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

    it('accepts a UUID plan id and a real calendar day', () => {
        expect(parseMealPlanDayPath({ planId: PLAN_ID, date: '2026-07-12' })).toEqual({
            kind: 'ok',
            planId: PLAN_ID,
            date: '2026-07-12',
        });
    });

    it('accepts an upper-case UUID unchanged, as the other parsers do', () => {
        expect(
            parseMealPlanDayPath({ planId: PLAN_ID.toUpperCase(), date: '2026-07-12' }),
        ).toMatchObject({ kind: 'ok', planId: PLAN_ID.toUpperCase() });
    });

    it.each([
        ['a malformed id', 'plan-1'],
        // A v1 UUID: right shape, wrong version nibble.
        ['a v1 UUID', 'b3c9f2e1-4d5a-1b6c-8d7e-9f0a1b2c3d4e'],
        ['an empty segment', ''],
        ['an absent segment', undefined],
        ['an explicit null', null],
        ['a number', 42],
        ['an object', { id: 'b3c9f2e1-4d5a-4b6c-8d7e-9f0a1b2c3d4e' }],
    ])('refuses %s as an invalid plan id', (_label, planId) => {
        expect(parseMealPlanDayPath({ planId, date: '2026-07-12' })).toMatchObject({
            kind: 'error',
            code: 'invalid_request',
            details: [{ field: 'planId', code: MEAL_PLAN_FIELD_CODES.INVALID_ID }],
        });
    });

    it.each([
        ['a day that does not exist', '2026-02-30'],
        ['a month that does not exist', '2026-13-01'],
        ['an un-padded key', '2026-1-5'],
        ['an empty segment', ''],
        ['a timestamp', '2026-07-12T00:00:00.000Z'],
        ['an absent segment', undefined],
        ['an explicit null', null],
        ['a number', 20260712],
    ])('refuses %s as an invalid date', (_label, date) => {
        expect(parseMealPlanDayPath({ planId: PLAN_ID, date })).toMatchObject({
            kind: 'error',
            code: 'invalid_request',
            details: [{ field: 'date', code: MEAL_PLAN_FIELD_CODES.INVALID_DATE }],
        });
    });

    it('accepts a leap day that exists and refuses one that does not', () => {
        expect(parseMealPlanDayPath({ planId: PLAN_ID, date: '2028-02-29' }).kind).toBe('ok');
        expect(parseMealPlanDayPath({ planId: PLAN_ID, date: '2026-02-29' }).kind).toBe('error');
    });

    it('reports both malformed segments in one verdict', () => {
        const verdict = parseMealPlanDayPath({ planId: 'plan-1', date: '2026-02-30' });

        expect(verdict.kind === 'error' ? verdict.details : []).toEqual([
            { field: 'planId', code: MEAL_PLAN_FIELD_CODES.INVALID_ID },
            { field: 'date', code: MEAL_PLAN_FIELD_CODES.INVALID_DATE },
        ]);
    });

    it('reports an empty path as both segments rather than as a missing route', () => {
        const verdict = parseMealPlanDayPath({});

        expect(verdict.kind === 'error' ? verdict.details : []).toHaveLength(2);
    });
});

describe('parseAffectedMealsPath', () => {
    const PLAN_ID = 'b3c9f2e1-4d5a-4b6c-8d7e-9f0a1b2c3d4e';

    it('accepts a UUID plan id', () => {
        expect(parseAffectedMealsPath({ planId: PLAN_ID })).toEqual({ kind: 'ok', planId: PLAN_ID });
    });

    it.each([
        ['a malformed id', 'plan-1'],
        ['a v1 UUID', 'b3c9f2e1-4d5a-1b6c-8d7e-9f0a1b2c3d4e'],
        ['an empty segment', ''],
        ['an absent segment', undefined],
        ['an explicit null', null],
        ['a number', 42],
    ])('refuses %s', (_label, planId) => {
        expect(parseAffectedMealsPath({ planId })).toMatchObject({
            kind: 'error',
            code: 'invalid_request',
            details: [{ field: 'planId', code: MEAL_PLAN_FIELD_CODES.INVALID_ID }],
        });
    });

    it('judges the id exactly as the day read does, so one route cannot be looser', () => {
        for (const planId of [PLAN_ID, 'plan-1', undefined]) {
            expect(parseAffectedMealsPath({ planId }).kind).toBe(
                parseMealPlanDayPath({ planId, date: '2026-07-12' }).kind,
            );
        }
    });
});

/* ---------------------------------------------------------------------------
 * Policy constants — pinned so a change to one is a visible change to policy
 * ------------------------------------------------------------------------- */

describe('policy constants', () => {
    it('plans a seven-day week from four recipes per slot', () => {
        expect(PLAN_DAY_COUNT).toBe(7);
        expect(MAX_RECIPE_USES_PER_WEEK).toBe(2);
        expect(MIN_ELIGIBLE_RECIPES_PER_SLOT).toBe(4);
    });

    it('bounds the search at 2,000 evaluations a day and 14,000 a plan', () => {
        expect(MAX_EVALUATIONS_PER_DAY).toBe(2000);
        expect(MAX_EVALUATIONS_PER_PLAN).toBe(14000);
    });

    // The tolerance cases above build their bands FROM these constants, which
    // is what keeps one band in one place — and is also why widening a band
    // would leave every one of them green. The literals live here instead, so a
    // change to the accepted day is a change to this test.
    it('accepts a day within 10 % on calories and the asymmetric protein band', () => {
        expect(CALORIE_TOLERANCE_RATIO).toBe(0.1);
        expect(PROTEIN_TOLERANCE_UNDER_G).toBe(15);
        expect(PROTEIN_TOLERANCE_OVER_G).toBe(25);
    });

    it('judges carbs and fat on 15 g or 15 %, whichever is the wider', () => {
        expect(MACRO_TOLERANCE_ABSOLUTE_G).toBe(15);
        expect(MACRO_TOLERANCE_RATIO).toBe(0.15);
    });

    it('stops counting a shared ingredient at the fourth', () => {
        expect(REUSE_BONUS_CAP).toBe(4);
    });

    it('sets the plan budget at exactly seven day budgets, which is why the guards need separating', () => {
        // 14,000 = 7 × 2,000, so under the shipped policy a week that spends
        // every day's allowance trips both guards at the same placement and no
        // fixture could say which rule ended the search. That is the honest
        // reason `searchPlanWeek` takes an injected budget, and stating the
        // relation here is what makes a future change to either number — one
        // that would quietly break the other's fixture — visible.
        expect(MAX_EVALUATIONS_PER_PLAN).toBe(PLAN_DAY_COUNT * MAX_EVALUATIONS_PER_DAY);
    });

    it('offers the documented portion multipliers, with the snack set a subset', () => {
        expect(MAIN_SLOT_PORTION_MULTIPLIERS).toEqual([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2]);
        expect(SNACK_PORTION_MULTIPLIERS).toEqual([0.5, 0.75, 1, 1.25, 1.5]);
        expect(
            SNACK_PORTION_MULTIPLIERS.every((multiplier) =>
                MAIN_SLOT_PORTION_MULTIPLIERS.includes(multiplier),
            ),
        ).toBe(true);
        expect(DEFAULT_PORTION_POLICY).toEqual({
            mainSlot: MAIN_SLOT_PORTION_MULTIPLIERS,
            snack: SNACK_PORTION_MULTIPLIERS,
        });
    });
});

/* ---------------------------------------------------------------------------
 * The committed catalog and recipe graph
 *
 * The fixtures above are focused deltas: interchangeable recipes at chosen
 * calories, built to make one search property visible. This section runs the
 * planner over the COMMITTED graph instead — real `recipe_versions` rows with
 * real `recipe_ingredients` and real `catalog_foods` identities — and asserts
 * the continuity a synthetic catalog cannot: that the candidate the planner
 * scores still carries the version, the catalog state, the ingredient identity
 * and the per-serving numbers the recipe domain published, and that the grams
 * it plans are the grams the grocery list will shop.
 * ------------------------------------------------------------------------- */

describe('the committed catalog and recipe graph', () => {
    const seed = derivePlanSeed(makeSeedInputs());

    describe('candidate continuity', () => {
        it('carries every committed identity through to the candidate, unaltered', () => {
            const candidates = buildPlanCandidates(fixtureCatalog(), makePreferences(), seed);
            const committed = new Map(
                readRecipeFixture().recipe_versions.map((version) => [version.id, version]),
            );

            expect(candidates).not.toHaveLength(0);

            for (const candidate of candidates) {
                const version = committed.get(candidate.recipe.recipe_version_id);

                expect(version).toBeDefined();
                expect(candidate.recipe.recipe_id).toBe(version?.recipe_id);
                expect(candidate.recipe.slug).toBe(version?.recipe_slug);
                expect(candidate.recipe.version).toBe(version?.version);
                expect(candidate.recipe.budget_tier).toBe(version?.budget_tier);
                expect(candidate.recipe.total_minutes).toBe(version?.total_minutes);
                expect(candidate.recipe.per_serving.calories).toBe(version?.per_serving_calories);
            }
        });

        it('scales the per-serving set by the multiplier and nothing else', () => {
            const candidates = buildPlanCandidates(
                [planCandidateOf('lemon-herb-chicken-and-rice', 2)],
                makePreferences(),
                seed,
            );
            const version = recipeVersionRow('lemon-herb-chicken-and-rice', 2);

            for (const candidate of candidates) {
                expect(candidate.nutrition.calories).toBeCloseTo(
                    version.per_serving_calories * candidate.portionMultiplier,
                    9,
                );
                expect(candidate.nutrition.protein).toBeCloseTo(
                    version.per_serving_protein_g * candidate.portionMultiplier,
                    9,
                );
            }
        });

        it('keeps each candidate ingredient a catalog fixture row, by id and by group', () => {
            const foodsById = new Map(readCatalogFixture().foods.map((food) => [food.id, food]));
            const candidates = buildPlanCandidates(fixtureCatalog(), makePreferences(), seed);

            for (const candidate of candidates) {
                expect(candidate.recipe.ingredients).not.toHaveLength(0);

                for (const ingredient of candidate.recipe.ingredients) {
                    const food = foodsById.get(ingredient.catalog_food_id);

                    // The planner matches a disliked group against LIVE
                    // identity metadata, so the group travelling with the
                    // candidate has to be the catalog's own.
                    expect(food).toBeDefined();
                    expect(ingredient.food_group).toBe(food?.food_group);
                }
            }
        });

        it('admits only the eight versions the fixture records as plannable', () => {
            const candidates = buildPlanCandidates(fixtureCatalog(), makePreferences(), seed);
            const admitted = new Set(candidates.map((candidate) => candidate.recipe.recipe_version_id));

            expect(admitted.size).toBe(readRecipeFixture().counts.plannable_versions);
            expect(admitted.size).toBe(8);
            expect(candidates).toHaveLength(admitted.size * MAIN_SLOT_PORTION_MULTIPLIERS.length);
        });

        it.each([
            ['the retired version', 'lemon-herb-chicken-and-rice', 1],
            ['the ai_estimated version', 'roasted-carrot-and-lentil-salad', 1],
            ['the ingredient_derived version', 'lemon-dressed-spinach-salad', 1],
            ['the unreviewed-allergen version', 'cracker-and-yogurt-snack-plate', 1],
        ])('never offers %s as a candidate', (_label, slug, versionNumber: number) => {
            const candidates = buildPlanCandidates(fixtureCatalog(), makePreferences(), seed);
            const excludedId = recipeVersionRow(slug, versionNumber).id;

            expect(candidates.map((candidate) => candidate.recipe.recipe_version_id)).not.toContain(excludedId);
        });

        it('still offers the current version of the recipe whose first version is retired', () => {
            const candidates = buildPlanCandidates(fixtureCatalog(), makePreferences(), seed);
            const current = recipeVersionRow('lemon-herb-chicken-and-rice', 2);

            expect(candidates.map((candidate) => candidate.recipe.recipe_version_id)).toContain(current.id);
        });
    });

    describe('what the committed graph can and cannot fill', () => {
        it.each<[MealSlot, number, string[]]>([
            ['breakfast', 2, ['spinach-egg-white-scramble:1', 'yogurt-egg-white-crispbread-plate:1']],
            ['lunch', 2, ['lemon-herb-chicken-and-rice:2', 'lentil-and-kale-stew:1']],
            [
                'dinner',
                5,
                [
                    'herb-chicken-rice-and-kale-bowl:1',
                    'lemon-herb-chicken-and-rice:2',
                    'lentil-and-kale-stew:1',
                    'salmon-and-kale-plate:1',
                    'soy-glazed-chicken-and-rice-bowl:1',
                ],
            ],
            ['snack', 1, ['herbed-yogurt-and-kale-dip-plate:1']],
        ])('offers %s exactly %i committed recipes', (slot, count, identities) => {
            const candidates = buildPlanCandidates(fixtureCatalog(), makePreferences(), seed);

            expect(eligibleRecipeCountForSlot(candidates, makePreferences(), slot)).toBe(count);
            expect(
                [
                    ...new Set(
                        candidatesForSlot(candidates, makePreferences(), slot).map(
                            (candidate) => `${candidate.recipe.slug}:${candidate.recipe.version}`,
                        ),
                    ),
                ].sort(),
            ).toEqual(identities);
        });

        it('refuses a week from the graph alone and names the thin slots, rather than failing', () => {
            const act = () =>
                generateWeeklyPlan({
                    seedInputs: makeSeedInputs(),
                    preferences: makePreferences(),
                    targets: TARGETS,
                    recipes: fixtureCatalog(),
                });

            // Only dinner reaches MIN_ELIGIBLE_RECIPES_PER_SLOT, so this is a
            // feasibility verdict about the catalog and not a server error.
            expect(act).toThrow(NoMatchingMealsError);
            expect(
                analyzeLimitingConstraints({
                    seedInputs: makeSeedInputs(),
                    preferences: makePreferences(),
                    targets: TARGETS,
                    recipes: fixtureCatalog(),
                }).constraints,
            ).toEqual([
                {
                    constraintKey: 'catalog_coverage',
                    value: 2,
                    unit: 'recipes',
                    slots: ['breakfast', 'lunch'],
                    editStep: 'schedule',
                },
            ]);
        });
    });

    describe('a week whose breakfasts are committed recipes', () => {
        /**
         * Four of the plannable committed versions that are not already
         * breakfast, widened to that slot and nothing else. `meal_slots` is the one
         * focused delta: four recipes at the weekly cap of two uses cover seven
         * days, which is what lets every breakfast the planner places be a
         * committed row. Lunch and dinner stay synthetic, because the graph
         * publishes too few recipes to fill three slots for seven days — the
         * property asserted just above.
         */
        const COMMITTED_BREAKFASTS: [string, number][] = [
            ['lemon-herb-chicken-and-rice', 2],
            ['lentil-and-kale-stew', 1],
            ['soy-glazed-chicken-and-rice-bowl', 1],
            ['salmon-and-kale-plate', 1],
        ];

        const mixedCatalog = (): PlanRecipeCandidate[] => [
            ...COMMITTED_BREAKFASTS.map(([slug, versionNumber]) =>
                planCandidateOf(slug, versionNumber, { meal_slots: ['breakfast'] }),
            ),
            ...['l1', 'l2', 'l3', 'l4'].map((slug) => makeRecipe({ slug, slots: ['lunch'], calories: 700 })),
            ...['d1', 'd2', 'd3', 'd4'].map((slug) => makeRecipe({ slug, slots: ['dinner'], calories: 800 })),
        ];

        const committedIds = (): Set<string> =>
            new Set(COMMITTED_BREAKFASTS.map(([slug, versionNumber]) => recipeVersionRow(slug, versionNumber).id));

        it('places a committed version, with its committed identity, in every breakfast slot', () => {
            const result = plan(mixedCatalog());
            const expected = committedIds();

            expect(result.days).toHaveLength(PLAN_DAY_COUNT);

            for (const day of result.days) {
                const [breakfast] = day.meals;

                expect(breakfast.slot).toBe('breakfast');
                expect(expected.has(breakfast.recipeVersionId)).toBe(true);

                const version = recipeVersionRow(breakfast.slug, breakfast.version);

                expect(breakfast.recipeVersionId).toBe(version.id);
                expect(breakfast.recipeId).toBe(version.recipe_id);
                expect(breakfast.planned.calories).toBeCloseTo(
                    version.per_serving_calories * breakfast.portionMultiplier,
                    9,
                );
                expect(isDayWithinTolerance(day.plannedTotals, TARGETS)).toBe(true);
            }
        });

        it('respects the weekly repetition cap across the committed four', () => {
            const uses = new Map<string, number>();

            for (const day of plan(mixedCatalog()).days) {
                const [breakfast] = day.meals;
                uses.set(breakfast.recipeId, (uses.get(breakfast.recipeId) ?? 0) + 1);
            }

            expect([...uses.values()].every((count) => count <= MAX_RECIPE_USES_PER_WEEK)).toBe(true);
            expect([...uses.keys()]).toHaveLength(COMMITTED_BREAKFASTS.length);
        });

        it('is byte-identical for identical inputs, committed rows included', () => {
            expect(plan(mixedCatalog())).toEqual(plan(mixedCatalog()));
        });

        it('plans each breakfast ingredient at the grams the grocery list will aggregate', () => {
            const [firstDay] = plan(mixedCatalog()).days;
            const [breakfast] = firstDay.meals;
            const version = recipeVersionRow(breakfast.slug, breakfast.version);
            const rows = fixtureIngredientRows(breakfast.slug, breakfast.version);

            expect(rows).not.toHaveLength(0);

            for (const row of rows) {
                // The grocery module's own arithmetic on this placement, not a
                // restatement of it: `plannedIngredientGrams` is what the
                // shopping list sums, and it has to agree with the version's
                // yield and the multiplier the planner chose.
                expect(
                    plannedIngredientGrams(row.gram_weight, version.yield_servings, breakfast.portionMultiplier),
                ).toBeCloseTo((row.gram_weight * breakfast.portionMultiplier) / version.yield_servings, 9);
            }

            // And the whole placement: one portion of this meal takes the
            // recipe's total mass through the same divisor.
            const totalGrams = rows.reduce((sum, row) => sum + row.gram_weight, 0);
            const plannedTotal = rows.reduce(
                (sum, row) =>
                    sum + plannedIngredientGrams(row.gram_weight, version.yield_servings, breakfast.portionMultiplier),
                0,
            );

            expect(plannedTotal).toBeCloseTo((totalGrams / version.yield_servings) * breakfast.portionMultiplier, 9);
            expect(plannedTotal).toBeLessThan(totalGrams);
        });

        it('follows the chicken from the recipe row into the planned portion', () => {
            const result = plan(mixedCatalog());
            const chicken = catalogFood('usda:9200101');
            const chickenDays = result.days.filter((day) =>
                fixtureIngredientRows(day.meals[0].slug, day.meals[0].version).some(
                    (row) => row.catalog_food_id === chicken.id,
                ),
            );

            expect(chickenDays).not.toHaveLength(0);

            for (const day of chickenDays) {
                const [breakfast] = day.meals;
                const version = recipeVersionRow(breakfast.slug, breakfast.version);
                const row = fixtureIngredientRows(breakfast.slug, breakfast.version).find(
                    (candidate) => candidate.catalog_food_id === chicken.id,
                );

                expect(row?.food_source_key).toBe('usda:9200101');
                expect([450, 600]).toContain((row as FixtureRecipeIngredient).gram_weight);
                expect(
                    plannedIngredientGrams(
                        (row as FixtureRecipeIngredient).gram_weight,
                        version.yield_servings,
                        breakfast.portionMultiplier,
                    ),
                ).toBe(
                    ((row as FixtureRecipeIngredient).gram_weight / version.yield_servings) *
                        breakfast.portionMultiplier,
                );
                expect(breakfast.planned.calories).toBeCloseTo(
                    version.per_serving_calories * breakfast.portionMultiplier,
                    9,
                );
            }
        });
    });

    describe('preferences against committed rows', () => {
        it('excludes the milk-bearing committed recipes for a milk allergy, and no others', () => {
            const preferences = makePreferences({ allergens: ['milk'] });
            const candidates = buildPlanCandidates(fixtureCatalog(), preferences, seed);
            const admitted = new Set(candidates.map((candidate) => candidate.recipe.slug));

            // spinach-egg-white-scramble carries whole milk,
            // herbed-yogurt-and-kale-dip-plate and
            // yogurt-egg-white-crispbread-plate carry Greek yogurt; the other
            // five plannable versions carry neither. Listed exhaustively, so a
            // recipe that started or stopped bearing milk fails here.
            expect(admitted.has('spinach-egg-white-scramble')).toBe(false);
            expect(admitted.has('herbed-yogurt-and-kale-dip-plate')).toBe(false);
            expect(admitted.has('yogurt-egg-white-crispbread-plate')).toBe(false);
            expect([...admitted].sort()).toEqual([
                'herb-chicken-rice-and-kale-bowl',
                'lemon-herb-chicken-and-rice',
                'lentil-and-kale-stew',
                'salmon-and-kale-plate',
                'soy-glazed-chicken-and-rice-bowl',
            ]);
        });

        it('keeps the pescatarian salmon plate, which the release spelling would have dropped', () => {
            const preferences = makePreferences({ diet: 'pescatarian' });
            const candidates = buildPlanCandidates([planCandidateOf('salmon-and-kale-plate', 1)], preferences, seed);

            expect(candidates).not.toHaveLength(0);
            expect(candidates[0].recipe.ingredients.map((ingredient) => ingredient.snapshot_diet_tags[0])).toContain(
                'pescatarian',
            );
        });

        it('excludes a committed recipe by the food group its own catalog row declares', () => {
            const salmon = catalogFood('usda:9200121');
            const preferences = makePreferences({ disliked_food_groups: [salmon.food_group] });
            const candidates = buildPlanCandidates(fixtureCatalog(), preferences, seed);
            const admitted = new Set(candidates.map((candidate) => candidate.recipe.slug));

            expect(salmon.food_group).toBe('salmon');
            expect(admitted.has('salmon-and-kale-plate')).toBe(false);
            expect(admitted.has('lentil-and-kale-stew')).toBe(true);
        });

        it('excludes a committed recipe by a disliked catalog food id', () => {
            const yogurt = catalogFood('usda:9200115');
            const preferences = makePreferences({ disliked_food_ids: [yogurt.id] });
            const candidates = buildPlanCandidates(fixtureCatalog(), preferences, seed);
            const admitted = new Set(candidates.map((candidate) => candidate.recipe.slug));

            expect(admitted.has('herbed-yogurt-and-kale-dip-plate')).toBe(false);
            expect(admitted.has('spinach-egg-white-scramble')).toBe(true);
        });
    });
});

/* ---------------------------------------------------------------------------
 * The rules the DTO boundary is built on
 *
 * Four pure rules of this module, plus the `mealPlan.mapper.ts` functions that
 * compose them. The mapper is asserted from here rather than from a suite of
 * its own for the reason the grocery import at the top of this file gives: both
 * modules are pure, nothing is mocked, and the behaviour worth pinning is the
 * AGREEMENT between the rule and the string or number it produces — which a
 * second file could only assert by restating half of it.
 * ------------------------------------------------------------------------- */

describe('derivePortionUnit', () => {
    it('takes the unit out of a one-serving description', () => {
        expect(derivePortionUnit('1 bowl')).toBe('bowl');
        expect(derivePortionUnit('1 plate')).toBe('plate');
        expect(derivePortionUnit('1 wrap')).toBe('wrap');
        expect(derivePortionUnit('1 wedge')).toBe('wedge');
        expect(derivePortionUnit('1 omelette')).toBe('omelette');
    });

    it('tolerates surrounding and repeated whitespace', () => {
        expect(derivePortionUnit('  1 bowl  ')).toBe('bowl');
        expect(derivePortionUnit('1\tbowl')).toBe('bowl');
    });

    it('keeps an internal hyphen and the original casing', () => {
        expect(derivePortionUnit('1 half-wrap')).toBe('half-wrap');
        expect(derivePortionUnit('1 Bowl')).toBe('Bowl');
    });

    /**
     * The six shapes the seeded corpus really contains that must NOT become a
     * unit. Each would be wrong in its own way: a yield count multiplied a
     * second time, a phrase whose LAST word `pluralizeCount` would inflect, or
     * a word already plural that it would inflect again ("halves" ->
     * "halveses").
     */
    it.each([
        ['¾ cup'],
        ['4 meatballs with sauce'],
        ['4 filled cabbage leaves'],
        ['3 bites'],
        ['2 muffins'],
        ['1 stuffed bell pepper (2 halves)'],
        ['1 fillet with potato and broccoli'],
    ])('falls back to the generic noun for %s', (description) => {
        expect(derivePortionUnit(description)).toBe('serving');
    });

    it('falls back for a word already in the plural, which would inflect twice', () => {
        expect(derivePortionUnit('1 halves')).toBe('serving');
        expect(derivePortionUnit('1 couscous')).toBe('serving');
    });

    it('falls back for no description and for a blank one', () => {
        expect(derivePortionUnit(null)).toBe('serving');
        expect(derivePortionUnit('')).toBe('serving');
        expect(derivePortionUnit('   ')).toBe('serving');
    });

    /**
     * TOTAL: no input produces an empty or unusable noun, because the string
     * reaches the plan card and the swap preview with no further guard. The
     * inputs below are the shapes the seeded corpus contains plus the ones a
     * future recipe file could plausibly introduce.
     */
    it.each([
        ['1 bowl'],
        ['1 plate'],
        ['¾ cup'],
        ['2 muffins'],
        ['1 stuffed bell pepper (2 halves)'],
        ['1 fillet with potato and broccoli'],
        ['1'],
        ['1 '],
        ['1  2'],
        ['one bowl'],
        ['11 bowl'],
        ['1 bowl of soup'],
        ['1 BOWL'],
        ['1 crème'],
        ['1 ½ bowls'],
    ])('yields a non-empty noun for %s', (description) => {
        expect(derivePortionUnit(description).length).toBeGreaterThan(0);
    });
});

describe('formatPortionText', () => {
    it('renders the recipe’s own unit, singular at or below one portion', () => {
        expect(formatPortionText(1, '1 bowl')).toBe('1 bowl');
        expect(formatPortionText(0.5, '1 bowl')).toBe('½ bowl');
        expect(formatPortionText(0.75, '1 wrap')).toBe('¾ wrap');
    });

    it('pluralises the recipe’s own unit above one portion', () => {
        expect(formatPortionText(1.25, '1 plate')).toBe('1¼ plates');
        expect(formatPortionText(2, '1 bowl')).toBe('2 bowls');
        expect(formatPortionText(1.5, '1 sandwich')).toBe('1½ sandwiches');
    });

    it('renders the generic noun when the description gives no usable unit', () => {
        expect(formatPortionText(1, '4 meatballs with sauce')).toBe('1 serving');
        expect(formatPortionText(1.75, null)).toBe('1¾ servings');
    });

    it('refuses a multiplier it cannot render, naming the column', () => {
        expect(() => formatPortionText(0, '1 bowl')).toThrow(MealPlanMappingError);
        expect(() => formatPortionText(Number.NaN, '1 bowl')).toThrow(/portion_multiplier/);
        expect(() => formatPortionText(-1, '1 bowl')).toThrow(MealPlanMappingError);
    });
});

describe('sameMacroTotals', () => {
    it('is true only for the same four numbers', () => {
        expect(sameMacroTotals(TARGETS, { ...TARGETS })).toBe(true);
    });

    it.each(['calories', 'protein', 'carbs', 'fat'] as const)('is false when %s differs', (key) => {
        expect(sameMacroTotals(TARGETS, { ...TARGETS, [key]: TARGETS[key] + 1 })).toBe(false);
    });

    it('is exact rather than tolerant — a fraction apart is not the same', () => {
        expect(sameMacroTotals(TARGETS, { ...TARGETS, calories: TARGETS.calories + 0.4 })).toBe(false);
    });
});

describe('resolveReportedTargets', () => {
    const generationTargets = proportional(1800);
    const confirmed = { calories: 2000, protein: 150, carbs: 200, fat: 65 };

    it('reports the current confirmed targets when they are complete', () => {
        expect(resolveReportedTargets({ complete: true, targets: confirmed }, generationTargets)).toEqual(TARGETS);
    });

    it('falls back to the generation snapshot when the confirmed read is incomplete', () => {
        expect(resolveReportedTargets({ complete: false, targets: confirmed }, generationTargets)).toEqual(
            generationTargets,
        );
        expect(resolveReportedTargets({ complete: true, targets: null }, generationTargets)).toEqual(
            generationTargets,
        );
    });

    it.each(['calories', 'protein', 'carbs', 'fat'] as const)(
        'falls back when the confirmed %s is null despite the complete flag',
        (key) => {
            const partial = { ...confirmed, [key]: null };

            expect(resolveReportedTargets({ complete: true, targets: partial }, generationTargets)).toEqual(
                generationTargets,
            );
        },
    );

    /**
     * The pair the plan card's `targetsStale` is derived from, asserted
     * together: the fallback must make the two EQUAL, so a week whose confirmed
     * targets went incomplete is not captioned as having moved.
     */
    it('keeps targetsStale false when it falls back', () => {
        const reported = resolveReportedTargets({ complete: false, targets: null }, generationTargets);

        expect(sameMacroTotals(reported, generationTargets)).toBe(true);
    });
});

describe('toPlanningPreferences', () => {
    const row = {
        diet: 'vegan',
        allergens: ['milk'],
        disliked_food_ids: ['11111111-1111-4111-8111-111111111111'],
        disliked_food_groups: ['mushroom'],
        cooking_time_limit_min: 30,
    };

    it('narrows the five columns eligibility is judged from', () => {
        expect(toPlanningPreferences(row)).toEqual({
            diet: 'vegan',
            allergens: ['milk'],
            disliked_food_ids: ['11111111-1111-4111-8111-111111111111'],
            disliked_food_groups: ['mushroom'],
            cooking_time_limit_min: 30,
        });
    });

    it('admits each of the four diets the contract names', () => {
        for (const diet of ['none', 'vegetarian', 'vegan', 'pescatarian']) {
            expect(toPlanningPreferences({ ...row, diet }).diet).toBe(diet);
        }
    });

    it('reads an unrecognised stored diet as no diet restriction', () => {
        expect(toPlanningPreferences({ ...row, diet: 'carnivore' }).diet).toBeNull();
        expect(toPlanningPreferences({ ...row, diet: null }).diet).toBeNull();
        expect(toPlanningPreferences({ ...row, diet: '' }).diet).toBeNull();
        expect(toPlanningPreferences({ ...row, diet: 'Vegan' }).diet).toBeNull();
    });

    /**
     * The narrowing must be an OWN-property test, not `in`: the prototype-member
     * names below are all `in` an ordinary object, so an `in` guard would cast
     * them to `Diet` and hand the eligibility rules a diet code no recipe
     * carries — refusing every candidate and reporting a feasible week as
     * `no_matching_meals` because one stored string was malformed.
     */
    it.each(['toString', 'constructor', 'hasOwnProperty', 'valueOf', 'isPrototypeOf', '__proto__', '__defineGetter__'])(
        'reads the prototype-member name %p as no diet restriction',
        (diet) => {
            expect(toPlanningPreferences({ ...row, diet }).diet).toBeNull();
        },
    );

    it('reads a missing row as nothing restricted', () => {
        expect(toPlanningPreferences(null)).toEqual({
            diet: null,
            allergens: [],
            disliked_food_ids: [],
            disliked_food_groups: [],
            cooking_time_limit_min: null,
        });
    });
});

describe('readPlannedTotals', () => {
    it('rounds each value once for display', () => {
        expect(readPlannedTotals({ calories: 419.6, protein: 31.4, carbs: 43.5, fat: 10.49 }, 'col', 'row-1')).toEqual({
            calories: 420,
            protein: 31,
            carbs: 44,
            fat: 10,
        });
    });

    it('leaves stored integers untouched', () => {
        expect(readPlannedTotals(TARGETS, 'col', 'row-1')).toEqual(TARGETS);
    });

    /**
     * The integer agreement the contract depends on: the diary snapshot is the
     * rounded per-serving figure and consumed totals are
     * `round(snapshot × servings)`, so the card must report the same rounded
     * figure the server will store — otherwise "This adds" sits a unit away
     * from the entry that gets written.
     */
    it('agrees with the diary snapshot the server writes for the same portion', () => {
        const stored = { calories: 419.6, protein: 31.4, carbs: 43.5, fat: 10.49 };
        const shown = readPlannedTotals(stored, 'col', 'row-1');
        const servings = 1.5;

        expect(Math.round(shown.calories * servings)).toBe(Math.round(Math.round(stored.calories) * servings));
    });

    it.each(['calories', 'protein', 'carbs', 'fat'] as const)(
        'refuses a non-finite stored %s, naming the column and the row',
        (key) => {
            const stored = { ...TARGETS, [key]: Number.NaN };

            expect(() => readPlannedTotals(stored, 'meal_plan_meals.planned_*', 'meal-7')).toThrow(
                MealPlanMappingError,
            );
            expect(() => readPlannedTotals(stored, 'meal_plan_meals.planned_*', 'meal-7')).toThrow(
                /meal_plan_meals\.planned_\*.*meal-7.*calories|protein|carbs|fat/,
            );
        },
    );
});

describe('readTargetsSnapshot', () => {
    it('reads the four stored macro values', () => {
        expect(readTargetsSnapshot(TARGETS, 'plan-1')).toEqual(TARGETS);
    });

    /**
     * A stored snapshot is the user's own calorie and macro targets, so the
     * exception message names the plan and the offending KEYS — never the
     * values, which the controller's error logging would otherwise write out
     * (CWE-532).
     */
    it('names the offending keys and their kinds without disclosing any stored value', () => {
        const corrupted = { calories: 1940, protein: '146', carbs: null, notes: 'secret-note' };

        expect(() => readTargetsSnapshot(corrupted, 'plan-7')).toThrow(MealPlanMappingError);

        try {
            readTargetsSnapshot(corrupted, 'plan-7');
            throw new Error('readTargetsSnapshot accepted a corrupted snapshot');
        } catch (error) {
            const message = (error as Error).message;

            expect(message).toContain('plan-7');
            expect(message).toContain('protein is a string');
            expect(message).toContain('carbs is null');
            expect(message).toContain('fat is absent');
            expect(message).not.toContain('1940');
            expect(message).not.toContain('146');
            expect(message).not.toContain('secret-note');
        }
    });

    it('reports a column that is not an object without serialising it', () => {
        try {
            readTargetsSnapshot('unexpected-string', 'plan-8');
            throw new Error('readTargetsSnapshot accepted a non-object snapshot');
        } catch (error) {
            const message = (error as Error).message;

            expect(message).toContain('not a JSON object');
            expect(message).not.toContain('unexpected-string');
        }
    });
});

describe('toPlanLifecycleState', () => {
    const planRow = {
        id: 'plan-1',
        status: 'active',
        start_date: new Date('2026-07-05T00:00:00.000Z'),
        end_date: new Date('2026-07-11T00:00:00.000Z'),
        replaced_by_plans: [],
    };

    it('reads the stored dates as day keys and passes the status through', () => {
        expect(toPlanLifecycleState(planRow)).toEqual({
            id: 'plan-1',
            status: 'active',
            start_date: '2026-07-05',
            end_date: '2026-07-11',
            replacement_plan_id: null,
        });
    });

    it('flattens the successor the caller resolved', () => {
        expect(
            toPlanLifecycleState({ ...planRow, status: 'superseded', replaced_by_plans: [{ id: 'plan-2' }] })
                .replacement_plan_id,
        ).toBe('plan-2');
    });

    /**
     * The output is `requireWritablePlan`'s input, so the two are asserted
     * together: shaping a row and judging it are different jobs in different
     * modules, and this is the seam between them.
     */
    it('produces exactly what the writability rule judges', () => {
        expect(requireWritablePlan(toPlanLifecycleState(planRow), '2026-07-07')).toMatchObject({ id: 'plan-1' });
        expect(() => requireWritablePlan(toPlanLifecycleState(planRow), '2026-07-12')).toThrow();
    });
});

describe('groupLoggedPlannedEntries', () => {
    const entryRow = (overrides: Record<string, unknown> = {}) => ({
        id: 'entry-1',
        date: new Date('2026-07-05T00:00:00.000Z'),
        servings: 1,
        logged_at: new Date('2026-07-05T08:30:00.000Z'),
        meal_plan_meal_id: 'meal-1',
        recipe_version_id: 'version-1',
        meals: { name: 'Breakfast' },
        recipe_versions: { name: 'Greek yogurt bowl' },
        ...overrides,
    });

    it('groups entries under the planned meal they belong to', () => {
        const grouped = groupLoggedPlannedEntries([
            entryRow(),
            entryRow({ id: 'entry-2', meal_plan_meal_id: 'meal-2' }),
            entryRow({ id: 'entry-3' }),
        ]);

        expect(grouped.get('meal-1')?.map((entry) => entry.entryId)).toEqual(['entry-1', 'entry-3']);
        expect(grouped.get('meal-2')?.map((entry) => entry.entryId)).toEqual(['entry-2']);
    });

    it('reads the entry date as a day key and the timestamp as ISO-8601', () => {
        const [entry] = groupLoggedPlannedEntries([entryRow()]).get('meal-1') ?? [];

        expect(entry).toMatchObject({
            date: '2026-07-05',
            loggedAt: '2026-07-05T08:30:00.000Z',
            mealName: 'Breakfast',
            recipeName: 'Greek yogurt bowl',
            recipeVersionId: 'version-1',
            servings: 1,
        });
    });

    /**
     * A user who edits a logged entry's name or macros detaches it from the
     * plan (`nutrition.service.ts::updateMealEntry` clears all three links).
     * Such a row is no longer evidence the meal was eaten, so including it
     * would light the LOGGED badge for a meal the user has rewritten by hand.
     */
    it.each([['meal_plan_meal_id'], ['recipe_version_id'], ['recipe_versions']])(
        'drops an entry detached by a %s of null',
        (field) => {
            expect(groupLoggedPlannedEntries([entryRow({ [field]: null })]).size).toBe(0);
        },
    );

    it('is an empty map for no entries', () => {
        expect(groupLoggedPlannedEntries([]).size).toBe(0);
    });
});

/* ---------------------------------------------------------------------------
 * The composed DTOs, at the boundary the client actually reads
 *
 * The two mappers above are asserted directly because the two properties the
 * contract turns on are properties of the COMPOSITION, not of a helper: a plan
 * card's figures are integers, and its portion is stated in the recipe's own
 * serving unit. Asserting `readPlannedTotals` alone would leave a mapper free to
 * stop calling it.
 * ------------------------------------------------------------------------- */

const recipeVersionRowFor = (overrides: Partial<RecipeVersionRow> = {}): RecipeVersionRow => ({
    id: 'version-1',
    recipe_id: 'recipe-1',
    version: 1,
    name: 'Chicken burrito bowl',
    description: null,
    icon_key: 'bowl',
    instructions: ['Season the chicken.'],
    yield_servings: 2,
    serving_description: '1 bowl',
    prep_minutes: 10,
    cook_minutes: 15,
    total_minutes: 25,
    meal_slots: ['lunch'],
    diet_tags: [],
    allergen_tags: [],
    allergen_status: 'known',
    budget_tier: 2,
    badges: ['high_protein'],
    nutrition_provenance: 'source_backed',
    per_serving_calories: 610,
    per_serving_protein_g: 45,
    per_serving_carbs_g: 58,
    per_serving_fat_g: 21,
    status: 'current',
    ...overrides,
});

const planMealRowFor = (overrides: Partial<PlanMealRow> = {}): PlanMealRow => ({
    id: 'meal-1',
    revision: 1,
    slot: 'lunch',
    slot_time: '12:30',
    sort_order: 1,
    portion_multiplier: 1,
    planned_calories: 609.6,
    planned_protein_g: 44.5,
    planned_carbs_g: 58.4,
    planned_fat_g: 21.49,
    flags: [],
    previous_recipe_versions: null,
    ...overrides,
});

describe('toMealPlanMealResponse', () => {
    it('reports the stored planned macros as integers', () => {
        const response = toMealPlanMealResponse(planMealRowFor(), recipeVersionRowFor(), []);

        expect(response.planned).toEqual({ calories: 610, protein: 45, carbs: 58, fat: 21 });
    });

    it('states the portion in the recipe’s own serving unit', () => {
        expect(toMealPlanMealResponse(planMealRowFor(), recipeVersionRowFor(), []).portionText).toBe('1 bowl');
        expect(
            toMealPlanMealResponse(
                planMealRowFor({ portion_multiplier: 1.5 }),
                recipeVersionRowFor({ serving_description: '1 plate' }),
                [],
            ).portionText,
        ).toBe('1½ plates');
    });

    it('falls back to the generic noun for a serving description that is not one unit', () => {
        expect(
            toMealPlanMealResponse(
                planMealRowFor(),
                recipeVersionRowFor({ serving_description: '4 meatballs with sauce' }),
                [],
            ).portionText,
        ).toBe('1 serving');
    });
});

describe('toMealPlanDayResponse', () => {
    const dayRow = {
        id: 'day-1',
        date: new Date('2026-07-05T00:00:00.000Z'),
        day_index: 0,
        planned_calories: 1904.7,
        planned_protein_g: 141.5,
        planned_carbs_g: 188.2,
        planned_fat_g: 60.6,
    };

    const mealWithRecipe = { ...planMealRowFor(), recipe_versions: recipeVersionRowFor() };

    it('reports the stored day totals as integers', () => {
        const response = toMealPlanDayResponse(dayRow, [mealWithRecipe], {
            endDate: '2026-07-11',
            loggedByMealId: new Map(),
        });

        expect(response.plannedTotals).toEqual({ calories: 1905, protein: 142, carbs: 188, fat: 61 });
    });

    /**
     * Meals and the day are rounded independently, so the day total is the sum
     * of what was PLANNED rather than the sum of four display strings. Stated
     * as a test so nobody "fixes" the difference by rounding the day out of the
     * meals.
     */
    it('rounds the day from its own stored column, not from the rounded meals', () => {
        const response = toMealPlanDayResponse(
            { ...dayRow, planned_calories: 1219.2 },
            [mealWithRecipe, { ...mealWithRecipe, id: 'meal-2' }],
            { endDate: '2026-07-11', loggedByMealId: new Map() },
        );
        const sumOfRoundedMeals = response.meals.reduce((total, meal) => total + meal.planned.calories, 0);

        expect(response.plannedTotals.calories).toBe(1219);
        expect(sumOfRoundedMeals).toBe(1220);
    });

    it('marks the plan’s last date', () => {
        const context = { endDate: '2026-07-05', loggedByMealId: new Map() };

        expect(toMealPlanDayResponse(dayRow, [mealWithRecipe], context).isLastDay).toBe(true);
    });
});
