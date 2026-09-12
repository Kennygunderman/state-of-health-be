/**
 * Unit tests for the pure recipe domain (Rule backend-architecture §11, whose
 * conventions come from the mobile repo: colocated `__tests__`, the `.test.ts`
 * suffix, `describe` blocks grouped by function and scenario, and edge cases
 * over happy paths).
 *
 * The bugs these are written to catch are the ones the rules exist to prevent:
 * an eligibility check that reads a recipe-level summary instead of the
 * ingredient snapshots and serves a user an allergen; a per-100 ml ingredient
 * silently treated as if millilitres were grams; a badge earned from a
 * declaration rather than from the composition; a fibre total that turned an
 * unknown into a zero; and a rounding that crept into a derivation and left the
 * mobile "This adds" card disagreeing with the server.
 */

import { UnitConversionError } from '../../utils/units';
import {
    BUDGET_TIER_1_MAX_COST_SCORE,
    BUDGET_TIER_2_MAX_COST_SCORE,
    deriveAllergenStatus,
    deriveAllergenTags,
    deriveBadges,
    deriveBudgetTier,
    deriveCostScore,
    deriveDietTags,
    deriveNutritionProvenance,
    deriveRecipeNutrition,
    deriveRecipeVersionFields,
    deriveSourcedCaloriesNote,
    deriveTotalMinutes,
    evaluatePlanningEligibility,
    findStaleIngredients,
    formatIngredientQuantity,
    HIGH_PROTEIN_MIN_ENERGY_SHARE,
    isDietCompatible,
    isEligibleForPlanning,
    isIngredientSnapshotStale,
    isMealSlot,
    isRecipeBadge,
    isRecipeIconKey,
    PlanningEligibilityCode,
    PlanningPreferences,
    PlanningRecipeVersion,
    PREFERENCE_FLAG_CODES,
    QUICK_MAX_TOTAL_MINUTES,
    RecipeDeclaration,
    RecipeDerivationError,
    RecipeIngredientSnapshot,
    RecipePublicationIngredient,
    roundNutritionForDisplay,
    scaleIngredients,
    scalePlannedNutrition,
    SOURCED_CALORIE_DIVERGENCE_THRESHOLD,
    validateRecipeDeclaration,
} from '../recipe.logic';

/* ---------------------------------------------------------------------------
 * Factories — a reviewed, source-backed, untagged 100 g ingredient whose
 * numbers are round and whose 4/4/9 estimate (98 kcal) sits inside the 5 %
 * disclosure threshold, so the baseline carries no note and earns only the
 * badge its composition genuinely supports (`dairy_free`).
 * ------------------------------------------------------------------------- */

const FOOD_A = '11111111-1111-4111-8111-111111111111';
const FOOD_B = '22222222-2222-4222-8222-222222222222';
const FOOD_C = '33333333-3333-4333-8333-333333333333';

const makeIngredient = (overrides: Partial<RecipePublicationIngredient> = {}): RecipePublicationIngredient => ({
    catalog_food_id: FOOD_A,
    snapshot_name: 'Brown rice, cooked',
    snapshot_provenance: 'source_backed',
    snapshot_allergen_tags: [],
    snapshot_diet_tags: [],
    is_optional: false,
    allergen_status: 'known',
    catalog_nutrition_version: 1,
    catalog_metadata_version: 1,
    snapshot_per_100g: { calories: 100, protein_g: 5, carbs_g: 15, fat_g: 2, fiber_g: 1 },
    quantity: 1,
    unit: 'cup',
    gram_weight: 100,
    display_text: '1 cup',
    sort_order: 0,
    cost_class: 1,
    ...overrides,
});

const makeRecipe = (overrides: Partial<PlanningRecipeVersion> = {}): PlanningRecipeVersion => ({
    status: 'current',
    nutrition_provenance: 'source_backed',
    allergen_status: 'known',
    total_minutes: 20,
    meal_slots: ['lunch', 'dinner'],
    ingredients: [makeIngredient()],
    ...overrides,
});

const makePreferences = (overrides: Partial<PlanningPreferences> = {}): PlanningPreferences => ({
    diet: null,
    allergens: [],
    disliked_food_ids: [],
    disliked_food_groups: [],
    cooking_time_limit_min: null,
    ...overrides,
});

const makeDeclaration = (overrides: Partial<RecipeDeclaration> = {}): RecipeDeclaration => ({
    icon_key: 'bowl',
    meal_slots: ['lunch'],
    badges: ['dairy_free'],
    diet_tags: [],
    allergen_tags: [],
    prep_minutes: 10,
    cook_minutes: 15,
    yield_servings: 2,
    ...overrides,
});

/**
 * Runs `run`, asserts it threw a `RecipeDerivationError`, and returns it so the
 * `field` and `ingredient` the seed reports can be asserted directly.
 */
const captureDerivationError = (run: () => unknown): RecipeDerivationError => {
    try {
        run();
    } catch (error) {
        expect(error).toBeInstanceOf(RecipeDerivationError);
        return error as RecipeDerivationError;
    }

    throw new Error('expected the call to throw a RecipeDerivationError');
};

const codesOf = (recipe: PlanningRecipeVersion, preferences: PlanningPreferences, slot?: 'lunch' | 'breakfast') =>
    evaluatePlanningEligibility(recipe, preferences, slot ?? null).reasons.map((reason) => reason.code);

const reasonFor = (
    recipe: PlanningRecipeVersion,
    preferences: PlanningPreferences,
    code: PlanningEligibilityCode,
) => evaluatePlanningEligibility(recipe, preferences).reasons.find((reason) => reason.code === code);

/* ---------------------------------------------------------------------------
 * Closed sets
 * ------------------------------------------------------------------------- */

describe('closed-set guards', () => {
    describe('isRecipeIconKey', () => {
        it('accepts every declared key', () => {
            expect(isRecipeIconKey('bowl')).toBe(true);
            expect(isRecipeIconKey('cloche')).toBe(true);
            expect(isRecipeIconKey('bowl_dash')).toBe(true);
        });

        it('rejects an unknown key so the seed fails instead of shipping the wrong glyph', () => {
            expect(isRecipeIconKey('pan')).toBe(false);
            expect(isRecipeIconKey('Bowl')).toBe(false);
        });

        it('rejects non-strings and inherited object keys', () => {
            expect(isRecipeIconKey(undefined)).toBe(false);
            expect(isRecipeIconKey(null)).toBe(false);
            expect(isRecipeIconKey(7)).toBe(false);
            expect(isRecipeIconKey({})).toBe(false);
            expect(isRecipeIconKey('constructor')).toBe(false);
            expect(isRecipeIconKey('__proto__')).toBe(false);
        });
    });

    describe('isMealSlot', () => {
        it('accepts the four slots and rejects anything else', () => {
            expect(isMealSlot('breakfast')).toBe(true);
            expect(isMealSlot('snack')).toBe(true);
            expect(isMealSlot('brunch')).toBe(false);
            expect(isMealSlot(null)).toBe(false);
        });
    });

    describe('isRecipeBadge', () => {
        it('accepts the five codes and rejects anything else', () => {
            expect(isRecipeBadge('high_protein')).toBe(true);
            expect(isRecipeBadge('quick')).toBe(true);
            expect(isRecipeBadge('keto')).toBe(false);
            expect(isRecipeBadge(3)).toBe(false);
        });
    });

    it('names the four preference-driven eligibility codes', () => {
        expect(PREFERENCE_FLAG_CODES).toEqual(['diet', 'allergen', 'dislike', 'cooking_time']);
    });
});

/* ---------------------------------------------------------------------------
 * Time
 * ------------------------------------------------------------------------- */

describe('deriveTotalMinutes', () => {
    it('is prep plus cook', () => {
        expect(deriveTotalMinutes(10, 15)).toBe(25);
        expect(deriveTotalMinutes(0, 0)).toBe(0);
    });

    it('rejects a negative or non-finite component rather than storing a nonsense total', () => {
        expect(() => deriveTotalMinutes(-1, 10)).toThrow(RecipeDerivationError);
        expect(() => deriveTotalMinutes(10, -1)).toThrow(RecipeDerivationError);
        expect(() => deriveTotalMinutes(Number.NaN, 10)).toThrow(RecipeDerivationError);
        expect(() => deriveTotalMinutes(10, Number.POSITIVE_INFINITY)).toThrow(RecipeDerivationError);
    });

    it('names the offending field', () => {
        expect(captureDerivationError(() => deriveTotalMinutes(10, -5)).field).toBe('cook_minutes');
        expect(captureDerivationError(() => deriveTotalMinutes(-5, 10)).field).toBe('prep_minutes');
    });
});

/* ---------------------------------------------------------------------------
 * Staleness — the metadata counter is the one that is easy to forget
 * ------------------------------------------------------------------------- */

describe('isIngredientSnapshotStale', () => {
    const snapshot = { catalog_nutrition_version: 3, catalog_metadata_version: 5 };

    it('is fresh when neither counter moved', () => {
        expect(isIngredientSnapshotStale(snapshot, { ...snapshot })).toBe(false);
    });

    it('is stale when only the nutrition counter moved', () => {
        expect(
            isIngredientSnapshotStale(snapshot, { catalog_nutrition_version: 4, catalog_metadata_version: 5 }),
        ).toBe(true);
    });

    it('is stale when only the METADATA counter moved (an ingredient can gain a milk tag)', () => {
        expect(
            isIngredientSnapshotStale(snapshot, { catalog_nutrition_version: 3, catalog_metadata_version: 6 }),
        ).toBe(true);
    });

    it('is stale when a counter moved backwards, because it still describes a different row', () => {
        expect(
            isIngredientSnapshotStale(snapshot, { catalog_nutrition_version: 2, catalog_metadata_version: 5 }),
        ).toBe(true);
    });
});

describe('findStaleIngredients', () => {
    const versions = (nutrition: number, metadata: number) => ({
        catalog_nutrition_version: nutrition,
        catalog_metadata_version: metadata,
    });

    it('reports nothing when every snapshot matches', () => {
        expect(findStaleIngredients([makeIngredient()], new Map([[FOOD_A, versions(1, 1)]]))).toEqual([]);
    });

    it('reports which counter moved', () => {
        const nutritionOnly = findStaleIngredients([makeIngredient()], new Map([[FOOD_A, versions(2, 1)]]));
        const metadataOnly = findStaleIngredients([makeIngredient()], new Map([[FOOD_A, versions(1, 2)]]));
        const both = findStaleIngredients([makeIngredient()], new Map([[FOOD_A, versions(2, 2)]]));

        expect(nutritionOnly[0].changed).toEqual(['nutrition']);
        expect(metadataOnly[0].changed).toEqual(['metadata']);
        expect(both[0].changed).toEqual(['nutrition', 'metadata']);
        expect(both[0]).toMatchObject({
            catalogFoodId: FOOD_A,
            name: 'Brown rice, cooked',
            snapshotNutritionVersion: 1,
            snapshotMetadataVersion: 1,
            currentNutritionVersion: 2,
            currentMetadataVersion: 2,
        });
    });

    it('reports a food the catalog no longer carries as absent rather than unchanged', () => {
        const [stale] = findStaleIngredients([makeIngredient()], new Map());

        expect(stale.changed).toEqual(['absent']);
        expect(stale.currentNutritionVersion).toBeNull();
        expect(stale.currentMetadataVersion).toBeNull();
    });

    it('reports in sort order however the rows arrived', () => {
        const ingredients = [
            makeIngredient({ catalog_food_id: FOOD_B, snapshot_name: 'Second', sort_order: 2 }),
            makeIngredient({ catalog_food_id: FOOD_A, snapshot_name: 'First', sort_order: 1 }),
        ];

        expect(findStaleIngredients(ingredients, new Map()).map((entry) => entry.name)).toEqual([
            'First',
            'Second',
        ]);
    });
});

/* ---------------------------------------------------------------------------
 * Nutrition
 * ------------------------------------------------------------------------- */

describe('deriveRecipeNutrition', () => {
    it('sums each ingredient as gram_weight x per-100 g value', () => {
        const derived = deriveRecipeNutrition(
            [
                makeIngredient({ gram_weight: 100 }),
                makeIngredient({ catalog_food_id: FOOD_B, gram_weight: 50, sort_order: 1 }),
            ],
            1,
        );

        expect(derived.total).toEqual({ calories: 150, protein: 7.5, carbs: 22.5, fat: 3, fiber: 1.5 });
    });

    it('scales a gram weight above the basis', () => {
        expect(deriveRecipeNutrition([makeIngredient({ gram_weight: 250 })], 1).total.calories).toBe(250);
    });

    it('divides by a fractional yield and keeps per-serving values unrounded', () => {
        const derived = deriveRecipeNutrition([makeIngredient({ gram_weight: 100 })], 2.5);

        expect(derived.perServing).toEqual({ calories: 40, protein: 2, carbs: 6, fat: 0.8 });
        expect(derived.perServingFiber).toBe(0.4);
    });

    it('does not round: a third of a serving stays a repeating fraction', () => {
        const derived = deriveRecipeNutrition([makeIngredient({ gram_weight: 100 })], 3);

        expect(derived.perServing.calories).toBeCloseTo(33.3333333, 6);
        expect(Number.isInteger(derived.perServing.calories)).toBe(false);
    });

    it('includes an optional ingredient — optional is still in the dish', () => {
        const derived = deriveRecipeNutrition(
            [
                makeIngredient(),
                makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, is_optional: true, gram_weight: 100 }),
            ],
            1,
        );

        expect(derived.total.calories).toBe(200);
    });

    it('produces identical totals however the rows are ordered', () => {
        const first = makeIngredient({ catalog_food_id: FOOD_A, gram_weight: 37, sort_order: 0 });
        const second = makeIngredient({ catalog_food_id: FOOD_B, gram_weight: 113, sort_order: 1 });

        expect(deriveRecipeNutrition([first, second], 3).total).toEqual(
            deriveRecipeNutrition([second, first], 3).total,
        );
    });

    describe('a per-100 ml basis', () => {
        const oil = (density: number | null | undefined) =>
            makeIngredient({
                snapshot_name: 'Olive oil',
                nutrition_basis: 'per_100ml',
                density_g_per_ml: density,
                gram_weight: 92,
                snapshot_per_100g: { calories: 884, protein_g: 0, carbs_g: 0, fat_g: 100, fiber_g: 0 },
            });

        it('converts through the stored density', () => {
            // 100 ml of oil at 0.92 g/ml weighs 92 g, so 92 g is exactly one basis.
            expect(deriveRecipeNutrition([oil(0.92)], 1).total.calories).toBeCloseTo(884, 9);
        });

        it('scales a partial volume correctly', () => {
            expect(deriveRecipeNutrition([oil(0.92)].map((i) => ({ ...i, gram_weight: 46 })), 1).total.fat).toBeCloseTo(
                50,
                9,
            );
        });

        it('throws UnitConversionError when the density is missing, rather than assuming 1 g/ml', () => {
            expect(() => deriveRecipeNutrition([oil(null)], 1)).toThrow(UnitConversionError);
            expect(() => deriveRecipeNutrition([oil(undefined)], 1)).toThrow(UnitConversionError);
            expect(() => deriveRecipeNutrition([oil(0)], 1)).toThrow(UnitConversionError);
        });
    });

    describe('fibre', () => {
        it('sums when every ingredient states it', () => {
            expect(deriveRecipeNutrition([makeIngredient(), makeIngredient({ sort_order: 1 })], 1).total.fiber).toBe(2);
        });

        it('stays null when one ingredient states null — never 0', () => {
            const derived = deriveRecipeNutrition(
                [
                    makeIngredient(),
                    makeIngredient({
                        catalog_food_id: FOOD_B,
                        sort_order: 1,
                        snapshot_per_100g: { calories: 100, protein_g: 5, carbs_g: 15, fat_g: 2, fiber_g: null },
                    }),
                ],
                1,
            );

            expect(derived.total.fiber).toBeNull();
            expect(derived.perServingFiber).toBeNull();
        });

        it('stays null when one ingredient omits it entirely', () => {
            const derived = deriveRecipeNutrition(
                [
                    makeIngredient({
                        snapshot_per_100g: { calories: 100, protein_g: 5, carbs_g: 15, fat_g: 2 },
                    }),
                ],
                1,
            );

            expect(derived.total.fiber).toBeNull();
        });

        it('is null regardless of where the unknown value sits in the list', () => {
            const known = makeIngredient({ catalog_food_id: FOOD_A, sort_order: 0 });
            const unknown = makeIngredient({
                catalog_food_id: FOOD_B,
                sort_order: 1,
                snapshot_per_100g: { calories: 100, protein_g: 5, carbs_g: 15, fat_g: 2, fiber_g: null },
            });

            expect(deriveRecipeNutrition([known, unknown], 1).total.fiber).toBeNull();
            expect(deriveRecipeNutrition([unknown, known], 1).total.fiber).toBeNull();
        });
    });

    describe('impossible input', () => {
        it('rejects an empty ingredient set', () => {
            expect(captureDerivationError(() => deriveRecipeNutrition([], 1)).field).toBe('ingredients');
        });

        it('rejects a non-positive or non-finite yield', () => {
            expect(() => deriveRecipeNutrition([makeIngredient()], 0)).toThrow(RecipeDerivationError);
            expect(() => deriveRecipeNutrition([makeIngredient()], -2)).toThrow(RecipeDerivationError);
            expect(() => deriveRecipeNutrition([makeIngredient()], Number.NaN)).toThrow(RecipeDerivationError);
        });

        it('rejects a non-positive gram weight and names the ingredient', () => {
            const error = captureDerivationError(() =>
                deriveRecipeNutrition([makeIngredient({ gram_weight: 0 })], 1),
            );

            expect(error.field).toBe('gram_weight');
            expect(error.ingredient).toBe('Brown rice, cooked');
            expect(() => deriveRecipeNutrition([makeIngredient({ gram_weight: -5 })], 1)).toThrow(
                RecipeDerivationError,
            );
            expect(() => deriveRecipeNutrition([makeIngredient({ gram_weight: Number.NaN })], 1)).toThrow(
                RecipeDerivationError,
            );
        });

        it('rejects a negative or non-finite nutrient and names the field', () => {
            const negative = captureDerivationError(() =>
                deriveRecipeNutrition(
                    [makeIngredient({ snapshot_per_100g: { calories: 100, protein_g: -1, carbs_g: 15, fat_g: 2 } })],
                    1,
                ),
            );
            const nonFinite = captureDerivationError(() =>
                deriveRecipeNutrition(
                    [
                        makeIngredient({
                            snapshot_per_100g: { calories: Number.NaN, protein_g: 5, carbs_g: 15, fat_g: 2 },
                        }),
                    ],
                    1,
                ),
            );

            expect(negative.field).toBe('protein_g');
            expect(nonFinite.field).toBe('calories');
        });

        it('rejects a negative fibre value it was asked to sum', () => {
            const error = captureDerivationError(() =>
                deriveRecipeNutrition(
                    [
                        makeIngredient({
                            snapshot_per_100g: { calories: 100, protein_g: 5, carbs_g: 15, fat_g: 2, fiber_g: -1 },
                        }),
                    ],
                    1,
                ),
            );

            expect(error.field).toBe('fiber_g');
        });

        it('rejects a basis it cannot convert instead of guessing', () => {
            const perServing = {
                ...makeIngredient(),
                nutrition_basis: 'per_serving',
            } as unknown as RecipeIngredientSnapshot;

            expect(captureDerivationError(() => deriveRecipeNutrition([perServing], 1)).field).toBe(
                'nutrition_basis',
            );
        });
    });
});

describe('deriveSourcedCaloriesNote', () => {
    it('is silent when the sourced energy and the 4/4/9 estimate agree', () => {
        // 4·25 + 4·25 + 9·0 = 200
        expect(deriveSourcedCaloriesNote({ calories: 200, protein: 25, carbs: 25, fat: 0 })).toBeNull();
    });

    it('is silent at exactly the threshold', () => {
        // 4·0 + 4·262.5 + 9·0 = 1050, exactly 5 % above 1000.
        expect(deriveSourcedCaloriesNote({ calories: 1000, protein: 0, carbs: 262.5, fat: 0 })).toBeNull();
    });

    it('discloses just above the threshold, with the percentage', () => {
        // 4·263 = 1052, i.e. 5.2 % above 1000.
        const note = deriveSourcedCaloriesNote({ calories: 1000, protein: 0, carbs: 263, fat: 0 });

        expect(note).toBe('Sourced energy 1000 kcal differs from the 4/4/9 macro estimate 1052 kcal by 5.2%.');
    });

    it('discloses a divergence in the other direction too', () => {
        const note = deriveSourcedCaloriesNote({ calories: 1000, protein: 0, carbs: 200, fat: 0 });

        expect(note).toContain('20.0%');
    });

    it('is silent when there is no energy and no macros', () => {
        expect(deriveSourcedCaloriesNote({ calories: 0, protein: 0, carbs: 0, fat: 0 })).toBeNull();
    });

    it('discloses macros that imply energy the source does not state, without a percentage', () => {
        const note = deriveSourcedCaloriesNote({ calories: 0, protein: 5, carbs: 5, fat: 1 });

        expect(note).toBe('Sourced energy 0 kcal differs from the 4/4/9 macro estimate 49 kcal.');
        expect(note).not.toContain('%');
    });

    it('rejects a negative value rather than reporting a nonsense divergence', () => {
        expect(() => deriveSourcedCaloriesNote({ calories: -1, protein: 0, carbs: 0, fat: 0 })).toThrow(
            RecipeDerivationError,
        );
        expect(() => deriveSourcedCaloriesNote({ calories: 100, protein: 0, carbs: 0, fat: Number.NaN })).toThrow(
            RecipeDerivationError,
        );
    });

    it('exposes the threshold it applies', () => {
        expect(SOURCED_CALORIE_DIVERGENCE_THRESHOLD).toBe(0.05);
    });

    it('is reported alongside a numeric divergence by the derivation', () => {
        const derived = deriveRecipeNutrition(
            [
                makeIngredient({
                    gram_weight: 100,
                    snapshot_per_100g: { calories: 1000, protein_g: 0, carbs_g: 263, fat_g: 0, fiber_g: 0 },
                }),
            ],
            1,
        );

        expect(derived.macroEnergyKcal).toBe(1052);
        expect(derived.calorieDivergence).toBeCloseTo(0.052, 9);
        expect(derived.sourcedCaloriesNote).toContain('5.2%');
    });

    it('reports a null divergence when the sourced energy is zero', () => {
        const derived = deriveRecipeNutrition(
            [
                makeIngredient({
                    snapshot_per_100g: { calories: 0, protein_g: 0, carbs_g: 0, fat_g: 0, fiber_g: 0 },
                }),
            ],
            1,
        );

        expect(derived.calorieDivergence).toBeNull();
        expect(derived.sourcedCaloriesNote).toBeNull();
    });
});

/* ---------------------------------------------------------------------------
 * Tags and provenance
 * ------------------------------------------------------------------------- */

const withoutAllergenStatus = (ingredient: RecipePublicationIngredient) => {
    const { allergen_status: _omitted, ...rest } = ingredient;
    return rest;
};

describe('deriveAllergenTags', () => {
    it('is the union across ingredients, including optional ones', () => {
        const tags = deriveAllergenTags([
            makeIngredient({ snapshot_allergen_tags: ['milk'] }),
            makeIngredient({
                catalog_food_id: FOOD_B,
                sort_order: 1,
                is_optional: true,
                snapshot_allergen_tags: ['sesame'],
            }),
        ]);

        expect(tags).toEqual(['milk', 'sesame']);
    });

    it('treats spelling variants as one tag and keeps a stable original', () => {
        const first = makeIngredient({ snapshot_allergen_tags: ['milk', 'Tree nuts'] });
        const second = makeIngredient({
            catalog_food_id: FOOD_B,
            sort_order: 1,
            snapshot_allergen_tags: ['tree_nuts', 'soy'],
        });

        expect(deriveAllergenTags([first, second])).toEqual(['milk', 'soy', 'Tree nuts']);
        expect(deriveAllergenTags([second, first])).toEqual(['milk', 'soy', 'Tree nuts']);
    });

    it('ignores a tag with no alphanumeric content, which could never be matched', () => {
        expect(deriveAllergenTags([makeIngredient({ snapshot_allergen_tags: ['milk', '---', '  '] })])).toEqual([
            'milk',
        ]);
    });

    it('is empty for no ingredients', () => {
        expect(deriveAllergenTags([])).toEqual([]);
    });
});

describe('deriveAllergenStatus', () => {
    it('is known only when every ingredient has been reviewed', () => {
        expect(deriveAllergenStatus([makeIngredient(), makeIngredient({ sort_order: 1 })])).toBe('known');
    });

    it('is unknown when one ingredient is unreviewed', () => {
        expect(
            deriveAllergenStatus([makeIngredient(), makeIngredient({ sort_order: 1, allergen_status: 'unknown' })]),
        ).toBe('unknown');
    });

    it('is unknown when an ingredient carries no review at all', () => {
        expect(deriveAllergenStatus([withoutAllergenStatus(makeIngredient())])).toBe('unknown');
    });

    it('is unknown for no ingredients — nothing has been reviewed', () => {
        expect(deriveAllergenStatus([])).toBe('unknown');
    });
});

describe('deriveDietTags', () => {
    it('is the intersection, closed under vegan implies vegetarian implies pescatarian', () => {
        const tags = deriveDietTags([
            makeIngredient({ snapshot_diet_tags: ['vegan', 'gluten_free'] }),
            makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, snapshot_diet_tags: ['vegan', 'gluten_free'] }),
        ]);

        expect(tags).toEqual(['gluten_free', 'pescatarian', 'vegan', 'vegetarian']);
    });

    it('drops a claim one ingredient does not carry', () => {
        expect(
            deriveDietTags([
                makeIngredient({ snapshot_diet_tags: ['vegan'] }),
                makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, snapshot_diet_tags: [] }),
            ]),
        ).toEqual([]);
    });

    it('counts an optional ingredient — an optional garnish still breaks a vegan claim', () => {
        expect(
            deriveDietTags([
                makeIngredient({ snapshot_diet_tags: ['vegan'] }),
                makeIngredient({
                    catalog_food_id: FOOD_B,
                    sort_order: 1,
                    is_optional: true,
                    snapshot_diet_tags: [],
                }),
            ]),
        ).toEqual([]);
    });

    it('implies pescatarian from vegetarian without implying vegan', () => {
        const tags = deriveDietTags([makeIngredient({ snapshot_diet_tags: ['vegetarian'] })]);

        expect(tags).toEqual(['pescatarian', 'vegetarian']);
        expect(tags).not.toContain('vegan');
    });

    it('leaves a pescatarian-only dish pescatarian', () => {
        expect(deriveDietTags([makeIngredient({ snapshot_diet_tags: ['pescatarian'] })])).toEqual(['pescatarian']);
    });

    it('matches across spellings', () => {
        const tags = deriveDietTags([
            makeIngredient({ snapshot_diet_tags: ['Vegan'] }),
            makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, snapshot_diet_tags: ['vegan'] }),
        ]);

        expect(isDietCompatible('vegan', tags)).toBe(true);
    });

    it('is empty for no ingredients rather than vacuously everything', () => {
        expect(deriveDietTags([])).toEqual([]);
    });
});

describe('isDietCompatible', () => {
    it('admits everything when no diet is set or the diet is none', () => {
        expect(isDietCompatible(null, [])).toBe(true);
        expect(isDietCompatible('none', [])).toBe(true);
    });

    it('requires a named diet to appear in the derived tags', () => {
        expect(isDietCompatible('vegan', ['vegan'])).toBe(true);
        expect(isDietCompatible('vegan', ['vegetarian'])).toBe(false);
        expect(isDietCompatible('pescatarian', ['pescatarian'])).toBe(true);
    });

    it('compares through the normalised key', () => {
        expect(isDietCompatible('vegan', ['Vegan'])).toBe(true);
    });
});

describe('deriveNutritionProvenance', () => {
    it('is source_backed only when every ingredient is', () => {
        expect(deriveNutritionProvenance([makeIngredient(), makeIngredient({ sort_order: 1 })])).toBe('source_backed');
    });

    it('degrades to ingredient_derived when one ingredient is', () => {
        expect(
            deriveNutritionProvenance([
                makeIngredient(),
                makeIngredient({ sort_order: 1, snapshot_provenance: 'ingredient_derived' }),
            ]),
        ).toBe('ingredient_derived');
    });

    it('degrades all the way to ai_estimated, the weakest grade present', () => {
        expect(
            deriveNutritionProvenance([
                makeIngredient({ snapshot_provenance: 'ingredient_derived' }),
                makeIngredient({ sort_order: 1, snapshot_provenance: 'ai_estimated' }),
            ]),
        ).toBe('ai_estimated');
    });

    it('rejects a user_entered ingredient, which no catalog food can be', () => {
        const error = captureDerivationError(() =>
            deriveNutritionProvenance([
                makeIngredient({ snapshot_name: 'Mystery sauce', snapshot_provenance: 'user_entered' }),
            ]),
        );

        expect(error.field).toBe('snapshot_provenance');
        expect(error.ingredient).toBe('Mystery sauce');
    });

    it('rejects an empty ingredient set', () => {
        expect(captureDerivationError(() => deriveNutritionProvenance([])).field).toBe('ingredients');
    });
});

/* ---------------------------------------------------------------------------
 * Badges
 * ------------------------------------------------------------------------- */

describe('deriveBadges', () => {
    const nutrition = (calories: number, protein: number) => ({ calories, protein, carbs: 0, fat: 0 });
    const context = (calories = 100, protein = 5, totalMinutes = 30) => ({
        nutrition: nutrition(calories, protein),
        totalMinutes,
    });

    describe('high_protein', () => {
        it('is earned at exactly 30 % of energy', () => {
            expect(deriveBadges([makeIngredient()], context(400, 30))).toContain('high_protein');
            expect(HIGH_PROTEIN_MIN_ENERGY_SHARE).toBe(0.3);
        });

        it('is not earned just below 30 %', () => {
            expect(deriveBadges([makeIngredient()], context(400, 29.9))).not.toContain('high_protein');
        });

        it('is not earned when there is no energy to take a share of', () => {
            expect(deriveBadges([makeIngredient()], context(0, 10))).not.toContain('high_protein');
        });
    });

    describe('gluten_free', () => {
        const glutenFree = (overrides: Partial<RecipePublicationIngredient> = {}) =>
            makeIngredient({ snapshot_diet_tags: ['gluten_free'], ...overrides });

        it('is earned when every reviewed ingredient carries the tag', () => {
            expect(
                deriveBadges([glutenFree(), glutenFree({ catalog_food_id: FOOD_B, sort_order: 1 })], context()),
            ).toContain('gluten_free');
        });

        it('is omitted for an uncertified oat, which simply lacks the reviewed tag', () => {
            const badges = deriveBadges(
                [
                    glutenFree(),
                    makeIngredient({
                        catalog_food_id: FOOD_B,
                        sort_order: 1,
                        snapshot_name: 'Rolled oats',
                        snapshot_diet_tags: [],
                    }),
                ],
                context(),
            );

            expect(badges).not.toContain('gluten_free');
        });

        it('is omitted when any ingredient is unreviewed', () => {
            const badges = deriveBadges(
                [glutenFree(), glutenFree({ catalog_food_id: FOOD_B, sort_order: 1, allergen_status: 'unknown' })],
                context(),
            );

            expect(badges).not.toContain('gluten_free');
            expect(badges).not.toContain('dairy_free');
        });

        it.each(['wheat', 'barley', 'rye', 'malt', 'gluten', "brewer's yeast"])(
            'is omitted when an ingredient contradicts the tag with %s',
            (allergen) => {
                const badges = deriveBadges(
                    [glutenFree(), glutenFree({ catalog_food_id: FOOD_B, sort_order: 1, snapshot_allergen_tags: [allergen] })],
                    context(),
                );

                expect(badges).not.toContain('gluten_free');
            },
        );
    });

    describe('dairy_free', () => {
        it('is earned when every ingredient is reviewed and none carries milk', () => {
            expect(deriveBadges([makeIngredient()], context())).toContain('dairy_free');
        });

        it('is omitted for a milk tag, whatever its spelling', () => {
            expect(
                deriveBadges([makeIngredient({ snapshot_allergen_tags: ['Milk'] })], context()),
            ).not.toContain('dairy_free');
        });

        it('is omitted when an ingredient carries no allergen review', () => {
            expect(deriveBadges([withoutAllergenStatus(makeIngredient())], context())).not.toContain('dairy_free');
        });
    });

    describe('vegan', () => {
        it('requires the tag on every ingredient', () => {
            expect(
                deriveBadges(
                    [
                        makeIngredient({ snapshot_diet_tags: ['vegan'] }),
                        makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, snapshot_diet_tags: ['vegan'] }),
                    ],
                    context(),
                ),
            ).toContain('vegan');

            expect(
                deriveBadges(
                    [
                        makeIngredient({ snapshot_diet_tags: ['vegan'] }),
                        makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, snapshot_diet_tags: [] }),
                    ],
                    context(),
                ),
            ).not.toContain('vegan');
        });
    });

    describe('quick', () => {
        it('is earned at exactly the ceiling and lost one minute later', () => {
            expect(deriveBadges([makeIngredient()], context(100, 5, QUICK_MAX_TOTAL_MINUTES))).toContain('quick');
            expect(deriveBadges([makeIngredient()], context(100, 5, QUICK_MAX_TOTAL_MINUTES + 1))).not.toContain(
                'quick',
            );
            expect(QUICK_MAX_TOTAL_MINUTES).toBe(15);
        });
    });

    it('emits every earned badge in declaration order', () => {
        const ingredients = [
            makeIngredient({ snapshot_diet_tags: ['vegan', 'gluten_free'] }),
            makeIngredient({
                catalog_food_id: FOOD_B,
                sort_order: 1,
                snapshot_diet_tags: ['vegan', 'gluten_free'],
            }),
        ];

        expect(deriveBadges(ingredients, context(400, 30, 15))).toEqual([
            'high_protein',
            'gluten_free',
            'dairy_free',
            'vegan',
            'quick',
        ]);
    });

    it('makes no composition claim about an empty ingredient set', () => {
        expect(deriveBadges([], context(400, 30, 10))).toEqual(['high_protein', 'quick']);
    });

    it('rejects a non-finite or negative total time', () => {
        expect(() => deriveBadges([makeIngredient()], context(100, 5, Number.NaN))).toThrow(RecipeDerivationError);
        expect(captureDerivationError(() => deriveBadges([makeIngredient()], context(100, 5, -1))).field).toBe(
            'total_minutes',
        );
    });

    it('rejects nutrition it cannot take a share of', () => {
        expect(captureDerivationError(() => deriveBadges([makeIngredient()], context(100, -5))).field).toBe('protein');
    });
});

/* ---------------------------------------------------------------------------
 * Budget
 * ------------------------------------------------------------------------- */

describe('deriveCostScore', () => {
    it('is mass-weighted, so a small expensive ingredient barely moves it', () => {
        const cheapBulk = makeIngredient({ gram_weight: 300, cost_class: 1 });
        const dearPinch = makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, gram_weight: 100, cost_class: 3 });

        expect(deriveCostScore([cheapBulk, dearPinch])).toBe(1.5);
    });

    it('averages equal masses', () => {
        expect(
            deriveCostScore([
                makeIngredient({ gram_weight: 100, cost_class: 1 }),
                makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, gram_weight: 100, cost_class: 3 }),
            ]),
        ).toBe(2);
    });

    it('does not depend on row order', () => {
        const first = makeIngredient({ gram_weight: 37, cost_class: 1 });
        const second = makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, gram_weight: 113, cost_class: 3 });

        expect(deriveCostScore([first, second])).toBe(deriveCostScore([second, first]));
    });

    it.each([0, 4, 1.5, Number.NaN])('rejects the out-of-range cost class %p', (costClass) => {
        expect(captureDerivationError(() => deriveCostScore([makeIngredient({ cost_class: costClass })])).field).toBe(
            'cost_class',
        );
    });

    it('rejects a missing cost class rather than defaulting to average', () => {
        const { cost_class: _omitted, ...withoutCostClass } = makeIngredient();
        // A null is legitimate on the row shape and still not a cost class.
        const nullCostClass: RecipeIngredientSnapshot = { ...makeIngredient(), cost_class: null };

        expect(captureDerivationError(() => deriveCostScore([withoutCostClass])).field).toBe('cost_class');
        expect(captureDerivationError(() => deriveCostScore([nullCostClass])).field).toBe('cost_class');
    });

    it('rejects an empty ingredient set and a non-positive gram weight', () => {
        expect(captureDerivationError(() => deriveCostScore([])).field).toBe('ingredients');
        expect(captureDerivationError(() => deriveCostScore([makeIngredient({ gram_weight: 0 })])).field).toBe(
            'gram_weight',
        );
    });
});

describe('deriveBudgetTier', () => {
    it('uses inclusive upper bounds', () => {
        expect(deriveBudgetTier(BUDGET_TIER_1_MAX_COST_SCORE)).toBe(1);
        expect(deriveBudgetTier(BUDGET_TIER_1_MAX_COST_SCORE + 0.01)).toBe(2);
        expect(deriveBudgetTier(BUDGET_TIER_2_MAX_COST_SCORE)).toBe(2);
        expect(deriveBudgetTier(BUDGET_TIER_2_MAX_COST_SCORE + 0.01)).toBe(3);
    });

    it('covers the extremes of the cost-class range', () => {
        expect(deriveBudgetTier(1)).toBe(1);
        expect(deriveBudgetTier(3)).toBe(3);
        expect(BUDGET_TIER_1_MAX_COST_SCORE).toBe(1.5);
        expect(BUDGET_TIER_2_MAX_COST_SCORE).toBe(2.5);
    });

    it('rejects a non-finite score', () => {
        expect(captureDerivationError(() => deriveBudgetTier(Number.NaN)).field).toBe('cost_score');
        expect(() => deriveBudgetTier(Number.POSITIVE_INFINITY)).toThrow(RecipeDerivationError);
    });
});

/* ---------------------------------------------------------------------------
 * Display scaling and the rounding contract
 * ------------------------------------------------------------------------- */

describe('formatIngredientQuantity', () => {
    it('renders a mass in its own unit, to a tenth', () => {
        expect(formatIngredientQuantity(5, 'oz')).toBe('5 oz');
        expect(formatIngredientQuantity(2.44, 'oz')).toBe('2.4 oz');
        expect(formatIngredientQuantity(0.1, 'g')).toBe('0.1 g');
    });

    it('never promotes a mass to a larger unit the way a grocery row would', () => {
        // `formatMass` would render these as "1 lb" and "1.3 lb", which is right
        // for something you buy and wrong for something you measure.
        expect(formatIngredientQuantity(453.6, 'g')).toBe('453.6 g');
        expect(formatIngredientQuantity(20, 'oz')).toBe('20 oz');
    });

    it('renders a volume with fraction glyphs', () => {
        expect(formatIngredientQuantity(0.75, 'cup')).toBe('¾ cup');
        expect(formatIngredientQuantity(1.25, 'cup')).toBe('1¼ cup');
        expect(formatIngredientQuantity(0.6, 'tbsp')).toBe('½ tbsp');
    });

    it('renders a generic count as a bare fraction, as the design does for a quarter avocado', () => {
        expect(formatIngredientQuantity(0.25, 'each')).toBe('¼');
        expect(formatIngredientQuantity(0.25, 'whole')).toBe('¼');
    });

    it('keeps a named count unit exactly as the recipe authored it', () => {
        expect(formatIngredientQuantity(2, 'cloves')).toBe('2 cloves');
        expect(formatIngredientQuantity(1, 'clove')).toBe('1 clove');
    });

    it('falls back to fraction glyphs for an unrecognised or absent unit', () => {
        expect(formatIngredientQuantity(0.5, 'sprig')).toBe('½ sprig');
        expect(formatIngredientQuantity(2, '')).toBe('2');
    });

    it('rejects a non-finite quantity', () => {
        expect(captureDerivationError(() => formatIngredientQuantity(Number.NaN, 'cup')).field).toBe('quantity');
    });
});

describe('scaleIngredients', () => {
    it("returns the stored values and the authored text for 'full'", () => {
        expect(scaleIngredients([makeIngredient()], 'full', 4)).toEqual([
            {
                catalogFoodId: FOOD_A,
                name: 'Brown rice, cooked',
                quantity: 1,
                unit: 'cup',
                gramWeight: 100,
                displayText: '1 cup',
                sortOrder: 0,
                isOptional: false,
            },
        ]);
    });

    it('scales one serving by 1 / yield_servings and recomputes the text', () => {
        const [scaled] = scaleIngredients([makeIngredient()], 1, 4);

        expect(scaled.quantity).toBe(0.25);
        expect(scaled.gramWeight).toBe(25);
        expect(scaled.displayText).toBe('¼ cup');
    });

    it("makes 'full' equal to yield_servings times one serving", () => {
        const full = scaleIngredients([makeIngredient()], 'full', 4);
        const wholeRecipeByMultiplier = scaleIngredients([makeIngredient()], 4, 4);

        expect(wholeRecipeByMultiplier).toEqual(full);
    });

    it.each([0.5, 0.75, 1, 1.25, 1.5, 1.75, 2])('scales the allowed multiplier %p', (multiplier) => {
        const [scaled] = scaleIngredients([makeIngredient()], multiplier, 2);

        expect(scaled.gramWeight).toBe(100 * (multiplier / 2));
        expect(scaled.quantity).toBe(multiplier / 2);
    });

    it('mutates nothing', () => {
        const ingredients = [makeIngredient()];
        const before = JSON.stringify(ingredients);

        const scaled = scaleIngredients(ingredients, 0.5, 2);

        expect(JSON.stringify(ingredients)).toBe(before);
        expect(scaled[0]).not.toBe(ingredients[0]);
    });

    it('returns ingredients in sort order', () => {
        const scaled = scaleIngredients(
            [
                makeIngredient({ catalog_food_id: FOOD_B, snapshot_name: 'Second', sort_order: 2 }),
                makeIngredient({ catalog_food_id: FOOD_A, snapshot_name: 'First', sort_order: 1 }),
            ],
            'full',
            2,
        );

        expect(scaled.map((entry) => entry.name)).toEqual(['First', 'Second']);
    });

    it('breaks a shared sort_order by catalog food id, so a seed file with a duplicated order still reads the same way twice', () => {
        const scaled = scaleIngredients(
            [
                makeIngredient({ catalog_food_id: FOOD_C, snapshot_name: 'Third', sort_order: 1 }),
                makeIngredient({ catalog_food_id: FOOD_A, snapshot_name: 'First', sort_order: 1 }),
                makeIngredient({ catalog_food_id: FOOD_B, snapshot_name: 'Second', sort_order: 1 }),
            ],
            'full',
            2,
        );

        expect(scaled.map((entry) => entry.name)).toEqual(['First', 'Second', 'Third']);
    });

    it('keeps two rows of the SAME food in input order, the last tiebreaker', () => {
        const scaled = scaleIngredients(
            [
                makeIngredient({ snapshot_name: 'Olive oil, for the pan', sort_order: 3, unit: 'tsp', quantity: 1 }),
                makeIngredient({ snapshot_name: 'Olive oil, for the dressing', sort_order: 3, unit: 'tbsp' }),
            ],
            'full',
            2,
        );

        expect(scaled.map((entry) => entry.name)).toEqual([
            'Olive oil, for the pan',
            'Olive oil, for the dressing',
        ]);
    });

    it('rejects an impossible portion or yield', () => {
        expect(captureDerivationError(() => scaleIngredients([makeIngredient()], 0, 2)).field).toBe(
            'portion_multiplier',
        );
        expect(() => scaleIngredients([makeIngredient()], -1, 2)).toThrow(RecipeDerivationError);
        expect(() => scaleIngredients([makeIngredient()], Number.NaN, 2)).toThrow(RecipeDerivationError);
        expect(captureDerivationError(() => scaleIngredients([makeIngredient()], 'full', 0)).field).toBe(
            'yield_servings',
        );
    });
});

describe('scalePlannedNutrition', () => {
    const perServing = { calories: 10, protein: 1, carbs: 2, fat: 0.5 };

    it('multiplies at full precision', () => {
        expect(scalePlannedNutrition(perServing, 1.25)).toEqual({
            calories: 12.5,
            protein: 1.25,
            carbs: 2.5,
            fat: 0.625,
        });
    });

    it('keeps a repeating fraction rather than rounding it away', () => {
        const scaled = scalePlannedNutrition({ calories: 100 / 3, protein: 1, carbs: 1, fat: 1 }, 1);

        expect(Number.isInteger(scaled.calories)).toBe(false);
        expect(scaled.calories).toBeCloseTo(33.3333333, 6);
    });

    it('rejects an impossible multiplier or value', () => {
        expect(captureDerivationError(() => scalePlannedNutrition(perServing, 0)).field).toBe('portion_multiplier');
        expect(() => scalePlannedNutrition(perServing, -1)).toThrow(RecipeDerivationError);
        expect(() => scalePlannedNutrition(perServing, Number.NaN)).toThrow(RecipeDerivationError);
        expect(captureDerivationError(() => scalePlannedNutrition({ ...perServing, fat: -1 }, 1)).field).toBe('fat');
    });
});

describe('roundNutritionForDisplay', () => {
    it('rounds every value to the nearest whole unit', () => {
        expect(roundNutritionForDisplay({ calories: 12.5, protein: 1.4, carbs: 2.5, fat: 0.625 })).toEqual({
            calories: 13,
            protein: 1,
            carbs: 3,
            fat: 1,
        });
    });

    it('rejects a non-finite value', () => {
        expect(
            captureDerivationError(() =>
                roundNutritionForDisplay({ calories: Number.NaN, protein: 1, carbs: 1, fat: 1 }),
            ).field,
        ).toBe('calories');
    });

    it('leaves the planned values it was given unrounded', () => {
        const planned = scalePlannedNutrition({ calories: 10.4, protein: 1, carbs: 1, fat: 1 }, 1);

        roundNutritionForDisplay(planned);

        expect(planned.calories).toBe(10.4);
    });
});

/* ---------------------------------------------------------------------------
 * Planning eligibility
 * ------------------------------------------------------------------------- */

describe('evaluatePlanningEligibility', () => {
    it('admits a current, source-backed, reviewed recipe with no preference conflict', () => {
        const verdict = evaluatePlanningEligibility(makeRecipe(), makePreferences(), 'lunch');

        expect(verdict).toEqual({ eligible: true, reasons: [] });
        expect(isEligibleForPlanning(makeRecipe(), makePreferences(), 'lunch')).toBe(true);
    });

    it('refuses a retired version, which stays readable but is never planned again', () => {
        expect(codesOf(makeRecipe({ status: 'retired' }), makePreferences())).toEqual(['status']);
    });

    describe('nutrition provenance', () => {
        it('refuses an ingredient_derived recipe', () => {
            expect(
                codesOf(makeRecipe({ nutrition_provenance: 'ingredient_derived' }), makePreferences()),
            ).toEqual(['nutrition_provenance']);
        });

        it('refuses an ai_estimated recipe', () => {
            expect(codesOf(makeRecipe({ nutrition_provenance: 'ai_estimated' }), makePreferences())).toEqual([
                'nutrition_provenance',
            ]);
        });

        it('refuses a source-backed rollup whose ingredient is an estimate, and names it', () => {
            const recipe = makeRecipe({
                ingredients: [
                    makeIngredient(),
                    makeIngredient({
                        catalog_food_id: FOOD_B,
                        sort_order: 1,
                        snapshot_name: 'House sauce',
                        snapshot_provenance: 'ingredient_derived',
                    }),
                ],
            });

            expect(reasonFor(recipe, makePreferences(), 'nutrition_provenance')?.detail).toEqual(['House sauce']);
        });

        it('reports the rollup value when no single ingredient can be named', () => {
            expect(
                reasonFor(makeRecipe({ nutrition_provenance: 'ai_estimated' }), makePreferences(), 'nutrition_provenance')
                    ?.detail,
            ).toEqual(['ai_estimated']);
        });
    });

    describe('allergen review status', () => {
        it('refuses an unreviewed recipe even when the user selected no allergies at all', () => {
            expect(codesOf(makeRecipe({ allergen_status: 'unknown' }), makePreferences())).toEqual([
                'allergen_status',
            ]);
        });

        it('refuses an unreviewed INGREDIENT and names it, whatever the user selected', () => {
            const recipe = makeRecipe({
                ingredients: [
                    makeIngredient(),
                    makeIngredient({
                        catalog_food_id: FOOD_B,
                        sort_order: 1,
                        snapshot_name: 'Unlabelled spice mix',
                        allergen_status: 'unknown',
                    }),
                ],
            });

            expect(reasonFor(recipe, makePreferences(), 'allergen_status')?.detail).toEqual(['Unlabelled spice mix']);
        });

        it('falls back to the recipe rollup when the caller supplied no per-ingredient review', () => {
            const recipe = makeRecipe({ ingredients: [withoutAllergenStatus(makeIngredient())] });

            expect(codesOf(recipe, makePreferences())).toEqual([]);
        });
    });

    describe('allergens', () => {
        const milkRecipe = makeRecipe({
            ingredients: [makeIngredient({ snapshot_name: 'Butter', snapshot_allergen_tags: ['Milk'] })],
        });

        it('refuses an overlap across spellings and reports the user’s own wording', () => {
            expect(reasonFor(milkRecipe, makePreferences({ allergens: ['milk'] }), 'allergen')?.detail).toEqual([
                'milk',
            ]);
        });

        it('matches an optional ingredient too', () => {
            const recipe = makeRecipe({
                ingredients: [
                    makeIngredient(),
                    makeIngredient({
                        catalog_food_id: FOOD_B,
                        sort_order: 1,
                        is_optional: true,
                        snapshot_allergen_tags: ['sesame'],
                    }),
                ],
            });

            expect(codesOf(recipe, makePreferences({ allergens: ['sesame'] }))).toEqual(['allergen']);
        });

        it('never treats the exclusive "none" answer as a tag to match', () => {
            const recipe = makeRecipe({ ingredients: [makeIngredient({ snapshot_allergen_tags: ['none'] })] });

            expect(codesOf(recipe, makePreferences({ allergens: ['none'] }))).toEqual([]);
        });

        it('ignores an unmatched allergen', () => {
            expect(codesOf(milkRecipe, makePreferences({ allergens: ['soy'] }))).toEqual([]);
        });
    });

    describe('diet', () => {
        const veganRecipe = makeRecipe({
            ingredients: [makeIngredient({ snapshot_diet_tags: ['vegan'] })],
        });

        it('refuses a recipe the ingredient snapshots do not support', () => {
            expect(reasonFor(makeRecipe(), makePreferences({ diet: 'vegan' }), 'diet')?.detail).toEqual(['vegan']);
        });

        it('admits a supported diet, including one reached by containment', () => {
            expect(codesOf(veganRecipe, makePreferences({ diet: 'vegan' }))).toEqual([]);
            expect(codesOf(veganRecipe, makePreferences({ diet: 'vegetarian' }))).toEqual([]);
            expect(codesOf(veganRecipe, makePreferences({ diet: 'pescatarian' }))).toEqual([]);
        });

        it('admits everything for none or an unanswered diet', () => {
            expect(codesOf(makeRecipe(), makePreferences({ diet: 'none' }))).toEqual([]);
            expect(codesOf(makeRecipe(), makePreferences({ diet: null }))).toEqual([]);
        });
    });

    describe('dislikes', () => {
        it('refuses a disliked food by id', () => {
            expect(
                reasonFor(makeRecipe(), makePreferences({ disliked_food_ids: [FOOD_A] }), 'dislike')?.detail,
            ).toEqual(['Brown rice, cooked']);
        });

        it('refuses a disliked FOOD GROUP, which is what makes one mushroom exclude them all', () => {
            const recipe = makeRecipe({
                ingredients: [
                    makeIngredient({ snapshot_name: 'Mushrooms, white', food_group: 'mushroom' }),
                ],
            });

            expect(
                reasonFor(recipe, makePreferences({ disliked_food_groups: ['Mushroom'] }), 'dislike')?.detail,
            ).toEqual(['Mushrooms, white']);
        });

        it('leaves an unrelated group alone', () => {
            const recipe = makeRecipe({ ingredients: [makeIngredient({ food_group: 'grain' })] });

            expect(codesOf(recipe, makePreferences({ disliked_food_groups: ['mushroom'] }))).toEqual([]);
        });

        it('does not match when the caller supplied no food group', () => {
            expect(codesOf(makeRecipe(), makePreferences({ disliked_food_groups: ['grain'] }))).toEqual([]);
        });
    });

    describe('cooking time', () => {
        it('admits a recipe at exactly the limit', () => {
            expect(
                codesOf(makeRecipe({ total_minutes: 30 }), makePreferences({ cooking_time_limit_min: 30 })),
            ).toEqual([]);
        });

        it('refuses one minute over, reporting the recipe’s own total', () => {
            expect(
                reasonFor(makeRecipe({ total_minutes: 31 }), makePreferences({ cooking_time_limit_min: 30 }), 'cooking_time')
                    ?.detail,
            ).toEqual(['31']);
        });

        it('applies no limit when the user has not answered', () => {
            expect(
                codesOf(makeRecipe({ total_minutes: 300 }), makePreferences({ cooking_time_limit_min: null })),
            ).toEqual([]);
        });

        it('refuses a total it cannot compare', () => {
            expect(
                codesOf(makeRecipe({ total_minutes: Number.NaN }), makePreferences({ cooking_time_limit_min: 30 })),
            ).toEqual(['cooking_time']);
        });
    });

    describe('slot', () => {
        it('refuses a slot the recipe does not declare', () => {
            expect(codesOf(makeRecipe(), makePreferences(), 'breakfast')).toEqual(['slot']);
        });

        it('asks the slot-independent question when no slot is given', () => {
            expect(codesOf(makeRecipe({ meal_slots: [] }), makePreferences())).toEqual([]);
            // The boolean wrapper defaults the slot the same way, which is how
            // incompatibility flagging asks about a meal already in a slot.
            expect(isEligibleForPlanning(makeRecipe({ meal_slots: [] }), makePreferences())).toBe(true);
        });
    });

    it('collects every refusal in code order rather than stopping at the first', () => {
        const recipe = makeRecipe({
            status: 'retired',
            nutrition_provenance: 'ai_estimated',
            allergen_status: 'unknown',
            total_minutes: 60,
            meal_slots: ['dinner'],
            ingredients: [
                makeIngredient({
                    snapshot_provenance: 'ai_estimated',
                    allergen_status: 'unknown',
                    snapshot_allergen_tags: ['milk'],
                    food_group: 'grain',
                }),
            ],
        });
        const preferences = makePreferences({
            diet: 'vegan',
            allergens: ['milk'],
            disliked_food_ids: [FOOD_A],
            disliked_food_groups: ['grain'],
            cooking_time_limit_min: 30,
        });

        expect(codesOf(recipe, preferences, 'breakfast')).toEqual([
            'status',
            'nutrition_provenance',
            'allergen_status',
            'allergen',
            'diet',
            'dislike',
            'cooking_time',
            'slot',
        ]);
        expect(isEligibleForPlanning(recipe, preferences, 'breakfast')).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * Declared versus derived
 * ------------------------------------------------------------------------- */

describe('deriveRecipeVersionFields', () => {
    it('derives every column the seed publishes', () => {
        const derived = deriveRecipeVersionFields([makeIngredient()], 2, 10, 15);

        expect(derived.totalMinutes).toBe(25);
        expect(derived.perServing).toEqual({ calories: 50, protein: 2.5, carbs: 7.5, fat: 1 });
        expect(derived.nutrition.total.fiber).toBe(1);
        expect(derived.sourcedCaloriesNote).toBeNull();
        expect(derived.dietTags).toEqual([]);
        expect(derived.allergenTags).toEqual([]);
        expect(derived.allergenStatus).toBe('known');
        expect(derived.nutritionProvenance).toBe('source_backed');
        expect(derived.badges).toEqual(['dairy_free']);
        expect(derived.costScore).toBe(1);
        expect(derived.budgetTier).toBe(1);
    });
});

describe('validateRecipeDeclaration', () => {
    const mismatchCodes = (declaration: Partial<RecipeDeclaration>, ingredients = [makeIngredient()]) =>
        validateRecipeDeclaration(makeDeclaration(declaration), ingredients).mismatches;

    it('accepts a declaration that matches the derivation', () => {
        const verdict = validateRecipeDeclaration(makeDeclaration(), [makeIngredient()]);

        expect(verdict.valid).toBe(true);
        expect(verdict.mismatches).toEqual([]);
        expect(verdict.derived.badges).toEqual(['dairy_free']);
    });

    describe('closed sets', () => {
        it('rejects an unknown icon key', () => {
            const [mismatch] = mismatchCodes({ icon_key: 'pan' });

            expect(mismatch).toMatchObject({ field: 'icon_key', code: 'unknown_value', declared: 'pan' });
            expect(mismatch.message).toContain('icon_key "pan" is not one of');
        });

        it('rejects an empty slot list, which could never be planned', () => {
            const [mismatch] = mismatchCodes({ meal_slots: [] });

            expect(mismatch).toMatchObject({ field: 'meal_slots', code: 'empty_value' });
        });

        it('rejects an unknown slot', () => {
            const [mismatch] = mismatchCodes({ meal_slots: ['brunch'] });

            expect(mismatch).toMatchObject({ field: 'meal_slots', code: 'unknown_value', declared: 'brunch' });
        });

        it('rejects an unknown badge and still compares the known ones', () => {
            const mismatches = mismatchCodes({ badges: ['keto'] });

            expect(mismatches).toEqual([
                expect.objectContaining({ field: 'badges', code: 'unknown_value', declared: 'keto' }),
                expect.objectContaining({ field: 'badges', code: 'undeclared', derived: 'dairy_free' }),
            ]);
        });
    });

    describe('badges', () => {
        it('reports a declared badge the composition does not support, naming the blocker', () => {
            const [mismatch] = mismatchCodes({ badges: ['dairy_free', 'vegan'] });

            expect(mismatch).toMatchObject({ field: 'badges', code: 'unsupported', declared: 'vegan' });
            expect(mismatch.ingredients).toEqual(['Brown rice, cooked']);
            expect(mismatch.message).toContain('Brown rice, cooked');
        });

        it('reports a derived badge the file omitted', () => {
            const [mismatch] = mismatchCodes({ badges: [] });

            expect(mismatch).toMatchObject({ field: 'badges', code: 'undeclared', derived: 'dairy_free' });
        });

        it('names the milk-bearing ingredient behind an unsupported dairy_free claim', () => {
            const mismatches = mismatchCodes({ badges: ['dairy_free'], allergen_tags: ['milk'] }, [
                makeIngredient({ snapshot_name: 'Butter', snapshot_allergen_tags: ['milk'] }),
            ]);

            expect(mismatches).toEqual([
                expect.objectContaining({
                    field: 'badges',
                    code: 'unsupported',
                    declared: 'dairy_free',
                    ingredients: ['Butter'],
                }),
            ]);
        });

        it('names the unreviewed ingredient behind an unsupported dairy_free claim', () => {
            const mismatches = mismatchCodes({ badges: ['dairy_free'], allergen_status: 'unknown' }, [
                withoutAllergenStatus(makeIngredient({ snapshot_name: 'Mystery stock' })) as RecipePublicationIngredient,
            ]);
            const badgeMismatch = mismatches.find((mismatch) => mismatch.field === 'badges');

            expect(badgeMismatch).toMatchObject({ code: 'unsupported', declared: 'dairy_free' });
            expect(badgeMismatch?.ingredients).toEqual(['Mystery stock']);
        });

        it('names the gluten-bearing ingredient behind an unsupported gluten_free claim', () => {
            const mismatches = mismatchCodes({ badges: ['dairy_free', 'gluten_free'], allergen_tags: ['wheat'] }, [
                makeIngredient({ snapshot_name: 'Wheat flour', snapshot_allergen_tags: ['wheat'] }),
            ]);

            expect(mismatches).toEqual([
                expect.objectContaining({
                    field: 'badges',
                    code: 'unsupported',
                    declared: 'gluten_free',
                    ingredients: ['Wheat flour'],
                }),
            ]);
            expect(mismatches[0].message).toContain('Wheat flour');
        });

        it('blocks gluten_free on an ingredient whose own snapshot contradicts itself', () => {
            // A reviewed snapshot that claims the gluten_free diet tag while
            // carrying `barley` cannot be believed in the direction that makes
            // a health claim, so the allergen tag wins and the badge is refused.
            const mismatches = mismatchCodes({ badges: ['dairy_free', 'gluten_free'] }, [
                makeIngredient({
                    snapshot_name: 'Malted barley syrup',
                    snapshot_diet_tags: ['gluten_free'],
                    snapshot_allergen_tags: ['barley'],
                }),
            ]);
            const badgeMismatch = mismatches.find((mismatch) => mismatch.field === 'badges');

            expect(badgeMismatch).toMatchObject({
                code: 'unsupported',
                declared: 'gluten_free',
                ingredients: ['Malted barley syrup'],
            });
        });

        it('names nothing for a time or nutrition badge, which no ingredient causes', () => {
            const [mismatch] = mismatchCodes({ badges: ['dairy_free', 'quick'] });

            expect(mismatch).toMatchObject({ code: 'unsupported', declared: 'quick', ingredients: [] });
        });
    });

    describe('allergen tags', () => {
        it('reports an UNDECLARED allergen and names the ingredient that carries it', () => {
            const mismatches = mismatchCodes({ badges: [], allergen_tags: [] }, [
                makeIngredient({ snapshot_name: 'Whole milk', snapshot_allergen_tags: ['milk'] }),
            ]);

            expect(mismatches).toHaveLength(1);
            expect(mismatches[0]).toMatchObject({
                field: 'allergen_tags',
                code: 'undeclared',
                derived: 'milk',
                ingredients: ['Whole milk'],
            });
        });

        it('reports an allergen no ingredient carries', () => {
            const [mismatch] = mismatchCodes({ allergen_tags: ['sesame'] });

            expect(mismatch).toMatchObject({
                field: 'allergen_tags',
                code: 'unsupported',
                declared: 'sesame',
                ingredients: [],
            });
        });
    });

    describe('diet tags', () => {
        it('reports a declared diet the ingredients do not support, naming the one that lacks it', () => {
            const [mismatch] = mismatchCodes({ diet_tags: ['vegan'] });

            expect(mismatch).toMatchObject({ field: 'diet_tags', code: 'unsupported', declared: 'vegan' });
            expect(mismatch.ingredients).toEqual(['Brown rice, cooked']);
        });

        it('reports derived diet tags the file omitted', () => {
            const mismatches = mismatchCodes({ diet_tags: [] }, [
                makeIngredient({ snapshot_diet_tags: ['vegan'] }),
            ]);
            const dietMismatches = mismatches.filter((mismatch) => mismatch.field === 'diet_tags');

            expect(dietMismatches.map((mismatch) => mismatch.derived)).toEqual([
                'pescatarian',
                'vegan',
                'vegetarian',
            ]);
            expect(dietMismatches.every((mismatch) => mismatch.code === 'undeclared')).toBe(true);
        });
    });

    describe('single values', () => {
        it('reports an allergen status that disagrees, with the unreviewed ingredients', () => {
            const mismatches = mismatchCodes({ allergen_status: 'known', badges: [] }, [
                makeIngredient({ snapshot_name: 'Mystery stock', allergen_status: 'unknown' }),
            ]);
            const mismatch = mismatches.find((entry) => entry.field === 'allergen_status');

            expect(mismatch).toMatchObject({ code: 'mismatch', declared: 'known', derived: 'unknown' });
            expect(mismatch?.ingredients).toEqual(['Mystery stock']);
        });

        it('reports a provenance, total time or budget tier that disagrees', () => {
            expect(mismatchCodes({ nutrition_provenance: 'ingredient_derived' })[0]).toMatchObject({
                field: 'nutrition_provenance',
                code: 'mismatch',
                declared: 'ingredient_derived',
                derived: 'source_backed',
            });
            expect(mismatchCodes({ total_minutes: 20 })[0]).toMatchObject({
                field: 'total_minutes',
                declared: '20',
                derived: '25',
            });
            expect(mismatchCodes({ budget_tier: 3 })[0]).toMatchObject({
                field: 'budget_tier',
                declared: '3',
                derived: '1',
            });
        });

        it('compares an optional field only when the file states it', () => {
            expect(
                validateRecipeDeclaration(makeDeclaration(), [makeIngredient()]).mismatches.map(
                    (mismatch) => mismatch.field,
                ),
            ).toEqual([]);
        });
    });

    it('propagates a missing density rather than reporting it as a mismatch', () => {
        expect(() =>
            validateRecipeDeclaration(makeDeclaration(), [
                makeIngredient({ nutrition_basis: 'per_100ml', density_g_per_ml: null }),
            ]),
        ).toThrow(UnitConversionError);
    });

    it('marks the verdict invalid whenever anything disagreed', () => {
        const verdict = validateRecipeDeclaration(makeDeclaration({ total_minutes: 20 }), [makeIngredient()]);

        expect(verdict.valid).toBe(false);
        expect(verdict.derived.totalMinutes).toBe(25);
    });
});
