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

import {
    BUDGET_TIER_1_MAX_PER_MEAL,
    BUDGET_TIER_2_MAX_PER_MEAL,
    CALORIE_TOLERANCE_RATIO,
    DEFAULT_PORTION_POLICY,
    EXTENDED_PORTION_POLICY,
    GeneratedPlan,
    MACRO_TOLERANCE_ABSOLUTE_G,
    MAIN_SLOT_PORTION_MULTIPLIERS,
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
    PlanSeedInputs,
    REUSE_BONUS_CAP,
    SNACK_PORTION_MULTIPLIERS,
    ScoredCandidate,
    addDaysToDayKey,
    analyzeLimitingConstraints,
    budgetPenalty,
    buildPlanCandidates,
    candidatesForSlot,
    compareCandidateMoves,
    computeDayTotals,
    daysBetweenDayKeys,
    derivePlanSeed,
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
    nextCookingTimeTier,
    parseGeneratePlanRequest,
    parseRegeneratePlanRequest,
    parseRegenerateRequest,
    planDatesFrom,
    planEndDate,
    plansOverlap,
    portionMultipliersForSlot,
    requireNonConflictingWeek,
    requireWritablePlan,
    resolveCurrentAndUpcoming,
    resolveSlotSchedule,
    resolveUserBudgetTier,
    reuseBonus,
    scoreCandidate,
    scheduleCumulativeShares,
    scheduleSlots,
    startDateWindow,
    targetProximity,
    violatesRepetitionRule,
} from '../mealPlan.logic';
import {
    NoMatchingMealsError,
    PlanGenerationError,
    PlanNotActiveError,
    PlanOverlapError,
    UpcomingExistsError,
} from '../mealPlanning.errors';
import type { MealPlanMacroTotals, MealTimeEntry } from '../../types/mealPlanning';
import type { MealSlot } from '../../types/recipe';

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

    it('refuses a recipe already placed today, which is zero days apart', () => {
        expect(violatesRepetitionRule('r', 1, none, new Set(['r']))).toBe(true);
    });

    it('ignores other recipes in either day', () => {
        expect(violatesRepetitionRule('r', 0, new Set(['other']), new Set(['another']))).toBe(false);
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
        expect(() => addDaysToDayKey('2026-02-30', 1)).toThrow(MealPlanInputError);
        expect(() => addDaysToDayKey('2026-07-05', 1.5)).toThrow(MealPlanInputError);
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
        // The catalog mixes protein-, carb- and fat-dense profiles so the day
        // tolerance binds on all four macros at once (these recipes deliberately
        // do NOT use `proportional`). A day therefore needs a specific MIX, and
        // because the no-consecutive-days rule decides which recipes a day may
        // draw on, one day's assignment constrains the next day's — the coupling
        // that makes a week-level dead end possible at all.
        const PROTEIN_DENSE: MealPlanMacroTotals = { calories: 600, protein: 80, carbs: 20, fat: 15 };
        const CARB_DENSE: MealPlanMacroTotals = { calories: 450, protein: 10, carbs: 85, fat: 6 };
        const CARB_DENSE_LARGE: MealPlanMacroTotals = { calories: 600, protein: 15, carbs: 110, fat: 10 };
        const FAT_DENSE: MealPlanMacroTotals = { calories: 600, protein: 20, carbs: 25, fat: 45 };
        const BALANCED: MealPlanMacroTotals = { calories: 800, protein: 55, carbs: 70, fat: 28 };

        // Every recipe here is load-bearing: greedy minimisation could not drop
        // one without the week becoming solvable day-by-day (or unsolvable).
        // The slugs are load-bearing too — they ARE the portable pre-order, so
        // renaming them reshuffles the move order and the property is lost.
        const catalog = (): PlanRecipeCandidate[] => [
            makeRecipe({ slug: 'lunch-balanced', slots: ['lunch'], calories: 0, nutrition: BALANCED }),
            makeRecipe({ slug: 'breakfast-carb', slots: ['breakfast'], calories: 0, nutrition: CARB_DENSE }),
            makeRecipe({
                slug: 'shared-carb',
                slots: ['breakfast', 'lunch'],
                calories: 0,
                nutrition: CARB_DENSE,
            }),
            makeRecipe({ slug: 'dinner-balanced', slots: ['dinner'], calories: 0, nutrition: BALANCED }),
            makeRecipe({ slug: 'breakfast-fat', slots: ['breakfast'], calories: 0, nutrition: FAT_DENSE }),
            makeRecipe({
                slug: 'shared-protein-bd',
                slots: ['breakfast', 'dinner'],
                calories: 0,
                nutrition: PROTEIN_DENSE,
            }),
            makeRecipe({
                slug: 'shared-protein-ld',
                slots: ['lunch', 'dinner'],
                calories: 0,
                nutrition: PROTEIN_DENSE,
            }),
            makeRecipe({
                slug: 'shared-fat',
                slots: ['breakfast', 'lunch'],
                calories: 0,
                nutrition: FAT_DENSE,
            }),
            makeRecipe({
                slug: 'breakfast-protein',
                slots: ['breakfast'],
                calories: 0,
                nutrition: PROTEIN_DENSE,
            }),
            makeRecipe({ slug: 'dinner-protein', slots: ['dinner'], calories: 0, nutrition: PROTEIN_DENSE }),
            makeRecipe({
                slug: 'shared-carb-big',
                slots: ['breakfast', 'lunch'],
                calories: 0,
                nutrition: CARB_DENSE_LARGE,
            }),
            makeRecipe({
                slug: 'shared-carb-bd',
                slots: ['breakfast', 'dinner'],
                calories: 0,
                nutrition: CARB_DENSE,
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
                const currentDayRecipeIds = new Set<string>();

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
                                    currentDayRecipeIds,
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
                        currentDayRecipeIds.add(recipeId);
                        usesByRecipeId.set(recipeId, (usesByRecipeId.get(recipeId) ?? 0) + 1);

                        if (fillSlot(slotIndex + 1)) {
                            return true;
                        }

                        placed.pop();
                        currentDayRecipeIds.delete(recipeId);
                        usesByRecipeId.set(recipeId, (usesByRecipeId.get(recipeId) ?? 0) - 1);
                    }

                    return false;
                };

                if (!fillSlot(0)) {
                    return { solved: false, failedDayIndex: dayIndex };
                }

                previousDayRecipeIds = new Set(currentDayRecipeIds);
            }

            return { solved: true, failedDayIndex: -1 };
        };

        it('cannot be solved by a search that never revisits an earlier day', () => {
            const outcome = solveWithoutCrossDayBacktracking(catalog());

            // Days 0-4 each close on their own; day 5 is where committing those
            // earlier days becomes unrecoverable.
            expect(outcome.solved).toBe(false);
            expect(outcome.failedDayIndex).toBe(5);
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
 * Limiting-constraint analysis
 * ------------------------------------------------------------------------- */

describe('analyzeLimitingConstraints', () => {
    const analyze = (
        recipes: PlanRecipeCandidate[],
        preferences: PlanGenerationPreferences = makePreferences(),
    ) =>
        analyzeLimitingConstraints({
            seedInputs: makeSeedInputs(),
            preferences,
            targets: TARGETS,
            recipes,
        });

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

    it('keeps relaxation probes quiet once the deadline has passed', () => {
        const constraints = analyzeLimitingConstraints({
            seedInputs: makeSeedInputs(),
            preferences: makePreferences({ cooking_time_limit_min: 30 }),
            targets: TARGETS,
            recipes: feasibleCatalog().map((recipe) => ({ ...recipe, total_minutes: 45 })),
            shouldAbort: () => true,
        });

        expect(constraints.map((constraint) => constraint.constraintKey)).not.toContain('cooking_time');
        expect(constraints.length).toBeGreaterThan(0);
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
                expect((error as PlanNotActiveError).replacementPlanId).toBe('plan-next');
                expect((error as PlanNotActiveError).reason).toBeUndefined();
            }
        });

        it('still refuses a superseded plan that records no replacement', () => {
            // The column is nullable, so "superseded" must not depend on knowing
            // what replaced it — the write is refused either way.
            try {
                requireWritablePlan(planState({ status: 'superseded' }), TODAY);
                throw new Error('expected PlanNotActiveError');
            } catch (error) {
                expect(error).toBeInstanceOf(PlanNotActiveError);
                expect((error as PlanNotActiveError).replacementPlanId).toBeUndefined();
            }
        });

        it('reports an ended plan as ended, even though it is still stored active', () => {
            try {
                requireWritablePlan(
                    planState({ start_date: '2026-06-01', end_date: '2026-06-07' }),
                    TODAY,
                );
                throw new Error('expected PlanNotActiveError');
            } catch (error) {
                expect((error as PlanNotActiveError).reason).toBe('ended');
                expect((error as PlanNotActiveError).replacementPlanId).toBeUndefined();
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
 * Policy constants — pinned so a change to one is a visible change to policy
 * ------------------------------------------------------------------------- */

describe('policy constants', () => {
    it('plans a seven-day week from four recipes per slot', () => {
        expect(PLAN_DAY_COUNT).toBe(7);
        expect(MAX_RECIPE_USES_PER_WEEK).toBe(2);
        expect(MIN_ELIGIBLE_RECIPES_PER_SLOT).toBe(4);
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
