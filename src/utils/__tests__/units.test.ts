/**
 * `src/utils/units.ts` is the numeric and display contract of the weekly
 * grocery list. This suite pins the decisions a reader cannot verify by eye:
 * that every recognised token belongs to exactly one family and an
 * unrecognised token to none, the definitional conversion factors, the
 * 16 oz / 16 tbsp promotion thresholds together with the re-round that makes
 * "16.0 oz" unprintable, the refusal to cross mass and volume without a stored
 * density, the clamp that stops a positive quantity reading as zero, the
 * irregular plurals, and the two rules that read a catalog portion description
 * rather than printing it: the amount a multi-item portion states in front of
 * its noun, and the head noun a qualifier must not be mistaken for.
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
    portionVolumeDensity,
    formatMass,
    formatVolume,
    formatQuarters,
    formatInUnit,
    pluralizeCount,
    CountPortionMeasure,
    countPortionLabel,
    countPortionItems,
    formatCount,
} from '../units';

/**
 * A stored count portion, as `catalog_food_portions` holds it: `amount` is the
 * cardinality and `description` the label. Both are stated at every call site
 * below, because the two disagreeing is the defect these cases exist for —
 * 138 of the shipped catalog's 139 non-unit count amounts say something other
 * than their `amount`, or nothing at all, in front of their noun.
 */
const countPortion = (description: string, amount = 1): CountPortionMeasure => ({ amount, description });

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

    // A finite quantity times a finite factor is not necessarily finite: 1e308 g
    // is a valid double and 1e308 kg is not. Returning Infinity would send a
    // quantity onward to be aggregated, compared or stored as a number nothing
    // downstream behaves sensibly against.
    it('throws when a finite quantity converts out of range', () => {
        expect(() => toBaseQuantity(1e308, 'kg')).toThrow(UnitConversionError);
        expect(() => toBaseQuantity(1e308, 'kg')).toThrow('is not a finite quantity');
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

    // The volume and the density are each finite and each usable; their product
    // is not. Catalog validation distinguishes this from a missing density by
    // the density it handed in, so the two faults must stay distinguishable
    // here too — same error type, different message.
    it('throws when a finite volume and density multiply out of range', () => {
        expect(() => millilitersToGrams(1e308, 10)).toThrow(UnitConversionError);
        expect(() => millilitersToGrams(1e308, 10)).toThrow('is not a finite quantity');
        expect(() => millilitersToGrams(1e308, 10)).not.toThrow('density_g_per_ml is required');
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

    // A denormal density is positive and finite, and dividing by it overflows.
    it('throws when a finite mass divides out of range', () => {
        expect(() => gramsToMilliliters(1e308, 5e-324)).toThrow(UnitConversionError);
        expect(() => gramsToMilliliters(1e308, 5e-324)).toThrow('is not a finite quantity');
    });

    it('reports the failure as a UnitConversionError by name', () => {
        expect(thrownBy(() => gramsToMilliliters(100, null)).name).toBe('UnitConversionError');
    });
});

/**
 * `portionVolumeDensity` — the density a stored volume portion states about its
 * own food.
 *
 * THE SHAPE IT EXISTS FOR is the one the shipped catalog release actually
 * carries, as its own manifest and rows state it: 11,046 published foods, every
 * one `nutrition_basis: per_100g` with `density_g_per_ml` NULL, and 4,622 of
 * them holding a VOLUME-family default portion. Each such portion states
 * `amount` units of volume weighing `gram_weight` grams, which is a density — so
 * the figure the display path needs is already in the data and is read from it
 * here instead of being demanded of a column that is null.
 *
 * `amount` IS DIVIDED OUT rather than assumed to be 1, because the release
 * disagrees with that assumption: its volume-family default portions are stated
 * at amounts other than 1 — halves, doubles, quarters and eighths among them —
 * and `data/meal-planning/catalog/releases/v1/portions.jsonl` is the authority
 * on which and how many, not a count transcribed here. Assuming 1 would double
 * a half-cup food's density and halve a two-cup food's.
 *
 * Every unanswerable input is null rather than a throw, and the last case here
 * pins the counterpart: the two conversion entry points still refuse a missing
 * density loudly, because `catalog.logic.ts`'s `per_100ml` nutrition basis and
 * `recipes-seed.ts` are built on that refusal.
 */
describe('portionVolumeDensity', () => {
    describe('a volume portion states its own density', () => {
        // `usda:167561`: default portion "1 cup", 150 g, density NULL — a real
        // shipped row, and the arithmetic is stated through the module's own cup
        // factor so the test cannot disagree with it about how many millilitres
        // a cup is.
        it('divides the gram weight by the millilitres the portion measures', () => {
            expect(portionVolumeDensity({ amount: 1, unit: 'cup', gram_weight: 150 })).toBeCloseTo(
                150 / MILLILITERS_PER_CUP,
                10,
            );
        });

        // `usda:167573`: default portion "0.5 cup", 107 g. Read as one cup it
        // would state 0.452 g/ml — half the truth — so the divisor is the whole
        // measured volume and not the unit's own factor.
        it('divides by the AMOUNT as well as the unit, for a portion that is not one of it', () => {
            expect(portionVolumeDensity({ amount: 0.5, unit: 'cup', gram_weight: 107 })).toBeCloseTo(
                107 / (0.5 * MILLILITERS_PER_CUP),
                10,
            );
        });

        it('scales linearly with the amount, so 8 of a unit is an eighth of the density', () => {
            const one = portionVolumeDensity({ amount: 1, unit: 'cup', gram_weight: 240 });
            const eight = portionVolumeDensity({ amount: 8, unit: 'cup', gram_weight: 240 });

            expect(one).not.toBeNull();
            expect(eight).toBeCloseTo((one as number) / 8, 10);
        });

        // Water-like by construction: a millilitre portion weighing its own
        // number of grams is 1 g/ml whichever volume token states it, which is
        // what makes every recognised volume unit comparable here.
        it.each(VOLUME_UNITS)('answers for %s, using that unit\u2019s own factor', (unit) => {
            const milliliters = toBaseQuantity(1, unit).amount;

            expect(portionVolumeDensity({ amount: 1, unit, gram_weight: milliliters })).toBeCloseTo(1, 10);
        });

        it('normalises the unit token the way every other conversion does', () => {
            expect(portionVolumeDensity({ amount: 1, unit: ' CUPS ', gram_weight: 150 })).toBeCloseTo(
                150 / MILLILITERS_PER_CUP,
                10,
            );
        });

        // A tablespoon of olive oil: the AAP's own example food, at the density
        // the release's portion implies rather than a curated one.
        it('answers for the tablespoon portion the grocery list renders oil in', () => {
            expect(portionVolumeDensity({ amount: 1, unit: 'tbsp', gram_weight: 13.5 })).toBeCloseTo(
                13.5 / MILLILITERS_PER_TABLESPOON,
                10,
            );
        });
    });

    describe('a portion that states no volume states no density', () => {
        it.each(MASS_UNITS)('answers null for the mass unit %s, because grams per gram is not a density', (unit) => {
            expect(portionVolumeDensity({ amount: 1, unit, gram_weight: 100 })).toBeNull();
        });

        it.each(COUNT_UNITS)('answers null for the count unit %s', (unit) => {
            expect(portionVolumeDensity({ amount: 1, unit, gram_weight: 50 })).toBeNull();
        });

        it.each(['bottle', 'sachet', 'can', '', '   ', 'floz', 'constructor', '__proto__'])(
            'answers null for the unrecognised token %p rather than guessing a volume',
            (unit) => {
                expect(portionVolumeDensity({ amount: 1, unit, gram_weight: 100 })).toBeNull();
            },
        );
    });

    describe('an unusable measurement states no density', () => {
        const UNUSABLE_NUMBERS: Array<[string, number]> = [
            ['zero', 0],
            ['negative', -1],
            ['NaN', Number.NaN],
            ['Infinity', Number.POSITIVE_INFINITY],
            ['-Infinity', Number.NEGATIVE_INFINITY],
        ];

        // Validation's `unsupported_portion` check rejects a non-positive amount
        // and `missing_gram_weight` an absent weight, so neither shape can reach
        // this function from a published food — which is exactly why it answers
        // instead of throwing: the display path has a truthful mass row to fall
        // back to either way.
        it.each(UNUSABLE_NUMBERS)('answers null for a %s amount', (_case, amount) => {
            expect(portionVolumeDensity({ amount, unit: 'cup', gram_weight: 150 })).toBeNull();
        });

        it.each(UNUSABLE_NUMBERS)('answers null for a %s gram weight', (_case, gram_weight) => {
            expect(portionVolumeDensity({ amount: 1, unit: 'cup', gram_weight })).toBeNull();
        });

        // Both inputs are finite and positive; the quotient is not. A silent
        // Infinity would travel on as the divisor of every rendered amount.
        it('answers null when the quotient is not finite', () => {
            expect(portionVolumeDensity({ amount: 5e-324, unit: 'ml', gram_weight: 1e308 })).toBeNull();
        });

        // The mirror case: a colossal volume under a tiny weight divides to 0,
        // and a zero density is no more usable than a null one.
        it('answers null when the quotient rounds away to zero', () => {
            expect(portionVolumeDensity({ amount: 1e308, unit: 'l', gram_weight: 5e-324 })).toBeNull();
        });
    });

    // The whole point of answering null: the CONVERSIONS still refuse. A future
    // change that made `requireDensity` tolerate a missing density would let a
    // `per_100ml` food's nutrition be computed at 1 g/ml, which is the fault
    // this module's loud failure exists to prevent.
    it('does not soften the conversions, which still refuse a density they were not given', () => {
        expect(portionVolumeDensity({ amount: 1, unit: 'cup', gram_weight: 150 })).not.toBeNull();

        expect(() => gramsToMilliliters(100, null)).toThrow(
            'A positive density_g_per_ml is required to convert grams to millilitres',
        );
        expect(() => millilitersToGrams(100, null)).toThrow(
            'A positive density_g_per_ml is required to convert millilitres to grams',
        );
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
    /**
     * EVERY entry of the exceptions table, in BOTH directions, because the
     * table is inverted to read the other way and an entry dropped from it
     * fails silently in whichever direction nothing asserts. The general rules
     * would give "tomatos", "leafs", "halfs", "cooky", "pierogy" and
     * "goldfishes".
     */
    const EXCEPTION_CASES: Array<[string, string]> = [
        ['egg', 'eggs'],
        ['tomato', 'tomatoes'],
        ['potato', 'potatoes'],
        ['leaf', 'leaves'],
        ['loaf', 'loaves'],
        ['half', 'halves'],
        ['cookie', 'cookies'],
        ['pierogi', 'pierogies'],
        // An invariant plural: the -sh rule would append -es to it.
        ['goldfish', 'goldfish'],
    ];

    it.each(EXCEPTION_CASES)('pluralises %s as %s', (description, expected) => {
        expect(pluralizeCount(2, description)).toBe(expected);
    });

    it.each(EXCEPTION_CASES)('reads one %s back out of %s', (expected, plural) => {
        expect(pluralizeCount(1, plural)).toBe(expected);
    });

    /*
     * The three the -ies and -sh rules get wrong, named as the strings a
     * shopper would otherwise have read. "1 cooky" is what the shipped code
     * printed for a `{amount: 3, description: 'cookies'}` portion.
     */
    const WRONG_UNDER_THE_GENERAL_RULES: Array<[number, string, string]> = [
        [1, 'cookies', 'cooky'],
        [1, 'pierogies', 'pierogy'],
        [4, 'goldfish', 'goldfishes'],
    ];

    it.each(WRONG_UNDER_THE_GENERAL_RULES)('never renders %p of "%s" as "%s"', (count, description, wrong) => {
        expect(pluralizeCount(count, description)).not.toBe(wrong);
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
        expect(formatCount(12, countPortion('egg'))).toEqual({ value: 12, unit: 'eggs', text: '12 eggs' });
    });

    it('keeps the singular for one', () => {
        expect(formatCount(1, countPortion('egg'))).toEqual({ value: 1, unit: 'egg', text: '1 egg' });
    });

    const BARE_DESCRIPTIONS: Array<[string, string]> = [
        ['an empty description', ''],
        ['a whitespace-only description', '   '],
    ];

    it.each(BARE_DESCRIPTIONS)('renders the bare number for %s', (_case, description) => {
        expect(formatCount(3, countPortion(description))).toEqual({ value: 3, unit: '', text: '3' });
    });

    it('trims the description before using it', () => {
        expect(formatCount(2, countPortion('  egg  '))).toEqual({ value: 2, unit: 'eggs', text: '2 eggs' });
    });

    it('rounds to a whole item, because half a lime is not a shopping instruction', () => {
        expect(formatCount(2.4, countPortion('clove'))).toEqual({ value: 2, unit: 'cloves', text: '2 cloves' });
        expect(formatCount(2.6, countPortion('clove'))).toEqual({ value: 3, unit: 'cloves', text: '3 cloves' });
    });

    it('never displays a positive count as zero', () => {
        expect(formatCount(0.4, countPortion('egg'))).toEqual({ value: 1, unit: 'egg', text: '1 egg' });
    });

    it('renders a true zero as zero rather than clamping it up', () => {
        expect(formatCount(0, countPortion('egg'))).toEqual({ value: 0, unit: 'eggs', text: '0 eggs' });
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s count', (_case, count) => {
        expect(() => formatCount(count, countPortion('egg'))).toThrow(UnitConversionError);
        expect(() => formatCount(count, countPortion('egg'))).toThrow('count must be a finite number');
    });
});

/*
 * The shipped catalog's count portions, as `catalog_food_portions` stores them:
 * the item is named first and qualified afterwards ("egg, large", "can,
 * drained"), the description sometimes repeats the amount in front of the noun
 * ("5 sprigs") and sometimes says nothing about it at all ("cookies" at
 * `amount: 3`). The LABEL comes from the text and the CARDINALITY from the
 * column, which is what keeps a grocery row from reading "9 5 sprigs" or
 * "6 1 egg, larges" on one side and from undercounting a multi-item portion on
 * the other.
 */
describe('countPortionLabel', () => {
    it('drops an amount the description repeats', () => {
        expect(countPortionLabel('5 sprigs')).toBe('sprigs');
    });

    it('keeps a description that states no amount', () => {
        expect(countPortionLabel('container (6 oz)')).toBe('container (6 oz)');
    });

    it('keeps the qualifier with the noun', () => {
        expect(countPortionLabel('1 egg, large')).toBe('egg, large');
    });

    it('trims the description', () => {
        expect(countPortionLabel('  1 avocado  ')).toBe('avocado');
    });

    it('drops a fractional leading amount too', () => {
        expect(countPortionLabel('0.5 fillet')).toBe('fillet');
    });

    it('keeps a bare plural label, which is the shape that carries its amount in the column', () => {
        // `{amount: 3, description: 'cookies', gram_weight: 44}`, as the
        // release ships it: nothing to strip, and the 3 is not in the text.
        expect(countPortionLabel('cookies')).toBe('cookies');
        expect(countPortionLabel('crackers (1 NLEA serving)')).toBe('crackers (1 NLEA serving)');
    });

    const NOT_AN_AMOUNT: Array<[string, string]> = [
        ['a leading zero, which states no amount', '0 slices'],
        ['a number with no noun after it', '12'],
        ['a number joined to its noun', '12oz'],
        ['an empty description', ''],
    ];

    it.each(NOT_AN_AMOUNT)('keeps %s whole', (_case, description) => {
        expect(countPortionLabel(description)).toBe(description.trim());
    });
});

describe('countPortionItems', () => {
    it('multiplies portions by the stored amount', () => {
        // USDA's dill weed portion: `{amount: 5, description: '5 sprigs'}` at
        // 1 g, so nine grams is nine portions and forty-five sprigs.
        expect(countPortionItems(9, countPortion('5 sprigs', 5))).toBe(45);
    });

    it('counts portions directly when one portion is one item', () => {
        expect(countPortionItems(6, countPortion('1 egg, large'))).toBe(6);
    });

    /*
     * THE COLUMN DECIDES, NOT THE TEXT. Both shapes below are real release
     * portions whose description disagrees with their `amount` — 138 of the 139
     * non-unit count amounts do — and reading the text would undercount them
     * threefold and elevenfold respectively.
     */
    const RELEASE_SHAPES: Array<[string, number, string, number, number]> = [
        ['cookies at amount 3', 3, 'cookies', 3, 9],
        ['crackers (1 NLEA serving) at amount 11', 11, 'crackers (1 NLEA serving)', 2, 22],
    ];

    it.each(RELEASE_SHAPES)('counts %s from the column', (_case, amount, description, portions, expected) => {
        expect(countPortionItems(portions, countPortion(description, amount))).toBe(expected);
    });

    it('does not count a repeated amount twice', () => {
        // "5 sprigs" states its five in both places. The column is read and the
        // text is only stripped, so nine grams is 45 sprigs and never 225.
        expect(countPortionItems(9, countPortion('5 sprigs', 5))).toBe(45);
        expect(countPortionItems(9, countPortion('5 sprigs', 5))).not.toBe(225);
    });

    /*
     * The defensive reading of an unusable `amount`: one portion counts one
     * item. Validation quarantines such a portion long before a shopping list
     * sees it, so the choice is between counting portions and counting nothing,
     * and a zero or negative multiplier would erase or invert the row.
     */
    const UNUSABLE_AMOUNTS: Array<[string, number]> = [
        ['zero', 0],
        ['negative', -3],
        ['infinite', Number.POSITIVE_INFINITY],
        ['NaN', Number.NaN],
    ];

    it.each(UNUSABLE_AMOUNTS)('treats a %s amount as one item per portion', (_case, amount) => {
        expect(countPortionItems(4, countPortion('cookies', amount))).toBe(4);
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s number of portions', (_case, portions) => {
        expect(() => countPortionItems(portions, countPortion('5 sprigs', 5))).toThrow(UnitConversionError);
        expect(() => countPortionItems(portions, countPortion('5 sprigs', 5))).toThrow(
            'count must be a finite number',
        );
    });

    it('throws rather than returning an infinite item count', () => {
        expect(() => countPortionItems(Number.MAX_VALUE, countPortion('5 sprigs', 5))).toThrow(UnitConversionError);
    });
});

describe('pluralizeCount — real catalog portion descriptions', () => {
    const SHIPPED_CASES: Array<[string, string]> = [
        ['1 egg, large', 'eggs, large'],
        ['1 can, drained', 'cans, drained'],
        ['1 tomato, medium', 'tomatoes, medium'],
        ['1 carrot, medium', 'carrots, medium'],
        ['1 stalk, medium', 'stalks, medium'],
        ['1 olive, large', 'olives, large'],
        ['1 potato, medium', 'potatoes, medium'],
        ['1 avocado', 'avocados'],
        ['1 clove', 'cloves'],
        ['1 slice', 'slices'],
        ['1 lemon', 'lemons'],
        ['1 pepper', 'peppers'],
    ];

    it.each(SHIPPED_CASES)('renders "%s" as "%s"', (description, expected) => {
        expect(pluralizeCount(4, description)).toBe(expected);
    });

    it.each(SHIPPED_CASES)('drops the stated amount from "%s" for a single item too', (description) => {
        expect(pluralizeCount(1, description)).toBe(description.replace(/^1 /, ''));
    });

    it('inflects the noun rather than the qualifier after a parenthesis', () => {
        expect(pluralizeCount(4, 'container (6 oz)')).toBe('containers (6 oz)');
    });

    const ALREADY_PLURAL: string[] = ['5 sprigs', 'sprigs', 'slices', 'cloves', 'eggs'];

    it.each(ALREADY_PLURAL)('leaves "%s" alone, because it is already plural', (description) => {
        expect(pluralizeCount(4, description)).toBe(description.replace(/^5 /, ''));
    });

    /*
     * The irregulars are chosen against the catalog, not against English: of
     * the 262 head nouns the shipped count portions use, only these inflect
     * wrongly under the general rules. The -o nouns beside them — avocado,
     * burrito, taco, matzo — all take a plain s, so no -o rule exists.
     */
    const CATALOG_IRREGULARS: Array<[string, string]> = [
        ['1 potato, medium', 'potatoes, medium'],
        ['baby potato', 'baby potatoes'],
        ['half', 'halves'],
        ['1 tomato, medium', 'tomatoes, medium'],
    ];

    it.each(CATALOG_IRREGULARS)('pluralises "%s" as "%s"', (description, expected) => {
        expect(pluralizeCount(2, description)).toBe(expected);
    });

    const CATALOG_REGULAR_O_NOUNS: Array<[string, string]> = [
        ['1 avocado', 'avocados'],
        ['burrito', 'burritos'],
        ['taco', 'tacos'],
        ['matzo', 'matzos'],
    ];

    it.each(CATALOG_REGULAR_O_NOUNS)('pluralises "%s" as "%s", with a plain s', (description, expected) => {
        expect(pluralizeCount(2, description)).toBe(expected);
    });

    const SINGULAR_TO_PLURAL_AND_BACK: Array<[string, string]> = [
        ['sprigs', 'sprig'],
        ['slices', 'slice'],
        ['eggs', 'egg'],
        ['berries', 'berry'],
        ['glasses', 'glass'],
        ['bunches', 'bunch'],
        ['leaves', 'leaf'],
        ['potatoes', 'potato'],
        ['halves', 'half'],
    ];

    it.each(SINGULAR_TO_PLURAL_AND_BACK)('reads one of "%s" as "%s"', (description, expected) => {
        expect(pluralizeCount(1, description)).toBe(expected);
    });

    // An -ss, -us or -is ending belongs to a singular word, so it is inflected
    // rather than mistaken for a plural and left as it is.
    const SINGULAR_S_ENDINGS: Array<[string, string]> = [
        ['glass', 'glasses'],
        ['hummus', 'hummuses'],
    ];

    it.each(SINGULAR_S_ENDINGS)('treats "%s" as singular and pluralises it to "%s"', (description, expected) => {
        expect(pluralizeCount(2, description)).toBe(expected);
    });
});

describe('formatCount — a portion that counts several items', () => {
    it('renders the items, not the portions', () => {
        // USDA states dill weed as `{amount: 5, description: '5 sprigs'}` at
        // 1 g, so nine grams is 45 sprigs — a fivefold undercount if the
        // portion were the item.
        expect(formatCount(9, countPortion('5 sprigs', 5))).toEqual({ value: 45, unit: 'sprigs', text: '45 sprigs' });
    });

    it('renders a single item of a plural description in the singular', () => {
        expect(formatCount(0.2, countPortion('5 sprigs', 5))).toEqual({ value: 1, unit: 'sprig', text: '1 sprig' });
    });

    it('counts portions when one portion is one item', () => {
        expect(formatCount(6, countPortion('1 egg, large'))).toEqual({
            value: 6,
            unit: 'eggs, large',
            text: '6 eggs, large',
        });
    });

    it('never repeats the portion amount in the text', () => {
        expect(formatCount(6, countPortion('1 egg, large')).text).not.toContain('1 egg');
        expect(formatCount(9, countPortion('5 sprigs', 5)).text).not.toContain('5 sprigs,');
    });

    it('keeps the singular for exactly one of a one-item portion', () => {
        expect(formatCount(1, countPortion('1 avocado'))).toEqual({ value: 1, unit: 'avocado', text: '1 avocado' });
    });

    /*
     * The two release shapes whose description says nothing about their
     * cardinality, rendered as a shopper reads them. The 132 g / 31 g totals
     * are three and two stored portions respectively, and the old
     * description-derived rule printed "3 cookies" and "2 crackers" for them.
     */
    it('renders the nine cookies three stored portions come to', () => {
        // `{amount: 3, description: 'cookies', gram_weight: 44}`: 132 g is
        // three portions of three cookies.
        expect(formatCount(132 / 44, countPortion('cookies', 3))).toEqual({
            value: 9,
            unit: 'cookies',
            text: '9 cookies',
        });
    });

    it('renders eleven crackers for one stored portion of them', () => {
        expect(formatCount(31 / 31, countPortion('crackers (1 NLEA serving)', 11))).toEqual({
            value: 11,
            unit: 'crackers (1 NLEA serving)',
            text: '11 crackers (1 NLEA serving)',
        });
    });

    it('says "1 cookie" rather than "1 cooky" for a third of a portion', () => {
        // The inflection half of the same defect: one item of a `cookies`
        // portion has to singularise, and the -ies rule read backwards gave
        // "cooky".
        expect(formatCount(1 / 3, countPortion('cookies', 3))).toEqual({
            value: 1,
            unit: 'cookie',
            text: '1 cookie',
        });
    });

    it('keeps an invariant plural invariant', () => {
        expect(formatCount(2, countPortion('goldfish', 12)).text).toBe('24 goldfish');
    });

    it('never counts nothing for a positive quantity, whatever the stored amount says', () => {
        expect(formatCount(0.1, countPortion('cookies', 0)).text).toBe('1 cookie');
    });
});

describe('formatInUnit', () => {
    it('renders a mass in the unit it is asked for', () => {
        expect(formatInUnit(1133.98, 'lb')).toEqual({ value: 2.5, unit: 'lb', text: '2.5 lb' });
        expect(formatInUnit(400, 'oz')).toEqual({ value: 14.1, unit: 'oz', text: '14.1 oz' });
    });

    it('keeps an amount below one in the unit asked for instead of promoting it', () => {
        // 207 ml is fourteen tablespoons, which is what formatVolume picks; the
        // same amount read in the cups a grocery row already displays is ¾.
        expect(formatVolume(207).text).toBe('14 tbsp');
        expect(formatInUnit(207, 'cups')).toEqual({ value: 0.75, unit: 'cup', text: '¾ cup' });
    });

    it('renders zero for an amount too small for the unit, rather than clamping it up', () => {
        expect(formatInUnit(5, 'lb')).toEqual({ value: 0, unit: 'lb', text: '0 lb' });
    });

    it('pluralises the one unit that carries a plural', () => {
        expect(formatInUnit(MILLILITERS_PER_CUP * 2, 'cup').text).toBe('2 cups');
        expect(formatInUnit(MILLILITERS_PER_CUP, 'cups').text).toBe('1 cup');
    });

    it('borrows the family precision for a unit outside the display tiers', () => {
        expect(formatInUnit(1500, 'kg')).toEqual({ value: 1.5, unit: 'kg', text: '1.5 kg' });
        expect(formatInUnit(MILLILITERS_PER_TEASPOON * 2, 'tsp')).toEqual({ value: 2, unit: 'tsp', text: '2 tsp' });
    });

    it('refuses a count unit, whose amounts are items rather than base units', () => {
        expect(() => formatInUnit(12, 'each')).toThrow(UnitConversionError);
        expect(() => formatInUnit(12, 'each')).toThrow('counts items');
    });

    it('refuses an unrecognised unit', () => {
        expect(() => formatInUnit(12, 'bottle')).toThrow(UnitConversionError);
        expect(() => formatInUnit(12, 'bottle')).toThrow('Unrecognised unit');
    });

    it.each(NON_FINITE_QUANTITIES)('throws for a %s amount', (_case, amount) => {
        expect(() => formatInUnit(amount, 'g')).toThrow(UnitConversionError);
        expect(() => formatInUnit(amount, 'g')).toThrow('quantity must be a finite number');
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

