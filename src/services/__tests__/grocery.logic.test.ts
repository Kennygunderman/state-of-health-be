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
    FoodStatesByName,
    GROCERY_EPSILON_G,
    COUNT_DISPLAY_UNIT,
    GROCERY_FIELD_CODES,
    GroceryConversionFacts,
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
    describesContainerOrServing,
    diffGroceryList,
    displayFamilyForPortion,
    indexFoodStatesByName,
    isGroceryRenderingFault,
    parseGroceryItemPath,
    parseGroceryListPath,
    parseToggleGroceryBody,
    partitionGroceryList,
    plannedIngredientGrams,
    quantitiesAreEqual,
    requireGroceryWritablePlan,
    storedRowFamily,
    volumeDensityFor,
} from '../grocery.logic';
import { PlanNotActiveError, PlanNotFoundError } from '../mealPlanning.errors';
// The other three domains of the cross-domain traversal at the end of this
// file. All four modules are pure, so the traversal calls the real functions.
import { PlanRecipeCandidate, buildPlanCandidates } from '../mealPlan.logic';
import { derivePlannedSnapshot } from '../plannedMealLog.logic';
import { RecipeIngredientSnapshot, scaleIngredients } from '../recipe.logic';
import { ToggleGroceryItemPayload } from '../../types/mealPlanning';
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

    return {
        description: row.description,
        // Carried through rather than defaulted: the portion's `amount` is the
        // divisor `volumeDensityFor` reads its density with, so a fixture that
        // dropped it would state a different density from the row on disk.
        amount: row.amount,
        unit: row.unit,
        gram_weight: row.gram_weight,
    };
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
const PREPARED = 'prepared';

const NOW = new Date('2026-07-05T12:00:00.000Z');
const EARLIER = new Date('2026-07-04T09:30:00.000Z');

/**
 * A portion whose unit is the only thing most cases care about — it is what
 * `displayFamilyForPortion` reads the family off. Left synthetic because these
 * are unit-family probes rather than foods: several pass a unit no catalog food
 * carries (`bottle`), which is exactly the fallback being pinned.
 *
 * `amount: 1` is the default because it is the catalog's commonest value and
 * keeps a case's arithmetic readable; the cases that matter for the density a
 * portion states override it, since `amount` is the divisor.
 */
const portion = (overrides: Partial<GroceryDefaultPortion> = {}): GroceryDefaultPortion => ({
    description: 'breast',
    amount: 1,
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

/**
 * Every pluralisation rule a count row's portion description can meet, as
 * `[singular, plural]` pairs: a plain noun, a sibilant ending taking `-es`, a
 * consonant followed by `y` becoming `-ies`, and each of the irregulars
 * `utils/units.ts` commits to its exceptions map.
 *
 * The rules themselves belong to `utils/units.ts` and are pinned there. What
 * this table adds is the layer: the grocery row's own `display_text` and the
 * three strings of its flag are what the shopper reads, and only `egg` ever
 * reached them — an exception dropped from the map, or a description that
 * stopped being pluralised on the way through the grocery rules, would still
 * have left this suite green.
 */
const PLURAL_DESCRIPTION_CASES: readonly (readonly [string, string])[] = [
    ['carrot', 'carrots'],
    ['squash', 'squashes'],
    ['berry', 'berries'],
    ['egg', 'eggs'],
    ['tomato', 'tomatoes'],
    ['potato', 'potatoes'],
    ['leaf', 'leaves'],
    ['loaf', 'loaves'],
    ['half', 'halves'],
];

/**
 * How much one counted item weighs in the cases above.
 *
 * The module's own ounce factor rather than a decimal, and every quantity those
 * cases pass is a multiple of it, so the item count is exact arithmetic on the
 * portion's stated weight instead of a number that happens to divide.
 */
const COUNTED_PORTION_GRAMS = GRAMS_PER_OUNCE;

/** Count-family facts whose default portion is described by one given word. */
const countedFacts = (description: string): GroceryConversionFacts => ({
    density_g_per_ml: null,
    default_portion: portion({ description, unit: 'each', gram_weight: COUNTED_PORTION_GRAMS }),
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

    /* -----------------------------------------------------------------------
     * The committed recipe that carries an optional ingredient
     *
     * `roasted-carrot-and-lentil-salad` v1 is the one version in the corpus
     * with an `is_optional` row (the Greek yogurt), which is why both the
     * optional-ingredient case and the immutability case below are built from
     * it rather than from an invented recipe.
     * --------------------------------------------------------------------- */

    const OPTIONAL_SLUG = 'roasted-carrot-and-lentil-salad';
    const OPTIONAL_VERSION = 1;
    /** `usda:9200115` — Greek yogurt, plain: the corpus's only optional ingredient. */
    const OPTIONAL_FOOD_KEY = 'usda:9200115';
    const OPTIONAL_PORTION_MULTIPLIER = 1.5;

    /** That optional row, or a failure naming what the fixture no longer carries. */
    const optionalIngredientRow = (): FixtureRecipeIngredient => {
        const ingredient = fixtureIngredientRows(OPTIONAL_SLUG, OPTIONAL_VERSION).find(
            (candidate) => candidate.food_source_key === OPTIONAL_FOOD_KEY,
        );
        if (!ingredient) {
            throw new Error(
                `recipes.fixture.json carries no ${OPTIONAL_FOOD_KEY} ingredient on ${OPTIONAL_SLUG} v${OPTIONAL_VERSION}`,
            );
        }

        return ingredient;
    };

    /** The whole recipe as one planned meal, straight off the fixture rows. */
    const optionalRecipeMeal = (): PlannedMealForGroceries => ({
        yield_servings: recipeVersionRow(OPTIONAL_SLUG, OPTIONAL_VERSION).yield_servings,
        portion_multiplier: OPTIONAL_PORTION_MULTIPLIER,
        ingredients: fixtureIngredientRows(OPTIONAL_SLUG, OPTIONAL_VERSION).map((ingredient) => ({
            catalog_food_id: ingredient.catalog_food_id,
            food_state: catalogFood(ingredient.food_source_key).food_state,
            gram_weight: ingredient.gram_weight,
        })),
    });

    /** The grams one planned portion of a fixture ingredient contributes. */
    const optionalRecipeGramsOf = (ingredient: FixtureRecipeIngredient): number =>
        (ingredient.gram_weight / recipeVersionRow(OPTIONAL_SLUG, OPTIONAL_VERSION).yield_servings) *
        OPTIONAL_PORTION_MULTIPLIER;

    /**
     * An OPTIONAL ingredient is shopped for exactly like a required one.
     *
     * AAP §0.7.3 lists every nutritive ingredient — oils, dressings and the
     * optional ones alike — and counts them for eligibility and for groceries
     * alike, so the aggregation takes `recipe_ingredients` rows with no
     * `is_optional` filter at all. A filter added here would drop the yogurt
     * from the shop while the recipe still cooks with it, which is the
     * regression these cases pin.
     */
    describe('an optional nutritive ingredient', () => {
        it('is genuinely optional in the committed corpus', () => {
            // Read off the row itself, so this case cannot quietly stop being
            // about an optional ingredient if the corpus is regenerated.
            expect(optionalIngredientRow().is_optional).toBe(true);
            expect(optionalIngredientRow().snapshot_name).toBe('Greek yogurt, plain');
        });

        it('contributes its planned grams under its own identity', () => {
            const ingredient = optionalIngredientRow();
            const total = aggregatePlannedGrams([optionalRecipeMeal()]).find(
                (candidate) => candidate.catalog_food_id === ingredient.catalog_food_id,
            );

            // 170 g over a yield of 3, at 1.5 planned portions. Stated as that
            // arithmetic over the fixture's own numbers rather than as a
            // decimal, so the case cannot disagree with the corpus it reads.
            expect(total).toEqual({
                catalog_food_id: ingredient.catalog_food_id,
                food_state: AS_PURCHASED,
                quantity_grams: optionalRecipeGramsOf(ingredient),
            });
        });

        it('reaches a real shopping line, in its own aisle and under its own name', () => {
            const ingredient = optionalIngredientRow();
            const recipeFoodFacts = fixtureIngredientRows(OPTIONAL_SLUG, OPTIONAL_VERSION).map((candidate) =>
                groceryFacts(candidate.food_source_key),
            );
            const rows = buildGroceryRows([optionalRecipeMeal()], recipeFoodFacts);

            // `dairy` is the catalog category; `dairy_alternatives` is the aisle
            // `catalog.logic.ts` collapses it onto. The line renders in the mass
            // family because the food's default portion is the 170 g container,
            // and 85 g lands on the column's two decimals with nothing to round.
            expect(catalogFood(OPTIONAL_FOOD_KEY).category).toBe('dairy');
            expect(rows.find((line) => line.catalog_food_id === ingredient.catalog_food_id)).toMatchObject({
                food_state: AS_PURCHASED,
                category: 'dairy_alternatives',
                // `as_purchased` describes the form the CATALOG measured the
                // yogurt in, which is how every shop sells it, so the shopping
                // line is the food's own name: §0.7.3's suffix rule renders the
                // state's shopper label, and this state's is empty.
                name: 'Greek yogurt, plain',
                quantity_grams: optionalRecipeGramsOf(ingredient),
                display_unit: 'oz',
                display_text: '3 oz',
            });
            // Every ingredient the recipe lists is shopped for, the optional one
            // included — a dropped line would shorten this list.
            expect(rows).toHaveLength(fixtureIngredientRows(OPTIONAL_SLUG, OPTIONAL_VERSION).length);
        });
    });

    /**
     * The aggregation never writes to the caller's data.
     *
     * The meals it receives are the rows the service has just read, and an
     * "optimisation" that accumulated into a caller's ingredient row would
     * corrupt the very plan it is summing — invisibly, because the first pass
     * would still add up. `Object.freeze` is deliberate rather than
     * decorative: the emitted test module is strict-mode, so an in-place write
     * to a frozen input throws `TypeError` instead of passing unnoticed. The
     * structural clone catches everything freezing cannot state — a key added,
     * a row reordered, an array pushed to.
     */
    describe('the caller\u2019s meals and ingredients', () => {
        /** Freezes the whole graph: each ingredient, each ingredient list, each meal, the list of meals. */
        const deepFreezeMeals = (meals: PlannedMealForGroceries[]): readonly PlannedMealForGroceries[] => {
            for (const plannedMeal of meals) {
                for (const ingredient of plannedMeal.ingredients) {
                    Object.freeze(ingredient);
                }

                Object.freeze(plannedMeal.ingredients);
                Object.freeze(plannedMeal);
            }

            return Object.freeze(meals);
        };

        it('come back unmodified, and twice over the same input gives the same totals', () => {
            const meals = [
                meal([{ catalog_food_id: CHICKEN, gram_weight: 400 }, { catalog_food_id: EGG, gram_weight: 50 }], {
                    yield_servings: 2,
                    portion_multiplier: 1.5,
                }),
                meal([{ catalog_food_id: CHICKEN, gram_weight: 200 }]),
            ];
            const beforeAggregating = structuredClone(meals);
            const frozen = deepFreezeMeals(meals);

            const first = aggregatePlannedGrams(frozen);
            const second = aggregatePlannedGrams(frozen);

            expect(first).toEqual([
                { catalog_food_id: CHICKEN, food_state: RAW, quantity_grams: 500 },
                { catalog_food_id: EGG, food_state: RAW, quantity_grams: 37.5 },
            ]);
            expect(second).toEqual(first);
            expect(meals).toEqual(beforeAggregating);
        });

        it('come back unmodified for the committed recipe too, optional row included', () => {
            const meals = [optionalRecipeMeal()];
            const beforeAggregating = structuredClone(meals);
            const frozen = deepFreezeMeals(meals);

            const first = aggregatePlannedGrams(frozen);
            const second = aggregatePlannedGrams(frozen);

            // Every identity is distinct and every id is a uuid of one length,
            // so ordering these by `catalog_food_id` is the same order the
            // module's own identity sort produces.
            const expected = fixtureIngredientRows(OPTIONAL_SLUG, OPTIONAL_VERSION)
                .map((ingredient) => ({
                    catalog_food_id: ingredient.catalog_food_id,
                    food_state: catalogFood(ingredient.food_source_key).food_state,
                    quantity_grams: optionalRecipeGramsOf(ingredient),
                }))
                .sort((a, b) => (a.catalog_food_id < b.catalog_food_id ? -1 : 1));

            expect(first).toEqual(expected);
            expect(second).toEqual(first);
            expect(meals).toEqual(beforeAggregating);
        });
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

/**
 * The density a volume row is rendered through.
 *
 * THE SHIPPED SHAPE these cases exist for: catalog release v1 publishes 10,928
 * foods, every one `nutrition_basis: per_100g` with `density_g_per_ml` NULL, and
 * 4,568 of them state their default portion in a volume unit. The committed
 * fixture carries the same shape in `ai:beverage:cold brew coffee
 * concentrate:prepared` (1 cup / 240 g / density null), so the derivation is
 * exercised against a row on disk and not only against a synthetic one.
 */
describe('volumeDensityFor', () => {
    it('prefers the food\u2019s own stored density, which is the curated authority', () => {
        // `usda:9200113` soy sauce: density 1.2 stored, and a 1 tbsp / 18 g
        // portion that would imply 1.217. The stored figure wins, so a
        // `per_100ml` food keeps converting through the number its nutrition
        // was computed with.
        expect(volumeDensityFor(groceryFacts('usda:9200113'))).toBe(1.2);
    });

    it('derives the density from the default portion when the food stores none', () => {
        // The shipped shape, from the fixture: a cup of this weighs 240 g.
        expect(volumeDensityFor(groceryFacts('ai:beverage:cold brew coffee concentrate:prepared'))).toBeCloseTo(
            240 / MILLILITERS_PER_CUP,
            10,
        );
    });

    it('divides the portion\u2019s amount out, so a two-tablespoon portion is not read as one', () => {
        expect(
            volumeDensityFor({
                density_g_per_ml: null,
                default_portion: portion({ description: '2 tbsp', amount: 2, unit: 'tbsp', gram_weight: 30 }),
            }),
        ).toBeCloseTo(30 / (2 * MILLILITERS_PER_TABLESPOON), 10);
    });

    it.each([
        ['zero', 0],
        ['negative', -1],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('ignores a %s stored density and falls back to the portion', (_case, density) => {
        expect(
            volumeDensityFor({
                density_g_per_ml: density,
                default_portion: portion({ description: '1 cup', unit: 'cup', gram_weight: 240 }),
            }),
        ).toBeCloseTo(240 / MILLILITERS_PER_CUP, 10);
    });

    it('answers null for a food whose portion is not measured by volume', () => {
        // Chicken breast: a 100 g default portion. Grams per gram is not a
        // density, so there is nothing to convert through.
        expect(volumeDensityFor(facts())).toBeNull();
    });

    it('answers null for a volume portion with no usable gram weight', () => {
        // The shape validation quarantines as `missing_gram_weight`, which the
        // fixture also carries in `ai:prepared_meal:vegetable barley soup cup`:
        // a cup of something whose weight nobody recorded states no density.
        expect(
            volumeDensityFor({
                density_g_per_ml: null,
                default_portion: portion({ description: '1 cup', unit: 'cup', gram_weight: 0 }),
            }),
        ).toBeNull();
    });

    it('answers null for a food with no default portion at all', () => {
        expect(volumeDensityFor({ density_g_per_ml: null, default_portion: null })).toBeNull();
    });
});

describe('displayFamilyForPortion', () => {
    const withPortion = (overrides: Partial<GroceryDefaultPortion>): GroceryConversionFacts => ({
        density_g_per_ml: null,
        default_portion: portion(overrides),
    });

    it('reads the family off the default portion unit', () => {
        expect(displayFamilyForPortion(withPortion({ unit: 'oz' }))).toBe('mass');
        expect(displayFamilyForPortion(withPortion({ unit: 'tbsp', gram_weight: 14 }))).toBe('volume');
        expect(displayFamilyForPortion(withPortion({ unit: 'each' }))).toBe('count');
    });

    it('falls back to mass for a container unit, which is never generated', () => {
        expect(displayFamilyForPortion(withPortion({ description: 'bottle', unit: 'bottle' }))).toBe('mass');
    });

    it('falls back to mass when the food has no default portion', () => {
        expect(displayFamilyForPortion({ density_g_per_ml: null, default_portion: null })).toBe('mass');
    });

    /*
     * A COUNT-FAMILY TOKEN IS NOT A COUNTABLE ITEM.
     *
     * `each` is the generic token catalog release v1 gives every non-metric
     * portion, so a container and a regulatory reference amount both arrive in
     * the count family — 702 of its 3,022 count-family default portions
     * describe one or the other. Counting those prints the free-text
     * description as the shopping unit ("2 cans, drained"), which is the
     * unsized container line §0.1.4 rules out and §6 of
     * `docs/meal-planning/planning-policy.md` repeats: quantities are measured
     * and container units are never generated.
     *
     * THE CORPUS BELOW IS THE POINT OF THIS BLOCK. The rule is a closed word
     * set plus a closed phrase set, so what it is worth testing is the
     * BOUNDARY it draws over the data it is closed against: one case per form
     * family release v1 actually ships, on both sides, quoted verbatim from
     * `data/meal-planning/catalog/releases/v1/portions.jsonl` with the number
     * of rows the release holds of that exact description. The sweep at the end
     * re-derives the split from that file, so neither an over-eager addition
     * nor a missing form can pass unnoticed.
     */
    describe('a portion that describes a container or a serving', () => {
        /**
         * THE DISQUALIFIED CORPUS: `[what the form is, the release's own
         * description, how many rows of it release v1 holds]`.
         *
         * One case per form family, and the first is literally `usda:173800`
         * (Chickpeas, canned) and `usda:174285` (Kidney beans, canned) —
         * `{amount: 1, unit: 'each', description: '1 can, drained'}` at 253 g
         * and 266 g, both ingredients of the seeded recipes, so it is the case
         * the shipped plan would have rendered as cans.
         *
         * Three groups: VESSELS (the package, not its contents), SERVING AND
         * REFERENCE AMOUNTS (a tabulation unit), and DOSES AND SINGLE-SERVE
         * REFERENCES (an amount dispensed). The composite forms are here for a
         * second reason — "regular microwave bag", "container refrigerated
         * 4 oz", "serving 1/2 cup", "kids meal order" and "package without
         * flavor packet" put the disqualifying word before the noun, after it,
         * or in the word the description EXCLUDES, which is why the scan reads
         * every word instead of the head noun.
         *
         * The unit token is fixed at `each` throughout: this table is about the
         * DESCRIPTION, and `each` is the token the release gives almost all of
         * these rows anyway. The sweep at the end exercises each row's own
         * stored unit.
         */
        const CONTAINER_FORMS: Array<[string, string, number]> = [
            // Vessels — the package, not its contents.
            ['a drained can, as usda:173800 and usda:174285 both state it', '1 can, drained', 2],
            ['a bare can', 'can', 7],
            ['a can sized in fluid ounces', 'can (6 fl oz)', 5],
            ['a container with no size stated', 'container, NFS', 30],
            ['a container sized in a parenthesis', 'container (6 oz)', 18],
            ['a bare package', 'package', 15],
            ['a package sized in a parenthesis', 'package (10 oz)', 12],
            ['a packet', 'packet', 10],
            ['a branded jar', 'jar, Gerber (4 oz)', 4],
            ['a bottle', 'bottle', 2],
            ['a pouch', 'pouch', 1],
            ['a branded envelope', 'envelope Alba (.675 oz)', 1],
            ['a bag qualified before the noun', 'regular microwave bag', 9],
            ['a branded serving bowl', 'KFC Bowl', 1],
            ['a container qualified after the noun', 'container refrigerated 4 oz', 1],
            ['a package whose second vessel word is what it excludes', 'package without flavor packet', 3],
            // Servings and reference amounts — a tabulation unit, not an item.
            ['a bare serving', 'serving', 100],
            ['a serving whose vessel word leads the description', 'serving 1/2 cup', 10],
            ['a serving counted per package', 'serving 9 servings per 24 oz package', 1],
            ['a regulatory serving', 'NLEA serving', 3],
            ['a bare regulatory reference amount', 'RACC', 172],
            ['a restaurant order', 'order', 4],
            ['a kids meal order', 'kids meal order', 3],
            ['a frozen meal', 'meal (11 oz)', 2],
            ['a branded frozen dinner', 'Swanson Salisbury Steak Dinner (11 oz)', 1],
            ['an item of unstated size', 'item, any size', 27],
            ['a unit stated through a yield', 'unit (yield from 1 lb ready-to-cook chicken)', 44],
            // Doses and single-serve references — an amount dispensed.
            ['a bare scoop', 'scoop', 4],
            ['a scoop written with its amount', '1 scoop', 1],
            ['a scoop with no size stated', 'scoop, NFS', 1],
            ['a branded scoop', 'scoop Gold Standard', 1],
            ['a recipe\u2019s whole yield, matched as a phrase', 'recipe yield', 2],
            ['an individual serving sized in fluid ounces', 'individual (3.5 fl oz)', 4],
            ['an individual serving offered as a size', 'small/individual', 10],
            ['an individual packet', 'individual packet', 4],
            ['an individual container', 'container, individual', 2],
        ];

        it.each(CONTAINER_FORMS)('recognises %s: "%s" (%i release rows)', (_case, description) => {
            expect(describesContainerOrServing(description)).toBe(true);
        });

        it.each(CONTAINER_FORMS)('weighs %s: "%s" (%i release rows)', (_case, description) => {
            expect(displayFamilyForPortion(withPortion({ description, unit: 'each', gram_weight: 253 }))).toBe('mass');
        });

        it.each(CONTAINER_FORMS)('measures %s as a volume when the food states a density: "%s" (%i release rows)', (_case, description) => {
            expect(
                displayFamilyForPortion({
                    density_g_per_ml: 1,
                    default_portion: portion({ description, unit: 'each', gram_weight: 253 }),
                }),
            ).toBe('volume');
        });

        /**
         * THE ALLOWED CORPUS, half one: a real ITEM NOUN, which is a thing a
         * shopper buys a number of. `[the release's own description, how many
         * rows of it release v1 holds]`.
         *
         * This is the half a keyword scan is most likely to break, and it is
         * 2,320 of the 3,022 rows — a word admitted carelessly takes hundreds
         * of truthful count lines with it.
         */
        const ITEM_NOUN_FORMS: Array<[string, number]> = [
            ['slice', 103],
            ['piece', 138],
            ['sandwich', 79],
            ['fillet', 58],
            ['patty', 34],
            ['chop', 6],
            ['link', 12],
            ['sausage', 2],
            ['drumstick', 3],
            ['thigh', 2],
            ['wing, any size', 13],
            ['breast', 1],
            ['leg', 1],
            ['egg', 114],
            ['1 clove', 1],
            ['1 apple, medium', 1],
            ['1 avocado', 1],
            ['banana', 2],
            ['1 carrot, medium', 1],
            ['stalk', 2],
            ['pepper', 7],
            ['1 lemon', 1],
            ['1 lime', 1],
            ['baby potato', 29],
            ['1 tomato, medium', 1],
            ['olive', 5],
            ['5 sprigs', 1],
            ['cookies', 13],
            ['crackers', 5],
            ['waffle', 2],
            ['pancake', 1],
            ['muffin', 18],
            ['roll', 16],
            ['bagel', 2],
            ['bar', 48],
            ['cone', 15],
            ['cube', 6],
            ['wedge (1.33 oz)', 2],
            ['pat (1" sq, 1/3" high)', 2],
            ['spear', 4],
            ['leaf', 11],
            ['berry', 6],
            ['cake', 16],
            ['pie', 1],
            ['pizza', 1],
            ['each taco', 3],
            ['burrito', 3],
            ['enchilada, any size', 5],
            ['tortilla', 2],
            ['small pita', 3],
            ['pretzel stick', 2],
            ['pickle, any size', 1],
            ['ball', 2],
            ['tablet', 1],
        ];

        /**
         * THE ALLOWED CORPUS, half two: an item USDA describes through its
         * YIELD, which is why `yield` and `refuse` are absent from the word set
         * and "recipe yield" is matched as a phrase instead. Every one of these
         * is a countable chop, rib, steak, pod, fruit or ear.
         */
        const YIELD_FORMS: Array<[string, number]> = [
            ['chop without refuse (Yield from 1 cooked chop, with refuse, weighing 172g)', 1],
            ['rib (yield after cooking, bone removed)', 2],
            ['steak (yield from 181 g raw meat)', 1],
            ['pod, yields', 1],
            ['fruit without refuse', 5],
            ['ear (yield after cooking)', 1],
        ];

        /**
         * THE ALLOWED CORPUS, half three, and the documented BOUNDARY of the
         * rule: a bare size or grade label with no item noun STAYS COUNTED.
         *
         * These are terse labels the catalog wrote on a countable item — not a
         * container and not a serving reference — so counting them prints the
         * item the shopper buys a number of. Measuring them instead would be a
         * scope decision neither §0.1.4 nor §6.2 asks for, and on these four
         * descriptions alone it would silently re-unit 261 rows.
         */
        const SIZE_LABEL_FORMS: Array<[string, number]> = [
            ['regular', 104],
            ['miniature', 75],
            ['miniature/bite size', 67],
            ['whole', 13],
            ['bite size', 2],
            ['slice, any size', 29],
            ['cubic inch', 14],
            ['small', 49],
            ['large', 11],
            ['medium', 4],
        ];

        it.each(ITEM_NOUN_FORMS)('keeps counting the item form "%s" (%i release rows)', (description) => {
            expect(describesContainerOrServing(description)).toBe(false);
            expect(displayFamilyForPortion(withPortion({ description, unit: 'each', gram_weight: 50 }))).toBe('count');
        });

        it.each(YIELD_FORMS)('keeps counting "%s", a real item described through its yield (%i release rows)', (description) => {
            expect(describesContainerOrServing(description)).toBe(false);
            expect(displayFamilyForPortion(withPortion({ description, unit: 'each', gram_weight: 50 }))).toBe('count');
        });

        it.each(SIZE_LABEL_FORMS)('keeps counting the bare size label "%s" (%i release rows)', (description) => {
            expect(describesContainerOrServing(description)).toBe(false);
            expect(displayFamilyForPortion(withPortion({ description, unit: 'each', gram_weight: 50 }))).toBe('count');
        });

        /*
         * The count portions the seeded recipes actually rely on, each with the
         * unit token the release stores beside it rather than the `each` the
         * tables above fix — the descriptions and the tokens vary independently
         * and both reach `count`.
         */
        const SEEDED_RECIPE_COUNT_PORTIONS: Array<[string, string]> = [
            ['1 egg, large', 'each'],
            ['1 clove', 'clove'],
            ['1 apple, medium', 'each'],
            ['5 sprigs', 'each'],
            ['1 olive, large', 'each'],
            ['1 slice', 'slice'],
            ['piece', 'piece'],
            ['whole', 'whole'],
        ];

        it.each(SEEDED_RECIPE_COUNT_PORTIONS)('keeps counting "%s", stored in the release as a %s portion', (description, unit) => {
            expect(describesContainerOrServing(description)).toBe(false);
            expect(displayFamilyForPortion(withPortion({ description, unit, gram_weight: 50 }))).toBe('count');
        });

        const WORDLESS_DESCRIPTIONS: Array<[string, string]> = [
            ['a description of digits alone', '12'],
            ['an empty description', ''],
        ];

        it.each(WORDLESS_DESCRIPTIONS)('finds no container word in %s, so the row still counts', (_case, description) => {
            expect(describesContainerOrServing(description)).toBe(false);
            expect(displayFamilyForPortion(withPortion({ description, unit: 'each', gram_weight: 50 }))).toBe('count');
        });

        it('still weighs a container description whose portion has no gram weight either', () => {
            expect(displayFamilyForPortion(withPortion({ description: '1 can, drained', unit: 'each', gram_weight: 0 }))).toBe(
                'mass',
            );
        });

        /* -------------------------------------------------------------------
         * The corpus the two lists are closed against
         *
         * Read off disk, like every other release- or fixture-derived case in
         * this file, and classified once: 3,454 default portions whose stored
         * unit token resolves to the count family, every one of them put
         * through the real predicate and the real family decision.
         *
         * WHY THE TOTALS ARE ASSERTED. A closed word list is only as good as
         * the data it was closed against, and both directions can regress
         * silently: a word added carelessly (`yield`, `whole`, `regular`) moves
         * hundreds of countable rows onto the scales, and a form family left
         * out prints a unit the data cannot size. The totals below move the
         * moment either happens.
         * ----------------------------------------------------------------- */
        describe('the release corpus the word and phrase sets are closed against', () => {
            /** `catalog_food_portions` as the release publishes them, one JSON object per line. */
            interface ReleasePortion {
                food_source_key: string;
                description: string;
                amount: number;
                unit: string;
                gram_weight: number;
                is_default: boolean;
            }

            const RELEASE_PORTIONS_PATH = join(
                __dirname,
                '..',
                '..',
                '..',
                'data',
                'meal-planning',
                'catalog',
                'releases',
                'v1',
                'portions.jsonl',
            );

            /**
             * Every DEFAULT portion whose stored unit token is a count one —
             * the exact population `displayFamilyForPortion` takes this
             * decision for. `unitFamily` decides what "count" means here, so
             * the test cannot disagree with the module about the token set.
             */
            const countFamilyDefaults: readonly ReleasePortion[] = readFileSync(RELEASE_PORTIONS_PATH, 'utf8')
                .split('\n')
                .filter((line) => line.trim().length > 0)
                .map((line) => JSON.parse(line) as ReleasePortion)
                .filter((row) => row.is_default && unitFamily(row.unit) === 'count');

            const disqualified = countFamilyDefaults.filter((row) => describesContainerOrServing(row.description));
            const counted = countFamilyDefaults.filter((row) => !describesContainerOrServing(row.description));

            /** Rows of each exact description, for the verbatim check below. */
            const rowsPerDescription = countFamilyDefaults.reduce<Map<string, number>>((tally, row) => {
                tally.set(row.description, (tally.get(row.description) ?? 0) + 1);

                return tally;
            }, new Map());

            const wordsOf = (description: string): string[] => description.toLowerCase().match(/[a-z]+/g) ?? [];

            it('holds 3,454 default portions in the count family', () => {
                expect(countFamilyDefaults).toHaveLength(3454);
            });

            it('measures 776 of them and keeps 2,678 counting', () => {
                expect(disqualified).toHaveLength(776);
                expect(counted).toHaveLength(2678);
            });

            it('quotes every form of the tables above verbatim, at the row count each states', () => {
                const quoted: Array<[string, number]> = [
                    ...CONTAINER_FORMS.map(([, description, rows]): [string, number] => [description, rows]),
                    ...ITEM_NOUN_FORMS,
                    ...YIELD_FORMS,
                    ...SIZE_LABEL_FORMS,
                ];

                // A form's stated row count is READ OFF THIS RELEASE, and a
                // count of zero is a real answer rather than a missing one: the
                // tables are the closed set of description SHAPES the predicate
                // must decide correctly, and which of them a given release
                // happens to ship is a property of the catalog, not of the rule.
                // Every shape below is shipped by at least one row of the
                // current release, but that is this release's property rather
                // than the rule's: the nine that shipped no row before the
                // catalog grew stayed here as predicate cases at zero rows,
                // asserted exactly as the rest are. Defaulting an absent
                // description to 0 is therefore the comparison, not a way of
                // skipping one.
                for (const [description, rows] of quoted) {
                    expect(rowsPerDescription.get(description) ?? 0).toBe(rows);
                }
            });

            it('puts not one of the 776 in the count family', () => {
                for (const row of disqualified) {
                    expect(displayFamilyForPortion({ density_g_per_ml: null, default_portion: row })).toBe('mass');
                }
            });

            it('counts every one of the 2,678, all of which state a positive gram weight', () => {
                for (const row of counted) {
                    expect(row.gram_weight).toBeGreaterThan(0);
                    expect(displayFamilyForPortion({ density_g_per_ml: null, default_portion: row })).toBe('count');
                }
            });

            /*
             * The phrase set's whole reason for existing: `yield` as a bare
             * word would move all 52 of these onto the scales, so the two
             * "recipe yield" rows are matched as a run of two whole words
             * instead.
             */
            it('keeps counting the 52 rows that describe an item through its yield', () => {
                const mentionsAYield = (row: ReleasePortion): boolean =>
                    wordsOf(row.description).includes('yield') || wordsOf(row.description).includes('yields');

                expect(counted.filter(mentionsAYield)).toHaveLength(52);
                expect(countFamilyDefaults.filter((row) => row.description === 'recipe yield')).toHaveLength(2);
                expect(counted.filter((row) => row.description === 'recipe yield')).toHaveLength(0);
            });

            it('measures every scoop and every individual serving the release ships', () => {
                const scoops = countFamilyDefaults.filter((row) => wordsOf(row.description).includes('scoop'));
                const individuals = countFamilyDefaults.filter((row) => wordsOf(row.description).includes('individual'));

                expect(scoops).toHaveLength(7);
                expect(individuals).toHaveLength(20);
                expect(counted.filter((row) => wordsOf(row.description).includes('scoop'))).toHaveLength(0);
                expect(counted.filter((row) => wordsOf(row.description).includes('individual'))).toHaveLength(0);
            });
        });
    });

    describe('a row is only put in a family it can actually be rendered in', () => {
        // THE SHIPPED SHAPE, and the reason this function takes the facts rather
        // than the portion alone. A volume-unit default portion against a null
        // `density_g_per_ml` is what all 4,568 volume-portion foods of release v1
        // look like; 41 of the 42 seeded recipes carry at least one. It renders
        // as a volume because the portion itself states the density.
        it('chooses volume for a density-less food whose portion states one', () => {
            expect(displayFamilyForPortion(groceryFacts('ai:beverage:cold brew coffee concentrate:prepared'))).toBe(
                'volume',
            );
        });

        // The degradation, and it is a DEGRADATION rather than a failure: grams
        // are what was actually measured, so a food that can state no density at
        // all is weighed. Failing instead would take the whole shopping list —
        // and with it the plan publication and every swap — down over one row's
        // unit.
        it('weighs a volume-portion food that can state no density, instead of throwing', () => {
            expect(displayFamilyForPortion(withPortion({ description: '1 cup', unit: 'cup', gram_weight: 0 }))).toBe(
                'mass',
            );
        });

        it('weighs a count-portion food whose portion has no gram weight to divide by', () => {
            // `requireCountPortion` would refuse this portion when the amount is
            // rendered, so choosing `count` for it would pick a family the row
            // cannot be shown in.
            expect(displayFamilyForPortion(withPortion({ unit: 'each', gram_weight: 0 }))).toBe('mass');
        });

        it('is total: every family it answers can render the grams it was chosen for', () => {
            const CASES: readonly GroceryConversionFacts[] = [
                groceryFacts('ai:beverage:cold brew coffee concentrate:prepared'),
                groceryFacts('usda:9200109'),
                groceryFacts('usda:9200107'),
                facts(),
                withPortion({ description: '1 cup', unit: 'cup', gram_weight: 0 }),
                withPortion({ unit: 'each', gram_weight: 0 }),
                withPortion({ description: 'bottle', unit: 'bottle' }),
                withPortion({ description: '1 can, drained', unit: 'each', gram_weight: 253 }),
                {
                    density_g_per_ml: 1,
                    default_portion: portion({ description: 'RACC', unit: 'each', gram_weight: 85 }),
                },
                { density_g_per_ml: null, default_portion: null },
            ];

            for (const candidate of CASES) {
                const family = displayFamilyForPortion(candidate);

                expect(() => buildGroceryDisplay(500, family, candidate)).not.toThrow();
            }
        });
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

        /**
         * The whole container-portion path end to end, on the release's own
         * data: the family decision and the rendering together, for BOTH foods
         * it applies to — the two canned legumes the seeded recipes actually
         * use.
         *
         * Release v1 ships each of them as
         * `{amount: 1, unit: 'each', description: '1 can, drained'}` with
         * `density_g_per_ml: null`, differing only in what the can weighs:
         * `usda:173800` (Chickpeas, canned) 253 g, `usda:174285` (Kidney
         * beans, canned) 266 g. One can's worth and two cans' worth are the
         * amounts a real plan aggregates — a recipe using a whole can, planned
         * once and planned twice — and each reads as the weight the
         * aggregation measured, never as "1 can, drained" or "2 cans,
         * drained". The api suite asserts the same four strings on the wire.
         */
        describe('a food whose default portion is a container', () => {
            /** `[the release food, one can in grams, one can rendered, two cans rendered]`. */
            const CANNED_LEGUMES: Array<[string, number, string, string]> = [
                ['usda:173800 (Chickpeas, canned)', 253, '8.9 oz', '1.1 lb'],
                ['usda:174285 (Kidney beans, canned)', 266, '9.4 oz', '1.2 lb'],
            ];

            const cannedFacts = (canGrams: number): GroceryConversionFacts => ({
                density_g_per_ml: null,
                default_portion: portion({ description: '1 can, drained', unit: 'each', gram_weight: canGrams }),
            });

            const renderAsBuilt = (grams: number, canGrams: number): string => {
                const facts = cannedFacts(canGrams);

                return buildGroceryDisplay(grams, displayFamilyForPortion(facts), facts).text;
            };

            it.each(CANNED_LEGUMES)('reads one can of %s as the ounces it weighs', (_food, canGrams, oneCan) => {
                expect(renderAsBuilt(canGrams, canGrams)).toBe(oneCan);
            });

            it.each(CANNED_LEGUMES)('promotes two cans of %s to pounds, still as a measure', (_food, canGrams, _oneCan, twoCans) => {
                expect(renderAsBuilt(2 * canGrams, canGrams)).toBe(twoCans);
            });

            it.each(CANNED_LEGUMES)('never puts the container word in the shopping line for %s', (_food, canGrams) => {
                expect(renderAsBuilt(canGrams, canGrams)).not.toMatch(/can/i);
                expect(renderAsBuilt(2 * canGrams, canGrams)).not.toMatch(/can/i);
                expect(displayFamilyForPortion(cannedFacts(canGrams))).toBe('mass');
            });
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

        /**
         * The shipped shape: `nutrition_basis: per_100g`, `density_g_per_ml`
         * NULL, and a volume-family default portion — all 4,568 volume-portion
         * foods of catalog release v1, and the ingredient shape 41 of the 42
         * seeded recipes carry. The portion is the conversion source §0.1.4
         * names ("display … through stored portion conversions"), so these rows
         * render rather than taking the publication down.
         */
        describe('a food whose density is stated only by its portion', () => {
            /** Olive oil as the release ships it: 1 tbsp weighs 13.5 g, density null. */
            const shippedOilFacts: GroceryConversionFacts = {
                density_g_per_ml: null,
                default_portion: portion({ description: '1 tbsp', unit: 'tbsp', gram_weight: 13.5 }),
            };

            // §0.1.4's own worked example, "Olive oil · 6 tbsp", from the shape
            // the catalog actually holds: six of a 13.5 g tablespoon is 81 g,
            // and 81 g back through the density that portion states is exactly
            // six tablespoons again.
            it('renders the Agent Action Plan\u2019s "Olive oil \u00b7 6 tbsp" example', () => {
                expect(buildGroceryDisplay(6 * 13.5, 'volume', shippedOilFacts)).toEqual({
                    family: 'volume',
                    quantity: 6,
                    unit: 'tbsp',
                    text: '6 tbsp',
                });
            });

            it('promotes to cups on the derived density just as it does on a stored one', () => {
                expect(buildGroceryDisplay(16 * 13.5, 'volume', shippedOilFacts).text).toBe('1 cup');
            });

            it('renders a committed fixture food of that shape in cups', () => {
                // `ai:beverage:cold brew coffee concentrate:prepared`: 1 cup
                // weighs 240 g, so two cups is 480 g.
                expect(
                    buildGroceryDisplay(
                        480,
                        'volume',
                        groceryFacts('ai:beverage:cold brew coffee concentrate:prepared'),
                    ).text,
                ).toBe('2 cups');
            });

            it('divides the portion\u2019s amount out, so a two-tablespoon portion renders half as much', () => {
                // A 2 tbsp / 30 g portion states 15 g per tablespoon, so 60 g is
                // four tablespoons. Read as a one-tablespoon portion it would
                // state 30 g and print "2 tbsp" for the same grams.
                expect(
                    buildGroceryDisplay(60, 'volume', {
                        density_g_per_ml: null,
                        default_portion: portion({ description: '2 tbsp', amount: 2, unit: 'tbsp', gram_weight: 30 }),
                    }).text,
                ).toBe('4 tbsp');
            });
        });

        // THE LOUD FAILURE IS KEPT, and this is the case that still reaches it:
        // an `oz` portion states no volume, so this food can state no density at
        // all — and `displayFamilyForPortion` would therefore never choose
        // `volume` for it. Getting here means a STORED row's recorded
        // `display_unit` says volume, which is the unit-family lock broken
        // upstream (§0.7.3) rather than a rendering choice, so it must not be
        // papered over with an assumed 1 g/ml.
        it('refuses to treat millilitres as grams when the food can state no density', () => {
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

        describe('the portion description carries the row\u2019s plural', () => {
            it.each(PLURAL_DESCRIPTION_CASES)('renders exactly one as "1 %s"', (singular) => {
                expect(buildGroceryDisplay(COUNTED_PORTION_GRAMS, 'count', countedFacts(singular))).toEqual({
                    family: 'count',
                    quantity: 1,
                    unit: COUNT_DISPLAY_UNIT,
                    text: `1 ${singular}`,
                });
            });

            it.each(PLURAL_DESCRIPTION_CASES)('renders more than one %s as "4 %s"', (singular, plural) => {
                expect(buildGroceryDisplay(4 * COUNTED_PORTION_GRAMS, 'count', countedFacts(singular))).toEqual({
                    family: 'count',
                    quantity: 4,
                    unit: COUNT_DISPLAY_UNIT,
                    text: `4 ${plural}`,
                });
            });
        });

        /*
         * The descriptions the shipped catalog actually stores, which are not
         * bare nouns: the item is named first and qualified afterwards
         * ("egg, large", "can, drained"), and a portion counting several items
         * states its amount in front of the noun ("5 sprigs" at 1 g, USDA's
         * dill weed portion). A row that rendered the description verbatim read
         * "6 1 egg, larges" and counted 9 g of dill as nine sprigs.
         */
        describe('a real catalog portion description', () => {
            /**
             * A release portion, `amount` included: the cardinality is the
             * column, so every case states it, and the ones whose description
             * repeats it state the same number in both places exactly as the
             * release does.
             */
            const shippedFacts = (description: string, gramWeight: number, amount = 1): GroceryConversionFacts => ({
                density_g_per_ml: null,
                default_portion: portion({ description, amount, unit: 'each', gram_weight: gramWeight }),
            });

            it('states the amount once, and pluralises the item rather than its qualifier', () => {
                expect(buildGroceryDisplay(300, 'count', shippedFacts('1 egg, large', 50))).toEqual({
                    family: 'count',
                    quantity: 6,
                    unit: COUNT_DISPLAY_UNIT,
                    text: '6 eggs, large',
                });
            });

            it('counts the items a multi-item portion contains', () => {
                // `usda:172233`, dill weed: `{amount: 5, gram_weight: 1}`, so
                // nine grams is nine portions of five sprigs.
                expect(buildGroceryDisplay(9, 'count', shippedFacts('5 sprigs', 1, 5))).toEqual({
                    family: 'count',
                    quantity: 45,
                    unit: COUNT_DISPLAY_UNIT,
                    text: '45 sprigs',
                });
            });

            it('reads a single item of a multi-item portion in the singular', () => {
                expect(buildGroceryDisplay(0.2, 'count', shippedFacts('5 sprigs', 1, 5)).text).toBe('1 sprig');
            });

            it('counts a portion whose description says nothing about its amount', () => {
                // `{amount: 3, description: 'cookies', gram_weight: 44}`: 132 g
                // is nine cookies, which only the column can say. The
                // description-derived rule read it as three.
                expect(buildGroceryDisplay(132, 'count', shippedFacts('cookies', 44, 3)).text).toBe('9 cookies');
            });

            it('singularises that description correctly for one item', () => {
                expect(buildGroceryDisplay(44 / 3, 'count', shippedFacts('cookies', 44, 3)).text).toBe('1 cookie');
            });

            // Release portions that are genuinely countable items, with their
            // real gram weights. The canned-bean portions are deliberately
            // absent: `displayFamilyForPortion` weighs a container description
            // rather than counting it, and their measured rendering is asserted
            // in the mass describe above.
            const SHIPPED_ROWS: Array<[string, number, number, string]> = [
                ['1 lemon', 84, 168, '2 lemons'],
                ['1 avocado', 201, 201, '1 avocado'],
                ['1 tomato, medium', 123, 369, '3 tomatoes, medium'],
                ['1 clove', 3, 12, '4 cloves'],
                ['1 potato, medium', 213, 426, '2 potatoes, medium'],
                ['1 slice', 16, 48, '3 slices'],
            ];

            it.each(SHIPPED_ROWS)('renders "%s" at %p g each, %p g in all, as "%s"', (description, gramWeight, grams, expected) => {
                expect(buildGroceryDisplay(grams, 'count', shippedFacts(description, gramWeight)).text).toBe(expected);
            });
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

    it('states a bulk week in the largest unit its family has, not in hundreds of the smallest', () => {
        const eggsPerItem = countFacts.default_portion.gram_weight;

        expect(buildGroceryDisplay(25 * GRAMS_PER_POUND, 'mass', massFacts).text).toBe('25 lb');
        expect(buildGroceryDisplay(20 * MILLILITERS_PER_CUP, 'volume', volumeFacts).text).toBe('20 cups');
        expect(buildGroceryDisplay(120 * eggsPerItem, 'count', countFacts).text).toBe('120 eggs');
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

/**
 * The predicate a plan publication and a swap commit translate their grocery
 * faults with, so §0.5.2's `502 plan_generation_failed` / `502 swap_failed`
 * escapes instead of a raw 500.
 *
 * It has to recognise BOTH classes and NOTHING else: `grocery.service.ts` raises
 * plain `Error`s for its own broken write invariants ("deleted N rows instead of
 * M"), which describe a state no client can act on and are documented as
 * reaching the controller as a 500. Widening this predicate to `Error` is
 * exactly how those would start being reported to the client as a swap failure.
 */
describe('isGroceryRenderingFault', () => {
    it('recognises this module\u2019s own data fault', () => {
        expect(isGroceryRenderingFault(new GroceryDataError('no catalog facts'))).toBe(true);
    });

    it('recognises the unit conversion fault raised by utils/units.ts', () => {
        expect(isGroceryRenderingFault(new UnitConversionError('no density'))).toBe(true);
    });

    it('recognises them as thrown, and not only as constructed', () => {
        const thrown = ((): unknown => {
            try {
                buildGroceryDisplay(100, 'volume', { density_g_per_ml: null, default_portion: portion() });
            } catch (error) {
                return error;
            }

            throw new Error('Expected the volume branch to refuse a food with no density');
        })();

        expect(isGroceryRenderingFault(thrown)).toBe(true);
    });

    it('does not recognise the untyped write-invariant faults, which stay 500s', () => {
        expect(
            isGroceryRenderingFault(new Error('Removing grocery rows of plan p deleted 2 rows instead of 3.')),
        ).toBe(false);
    });

    it.each([
        ['a typed refusal from another vocabulary', new PlanNotFoundError()],
        ['a bare error', new Error('boom')],
        ['a type error', new TypeError('boom')],
    ])('does not recognise %s', (_case, error) => {
        expect(isGroceryRenderingFault(error)).toBe(false);
    });

    it.each([
        ['a string', 'boom'],
        ['null', null],
        ['undefined', undefined],
        ['a plain object', { name: 'UnitConversionError' }],
    ])('answers false for %s rather than assuming a shape', (_case, value) => {
        expect(isGroceryRenderingFault(value)).toBe(false);
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

    it('distinguishes a multi-word state by its shopper label, never by its stored code', () => {
        const bothForms = indexFoodStatesByName([
            { name: 'Flour', food_state: 'as_purchased' },
            { name: 'Flour', food_state: DRY },
        ]);

        // The state has to be said here — two rows of one name — and what is
        // said is the label a shopper reads, not the enum token.
        expect(buildGroceryName('Flour', 'as_purchased', bothForms)).toBe('Flour, as sold');
        expect(buildGroceryName('Flour', 'as_purchased', bothForms)).not.toContain('as purchased');
    });

    it('says nothing on its own for the states that describe how the catalog measured the food', () => {
        // `as_purchased` and `prepared` state the form the CATALOG tabulated
        // the food in, which is the default assumption of every line on a
        // shopping list: a shopper buys olive oil and peanut butter.
        expect(
            buildGroceryName('Olive oil', AS_PURCHASED, indexFoodStatesByName([{ name: 'Olive oil', food_state: AS_PURCHASED }])),
        ).toBe('Olive oil');
        expect(
            buildGroceryName('Peanut butter', PREPARED, indexFoodStatesByName([{ name: 'Peanut butter', food_state: PREPARED }])),
        ).toBe('Peanut butter');
    });

    it('keeps the two states that are real shopping distinctions', () => {
        // Dry lentils and cooked lentils are different purchases, and §0.7.3's
        // own worked examples are exactly these two words.
        expect(buildGroceryName('Lentils', DRY, indexFoodStatesByName([{ name: 'Lentils', food_state: DRY }]))).toBe(
            'Lentils, dry',
        );
        expect(buildGroceryName('Lentils', COOKED, indexFoodStatesByName([{ name: 'Lentils', food_state: COOKED }]))).toBe(
            'Lentils, cooked',
        );
    });

    it('degrades an unknown future state to its own humanised words rather than to silence', () => {
        // A sixth enum value nobody has written copy for still names the
        // distinction the shopper is buying, plainly.
        expect(buildGroceryName('Beef', 'air_dried', indexFoodStatesByName([{ name: 'Beef', food_state: 'air_dried' }]))).toBe(
            'Beef, air dried',
        );
        expect(
            buildGroceryName('Beef', 'air_dried', indexFoodStatesByName([
                { name: 'Beef', food_state: 'air_dried' },
                { name: 'Beef', food_state: RAW },
            ])),
        ).toBe('Beef, air dried');
    });

    it('appends nothing at all for a state token with no words in it', () => {
        // Data this malformed can state nothing truthful, and a dangling
        // "Herbs, " would be worse than the bare name.
        expect(buildGroceryName('Herbs', '', new Map())).toBe('Herbs');
    });

    it('leaves a raw food unqualified when the list index does not mention it', () => {
        expect(buildGroceryName('Chicken breast', RAW, new Map())).toBe('Chicken breast');
    });

    /**
     * EVERY non-raw food the seeded recipes use, with the name the rule
     * produces for it — the 36 of `data/meal-planning/catalog/releases/v1` the
     * 43 committed recipes reference, grouped by their stored `food_state`.
     *
     * Real release data rather than an invented matrix, because the rule is
     * about WHAT A SHOPPER READS on a real list. §0.7.3 and §6.2 of
     * `docs/meal-planning/planning-policy.md` require the state to be shown
     * whenever it is not `raw`, and what is shown is the state's shopper label:
     * `dry` and `cooked` are real shopping distinctions and keep their words,
     * while `as_purchased` and `prepared` describe the form the CATALOG
     * measured the food in — the default assumption of every line — so they say
     * nothing on their own. Printing the codes instead put "Olive oil, as
     * purchased" and "Peanut butter, prepared" on 30 of these 36 lines.
     *
     * Where the state does earn a word, the only names that stay bare are the
     * ones whose own qualifier already contains it literally.
     */
    const RELEASE_NON_RAW_CASES: Array<[string, string, string]> = [
        // as_purchased — the shop sells all twelve exactly as the catalog
        // measured them, so the row says the food and nothing else.
        ['Almond milk, unsweetened', AS_PURCHASED, 'Almond milk, unsweetened'],
        ['Almonds', AS_PURCHASED, 'Almonds'],
        ['Balsamic vinegar', AS_PURCHASED, 'Balsamic vinegar'],
        ['Canola oil', AS_PURCHASED, 'Canola oil'],
        ['Cheddar cheese', AS_PURCHASED, 'Cheddar cheese'],
        ['Feta cheese', AS_PURCHASED, 'Feta cheese'],
        ['Greek yogurt, plain', AS_PURCHASED, 'Greek yogurt, plain'],
        ['Honey', AS_PURCHASED, 'Honey'],
        ['Maple syrup', AS_PURCHASED, 'Maple syrup'],
        ['Milk, 2%', AS_PURCHASED, 'Milk, 2%'],
        ['Oat milk', AS_PURCHASED, 'Oat milk'],
        ['Olive oil', AS_PURCHASED, 'Olive oil'],
        // cooked — "canned" is not a way of saying "cooked", so the catalog's
        // qualifier is kept AND the state is stated.
        ['Black beans, canned', COOKED, 'Black beans, canned, cooked'],
        ['Brown rice, cooked', COOKED, 'Brown rice, cooked'],
        ['Chickpeas, canned', COOKED, 'Chickpeas, canned, cooked'],
        ['Kidney beans, canned', COOKED, 'Kidney beans, canned, cooked'],
        ['Pasta, cooked', COOKED, 'Pasta, cooked'],
        ['Quinoa, cooked', COOKED, 'Quinoa, cooked'],
        // dry — three of these already carry the word.
        ['All-purpose flour', DRY, 'All-purpose flour, dry'],
        ['Black pepper', DRY, 'Black pepper, dry'],
        ['Bulgur, dry', DRY, 'Bulgur, dry'],
        ['Chili powder', DRY, 'Chili powder, dry'],
        ['Ground cumin', DRY, 'Ground cumin, dry'],
        ['Lentils, dry', DRY, 'Lentils, dry'],
        ['Rolled oats, dry', DRY, 'Rolled oats, dry'],
        ['Salt', DRY, 'Salt, dry'],
        ['Sunflower seeds', DRY, 'Sunflower seeds, dry'],
        // prepared — a jar of mayonnaise is bought ready to use, which is the
        // only way a shop sells it, so the row says the food and nothing else.
        ['Hummus', PREPARED, 'Hummus'],
        ['Mayonnaise', PREPARED, 'Mayonnaise'],
        ['Olives, black', PREPARED, 'Olives, black'],
        ['Peanut butter', PREPARED, 'Peanut butter'],
        ['Salsa', PREPARED, 'Salsa'],
        ['Soy sauce', PREPARED, 'Soy sauce'],
        ['Tuna, canned in water', PREPARED, 'Tuna, canned in water'],
        ['Turkey breast, sliced', PREPARED, 'Turkey breast, sliced'],
        ['Yellow mustard', PREPARED, 'Yellow mustard'],
    ];

    it.each(RELEASE_NON_RAW_CASES)('names %s in the %s state "%s"', (name, state, expected) => {
        expect(buildGroceryName(name, state, indexFoodStatesByName([{ name, food_state: state }]))).toBe(expected);
    });

    /**
     * The regression this table exists to hold shut, as one claim over all 36
     * lines: the ONLY thing a shopping name ever gains on its own is one of the
     * two shopping words, and an internal state code is never printed at all.
     */
    it('never appends an internal state token to a shopper name', () => {
        /** Everything the ordinary path may ever add to a release name. */
        const ORDINARY_SUFFIXES: readonly string[] = ['', ', dry', ', cooked'];
        const SILENT_STATES: readonly string[] = [AS_PURCHASED, PREPARED];

        for (const [name, state, expected] of RELEASE_NON_RAW_CASES) {
            expect(expected.startsWith(name)).toBe(true);
            expect(ORDINARY_SUFFIXES).toContain(expected.slice(name.length));

            if (SILENT_STATES.includes(state)) {
                // Nothing is added, so nothing of the code can reach the
                // shopper: these are the 21 lines that read "…, as purchased"
                // and "…, prepared".
                expect(expected).toBe(name);
                expect(expected).not.toContain(state.replace(/_/g, ' '));
            }
        }
    });

    it('states the word it does append exactly once', () => {
        for (const [name, , expected] of RELEASE_NON_RAW_CASES) {
            const appended = expected.slice(name.length);

            if (appended === '') {
                continue;
            }

            const word = appended.replace(', ', '');

            expect(expected.split(word).length - 1).toBe(1);
        }
    });

    /*
     * The de-duplication, isolated: a name keeps its own form only when its
     * qualifiers contain the STATE'S OWN WORDS. "Peas, cooked in water" states
     * `cooked` inside a phrase, "Dressing, prepared from mix" states `prepared`
     * in the first of three words, and "Flour, as purchased" states both words
     * of a two-word state — all of them contiguous runs of whole words.
     */
    const SELF_STATING_CASES: Array<[string, string]> = [
        ['Brown rice, cooked', COOKED],
        ['Pasta, cooked', COOKED],
        ['Quinoa, cooked', COOKED],
        ['Peas, cooked in water', COOKED],
        ['Rolled oats, dry', DRY],
        ['Lentils, dry', DRY],
        ['Bulgur, dry', DRY],
        ['Dressing, prepared from mix', PREPARED],
        ['Flour, as purchased', AS_PURCHASED],
    ];

    it.each(SELF_STATING_CASES)('does not repeat the state %s already states', (name, state) => {
        expect(buildGroceryName(name, state, indexFoodStatesByName([{ name, food_state: state }]))).toBe(name);
    });

    /*
     * The substitution the rule must NOT make. Each name carries a preparation
     * word that used to be read as a synonym of the stored state, which silently
     * replaced the state the row actually holds.
     */
    const PREPARATION_WORD_CASES: Array<[string, string, string]> = [
        ['Black beans, canned', COOKED, 'Black beans, canned, cooked'],
        ['Chickpeas, canned', COOKED, 'Chickpeas, canned, cooked'],
        ['Beef, roasted', DRY, 'Beef, roasted, dry'],
        ['Oats, uncooked', DRY, 'Oats, uncooked, dry'],
    ];

    it.each(PREPARATION_WORD_CASES)('states the stored state of %s rather than accepting its preparation word', (name, state, expected) => {
        expect(buildGroceryName(name, state, indexFoodStatesByName([{ name, food_state: state }]))).toBe(expected);
    });

    /*
     * The same claim for the two states that say nothing on their own: they are
     * silent because the state is not worth saying, NOT because a preparation
     * word in the catalog's name was read as saying it. Where such a row has to
     * be distinguished, the label is appended over the preparation word exactly
     * as `cooked` is over "canned".
     */
    const SILENT_STATE_PREPARATION_CASES: Array<[string, string, string, string]> = [
        ['Tuna, canned in water', PREPARED, RAW, 'Tuna, canned in water, ready to use'],
        ['Turkey breast, sliced', PREPARED, RAW, 'Turkey breast, sliced, ready to use'],
        ['Yogurt, strained', AS_PURCHASED, COOKED, 'Yogurt, strained, as sold'],
    ];

    it.each(SILENT_STATE_PREPARATION_CASES)(
        'distinguishes %s in the %s state without reading its preparation word as the state',
        (name, state, other, expected) => {
            expect(buildGroceryName(name, state, indexFoodStatesByName([{ name, food_state: state }]))).toBe(name);
            expect(
                buildGroceryName(
                    name,
                    state,
                    indexFoodStatesByName([
                        { name, food_state: state },
                        { name, food_state: other },
                    ]),
                ),
            ).toBe(expected);
        },
    );

    it('matches the state as whole words, not as a fragment of one', () => {
        // "predry" contains the letters of "dry" and says nothing about the
        // state, so the suffix is still owed.
        expect(buildGroceryName('Herbs, predry', DRY, new Map())).toBe('Herbs, predry, dry');
    });

    it('reads the qualifiers only, so a state word inside the food\u2019s own noun is not the state', () => {
        // "dry" describes the beef, not how the shop stores it, and it sits in
        // the head segment rather than in a qualifier.
        expect(buildGroceryName('Dry-aged beef', DRY, new Map())).toBe('Dry-aged beef, dry');
    });

    it('reads the qualifiers only, so a name whose noun resembles a state still gets its suffix', () => {
        // "Rolled oats, dry" in a COOKED state is a different food from the dry
        // one, and "dry" is not a way of saying "cooked".
        expect(buildGroceryName('Rolled oats, dry', COOKED, indexFoodStatesByName([{ name: 'Rolled oats, dry', food_state: COOKED }]))).toBe(
            'Rolled oats, dry, cooked',
        );
    });

    it('reads a state stated in the last of several qualifiers', () => {
        expect(buildGroceryName('Beef, ground, cooked', COOKED, new Map())).toBe('Beef, ground, cooked');
    });

    const RESIDUAL_SUFFIX_CASES: Array<[string, string, string]> = [
        ['Salt', DRY, 'Salt, dry'],
        ['All-purpose flour', DRY, 'All-purpose flour, dry'],
        ['Rice', COOKED, 'Rice, cooked'],
        ['Chickpeas', COOKED, 'Chickpeas, cooked'],
    ];

    it.each(RESIDUAL_SUFFIX_CASES)('still qualifies %s, whose name states no preparation', (name, state, expected) => {
        expect(buildGroceryName(name, state, indexFoodStatesByName([{ name, food_state: state }]))).toBe(expected);
    });

    /**
     * COEXISTENCE, PAIR BY PAIR. Two rows of one base name must never render
     * the same string, or the shopper reads one line and buys half of what the
     * week needs — so a row that would otherwise stay silent (`raw`,
     * `as_purchased`, `prepared`, or a name whose qualifier is merely a
     * preparation word) is qualified here, with that state's DISTINGUISHING
     * label. What coexistence does NOT do is state a row's state twice: the
     * last pair's name already says `cooked`, so its cooked line keeps its name
     * and only its raw line is suffixed, and the two are still distinct.
     *
     * `label` is the word each side is expected to carry, held beside the
     * rendered name so the "exactly once" claim below counts the words actually
     * appended rather than the enum token — which for two of the five states is
     * not the text a shopper sees at all.
     */
    interface CoexistenceSide {
        readonly state: string;
        readonly label: string;
        readonly expected: string;
    }

    interface CoexistencePair {
        readonly what: string;
        readonly name: string;
        readonly first: CoexistenceSide;
        readonly second: CoexistenceSide;
    }

    const COEXISTING_PAIRS: readonly CoexistencePair[] = [
        {
            what: 'a name that says nothing about either state',
            name: 'Rice',
            first: { state: RAW, label: 'raw', expected: 'Rice, raw' },
            second: { state: COOKED, label: 'cooked', expected: 'Rice, cooked' },
        },
        {
            what: 'a name whose qualifier is a preparation word rather than a state',
            name: 'Black beans, canned',
            first: { state: COOKED, label: 'cooked', expected: 'Black beans, canned, cooked' },
            second: { state: DRY, label: 'dry', expected: 'Black beans, canned, dry' },
        },
        {
            what: 'a shopping-form state beside raw',
            name: 'Olive oil',
            first: { state: AS_PURCHASED, label: 'as sold', expected: 'Olive oil, as sold' },
            second: { state: RAW, label: 'raw', expected: 'Olive oil, raw' },
        },
        {
            what: 'the two states a shopper could otherwise confuse',
            name: 'Chickpeas',
            first: { state: AS_PURCHASED, label: 'as sold', expected: 'Chickpeas, as sold' },
            second: { state: COOKED, label: 'cooked', expected: 'Chickpeas, cooked' },
        },
        {
            what: 'a ready-to-use form beside a dry one',
            name: 'Hummus',
            first: { state: PREPARED, label: 'ready to use', expected: 'Hummus, ready to use' },
            second: { state: DRY, label: 'dry', expected: 'Hummus, dry' },
        },
        {
            what: 'a name that already states one of the two states',
            name: 'Peas, cooked',
            first: { state: COOKED, label: 'cooked', expected: 'Peas, cooked' },
            second: { state: RAW, label: 'raw', expected: 'Peas, cooked, raw' },
        },
    ];

    const coexistingIndex = (name: string, first: string, second: string): FoodStatesByName =>
        indexFoodStatesByName([
            { name, food_state: first },
            { name, food_state: second },
        ]);

    /** How many times `name` states `label`'s own words. */
    const timesStated = (name: string, label: string): number => name.split(label).length - 1;

    it.each(COEXISTING_PAIRS)('renders $what as two distinct lines', ({ name, first, second }) => {
        const coexisting = coexistingIndex(name, first.state, second.state);

        expect(buildGroceryName(name, first.state, coexisting)).toBe(first.expected);
        expect(buildGroceryName(name, second.state, coexisting)).toBe(second.expected);
        expect(first.expected).not.toBe(second.expected);
    });

    it.each(COEXISTING_PAIRS)('states each coexisting label of $what exactly once', ({ name, first, second }) => {
        expect(timesStated(first.expected, first.label)).toBe(1);
        expect(timesStated(second.expected, second.label)).toBe(1);
        expect(first.expected.startsWith(name)).toBe(true);
        expect(second.expected.startsWith(name)).toBe(true);
    });

    it.each(COEXISTING_PAIRS)('never prints a stored state code on either line of $what', ({ first, second }) => {
        for (const side of [first, second]) {
            expect(side.expected).not.toContain('_');

            if (side.label !== side.state) {
                // The two states whose label is not their code: the code must
                // not reach the shopper under any rule.
                expect(side.expected).not.toContain(side.state.replace(/_/g, ' '));
            }
        }
    });

    it('suffixes both rows when the shared name states both coexisting states', () => {
        // The collision guard, and the one case that pays for distinguishability
        // with a repeated word. "Beans, cooked and dry" states `cooked` AND
        // `dry` literally, so de-duplicating both rows — the reading the pairs
        // above take one row at a time — would render one identical string
        // twice, which is the collapse coexistence exists to prevent. Both are
        // therefore suffixed, and the two lines stay distinct.
        const coexisting = coexistingIndex('Beans, cooked and dry', COOKED, DRY);
        const cooked = buildGroceryName('Beans, cooked and dry', COOKED, coexisting);
        const dry = buildGroceryName('Beans, cooked and dry', DRY, coexisting);

        expect(cooked).toBe('Beans, cooked and dry, cooked');
        expect(dry).toBe('Beans, cooked and dry, dry');
        expect(cooked).not.toBe(dry);
    });

    it('de-duplicates at most one row of a coexisting name, so no pair can collide', () => {
        // The general claim behind the guard: a de-duplicated name is the bare
        // base and a suffixed one is the base plus ", state", so the two can
        // never be equal — whatever the states, and whatever the name says.
        const NAMES: readonly string[] = [
            'Rice',
            'Peas, cooked',
            'Beans, cooked and dry',
            'Olive oil',
            'Rolled oats, dry',
            'Dry-aged beef',
        ];
        const STATES: readonly string[] = [RAW, COOKED, DRY, PREPARED, AS_PURCHASED];

        for (const name of NAMES) {
            for (const first of STATES) {
                for (const second of STATES) {
                    if (first === second) {
                        continue;
                    }

                    const coexisting = coexistingIndex(name, first, second);

                    expect(buildGroceryName(name, first, coexisting)).not.toBe(
                        buildGroceryName(name, second, coexisting),
                    );
                }
            }
        }
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

        // Neither line carries a state: `raw` is the unmarked case, and
        // `as_purchased` describes how the catalog measured the oil rather than
        // anything the shopper is choosing between.
        expect(rows.map((line) => [line.name, line.display_text, line.display_unit])).toEqual([
            ['Eggs', '12 eggs', COUNT_DISPLAY_UNIT],
            ['Olive oil', '1 cup', 'cup'],
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
 * A total that lands on a display-rounding midpoint
 *
 * The column keeps two decimals and the aggregate keeps all of them, so a total
 * can sit on the far side of a rounding step from the number that is actually
 * stored. Both cases below are the shipped data's own: a `13.1625 g` spice total
 * whose truncation drops it below a ¼-tbsp step, and a `208.125 g` grain total
 * whose truncation lifts it over a ¼-cup one. Each density is the one that puts
 * the food's real total on the step, so the drift is a property of the numbers
 * rather than of an invented fixture.
 *
 * What the rows prove is one invariant — A ROW'S TEXT IS THE RENDERING OF THE
 * GRAMS THAT ROW STORES — and then the two flag failures that invariant is the
 * only defence against, because `applyToggle` records the acknowledged baseline
 * as GRAMS and every "was Y" and every visibility test re-renders it.
 * ------------------------------------------------------------------------- */

describe('a total that lands on a display-rounding midpoint', () => {
    /**
     * One drifting total: the density and portion that make the food a volume
     * row, the per-recipe grams behind the total, and the three numbers the two
     * roundings disagree about.
     */
    interface MidpointCase {
        readonly what: string;
        readonly densityGPerMl: number;
        readonly portionUnit: string;
        /** Grams of the food in the whole recipe; the yield below halves it. */
        readonly gramsPerRecipe: number;
        readonly exactGrams: number;
        readonly storedGrams: number;
        /** What the STORED grams render as — the text the row must carry. */
        readonly storedText: string;
        /** What the untruncated aggregate rendered as, before this was fixed. */
        readonly untruncatedText: string;
        /** A later week's total, chosen to move the row's rendered text. */
        readonly increasedGramsPerRecipe: number;
        readonly increasedText: string;
        readonly deltaText: string;
    }

    /** Two servings per recipe, so the stored total is not the recipe's own weight. */
    const YIELD_SERVINGS = 2;

    const MIDPOINT_CASES: readonly MidpointCase[] = [
        {
            // "Chili powder, dry": six planned contributions summing to
            // 13.1625 g. The untruncated total renders a quarter-tablespoon
            // HIGHER than the stored one, which is what used to overstate both
            // the pill's "was Y" and its delta.
            what: 'a truncation that drops the total below a ¼-tbsp step',
            densityGPerMl: 0.5477,
            portionUnit: 'tbsp',
            gramsPerRecipe: 26.325,
            exactGrams: 13.1625,
            storedGrams: 13.16,
            storedText: '1½ tbsp',
            untruncatedText: '1¾ tbsp',
            increasedGramsPerRecipe: 32.4,
            increasedText: '2 tbsp',
            deltaText: '+½ tbsp',
        },
        {
            // "Quinoa, cooked": 208.125 g, where the drift runs the other way.
            // The untruncated total renders a quarter-cup LOWER, which is what
            // used to suppress the flag entirely — the row visibly grew from
            // "1 cup" to "1¼ cups" while the baseline re-rendered to "1¼ cups"
            // and the two read equal.
            what: 'a truncation that lifts the total over a ¼-cup step',
            densityGPerMl: 0.78195,
            portionUnit: 'cup',
            gramsPerRecipe: 416.25,
            exactGrams: 208.125,
            storedGrams: 208.13,
            storedText: '1¼ cups',
            untruncatedText: '1 cup',
            increasedGramsPerRecipe: 510,
            increasedText: '1½ cups',
            deltaText: '+¼ cup',
        },
    ];

    /** The drifting food as a volume row: its own density, its own portion unit. */
    const midpointFacts = (midpoint: MidpointCase): GroceryFoodFacts =>
        oilFacts({
            density_g_per_ml: midpoint.densityGPerMl,
            default_portion: portion({
                description: `1 ${midpoint.portionUnit}`,
                unit: midpoint.portionUnit,
                gram_weight: midpoint.densityGPerMl * MILLILITERS_PER_TABLESPOON,
            }),
        });

    /** The one line a week of this food implies, built by the production builder. */
    const midpointRow = (midpoint: MidpointCase, gramsPerRecipe: number): GroceryRowDraft => {
        const food = midpointFacts(midpoint);
        const rows = buildGroceryRows(
            [
                meal([{ catalog_food_id: food.catalog_food_id, food_state: food.food_state, gram_weight: gramsPerRecipe }], {
                    yield_servings: YIELD_SERVINGS,
                }),
            ],
            [food],
        );

        return rows[0];
    };

    /** That line as the database would hold it, with the check state stated. */
    const asStoredRow = (line: GroceryRowDraft, overrides: Partial<StoredGroceryRow> = {}): StoredGroceryRow => ({
        id: 'midpoint-row',
        catalog_food_id: line.catalog_food_id,
        food_state: line.food_state,
        name: line.name,
        category: line.category,
        quantity_grams: line.quantity_grams,
        display_quantity: line.display_quantity,
        display_unit: line.display_unit,
        display_text: line.display_text,
        is_checked: false,
        previous_quantity_grams: null,
        flagged_at: null,
        sort_order: line.sort_order,
        ...overrides,
    });

    it.each(MIDPOINT_CASES)('is a real midpoint: $what renders two different amounts', (midpoint) => {
        const food = midpointFacts(midpoint);

        // Without this the cases below would pass on any implementation: the
        // two roundings have to disagree for there to be anything to get wrong.
        expect(buildGroceryDisplay(midpoint.exactGrams, 'volume', food).text).toBe(midpoint.untruncatedText);
        expect(buildGroceryDisplay(midpoint.storedGrams, 'volume', food).text).toBe(midpoint.storedText);
        expect(midpoint.untruncatedText).not.toBe(midpoint.storedText);
    });

    it.each(MIDPOINT_CASES)('stores $what as the rendering of its own grams', (midpoint) => {
        const line = midpointRow(midpoint, midpoint.gramsPerRecipe);

        expect(line.quantity_grams).toBe(midpoint.storedGrams);
        expect(line.display_text).toBe(midpoint.storedText);
        expect(line.display_text).toBe(
            buildGroceryDisplay(line.quantity_grams, 'volume', midpointFacts(midpoint)).text,
        );
    });

    it.each(MIDPOINT_CASES)('makes the acknowledged baseline re-render to the text the row showed, for $what', (midpoint) => {
        const line = midpointRow(midpoint, midpoint.gramsPerRecipe);
        const checkState = applyToggle(line, true, EARLIER);

        // The mechanism behind BOTH symptoms: the baseline is recorded as
        // grams, and every "was Y" and every visibility test renders it again.
        expect(checkState.previous_quantity_grams).toBe(midpoint.storedGrams);
        expect(
            buildGroceryDisplay(checkState.previous_quantity_grams as number, 'volume', midpointFacts(midpoint)).text,
        ).toBe(line.display_text);
    });

    it.each(MIDPOINT_CASES)('flags a visible increase on $what, with a pill that reconciles', (midpoint) => {
        const food = midpointFacts(midpoint);
        const line = midpointRow(midpoint, midpoint.gramsPerRecipe);
        const checked = asStoredRow(line, {
            is_checked: true,
            previous_quantity_grams: applyToggle(line, true, EARLIER).previous_quantity_grams,
        });
        const increased = midpointRow(midpoint, midpoint.increasedGramsPerRecipe);
        const plan = diffGroceryList([checked], [increased], [food], NOW);
        const flaggedRow = {
            ...checked,
            quantity_grams: plan.updates[0].quantity_grams,
            display_quantity: plan.updates[0].display_quantity,
            display_unit: plan.updates[0].display_unit,
            display_text: plan.updates[0].display_text,
            previous_quantity_grams: plan.updates[0].previous_quantity_grams,
            flagged_at: plan.updates[0].flagged_at,
        };

        expect(increased.display_text).toBe(midpoint.increasedText);
        // The increase is visible on the row, so it is flagged — the half of
        // this defect that used to leave a checked row growing silently.
        expect(plan.updates[0].flagged_at).toBe(NOW);
        expect(plan.summary.increased).toBe(1);
        expect(buildGroceryFlag(flaggedRow, food)).toEqual({
            previousDisplayText: line.display_text,
            newDisplayText: midpoint.increasedText,
            deltaDisplayText: midpoint.deltaText,
            flaggedAt: NOW.toISOString(),
        });
        // The pill is exactly what the shopper gets by subtracting the numbers
        // in front of them: "was" is the text the row itself was showing, not a
        // re-rendering that disagrees with it.
        expect(buildGroceryFlag(flaggedRow, food)?.previousDisplayText).toBe(midpoint.storedText);
        expect(bannerFor([flaggedRow], { mealSlot: 'lunch', changedList: true })).toEqual({
            code: 'amount_increased',
            itemNames: [flaggedRow.name],
        });
    });

    /**
     * The suppression half, stated as the equivalence it actually is rather
     * than as one scenario: on a row the shopper has just checked, an increase
     * raises a flag EXACTLY WHEN it moves the row's own rendered text.
     *
     * That equivalence is what the drift used to break, and it broke it in both
     * directions — an increase the shopper could see went unflagged because the
     * re-rendered baseline already read the larger amount, and the sub-line
     * could claim a previous amount the row had never shown. It holds now
     * because the baseline re-renders to exactly the text the row carries, so
     * "visible against what was acknowledged" and "visible on the row" are the
     * same question. Swept at a quarter of a gram, which is under the epsilon,
     * so the sweep also crosses the equality tolerance itself.
     */
    it.each(MIDPOINT_CASES)('flags exactly the increases the shopper can see on $what', (midpoint) => {
        const food = midpointFacts(midpoint);
        const line = midpointRow(midpoint, midpoint.gramsPerRecipe);
        const checked = asStoredRow(line, {
            is_checked: true,
            previous_quantity_grams: applyToggle(line, true, EARLIER).previous_quantity_grams,
        });

        for (let step = 1; step <= 200; step += 1) {
            const increased = midpointRow(midpoint, (midpoint.storedGrams + step * 0.25) * YIELD_SERVINGS);
            const plan = diffGroceryList([checked], [increased], [food], NOW);
            const update = plan.updates[0];

            if (!update) {
                // Sub-epsilon: the row is left entirely alone — the text the
                // shopper is reading is kept even where the draft would have
                // rendered the next step — so there is no flag to judge.
                expect(plan.unchangedItemIds).toEqual([checked.id]);
                continue;
            }

            expect(update.flagged_at === NOW).toBe(update.display_text !== checked.display_text);
        }
    });

    /**
     * The invariant as a sweep rather than as two cases, across all three
     * families: whatever the aggregate, a built row's text is the rendering of
     * the grams that row stores. The step is a hundredth of a gram, which is the
     * column's own resolution, so every case walks the truncation through a
     * whole stored gram in each family.
     */
    it('never builds a row whose text disagrees with its own grams', () => {
        const SWEEP_STEPS = 400;
        const sweptFoods: readonly [GroceryFoodFacts, number][] = [
            [midpointFacts(MIDPOINT_CASES[0]), 13],
            [midpointFacts(MIDPOINT_CASES[1]), 208],
            [facts(), 2.5 * GRAMS_PER_POUND],
            [eggFacts(), 600],
        ];

        for (const [food, base] of sweptFoods) {
            const family = displayFamilyForPortion(food);

            for (let step = 0; step < SWEEP_STEPS; step += 1) {
                const line = buildGroceryRows(
                    [
                        meal(
                            [
                                {
                                    catalog_food_id: food.catalog_food_id,
                                    food_state: food.food_state,
                                    gram_weight: (base + step * 0.0025) * YIELD_SERVINGS,
                                },
                            ],
                            { yield_servings: YIELD_SERVINGS },
                        ),
                    ],
                    [food],
                )[0];

                expect(line.display_text).toBe(buildGroceryDisplay(line.quantity_grams, family, food).text);
                expect(line.display_quantity).toBe(buildGroceryDisplay(line.quantity_grams, family, food).quantity);
            }
        }
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
         * A row flagged at 3.1 lb and re-aggregated to 2.9 lb is STILL above the
         * 2.5 lb the shopper acknowledged, and the row still says so, so the
         * flag stands — the fall added nothing, and it retracted nothing
         * either. This is the case a direction-driven rule got wrong: the
         * shopper had bought 2.5 lb and ticked the row off, the week now needs
         * 2.9 lb, and clearing the flag left them with a struck-through line
         * they could not cook from. §0.7.3's baseline is the LAST ACKNOWLEDGED
         * amount and the user acknowledged nothing between the two swaps.
         */
        it('keeps a standing flag while the amount is still visibly above what was acknowledged', () => {
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
                // The instant is the one the flag was raised at: the divergence
                // dates from then, not from the swap that lowered it.
                flagged_at: EARLIER,
                previous_quantity_grams: TWO_AND_A_HALF_LB,
            });
            // A fall is not an increase, so it is not counted as one.
            expect(plan.summary.increased).toBe(0);
            expect(decreased.is_checked).toBe(true);
            expect(buildGroceryFlag(decreased, facts())).toEqual({
                previousDisplayText: '2.5 lb',
                newDisplayText: '2.9 lb',
                deltaDisplayText: '+0.4 lb',
                flaggedAt: EARLIER.toISOString(),
            });
            expect(bannerFor([decreased], { mealSlot: 'lunch', changedList: true })).toEqual({
                code: 'amount_increased',
                itemNames: ['Chicken breast'],
            });
        });

        /**
         * The half of the old expectation that was always right: once the
         * amount is back to what the shopper acknowledged there is nothing
         * outstanding, so the flag goes, the sub-line goes, and the banner
         * falls back to the swap notice. The baseline stays put, which is what
         * the next increase is measured from.
         */
        it('clears a standing flag once the amount comes back to what was acknowledged', () => {
            const flaggedRow = acknowledgedRow({
                quantity_grams: 3.1 * GRAMS_PER_POUND,
                display_quantity: 3.1,
                display_text: '3.1 lb',
                flagged_at: EARLIER,
            });
            const plan = diffGroceryList([flaggedRow], [massDraft(TWO_AND_A_HALF_LB)], chickenFacts, NOW);
            const decreased = applyUpdate(flaggedRow, plan.updates[0]);

            expect(plan.updates[0]).toMatchObject({
                display_text: '2.5 lb',
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

        /**
         * And the boundary between the two: an amount that is still above the
         * acknowledged one in GRAMS but renders the acknowledged TEXT clears
         * the flag, because the row no longer shows the shopper anything to
         * act on. 0.6 g above 2.5 lb is past the half-gram epsilon and still
         * reads "2.5 lb".
         */
        it('clears a standing flag once the amount lands back on the acknowledged display text', () => {
            const flaggedRow = acknowledgedRow({
                quantity_grams: 3.1 * GRAMS_PER_POUND,
                display_quantity: 3.1,
                display_text: '3.1 lb',
                flagged_at: EARLIER,
            });
            const plan = diffGroceryList([flaggedRow], [massDraft(TWO_AND_A_HALF_LB + 0.6)], chickenFacts, NOW);
            const decreased = applyUpdate(flaggedRow, plan.updates[0]);

            expect(plan.updates[0]).toMatchObject({
                quantity_grams: TWO_AND_A_HALF_LB + 0.6,
                display_text: '2.5 lb',
                flagged_at: null,
                previous_quantity_grams: TWO_AND_A_HALF_LB,
            });
            expect(buildGroceryFlag(decreased, facts())).toBeNull();
            expect(bannerFor([decreased], null)).toBeNull();
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
                diffGroceryList([flaggedRow], [massDraft(TWO_AND_A_HALF_LB)], chickenFacts, EARLIER).updates[0],
            );
            const raised = diffGroceryList([cleared], [massDraft(3.1 * GRAMS_PER_POUND)], chickenFacts, NOW);
            const reflagged = applyUpdate(cleared, raised.updates[0]);

            expect(cleared.flagged_at).toBeNull();
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
         * exactly what was acknowledged — is where the same-display exception
         * is easiest to lose: a gram above 2.5 lb differs from the acknowledged
         * amount in the column and moves nothing on the row, so it must raise
         * nothing.
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
                diffGroceryList([flaggedRow], [massDraft(TWO_AND_A_HALF_LB)], chickenFacts, EARLIER).updates[0],
            );
            const invisible = diffGroceryList([cleared], [massDraft(TWO_AND_A_HALF_LB + 1)], chickenFacts, NOW);
            const unflagged = applyUpdate(cleared, invisible.updates[0]);

            expect(invisible.updates[0]).toMatchObject({
                quantity_grams: TWO_AND_A_HALF_LB + 1,
                display_text: '2.5 lb',
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
                diffGroceryList([flaggedRow], [massDraft(TWO_AND_A_HALF_LB)], chickenFacts, EARLIER).updates[0],
            );
            const noise = diffGroceryList([cleared], [massDraft(TWO_AND_A_HALF_LB + 0.2)], chickenFacts, NOW);

            expect(noise.updates).toEqual([]);
            expect(noise.unchangedItemIds).toEqual(['r1']);
            expect(cleared.flagged_at).toBeNull();
        });

        it('never flags an unchecked row, however far above its recorded amount it sits', () => {
            // An unchecked row has acknowledged nothing, so there is nothing to
            // warn it about — and the baseline is cleared rather than carried.
            const unchecked = row({
                id: 'r1',
                is_checked: false,
                quantity_grams: 3.1 * GRAMS_PER_POUND,
                display_quantity: 3.1,
                display_text: '3.1 lb',
                previous_quantity_grams: TWO_AND_A_HALF_LB,
            });
            const plan = diffGroceryList([unchecked], [massDraft(2.9 * GRAMS_PER_POUND)], chickenFacts, NOW);

            expect(plan.updates[0]).toMatchObject({
                display_text: '2.9 lb',
                flagged_at: null,
                previous_quantity_grams: null,
            });
        });

        /**
         * The user's own way out, and the reason a standing flag is safe: any
         * toggle re-acknowledges the amount on screen, so a row the shopper has
         * looked at again starts from that amount and a later fall to it has
         * nothing left to say.
         */
        it('stops flagging a row the shopper re-acknowledges by toggling it', () => {
            const flaggedRow = acknowledgedRow({
                quantity_grams: 3.1 * GRAMS_PER_POUND,
                display_quantity: 3.1,
                display_text: '3.1 lb',
                flagged_at: EARLIER,
            });
            const checkState = applyToggle(flaggedRow, true, NOW);
            const reacknowledged: StoredGroceryRow = {
                ...flaggedRow,
                is_checked: checkState.is_checked,
                previous_quantity_grams: checkState.previous_quantity_grams,
                flagged_at: checkState.flagged_at,
            };
            const plan = diffGroceryList([reacknowledged], [massDraft(2.9 * GRAMS_PER_POUND)], chickenFacts, NOW);

            expect(checkState.previous_quantity_grams).toBe(3.1 * GRAMS_PER_POUND);
            expect(checkState.flagged_at).toBeNull();
            expect(plan.updates[0]).toMatchObject({
                display_text: '2.9 lb',
                flagged_at: null,
                previous_quantity_grams: 3.1 * GRAMS_PER_POUND,
            });
            expect(buildGroceryFlag(applyUpdate(reacknowledged, plan.updates[0]), facts())).toBeNull();
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

        /**
         * A food whose `food_state` changes is a DIFFERENT line, because the
         * aggregation identity is `(catalog_food_id, food_state)`: the raw row
         * is REMOVED and the cooked one INSERTED. Treating the new state as an
         * in-place increase on the old row is the regression these cases exist
         * to catch, and it is a distinct rule from the two above —
         * `storedRowFamily` locks the family of a row that ALREADY EXISTS, so
         * it must not reach across a state change and impose the raw row's
         * family, its check, its standing flag or its acknowledged baseline on
         * a row the shopper has never seen.
         */
        describe('a food whose state changes from raw to cooked', () => {
            /**
             * The cooked identity counts its portions, so the family it implies
             * is not the raw row's. Its weight is the module's own ounce factor
             * rather than a decimal, and every quantity below is a multiple of
             * it, which is what keeps the counting arithmetic exact.
             */
            const COOKED_PORTION_GRAMS = 4 * GRAMS_PER_OUNCE;

            const cookedFacts = facts({
                food_state: COOKED,
                default_portion: portion({
                    description: 'cooked breast',
                    unit: 'each',
                    gram_weight: COOKED_PORTION_GRAMS,
                }),
            });

            /** Three cooked portions, named, numbered and rendered by the module itself. */
            const cookedDrafts = buildGroceryRows(
                [meal([{ catalog_food_id: CHICKEN, food_state: COOKED, gram_weight: 3 * COOKED_PORTION_GRAMS }])],
                [cookedFacts],
            );

            /** Checked, acknowledged at 2.5 lb and already flagged — none of that may travel. */
            const rawRow = acknowledgedRow({ flagged_at: EARLIER });

            const plan = diffGroceryList([rawRow], cookedDrafts, [facts(), cookedFacts], NOW);

            it('removes the raw row instead of updating it in place', () => {
                expect(plan.removals).toEqual([{ id: 'r1', name: 'Chicken breast', is_checked: true }]);
                expect(plan.updates).toEqual([]);
                expect(plan.unchangedItemIds).toEqual([]);
            });

            it('inserts the cooked line as a row of its own', () => {
                expect(cookedDrafts).toHaveLength(1);
                expect(plan.inserts).toEqual(cookedDrafts);
            });

            it('counts one addition and one removal, and no increase', () => {
                expect(plan.summary).toEqual({ added: 1, removed: 1, increased: 0 });
            });

            /**
             * `GroceryRowDraft` declares no `is_checked`, `flagged_at` or
             * `previous_quantity_grams` member, so the proof is the insert's OWN
             * key set: the check the shopper had ticked, the flag standing since
             * `EARLIER` and the 2.5 lb they acknowledged all die with the raw row
             * rather than leaking onto its replacement.
             */
            it('carries no check, no flag and no acknowledged baseline onto the new row', () => {
                expect(Object.keys(plan.inserts[0]).sort()).toEqual([
                    'catalog_food_id',
                    'category',
                    'display_quantity',
                    'display_text',
                    'display_unit',
                    'food_state',
                    'name',
                    'quantity_grams',
                    'sort_order',
                ]);
                expect(Object.keys(plan.inserts[0])).not.toContain('is_checked');
                expect(Object.keys(plan.inserts[0])).not.toContain('flagged_at');
                expect(Object.keys(plan.inserts[0])).not.toContain('previous_quantity_grams');
            });

            it('renders the new row in the family the new identity\u2019s own portion implies', () => {
                expect(rawRow.display_unit).toBe('lb');
                expect(storedRowFamily(rawRow)).toBe('mass');
                expect(plan.inserts[0]).toMatchObject({
                    catalog_food_id: CHICKEN,
                    food_state: COOKED,
                    name: 'Chicken breast, cooked',
                    display_quantity: 3,
                    display_unit: COUNT_DISPLAY_UNIT,
                    display_text: '3 cooked breasts',
                });
                expect(unitFamily(plan.inserts[0].display_unit)).toBe('count');
            });

            /**
             * Both states can also be on one list at once, which is the reason
             * the transition above is a new line rather than an increase. With
             * both present `buildGroceryName` suffixes BOTH: the cooked line
             * because its state is not `raw`, and the raw line because another
             * state of the same base name is on the list.
             */
            it('shops the two states of one catalog food as two distinctly named lines', () => {
                const rows = buildGroceryRows(
                    [
                        meal([
                            { catalog_food_id: CHICKEN, food_state: RAW, gram_weight: GRAMS_PER_POUND },
                            { catalog_food_id: CHICKEN, food_state: COOKED, gram_weight: 3 * COOKED_PORTION_GRAMS },
                        ]),
                    ],
                    [facts(), cookedFacts],
                );

                expect(rows.map((line) => [line.food_state, line.name])).toEqual([
                    [COOKED, 'Chicken breast, cooked'],
                    [RAW, 'Chicken breast, raw'],
                ]);
            });
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

    it('plans the writes without touching what it was given, and plans the same ones twice over', () => {
        const stored = [Object.freeze(acknowledgedRow({ flagged_at: EARLIER }))];
        const aggregated = [Object.freeze(massDraft(3.1 * GRAMS_PER_POUND))];
        const catalogFacts = [Object.freeze(facts())];
        const beforeDiffing = structuredClone({ stored, aggregated, catalogFacts });

        const first = diffGroceryList(stored, aggregated, catalogFacts, NOW);
        const second = diffGroceryList(stored, aggregated, catalogFacts, NOW);

        expect(first).toEqual(second);
        expect({ stored, aggregated, catalogFacts }).toEqual(beforeDiffing);
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

        /**
         * All three strings of a count flag are pre-formatted here and rendered
         * verbatim by the client, so each of them has to pluralise the portion
         * description on its own: "was 2 loaves", "Now 4 loaves", "+2 loaves".
         * The rows are built through `buildGroceryDisplay`, so the text the flag
         * is read against is the module's own rendering rather than a string
         * this test invented.
         */
        describe('the portion description carries the plural in every string', () => {
            /** A flagged count row of `items` portions, acknowledged at `baselineItems`. */
            const countedRow = (description: string, items: number, baselineItems: number): StoredGroceryRow => {
                const display = buildGroceryDisplay(
                    items * COUNTED_PORTION_GRAMS,
                    'count',
                    countedFacts(description),
                );

                return row({
                    quantity_grams: items * COUNTED_PORTION_GRAMS,
                    display_quantity: display.quantity,
                    display_unit: display.unit,
                    display_text: display.text,
                    previous_quantity_grams: baselineItems * COUNTED_PORTION_GRAMS,
                    flagged_at: NOW,
                });
            };

            it.each(PLURAL_DESCRIPTION_CASES)('pluralises %s as %s in was, now and the delta', (singular, plural) => {
                expect(buildGroceryFlag(countedRow(singular, 4, 2), countedFacts(singular))).toEqual({
                    previousDisplayText: `2 ${plural}`,
                    newDisplayText: `4 ${plural}`,
                    deltaDisplayText: `+2 ${plural}`,
                    flaggedAt: NOW.toISOString(),
                });
            });

            // One item more than one item: the "was" is the singular the shopper
            // acknowledged, the delta is one whole item, and only the new amount
            // is plural — the same rule the egg case above shows.
            it.each(PLURAL_DESCRIPTION_CASES)('keeps %s singular for a delta of one', (singular, plural) => {
                expect(buildGroceryFlag(countedRow(singular, 2, 1), countedFacts(singular))).toEqual({
                    previousDisplayText: `1 ${singular}`,
                    newDisplayText: `2 ${plural}`,
                    deltaDisplayText: `+1 ${singular}`,
                    flaggedAt: NOW.toISOString(),
                });
            });
        });

        /**
         * A portion that counts several items puts every string on the item
         * scale, including the baseline. `display_quantity` counts items, so
         * subtracting portions from it would report a fifth of the real
         * increase on a five-sprig portion — and the "was" would disagree with
         * both of the other two strings.
         */
        describe('a portion that counts several items', () => {
            // USDA's dill weed portion as the release stores it, `amount` and
            // all: five sprigs weighing one gram. The cardinality is the
            // column, so it is stated here rather than left to the default.
            const dillFacts = (): GroceryConversionFacts => ({
                density_g_per_ml: null,
                default_portion: portion({ description: '5 sprigs', amount: 5, unit: 'each', gram_weight: 1 }),
            });

            const dillRow = (grams: number, baselineGrams: number): StoredGroceryRow => {
                const display = buildGroceryDisplay(grams, 'count', dillFacts());

                return row({
                    quantity_grams: grams,
                    display_quantity: display.quantity,
                    display_unit: display.unit,
                    display_text: display.text,
                    previous_quantity_grams: baselineGrams,
                    flagged_at: NOW,
                });
            };

            it('measures the increase in items rather than in portions', () => {
                // 9 g of dill is 45 sprigs and 5 g is 25, so the shopper needs
                // twenty sprigs more — not the four portions the grams differ by.
                expect(buildGroceryFlag(dillRow(9, 5), dillFacts())).toEqual({
                    previousDisplayText: '25 sprigs',
                    newDisplayText: '45 sprigs',
                    deltaDisplayText: '+20 sprigs',
                    flaggedAt: NOW.toISOString(),
                });
            });

            it('reconciles the three strings, whatever the portion counts', () => {
                const flag = buildGroceryFlag(dillRow(4, 3), dillFacts());

                expect(flag).toMatchObject({
                    previousDisplayText: '15 sprigs',
                    newDisplayText: '20 sprigs',
                    deltaDisplayText: '+5 sprigs',
                });
            });

            it('counts from the rendered baseline when the items do not divide evenly', () => {
                // 8.5 g of dill is 42.5 sprigs and 7.5 g is 37.5. Rounding the
                // baseline for "was" and again for the pill put "38 sprigs"
                // beside "+6", which does not reach the 43 the row shows.
                expect(buildGroceryFlag(dillRow(8.5, 7.5), dillFacts())).toMatchObject({
                    previousDisplayText: '38 sprigs',
                    newDisplayText: '43 sprigs',
                    deltaDisplayText: '+5 sprigs',
                });
            });
        });

        describe('a baseline that renders to a whole item it does not equal', () => {
            /**
             * Real weekly amounts rarely divide by a portion weight, so the
             * baseline usually carries a fraction of an item. Every row here is
             * a food and a pair of amounts taken from the shipped release, and
             * every one of them read one item too high before the flag began
             * subtracting the number it had already rendered.
             */
            const FRACTIONAL_CASES: ReadonlyArray<{
                readonly food: string;
                readonly description: string;
                readonly gramWeight: number;
                readonly grams: number;
                readonly baselineGrams: number;
                readonly previous: string;
                readonly current: string;
                readonly delta: string;
            }> = [
                {
                    food: 'Avocado',
                    description: '1 avocado',
                    gramWeight: 201,
                    grams: 301.5,
                    baselineGrams: 100.5,
                    previous: '1 avocado',
                    current: '2 avocados',
                    delta: '+1 avocado',
                },
                {
                    food: 'Banana',
                    description: '1 banana, medium',
                    gramWeight: 118,
                    grams: 413,
                    baselineGrams: 295,
                    previous: '3 bananas, medium',
                    current: '4 bananas, medium',
                    delta: '+1 banana, medium',
                },
                {
                    food: 'Carrot',
                    description: '1 carrot, medium',
                    gramWeight: 61,
                    grams: 396.5,
                    baselineGrams: 335.5,
                    previous: '6 carrots, medium',
                    current: '7 carrots, medium',
                    delta: '+1 carrot, medium',
                },
                {
                    food: 'Garlic',
                    description: '1 clove',
                    gramWeight: 3,
                    grams: 40.5,
                    baselineGrams: 37.5,
                    previous: '13 cloves',
                    current: '14 cloves',
                    delta: '+1 clove',
                },
                {
                    food: 'Potato, russet',
                    description: '1 potato, medium',
                    gramWeight: 213,
                    grams: 319.5,
                    baselineGrams: 106.5,
                    previous: '1 potato, medium',
                    current: '2 potatoes, medium',
                    delta: '+1 potato, medium',
                },
            ];

            it.each(FRACTIONAL_CASES)(
                '$food reads "was $previous", "$current" and "$delta", which add up',
                ({ description, gramWeight, grams, baselineGrams, previous, current, delta }) => {
                    const facts: GroceryConversionFacts = {
                        density_g_per_ml: null,
                        default_portion: portion({ description, unit: 'each', gram_weight: gramWeight }),
                    };
                    const display = buildGroceryDisplay(grams, 'count', facts);

                    const flag = buildGroceryFlag(
                        row({
                            quantity_grams: grams,
                            display_quantity: display.quantity,
                            display_unit: display.unit,
                            display_text: display.text,
                            previous_quantity_grams: baselineGrams,
                            flagged_at: NOW,
                        }),
                        facts,
                    );

                    expect(flag).toMatchObject({
                        previousDisplayText: previous,
                        newDisplayText: current,
                        deltaDisplayText: delta,
                    });

                    const wholeItemsAdded = Number(delta.slice(1, delta.indexOf(' ')));
                    expect(Number(previous.slice(0, previous.indexOf(' '))) + wholeItemsAdded).toBe(display.quantity);
                },
            );
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

        // THE SHIPPED SHAPE on the flag path, which reads the density a second
        // time — once for "was Y" and once for the delta pill. A release food
        // carries no `density_g_per_ml`, so all three strings of the 14b flag
        // are produced from the density its portion states: a cup of this food
        // weighs 240 g, so 1 cup was acknowledged, 1¼ cups are needed, and the
        // pill reconciles the two.
        it('renders all three strings for a food whose density comes from its portion', () => {
            const coldBrew = groceryFacts('ai:beverage:cold brew coffee concentrate:prepared');
            const gramsPerCup = 240;
            const flagged = oilRow({
                catalog_food_id: coldBrew.catalog_food_id,
                name: 'Cold brew coffee concentrate',
                quantity_grams: 1.25 * gramsPerCup,
                display_quantity: 1.25,
                display_text: '1¼ cups',
                previous_quantity_grams: gramsPerCup,
            });

            expect(buildGroceryFlag(flagged, coldBrew)).toMatchObject({
                previousDisplayText: '1 cup',
                newDisplayText: '1¼ cups',
                deltaDisplayText: '+¼ cup',
            });
        });

        // The lock's counterpart on this path: a stored volume row whose food
        // can state no density at all is a broken invariant, and the flag fails
        // loudly rather than describing an amount nothing measured.
        it('refuses to render a stored volume row whose food can state no density', () => {
            const flagged = oilRow({
                quantity_grams: 1.25 * MILLILITERS_PER_CUP,
                display_quantity: 1.25,
                display_text: '1¼ cups',
                previous_quantity_grams: MILLILITERS_PER_CUP,
            });

            expect(() =>
                buildGroceryFlag(flagged, { density_g_per_ml: null, default_portion: portion() }),
            ).toThrow(UnitConversionError);
        });

        it('stays in tablespoons when the row never leaves them', () => {
            // A quarter-tablespoon more of oil: the row's unit can hold the
            // baseline and the gap, so nothing is re-tiered and all three
            // strings are tablespoons.
            const flagged = oilRow({
                display_unit: 'tbsp',
                quantity_grams: 15.5 * MILLILITERS_PER_TABLESPOON,
                display_quantity: 15.5,
                display_text: '15½ tbsp',
                previous_quantity_grams: 15.25 * MILLILITERS_PER_TABLESPOON,
            });

            expect(buildGroceryFlag(flagged, oilFacts())).toMatchObject({
                previousDisplayText: '15¼ tbsp',
                newDisplayText: '15½ tbsp',
                deltaDisplayText: '+¼ tbsp',
            });
        });
    });

    /**
     * The three strings are read together — "Now 2 cups", "was ¾ cup", "+1¼
     * cups" — so all three are rendered in the ROW's unit even when the
     * acknowledged amount, taken on its own, would be rendered in a smaller
     * one. Letting the baseline choose its own unit is what put "was 14 tbsp"
     * beside "2 cups" with a "+1 cup" pill: each string was true and the three
     * did not add up.
     */
    describe('a baseline whose own unit would differ from the row\u2019s', () => {
        const cupRow = (baselineTablespoons: number): StoredGroceryRow =>
            row({
                catalog_food_id: OLIVE_OIL,
                name: 'Olive oil',
                quantity_grams: 2 * MILLILITERS_PER_CUP,
                display_quantity: 2,
                display_unit: 'cups',
                display_text: '2 cups',
                previous_quantity_grams: baselineTablespoons * MILLILITERS_PER_TABLESPOON,
                flagged_at: NOW,
            });

        it('reads a tablespoon-scale baseline in the row\u2019s cups', () => {
            // 14 tbsp is ⅞ of a cup, which the quarter precision this row
            // displays reads as 1 — and 1 + 1 = 2, the amount beside it.
            // formatVolume, asked on its own, would have said "14 tbsp".
            expect(buildGroceryFlag(cupRow(14), oilFacts())).toEqual({
                previousDisplayText: '1 cup',
                newDisplayText: '2 cups',
                deltaDisplayText: '+1 cup',
                flaggedAt: NOW.toISOString(),
            });
        });

        it('keeps a fractional baseline fractional, in the row\u2019s unit', () => {
            // 10 tbsp is ⅝ of a cup, which quarter precision reads as ¾, and
            // ¾ + 1¼ = 2.
            expect(buildGroceryFlag(cupRow(10), oilFacts())).toMatchObject({
                previousDisplayText: '¾ cup',
                deltaDisplayText: '+1¼ cups',
            });
        });

        it('reads an ounce-scale baseline in the row\u2019s pounds', () => {
            // 8.7 oz is 246.6 g, which formatMass renders in ounces; in pounds
            // it is 0.5, and 0.5 + 0.7 = 1.2 exactly.
            const flagged = row({
                quantity_grams: 1.2 * GRAMS_PER_POUND,
                display_quantity: 1.2,
                display_unit: 'lb',
                display_text: '1.2 lb',
                previous_quantity_grams: 8.7 * GRAMS_PER_OUNCE,
                flagged_at: NOW,
            });

            expect(buildGroceryFlag(flagged, facts())).toEqual({
                previousDisplayText: '0.5 lb',
                newDisplayText: '1.2 lb',
                deltaDisplayText: '+0.7 lb',
                flaggedAt: NOW.toISOString(),
            });
        });

        it('keeps a gram row at whole grams, the precision that unit displays', () => {
            const flagged = row({
                quantity_grams: 25,
                display_quantity: 25,
                display_unit: 'g',
                display_text: '25 g',
                previous_quantity_grams: 10,
                flagged_at: NOW,
            });

            expect(buildGroceryFlag(flagged, facts())).toMatchObject({
                previousDisplayText: '10 g',
                deltaDisplayText: '+15 g',
            });
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

    /**
     * A check mark is state-setting and last-write-wins: §0.5.1 gives the
     * grocery writes no idempotency key and no expected revision, and the body
     * is where either would first appear. The mapped type below stops
     * compiling the moment the payload grows a second field, and the parse
     * REFUSES a client that sends one anyway — so making check marks
     * revisioned has to be a deliberate change to this test rather than a quiet
     * one somewhere else.
     *
     * Refusing rather than ignoring is the point: "this route needs no
     * revision" is a statement about what it requires, and a request accepted
     * with an `expectedPlanRevision` in it is the server telling the client a
     * concurrency guard was applied when none exists.
     */
    it('names the desired state alone, refusing an idempotency key and an expected revision', () => {
        const everyPayloadField: { [K in keyof ToggleGroceryItemPayload]-?: true } = { isChecked: true };

        expect(Object.keys(everyPayloadField)).toEqual(['isChecked']);
        expect(
            parseToggleGroceryBody({
                isChecked: true,
                idempotencyKey: '0f4d8a2e-6b1c-4f3a-9e7d-2c5b8a1f6d40',
                expectedPlanRevision: 4,
            }),
        ).toEqual({
            kind: 'error',
            code: 'invalid_request',
            message: 'The grocery check request is not valid',
            details: [
                { field: 'idempotencyKey', code: GROCERY_FIELD_CODES.UNKNOWN_FIELD },
                { field: 'expectedPlanRevision', code: GROCERY_FIELD_CODES.UNKNOWN_FIELD },
            ],
        });
    });

    it('names an unknown field on its own, the way its four sibling writes do', () => {
        expect(parseToggleGroceryBody({ isChecked: true, userId: 'someone-else' })).toMatchObject({
            kind: 'error',
            code: 'invalid_request',
            details: [{ field: 'userId', code: GROCERY_FIELD_CODES.UNKNOWN_FIELD }],
        });
    });

    it('reports every unknown key rather than only the first', () => {
        expect(
            parseToggleGroceryBody({ isChecked: true, quantityGrams: 400, flag: null, planId: PLAN_ID }),
        ).toMatchObject({
            details: [
                { field: 'quantityGrams', code: GROCERY_FIELD_CODES.UNKNOWN_FIELD },
                { field: 'flag', code: GROCERY_FIELD_CODES.UNKNOWN_FIELD },
                { field: 'planId', code: GROCERY_FIELD_CODES.UNKNOWN_FIELD },
            ],
        });
    });

    it('accumulates the two kinds of problem, so a caller is not sent back twice', () => {
        // The same discipline `parseGroceryItemPath` applies to its two ids: a
        // body with a bad `isChecked` AND a stray key reports both.
        expect(parseToggleGroceryBody({ isChecked: 'yes', expectedPlanRevision: 7 })).toMatchObject({
            details: [
                { field: 'isChecked', code: GROCERY_FIELD_CODES.INVALID_TYPE },
                { field: 'expectedPlanRevision', code: GROCERY_FIELD_CODES.UNKNOWN_FIELD },
            ],
        });
    });

    it('still reports the missing field alone when the body carries nothing else', () => {
        // The single-field sentences are unchanged, so a client rendering
        // either beside the field keeps its copy.
        expect(parseToggleGroceryBody({ expectedPlanRevision: 7 })).toMatchObject({
            message: 'The grocery check request is not valid',
            details: [
                { field: 'isChecked', code: GROCERY_FIELD_CODES.REQUIRED },
                { field: 'expectedPlanRevision', code: GROCERY_FIELD_CODES.UNKNOWN_FIELD },
            ],
        });
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
