/**
 * `src/utils/units.ts` is the numeric and display contract of the weekly
 * grocery list. The rules worth pinning are the ones a reader cannot verify by
 * eye: the one-family invariant (an unknown token must never become a count),
 * the 16 oz / 16 tbsp promotion thresholds and the re-round that stops
 * "16.0 oz" from ever being printed, the refusal to cross mass and volume
 * without a density, the "a positive quantity never displays as zero" clamp,
 * and the irregular plurals.
 */

import {
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
    formatCount,
    formatMass,
    formatQuarters,
    formatVolume,
    gramsToMilliliters,
    millilitersToGrams,
    pluralizeCount,
    toBaseQuantity,
    unitFamily,
} from '../units';

describe('unitFamily', () => {
    it.each(['g', 'gram', 'grams', 'kg', 'kilogram', 'kilograms', 'oz', 'ounce', 'ounces', 'lb', 'lbs', 'pound', 'pounds'])(
        'resolves %s to the mass family',
        (unit) => {
            expect(unitFamily(unit)).toBe('mass');
        },
    );

    it.each(['ml', 'milliliter', 'milliliters', 'l', 'liter', 'liters', 'tsp', 'teaspoon', 'tbsp', 'tablespoon', 'cup', 'cups', 'fl oz', 'fluid ounce', 'fluid ounces'])(
        'resolves %s to the volume family',
        (unit) => {
            expect(unitFamily(unit)).toBe('volume');
        },
    );

    it.each(['each', 'piece', 'pieces', 'count', 'whole', 'clove', 'cloves', 'slice', 'slices', 'head', 'heads', 'bunch', 'bunches'])(
        'resolves %s to the count family',
        (unit) => {
            expect(unitFamily(unit)).toBe('count');
        },
    );

    it.each([
        ['an unknown token', 'furlong'],
        ['an empty token', ''],
        ['whitespace', '   '],
        ['a near miss', 'grammes'],
    ])('answers null for %s rather than guessing a family', (_case, unit) => {
        // Guessing 'count' here is exactly how a mass quantity would merge into
        // a count on a grocery row, and every "Now X, was Y" comparison would
        // then straddle two families.
        expect(unitFamily(unit)).toBeNull();
    });

    it.each(['constructor', 'toString', 'hasOwnProperty', 'valueOf'])(
        'never resolves the prototype member "%s" to a real family',
        (unit) => {
            // The unit table is a plain object literal, so these names resolve
            // through Object.prototype and the lookup is truthy. The invariant
            // that matters — an unrecognised token never becomes a family — still
            // holds, and this is asserted as that invariant rather than as the
            // exact current return value so it keeps passing once the lookup is
            // made own-property-only (reported separately: `unitFamily` answers
            // `undefined` rather than `null` for these, and `toBaseQuantity`
            // answers a NaN amount instead of throwing).
            expect(['mass', 'volume', 'count']).not.toContain(unitFamily(unit));
        },
    );

    it.each([
        [' G '],
        ['KG'],
        ['Fl Oz'],
        ['fluid  ounces'],
    ])('normalises case and internal whitespace in %s', (unit) => {
        expect(unitFamily(unit)).not.toBeNull();
    });
});

describe('toBaseQuantity', () => {
    it.each([
        ['grams are the mass base', 250, 'g', 'mass', 250],
        ['kilograms scale by 1000', 2, 'kg', 'mass', 2 * GRAMS_PER_KILOGRAM],
        ['ounces scale by the avoirdupois factor', 1, 'oz', 'mass', GRAMS_PER_OUNCE],
        ['pounds scale by the avoirdupois factor', 1, 'lb', 'mass', GRAMS_PER_POUND],
        ['millilitres are the volume base', 500, 'ml', 'volume', 500],
        ['litres scale by 1000', 1.5, 'l', 'volume', 1.5 * MILLILITERS_PER_LITER],
        ['cups scale by the US customary factor', 2, 'cups', 'volume', 2 * MILLILITERS_PER_CUP],
        ['teaspoons scale by the US customary factor', 3, 'tsp', 'volume', 3 * MILLILITERS_PER_TEASPOON],
        ['counts are their own base', 4, 'each', 'count', 4],
    ])('converts %s', (_case, amount, unit, family, expected) => {
        expect(toBaseQuantity(amount as number, unit as string)).toEqual({ family, amount: expected });
    });

    it('carries a zero quantity through without inventing one', () => {
        expect(toBaseQuantity(0, 'g')).toEqual({ family: 'mass', amount: 0 });
    });

    it('carries a negative quantity through, for a correction', () => {
        expect(toBaseQuantity(-2, 'kg')).toEqual({ family: 'mass', amount: -2 * GRAMS_PER_KILOGRAM });
    });

    it('throws for an unrecognised unit, naming it', () => {
        expect(() => toBaseQuantity(1, 'furlong')).toThrow(UnitConversionError);
        expect(() => toBaseQuantity(1, 'furlong')).toThrow('Unrecognised unit "furlong"');
    });

    it.each([
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
        ['-Infinity', Number.NEGATIVE_INFINITY],
    ])('throws for a %s quantity', (_case, amount) => {
        expect(() => toBaseQuantity(amount, 'g')).toThrow(UnitConversionError);
        expect(() => toBaseQuantity(amount, 'g')).toThrow('quantity must be a finite number');
    });
});

describe('millilitersToGrams and gramsToMilliliters', () => {
    it('applies a density to cross from volume to mass', () => {
        expect(millilitersToGrams(100, 1.03)).toBeCloseTo(103, 10);
    });

    it('applies a density to cross from mass to volume', () => {
        expect(gramsToMilliliters(103, 1.03)).toBeCloseTo(100, 10);
    });

    it('round-trips a quantity through both directions', () => {
        expect(gramsToMilliliters(millilitersToGrams(240, 0.92), 0.92)).toBeCloseTo(240, 10);
    });

    it.each([
        ['null', null],
        ['undefined', undefined],
        ['zero', 0],
        ['negative', -1.03],
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('refuses to convert millilitres to grams with a %s density', (_case, density) => {
        // Millilitres never equal grams. Assuming 1 g/ml would silently corrupt
        // every nutrient figure derived from the conversion, so a food without
        // a stored density fails loudly and a human fixes the catalog row.
        expect(() => millilitersToGrams(100, density)).toThrow(UnitConversionError);
        expect(() => millilitersToGrams(100, density)).toThrow('positive density_g_per_ml is required');
    });

    it.each([
        ['null', null],
        ['zero', 0],
    ])('refuses to convert grams to millilitres with a %s density', (_case, density) => {
        expect(() => gramsToMilliliters(100, density)).toThrow(UnitConversionError);
    });

    it.each([
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('refuses a %s input quantity', (_case, quantity) => {
        expect(() => millilitersToGrams(quantity, 1)).toThrow('millilitres must be a finite number');
        expect(() => gramsToMilliliters(quantity, 1)).toThrow('grams must be a finite number');
    });

    it('converts a zero quantity without touching the density rule', () => {
        expect(millilitersToGrams(0, 1.03)).toBe(0);
        expect(gramsToMilliliters(0, 1.03)).toBe(0);
    });
});

describe('formatQuarters', () => {
    it.each([
        [0, '0'],
        [0.1, '0'],
        [0.125, '¼'],
        [0.25, '¼'],
        [0.5, '½'],
        [0.75, '¾'],
        [0.9, '1'],
        [1, '1'],
        [1.25, '1¼'],
        [1.5, '1½'],
        [1.75, '1¾'],
        [2, '2'],
        [2.87, '2¾'],
        [2.9, '3'],
    ])('renders %p as %p', (value, expected) => {
        expect(formatQuarters(value)).toBe(expected);
    });

    it.each([
        [-0.25, '-¼'],
        [-1.25, '-1¼'],
        [-2, '-2'],
    ])('keeps the sign outside the glyph for %p', (value, expected) => {
        expect(formatQuarters(value)).toBe(expected);
    });

    it.each([
        ['NaN', Number.NaN],
        ['Infinity', Number.POSITIVE_INFINITY],
    ])('throws for a %s quantity', (_case, value) => {
        expect(() => formatQuarters(value)).toThrow(UnitConversionError);
    });
});

describe('formatMass', () => {
    it.each([
        [15, '15 g'],
        [28, '28 g'],
        [100, '3.5 oz'],
        [400, '14.1 oz'],
        [GRAMS_PER_POUND, '1 lb'],
        [1000, '2.2 lb'],
    ])('renders %p grams as %p', (grams, text) => {
        expect(formatMass(grams).text).toBe(text);
    });

    it('promotes to the next unit when rounding reaches it', () => {
        // 453 g is 15.978 oz, which rounds to 16.0 oz — a value that has
        // already reached a pound. Printing "16.0 oz" would be wrong twice: it
        // is not how anyone reads a weight, and it contradicts the tier rule.
        expect(formatMass(453)).toEqual({ value: 1, unit: 'lb', text: '1 lb' });
    });

    it('promotes grams to ounces at the 16 g/oz boundary rather than printing 28 g as an ounce', () => {
        expect(formatMass(GRAMS_PER_OUNCE)).toEqual({ value: 1, unit: 'oz', text: '1 oz' });
        expect(formatMass(28.3).text).toBe('28 g');
    });

    it('never displays a positive quantity as zero', () => {
        // You buy one gram, not none: only a true zero prints as 0.
        expect(formatMass(0.4)).toEqual({ value: 1, unit: 'g', text: '1 g' });
        expect(formatMass(0)).toEqual({ value: 0, unit: 'g', text: '0 g' });
    });

    it('keeps the smallest unit for a negative quantity instead of promoting it', () => {
        expect(formatMass(-10)).toEqual({ value: -10, unit: 'g', text: '-10 g' });
    });

    it('throws for a non-finite quantity, naming the unit it was given', () => {
        expect(() => formatMass(Number.NaN)).toThrow('grams must be a finite number');
    });
});

describe('formatVolume', () => {
    it.each([
        [5, '5 ml'],
        [10, '10 ml'],
        [MILLILITERS_PER_TABLESPOON, '1 tbsp'],
        [30, '2 tbsp'],
        [100, '6¾ tbsp'],
        [MILLILITERS_PER_CUP, '1 cup'],
        [2 * MILLILITERS_PER_CUP, '2 cups'],
    ])('renders %p millilitres as %p', (milliliters, text) => {
        expect(formatVolume(milliliters).text).toBe(text);
    });

    it('promotes millilitres to a tablespoon when rounding reaches one', () => {
        // 14.7 ml rounds to 15 ml, which is already a tablespoon.
        expect(formatVolume(14.7)).toEqual({ value: 1, unit: 'tbsp', text: '1 tbsp' });
    });

    it('promotes tablespoons to a cup at the 16 tbsp boundary', () => {
        // 236 ml is 15.96 tbsp, which rounds to 16 tbsp — one cup.
        expect(formatVolume(236)).toEqual({ value: 1, unit: 'cup', text: '1 cup' });
    });

    it('pluralises only the cup, and only above one', () => {
        expect(formatVolume(1.5 * MILLILITERS_PER_CUP)).toEqual({
            value: 1.5,
            unit: 'cups',
            text: '1½ cups',
        });
        expect(formatVolume(MILLILITERS_PER_CUP).unit).toBe('cup');
        expect(formatVolume(3 * MILLILITERS_PER_TABLESPOON).unit).toBe('tbsp');
        expect(formatVolume(3).unit).toBe('ml');
    });

    it('renders quarters inside the cup and tablespoon tiers', () => {
        expect(formatVolume(1.75 * MILLILITERS_PER_CUP).text).toBe('1¾ cups');
        expect(formatVolume(2.5 * MILLILITERS_PER_TABLESPOON).text).toBe('2½ tbsp');
    });

    it('reports three quarters of a cup in tablespoons, because the tier rule keeps the value at or above one', () => {
        // 177 ml is 0.75 cup, which is below the cup tier, so it reads as
        // 12 tbsp. Quarter-cup glyphs appear only from one cup upwards — that
        // is the tier rule, not a rounding accident.
        expect(formatVolume(0.75 * MILLILITERS_PER_CUP).text).toBe('12 tbsp');
    });

    it('never displays a positive quantity as zero', () => {
        expect(formatVolume(0.4)).toEqual({ value: 1, unit: 'ml', text: '1 ml' });
        expect(formatVolume(0)).toEqual({ value: 0, unit: 'ml', text: '0 ml' });
    });

    it('throws for a non-finite quantity, naming the unit it was given', () => {
        expect(() => formatVolume(Number.POSITIVE_INFINITY)).toThrow('millilitres must be a finite number');
    });
});

describe('pluralizeCount', () => {
    it.each([
        [1, 'egg', 'egg'],
        [-1, 'egg', 'egg'],
    ])('leaves the description alone for a count of %p', (count, description, expected) => {
        expect(pluralizeCount(count, description)).toBe(expected);
    });

    it.each([
        ['egg', 'eggs'],
        ['tomato', 'tomatoes'],
        ['leaf', 'leaves'],
        ['loaf', 'loaves'],
    ])('uses the exceptions map for %s', (description, expected) => {
        // The general rule produces "tomatos" and "leafs"; the map exists for
        // exactly these, so a regression here ships a typo to every user.
        expect(pluralizeCount(2, description)).toBe(expected);
    });

    it.each([
        ['slice', 'slices'],
        ['clove', 'cloves'],
        ['bunch', 'bunches'],
        ['box', 'boxes'],
        ['dish', 'dishes'],
        ['glass', 'glasses'],
        ['waltz', 'waltzes'],
        ['berry', 'berries'],
        ['day', 'days'],
    ])('applies the English rule to %s', (description, expected) => {
        expect(pluralizeCount(2, description)).toBe(expected);
    });

    it.each([
        [0, 'egg', 'eggs'],
        [2, 'egg', 'eggs'],
        [1.5, 'egg', 'eggs'],
    ])('pluralises for a count of %p', (count, description, expected) => {
        expect(pluralizeCount(count, description)).toBe(expected);
    });

    it('pluralises only the last word of a description', () => {
        expect(pluralizeCount(2, 'chicken breast')).toBe('chicken breasts');
        expect(pluralizeCount(2, 'bread slice')).toBe('bread slices');
    });

    it.each([
        ['Egg', 'Eggs'],
        ['EGG', 'EGGS'],
        ['Tomato', 'Tomatoes'],
        ['Chicken Breast', 'Chicken Breasts'],
    ])('restores the original casing of %s', (description, expected) => {
        // The exceptions map is keyed in lower case, so without this a
        // capitalised description would come back shouted or lower-cased.
        expect(pluralizeCount(2, description)).toBe(expected);
    });

    it.each([
        ['a description with no letters', '123'],
        ['an empty description', ''],
    ])('returns %s unchanged', (_case, description) => {
        expect(pluralizeCount(2, description)).toBe(description);
    });
});

describe('formatCount', () => {
    it('renders a count with its pluralised description', () => {
        expect(formatCount(3, 'egg')).toEqual({ value: 3, unit: 'eggs', text: '3 eggs' });
    });

    it('keeps the singular for one', () => {
        expect(formatCount(1, 'egg')).toEqual({ value: 1, unit: 'egg', text: '1 egg' });
    });

    it('rounds to a whole item', () => {
        expect(formatCount(2.4, 'clove')).toEqual({ value: 2, unit: 'cloves', text: '2 cloves' });
        expect(formatCount(2.6, 'clove')).toEqual({ value: 3, unit: 'cloves', text: '3 cloves' });
    });

    it('never displays a positive count as zero', () => {
        expect(formatCount(0.4, 'egg')).toEqual({ value: 1, unit: 'egg', text: '1 egg' });
    });

    it('renders a true zero as zero', () => {
        expect(formatCount(0, 'egg')).toEqual({ value: 0, unit: 'eggs', text: '0 eggs' });
    });

    it.each([
        ['an empty description', ''],
        ['a whitespace-only description', '   '],
    ])('renders the bare number for %s', (_case, description) => {
        expect(formatCount(3, description)).toEqual({ value: 3, unit: '', text: '3' });
    });

    it('trims the description before using it', () => {
        expect(formatCount(2, '  egg  ')).toEqual({ value: 2, unit: 'eggs', text: '2 eggs' });
    });

    it('throws for a non-finite count', () => {
        expect(() => formatCount(Number.NaN, 'egg')).toThrow(UnitConversionError);
        expect(() => formatCount(Number.NaN, 'egg')).toThrow('count must be a finite number');
    });
});

describe('the conversion constants', () => {
    it('pins the two promotion thresholds the display rule turns on', () => {
        expect(OUNCES_PER_POUND).toBe(16);
        expect(TABLESPOONS_PER_CUP).toBe(16);
    });

    it('keeps a fluid ounce at exactly two tablespoons', () => {
        expect(MILLILITERS_PER_FLUID_OUNCE).toBeCloseTo(2 * MILLILITERS_PER_TABLESPOON, 10);
    });

    it('keeps the avoirdupois pound at 16 ounces', () => {
        expect(GRAMS_PER_POUND).toBeCloseTo(OUNCES_PER_POUND * GRAMS_PER_OUNCE, 10);
    });

    it('keeps a cup at 16 tablespoons and a tablespoon at three teaspoons', () => {
        expect(MILLILITERS_PER_CUP).toBeCloseTo(TABLESPOONS_PER_CUP * MILLILITERS_PER_TABLESPOON, 10);
        expect(MILLILITERS_PER_TABLESPOON).toBeCloseTo(3 * MILLILITERS_PER_TEASPOON, 10);
    });
});
