/**
 * `src/utils/units.ts` is the numeric and display contract of the weekly
 * grocery list. This suite pins the decisions a reader cannot verify by eye:
 * that every recognised token belongs to exactly one family and an
 * unrecognised token to none, the definitional conversion factors, the
 * 16 oz / 16 tbsp promotion thresholds together with the re-round that makes
 * "16.0 oz" unprintable, the refusal to cross mass and volume without a stored
 * density, the clamp that stops a positive quantity reading as zero, and the
 * irregular plurals.
 *
 * The token tables below are exhaustive rather than sampled, because a token
 * quietly changing family is the corruption the one-family invariant exists to
 * prevent: a grocery row's family is chosen once at plan generation and read
 * from its stored `display_unit` afterwards, so an update may move oz to lb but
 * must never move mass to count.
 *
 * Aggregation, the equality epsilon, aisle categories, the "Now X, was Y"
 * sub-line and the delta pill belong to the grocery domain logic that composes
 * these values, and are asserted with it rather than here.
 */

import {
    BaseQuantity,
    DisplayQuantity,
    GRAMS_PER_KILOGRAM,
    GRAMS_PER_OUNCE,
    GRAMS_PER_POUND,
    MILLILITERS_PER_CUP,
    MILLILITERS_PER_FLUID_OUNCE,
    MILLILITERS_PER_LITER,
    MILLILITERS_PER_TABLESPOON,
    MILLILITERS_PER_TEASPOON,
    OUNCES_PER_POUND,
    TABLESPOONS_PER_CUP,
    UnitConversionError,
    UnitFamily,
    unitFamily,
    toBaseQuantity,
    millilitersToGrams,
    gramsToMilliliters,
    formatMass,
    formatVolume,
    formatQuarters,
    pluralizeCount,
    formatCount,
} from '../units';

const MASS_UNITS: string[] = [
    'g',
    'gram',
    'grams',
    'kg',
    'kilogram',
    'kilograms',
    'oz',
    'ounce',
    'ounces',
    'lb',
    'lbs',
    'pound',
    'pounds',
];

const VOLUME_UNITS: string[] = [
    'ml',
    'milliliter',
    'milliliters',
    'l',
    'liter',
    'liters',
    'tsp',
    'teaspoon',
    'teaspoons',
    'tbsp',
    'tablespoon',
    'tablespoons',
    'cup',
    'cups',
    'fl oz',
    'fluid ounce',
    'fluid ounces',
];

const COUNT_UNITS: string[] = [
    'each',
    'piece',
    'pieces',
    'count',
    'whole',
    'clove',
    'cloves',
    'slice',
    'slices',
    'head',
    'heads',
    'bunch',
    'bunches',
];

const RECOGNISED_UNITS: string[] = MASS_UNITS.concat(VOLUME_UNITS, COUNT_UNITS);

const NON_FINITE_QUANTITIES: Array<[string, number]> = [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
];

const INVALID_DENSITIES: Array<[string, number | null | undefined]> = [
    ['null', null],
    ['undefined', undefined],
    ['zero', 0],
    ['negative', -1],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
];

/** The error a call throws, so both its `name` and its message can be asserted. */
const thrownBy = (call: () => unknown): Error => {
    try {
        call();
    } catch (error) {
        return error as Error;
    }

    throw new Error('Expected the call to throw, but it returned normally');
};

describe('unitFamily — recognised tokens', () => {
    it.each(MASS_UNITS)('resolves %s to the mass family', (unit) => {
        expect(unitFamily(unit)).toBe('mass');
    });

    it.each(VOLUME_UNITS)('resolves %s to the volume family', (unit) => {
        expect(unitFamily(unit)).toBe('volume');
    });

    it.each(COUNT_UNITS)('resolves %s to the count family', (unit) => {
        expect(unitFamily(unit)).toBe('count');
    });

    it('partitions the recognised tokens into exactly the three declared families', () => {
        const tokensIn = (family: UnitFamily): string[] =>
            RECOGNISED_UNITS.filter((unit) => unitFamily(unit) === family);

        expect(tokensIn('mass')).toEqual(MASS_UNITS);
        expect(tokensIn('volume')).toEqual(VOLUME_UNITS);
        expect(tokensIn('count')).toEqual(COUNT_UNITS);
    });

    it('reads oz as a weight ounce and fl oz as a fluid ounce', () => {
        expect(unitFamily('oz')).toBe('mass');
        expect(unitFamily('fl oz')).toBe('volume');
    });

    it('rejects the run-together spelling floz instead of guessing which ounce it means', () => {
        // "floz" could be either ounce, and a wrong guess here crosses mass and
        // volume. The spaced spelling is the only accepted fluid ounce.
        expect(unitFamily('floz')).toBeNull();
    });
});

describe('unitFamily — normalisation', () => {
    const NORMALISED_CASES: Array<[string, UnitFamily]> = [
        [' LB ', 'mass'],
        [' G ', 'mass'],
        ['KG', 'mass'],
        ['Ounces', 'mass'],
        ['Cups', 'volume'],
        ['Fl Oz', 'volume'],
        ['fluid  ounces', 'volume'],
        ['TBSP', 'volume'],
        ['EACH', 'count'],
    ];

    it.each(NORMALISED_CASES)('resolves %p to the %s family', (unit, family) => {
        expect(unitFamily(unit)).toBe(family);
    });
});

describe('unitFamily — unrecognised tokens', () => {
    const UNRECOGNISED_UNITS: Array<[string, string]> = [
        ['a container unit', 'bottle'],
        ['another container unit', 'sachet'],
        ['a packaging unit', 'can'],
        ['an empty token', ''],
        ['whitespace', '   '],
        ['an unrelated unit', 'furlong'],
        ['a near miss', 'grammes'],
    ];

    it.each(UNRECOGNISED_UNITS)('answers null for %s rather than guessing a family', (_case, unit) => {
        expect(unitFamily(unit)).toBeNull();
    });

    it.each(['constructor', '__proto__', 'toString', 'valueOf', 'hasOwnProperty'])(
        'answers null for the inherited object member %p',
        (unit) => {
            expect(unitFamily(unit)).toBeNull();
        },
    );
});

describe('toBaseQuantity — mass', () => {
    const MASS_CASES: Array<[string, number, string, number]> = [
        ['grams are the base unit', 250, 'g', 250],
        ['a kilogram is a thousand grams', 2, 'kg', 2000],
        ['an ounce is 28.349523125 g', 1, 'oz', 28.349523125],
        ['a pound is 453.59237 g', 1, 'lb', 453.59237],
        ['a fractional pound scales', 0.5, 'lb', 226.796185],
    ];

    it.each(MASS_CASES)('converts %s', (_case, amount, unit, expected) => {
        const quantity = toBaseQuantity(amount, unit);

        expect(quantity.family).toBe('mass');
        expect(quantity.amount).toBeCloseTo(expected, 5);
    });

    it('agrees that sixteen ounces make a pound', () => {
        expect(toBaseQuantity(OUNCES_PER_POUND, 'oz').amount).toBeCloseTo(toBaseQuantity(1, 'lb').amount, 5);
    });
});

describe('toBaseQuantity — volume', () => {
    const VOLUME_CASES: Array<[string, number, string, number]> = [
        ['millilitres are the base unit', 500, 'ml', 500],
        ['a litre is a thousand millilitres', 1.5, 'l', 1500],
        ['a cup is 236.5882365 ml', 1, 'cup', 236.5882365],
        ['a tablespoon is a sixteenth of a cup', 1, 'tbsp', 14.78676478125],
        ['a teaspoon is a third of a tablespoon', 1, 'tsp', 4.92892159375],
        ['a fluid ounce is two tablespoons', 1, 'fl oz', 29.5735295625],
        ['a fractional cup scales', 0.25, 'cup', 59.147059125],
    ];

    it.each(VOLUME_CASES)('converts %s', (_case, amount, unit, expected) => {
        const quantity = toBaseQuantity(amount, unit);

        expect(quantity.family).toBe('volume');
        expect(quantity.amount).toBeCloseTo(expected, 5);
    });

    it('agrees that sixteen tablespoons make a cup', () => {
        expect(toBaseQuantity(TABLESPOONS_PER_CUP, 'tbsp').amount).toBeCloseTo(toBaseQuantity(1, 'cup').amount, 5);
    });
});

describe('toBaseQuantity — count and edge cases', () => {
    it('reports the converted quantity as a family and a base amount', () => {
        const expected: BaseQuantity = { family: 'mass', amount: 250 };

        expect(toBaseQuantity(250, 'g')).toEqual(expected);
    });

    it('passes a count through unchanged', () => {
        expect(toBaseQuantity(4, 'each')).toEqual({ family: 'count', amount: 4 });
    });

    it('passes a count through for every count token, not only the base word', () => {
        expect(toBaseQuantity(3, 'cloves')).toEqual({ family: 'count', amount: 3 });
    });

    it('carries a zero quantity through without inventing one', () => {
        expect(toBaseQuantity(0, 'g')).toEqual({ family: 'mass', amount: 0 });
    });

    it('carries a negative quantity through, for a correction', () => {
        expect(toBaseQuantity(-2, 'kg')).toEqual({ family: 'mass', amount: -2000 });
    });

    it('throws for a container unit, naming it', () => {
        expect(() => toBaseQuantity(1, 'bottle')).toThrow(UnitConversionError);
        expect(() => toBaseQuantity(1, 'bottle')).toThrow('Unrecognised unit "bottle"');
    });

    it('throws for an empty unit', () => {
        expect(() => toBaseQuantity(1, '')).toThrow(UnitConversionError);
        expect(() => toBaseQuantity(1, '')).toThrow('Unrecognised unit ""');
    });

    it('throws for an inherited object member rather than yielding a quantity with no family', () => {
        expect(() => toBaseQuantity(1, 'constructor')).toThrow(UnitConversionError);
        expect(() => toBaseQuantity(1, '__proto__')).toThrow(UnitConversionError);
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s quantity', (_case, amount) => {
        expect(() => toBaseQuantity(amount, 'g')).toThrow(UnitConversionError);
        expect(() => toBaseQuantity(amount, 'g')).toThrow('quantity must be a finite number');
    });
});

describe('millilitersToGrams', () => {
    it('applies a water-like density', () => {
        expect(millilitersToGrams(240, 1)).toBeCloseTo(240, 5);
    });

    it('applies an oil-like density', () => {
        expect(millilitersToGrams(250, 0.92)).toBeCloseTo(230, 5);
    });

    it('converts a zero quantity', () => {
        expect(millilitersToGrams(0, 1.03)).toBe(0);
    });

    it.each(INVALID_DENSITIES)(
        'refuses a %s density rather than assuming 1 g/ml, because millilitres never equal grams',
        (_case, density) => {
            expect(() => millilitersToGrams(100, density)).toThrow(UnitConversionError);
            expect(() => millilitersToGrams(100, density)).toThrow(
                'A positive density_g_per_ml is required to convert millilitres to grams',
            );
        },
    );

    it.each(INVALID_DENSITIES)('names the rejected %s density in the message', (_case, density) => {
        expect(() => millilitersToGrams(100, density)).toThrow(String(density));
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s quantity', (_case, milliliters) => {
        expect(() => millilitersToGrams(milliliters, 1)).toThrow('millilitres must be a finite number');
    });

    it('reports the failure as a UnitConversionError by name', () => {
        expect(thrownBy(() => millilitersToGrams(100, null)).name).toBe('UnitConversionError');
    });
});

describe('gramsToMilliliters', () => {
    it('applies a water-like density', () => {
        expect(gramsToMilliliters(240, 1)).toBeCloseTo(240, 5);
    });

    it('applies an oil-like density', () => {
        expect(gramsToMilliliters(230, 0.92)).toBeCloseTo(250, 5);
    });

    it('converts a zero quantity', () => {
        expect(gramsToMilliliters(0, 1.03)).toBe(0);
    });

    it('round-trips a quantity back to where it started', () => {
        expect(gramsToMilliliters(millilitersToGrams(240, 0.92), 0.92)).toBeCloseTo(240, 5);
    });

    it.each(INVALID_DENSITIES)(
        'refuses a %s density rather than assuming 1 g/ml, because grams never equal millilitres',
        (_case, density) => {
            expect(() => gramsToMilliliters(100, density)).toThrow(UnitConversionError);
            expect(() => gramsToMilliliters(100, density)).toThrow(
                'A positive density_g_per_ml is required to convert grams to millilitres',
            );
        },
    );

    it.each(INVALID_DENSITIES)('names the rejected %s density in the message', (_case, density) => {
        expect(() => gramsToMilliliters(100, density)).toThrow(String(density));
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s quantity', (_case, grams) => {
        expect(() => gramsToMilliliters(grams, 1)).toThrow('grams must be a finite number');
    });

    it('reports the failure as a UnitConversionError by name', () => {
        expect(thrownBy(() => gramsToMilliliters(100, null)).name).toBe('UnitConversionError');
    });
});

describe('formatMass — the largest unit that keeps the value at or above one', () => {
    const MASS_TEXT_CASES: Array<[number, string]> = [
        [15, '15 g'],
        [20, '20 g'],
        [28, '28 g'],
        [GRAMS_PER_OUNCE, '1 oz'],
        [100, '3.5 oz'],
        [4 * GRAMS_PER_OUNCE, '4 oz'],
        [400, '14.1 oz'],
        [GRAMS_PER_POUND, '1 lb'],
        [1.2 * GRAMS_PER_POUND, '1.2 lb'],
        [2.5 * GRAMS_PER_POUND, '2.5 lb'],
        [1000, '2.2 lb'],
    ];

    it.each(MASS_TEXT_CASES)('renders %p grams as %p', (grams, text) => {
        expect(formatMass(grams).text).toBe(text);
    });

    it('reports the rounded value, its unit, and the text that renders the pair', () => {
        const expected: DisplayQuantity = { value: 4, unit: 'oz', text: '4 oz' };

        expect(formatMass(4 * GRAMS_PER_OUNCE)).toEqual(expected);
    });

    it('keeps grams below an ounce instead of rendering a fraction of one', () => {
        expect(formatMass(28)).toEqual({ value: 28, unit: 'g', text: '28 g' });
    });

    it('keeps 15.9 oz in ounces, because it has not reached a pound', () => {
        expect(formatMass(15.9 * GRAMS_PER_OUNCE)).toEqual({ value: 15.9, unit: 'oz', text: '15.9 oz' });
    });

    it('promotes 15.96 oz to a pound rather than printing 16.0 oz', () => {
        // Choosing the unit and rounding to its precision interact: 15.96 oz
        // rounds to 16.0 oz, which has already reached a pound. Promoting once
        // and re-rounding is what makes "16.0 oz" an impossible output.
        expect(formatMass(15.96 * GRAMS_PER_OUNCE)).toEqual({ value: 1, unit: 'lb', text: '1 lb' });
    });

    it('drops a trailing zero decimal', () => {
        expect(formatMass(4 * GRAMS_PER_OUNCE).text).toBe('4 oz');
        expect(formatMass(2 * GRAMS_PER_POUND).text).toBe('2 lb');
    });

    it('never displays a positive quantity as zero', () => {
        // A grocery row must not read "0 g" for salt the recipe actually needs.
        expect(formatMass(0.4)).toEqual({ value: 1, unit: 'g', text: '1 g' });
    });

    it('renders a true zero as zero rather than clamping it up', () => {
        expect(formatMass(0)).toEqual({ value: 0, unit: 'g', text: '0 g' });
    });

    it('keeps the smallest unit for a negative quantity instead of promoting it', () => {
        expect(formatMass(-10)).toEqual({ value: -10, unit: 'g', text: '-10 g' });
    });

    it('leaves the abbreviated mass units invariant above one', () => {
        expect(formatMass(7).unit).toBe('g');
        expect(formatMass(7 * GRAMS_PER_OUNCE).unit).toBe('oz');
        expect(formatMass(7 * GRAMS_PER_POUND).unit).toBe('lb');
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s quantity, naming grams', (_case, grams) => {
        expect(() => formatMass(grams)).toThrow(UnitConversionError);
        expect(() => formatMass(grams)).toThrow('grams must be a finite number');
    });
});

describe('formatVolume — the largest unit that keeps the value at or above one', () => {
    const VOLUME_TEXT_CASES: Array<[number, string]> = [
        [5, '5 ml'],
        [10, '10 ml'],
        [MILLILITERS_PER_TABLESPOON, '1 tbsp'],
        [2.5 * MILLILITERS_PER_TABLESPOON, '2½ tbsp'],
        [6 * MILLILITERS_PER_TABLESPOON, '6 tbsp'],
        [7 * MILLILITERS_PER_TABLESPOON, '7 tbsp'],
        [100, '6¾ tbsp'],
        [MILLILITERS_PER_CUP, '1 cup'],
        [1.5 * MILLILITERS_PER_CUP, '1½ cups'],
        [1.75 * MILLILITERS_PER_CUP, '1¾ cups'],
        [2 * MILLILITERS_PER_CUP, '2 cups'],
        [7 * MILLILITERS_PER_CUP, '7 cups'],
    ];

    it.each(VOLUME_TEXT_CASES)('renders %p millilitres as %p', (milliliters, text) => {
        expect(formatVolume(milliliters).text).toBe(text);
    });

    it('promotes millilitres to a tablespoon once rounding reaches one', () => {
        expect(formatVolume(14.7)).toEqual({ value: 1, unit: 'tbsp', text: '1 tbsp' });
    });

    it('promotes 15.9 tbsp to a cup rather than printing 16 tbsp', () => {
        expect(formatVolume(15.9 * MILLILITERS_PER_TABLESPOON)).toEqual({
            value: 1,
            unit: 'cup',
            text: '1 cup',
        });
    });

    it('reports three quarters of a cup in tablespoons, because the tier rule keeps the value at or above one', () => {
        expect(formatVolume(0.75 * MILLILITERS_PER_CUP).text).toBe('12 tbsp');
    });

    it('pluralises the cup above one and leaves it singular at one', () => {
        expect(formatVolume(MILLILITERS_PER_CUP).unit).toBe('cup');
        expect(formatVolume(2 * MILLILITERS_PER_CUP).unit).toBe('cups');
    });

    it('leaves the abbreviated volume units invariant above one', () => {
        expect(formatVolume(7 * MILLILITERS_PER_TABLESPOON).unit).toBe('tbsp');
        expect(formatVolume(7).unit).toBe('ml');
    });

    it('never displays a positive quantity as zero', () => {
        expect(formatVolume(0.4)).toEqual({ value: 1, unit: 'ml', text: '1 ml' });
    });

    it('renders a true zero as zero rather than clamping it up', () => {
        expect(formatVolume(0)).toEqual({ value: 0, unit: 'ml', text: '0 ml' });
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s quantity, naming millilitres', (_case, milliliters) => {
        expect(() => formatVolume(milliliters)).toThrow(UnitConversionError);
        expect(() => formatVolume(milliliters)).toThrow('millilitres must be a finite number');
    });
});

describe('formatQuarters', () => {
    const QUARTER_CASES: Array<[number, string]> = [
        [0, '0'],
        [0.25, '¼'],
        [0.5, '½'],
        [0.75, '¾'],
        [1, '1'],
        [1.25, '1¼'],
        [1.5, '1½'],
        [1.75, '1¾'],
        [2, '2'],
        [7, '7'],
    ];

    it.each(QUARTER_CASES)('renders %p as %p', (value, expected) => {
        expect(formatQuarters(value)).toBe(expected);
    });

    it('sets the whole number against the glyph with no space between them', () => {
        expect(formatQuarters(1.25)).toBe('1¼');
        expect(formatQuarters(12.5)).toBe('12½');
    });

    const ROUNDING_CASES: Array<[number, string]> = [
        [0.1, '0'],
        [0.125, '¼'],
        [0.24, '¼'],
        [0.26, '¼'],
        [0.375, '½'],
        [2.87, '2¾'],
        [2.9, '3'],
    ];

    it.each(ROUNDING_CASES)('rounds %p to the nearest quarter, giving %p', (value, expected) => {
        expect(formatQuarters(value)).toBe(expected);
    });

    const SIGNED_CASES: Array<[number, string]> = [
        [-0.25, '-¼'],
        [-1.25, '-1¼'],
        [-2, '-2'],
    ];

    it.each(SIGNED_CASES)('keeps the sign outside the glyph for %p', (value, expected) => {
        expect(formatQuarters(value)).toBe(expected);
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s quantity', (_case, value) => {
        expect(() => formatQuarters(value)).toThrow(UnitConversionError);
    });
});

describe('pluralizeCount — the count decides', () => {
    it('leaves the description singular for exactly one', () => {
        expect(pluralizeCount(1, 'egg')).toBe('egg');
    });

    it('leaves the description singular for minus one', () => {
        expect(pluralizeCount(-1, 'egg')).toBe('egg');
    });

    it('pluralises for zero, as English does', () => {
        expect(pluralizeCount(0, 'egg')).toBe('eggs');
    });

    it.each([2, 12, 1.5])('pluralises for a count of %p', (count) => {
        expect(pluralizeCount(count, 'egg')).toBe('eggs');
    });
});

describe('pluralizeCount — irregular plurals', () => {
    const EXCEPTION_CASES: Array<[string, string]> = [
        ['egg', 'eggs'],
        ['tomato', 'tomatoes'],
        ['leaf', 'leaves'],
        ['loaf', 'loaves'],
    ];

    it.each(EXCEPTION_CASES)('pluralises %s as %s', (description, expected) => {
        expect(pluralizeCount(2, description)).toBe(expected);
    });

    const CASED_EXCEPTION_CASES: Array<[string, string]> = [
        ['Egg', 'Eggs'],
        ['EGG', 'EGGS'],
        ['Tomato', 'Tomatoes'],
        ['Leaf', 'Leaves'],
    ];

    it.each(CASED_EXCEPTION_CASES)('matches the exception for %s and restores its casing as %s', (description, expected) => {
        expect(pluralizeCount(2, description)).toBe(expected);
    });
});

describe('pluralizeCount — the general rules', () => {
    const SIBILANT_CASES: Array<[string, string]> = [
        ['squash', 'squashes'],
        ['box', 'boxes'],
        ['glass', 'glasses'],
        ['waltz', 'waltzes'],
        ['bunch', 'bunches'],
        ['dish', 'dishes'],
    ];

    it.each(SIBILANT_CASES)('adds es to %s, which ends in a sibilant', (description, expected) => {
        expect(pluralizeCount(2, description)).toBe(expected);
    });

    it('turns a consonant followed by y into ies', () => {
        expect(pluralizeCount(2, 'berry')).toBe('berries');
    });

    it('adds a plain s after a vowel followed by y', () => {
        expect(pluralizeCount(2, 'day')).toBe('days');
    });

    const PLAIN_CASES: Array<[string, string]> = [
        ['carrot', 'carrots'],
        ['slice', 'slices'],
        ['clove', 'cloves'],
    ];

    it.each(PLAIN_CASES)('adds a plain s to %s', (description, expected) => {
        expect(pluralizeCount(2, description)).toBe(expected);
    });
});

describe('pluralizeCount — multi-word descriptions', () => {
    it('pluralises only the last word', () => {
        expect(pluralizeCount(2, 'chicken breast')).toBe('chicken breasts');
    });

    it('leaves the leading words untouched when only the first is capitalised', () => {
        expect(pluralizeCount(2, 'Greek yogurt')).toBe('Greek yogurts');
    });

    it('restores the casing of a capitalised last word', () => {
        expect(pluralizeCount(2, 'Chicken Breast')).toBe('Chicken Breasts');
    });

    it('applies an irregular plural to the last word only', () => {
        expect(pluralizeCount(2, 'bay leaf')).toBe('bay leaves');
    });

    const UNCHANGED_DESCRIPTIONS: Array<[string, string]> = [
        ['a description with no letters', '123'],
        ['an empty description', ''],
    ];

    it.each(UNCHANGED_DESCRIPTIONS)('returns %s unchanged', (_case, description) => {
        expect(pluralizeCount(2, description)).toBe(description);
    });
});

describe('formatCount', () => {
    it('renders a count with its pluralised description', () => {
        expect(formatCount(12, 'egg')).toEqual({ value: 12, unit: 'eggs', text: '12 eggs' });
    });

    it('keeps the singular for one', () => {
        expect(formatCount(1, 'egg')).toEqual({ value: 1, unit: 'egg', text: '1 egg' });
    });

    const BARE_DESCRIPTIONS: Array<[string, string]> = [
        ['an empty description', ''],
        ['a whitespace-only description', '   '],
    ];

    it.each(BARE_DESCRIPTIONS)('renders the bare number for %s', (_case, description) => {
        expect(formatCount(3, description)).toEqual({ value: 3, unit: '', text: '3' });
    });

    it('trims the description before using it', () => {
        expect(formatCount(2, '  egg  ')).toEqual({ value: 2, unit: 'eggs', text: '2 eggs' });
    });

    it('rounds to a whole item, because half a lime is not a shopping instruction', () => {
        expect(formatCount(2.4, 'clove')).toEqual({ value: 2, unit: 'cloves', text: '2 cloves' });
        expect(formatCount(2.6, 'clove')).toEqual({ value: 3, unit: 'cloves', text: '3 cloves' });
    });

    it('never displays a positive count as zero', () => {
        expect(formatCount(0.4, 'egg')).toEqual({ value: 1, unit: 'egg', text: '1 egg' });
    });

    it('renders a true zero as zero rather than clamping it up', () => {
        expect(formatCount(0, 'egg')).toEqual({ value: 0, unit: 'eggs', text: '0 eggs' });
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s count', (_case, count) => {
        expect(() => formatCount(count, 'egg')).toThrow(UnitConversionError);
        expect(() => formatCount(count, 'egg')).toThrow('count must be a finite number');
    });
});

describe('the conversion constants', () => {
    it('pins the two promotion thresholds the display rule turns on', () => {
        expect(OUNCES_PER_POUND).toBe(16);
        expect(TABLESPOONS_PER_CUP).toBe(16);
    });

    it('keeps the avoirdupois pound at sixteen ounces', () => {
        expect(GRAMS_PER_POUND).toBeCloseTo(OUNCES_PER_POUND * GRAMS_PER_OUNCE, 5);
    });

    it('keeps a cup at sixteen tablespoons and a tablespoon at three teaspoons', () => {
        expect(MILLILITERS_PER_CUP).toBeCloseTo(TABLESPOONS_PER_CUP * MILLILITERS_PER_TABLESPOON, 5);
        expect(MILLILITERS_PER_TABLESPOON).toBeCloseTo(3 * MILLILITERS_PER_TEASPOON, 5);
    });

    it('keeps a fluid ounce at exactly two tablespoons', () => {
        expect(MILLILITERS_PER_FLUID_OUNCE).toBeCloseTo(2 * MILLILITERS_PER_TABLESPOON, 5);
    });

    it('keeps the metric prefixes at a thousand base units', () => {
        expect(GRAMS_PER_KILOGRAM).toBe(1000);
        expect(MILLILITERS_PER_LITER).toBe(1000);
    });
});

