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

import { readFileSync } from 'fs';
import { join } from 'path';

// The closed sets come from the contract module that declares them, never from
// literals repeated here: a suite that restated the nine icon keys, five badges
// and four slots would keep passing after one of them was dropped or renamed.
import { MEAL_SLOTS, RECIPE_BADGES, RECIPE_ICON_KEYS, RecipePerServingNutrition } from '../../types/recipe';
import { UnitConversionError } from '../../utils/units';
import { CatalogMappingError } from '../catalog.mapper';
import {
    BUDGET_TIER_1_MAX_COST_SCORE,
    BUDGET_TIER_2_MAX_COST_SCORE,
    CatalogIngredientVersions,
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
    ParsedRecipeVersionPath,
    parseRecipeVersionPath,
    PlanningEligibilityCode,
    PlanningPreferences,
    PlanningRecipeVersion,
    PREFERENCE_FLAG_CODES,
    RECIPE_FIELD_CODES,
    QUICK_MAX_TOTAL_MINUTES,
    RecipeDeclaration,
    RecipeDerivationError,
    RecipeIngredientSnapshot,
    RecipePublicationIngredient,
    RecipeVersionPathRefusal,
    roundNutritionForDisplay,
    scaleIngredients,
    scalePlannedNutrition,
    SOURCED_CALORIE_DIVERGENCE_THRESHOLD,
    validateRecipeDeclaration,
} from '../recipe.logic';
import {
    mapPlannedRecipeSummary,
    mapRecipeIngredient,
    mapRecipeVersion,
    RecipeIngredientRow,
    RecipeMappingError,
    RecipeVersionRow,
} from '../recipe.mapper';

/* ---------------------------------------------------------------------------
 * The shared fixture graph
 *
 * `data/meal-planning/fixtures/catalog-foods.fixture.json` and
 * `recipes.fixture.json` are the referentially closed pair the Agent Action
 * Plan §0.3.3 commits: fixed uuid primary keys, fixed ISO-8601 timestamps, and
 * snake_case ROWS rather than camelCase wire DTOs, so a row can be handed to
 * `recipe.logic.ts` unmapped.
 *
 * Every food and recipe identity in this file is read from them, which is the
 * point: the `catalog_food_id` a rule reads here is the same identity the
 * planner, grocery and planned-log suites read, so an invariant that spans
 * recipe -> plan -> grocery -> log can be asserted at all. Before this, each
 * suite invented its own vocabulary and nothing joined them.
 *
 * Read off disk rather than transcribed — the convention
 * `evidence.logic.test.ts` uses for the committed evidence policy — so a
 * fixture correction changes what this suite asserts. Each accessor re-parses
 * the document, so a case that mutates a row cannot leak into the next.
 * ------------------------------------------------------------------------- */

const FIXTURE_DIRECTORY = join(__dirname, '..', '..', '..', 'data', 'meal-planning', 'fixtures');

const CATALOG_FOODS_JSON = readFileSync(join(FIXTURE_DIRECTORY, 'catalog-foods.fixture.json'), 'utf8');
const RECIPES_JSON = readFileSync(join(FIXTURE_DIRECTORY, 'recipes.fixture.json'), 'utf8');

/**
 * The `catalog_foods` columns this suite reads. The fixture row carries the
 * whole table plus a `note`; only what a recipe rule consults is typed, so a
 * column this suite does not depend on cannot silently become a dependency.
 */
interface FixtureCatalogFood {
    id: string;
    source_key: string;
    display_name: string;
    food_state: string;
    food_group: string;
    nutrition_version: number;
    metadata_version: number;
    publication_status: string;
    nutrition_basis: string;
    /** Read only to prove a frozen snapshot disagrees with the live row. */
    calories: number;
    density_g_per_ml: number | null;
    allergen_status: 'known' | 'unknown';
    cost_class: number;
}

/** The `recipe_versions` columns, plus the fixture's `derived_reference` block. */
interface FixtureRecipeVersion {
    id: string;
    recipe_id: string;
    recipe_slug: string;
    version: number;
    name: string;
    icon_key: string;
    yield_servings: number;
    serving_description: string;
    prep_minutes: number;
    cook_minutes: number;
    total_minutes: number;
    meal_slots: string[];
    diet_tags: string[];
    allergen_tags: string[];
    allergen_status: 'known' | 'unknown';
    budget_tier: number;
    badges: string[];
    nutrition_provenance: RecipePublicationIngredient['snapshot_provenance'];
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
    sourced_calories_note: string | null;
    status: 'current' | 'retired';
    derived_reference: {
        per_serving_fiber_g: number | null;
        cost_score: number;
        calorie_divergence: number | null;
    };
}

/**
 * A `recipe_ingredients` row. `resolved_catalog_facts` is the fixture's one
 * documented non-column field on these rows: the `catalog_foods` facts the
 * table does not snapshot but `RecipePublicationIngredient` requires.
 */
interface FixtureRecipeIngredient {
    id: string;
    recipe_version_id: string;
    food_source_key: string;
    catalog_food_id: string;
    catalog_nutrition_version: number;
    catalog_metadata_version: number;
    snapshot_per_100g: { calories: number; protein_g: number; carbs_g: number; fat_g: number; fiber_g?: number | null };
    snapshot_name: string;
    snapshot_provenance: RecipePublicationIngredient['snapshot_provenance'];
    snapshot_allergen_tags: string[];
    snapshot_diet_tags: string[];
    quantity: number;
    unit: string;
    gram_weight: number;
    display_text: string;
    sort_order: number;
    is_optional: boolean;
    resolved_catalog_facts: {
        allergen_status: 'known' | 'unknown';
        cost_class: number;
        food_group: string;
        nutrition_basis: 'per_100g' | 'per_100ml';
        density_g_per_ml: number | null;
        publication_status: string;
    };
}

interface CatalogFixtureDocument {
    counts: { foods: number; published_foods: number };
    foods: FixtureCatalogFood[];
}

/**
 * The fixture's declared-vs-derived negative case, held OUTSIDE
 * `recipe_versions` and outside `insert_order` because its columns
 * deliberately disagree with its ingredients: a loader walking the insert order
 * would otherwise persist an invalid row and change the plannable-version count
 * every planner test reads.
 *
 * `declaration` is typed as the contract shape rather than re-described, so a
 * fixture that stopped supplying a field `validateRecipeDeclaration` requires
 * fails to compile instead of failing obscurely at run time.
 */
interface FixtureDeclarationNegativeCase {
    recipe_slug: string;
    expected_valid: false;
    expected_mismatch_fields: { field: string; code: string }[];
    derived_for_reference: { diet_tags: string[]; allergen_tags: string[]; badges: string[] };
    declaration: RecipeDeclaration;
    ingredients: FixtureRecipeIngredient[];
}

interface RecipeFixtureDocument {
    counts: {
        recipes: number;
        recipe_versions: number;
        recipe_ingredients: number;
        plannable_versions: number;
        declaration_negative_cases: number;
    };
    recipes: { id: string; slug: string; current_version_id: string }[];
    recipe_versions: FixtureRecipeVersion[];
    recipe_ingredients: FixtureRecipeIngredient[];
    declaration_negative_cases: FixtureDeclarationNegativeCase[];
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

/**
 * One `recipe_ingredients` row as the publication shape: the row's own columns
 * plus the five resolved `catalog_foods` facts the fixture records beside it.
 * Nothing is invented here — every value is the fixture's.
 */
const toPublicationIngredient = (row: FixtureRecipeIngredient): RecipePublicationIngredient => ({
    catalog_food_id: row.catalog_food_id,
    snapshot_name: row.snapshot_name,
    snapshot_provenance: row.snapshot_provenance,
    snapshot_allergen_tags: row.snapshot_allergen_tags,
    snapshot_diet_tags: row.snapshot_diet_tags,
    is_optional: row.is_optional,
    food_group: row.resolved_catalog_facts.food_group,
    allergen_status: row.resolved_catalog_facts.allergen_status,
    catalog_nutrition_version: row.catalog_nutrition_version,
    catalog_metadata_version: row.catalog_metadata_version,
    snapshot_per_100g: row.snapshot_per_100g,
    quantity: row.quantity,
    unit: row.unit,
    gram_weight: row.gram_weight,
    display_text: row.display_text,
    sort_order: row.sort_order,
    nutrition_basis: row.resolved_catalog_facts.nutrition_basis,
    density_g_per_ml: row.resolved_catalog_facts.density_g_per_ml,
    cost_class: row.resolved_catalog_facts.cost_class,
});

/** Every ingredient of one fixture version, in the fixture's own row order. */
const publicationIngredients = (slug: string, version: number): RecipePublicationIngredient[] => {
    const versionId = recipeVersionRow(slug, version).id;
    const rows = readRecipeFixture().recipe_ingredients.filter((row) => row.recipe_version_id === versionId);
    if (rows.length === 0) {
        throw new Error(`recipes.fixture.json carries no ingredients for ${slug} v${version}`);
    }

    return rows.map(toPublicationIngredient);
};

/** The one committed declared-vs-derived negative case, or a failure saying it is gone. */
const declarationNegativeCase = (): FixtureDeclarationNegativeCase => {
    const fixture = readRecipeFixture();
    const [negativeCase] = fixture.declaration_negative_cases;

    if (!negativeCase) {
        throw new Error('recipes.fixture.json carries no declaration_negative_cases entry');
    }

    expect(fixture.declaration_negative_cases).toHaveLength(fixture.counts.declaration_negative_cases);

    return negativeCase;
};

/** One named ingredient of one fixture version, by the food's stable source key. */
const publicationIngredient = (
    slug: string,
    version: number,
    foodSourceKey: string,
): RecipePublicationIngredient => {
    const versionId = recipeVersionRow(slug, version).id;
    const row = readRecipeFixture().recipe_ingredients.find(
        (candidate) => candidate.recipe_version_id === versionId && candidate.food_source_key === foodSourceKey,
    );
    if (!row) {
        throw new Error(`${slug} v${version} has no ingredient for ${foodSourceKey}`);
    }

    return toPublicationIngredient(row);
};

/* ---------------------------------------------------------------------------
 * Factories — a reviewed, source-backed, untagged 100 g ingredient whose
 * numbers are round and whose 4/4/9 estimate (98 kcal) sits inside the 5 %
 * disclosure threshold, so the baseline carries no note and earns only the
 * badge its composition genuinely supports (`dairy_free`).
 *
 * Its IDENTITY is the fixture's — cooked brown rice, `usda:9200104`, as
 * `soy-glazed-chicken-and-rice-bowl` v1 carries it — so every probe below runs
 * against a food the catalog fixture really publishes, and the id it reports in
 * an error or a mismatch is one the other three domain suites resolve too.
 * ------------------------------------------------------------------------- */

const COOKED_BROWN_RICE = publicationIngredient('soy-glazed-chicken-and-rice-bowl', 1, 'usda:9200104');

/**
 * The three foods the focused probes need to tell apart, all fixture rows. The
 * ordering probes below turn on their ids sorting A < B < C, which the fixture's
 * counter-encoded uuids give: `…0004` (cooked brown rice) < `…000b` (spinach) <
 * `…000c` (kale).
 */
const FOOD_A = COOKED_BROWN_RICE.catalog_food_id;
const FOOD_B = catalogFood('usda:9200111').id;
const FOOD_C = catalogFood('usda:9200112').id;

/**
 * What the baseline overrides on that row, and why each is a deliberate local
 * override rather than fixture drift:
 *
 *  - `snapshot_per_100g` and the quantity trio: 100 g of a 100 kcal /
 *    5 / 15 / 2 / 1 food, so each arithmetic probe reads as the boundary it was
 *    written to pin instead of as a rounding accident. Whether the fixture's
 *    real numbers reproduce is asserted separately, for every committed
 *    version, under "the committed recipe graph" at the end of this file.
 *  - `snapshot_diet_tags`: emptied. The diet-intersection and badge probes need
 *    a baseline that earns no diet tag; the fixture row carries the four tags
 *    cooked brown rice genuinely has, and the fixture-derived section asserts
 *    those.
 *  - `food_group`: dropped, because `recipe_ingredients` does not snapshot it —
 *    the planner's service resolves it — and one dislike probe asserts exactly
 *    the unresolved case.
 */
const { food_group: _unresolvedGroup, ...COOKED_BROWN_RICE_IDENTITY } = COOKED_BROWN_RICE;

const makeIngredient = (overrides: Partial<RecipePublicationIngredient> = {}): RecipePublicationIngredient => ({
    ...COOKED_BROWN_RICE_IDENTITY,
    snapshot_diet_tags: [],
    snapshot_per_100g: { calories: 100, protein_g: 5, carbs_g: 15, fat_g: 2, fiber_g: 1 },
    quantity: 1,
    unit: 'cup',
    gram_weight: 100,
    display_text: '1 cup',
    sort_order: 0,
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

/*
 * The three families are CLOSED WIRE CONTRACTS and this module is their only
 * runtime enforcement point: the columns are plain TEXT and the mobile codecs
 * decode them leniently (an unknown iconKey falls back to a glyph, an unknown
 * badge is dropped). Sampling a few members would let a dropped or misspelled
 * value pass here and surface as a wrong glyph or a silently missing badge, so
 * each family is pinned member by member against the authoritative array, and
 * the array itself is pinned against the literal contract.
 */
const NON_STRING_VALUES: readonly unknown[] = [undefined, null, 7, true, {}, [], () => 'bowl'];

/** Prototype members that would pass a `value in object` style membership test. */
const INHERITED_KEYS: readonly string[] = ['constructor', '__proto__', 'toString', 'hasOwnProperty'];

describe('closed-set guards', () => {
    describe('isRecipeIconKey', () => {
        it('pins the nine icon keys, so dropping or renaming one fails here', () => {
            expect([...RECIPE_ICON_KEYS]).toEqual([
                'crosshair',
                'fork_knife',
                'bowl',
                'wrap',
                'dome',
                'salad',
                'bowl_dash',
                'pot',
                'cloche',
            ]);
            expect(new Set(RECIPE_ICON_KEYS).size).toBe(RECIPE_ICON_KEYS.length);
        });

        it.each([...RECIPE_ICON_KEYS])('accepts the declared key %s', (key) => {
            expect(isRecipeIconKey(key)).toBe(true);
        });

        it.each([
            'pan',
            'Bowl',
            'BOWL',
            'bowl_dashed',
            'bowl-dash',
            'forkknife',
            'fork-knife',
            'clochee',
            'cloch',
            ' bowl',
            'bowl ',
            '',
        ])('rejects the near miss %p so the seed fails instead of shipping the wrong glyph', (key) => {
            expect(isRecipeIconKey(key)).toBe(false);
        });

        it.each([...MEAL_SLOTS, ...RECIPE_BADGES])('rejects %s, which belongs to another family', (value) => {
            expect(isRecipeIconKey(value)).toBe(false);
        });

        it.each([...NON_STRING_VALUES, ...INHERITED_KEYS])('rejects the non-member %p', (value) => {
            expect(isRecipeIconKey(value)).toBe(false);
        });
    });

    describe('isMealSlot', () => {
        it('pins the four slots in schedule order', () => {
            expect([...MEAL_SLOTS]).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
            expect(new Set(MEAL_SLOTS).size).toBe(MEAL_SLOTS.length);
        });

        it.each([...MEAL_SLOTS])('accepts the declared slot %s', (slot) => {
            expect(isMealSlot(slot)).toBe(true);
        });

        it.each([
            'brunch',
            'Snack',
            'SNACK',
            'snacks',
            'breakfasts',
            'break fast',
            'break_fast',
            ' lunch',
            'lunch ',
            '',
        ])('rejects the near miss %p', (slot) => {
            expect(isMealSlot(slot)).toBe(false);
        });

        it.each([...RECIPE_ICON_KEYS, ...RECIPE_BADGES])('rejects %s, which belongs to another family', (value) => {
            expect(isMealSlot(value)).toBe(false);
        });

        it.each([...NON_STRING_VALUES, ...INHERITED_KEYS])('rejects the non-member %p', (value) => {
            expect(isMealSlot(value)).toBe(false);
        });
    });

    describe('isRecipeBadge', () => {
        it('pins the five badge codes in the order the badges are rendered', () => {
            expect([...RECIPE_BADGES]).toEqual(['high_protein', 'gluten_free', 'dairy_free', 'vegan', 'quick']);
            expect(new Set(RECIPE_BADGES).size).toBe(RECIPE_BADGES.length);
        });

        it.each([...RECIPE_BADGES])('accepts the declared code %s', (badge) => {
            expect(isRecipeBadge(badge)).toBe(true);
        });

        it.each([
            'keto',
            'Quick',
            'QUICK',
            'high protein',
            'high-protein',
            'highprotein',
            'highProtein',
            'glutenfree',
            'gluten-free',
            'dairyfree',
            'vegetarian',
            'pescatarian',
            ' vegan',
            'vegan ',
            '',
        ])('rejects the near miss %p, which the mobile converter would silently drop', (badge) => {
            expect(isRecipeBadge(badge)).toBe(false);
        });

        it.each([...RECIPE_ICON_KEYS, ...MEAL_SLOTS])('rejects %s, which belongs to another family', (value) => {
            expect(isRecipeBadge(value)).toBe(false);
        });

        it.each([...NON_STRING_VALUES, ...INHERITED_KEYS])('rejects the non-member %p', (value) => {
            expect(isRecipeBadge(value)).toBe(false);
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

    it('is stale when both counters moved', () => {
        expect(
            isIngredientSnapshotStale(snapshot, { catalog_nutrition_version: 4, catalog_metadata_version: 6 }),
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
            name: 'Brown rice',
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

    it('scales inversely with the yield: the same dish divided eight ways is an eighth of a serving', () => {
        const ingredients = [
            makeIngredient({ gram_weight: 240 }),
            makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, gram_weight: 160 }),
        ];

        const whole = deriveRecipeNutrition(ingredients, 1);
        const eight = deriveRecipeNutrition(ingredients, 8);

        // The whole-recipe totals are a property of the ingredients alone, so
        // only the divisor moves — which is what makes yield an editorial
        // decision about portioning rather than a change to the dish.
        expect(eight.total).toEqual(whole.total);
        expect(eight.perServing.calories).toBeCloseTo(whole.perServing.calories / 8, 9);
        expect(eight.perServing.protein).toBeCloseTo(whole.perServing.protein / 8, 9);
        expect(eight.perServing.carbs).toBeCloseTo(whole.perServing.carbs / 8, 9);
        expect(eight.perServing.fat).toBeCloseTo(whole.perServing.fat / 8, 9);
        expect(eight.perServingFiber).toBeCloseTo((whole.perServingFiber as number) / 8, 9);
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

    it('reads an absent nutrition_basis as per_100g, the basis a published food states', () => {
        const { nutrition_basis: _absentBasis, ...withoutBasis } = makeIngredient({ gram_weight: 250 });

        expect(deriveRecipeNutrition([withoutBasis], 1).total).toEqual(
            deriveRecipeNutrition([makeIngredient({ gram_weight: 250, nutrition_basis: 'per_100g' })], 1).total,
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
            expect(error.ingredient).toBe('Brown rice');
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

    /*
     * The hierarchy has to be applied to EACH ingredient before the sets are
     * intersected. Closing only the survivors of a raw intersection loses a
     * claim every ingredient satisfies, which excluded valid recipes and could
     * make a guaranteed diet profile report no matching meals.
     */
    describe('mixed ingredients across the hierarchy', () => {
        const rice = makeIngredient({ snapshot_name: 'Brown rice, cooked', snapshot_diet_tags: ['vegan'] });
        const halloumi = makeIngredient({
            catalog_food_id: FOOD_B,
            sort_order: 1,
            snapshot_name: 'Halloumi',
            snapshot_diet_tags: ['vegetarian'],
        });
        const salmon = makeIngredient({
            catalog_food_id: FOOD_C,
            sort_order: 2,
            snapshot_name: 'Salmon fillet',
            snapshot_diet_tags: ['pescatarian'],
        });

        it('keeps vegetarian and pescatarian for a vegan ingredient beside a vegetarian one', () => {
            const tags = deriveDietTags([rice, halloumi]);

            expect(tags).toEqual(['pescatarian', 'vegetarian']);
            expect(tags).not.toContain('vegan');
        });

        it('keeps pescatarian for a vegan ingredient beside a pescatarian-only fish', () => {
            expect(deriveDietTags([rice, salmon])).toEqual(['pescatarian']);
        });

        it('keeps pescatarian for a vegetarian ingredient beside a pescatarian-only fish', () => {
            expect(deriveDietTags([halloumi, salmon])).toEqual(['pescatarian']);
        });

        it('narrows to the weakest claim across all three', () => {
            expect(deriveDietTags([rice, halloumi, salmon])).toEqual(['pescatarian']);
        });

        it('does not depend on the order the ingredient rows arrived in', () => {
            expect(deriveDietTags([halloumi, rice])).toEqual(deriveDietTags([rice, halloumi]));
            expect(deriveDietTags([salmon, rice, halloumi])).toEqual(deriveDietTags([rice, halloumi, salmon]));
        });

        it('expands through spelling variants too', () => {
            const tags = deriveDietTags([
                makeIngredient({ snapshot_diet_tags: ['Vegan'] }),
                makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, snapshot_diet_tags: ['Vegetarian'] }),
            ]);

            expect(isDietCompatible('vegetarian', tags)).toBe(true);
            expect(isDietCompatible('pescatarian', tags)).toBe(true);
            expect(isDietCompatible('vegan', tags)).toBe(false);
        });

        it('implies nothing for a tag outside the hierarchy', () => {
            const tags = deriveDietTags([
                makeIngredient({ snapshot_diet_tags: ['vegan', 'gluten_free'] }),
                halloumi,
            ]);

            expect(tags).toEqual(['pescatarian', 'vegetarian']);
            expect(tags).not.toContain('gluten_free');
        });

        it('still drops every claim when one ingredient carries none', () => {
            expect(deriveDietTags([rice, halloumi, makeIngredient({ catalog_food_id: FOOD_C, sort_order: 3 })])).toEqual(
                [],
            );
        });
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

        it('is earned just above 30 %', () => {
            expect(deriveBadges([makeIngredient()], context(400, 30.1))).toContain('high_protein');
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
                name: 'Brown rice',
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

    it('scales an optional ingredient exactly like a required one, and says which it is', () => {
        const [required, optional] = scaleIngredients(
            [
                makeIngredient({ quantity: 2, gram_weight: 200 }),
                makeIngredient({
                    catalog_food_id: FOOD_B,
                    snapshot_name: 'Greek yogurt, plain',
                    sort_order: 1,
                    is_optional: true,
                    quantity: 2,
                    gram_weight: 200,
                }),
            ],
            1,
            2,
        );

        // Optional describes whether the cook may leave it out, never how much
        // of it a portion is: a row scaled differently would put a different
        // amount on the recipe card than the grocery list shopped for.
        expect(optional.quantity).toBe(required.quantity);
        expect(optional.gramWeight).toBe(required.gramWeight);
        expect(optional.displayText).toBe(required.displayText);
        expect(optional.isOptional).toBe(true);
        expect(required.isOptional).toBe(false);
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

        it('refuses an ingredient carrying NO review, whatever the recipe rollup claims, and names it', () => {
            // The rollup says `known` and the ingredient says nothing at all.
            // A summary cannot vouch for evidence nobody supplied, so the
            // absence is a refusal — never a fallback to the rollup.
            const recipe = makeRecipe({ ingredients: [withoutAllergenStatus(makeIngredient())] });

            expect(codesOf(recipe, makePreferences())).toEqual(['allergen_status']);
            expect(reasonFor(recipe, makePreferences(), 'allergen_status')?.detail).toEqual(['Brown rice']);
            expect(isEligibleForPlanning(recipe, makePreferences(), 'lunch')).toBe(false);
        });

        it('refuses an OPTIONAL ingredient carrying no review — optional is still on the plate', () => {
            const recipe = makeRecipe({
                ingredients: [
                    makeIngredient(),
                    withoutAllergenStatus(
                        makeIngredient({
                            catalog_food_id: FOOD_B,
                            sort_order: 1,
                            is_optional: true,
                            snapshot_name: 'Garnish, unreviewed',
                        }),
                    ),
                ],
            });

            expect(reasonFor(recipe, makePreferences(), 'allergen_status')?.detail).toEqual(['Garnish, unreviewed']);
        });

        it('names every unreviewed ingredient, whether it said unknown or said nothing', () => {
            const recipe = makeRecipe({
                ingredients: [
                    makeIngredient(),
                    makeIngredient({
                        catalog_food_id: FOOD_B,
                        sort_order: 1,
                        snapshot_name: 'Mystery stock',
                        allergen_status: 'unknown',
                    }),
                    withoutAllergenStatus(
                        makeIngredient({ catalog_food_id: FOOD_C, sort_order: 2, snapshot_name: 'Unlabelled paste' }),
                    ),
                ],
            });

            expect(reasonFor(recipe, makePreferences(), 'allergen_status')?.detail).toEqual([
                'Mystery stock',
                'Unlabelled paste',
            ]);
        });

        it('refuses an empty ingredient set, where nothing has been reviewed at all', () => {
            const recipe = makeRecipe({ ingredients: [] });

            expect(codesOf(recipe, makePreferences())).toEqual(['allergen_status']);
            expect(reasonFor(recipe, makePreferences(), 'allergen_status')?.detail).toEqual(['known']);
        });

        it('admits a recipe only when EVERY ingredient states known explicitly', () => {
            const recipe = makeRecipe({
                ingredients: [
                    makeIngredient(),
                    makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, is_optional: true }),
                    makeIngredient({ catalog_food_id: FOOD_C, sort_order: 2 }),
                ],
            });

            expect(codesOf(recipe, makePreferences(), 'lunch')).toEqual([]);
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

        it('admits a MIXED vegan-and-vegetarian recipe for a vegetarian and a pescatarian', () => {
            // Both ingredients are vegetarian — the rice by implication, the
            // halloumi by declaration — so refusing this recipe would exclude a
            // valid meal from a vegetarian's week.
            const mixed = makeRecipe({
                ingredients: [
                    makeIngredient({ snapshot_diet_tags: ['vegan'] }),
                    makeIngredient({
                        catalog_food_id: FOOD_B,
                        sort_order: 1,
                        snapshot_name: 'Halloumi',
                        snapshot_diet_tags: ['vegetarian'],
                    }),
                ],
            });

            expect(codesOf(mixed, makePreferences({ diet: 'vegetarian' }))).toEqual([]);
            expect(codesOf(mixed, makePreferences({ diet: 'pescatarian' }))).toEqual([]);
            expect(codesOf(mixed, makePreferences({ diet: 'vegan' }))).toEqual(['diet']);
        });

        it('admits a vegan-and-fish recipe for a pescatarian only', () => {
            const withFish = makeRecipe({
                ingredients: [
                    makeIngredient({ snapshot_diet_tags: ['vegan'] }),
                    makeIngredient({
                        catalog_food_id: FOOD_B,
                        sort_order: 1,
                        snapshot_name: 'Salmon fillet',
                        snapshot_diet_tags: ['pescatarian'],
                    }),
                ],
            });

            expect(codesOf(withFish, makePreferences({ diet: 'pescatarian' }))).toEqual([]);
            expect(codesOf(withFish, makePreferences({ diet: 'vegetarian' }))).toEqual(['diet']);
            expect(codesOf(withFish, makePreferences({ diet: 'vegan' }))).toEqual(['diet']);
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
            ).toEqual(['Brown rice']);
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

        // The four limits the setup screen offers, each asserted at the limit
        // and one minute past it. A single boundary would leave `<=` and `<`
        // indistinguishable at the other three, and a user who answered "15
        // min" is the one an off-by-one hands a 16-minute recipe to.
        it.each([15, 30, 45, 60])('admits exactly %i minutes and refuses one more', (limit) => {
            expect(codesOf(makeRecipe({ total_minutes: limit }), makePreferences({ cooking_time_limit_min: limit }))).toEqual(
                [],
            );
            expect(
                codesOf(makeRecipe({ total_minutes: limit + 1 }), makePreferences({ cooking_time_limit_min: limit })),
            ).toEqual(['cooking_time']);
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
 * Request parsing
 *
 * `GET /recipes/:recipeVersionId` puts its path segment straight into a
 * PostgreSQL `uuid` predicate, so a malformed one would become a Prisma
 * failure and a generic 500 where the contract promises a 400 naming the
 * field. The parser decides only whether the value COULD denote a version;
 * whether one exists, and whether this caller may read it, stays the service's
 * 404.
 * ------------------------------------------------------------------------- */

describe('parseRecipeVersionPath', () => {
    const RECIPE_VERSION_ID = '9d2c5b3a-7e41-4f6b-8c1d-0a2b3c4d5e6f';

    /** The single detail of a refusal, or a failure that says it was accepted. */
    const refusal = (parsed: ParsedRecipeVersionPath) => {
        if (parsed.kind !== 'error') {
            throw new Error('expected the parser to reject this path');
        }

        return parsed;
    };

    it('accepts a v4 UUID and returns it unchanged', () => {
        expect(parseRecipeVersionPath({ recipeVersionId: RECIPE_VERSION_ID })).toEqual({
            kind: 'ok',
            recipeVersionId: RECIPE_VERSION_ID,
        });
    });

    it('accepts an upper-case UUID unchanged, because the column comparison is not case sensitive', () => {
        expect(parseRecipeVersionPath({ recipeVersionId: RECIPE_VERSION_ID.toUpperCase() })).toEqual({
            kind: 'ok',
            recipeVersionId: RECIPE_VERSION_ID.toUpperCase(),
        });
    });

    it.each([
        ['a malformed id', 'recipe-1'],
        // A v1 UUID: right shape, wrong version nibble.
        ['a v1 UUID', '9d2c5b3a-7e41-1f6b-8c1d-0a2b3c4d5e6f'],
        // The v4 nibble is right but the variant nibble is not.
        ['a wrong variant', '9d2c5b3a-7e41-4f6b-2c1d-0a2b3c4d5e6f'],
        ['a truncated id', '9d2c5b3a-7e41-4f6b-8c1d-0a2b3c4d5e'],
        ['a braced id', '{9d2c5b3a-7e41-4f6b-8c1d-0a2b3c4d5e6f}'],
        ['an unhyphenated id', '9d2c5b3a7e414f6b8c1d0a2b3c4d5e6f'],
        ['an empty segment', ''],
        ['a whitespace segment', ' '],
        ['an absent segment', undefined],
        ['an explicit null', null],
        ['a number', 42],
        ['an object', { recipeVersionId: '9d2c5b3a-7e41-4f6b-8c1d-0a2b3c4d5e6f' }],
        ['an array', ['9d2c5b3a-7e41-4f6b-8c1d-0a2b3c4d5e6f']],
    ])('refuses %s', (_label, recipeVersionId) => {
        expect(parseRecipeVersionPath({ recipeVersionId })).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: expect.stringContaining('recipeVersionId'),
            details: [{ field: 'recipeVersionId', code: RECIPE_FIELD_CODES.INVALID_ID }],
        });
    });

    it('names the field and its code in the diagnostic message', () => {
        const parsed = refusal(parseRecipeVersionPath({ recipeVersionId: 'recipe-1' }));

        expect(parsed.message).toContain('recipeVersionId');
        expect(parsed.message).toContain(RECIPE_FIELD_CODES.INVALID_ID);
    });

    it('speaks the layer\u2019s one code vocabulary', () => {
        expect(RECIPE_FIELD_CODES.INVALID_ID).toBe('invalid_id');
    });

    it('returns its verdict rather than throwing, for every input', () => {
        for (const recipeVersionId of [RECIPE_VERSION_ID, 'recipe-1', undefined, null, 42]) {
            expect(() => parseRecipeVersionPath({ recipeVersionId })).not.toThrow();
        }
    });

    it('exports its refusal branch as a type a caller can declare', () => {
        // `recipe.service.ts::getRecipeVersionForUser` returns this branch
        // verbatim beside its own ok shape, so the alias has to remain both
        // exported and assignable from a real refusal — a narrowing that stops
        // compiling, or an alias quietly dropped, is what would push that
        // service back to re-declaring the verdict shape by hand.
        const refused: RecipeVersionPathRefusal = refusal(
            parseRecipeVersionPath({ recipeVersionId: 'recipe-1' }),
        );

        expect(refused.kind).toBe('error');
        expect(refused.code).toBe('invalid_request');
        expect(refused.details).toEqual([
            { field: 'recipeVersionId', code: RECIPE_FIELD_CODES.INVALID_ID },
        ]);
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
            expect(mismatch.ingredients).toEqual(['Brown rice']);
            expect(mismatch.message).toContain('Brown rice');
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
            expect(mismatch.ingredients).toEqual(['Brown rice']);
        });

        it('names only the ingredient that genuinely lacks the claim, hierarchy included', () => {
            // The vegan-tagged rice IS vegetarian by implication, so the
            // blocker list must name the untagged stock alone — the same
            // hierarchy the derivation applies, or the verdict and its
            // explanation would contradict each other.
            const mismatches = mismatchCodes({ diet_tags: ['vegetarian'] }, [
                makeIngredient({ snapshot_diet_tags: ['vegan'] }),
                makeIngredient({ catalog_food_id: FOOD_B, sort_order: 1, snapshot_name: 'Mystery stock' }),
            ]);
            const mismatch = mismatches.find(
                (entry) => entry.field === 'diet_tags' && entry.declared === 'vegetarian',
            );

            expect(mismatch).toMatchObject({ code: 'unsupported' });
            expect(mismatch?.ingredients).toEqual(['Mystery stock']);
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

    /**
     * The fixture's committed negative case, read off disk rather than
     * transcribed, so a correction to it changes what this suite asserts.
     *
     * Its declaration fails in the DANGEROUS direction: it claims
     * `allergen_tags: []` and the `dairy_free` and `vegan` badges while a cup of
     * whole milk is in the dish. A seed that trusted the file would offer a
     * milk-bearing dinner to a milk-allergic user, which is the whole reason
     * `recipes-seed.ts` derives these columns and only ever compares the file
     * against the derivation.
     */
    describe('the committed negative case', () => {
        const negativeCase = () => {
            const fixtureCase = declarationNegativeCase();

            return {
                fixtureCase,
                verdict: validateRecipeDeclaration(
                    fixtureCase.declaration,
                    fixtureCase.ingredients.map(toPublicationIngredient),
                ),
            };
        };

        it('refuses the declaration on exactly the fields and codes the fixture records', () => {
            const { fixtureCase, verdict } = negativeCase();

            expect(verdict.valid).toBe(fixtureCase.expected_valid);
            expect(verdict.mismatches.map((mismatch) => ({ field: mismatch.field, code: mismatch.code }))).toEqual(
                fixtureCase.expected_mismatch_fields,
            );
        });

        it('returns the DERIVED tags and badges, never the declared ones', () => {
            const { fixtureCase, verdict } = negativeCase();

            // The derivation is the source of truth: the verdict hands the seed
            // what the ingredients actually support, and the declaration is
            // only ever the thing compared against it.
            expect(verdict.derived.allergenTags).toEqual(fixtureCase.derived_for_reference.allergen_tags);
            expect(verdict.derived.dietTags).toEqual(fixtureCase.derived_for_reference.diet_tags);
            expect(verdict.derived.badges).toEqual(fixtureCase.derived_for_reference.badges);
        });

        it('names the milk the file omitted and the badges it cannot support', () => {
            const { verdict } = negativeCase();
            const understatedAllergen = verdict.mismatches.find((mismatch) => mismatch.field === 'allergen_tags');
            const overstatedBadges = verdict.mismatches.filter(
                (mismatch) => mismatch.field === 'badges' && mismatch.code === 'unsupported',
            );

            expect(understatedAllergen).toMatchObject({ code: 'undeclared', derived: 'milk' });
            expect(understatedAllergen?.ingredients).toEqual(['Whole milk']);
            expect(overstatedBadges.map((mismatch) => mismatch.declared)).toEqual(['dairy_free', 'vegan']);
            for (const mismatch of overstatedBadges) {
                expect(mismatch.ingredients).toEqual(['Whole milk']);
            }
        });

        it('stays outside recipe_versions, so no loader can persist it', () => {
            const { fixtureCase } = negativeCase();

            // The invalid row lives beside the graph rather than in it: a
            // loader walking `insert_order` would otherwise persist a recipe
            // whose columns understate an allergen, and would change the
            // plannable-version count every planner test reads.
            expect(readRecipeFixture().recipe_versions.map((version) => version.recipe_slug)).not.toContain(
                fixtureCase.recipe_slug,
            );
            expect(readRecipeFixture().recipe_ingredients).not.toContainEqual(
                expect.objectContaining({ recipe_version_id: fixtureCase.ingredients[0].recipe_version_id }),
            );
        });
    });
});

/* ---------------------------------------------------------------------------
 * The committed recipe graph
 *
 * Everything above pins one rule at a time with a focused fixture. This section
 * runs the same rules over the WHOLE committed graph — every `recipe_versions`
 * row and every `recipe_ingredients` row the fixture holds, which at the time
 * of writing is twelve versions and fifty-one ingredient rows — and that is a
 * different kind of test: the fixture states what each version's columns are,
 * and these assertions require the derivation to reproduce them from the
 * ingredient rows alone. The counts are never asserted from this prose: the
 * first case below reads them from the fixture's own `counts` block, so a
 * corpus that grows moves the numbers here out of date without ever letting an
 * assertion pass against the wrong number of rows.
 *
 * That is the invariant a per-rule probe cannot reach, because a probe supplies
 * its own inputs and its own answer. Here the fixture supplies both, the rows
 * are shared with the planner, grocery and planned-log suites, and a derivation
 * that drifted would have to drift in agreement with a document nothing else in
 * the build can edit.
 * ------------------------------------------------------------------------- */

/** Every committed version, as the `(slug, version)` pair the accessors take. */
const COMMITTED_VERSIONS: [string, number][] = readRecipeFixture().recipe_versions.map((version) => [
    version.recipe_slug,
    version.version,
]);

/** The declared columns of one version, as `validateRecipeDeclaration` reads them. */
const declarationOf = (version: FixtureRecipeVersion): RecipeDeclaration => ({
    icon_key: version.icon_key,
    meal_slots: version.meal_slots,
    badges: version.badges,
    diet_tags: version.diet_tags,
    allergen_tags: version.allergen_tags,
    prep_minutes: version.prep_minutes,
    cook_minutes: version.cook_minutes,
    yield_servings: version.yield_servings,
    total_minutes: version.total_minutes,
    allergen_status: version.allergen_status,
    nutrition_provenance: version.nutrition_provenance,
    budget_tier: version.budget_tier,
});

/** One version as the planning shape, with its own ingredient rows. */
const planningVersionOf = (version: FixtureRecipeVersion): PlanningRecipeVersion => ({
    status: version.status,
    nutrition_provenance: version.nutrition_provenance,
    allergen_status: version.allergen_status,
    total_minutes: version.total_minutes,
    meal_slots: version.meal_slots,
    ingredients: publicationIngredients(version.recipe_slug, version.version),
});

describe('the committed recipe graph', () => {
    it('is closed: every ingredient resolves to a catalog food, by id and by source key', () => {
        const foodsBySourceKey = new Map(readCatalogFixture().foods.map((food) => [food.source_key, food]));
        const recipeFixture = readRecipeFixture();

        expect(recipeFixture.recipe_ingredients).toHaveLength(recipeFixture.counts.recipe_ingredients);
        expect(recipeFixture.recipe_versions).toHaveLength(recipeFixture.counts.recipe_versions);

        for (const row of recipeFixture.recipe_ingredients) {
            const food = foodsBySourceKey.get(row.food_source_key);

            // Both directions: the source key the seed resolves must name a
            // committed food, and the id it cached must be that food's id. A
            // fixture where the two disagree would let a "closed" graph point a
            // recipe at one food and a grocery row at another.
            expect(food).toBeDefined();
            expect(row.catalog_food_id).toBe(food?.id);
        }
    });

    it('holds exactly one current version per recipe, with the retired one still readable', () => {
        const { recipes, recipe_versions: versions } = readRecipeFixture();

        for (const recipe of recipes) {
            const own = versions.filter((version) => version.recipe_id === recipe.id);
            const current = own.filter((version) => version.status === 'current');

            expect(current).toHaveLength(1);
            expect(recipe.current_version_id).toBe(current[0].id);
        }

        const retired = versions.filter((version) => version.status === 'retired');

        expect(retired.map((version) => `${version.recipe_slug}:${version.version}`)).toEqual([
            'lemon-herb-chicken-and-rice:1',
        ]);
        expect(publicationIngredients('lemon-herb-chicken-and-rice', 1)).not.toHaveLength(0);
    });

    describe.each(COMMITTED_VERSIONS)('%s v%i', (slug, versionNumber) => {
        const version = recipeVersionRow(slug, versionNumber);
        const ingredients = publicationIngredients(slug, versionNumber);

        it('reproduces its four stored per-serving macros from the ingredient rows', () => {
            const derived = deriveRecipeNutrition(ingredients, version.yield_servings);

            expect(derived.perServing.calories).toBeCloseTo(version.per_serving_calories, 9);
            expect(derived.perServing.protein).toBeCloseTo(version.per_serving_protein_g, 9);
            expect(derived.perServing.carbs).toBeCloseTo(version.per_serving_carbs_g, 9);
            expect(derived.perServing.fat).toBeCloseTo(version.per_serving_fat_g, 9);
        });

        it('reproduces its recorded fibre, divergence and disclosure note', () => {
            const derived = deriveRecipeNutrition(ingredients, version.yield_servings);
            const { per_serving_fiber_g: fiber, calorie_divergence: divergence } = version.derived_reference;

            if (fiber === null) {
                expect(derived.perServingFiber).toBeNull();
            } else {
                expect(derived.perServingFiber).toBeCloseTo(fiber, 9);
            }

            if (divergence === null) {
                expect(derived.calorieDivergence).toBeNull();
            } else {
                expect(derived.calorieDivergence).toBeCloseTo(divergence, 9);
            }

            expect(derived.sourcedCaloriesNote).toBe(version.sourced_calories_note);
        });

        it('reproduces its recorded cost score and the tier cut from it', () => {
            const costScore = deriveCostScore(ingredients);

            expect(costScore).toBeCloseTo(version.derived_reference.cost_score, 9);
            expect(deriveBudgetTier(costScore)).toBe(version.budget_tier);
        });

        it('declares nothing its composition does not support', () => {
            const verdict = validateRecipeDeclaration(declarationOf(version), ingredients);

            expect(verdict.mismatches).toEqual([]);
            expect(verdict.valid).toBe(true);
        });

        it('derives the tag, status, provenance and badge columns it stores', () => {
            const derived = deriveRecipeVersionFields(
                ingredients,
                version.yield_servings,
                version.prep_minutes,
                version.cook_minutes,
            );

            expect(derived.totalMinutes).toBe(version.total_minutes);
            expect(derived.dietTags).toEqual(version.diet_tags);
            expect(derived.allergenTags).toEqual(version.allergen_tags);
            expect(derived.allergenStatus).toBe(version.allergen_status);
            expect(derived.nutritionProvenance).toBe(version.nutrition_provenance);
            expect(derived.badges).toEqual(version.badges);
        });
    });

    describe('planning eligibility across the graph', () => {
        /**
         * The fixture is built so that exactly three current versions fail one
         * planning fact each and the retired one fails `status`. Stated as a
         * table rather than derived from the rows, so a version that quietly
         * became plannable — or stopped being — fails here.
         */
        const EXPECTED_REFUSALS: [string, number, PlanningEligibilityCode[]][] = [
            ['lemon-herb-chicken-and-rice', 1, ['status']],
            ['lemon-herb-chicken-and-rice', 2, []],
            ['spinach-egg-white-scramble', 1, []],
            ['lentil-and-kale-stew', 1, []],
            ['soy-glazed-chicken-and-rice-bowl', 1, []],
            ['herbed-yogurt-and-kale-dip-plate', 1, []],
            ['roasted-carrot-and-lentil-salad', 1, ['nutrition_provenance']],
            ['lemon-dressed-spinach-salad', 1, ['nutrition_provenance']],
            ['cracker-and-yogurt-snack-plate', 1, ['allergen_status']],
            ['salmon-and-kale-plate', 1, []],
            ['herb-chicken-rice-and-kale-bowl', 1, []],
            ['yogurt-egg-white-crispbread-plate', 1, []],
        ];

        it.each(EXPECTED_REFUSALS)('%s v%i refuses on exactly %j for an unrestricted user', (slug, versionNumber, codes) => {
            const verdict = evaluatePlanningEligibility(
                planningVersionOf(recipeVersionRow(slug, versionNumber)),
                makePreferences(),
                null,
            );

            expect(verdict.reasons.map((reason) => reason.code)).toEqual(codes);
            expect(verdict.eligible).toBe(codes.length === 0);
        });

        it('leaves eight of the twelve versions plannable, which is what the fixture records', () => {
            const plannable = COMMITTED_VERSIONS.filter(([slug, versionNumber]) =>
                isEligibleForPlanning(planningVersionOf(recipeVersionRow(slug, versionNumber)), makePreferences()),
            );

            expect(plannable).toHaveLength(readRecipeFixture().counts.plannable_versions);
            expect(plannable).toHaveLength(8);
        });

        it('offers at least four plannable recipes in one slot, which the repeat rule needs', () => {
            const perSlot = new Map<string, number>();
            for (const [slug, versionNumber] of COMMITTED_VERSIONS) {
                const version = recipeVersionRow(slug, versionNumber);
                if (!isEligibleForPlanning(planningVersionOf(version), makePreferences())) {
                    continue;
                }
                for (const slot of version.meal_slots) {
                    perSlot.set(slot, (perSlot.get(slot) ?? 0) + 1);
                }
            }

            // A recipe may be used at most twice a week and never on
            // consecutive days, so four per slot is the minimum that lets a
            // seven-day week close at all.
            expect(Math.max(...perSlot.values())).toBeGreaterThanOrEqual(4);
        });
    });

    describe('the per_100 ml ingredient', () => {
        const SLUG = 'spinach-egg-white-scramble';

        it('converts through the stored density, because millilitres are not grams', () => {
            const version = recipeVersionRow(SLUG, 1);
            const ingredients = publicationIngredients(SLUG, 1);
            const milk = publicationIngredient(SLUG, 1, 'usda:9200110');

            expect(milk.nutrition_basis).toBe('per_100ml');
            expect(milk.density_g_per_ml).toBe(1.032);

            const derived = deriveRecipeNutrition(ingredients, version.yield_servings);
            const asIfGrams = deriveRecipeNutrition(
                ingredients.map((ingredient) =>
                    ingredient.catalog_food_id === milk.catalog_food_id
                        ? { ...ingredient, nutrition_basis: 'per_100g' as const }
                        : ingredient,
                ),
                version.yield_servings,
            );

            // The stored figure is only reproducible WITH the conversion, and
            // the difference is exactly the density factor on the milk term —
            // derived here from the row rather than quoted as a magic number.
            expect(derived.perServing.calories).toBeCloseTo(version.per_serving_calories, 9);
            expect(asIfGrams.perServing.calories - derived.perServing.calories).toBeCloseTo(
                ((milk.snapshot_per_100g.calories * milk.gram_weight) / 100) *
                    (1 - 1 / (milk.density_g_per_ml as number)) /
                    version.yield_servings,
                9,
            );
            expect(asIfGrams.perServing.calories).not.toBeCloseTo(version.per_serving_calories, 6);
        });

        it('refuses the same row with its density removed rather than reading ml as g', () => {
            const ingredients = publicationIngredients(SLUG, 1).map((ingredient) =>
                ingredient.nutrition_basis === 'per_100ml'
                    ? { ...ingredient, density_g_per_ml: null }
                    : ingredient,
            );

            expect(() => deriveRecipeNutrition(ingredients, 2)).toThrow(UnitConversionError);
        });
    });

    describe('the deliberately stale ingredient snapshot', () => {
        const SLUG = 'herbed-yogurt-and-kale-dip-plate';

        /** The live catalog versions, read from the catalog fixture itself. */
        const liveVersions = (): Map<string, CatalogIngredientVersions> =>
            new Map(
                readCatalogFixture().foods.map((food) => [
                    food.id,
                    {
                        catalog_nutrition_version: food.nutrition_version,
                        catalog_metadata_version: food.metadata_version,
                    },
                ]),
            );

        it('reports the yogurt as stale in BOTH counters against the live catalog row', () => {
            const stale = findStaleIngredients(publicationIngredients(SLUG, 1), liveVersions());
            const yogurt = catalogFood('usda:9200115');

            // This row is frozen before both of the catalog's bumps, so its
            // numbers AND its name differ from the live row. The name is the
            // half a nutrition-only comparison would miss.
            expect(stale).toHaveLength(1);
            expect(stale[0]).toMatchObject({
                catalogFoodId: yogurt.id,
                name: 'Yogurt, Greek, plain, nonfat',
                changed: ['nutrition', 'metadata'],
                snapshotNutritionVersion: 1,
                snapshotMetadataVersion: 1,
                currentNutritionVersion: 2,
                currentMetadataVersion: 2,
            });
            expect(stale[0]?.name).not.toBe(yogurt.display_name);
            expect(isIngredientSnapshotStale(
                { catalog_nutrition_version: 1, catalog_metadata_version: 1 },
                { catalog_nutrition_version: yogurt.nutrition_version, catalog_metadata_version: yogurt.metadata_version },
            )).toBe(true);
        });

        it('derives from the frozen snapshot and never from the live row', () => {
            const version = recipeVersionRow(SLUG, 1);
            const ingredients = publicationIngredients(SLUG, 1);
            const yogurtRow = publicationIngredient(SLUG, 1, 'usda:9200115');
            const live = catalogFood('usda:9200115');

            // The fixture's whole point: the snapshot disagrees with the live
            // row, so a derivation that joined to the catalog instead of
            // reading the snapshot would produce a different number.
            expect(yogurtRow.snapshot_per_100g.calories).not.toBe(live.calories);
            expect(yogurtRow.snapshot_per_100g.calories).toBe(61);
            expect(live.calories).toBe(59);

            const fromSnapshot = deriveRecipeNutrition(ingredients, version.yield_servings);
            const asIfJoinedToLive = deriveRecipeNutrition(
                ingredients.map((ingredient) =>
                    ingredient.catalog_food_id === yogurtRow.catalog_food_id
                        ? { ...ingredient, snapshot_per_100g: { ...ingredient.snapshot_per_100g, calories: 59 } }
                        : ingredient,
                ),
                version.yield_servings,
            );

            expect(fromSnapshot.perServing.calories).toBeCloseTo(version.per_serving_calories, 9);
            expect(asIfJoinedToLive.perServing.calories).not.toBeCloseTo(version.per_serving_calories, 6);
        });

        it('reports every other version as matching the live catalog', () => {
            const matching = COMMITTED_VERSIONS.filter(
                ([slug, versionNumber]) =>
                    findStaleIngredients(publicationIngredients(slug, versionNumber), liveVersions()).length === 0,
            );

            // Only the version whose snapshot matches the live row in BOTH
            // counters is current. The fixture deliberately covers all three
            // stale states, so two other yogurt references are stale too —
            // each in a different counter.
            expect(matching).not.toContainEqual([SLUG, 1]);
            expect(matching).toContainEqual(['roasted-carrot-and-lentil-salad', 1]);
            expect(matching).not.toContainEqual(['cracker-and-yogurt-snack-plate', 1]);
            expect(matching).not.toContainEqual(['yogurt-egg-white-crispbread-plate', 1]);
        });

        it('covers all three staleness states across the graph, one per counter', () => {
            const changedFor = (slug: string): readonly string[] =>
                findStaleIngredients(publicationIngredients(slug, 1), liveVersions())[0]?.changed ?? [];

            // Both counters, nutrition only, and metadata only. A fixture that
            // varied one counter would leave half of
            // isIngredientSnapshotStale untested.
            expect(changedFor(SLUG)).toEqual(['nutrition', 'metadata']);
            expect(changedFor('yogurt-egg-white-crispbread-plate')).toEqual(['nutrition']);
            expect(changedFor('cracker-and-yogurt-snack-plate')).toEqual(['metadata']);
            expect(changedFor('roasted-carrot-and-lentil-salad')).toEqual([]);
        });
    });

    describe('the optional ingredient', () => {
        const SLUG = 'roasted-carrot-and-lentil-salad';

        it('counts for the allergen union and for the diet intersection', () => {
            const ingredients = publicationIngredients(SLUG, 1);
            const required = ingredients.filter((ingredient) => !ingredient.is_optional);
            const optional = ingredients.filter((ingredient) => ingredient.is_optional);

            expect(optional).toHaveLength(1);
            expect(optional[0].snapshot_name).toBe('Greek yogurt, plain');

            expect(deriveAllergenTags(ingredients)).toContain('milk');
            expect(deriveAllergenTags(required)).not.toContain('milk');
            expect(deriveDietTags(ingredients)).not.toContain('vegan');
            expect(deriveDietTags(required)).toContain('vegan');
        });

        it('counts for the nutrition totals too, so a plate is not understated', () => {
            const version = recipeVersionRow(SLUG, 1);
            const ingredients = publicationIngredients(SLUG, 1);
            const required = ingredients.filter((ingredient) => !ingredient.is_optional);

            expect(deriveRecipeNutrition(ingredients, version.yield_servings).perServing.calories).toBeCloseTo(
                version.per_serving_calories,
                9,
            );
            expect(deriveRecipeNutrition(required, version.yield_servings).perServing.calories).toBeLessThan(
                version.per_serving_calories,
            );
        });
    });

    it('keeps a retired catalog food referenceable by the historical version that used it', () => {
        const couscous = publicationIngredient('lemon-herb-chicken-and-rice', 1, 'usda:9200119');
        const version = recipeVersionRow('lemon-herb-chicken-and-rice', 1);

        expect(catalogFood('usda:9200119').publication_status).toBe('retired');
        expect(couscous.catalog_food_id).toBe(catalogFood('usda:9200119').id);

        // A retired food is out of search and out of new eligibility, but the
        // plan and diary rows that already point at this version must still
        // resolve — so its derivation has to keep working.
        expect(deriveRecipeNutrition(publicationIngredients('lemon-herb-chicken-and-rice', 1), version.yield_servings)
            .perServing.calories).toBeCloseTo(version.per_serving_calories, 9);
        expect(publicationIngredients('lemon-herb-chicken-and-rice', 2).map((row) => row.catalog_food_id)).not.toContain(
            couscous.catalog_food_id,
        );
    });

    it('propagates an unknown fibre instead of summing it as zero', () => {
        const version = recipeVersionRow('soy-glazed-chicken-and-rice-bowl', 1);
        const ingredients = publicationIngredients('soy-glazed-chicken-and-rice-bowl', 1);
        const soySauce = publicationIngredient('soy-glazed-chicken-and-rice-bowl', 1, 'usda:9200113');

        expect(soySauce.snapshot_per_100g.fiber_g).toBeNull();
        expect(version.derived_reference.per_serving_fiber_g).toBeNull();
        expect(deriveRecipeNutrition(ingredients, version.yield_servings).perServingFiber).toBeNull();
    });

    it('discloses the one version whose sourced energy diverges by more than 5 %', () => {
        const version = recipeVersionRow('lemon-dressed-spinach-salad', 1);
        const derived = deriveRecipeNutrition(
            publicationIngredients('lemon-dressed-spinach-salad', 1),
            version.yield_servings,
        );

        expect(derived.calorieDivergence).toBeGreaterThan(SOURCED_CALORIE_DIVERGENCE_THRESHOLD);
        expect(derived.sourcedCaloriesNote).toBe(version.sourced_calories_note);
        expect(derived.sourcedCaloriesNote).toContain('8.0%');

        const noteless = COMMITTED_VERSIONS.filter(
            ([slug, versionNumber]) => recipeVersionRow(slug, versionNumber).sourced_calories_note === null,
        );

        expect(noteless).toHaveLength(COMMITTED_VERSIONS.length - 1);
    });

    it('spells the pescatarian tag the way isDietCompatible matches it', () => {
        const version = recipeVersionRow('salmon-and-kale-plate', 1);
        const ingredients = publicationIngredients('salmon-and-kale-plate', 1);
        const salmon = publicationIngredient('salmon-and-kale-plate', 1, 'usda:9200121');

        // The one recipe that is pescatarian WITHOUT being vegetarian: no
        // implication closure can rescue it, so the spelling is load-bearing.
        expect(salmon.snapshot_diet_tags).toContain('pescatarian');
        expect(salmon.snapshot_diet_tags).not.toContain('pescatarian_ok');
        expect(deriveDietTags(ingredients)).toEqual(version.diet_tags);
        expect(version.diet_tags).toEqual(['gluten_free', 'pescatarian']);
        expect(isDietCompatible('pescatarian', version.diet_tags)).toBe(true);
        expect(isDietCompatible('vegetarian', version.diet_tags)).toBe(false);
    });

    describe('one food on its way to a plan', () => {
        const SLUG = 'lemon-herb-chicken-and-rice';
        const PORTION_MULTIPLIER = 1.5;

        it('scales the chicken row to the grams the planner will plan and the list will shop', () => {
            const version = recipeVersionRow(SLUG, 2);
            const chickenRow = publicationIngredient(SLUG, 2, 'usda:9200101');
            const scaled = scaleIngredients(
                publicationIngredients(SLUG, 2),
                PORTION_MULTIPLIER,
                version.yield_servings,
            );
            const chicken = scaled.find((entry) => entry.catalogFoodId === chickenRow.catalog_food_id);

            expect(chickenRow.catalog_food_id).toBe(catalogFood('usda:9200101').id);
            expect(chickenRow.gram_weight).toBe(600);
            expect(version.yield_servings).toBe(4);

            // `gram_weight / yield_servings * portion_multiplier` — the same
            // arithmetic `grocery.logic.ts`'s `plannedIngredientGrams` applies
            // to this row, and the number the grocery suite's traversal test
            // asserts against the aggregated shopping line.
            expect(chicken?.gramWeight).toBe(225);
            expect(chicken?.gramWeight).toBe(
                (chickenRow.gram_weight / version.yield_servings) * PORTION_MULTIPLIER,
            );
        });

        it('scales the whole per-serving set by the same multiplier', () => {
            const version = recipeVersionRow(SLUG, 2);
            const planned = scalePlannedNutrition(
                {
                    calories: version.per_serving_calories,
                    protein: version.per_serving_protein_g,
                    carbs: version.per_serving_carbs_g,
                    fat: version.per_serving_fat_g,
                },
                PORTION_MULTIPLIER,
            );

            expect(planned.calories).toBeCloseTo(version.per_serving_calories * PORTION_MULTIPLIER, 9);
            expect(roundNutritionForDisplay(planned).calories).toBe(
                Math.round(version.per_serving_calories * PORTION_MULTIPLIER),
            );
        });
    });

    /**
     * The rounding contract, composed across the two modules that own it.
     *
     * This module's half is the one asserted here: it hands over UNROUNDED
     * floats, and the only roundings in the chain happen downstream, once each.
     * The chain is
     *
     *   1. `deriveRecipeNutrition` / `scalePlannedNutrition` — full precision;
     *   2. `nutrition.service.ts::insertPlannedMealEntry` — `Math.round` per
     *      value, ONCE, into the diary snapshot;
     *   3. `nutrition.service.ts::asEaten` — `Math.round(snapshot × servings)`,
     *      the consumed total the mobile "This adds" card must agree with.
     *
     * Steps 2 and 3 are restated below rather than imported, because
     * `nutrition.service.ts` imports the Prisma client and this suite is
     * database-free by rule. `plannedMealLog.logic.test.ts` owns the logging
     * side of the contract; what is at stake HERE is that an extra round
     * inside step 1 would shift both of the others, which is invisible in
     * either module read alone.
     */
    describe('the rounding contract', () => {
        /** `nutrition.service.ts::insertPlannedMealEntry` — one round per value, on insert. */
        const asSnapshot = (nutrition: RecipePerServingNutrition): RecipePerServingNutrition => ({
            calories: Math.round(nutrition.calories),
            protein: Math.round(nutrition.protein),
            carbs: Math.round(nutrition.carbs),
            fat: Math.round(nutrition.fat),
        });

        /** `nutrition.service.ts::asEaten` — `Math.round(perServing * servings)`. */
        const asEaten = (perServing: number, servings: number): number => Math.round(perServing * servings);

        const plannedPortion = (slug: string, versionNumber: number, portionMultiplier: number) => {
            const version = recipeVersionRow(slug, versionNumber);
            const derived = deriveRecipeNutrition(publicationIngredients(slug, versionNumber), version.yield_servings);

            return { version, derived, planned: scalePlannedNutrition(derived.perServing, portionMultiplier) };
        };

        it('hands the planned portion over unrounded, fractions intact', () => {
            const { version, derived, planned } = plannedPortion('soy-glazed-chicken-and-rice-bowl', 1, 1.25);

            expect(Number.isInteger(derived.perServing.calories)).toBe(false);
            expect(Number.isInteger(planned.calories)).toBe(false);
            expect(planned.calories).toBeCloseTo(version.per_serving_calories * 1.25, 9);
            expect(planned.calories).not.toBe(Math.round(planned.calories));
        });

        it('rounds once into the snapshot and once again for the servings eaten', () => {
            const { planned } = plannedPortion('soy-glazed-chicken-and-rice-bowl', 1, 1.25);
            const snapshot = asSnapshot(planned);

            // Two roundings, and only two: the snapshot is what "1 serving"
            // means in the diary from then on, so the consumed total is taken
            // from the STORED integer and never recomputed from the float.
            expect(snapshot.calories).toBe(Math.round(planned.calories));
            expect(asEaten(snapshot.calories, 1)).toBe(snapshot.calories);
            expect(asEaten(snapshot.calories, 2)).toBe(snapshot.calories * 2);
            expect(asEaten(snapshot.calories, 0.5)).toBe(Math.round(snapshot.calories / 2));
        });

        it('rounds a half up, so the diary and the client agree on the .5 case', () => {
            // An odd snapshot halved lands exactly on .5 — the one input where
            // half-up and half-even disagree, and where a client using the
            // other rule would show a calorie less than the server stored.
            const snapshot = { calories: 421, protein: 41, carbs: 51, fat: 11 };

            expect(snapshot.calories % 2).toBe(1);
            expect(asEaten(snapshot.calories, 0.5)).toBe(211);
            expect(asEaten(snapshot.protein, 0.5)).toBe(21);
            expect(asSnapshot({ calories: 12.5, protein: 1.5, carbs: 2.5, fat: 0.5 })).toEqual({
                calories: 13,
                protein: 2,
                carbs: 3,
                fat: 1,
            });
        });

        it('would disagree with the diary if this module rounded before scaling', () => {
            const MULTIPLIER = 1.5;
            const { derived, planned } = plannedPortion('herb-chicken-rice-and-kale-bowl', 1, MULTIPLIER);

            // The failure mode the contract exists to prevent, shown by doing
            // it: rounding the per-serving value BEFORE the portion multiplier
            // is applied moves the stored snapshot, and with it every consumed
            // total the diary computes from that snapshot.
            const roundedTooEarly = scalePlannedNutrition(roundNutritionForDisplay(derived.perServing), MULTIPLIER);

            expect(asSnapshot(roundedTooEarly).calories).not.toBe(asSnapshot(planned).calories);
            expect(asEaten(asSnapshot(roundedTooEarly).calories, 1)).not.toBe(
                asEaten(asSnapshot(planned).calories, 1),
            );
        });
    });
});

/**
 * `recipe.mapper.ts` is the row -> DTO boundary for recipe versions, and this
 * suite pins the one thing a reshaping layer can get catastrophically wrong:
 * what it does when a stored row cannot supply a field the contract declares.
 *
 * The rule the file holds, and the reason each case below is a decision
 * somebody could quietly reverse:
 *
 *  - **A MISSING SAFETY LIST IS A FAULT, NOT AN EMPTY LIST.** `allergen_tags`
 *    and `diet_tags` are the derived union of every ingredient's frozen tags
 *    (§0.7.3), and planning eligibility is decided against exactly that union,
 *    so `[]` is the positive claim "contains none of the nine named allergens /
 *    carries no dietary restriction" rather than "unknown". Both columns are
 *    `TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[]`
 *    (`prisma/migrations/20260908000000_meal_planning/migration.sql`), so an
 *    absent value is drift, a projection that dropped the column, or a row
 *    written around the seed — and answering it with a default would publish
 *    that safety claim on behalf of a row that never made it. Whether the data
 *    IS unknown is stated separately, by `allergen_status`.
 *  - **The same holds for the two closed-set code lists.** `meal_slots` is NOT
 *    NULL without a default at all, and `badges` defaults to `[]`; reading an
 *    absent one as "no slots / no badges" understates what the recipe is,
 *    silently, on a row nothing in the sanctioned write path can produce.
 *  - **What DOES degrade, and only this.** An unrecognised MEMBER of
 *    `meal_slots` or `badges` is dropped, never substituted — matching the
 *    mobile converter, so both sides put the same value on the wire, and
 *    leaving a future slot or badge code unable to take a screen down. The two
 *    TAG lists have no such filter because their vocabulary is deliberately
 *    open (`src/types/recipe.ts`), which is why a non-string member of any of
 *    the four throws instead: `filter` would hide it in a code list, and in a
 *    tag list it would reach the client inside a field declared `string[]`.
 *  - **A RECIPE WITH NO STEPS IS LOST DATA, NOT A RECIPE.** `instructions` is
 *    `JSONB NOT NULL` holding what the recipe is cooked from, and frame 12
 *    renders it as the numbered list the user follows. A non-array root and an
 *    empty array are both refused, because either one renders a title, badges,
 *    nutrition and an ingredient list followed by nothing, with no way for the
 *    user or the operator to tell that the steps were lost rather than never
 *    written.
 *  - **Ingredient amounts are the WHOLE RECIPE's, passed through unscaled.**
 *    `quantity`, `gramWeight` and `displayText` are asserted equal to the
 *    stored values, which is the contract the swap preview and recipe detail
 *    both scale from (`quantity x portionMultiplier / yieldServings`). A mapper
 *    that started scaling here would put that rule in a second place and
 *    disagree with the stored per-serving nutrition beside it.
 *  - **The snapshot half fails closed too.** A recipe whose frozen ingredient
 *    safety tags are absent fails the WHOLE recipe rather than presenting an
 *    ingredient that appears to carry no allergens — asserted through
 *    `mapRecipeVersion`, because that is the only way a client ever reaches
 *    `catalog.mapper.ts::mapIngredientSnapshot`.
 *  - **Every legitimate row still maps.** An allergen-free recipe (genuinely
 *    empty tag lists), a retired version and a description-less recipe are
 *    asserted to pass, so "fail closed" cannot be read as "fail on anything
 *    unusual".
 *
 * A dedicated block for a mapper, where §11 covers mappers by integration,
 * because the behaviour above was ADDED at this checkpoint and the integration
 * suites that would cover it (`src/__tests__/api/recipes.test.ts`,
 * `api/plans.test.ts`, `api/swaps.test.ts`) are §0.7.1 Group 6 deliverables that
 * do not exist yet — leaving a new fail-closed rule with no evidence at all was
 * the worse of the two readings. It changes nothing about the coverage gate:
 * `jest.config.ts` derives its thresholds from `src/services/*.logic.ts` on
 * disk, which a test file cannot join.
 *
 * Folded into this suite from a dedicated `recipe.mapper.test.ts`: the backend
 * test inventory (Agent Action Plan §0.3.3, §0.8.1) gives each domain exactly
 * one pure suite, `__tests__/<domain>.logic.test.ts`, and §0.5.1/§0.7.1 place
 * `recipe.mapper.ts` inside the recipe domain that suite covers. Every title,
 * fixture and assertion below is the one that was written for it; only the file
 * they live in moved.
 */
describe('recipe.mapper.ts — the recipe row -> DTO boundary', () => {
    const VERSION_ID = '7f1d2c34-5678-4abc-9def-0123456789ab';
    const CATALOG_FOOD_ID = '11111111-2222-4333-8444-555555555555';

    /**
     * Overrides are `unknown`-valued on purpose: every failing case below stores a
     * value the row type forbids, which is exactly the state a `$queryRaw`
     * projection or a row written around the migration can produce and the state
     * the runtime readers exist for. The single cast lives here rather than at
     * thirty call sites.
     */
    type RowOverrides = Readonly<Record<string, unknown>>;

    const VALID_VERSION: RecipeVersionRow = {
        id: VERSION_ID,
        recipe_id: '22222222-3333-4444-8555-666666666666',
        version: 2,
        name: 'Chicken burrito bowl',
        description: 'A bowl that keeps.',
        icon_key: 'bowl',
        instructions: ['Season the chicken with chili powder, cumin, and salt.', 'Sear 6 to 7 minutes per side.'],
        yield_servings: 2,
        serving_description: '1 bowl',
        prep_minutes: 10,
        cook_minutes: 15,
        total_minutes: 25,
        meal_slots: ['lunch', 'dinner'],
        diet_tags: ['gluten_free'],
        allergen_tags: ['milk'],
        allergen_status: 'known',
        budget_tier: 2,
        badges: ['high_protein'],
        nutrition_provenance: 'source_backed',
        per_serving_calories: 610,
        per_serving_protein_g: 45,
        per_serving_carbs_g: 58,
        per_serving_fat_g: 21,
        status: 'current',
    };

    const VALID_INGREDIENT: RecipeIngredientRow = {
        catalog_food_id: CATALOG_FOOD_ID,
        catalog_nutrition_version: 3,
        catalog_metadata_version: 4,
        snapshot_per_100g: { calories: 165, protein_g: 31, carbs_g: 0, fat_g: 3.6, fiber_g: null },
        snapshot_name: 'Chicken breast',
        snapshot_provenance: 'source_backed',
        snapshot_allergen_tags: [],
        snapshot_diet_tags: ['gluten_free'],
        quantity: 10,
        unit: 'oz',
        gram_weight: 284,
        display_text: '10 oz',
        is_optional: false,
    };

    const versionRow = (overrides: RowOverrides = {}): RecipeVersionRow =>
        ({ ...VALID_VERSION, ...overrides }) as unknown as RecipeVersionRow;

    const ingredientRow = (overrides: RowOverrides = {}): RecipeIngredientRow =>
        ({ ...VALID_INGREDIENT, ...overrides }) as unknown as RecipeIngredientRow;

    /** The values a NOT NULL TEXT[] column can only hold through drift or corruption. */
    const ABSENT_OR_NOT_AN_ARRAY: readonly [string, unknown][] = [
        ['null', null],
        ['undefined', undefined],
        ['an object', { breakfast: true }],
        ['a string', 'lunch'],
        ['a number', 3],
        ['a boolean', false],
    ];

    /** The four required TEXT[] columns of `recipe_versions`, and the DTO member each becomes. */
    const REQUIRED_LIST_COLUMNS: readonly [string, keyof ReturnType<typeof mapRecipeVersion>][] = [
        ['meal_slots', 'mealSlots'],
        ['badges', 'badges'],
        ['diet_tags', 'dietTags'],
        ['allergen_tags', 'allergenTags'],
    ];

    describe('mapRecipeVersion', () => {
        describe('a required list column that is absent or is not an array', () => {
            REQUIRED_LIST_COLUMNS.forEach(([column]) => {
                ABSENT_OR_NOT_AN_ARRAY.forEach(([label, value]) => {
                    it(`fails the response when ${column} is ${label}`, () => {
                        expect(() => mapRecipeVersion(versionRow({ [column]: value }), [VALID_INGREDIENT])).toThrow(
                            RecipeMappingError,
                        );
                    });

                    it(`names ${column} and the version in the failure when it is ${label}`, () => {
                        expect(() => mapRecipeVersion(versionRow({ [column]: value }), [VALID_INGREDIENT])).toThrow(
                            new RegExp(`recipe_versions\\.${column}[\\s\\S]*${VERSION_ID}`),
                        );
                    });
                });
            });

            it('never answers a missing safety list with an empty one', () => {
                // The whole point of the rule: `[]` here would read as "contains no
                // allergens", which is a claim about the food rather than about the
                // data, so there must be no path from an absent column to a mapped
                // response at all.
                expect(() => mapRecipeVersion(versionRow({ allergen_tags: null }), [VALID_INGREDIENT])).toThrow(
                    RecipeMappingError,
                );
                expect(() => mapRecipeVersion(versionRow({ diet_tags: undefined }), [VALID_INGREDIENT])).toThrow(
                    RecipeMappingError,
                );
            });
        });

        describe('a list member that is not a string', () => {
            REQUIRED_LIST_COLUMNS.forEach(([column]) => {
                it(`fails the response, naming the index, when ${column} carries a number`, () => {
                    expect(() => mapRecipeVersion(versionRow({ [column]: ['lunch', 7] }), [VALID_INGREDIENT])).toThrow(
                        new RegExp(`recipe_versions\\.${column}\\[1\\]`),
                    );
                });

                it(`fails the response when ${column} carries null`, () => {
                    expect(() => mapRecipeVersion(versionRow({ [column]: [null] }), [VALID_INGREDIENT])).toThrow(
                        RecipeMappingError,
                    );
                });
            });
        });

        describe('an unrecognised member of a closed-set code list', () => {
            it('drops an unknown meal slot and keeps the known ones', () => {
                const mapped = mapRecipeVersion(versionRow({ meal_slots: ['breakfast', 'brunch', 'dinner'] }), []);

                expect(mapped.mealSlots).toEqual(['breakfast', 'dinner']);
            });

            it('drops an unknown badge and keeps the known ones', () => {
                const mapped = mapRecipeVersion(versionRow({ badges: ['quick', 'sparkly', 'vegan'] }), []);

                expect(mapped.badges).toEqual(['quick', 'vegan']);
            });

            it('keeps an unrecognised diet or allergen tag, because those vocabularies are open', () => {
                const mapped = mapRecipeVersion(
                    versionRow({ diet_tags: ['flexitarian'], allergen_tags: ['lupin'] }),
                    [],
                );

                expect(mapped.dietTags).toEqual(['flexitarian']);
                expect(mapped.allergenTags).toEqual(['lupin']);
            });
        });

        describe('instructions', () => {
            ABSENT_OR_NOT_AN_ARRAY.forEach(([label, value]) => {
                it(`fails the response when the stored value is ${label}`, () => {
                    expect(() => mapRecipeVersion(versionRow({ instructions: value }), [VALID_INGREDIENT])).toThrow(
                        RecipeMappingError,
                    );
                });
            });

            it('fails the response when the list is empty', () => {
                expect(() => mapRecipeVersion(versionRow({ instructions: [] }), [VALID_INGREDIENT])).toThrow(
                    RecipeMappingError,
                );
            });

            it('names the column and the version so an operator knows which row to repair', () => {
                expect(() => mapRecipeVersion(versionRow({ instructions: [] }), [VALID_INGREDIENT])).toThrow(
                    new RegExp(`recipe_versions\\.instructions[\\s\\S]*${VERSION_ID}`),
                );
            });

            it('fails the response when a step is not a string, naming the index', () => {
                expect(() =>
                    mapRecipeVersion(versionRow({ instructions: ['Sear the chicken.', 42] }), [VALID_INGREDIENT]),
                ).toThrow(/recipe_versions\.instructions\[1\]/);
            });

            it('emits the stored steps in the stored order', () => {
                const mapped = mapRecipeVersion(versionRow({ instructions: ['First.', 'Second.', 'Third.'] }), []);

                expect(mapped.instructions).toEqual(['First.', 'Second.', 'Third.']);
            });
        });

        describe('a frozen ingredient snapshot whose safety tags are absent', () => {
            it('fails the whole recipe rather than presenting an allergen-free ingredient', () => {
                expect(() =>
                    mapRecipeVersion(VALID_VERSION, [ingredientRow({ snapshot_allergen_tags: null })]),
                ).toThrow(CatalogMappingError);
            });

            it('fails the whole recipe when the frozen diet tags are absent', () => {
                expect(() => mapRecipeVersion(VALID_VERSION, [ingredientRow({ snapshot_diet_tags: undefined })])).toThrow(
                    CatalogMappingError,
                );
            });

            it('names the column and the catalog food in the failure', () => {
                expect(() =>
                    mapRecipeVersion(VALID_VERSION, [ingredientRow({ snapshot_allergen_tags: 'milk' })]),
                ).toThrow(new RegExp(`recipe_ingredients\\.snapshot_allergen_tags[\\s\\S]*${CATALOG_FOOD_ID}`));
            });

            it('fails the whole recipe when a frozen tag is not a string', () => {
                expect(() =>
                    mapRecipeVersion(VALID_VERSION, [ingredientRow({ snapshot_allergen_tags: ['milk', 5] })]),
                ).toThrow(/recipe_ingredients\.snapshot_allergen_tags\[1\]/);
            });
        });

        describe('a row that satisfies the contract', () => {
            it('maps every list column through as stored', () => {
                const mapped = mapRecipeVersion(VALID_VERSION, [VALID_INGREDIENT]);

                expect(mapped.mealSlots).toEqual(['lunch', 'dinner']);
                expect(mapped.badges).toEqual(['high_protein']);
                expect(mapped.dietTags).toEqual(['gluten_free']);
                expect(mapped.allergenTags).toEqual(['milk']);
            });

            it('maps a genuinely allergen-free, restriction-free recipe with empty lists', () => {
                // Empty is a legitimate stored value and must still map: "fail
                // closed" is about an ABSENT column, not about an empty one.
                const mapped = mapRecipeVersion(versionRow({ allergen_tags: [], diet_tags: [], badges: [] }), []);

                expect(mapped.allergenTags).toEqual([]);
                expect(mapped.dietTags).toEqual([]);
                expect(mapped.badges).toEqual([]);
            });

            it('maps a retired version and a description-less recipe', () => {
                const mapped = mapRecipeVersion(versionRow({ status: 'retired', description: null }), [VALID_INGREDIENT]);

                expect(mapped.status).toBe('retired');
                expect(mapped.description).toBe('');
            });

            it('reads the stored per-serving nutrition rather than recomputing it', () => {
                const mapped = mapRecipeVersion(VALID_VERSION, [VALID_INGREDIENT]);

                expect(mapped.perServing).toEqual({ calories: 610, protein: 45, carbs: 58, fat: 21 });
            });
        });
    });

    describe('mapRecipeIngredient', () => {
        describe('the amounts it emits', () => {
            it('passes the whole-recipe quantity, gram weight and display text through unscaled', () => {
                // The contract the swap preview and recipe detail both scale from:
                // these are the recipe as published, for `yield_servings` servings,
                // and nothing here knows the portion.
                const mapped = mapRecipeIngredient(VALID_INGREDIENT);

                expect(mapped.quantity).toBe(VALID_INGREDIENT.quantity);
                expect(mapped.unit).toBe(VALID_INGREDIENT.unit);
                expect(mapped.gramWeight).toBe(VALID_INGREDIENT.gram_weight);
                expect(mapped.displayText).toBe(VALID_INGREDIENT.display_text);
            });

            it('is unaffected by the recipe yield, which is the consumer divisor', () => {
                const one = mapRecipeIngredient(VALID_INGREDIENT);
                const four = mapRecipeVersion(versionRow({ yield_servings: 4 }), [VALID_INGREDIENT]).ingredients[0];

                expect(four.quantity).toBe(one.quantity);
                expect(four.gramWeight).toBe(one.gramWeight);
                expect(four.displayText).toBe(one.displayText);
            });
        });

        describe('the frozen identity', () => {
            it('reads the snapshot name and provenance, never a live catalog row', () => {
                const mapped = mapRecipeIngredient(VALID_INGREDIENT);

                expect(mapped.name).toBe('Chicken breast');
                expect(mapped.nutritionProvenance).toBe('source_backed');
                expect(mapped.catalogFoodId).toBe(CATALOG_FOOD_ID);
            });
        });
    });

    describe('mapPlannedRecipeSummary', () => {
        describe('badges', () => {
            ABSENT_OR_NOT_AN_ARRAY.forEach(([label, value]) => {
                it(`fails the planned meal when the column is ${label}`, () => {
                    expect(() => mapPlannedRecipeSummary(versionRow({ badges: value }))).toThrow(RecipeMappingError);
                });
            });

            it('drops an unrecognised badge code', () => {
                expect(mapPlannedRecipeSummary(versionRow({ badges: ['quick', 'sparkly'] })).badges).toEqual(['quick']);
            });
        });

        describe('provenance', () => {
            it('refuses a planned recipe whose nutrition is not source-backed', () => {
                expect(() => mapPlannedRecipeSummary(versionRow({ nutrition_provenance: 'ai_estimated' }))).toThrow(
                    RecipeMappingError,
                );
            });

            it('emits the source-backed literal for an eligible recipe', () => {
                expect(mapPlannedRecipeSummary(VALID_VERSION).nutritionProvenance).toBe('source_backed');
            });
        });
    });
});
