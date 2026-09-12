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
import {
    GRAMS_PER_OUNCE,
    GRAMS_PER_POUND,
    MILLILITERS_PER_CUP,
    MILLILITERS_PER_TABLESPOON,
    UnitConversionError,
    unitFamily,
} from '../../utils/units';

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

const CHICKEN = 'chicken-breast';
const OLIVE_OIL = 'olive-oil';
const EGG = 'egg';
const RICE = 'rice';
const RAW = 'raw';
const COOKED = 'cooked';
const DRY = 'dry';

const NOW = new Date('2026-07-05T12:00:00.000Z');
const EARLIER = new Date('2026-07-04T09:30:00.000Z');

const portion = (overrides: Partial<GroceryDefaultPortion> = {}): GroceryDefaultPortion => ({
    description: 'breast',
    unit: 'oz',
    gram_weight: GRAMS_PER_OUNCE,
    ...overrides,
});

const facts = (overrides: Partial<GroceryFoodFacts> = {}): GroceryFoodFacts => ({
    catalog_food_id: CHICKEN,
    food_state: RAW,
    name: 'Chicken breast',
    category: 'protein_poultry',
    density_g_per_ml: null,
    default_portion: portion(),
    ...overrides,
});

/** Water-like, so a millilitre of it weighs a gram and the arithmetic stays readable. */
const oilFacts = (overrides: Partial<GroceryFoodFacts> = {}): GroceryFoodFacts =>
    facts({
        catalog_food_id: OLIVE_OIL,
        name: 'Olive oil',
        category: 'oil_fat',
        density_g_per_ml: 1,
        default_portion: portion({ description: 'tbsp', unit: 'tbsp', gram_weight: MILLILITERS_PER_TABLESPOON }),
        ...overrides,
    });

const eggFacts = (overrides: Partial<GroceryFoodFacts> = {}): GroceryFoodFacts =>
    facts({
        catalog_food_id: EGG,
        name: 'Eggs',
        category: 'protein_egg',
        density_g_per_ml: null,
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
    const aisleFoods: GroceryFoodFacts[] = [
        facts({ catalog_food_id: 'soy-sauce', name: 'Soy sauce', category: 'condiment_sauce' }),
        facts({ catalog_food_id: RICE, name: 'Brown rice', category: 'grain', food_state: DRY }),
        facts({ catalog_food_id: 'yogurt', name: 'Greek yogurt', category: 'dairy' }),
        facts({ catalog_food_id: CHICKEN, name: 'Chicken breast', category: 'protein_poultry' }),
        facts({ catalog_food_id: 'spinach', name: 'Spinach', category: 'produce_vegetable' }),
    ];

    const aisleMeal = meal([
        { catalog_food_id: 'soy-sauce', gram_weight: 100 },
        { catalog_food_id: RICE, food_state: DRY, gram_weight: 100 },
        { catalog_food_id: 'yogurt', gram_weight: 100 },
        { catalog_food_id: CHICKEN, gram_weight: 100 },
        { catalog_food_id: 'spinach', gram_weight: 100 },
    ]);

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
                    { catalog_food_id: OLIVE_OIL, gram_weight: MILLILITERS_PER_CUP },
                ]),
            ],
            [eggFacts(), oilFacts()],
        );

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

        it('keeps the flag, and its original time, while the amount is still above what was acknowledged', () => {
            const plan = diffGroceryList(
                [
                    acknowledgedRow({
                        quantity_grams: 3.1 * GRAMS_PER_POUND,
                        display_quantity: 3.1,
                        display_text: '3.1 lb',
                        flagged_at: EARLIER,
                    }),
                ],
                [massDraft(2.9 * GRAMS_PER_POUND)],
                chickenFacts,
                NOW,
            );

            expect(plan.updates[0]).toMatchObject({
                display_text: '2.9 lb',
                flagged_at: EARLIER,
                previous_quantity_grams: TWO_AND_A_HALF_LB,
            });
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
        expect(error).toMatchObject({ reason: 'ended', replacementPlanId: undefined });
    });

    it('refuses a superseded plan and points at the plan that replaced it', () => {
        const error = captureError(() =>
            requireGroceryWritablePlan(
                { ...activePlan, status: 'superseded', replacement_plan_id: ITEM_ID },
                '2026-07-05',
            ),
        );

        expect(error).toBeInstanceOf(PlanNotActiveError);
        expect(error).toMatchObject({ replacementPlanId: ITEM_ID, reason: undefined });
    });

    it('refuses a superseded plan even when no replacement is known', () => {
        const error = captureError(() =>
            requireGroceryWritablePlan({ ...activePlan, status: 'superseded' }, '2026-07-05'),
        );

        expect(error).toMatchObject({ replacementPlanId: undefined });
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
    });
});

