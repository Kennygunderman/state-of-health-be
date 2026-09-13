// Unit tests for the grocery rules. No database, no mocks, no clock: every
// rule takes its data as arguments, and anything time-dependent takes `now`,
// so each test states a whole scenario and asserts a returned value.
//
// The scenarios that matter most are the four that keep the flags
// trustworthy — the epsilon, the acknowledged baseline, the same-display
// increase and the unit-family lock — because each of those is a rule a future
// change could plausibly "simplify" away.
//
// Gram totals are expressed through `utils/units.ts`'s own conversion factors
// rather than as decimal literals, so a test can never disagree with the module
// it exercises about how many grams a pound is.

import { readFileSync } from 'fs';
import { join } from 'path';

import {
    GROCERY_EPSILON_G,
    COUNT_DISPLAY_UNIT,
    GROCERY_FIELD_CODES,
    GroceryDataError,
    GroceryDefaultPortion,
    GroceryFoodFacts,
    GroceryRowDraft,
    PlannedMealForGroceries,
    StoredGroceryRow,
    acknowledgedBaselineGrams,
    aggregatePlannedGrams,
    applyToggle,
    applyUncheckAll,
    bannerFor,
    buildGroceryDisplay,
    buildGroceryFlag,
    buildGroceryName,
    buildGroceryRows,
    classifyQuantityChange,
    diffGroceryList,
    displayFamilyForPortion,
    indexFoodStatesByName,
    parseGroceryItemPath,
    parseGroceryListPath,
    parseToggleGroceryBody,
    partitionGroceryList,
    plannedIngredientGrams,
    quantitiesAreEqual,
    requireGroceryWritablePlan,
    storedRowFamily,
} from '../grocery.logic';
import { PlanNotActiveError, PlanNotFoundError } from '../mealPlanning.errors';
// The other three domains of the cross-domain traversal at the end of this
// file. All four modules are pure, so the traversal calls the real functions.
import { PlanRecipeCandidate, buildPlanCandidates } from '../mealPlan.logic';
import { derivePlannedSnapshot } from '../plannedMealLog.logic';
import { RecipeIngredientSnapshot, scaleIngredients } from '../recipe.logic';
import {
    GRAMS_PER_OUNCE,
    GRAMS_PER_POUND,
    MILLILITERS_PER_CUP,
    MILLILITERS_PER_TABLESPOON,
    UnitConversionError,
    unitFamily,
} from '../../utils/units';

/* ---------------------------------------------------------------------------
 * The shared fixture graph
 *
 * `data/meal-planning/fixtures/catalog-foods.fixture.json` and
 * `recipes.fixture.json` are the referentially closed pair the Agent Action
 * Plan §0.3.3 commits — fixed uuid keys, fixed timestamps, snake_case rows —
 * and they are the same rows the recipe, planner and planned-log suites read.
 * Every food identity below is one of theirs, which is what lets the traversal
 * at the end of this file follow a single food out of a `recipe_ingredients`
 * row, through the planner's portion arithmetic, into a shopping line, and on
 * into a diary snapshot, asserting the same identity and the same grams at
 * every hop.
 *
 * Read off disk rather than transcribed (the convention
 * `evidence.logic.test.ts` uses), and re-parsed per accessor so a case that
 * mutates a row cannot leak into the next.
 * ------------------------------------------------------------------------- */

const FIXTURE_DIRECTORY = join(__dirname, '..', '..', '..', 'data', 'meal-planning', 'fixtures');

const CATALOG_FOODS_JSON = readFileSync(join(FIXTURE_DIRECTORY, 'catalog-foods.fixture.json'), 'utf8');
const RECIPES_JSON = readFileSync(join(FIXTURE_DIRECTORY, 'recipes.fixture.json'), 'utf8');

/** The `catalog_foods` columns a shopping line is built from. */
interface FixtureCatalogFood {
    id: string;
    source_key: string;
    display_name: string;
    food_state: string;
    category: string;
    density_g_per_ml: number | null;
}

/** A `catalog_food_portions` row; the `is_default` one decides the row's family. */
interface FixtureCatalogPortion {
    food_source_key: string;
    description: string;
    amount: number;
    unit: string;
    gram_weight: number;
    is_default: boolean;
}

/** The `recipe_versions` columns the portion arithmetic needs. */
interface FixtureRecipeVersion {
    id: string;
    recipe_id: string;
    recipe_slug: string;
    version: number;
    name: string;
    serving_description: string;
    yield_servings: number;
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
}

/**
 * A `recipe_ingredients` row. `gram_weight` is the grams of this food in the
 * WHOLE recipe, which is what the portion arithmetic divides by the yield.
 * `resolved_catalog_facts` is the fixture's documented non-column field: the
 * `catalog_foods` facts the table does not snapshot.
 */
interface FixtureRecipeIngredient {
    recipe_version_id: string;
    food_source_key: string;
    catalog_food_id: string;
    catalog_nutrition_version: number;
    catalog_metadata_version: number;
    snapshot_name: string;
    snapshot_provenance: RecipeIngredientSnapshot['snapshot_provenance'];
    snapshot_allergen_tags: string[];
    snapshot_diet_tags: string[];
    snapshot_per_100g: RecipeIngredientSnapshot['snapshot_per_100g'];
    quantity: number;
    unit: string;
    gram_weight: number;
    display_text: string;
    sort_order: number;
    is_optional: boolean;
    resolved_catalog_facts: {
        nutrition_basis: 'per_100g' | 'per_100ml';
        density_g_per_ml: number | null;
    };
}

interface CatalogFixtureDocument {
    foods: FixtureCatalogFood[];
    portions: FixtureCatalogPortion[];
}

interface RecipeFixtureDocument {
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

/**
 * That food's `is_default` portion as the grocery shape. Every fixture food has
 * exactly one, which the partial unique index enforces, so a missing one is a
 * broken fixture rather than a case to tolerate.
 */
const defaultPortionOf = (sourceKey: string): GroceryDefaultPortion => {
    const row = readCatalogFixture().portions.find(
        (candidate) => candidate.food_source_key === sourceKey && candidate.is_default,
    );
    if (!row) {
        throw new Error(`catalog-foods.fixture.json carries no default portion for ${sourceKey}`);
    }

    return { description: row.description, unit: row.unit, gram_weight: row.gram_weight };
};

/** One committed catalog food as the facts a shopping line reads. */
const groceryFacts = (sourceKey: string, overrides: Partial<GroceryFoodFacts> = {}): GroceryFoodFacts => {
    const food = catalogFood(sourceKey);

    return {
        catalog_food_id: food.id,
        food_state: food.food_state,
        name: food.display_name,
        category: food.category,
        density_g_per_ml: food.density_g_per_ml,
        default_portion: defaultPortionOf(sourceKey),
        ...overrides,
    };
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

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

const CHICKEN = catalogFood('usda:9200101').id;
const OLIVE_OIL = catalogFood('usda:9200109').id;
const EGG = catalogFood('usda:9200107').id;
const RICE = catalogFood('usda:9200103').id;
const RAW = 'raw';
const COOKED = 'cooked';
const DRY = 'dry';
const AS_PURCHASED = 'as_purchased';

const NOW = new Date('2026-07-05T12:00:00.000Z');
const EARLIER = new Date('2026-07-04T09:30:00.000Z');

/**
 * A portion whose unit is the only thing most cases care about — it is what
 * `displayFamilyForPortion` reads the family off. Left synthetic because these
 * are unit-family probes rather than foods: several pass a unit no catalog food
 * carries (`bottle`), which is exactly the fallback being pinned.
 */
const portion = (overrides: Partial<GroceryDefaultPortion> = {}): GroceryDefaultPortion => ({
    description: 'breast',
    unit: 'oz',
    gram_weight: GRAMS_PER_OUNCE,
    ...overrides,
});

/** `usda:9200101` — chicken breast, raw, protein_poultry, with its own 100 g default portion. */
const facts = (overrides: Partial<GroceryFoodFacts> = {}): GroceryFoodFacts =>
    groceryFacts('usda:9200101', overrides);

/**
 * `usda:9200109` — olive oil, the committed volume-family food.
 *
 * Its density is overridden to 1: the catalog states 0.918, and every volume
 * assertion below is written so a millilitre weighs a gram, which keeps "1 cup"
 * readable as `MILLILITERS_PER_CUP` grams instead of a six-decimal figure. The
 * real 0.918 is exercised where it belongs — in the traversal at the end of
 * this file and in the recipe suite's per_100 ml conversion.
 */
const oilFacts = (overrides: Partial<GroceryFoodFacts> = {}): GroceryFoodFacts =>
    groceryFacts('usda:9200109', {
        density_g_per_ml: 1,
        default_portion: portion({ description: 'tbsp', unit: 'tbsp', gram_weight: MILLILITERS_PER_TABLESPOON }),
        ...overrides,
    });

/**
 * `usda:9200107` — egg white, the committed count-family food (`each`).
 *
 * Two local overrides, both so the counting arithmetic reads as a boundary: the
 * portion weighs 50 g rather than the catalog's 33 g, which makes 600 g exactly
 * twelve items, and the name and portion description are the plural-facing
 * 'Eggs'/'egg' rather than 'Egg white'/'1 large egg white', which is what the
 * irregular-plural assertions are about.
 */
const eggFacts = (overrides: Partial<GroceryFoodFacts> = {}): GroceryFoodFacts =>
    groceryFacts('usda:9200107', {
        name: 'Eggs',
        default_portion: portion({ description: 'egg', unit: 'each', gram_weight: 50 }),
        ...overrides,
    });

const meal = (
    ingredients: readonly { catalog_food_id: string; food_state?: string; gram_weight: number }[],
    overrides: Partial<Omit<PlannedMealForGroceries, 'ingredients'>> = {},
): PlannedMealForGroceries => ({
    yield_servings: 1,
    portion_multiplier: 1,
    ingredients: ingredients.map((ingredient) => ({
        catalog_food_id: ingredient.catalog_food_id,
        food_state: ingredient.food_state ?? RAW,
        gram_weight: ingredient.gram_weight,
    })),
    ...overrides,
});

const row = (overrides: Partial<StoredGroceryRow> = {}): StoredGroceryRow => ({
    id: 'row-1',
    catalog_food_id: CHICKEN,
    food_state: RAW,
    name: 'Chicken breast',
    category: 'protein',
    quantity_grams: 2.5 * GRAMS_PER_POUND,
    display_quantity: 2.5,
    display_unit: 'lb',
    display_text: '2.5 lb',
    is_checked: false,
    previous_quantity_grams: null,
    flagged_at: null,
    sort_order: 0,
    ...overrides,
});

const draft = (overrides: Partial<GroceryRowDraft> = {}): GroceryRowDraft => ({
    catalog_food_id: CHICKEN,
    food_state: RAW,
    category: 'protein',
    name: 'Chicken breast',
    quantity_grams: 2.5 * GRAMS_PER_POUND,
    display_quantity: 2.5,
    display_unit: 'lb',
    display_text: '2.5 lb',
    sort_order: 0,
    ...overrides,
});

/** A draft carrying a mass amount, rendered the way the module would render it. */
const massDraft = (grams: number, overrides: Partial<GroceryRowDraft> = {}): GroceryRowDraft => {
    const display = buildGroceryDisplay(grams, 'mass', { density_g_per_ml: null, default_portion: portion() });

    return draft({
        quantity_grams: grams,
        display_quantity: display.quantity,
        display_unit: display.unit,
        display_text: display.text,
        ...overrides,
    });
};

/* ---------------------------------------------------------------------------
 * Aggregation
 * ------------------------------------------------------------------------- */

describe('plannedIngredientGrams', () => {
    it('divides the recipe gram weight by the yield and scales by the portion', () => {
        expect(plannedIngredientGrams(600, 4, 1.5)).toBe(225);
    });

    it('returns the per-serving weight for a single planned serving', () => {
        expect(plannedIngredientGrams(600, 4, 1)).toBe(150);
    });

    it('keeps full precision rather than rounding each contribution', () => {
        expect(plannedIngredientGrams(100, 3, 1)).toBeCloseTo(33.333333333, 9);
    });

    describe('unusable inputs', () => {
        it('rejects a zero yield rather than dividing by it', () => {
            expect(() => plannedIngredientGrams(600, 0, 1)).toThrow(GroceryDataError);
        });

        it('rejects a negative yield', () => {
            expect(() => plannedIngredientGrams(600, -4, 1)).toThrow(/yield_servings/);
        });

        it('rejects a non-positive gram weight', () => {
            expect(() => plannedIngredientGrams(0, 4, 1)).toThrow(/gram_weight/);
        });

        it('rejects a non-positive portion multiplier', () => {
            expect(() => plannedIngredientGrams(600, 4, 0)).toThrow(/portion_multiplier/);
        });

        it('rejects a non-finite gram weight', () => {
            expect(() => plannedIngredientGrams(Number.NaN, 4, 1)).toThrow(GroceryDataError);
        });
    });
});

describe('aggregatePlannedGrams', () => {
    it('sums the same food across meals into one line', () => {
        const totals = aggregatePlannedGrams([
            meal([{ catalog_food_id: CHICKEN, gram_weight: 400 }]),
            meal([{ catalog_food_id: CHICKEN, gram_weight: 200 }]),
        ]);

        expect(totals).toEqual([{ catalog_food_id: CHICKEN, food_state: RAW, quantity_grams: 600 }]);
    });

    it('never merges two states of one food, because they are two different shops', () => {
        const totals = aggregatePlannedGrams([
            meal([
                { catalog_food_id: RICE, food_state: DRY, gram_weight: 100 },
                { catalog_food_id: RICE, food_state: COOKED, gram_weight: 300 },
            ]),
        ]);

        expect(totals).toEqual([
            { catalog_food_id: RICE, food_state: COOKED, quantity_grams: 300 },
            { catalog_food_id: RICE, food_state: DRY, quantity_grams: 100 },
        ]);
    });

    it('applies the yield and the portion multiplier per meal', () => {
        const totals = aggregatePlannedGrams([
            meal([{ catalog_food_id: CHICKEN, gram_weight: 800 }], { yield_servings: 4, portion_multiplier: 1.5 }),
        ]);

        expect(totals[0].quantity_grams).toBe(300);
    });

    it('orders by identity, so the read order of the meals cannot change the result', () => {
        const first = aggregatePlannedGrams([
            meal([{ catalog_food_id: EGG, gram_weight: 50 }]),
            meal([{ catalog_food_id: CHICKEN, gram_weight: 100 }]),
        ]);
        const second = aggregatePlannedGrams([
            meal([{ catalog_food_id: CHICKEN, gram_weight: 100 }]),
            meal([{ catalog_food_id: EGG, gram_weight: 50 }]),
        ]);

        expect(first).toEqual(second);
        expect(first.map((total) => total.catalog_food_id)).toEqual([CHICKEN, EGG]);
    });

    it('returns nothing for a week with no meals', () => {
        expect(aggregatePlannedGrams([])).toEqual([]);
    });
});

/* ---------------------------------------------------------------------------
 * The epsilon
 * ------------------------------------------------------------------------- */

describe('quantitiesAreEqual', () => {
    it('is half a gram', () => {
        expect(GROCERY_EPSILON_G).toBe(0.5);
    });

    it('treats a sub-epsilon difference as equal', () => {
        expect(quantitiesAreEqual(1000, 1000.49)).toBe(true);
    });

    it('excludes the epsilon itself', () => {
        expect(quantitiesAreEqual(1000, 1000.5)).toBe(false);
    });

    it('is symmetric', () => {
        expect(quantitiesAreEqual(1000.49, 1000)).toBe(true);
        expect(quantitiesAreEqual(1000.5, 1000)).toBe(false);
    });
});

describe('classifyQuantityChange', () => {
    it('reports a sub-epsilon drift as unchanged, so noise cannot flag a checked row', () => {
        expect(classifyQuantityChange(1000, 1000.4)).toBe('unchanged');
        expect(classifyQuantityChange(1000, 999.6)).toBe('unchanged');
    });

    it('reports a real increase', () => {
        expect(classifyQuantityChange(1000, 1200)).toBe('increased');
    });

    it('reports a real decrease', () => {
        expect(classifyQuantityChange(1000, 800)).toBe('decreased');
    });

    it('applies the epsilon before the direction, at the boundary', () => {
        expect(classifyQuantityChange(1000, 1000.5)).toBe('increased');
        expect(classifyQuantityChange(1000, 999.5)).toBe('decreased');
    });
});

/* ---------------------------------------------------------------------------
 * Display and the unit-family lock
 * ------------------------------------------------------------------------- */

describe('displayFamilyForPortion', () => {
    it('reads the family off the default portion unit', () => {
        expect(displayFamilyForPortion(portion({ unit: 'oz' }))).toBe('mass');
        expect(displayFamilyForPortion(portion({ unit: 'tbsp' }))).toBe('volume');
        expect(displayFamilyForPortion(portion({ unit: 'each' }))).toBe('count');
    });

    it('falls back to mass for a container unit, which is never generated', () => {
        expect(displayFamilyForPortion(portion({ description: 'bottle', unit: 'bottle' }))).toBe('mass');
    });

    it('falls back to mass when the food has no default portion', () => {
        expect(displayFamilyForPortion(null)).toBe('mass');
    });
});

describe('buildGroceryDisplay', () => {
    const massFacts = { density_g_per_ml: null, default_portion: portion() };
    const volumeFacts = { density_g_per_ml: 1, default_portion: portion({ unit: 'tbsp' }) };
    const countFacts = { density_g_per_ml: null, default_portion: portion({ description: 'egg', gram_weight: 50 }) };

    describe('mass', () => {
        it('renders pounds to a tenth', () => {
            expect(buildGroceryDisplay(2.5 * GRAMS_PER_POUND, 'mass', massFacts)).toEqual({
                family: 'mass',
                quantity: 2.5,
                unit: 'lb',
                text: '2.5 lb',
            });
        });

        it('stays in ounces below a pound', () => {
            expect(buildGroceryDisplay(450, 'mass', massFacts).text).toBe('15.9 oz');
        });

        it('promotes to pounds at sixteen ounces rather than printing "16.0 oz"', () => {
            expect(buildGroceryDisplay(16 * GRAMS_PER_OUNCE, 'mass', massFacts).text).toBe('1 lb');
            expect(buildGroceryDisplay(453, 'mass', massFacts).text).toBe('1 lb');
        });

        it('renders whole grams under an ounce', () => {
            expect(buildGroceryDisplay(20, 'mass', massFacts).text).toBe('20 g');
        });

        it('renders a true zero as zero', () => {
            expect(buildGroceryDisplay(0, 'mass', massFacts).text).toBe('0 g');
        });
    });

    describe('volume', () => {
        it('converts grams through the stored density', () => {
            expect(buildGroceryDisplay(MILLILITERS_PER_CUP, 'volume', volumeFacts).text).toBe('1 cup');
        });

        it('rounds cups and tablespoons to the nearest quarter', () => {
            expect(buildGroceryDisplay(0.3 * MILLILITERS_PER_CUP, 'volume', volumeFacts).text).toBe('4¾ tbsp');
            expect(buildGroceryDisplay(1.3 * MILLILITERS_PER_CUP, 'volume', volumeFacts).text).toBe('1¼ cups');
        });

        it('promotes to cups at sixteen tablespoons', () => {
            expect(buildGroceryDisplay(15.9 * MILLILITERS_PER_TABLESPOON, 'volume', volumeFacts).text).toBe('1 cup');
        });

        it('renders whole millilitres below a tablespoon', () => {
            expect(buildGroceryDisplay(10, 'volume', volumeFacts).text).toBe('10 ml');
        });

        it('refuses to treat millilitres as grams when the food has no density', () => {
            expect(() =>
                buildGroceryDisplay(100, 'volume', { density_g_per_ml: null, default_portion: portion() }),
            ).toThrow(UnitConversionError);
        });
    });

    describe('count', () => {
        it('divides by the portion gram weight and pluralises the description', () => {
            expect(buildGroceryDisplay(600, 'count', countFacts)).toEqual({
                family: 'count',
                quantity: 12,
                unit: COUNT_DISPLAY_UNIT,
                text: '12 eggs',
            });
        });

        it('keeps the singular for exactly one', () => {
            expect(buildGroceryDisplay(50, 'count', countFacts).text).toBe('1 egg');
        });

        it('never shows a positive amount as none', () => {
            expect(buildGroceryDisplay(25, 'count', countFacts).text).toBe('1 egg');
        });

        it('rejects a portion with no usable gram weight', () => {
            expect(() =>
                buildGroceryDisplay(600, 'count', {
                    density_g_per_ml: null,
                    default_portion: portion({ gram_weight: 0 }),
                }),
            ).toThrow(GroceryDataError);
        });

        it('rejects a missing portion', () => {
            expect(() =>
                buildGroceryDisplay(600, 'count', { density_g_per_ml: null, default_portion: null }),
            ).toThrow(GroceryDataError);
        });
    });

    describe('the stored display_unit always resolves to its own family', () => {
        it('holds for every family, which is what makes the lock readable', () => {
            const massUnit = buildGroceryDisplay(2.5 * GRAMS_PER_POUND, 'mass', massFacts);
            const volumeUnit = buildGroceryDisplay(MILLILITERS_PER_CUP, 'volume', volumeFacts);
            const countUnit = buildGroceryDisplay(600, 'count', countFacts);

            expect(unitFamily(massUnit.unit)).toBe('mass');
            expect(unitFamily(volumeUnit.unit)).toBe('volume');
            expect(unitFamily(countUnit.unit)).toBe('count');
        });
    });

    describe('unusable quantities', () => {
        it('rejects a negative quantity', () => {
            expect(() => buildGroceryDisplay(-1, 'mass', massFacts)).toThrow(GroceryDataError);
        });

        it('rejects a non-finite quantity', () => {
            expect(() => buildGroceryDisplay(Number.POSITIVE_INFINITY, 'mass', massFacts)).toThrow(GroceryDataError);
        });
    });
});

describe('storedRowFamily', () => {
    it('reads the family back off the row', () => {
        expect(storedRowFamily({ display_unit: 'lb' })).toBe('mass');
        expect(storedRowFamily({ display_unit: 'cups' })).toBe('volume');
        expect(storedRowFamily({ display_unit: COUNT_DISPLAY_UNIT })).toBe('count');
    });

    it('throws rather than guessing when the stored unit no longer resolves', () => {
        expect(() => storedRowFamily({ display_unit: 'bottle' })).toThrow(GroceryDataError);
    });
});

/* ---------------------------------------------------------------------------
 * The food_state name suffix
 * ------------------------------------------------------------------------- */

describe('indexFoodStatesByName', () => {
    it('collects every state a base name appears in', () => {
        const index = indexFoodStatesByName([
            { name: 'Rice', food_state: DRY },
            { name: 'Rice', food_state: COOKED },
            { name: 'Chicken breast', food_state: RAW },
        ]);

        expect(index.get('Rice')).toEqual(new Set([DRY, COOKED]));
        expect(index.get('Chicken breast')).toEqual(new Set([RAW]));
    });
});

describe('buildGroceryName', () => {
    const single = indexFoodStatesByName([{ name: 'Chicken breast', food_state: RAW }]);
    const both = indexFoodStatesByName([
        { name: 'Rice', food_state: RAW },
        { name: 'Rice', food_state: COOKED },
    ]);

    it('leaves a raw food unqualified', () => {
        expect(buildGroceryName('Chicken breast', RAW, single)).toBe('Chicken breast');
    });

    it('qualifies a single non-raw state, because the state is worth saying', () => {
        expect(buildGroceryName('Brown rice', DRY, indexFoodStatesByName([{ name: 'Brown rice', food_state: DRY }]))).toBe(
            'Brown rice, dry',
        );
    });

    it('qualifies both lines when two states of one food are on the list', () => {
        expect(buildGroceryName('Rice', RAW, both)).toBe('Rice, raw');
        expect(buildGroceryName('Rice', COOKED, both)).toBe('Rice, cooked');
    });

    it('reads a multi-word state as words', () => {
        expect(buildGroceryName('Flour', 'as_purchased', new Map())).toBe('Flour, as purchased');
    });

    it('leaves a raw food unqualified when the list index does not mention it', () => {
        expect(buildGroceryName('Chicken breast', RAW, new Map())).toBe('Chicken breast');
    });
});

/* ---------------------------------------------------------------------------
 * Aisles and list order
 * ------------------------------------------------------------------------- */

describe('buildGroceryRows', () => {
    /**
     * One committed food per aisle, written in an order that matches none of
     * them, so the aisle order below can only come from the rule: soy sauce
     * (condiment_sauce) to the pantry, brown rice (grain) to grains & bread,
     * Greek yogurt (dairy) to dairy & alternatives, chicken breast
     * (protein_poultry) to protein, spinach (produce_vegetable) to produce.
     */
    const aisleFoods: GroceryFoodFacts[] = [
        groceryFacts('usda:9200113'),
        groceryFacts('usda:9200103'),
        groceryFacts('usda:9200115'),
        groceryFacts('usda:9200101'),
        groceryFacts('usda:9200111'),
    ];

    const aisleMeal = meal(
        aisleFoods.map((food) => ({
            catalog_food_id: food.catalog_food_id,
            food_state: food.food_state,
            gram_weight: 100,
        })),
    );

    it('files each line in its aisle and closes the list with pantry_other', () => {
        const rows = buildGroceryRows([aisleMeal], aisleFoods);

        expect(rows.map((line) => line.category)).toEqual([
            'produce',
            'protein',
            'dairy_alternatives',
            'grains_bread',
            'pantry_other',
        ]);
    });

    it('numbers sort_order from the final position', () => {
        expect(buildGroceryRows([aisleMeal], aisleFoods).map((line) => line.sort_order)).toEqual([0, 1, 2, 3, 4]);
    });

    it('orders by name within an aisle', () => {
        const rows = buildGroceryRows(
            [
                meal([
                    { catalog_food_id: 'spinach', gram_weight: 100 },
                    { catalog_food_id: 'avocado', gram_weight: 100 },
                ]),
            ],
            [
                facts({ catalog_food_id: 'spinach', name: 'Spinach', category: 'produce_vegetable' }),
                facts({ catalog_food_id: 'avocado', name: 'Avocado', category: 'produce_fruit' }),
            ],
        );

        expect(rows.map((line) => line.name)).toEqual(['Avocado', 'Spinach']);
    });

    it('orders by name even when identity order disagrees with it', () => {
        const rows = buildGroceryRows(
            [
                meal([
                    { catalog_food_id: 'a-food', gram_weight: 100 },
                    { catalog_food_id: 'b-food', gram_weight: 100 },
                ]),
            ],
            [
                facts({ catalog_food_id: 'a-food', name: 'Zucchini', category: 'produce_vegetable' }),
                facts({ catalog_food_id: 'b-food', name: 'Apple', category: 'produce_fruit' }),
            ],
        );

        expect(rows.map((line) => line.name)).toEqual(['Apple', 'Zucchini']);
    });

    it('keeps identity order when two lines share an aisle and a name', () => {
        const rows = buildGroceryRows(
            [
                meal([
                    { catalog_food_id: 'b-food', gram_weight: 100 },
                    { catalog_food_id: 'a-food', gram_weight: 100 },
                ]),
            ],
            [
                facts({ catalog_food_id: 'b-food', name: 'Olive oil', category: 'produce_vegetable' }),
                facts({ catalog_food_id: 'a-food', name: 'Olive oil', category: 'produce_vegetable' }),
            ],
        );

        expect(rows.map((line) => line.catalog_food_id)).toEqual(['a-food', 'b-food']);
    });

    it('qualifies the two states of one food and leaves the raw one alone otherwise', () => {
        const rows = buildGroceryRows(
            [
                meal([
                    { catalog_food_id: 'rice-dry', food_state: DRY, gram_weight: 100 },
                    { catalog_food_id: 'rice-cooked', food_state: COOKED, gram_weight: 300 },
                ]),
            ],
            [
                facts({ catalog_food_id: 'rice-dry', name: 'Rice', category: 'grain', food_state: DRY }),
                facts({ catalog_food_id: 'rice-cooked', name: 'Rice', category: 'grain', food_state: COOKED }),
            ],
        );

        expect(rows.map((line) => line.name)).toEqual(['Rice, cooked', 'Rice, dry']);
    });

    it('renders each line in the family its own default portion implies', () => {
        const rows = buildGroceryRows(
            [
                meal([
                    { catalog_food_id: EGG, gram_weight: 600 },
                    { catalog_food_id: OLIVE_OIL, food_state: AS_PURCHASED, gram_weight: MILLILITERS_PER_CUP },
                ]),
            ],
            [eggFacts(), oilFacts()],
        );

        // The oil's name carries its state because the catalog food really is
        // `as_purchased` and it is the only non-raw line on this list.
        expect(rows.map((line) => [line.name, line.display_text, line.display_unit])).toEqual([
            ['Eggs', '12 eggs', COUNT_DISPLAY_UNIT],
            ['Olive oil, as purchased', '1 cup', 'cup'],
        ]);
    });

    it('stores grams at the column precision of two decimals', () => {
        const rows = buildGroceryRows(
            [meal([{ catalog_food_id: CHICKEN, gram_weight: 100 }], { yield_servings: 3 })],
            [facts()],
        );

        expect(rows[0].quantity_grams).toBe(33.33);
    });

    it('refuses to build a line it cannot name or categorise', () => {
        expect(() => buildGroceryRows([meal([{ catalog_food_id: 'unknown', gram_weight: 100 }])], [facts()])).toThrow(
            GroceryDataError,
        );
    });

    it('returns an empty list for a plan with no ingredients', () => {
        expect(buildGroceryRows([], [])).toEqual([]);
    });
});


/* ---------------------------------------------------------------------------
 * The acknowledged baseline
 * ------------------------------------------------------------------------- */

describe('acknowledgedBaselineGrams', () => {
    it('is the recorded amount when there is one', () => {
        expect(acknowledgedBaselineGrams({ quantity_grams: 1400, previous_quantity_grams: 1133 })).toBe(1133);
    });

    it('falls back to the current amount, which cannot overstate the change', () => {
        expect(acknowledgedBaselineGrams({ quantity_grams: 1400, previous_quantity_grams: null })).toBe(1400);
    });
});

/* ---------------------------------------------------------------------------
 * The diff
 * ------------------------------------------------------------------------- */

describe('diffGroceryList', () => {
    const TWO_AND_A_HALF_LB = 2.5 * GRAMS_PER_POUND;
    const chickenFacts = [facts()];

    /** A checked row the user acknowledged at 2.5 lb. */
    const acknowledgedRow = (overrides: Partial<StoredGroceryRow> = {}): StoredGroceryRow =>
        row({
            id: 'r1',
            is_checked: true,
            quantity_grams: TWO_AND_A_HALF_LB,
            previous_quantity_grams: TWO_AND_A_HALF_LB,
            ...overrides,
        });

    /** Folds an update back onto a row, the way the service's write would. */
    const applyUpdate = (current: StoredGroceryRow, update: ReturnType<typeof diffGroceryList>['updates'][0]) => ({
        ...current,
        name: update.name,
        category: update.category,
        quantity_grams: update.quantity_grams,
        display_quantity: update.display_quantity,
        display_unit: update.display_unit,
        display_text: update.display_text,
        sort_order: update.sort_order,
        previous_quantity_grams: update.previous_quantity_grams,
        flagged_at: update.flagged_at,
    });

    describe('an increase on a checked row', () => {
        const plan = diffGroceryList([acknowledgedRow()], [massDraft(3.1 * GRAMS_PER_POUND)], chickenFacts, NOW);

        it('keeps the check by never writing is_checked, and flags instead', () => {
            expect(plan.updates).toEqual([
                {
                    id: 'r1',
                    name: 'Chicken breast',
                    category: 'protein',
                    quantity_grams: 3.1 * GRAMS_PER_POUND,
                    display_quantity: 3.1,
                    display_unit: 'lb',
                    display_text: '3.1 lb',
                    sort_order: 0,
                    previous_quantity_grams: TWO_AND_A_HALF_LB,
                    flagged_at: NOW,
                },
            ]);
        });

        it('counts the increase', () => {
            expect(plan.summary).toEqual({ added: 0, removed: 0, increased: 1 });
        });
    });

    it('stores an increase whose rendered text does not move, but does not flag it', () => {
        const plan = diffGroceryList([acknowledgedRow()], [massDraft(TWO_AND_A_HALF_LB + 1.1)], chickenFacts, NOW);

        expect(plan.updates[0]).toMatchObject({
            quantity_grams: TWO_AND_A_HALF_LB + 1.1,
            display_text: '2.5 lb',
            flagged_at: null,
        });
        expect(plan.summary.increased).toBe(1);
    });

    // The visibility test governs RAISING a flag, not keeping one: a warning the
    // shopper is already looking at must not be retracted over a gram.
    it('keeps a standing flag through an increase that moves nothing on the row', () => {
        const flaggedRow = acknowledgedRow({
            quantity_grams: 3.1 * GRAMS_PER_POUND,
            display_quantity: 3.1,
            display_text: '3.1 lb',
            flagged_at: EARLIER,
        });
        const plan = diffGroceryList([flaggedRow], [massDraft(3.1 * GRAMS_PER_POUND + 1.1)], chickenFacts, NOW);

        expect(plan.updates[0]).toMatchObject({
            quantity_grams: 3.1 * GRAMS_PER_POUND + 1.1,
            display_text: '3.1 lb',
            flagged_at: EARLIER,
            previous_quantity_grams: TWO_AND_A_HALF_LB,
        });
        expect(buildGroceryFlag(applyUpdate(flaggedRow, plan.updates[0]), facts())).toMatchObject({
            previousDisplayText: '2.5 lb',
            newDisplayText: '3.1 lb',
            deltaDisplayText: '+0.6 lb',
            flaggedAt: EARLIER.toISOString(),
        });
    });

    it('leaves a sub-epsilon drift entirely alone', () => {
        const plan = diffGroceryList(
            [acknowledgedRow()],
            [draft({ quantity_grams: TWO_AND_A_HALF_LB + 0.2 })],
            chickenFacts,
            NOW,
        );

        expect(plan.updates).toEqual([]);
        expect(plan.unchangedItemIds).toEqual(['r1']);
        expect(plan.summary).toEqual({ added: 0, removed: 0, increased: 0 });
    });

    it('keeps the text the shopper is reading when the quantity is unchanged', () => {
        const plan = diffGroceryList(
            [acknowledgedRow()],
            [draft({ quantity_grams: TWO_AND_A_HALF_LB + 0.4, display_quantity: 2.6, display_text: '2.6 lb' })],
            chickenFacts,
            NOW,
        );

        expect(plan.updates).toEqual([]);
        expect(plan.unchangedItemIds).toEqual(['r1']);
    });

    describe('a decrease', () => {
        it('updates the amount and says nothing: check kept, flag cleared', () => {
            const plan = diffGroceryList(
                [
                    acknowledgedRow({
                        quantity_grams: 3.1 * GRAMS_PER_POUND,
                        display_quantity: 3.1,
                        display_text: '3.1 lb',
                        flagged_at: EARLIER,
                    }),
                ],
                [massDraft(TWO_AND_A_HALF_LB)],
                chickenFacts,
                NOW,
            );

            expect(plan.updates[0]).toMatchObject({
                quantity_grams: TWO_AND_A_HALF_LB,
                display_text: '2.5 lb',
                flagged_at: null,
                previous_quantity_grams: TWO_AND_A_HALF_LB,
            });
            expect(plan.summary.increased).toBe(0);
        });

        /**
         * A row flagged at 3.1 lb and re-aggregated to 2.9 lb is still above the
         * 2.5 lb the shopper acknowledged, and the flag goes anyway: the amount
         * they were warned about has come back down, so there is nothing left to
         * warn about. The baseline stays put, which is what the next increase is
         * measured from.
         */
        it('clears a standing flag even while the amount is still above what was acknowledged', () => {
            const flaggedRow = acknowledgedRow({
                quantity_grams: 3.1 * GRAMS_PER_POUND,
                display_quantity: 3.1,
                display_text: '3.1 lb',
                flagged_at: EARLIER,
            });
            const plan = diffGroceryList([flaggedRow], [massDraft(2.9 * GRAMS_PER_POUND)], chickenFacts, NOW);
            const decreased = applyUpdate(flaggedRow, plan.updates[0]);

            expect(plan.updates[0]).toMatchObject({
                display_text: '2.9 lb',
                flagged_at: null,
                previous_quantity_grams: TWO_AND_A_HALF_LB,
            });
            expect(plan.summary.increased).toBe(0);
            expect(decreased.is_checked).toBe(true);
            expect(buildGroceryFlag(decreased, facts())).toBeNull();
            expect(bannerFor([decreased], { mealSlot: 'lunch', changedList: true })).toEqual({
                code: 'updated_after_swap',
                mealSlot: 'lunch',
            });
        });

        it('flags a later increase afresh, from the amount the shopper acknowledged', () => {
            const flaggedRow = acknowledgedRow({
                quantity_grams: 3.1 * GRAMS_PER_POUND,
                display_quantity: 3.1,
                display_text: '3.1 lb',
                flagged_at: EARLIER,
            });
            const cleared = applyUpdate(
                flaggedRow,
                diffGroceryList([flaggedRow], [massDraft(2.9 * GRAMS_PER_POUND)], chickenFacts, EARLIER).updates[0],
            );
            const raised = diffGroceryList([cleared], [massDraft(3.1 * GRAMS_PER_POUND)], chickenFacts, NOW);
            const reflagged = applyUpdate(cleared, raised.updates[0]);

            expect(raised.updates[0]).toMatchObject({
                display_text: '3.1 lb',
                flagged_at: NOW,
                previous_quantity_grams: TWO_AND_A_HALF_LB,
            });
            expect(buildGroceryFlag(reflagged, facts())).toEqual({
                previousDisplayText: '2.5 lb',
                newDisplayText: '3.1 lb',
                deltaDisplayText: '+0.6 lb',
                flaggedAt: NOW.toISOString(),
            });
        });

        /**
         * The state a decrease leaves behind — checked, unflagged, and reading
         * more than was acknowledged — is where the same-display exception is
         * easiest to lose: the new amount differs from the 2.5 lb the shopper
         * accepted, so a rule that only compared against the baseline would
         * raise a flag over a gram that moves nothing on the row.
         */
        it('raises no flag for a later increase that does not move the row\u2019s own text', () => {
            const flaggedRow = acknowledgedRow({
                quantity_grams: 3.1 * GRAMS_PER_POUND,
                display_quantity: 3.1,
                display_text: '3.1 lb',
                flagged_at: EARLIER,
            });
            const cleared = applyUpdate(
                flaggedRow,
                diffGroceryList([flaggedRow], [massDraft(2.9 * GRAMS_PER_POUND)], chickenFacts, EARLIER).updates[0],
            );
            const invisible = diffGroceryList(
                [cleared],
                [massDraft(2.9 * GRAMS_PER_POUND + 1)],
                chickenFacts,
                NOW,
            );
            const unflagged = applyUpdate(cleared, invisible.updates[0]);

            expect(invisible.updates[0]).toMatchObject({
                quantity_grams: 2.9 * GRAMS_PER_POUND + 1,
                display_text: '2.9 lb',
                flagged_at: null,
                previous_quantity_grams: TWO_AND_A_HALF_LB,
            });
            expect(invisible.summary.increased).toBe(1);
            expect(buildGroceryFlag(unflagged, facts())).toBeNull();
            expect(bannerFor([unflagged], null)).toBeNull();
        });

        it('does not resurrect the cleared flag on a sub-epsilon re-aggregation', () => {
            const flaggedRow = acknowledgedRow({
                quantity_grams: 3.1 * GRAMS_PER_POUND,
                display_quantity: 3.1,
                display_text: '3.1 lb',
                flagged_at: EARLIER,
            });
            const cleared = applyUpdate(
                flaggedRow,
                diffGroceryList([flaggedRow], [massDraft(2.9 * GRAMS_PER_POUND)], chickenFacts, EARLIER).updates[0],
            );
            const noise = diffGroceryList(
                [cleared],
                [massDraft(2.9 * GRAMS_PER_POUND + 0.2)],
                chickenFacts,
                NOW,
            );

            expect(noise.updates).toEqual([]);
            expect(noise.unchangedItemIds).toEqual(['r1']);
            expect(cleared.flagged_at).toBeNull();
        });
    });

    it('leaves a standing flag exactly as it is when a re-aggregation changes nothing', () => {
        const flaggedRow = acknowledgedRow({
            quantity_grams: 3.1 * GRAMS_PER_POUND,
            display_quantity: 3.1,
            display_text: '3.1 lb',
            flagged_at: EARLIER,
        });
        const plan = diffGroceryList(
            [flaggedRow],
            [draft({ quantity_grams: 3.1 * GRAMS_PER_POUND + 0.2 })],
            chickenFacts,
            NOW,
        );

        expect(plan.updates).toEqual([]);
        expect(plan.unchangedItemIds).toEqual(['r1']);
    });

    it('treats an increase on an unchecked row as nothing more than a new amount', () => {
        const plan = diffGroceryList(
            [row({ id: 'r1', is_checked: false, previous_quantity_grams: null })],
            [massDraft(3.1 * GRAMS_PER_POUND)],
            chickenFacts,
            NOW,
        );

        expect(plan.updates[0]).toMatchObject({
            display_text: '3.1 lb',
            flagged_at: null,
            previous_quantity_grams: null,
        });
    });

    it('records the baseline for a row checked before the column carried one, and flags from it', () => {
        const plan = diffGroceryList(
            [row({ id: 'r1', is_checked: true, previous_quantity_grams: null })],
            [massDraft(3.1 * GRAMS_PER_POUND)],
            chickenFacts,
            NOW,
        );

        expect(plan.updates[0]).toMatchObject({
            previous_quantity_grams: TWO_AND_A_HALF_LB,
            flagged_at: NOW,
        });
    });

    describe('three successive swaps against one acknowledged baseline', () => {
        it('still reads "was 2.5 lb" after every one of them', () => {
            let current = acknowledgedRow();

            for (const grams of [2.6, 2.9, 3.1].map((pounds) => pounds * GRAMS_PER_POUND)) {
                const plan = diffGroceryList([current], [massDraft(grams)], chickenFacts, NOW);
                current = applyUpdate(current, plan.updates[0]);
            }

            expect(current.previous_quantity_grams).toBe(TWO_AND_A_HALF_LB);
            expect(current.display_text).toBe('3.1 lb');
            expect(buildGroceryFlag(current, facts())).toEqual({
                previousDisplayText: '2.5 lb',
                newDisplayText: '3.1 lb',
                deltaDisplayText: '+0.6 lb',
                flaggedAt: NOW.toISOString(),
            });
        });

        it('keeps the instant the flag was first raised', () => {
            const first = diffGroceryList([acknowledgedRow()], [massDraft(2.6 * GRAMS_PER_POUND)], chickenFacts, EARLIER);
            const afterFirst = applyUpdate(acknowledgedRow(), first.updates[0]);
            const second = diffGroceryList([afterFirst], [massDraft(3.1 * GRAMS_PER_POUND)], chickenFacts, NOW);

            expect(first.updates[0].flagged_at).toBe(EARLIER);
            expect(second.updates[0].flagged_at).toBe(EARLIER);
        });
    });

    describe('the unit-family lock', () => {
        it('keeps a mass row in mass when the new candidate would be counted', () => {
            const plan = diffGroceryList(
                [acknowledgedRow()],
                [
                    draft({
                        quantity_grams: 3.1 * GRAMS_PER_POUND,
                        display_quantity: 28,
                        display_unit: COUNT_DISPLAY_UNIT,
                        display_text: '28 eggs',
                    }),
                ],
                [facts({ density_g_per_ml: 1, default_portion: portion({ description: 'egg', unit: 'each', gram_weight: 50 }) })],
                NOW,
            );

            expect(plan.updates[0]).toMatchObject({ display_unit: 'lb', display_text: '3.1 lb' });
        });

        it('still allows a move inside the family, from ounces to pounds', () => {
            const plan = diffGroceryList(
                [row({ id: 'r1', quantity_grams: 450, display_quantity: 15.9, display_unit: 'oz', display_text: '15.9 oz' })],
                [massDraft(600)],
                chickenFacts,
                NOW,
            );

            expect(plan.updates[0]).toMatchObject({ display_unit: 'lb', display_text: '1.3 lb' });
        });
    });

    describe('lines arriving and leaving', () => {
        it('adds a new line unchecked, as a plain insert', () => {
            const newLine = draft({ catalog_food_id: EGG, name: 'Eggs', category: 'protein', sort_order: 1 });
            const plan = diffGroceryList([acknowledgedRow()], [draft(), newLine], [facts(), eggFacts()], NOW);

            expect(plan.inserts).toEqual([newLine]);
            expect(plan.summary.added).toBe(1);
        });

        it('removes a line the new plan does not need, and counts a checked removal', () => {
            const plan = diffGroceryList(
                [
                    acknowledgedRow(),
                    row({ id: 'r2', catalog_food_id: EGG, name: 'Eggs', is_checked: true, sort_order: 1 }),
                ],
                [draft()],
                chickenFacts,
                NOW,
            );

            expect(plan.removals).toEqual([{ id: 'r2', name: 'Eggs', is_checked: true }]);
            expect(plan.summary.removed).toBe(1);
        });

        it('orders removals by their place on the list', () => {
            const plan = diffGroceryList(
                [
                    row({ id: 'late', catalog_food_id: 'late-food', name: 'Late', sort_order: 9 }),
                    row({ id: 'early', catalog_food_id: 'early-food', name: 'Early', sort_order: 1 }),
                ],
                [],
                [],
                NOW,
            );

            expect(plan.removals.map((removal) => removal.id)).toEqual(['early', 'late']);
        });
    });

    it('refuses to re-render a surviving line whose facts are missing', () => {
        expect(() => diffGroceryList([acknowledgedRow()], [massDraft(3.1 * GRAMS_PER_POUND)], [], NOW)).toThrow(
            GroceryDataError,
        );
    });

    it('has nothing to do for an empty plan', () => {
        expect(diffGroceryList([], [], [], NOW)).toEqual({
            inserts: [],
            updates: [],
            removals: [],
            unchangedItemIds: [],
            summary: { added: 0, removed: 0, increased: 0 },
        });
    });
});

/* ---------------------------------------------------------------------------
 * The flag payload
 * ------------------------------------------------------------------------- */

describe('buildGroceryFlag', () => {
    it('reports no flag when the row is not flagged', () => {
        expect(buildGroceryFlag(row({ flagged_at: null, previous_quantity_grams: 1000 }), facts())).toBeNull();
    });

    it('reports no flag rather than inventing a "was" when no baseline was recorded', () => {
        expect(buildGroceryFlag(row({ flagged_at: NOW, previous_quantity_grams: null }), facts())).toBeNull();
    });

    it('renders the delta in the row\u2019s own unit, not a freshly chosen one', () => {
        const flagged = row({
            quantity_grams: 3.1 * GRAMS_PER_POUND,
            display_quantity: 3.1,
            display_unit: 'lb',
            display_text: '3.1 lb',
            previous_quantity_grams: 2.5 * GRAMS_PER_POUND,
            flagged_at: NOW,
        });

        expect(buildGroceryFlag(flagged, facts())).toEqual({
            previousDisplayText: '2.5 lb',
            newDisplayText: '3.1 lb',
            deltaDisplayText: '+0.6 lb',
            flaggedAt: NOW.toISOString(),
        });
    });

    it('renders an ounce delta in ounces', () => {
        const flagged = row({
            quantity_grams: 450,
            display_quantity: 15.9,
            display_unit: 'oz',
            display_text: '15.9 oz',
            previous_quantity_grams: 400,
            flagged_at: NOW,
        });

        expect(buildGroceryFlag(flagged, facts())).toMatchObject({
            previousDisplayText: '14.1 oz',
            deltaDisplayText: '+1.8 oz',
        });
    });

    describe('counts', () => {
        const eggRow = (overrides: Partial<StoredGroceryRow> = {}): StoredGroceryRow =>
            row({
                catalog_food_id: EGG,
                name: 'Eggs',
                quantity_grams: 600,
                display_quantity: 12,
                display_unit: COUNT_DISPLAY_UNIT,
                display_text: '12 eggs',
                flagged_at: NOW,
                ...overrides,
            });

        it('pluralises a delta of more than one', () => {
            expect(buildGroceryFlag(eggRow({ previous_quantity_grams: 500 }), eggFacts())).toMatchObject({
                previousDisplayText: '10 eggs',
                newDisplayText: '12 eggs',
                deltaDisplayText: '+2 eggs',
            });
        });

        it('keeps the singular for a delta of one', () => {
            expect(buildGroceryFlag(eggRow({ previous_quantity_grams: 550 }), eggFacts())).toMatchObject({
                deltaDisplayText: '+1 egg',
            });
        });
    });

    describe('volumes', () => {
        const oilRow = (overrides: Partial<StoredGroceryRow> = {}): StoredGroceryRow =>
            row({
                catalog_food_id: OLIVE_OIL,
                name: 'Olive oil',
                display_unit: 'cups',
                flagged_at: NOW,
                ...overrides,
            });

        it('renders a quarter delta with the singular unit', () => {
            const flagged = oilRow({
                quantity_grams: 1.25 * MILLILITERS_PER_CUP,
                display_quantity: 1.25,
                display_text: '1¼ cups',
                previous_quantity_grams: MILLILITERS_PER_CUP,
            });

            expect(buildGroceryFlag(flagged, oilFacts())).toMatchObject({
                previousDisplayText: '1 cup',
                newDisplayText: '1¼ cups',
                deltaDisplayText: '+¼ cup',
            });
        });

        it('pluralises a delta above one cup', () => {
            const flagged = oilRow({
                quantity_grams: 2.5 * MILLILITERS_PER_CUP,
                display_quantity: 2.5,
                display_text: '2½ cups',
                previous_quantity_grams: MILLILITERS_PER_CUP,
            });

            expect(buildGroceryFlag(flagged, oilFacts())).toMatchObject({ deltaDisplayText: '+1½ cups' });
        });
    });

    /**
     * An increase that promotes the row to a larger unit is, by definition,
     * smaller than one step of the unit it promoted INTO, so the row's own unit
     * can only call it zero — and "was 15.8 oz / Now 1 lb / +0 lb" contradicts
     * itself. The delta is then re-rendered from the family's base units, which
     * is why each case below pins the string AND the family of the unit it
     * lands in: a mass row's delta must still be a mass.
     */
    describe('an increase that crosses a unit-promotion boundary', () => {
        /** The unit word of a delta pill: everything after its last space. */
        const deltaUnitOf = (deltaDisplayText: string): string =>
            deltaDisplayText.slice(deltaDisplayText.lastIndexOf(' ') + 1);

        it('renders the grams rather than +0 lb when ounces promote to pounds', () => {
            const flagged = row({
                quantity_grams: 15.96 * GRAMS_PER_OUNCE,
                display_quantity: 1,
                display_unit: 'lb',
                display_text: '1 lb',
                previous_quantity_grams: 15.8 * GRAMS_PER_OUNCE,
                flagged_at: NOW,
            });

            const flag = buildGroceryFlag(flagged, facts());

            expect(flag).toEqual({
                previousDisplayText: '15.8 oz',
                newDisplayText: '1 lb',
                deltaDisplayText: '+6 g',
                flaggedAt: NOW.toISOString(),
            });
            expect(unitFamily(deltaUnitOf(flag?.deltaDisplayText ?? ''))).toBe('mass');
        });

        it('renders the grams rather than +0 oz when grams promote to ounces', () => {
            const flagged = row({
                quantity_grams: 29,
                display_quantity: 1,
                display_unit: 'oz',
                display_text: '1 oz',
                previous_quantity_grams: 27.8,
                flagged_at: NOW,
            });

            const flag = buildGroceryFlag(flagged, facts());

            expect(flag).toEqual({
                previousDisplayText: '28 g',
                newDisplayText: '1 oz',
                deltaDisplayText: '+1 g',
                flaggedAt: NOW.toISOString(),
            });
            expect(unitFamily(deltaUnitOf(flag?.deltaDisplayText ?? ''))).toBe('mass');
        });

        it('renders the millilitres rather than +0 cup when tablespoons promote to cups', () => {
            /** Real olive oil, so the row's grams and its millilitres differ. */
            const density = 0.92;
            const flagged = row({
                catalog_food_id: OLIVE_OIL,
                name: 'Olive oil',
                quantity_grams: 236 * density,
                display_quantity: 1,
                display_unit: 'cup',
                display_text: '1 cup',
                previous_quantity_grams: 232 * density,
                flagged_at: NOW,
            });

            const flag = buildGroceryFlag(flagged, oilFacts({ density_g_per_ml: density }));

            expect(flag).toEqual({
                previousDisplayText: '15¾ tbsp',
                newDisplayText: '1 cup',
                deltaDisplayText: '+5 ml',
                flaggedAt: NOW.toISOString(),
            });
            expect(unitFamily(deltaUnitOf(flag?.deltaDisplayText ?? ''))).toBe('volume');
        });

        it('names one whole item rather than +0 eggs, the count family having no smaller unit', () => {
            const flagged = row({
                catalog_food_id: EGG,
                name: 'Eggs',
                quantity_grams: 600,
                display_quantity: 12,
                display_unit: COUNT_DISPLAY_UNIT,
                display_text: '12 eggs',
                previous_quantity_grams: 590,
                flagged_at: NOW,
            });

            expect(buildGroceryFlag(flagged, eggFacts())).toMatchObject({ deltaDisplayText: '+1 egg' });
        });
    });
});


/* ---------------------------------------------------------------------------
 * Check marks
 * ------------------------------------------------------------------------- */

describe('applyToggle', () => {
    it('records the amount on screen as the new acknowledged baseline when checking', () => {
        expect(applyToggle({ quantity_grams: 3.1 * GRAMS_PER_POUND }, true, NOW)).toEqual({
            is_checked: true,
            checked_at: NOW,
            previous_quantity_grams: 3.1 * GRAMS_PER_POUND,
            flagged_at: null,
        });
    });

    it('clears the flag when checking, because the user has just seen the amount', () => {
        expect(applyToggle({ quantity_grams: 1000 }, true, NOW).flagged_at).toBeNull();
    });

    it('clears the check, the timestamp, the baseline and the flag when unchecking', () => {
        expect(applyToggle({ quantity_grams: 1000 }, false, NOW)).toEqual({
            is_checked: false,
            checked_at: null,
            previous_quantity_grams: null,
            flagged_at: null,
        });
    });

    it('applies exactly the same update as "Uncheck all" when unchecking one row', () => {
        expect(applyToggle({ quantity_grams: 1000 }, false, NOW)).toEqual(applyUncheckAll());
    });
});

describe('applyUncheckAll', () => {
    it('clears both the checks and the flags', () => {
        expect(applyUncheckAll()).toEqual({
            is_checked: false,
            checked_at: null,
            previous_quantity_grams: null,
            flagged_at: null,
        });
    });
});

/* ---------------------------------------------------------------------------
 * List shape
 * ------------------------------------------------------------------------- */

describe('partitionGroceryList', () => {
    const rows = [
        row({ id: 'pantry', category: 'pantry_other', sort_order: 4 }),
        row({ id: 'produce-late', category: 'produce', sort_order: 2 }),
        row({ id: 'produce-early', category: 'produce', sort_order: 0 }),
        row({ id: 'protein', category: 'protein', sort_order: 1 }),
        row({ id: 'checked-dairy', category: 'dairy_alternatives', sort_order: 3, is_checked: true }),
    ];

    const partition = partitionGroceryList(rows);

    it('emits the aisles in store order, closing with pantry_other', () => {
        expect(partition.sections.map((section) => section.category)).toEqual(['produce', 'protein', 'pantry_other']);
    });

    it('omits an aisle with nothing left to buy in it', () => {
        expect(partition.sections.map((section) => section.category)).not.toContain('dairy_alternatives');
    });

    it('holds the checked rows apart so they stay visible', () => {
        expect(partition.checkedItems.map((item) => item.id)).toEqual(['checked-dairy']);
    });

    it('orders the rows of an aisle by their place on the list', () => {
        expect(partition.sections[0].items.map((item) => item.id)).toEqual(['produce-early', 'produce-late']);
    });

    it('shops an unrecognised aisle code under pantry_other rather than dropping the row', () => {
        const result = partitionGroceryList([row({ id: 'odd', category: 'aisle-99' })]);

        expect(result.sections).toEqual([{ category: 'pantry_other', items: [expect.objectContaining({ id: 'odd' })] }]);
    });

    it('returns an empty list for a plan with no rows', () => {
        expect(partitionGroceryList([])).toEqual({ sections: [], checkedItems: [] });
    });
});

/* ---------------------------------------------------------------------------
 * The banner
 * ------------------------------------------------------------------------- */

describe('bannerFor', () => {
    const flagged = [{ name: 'Chicken breast', flagged_at: NOW }];
    const unflagged = [{ name: 'Chicken breast', flagged_at: null }];

    it('announces an increase, naming the flagged items', () => {
        expect(bannerFor(flagged, null)).toEqual({ code: 'amount_increased', itemNames: ['Chicken breast'] });
    });

    it('names every flagged item, so the client can pluralise its own copy', () => {
        expect(
            bannerFor([...flagged, { name: 'Olive oil', flagged_at: EARLIER }], null),
        ).toEqual({ code: 'amount_increased', itemNames: ['Chicken breast', 'Olive oil'] });
    });

    it('puts a flag ahead of a swap notice', () => {
        expect(bannerFor(flagged, { mealSlot: 'lunch', changedList: true })).toEqual({
            code: 'amount_increased',
            itemNames: ['Chicken breast'],
        });
    });

    it('announces the swap that changed the list when nothing is flagged', () => {
        expect(bannerFor(unflagged, { mealSlot: 'lunch', changedList: true })).toEqual({
            code: 'updated_after_swap',
            mealSlot: 'lunch',
        });
    });

    it('says nothing about a swap that changed no amount', () => {
        expect(bannerFor(unflagged, { mealSlot: 'lunch', changedList: false })).toBeNull();
    });

    it('says nothing when there is nothing to announce', () => {
        expect(bannerFor(unflagged, null)).toBeNull();
    });
});

/* ---------------------------------------------------------------------------
 * Request parsing
 * ------------------------------------------------------------------------- */

const PLAN_ID = '9f8b2c1d-4e5a-4c7b-8d9e-0a1b2c3d4e5f';
const ITEM_ID = '1a2b3c4d-5e6f-4a7b-9c8d-1e2f3a4b5c6d';

describe('parseGroceryListPath', () => {
    it('accepts a v4 UUID', () => {
        expect(parseGroceryListPath({ planId: PLAN_ID })).toEqual({ kind: 'ok', planId: PLAN_ID });
    });

    it('reports a malformed id as a field error rather than throwing', () => {
        expect(parseGroceryListPath({ planId: 'not-a-uuid' })).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'planId must be a UUID',
            details: [{ field: 'planId', code: GROCERY_FIELD_CODES.INVALID_ID }],
        });
    });

    it('rejects a UUID of another version', () => {
        expect(parseGroceryListPath({ planId: '9f8b2c1d-4e5a-1c7b-8d9e-0a1b2c3d4e5f' }).kind).toBe('error');
    });

    it('rejects an absent id', () => {
        expect(parseGroceryListPath({}).kind).toBe('error');
    });
});

describe('parseGroceryItemPath', () => {
    it('accepts two v4 UUIDs', () => {
        expect(parseGroceryItemPath({ planId: PLAN_ID, itemId: ITEM_ID })).toEqual({
            kind: 'ok',
            planId: PLAN_ID,
            itemId: ITEM_ID,
        });
    });

    it('reports both ids at once, so the caller is not sent back twice', () => {
        const parsed = parseGroceryItemPath({ planId: 'nope', itemId: 42 });

        expect(parsed).toMatchObject({
            kind: 'error',
            details: [
                { field: 'planId', code: GROCERY_FIELD_CODES.INVALID_ID },
                { field: 'itemId', code: GROCERY_FIELD_CODES.INVALID_ID },
            ],
        });
    });

    it('reports only the offending id', () => {
        expect(parseGroceryItemPath({ planId: PLAN_ID, itemId: 'nope' })).toMatchObject({
            details: [{ field: 'itemId', code: GROCERY_FIELD_CODES.INVALID_ID }],
        });
    });
});

describe('parseToggleGroceryBody', () => {
    it('accepts the desired state', () => {
        expect(parseToggleGroceryBody({ isChecked: true })).toEqual({ kind: 'ok', payload: { isChecked: true } });
        expect(parseToggleGroceryBody({ isChecked: false })).toEqual({ kind: 'ok', payload: { isChecked: false } });
    });

    it('requires the field', () => {
        expect(parseToggleGroceryBody({})).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'isChecked is required',
            details: [{ field: 'isChecked', code: GROCERY_FIELD_CODES.REQUIRED }],
        });
    });

    it('treats an explicit null as absent', () => {
        expect(parseToggleGroceryBody({ isChecked: null })).toMatchObject({
            details: [{ field: 'isChecked', code: GROCERY_FIELD_CODES.REQUIRED }],
        });
    });

    it('refuses a truthy value that is not a boolean, so a check cannot be set by accident', () => {
        expect(parseToggleGroceryBody({ isChecked: 'true' })).toMatchObject({
            details: [{ field: 'isChecked', code: GROCERY_FIELD_CODES.INVALID_TYPE }],
        });
        expect(parseToggleGroceryBody({ isChecked: 1 })).toMatchObject({
            details: [{ field: 'isChecked', code: GROCERY_FIELD_CODES.INVALID_TYPE }],
        });
    });

    it('rejects a body that is not an object', () => {
        expect(parseToggleGroceryBody(null).kind).toBe('error');
        expect(parseToggleGroceryBody('isChecked').kind).toBe('error');
        expect(parseToggleGroceryBody([{ isChecked: true }]).kind).toBe('error');
    });
});

/* ---------------------------------------------------------------------------
 * Plan writability
 * ------------------------------------------------------------------------- */

describe('requireGroceryWritablePlan', () => {
    const captureError = (act: () => unknown): unknown => {
        try {
            act();
        } catch (error) {
            return error;
        }

        return null;
    };

    const activePlan = {
        id: PLAN_ID,
        status: 'active',
        end_date: '2026-07-11',
        replacement_plan_id: null,
    };

    it('returns an active plan whose week has not ended', () => {
        expect(requireGroceryWritablePlan(activePlan, '2026-07-05')).toBe(activePlan);
    });

    it('still accepts a write on the plan\u2019s last day', () => {
        expect(requireGroceryWritablePlan(activePlan, '2026-07-11')).toBe(activePlan);
    });

    it('refuses a plan whose last date has passed, and says why', () => {
        const error = captureError(() => requireGroceryWritablePlan(activePlan, '2026-07-12'));

        expect(error).toBeInstanceOf(PlanNotActiveError);
        expect((error as PlanNotActiveError).data).toEqual({ reason: 'ended' });
    });

    it('refuses a superseded plan and points at the plan that replaced it', () => {
        const error = captureError(() =>
            requireGroceryWritablePlan(
                { ...activePlan, status: 'superseded', replacement_plan_id: ITEM_ID },
                '2026-07-05',
            ),
        );

        expect(error).toBeInstanceOf(PlanNotActiveError);
        expect((error as PlanNotActiveError).data).toEqual({ replacementPlanId: ITEM_ID });
    });

    it('treats a superseded plan with no resolvable replacement as a data fault, not a 409', () => {
        // A superseded plan always has a successor — regeneration links it in the
        // same transaction — so an unresolved one contradicts itself. The
        // superseded variant promises that id, so it is never answered without
        // one, and the alternative claim (`reason: 'ended'`) would be false.
        expect(() => requireGroceryWritablePlan({ ...activePlan, status: 'superseded' }, '2026-07-05')).toThrow(
            GroceryDataError,
        );
    });

    it('answers a missing plan and a plan that is not the caller\u2019s identically', () => {
        expect(captureError(() => requireGroceryWritablePlan(null, '2026-07-05'))).toBeInstanceOf(PlanNotFoundError);
    });

    describe('malformed day keys', () => {
        it('refuses to judge a lifecycle against a malformed stored date', () => {
            expect(() => requireGroceryWritablePlan({ ...activePlan, end_date: '11-07-2026' }, '2026-07-05')).toThrow(
                GroceryDataError,
            );
        });

        it('refuses to judge a lifecycle against a malformed today', () => {
            expect(() => requireGroceryWritablePlan(activePlan, 'today')).toThrow(GroceryDataError);
        });

        /**
         * The guard asks the shared calendar rule, not the shape alone.
         *
         * Shape is not enough for what this function does with the value: it
         * decides a plan's whole writability by comparing the two keys as
         * strings, and `2026-02-30` compares perfectly well while naming no day
         * at all. A stored `end_date` like that would put the plan's lifecycle
         * on the wrong side of a boundary with nothing to show why.
         */
        it('refuses a stored end_date that is well shaped but names no day', () => {
            expect(() => requireGroceryWritablePlan({ ...activePlan, end_date: '2026-02-30' }, '2026-07-05')).toThrow(
                GroceryDataError,
            );
        });

        it('refuses a today that is well shaped but names no day', () => {
            expect(() => requireGroceryWritablePlan(activePlan, '2026-02-30')).toThrow(GroceryDataError);
        });

        it('still accepts a real leap day on either side of the comparison', () => {
            const leapPlan = { ...activePlan, end_date: '2024-02-29' };

            expect(requireGroceryWritablePlan(leapPlan, '2024-02-29')).toBe(leapPlan);
            expect(() => requireGroceryWritablePlan(leapPlan, '2024-03-01')).toThrow(PlanNotActiveError);
        });
    });
});


/* ---------------------------------------------------------------------------
 * One food across four domains
 *
 * This is the invariant no suite could state while each of them invented its
 * own food and recipe identities: a single committed food followed out of a
 * `recipe_ingredients` row, through the planner's candidate and its portion
 * multiplier, into the aggregated shopping line, and on into the diary
 * snapshot — with the SAME identity and the SAME grams asserted at every hop.
 *
 * The four modules are imported rather than restated. Each is pure, so nothing
 * is mocked: the hop is the real function the real service calls.
 * ------------------------------------------------------------------------- */

describe('one food across recipe, plan, grocery and log', () => {
    const SLUG = 'lemon-herb-chicken-and-rice';
    const VERSION = 2;
    const PORTION_MULTIPLIER = 1.5;
    const MEAL_ID = '45c48cce-2e2d-4fd8-a0a1-9c8a1b2c3d4e';

    /** The recipe's ingredient rows as `recipe.logic.ts` takes them. */
    const recipeIngredients = (): RecipeIngredientSnapshot[] =>
        fixtureIngredientRows(SLUG, VERSION).map((row) => ({
            catalog_food_id: row.catalog_food_id,
            snapshot_name: row.snapshot_name,
            snapshot_provenance: row.snapshot_provenance,
            snapshot_allergen_tags: row.snapshot_allergen_tags,
            snapshot_diet_tags: row.snapshot_diet_tags,
            is_optional: row.is_optional,
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
        }));

    /** The planned meal a week of this plan hands the grocery aggregation. */
    const plannedMeal = (): PlannedMealForGroceries => ({
        yield_servings: recipeVersionRow(SLUG, VERSION).yield_servings,
        portion_multiplier: PORTION_MULTIPLIER,
        ingredients: fixtureIngredientRows(SLUG, VERSION).map((row) => ({
            catalog_food_id: row.catalog_food_id,
            food_state: catalogFood(row.food_source_key).food_state,
            gram_weight: row.gram_weight,
        })),
    });

    /** The catalog facts for every food this recipe touches. */
    const recipeFoodFacts = (): GroceryFoodFacts[] =>
        fixtureIngredientRows(SLUG, VERSION).map((row) => groceryFacts(row.food_source_key));

    it('agrees with recipe.logic about the grams one planned portion takes', () => {
        const version = recipeVersionRow(SLUG, VERSION);
        const chickenRow = fixtureIngredientRows(SLUG, VERSION).find(
            (row) => row.food_source_key === 'usda:9200101',
        );
        const scaled = scaleIngredients(recipeIngredients(), PORTION_MULTIPLIER, version.yield_servings);
        const fromRecipe = scaled.find((entry) => entry.catalogFoodId === CHICKEN);

        expect(chickenRow?.gram_weight).toBe(600);
        expect(version.yield_servings).toBe(4);

        // Hop 1 -> hop 2. Two modules, two implementations, one number.
        expect(fromRecipe?.gramWeight).toBe(225);
        expect(plannedIngredientGrams(chickenRow?.gram_weight as number, version.yield_servings, PORTION_MULTIPLIER))
            .toBe(fromRecipe?.gramWeight);
    });

    /**
     * The committed version as the planner's own candidate shape. Only the
     * three columns this suite's `FixtureRecipeVersion` does not read are
     * stated here (the version's minutes, slots and tier, which the planner
     * suite asserts against the fixture); every identity and every number is
     * the fixture's.
     */
    const planRecipeCandidate = (): PlanRecipeCandidate => {
        const version = recipeVersionRow(SLUG, VERSION);

        return {
            recipe_version_id: version.id,
            recipe_id: version.recipe_id,
            slug: version.recipe_slug,
            version: version.version,
            status: 'current',
            nutrition_provenance: 'source_backed',
            allergen_status: 'known',
            total_minutes: 45,
            meal_slots: ['lunch', 'dinner'],
            budget_tier: 2,
            per_serving: {
                calories: version.per_serving_calories,
                protein: version.per_serving_protein_g,
                carbs: version.per_serving_carbs_g,
                fat: version.per_serving_fat_g,
            },
            ingredients: fixtureIngredientRows(SLUG, VERSION).map((row) => ({
                catalog_food_id: row.catalog_food_id,
                snapshot_name: row.snapshot_name,
                snapshot_provenance: 'source_backed',
                snapshot_allergen_tags: [],
                snapshot_diet_tags: [],
                is_optional: false,
                allergen_status: 'known',
            })),
        };
    };

    it('carries the same identity and grams into the planner candidate', () => {
        const version = recipeVersionRow(SLUG, VERSION);
        const candidates = buildPlanCandidates(
            [planRecipeCandidate()],
            { diet: null, allergens: [], disliked_food_ids: [], disliked_food_groups: [], cooking_time_limit_min: null },
            1,
        );
        const candidate = candidates.find((entry) => entry.portionMultiplier === PORTION_MULTIPLIER);

        expect(candidate).toBeDefined();
        expect(candidate?.recipe.recipe_version_id).toBe(version.id);
        expect(candidate?.recipe.ingredients.map((ingredient) => ingredient.catalog_food_id)).toContain(CHICKEN);
        expect(candidate?.nutrition.calories).toBeCloseTo(version.per_serving_calories * PORTION_MULTIPLIER, 9);

        // The grams the planner implies for that candidate are the grams the
        // grocery aggregation will sum, for the same catalog identity.
        const chickenRow = fixtureIngredientRows(SLUG, VERSION).find(
            (row) => row.catalog_food_id === CHICKEN,
        );

        expect(
            plannedIngredientGrams(
                chickenRow?.gram_weight as number,
                recipeVersionRow(SLUG, VERSION).yield_servings,
                candidate?.portionMultiplier as number,
            ),
        ).toBe(225);
    });

    it('aggregates that portion into a shopping line under the same identity', () => {
        const totals = aggregatePlannedGrams([plannedMeal()]);
        const chickenTotal = totals.find((total) => total.catalog_food_id === CHICKEN);

        expect(chickenTotal).toEqual({ catalog_food_id: CHICKEN, food_state: RAW, quantity_grams: 225 });
        expect(totals.map((total) => total.catalog_food_id)).toEqual(
            [...totals].map((total) => total.catalog_food_id).sort(),
        );
    });

    it('renders the line from the food\u2019s own catalog facts', () => {
        const [chickenLine] = buildGroceryRows([plannedMeal()], recipeFoodFacts()).filter(
            (line) => line.catalog_food_id === CHICKEN,
        );

        expect(chickenLine).toMatchObject({
            catalog_food_id: CHICKEN,
            food_state: RAW,
            name: 'Chicken breast',
            category: 'protein',
            quantity_grams: 225,
        });
        // 225 g in the mass family, which is what chicken's own default portion
        // (100 g) implies.
        expect(chickenLine.display_unit).toBe('oz');
        expect(chickenLine.display_text).toBe('7.9 oz');
    });

    it('sums two planned portions of the same recipe into one line', () => {
        const totals = aggregatePlannedGrams([plannedMeal(), plannedMeal()]);
        const chickenTotal = totals.find((total) => total.catalog_food_id === CHICKEN);

        expect(chickenTotal?.quantity_grams).toBe(450);
    });

    it('writes a diary snapshot for the same recipe version the line came from', () => {
        const version = recipeVersionRow(SLUG, VERSION);
        const snapshot = derivePlannedSnapshot(
            { id: MEAL_ID, recipe_version_id: version.id, portion_multiplier: PORTION_MULTIPLIER },
            {
                id: version.id,
                name: version.name,
                serving_description: version.serving_description,
                per_serving_calories: version.per_serving_calories,
                per_serving_protein_g: version.per_serving_protein_g,
                per_serving_carbs_g: version.per_serving_carbs_g,
                per_serving_fat_g: version.per_serving_fat_g,
            },
        );

        // Hop 4: the entry points back at the same `recipe_versions` row whose
        // ingredient rows produced the 225 g line, and rounds ONCE off the
        // unrounded planned portion.
        expect(snapshot.recipe_version_id).toBe(version.id);
        expect(snapshot.meal_plan_meal_id).toBe(MEAL_ID);
        expect(snapshot.name).toBe(version.name);
        expect(snapshot.calories).toBe(Math.round(version.per_serving_calories * PORTION_MULTIPLIER));
        expect(snapshot.serving_text).toBe(`${PORTION_MULTIPLIER} \u00d7 ${version.serving_description}`);
    });

    it('never merges the dry and cooked rice the catalog publishes as two foods', () => {
        const dry = groceryFacts('usda:9200103');
        const cooked = groceryFacts('usda:9200104');
        const rows = buildGroceryRows(
            [
                meal([
                    { catalog_food_id: cooked.catalog_food_id, food_state: cooked.food_state, gram_weight: 300 },
                    { catalog_food_id: dry.catalog_food_id, food_state: dry.food_state, gram_weight: 100 },
                ]),
            ],
            [dry, cooked],
        );

        // Both rows are display_name 'Brown rice' in the catalog, which is why
        // each line has to say which one it is.
        expect(dry.name).toBe(cooked.name);
        expect(rows.map((line) => [line.name, line.quantity_grams])).toEqual([
            ['Brown rice, cooked', 300],
            ['Brown rice, dry', 100],
        ]);
    });
});
