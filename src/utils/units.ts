// Unit and quantity arithmetic behind the weekly grocery list — the numeric
// and display contract of the meal planner, expressed as pure functions.
//
// Deliberately dependency-free: no imports, no I/O, no locale lookup. Every
// conversion factor is a named constant below, so the rules that are easy to
// get wrong (the 16 oz / 16 tbsp promotion thresholds, quarter rounding, the
// one-family invariant, a missing density) are pinned by unit tests instead of
// being discovered in someone's shopping list.
//
// Not this module's job: aggregating planned portions, the equality epsilon,
// aisle categories, the "Now X, was Y" sub-line, delta pills and the
// food-state name suffix all belong to grocery.logic.ts, which composes the
// values produced here.

// Mass — international avoirdupois.
export const GRAMS_PER_OUNCE = 28.349523125;
export const OUNCES_PER_POUND = 16;
export const GRAMS_PER_POUND = 453.59237;
export const GRAMS_PER_KILOGRAM = 1000;

// Volume — US customary, the units USDA foodPortions and the grocery rows use.
export const MILLILITERS_PER_TEASPOON = 4.92892159375;
export const MILLILITERS_PER_TABLESPOON = 14.78676478125;
export const TABLESPOONS_PER_CUP = 16;
export const MILLILITERS_PER_CUP = 236.5882365;
// One US fluid ounce is exactly two tablespoons.
export const MILLILITERS_PER_FLUID_OUNCE = 29.5735295625;
export const MILLILITERS_PER_LITER = 1000;

// Display precision rather than conversion: tenths for pounds and ounces,
// quarters for cups and tablespoons.
const TENTHS_PER_UNIT = 10;
const QUARTERS_PER_UNIT = 4;

// A family's base unit measures itself.
const IDENTITY_FACTOR = 1;

export class UnitConversionError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'UnitConversionError';
    }
}

export type UnitFamily = 'mass' | 'volume' | 'count';

export interface BaseQuantity {
    family: UnitFamily;
    /** Grams for mass, millilitres for volume, the raw number for count. */
    amount: number;
}

export interface DisplayQuantity {
    /** The rounded number, in `unit`, that `text` renders. */
    value: number;
    unit: string;
    text: string;
}

interface UnitDefinition {
    family: UnitFamily;
    /** Base units — grams, millilitres, items — in one of this unit. */
    perBase: number;
}

// Every recognised token belongs to exactly ONE family, and an unknown token
// resolves to null rather than a guess. A grocery row's family is chosen once
// at plan generation and read from the row's stored display_unit afterwards, so
// a later update may move oz -> lb but never mass -> count, and every
// "Now X, was Y" comparison stays inside one family. Guessing 'count' for an
// unrecognised token is exactly how a mass quantity would merge into a count.
const UNIT_DEFINITIONS: Record<string, UnitDefinition> = {
    g: { family: 'mass', perBase: IDENTITY_FACTOR },
    gram: { family: 'mass', perBase: IDENTITY_FACTOR },
    grams: { family: 'mass', perBase: IDENTITY_FACTOR },
    kg: { family: 'mass', perBase: GRAMS_PER_KILOGRAM },
    kilogram: { family: 'mass', perBase: GRAMS_PER_KILOGRAM },
    kilograms: { family: 'mass', perBase: GRAMS_PER_KILOGRAM },
    oz: { family: 'mass', perBase: GRAMS_PER_OUNCE },
    ounce: { family: 'mass', perBase: GRAMS_PER_OUNCE },
    ounces: { family: 'mass', perBase: GRAMS_PER_OUNCE },
    lb: { family: 'mass', perBase: GRAMS_PER_POUND },
    lbs: { family: 'mass', perBase: GRAMS_PER_POUND },
    pound: { family: 'mass', perBase: GRAMS_PER_POUND },
    pounds: { family: 'mass', perBase: GRAMS_PER_POUND },

    ml: { family: 'volume', perBase: IDENTITY_FACTOR },
    milliliter: { family: 'volume', perBase: IDENTITY_FACTOR },
    milliliters: { family: 'volume', perBase: IDENTITY_FACTOR },
    l: { family: 'volume', perBase: MILLILITERS_PER_LITER },
    liter: { family: 'volume', perBase: MILLILITERS_PER_LITER },
    liters: { family: 'volume', perBase: MILLILITERS_PER_LITER },
    tsp: { family: 'volume', perBase: MILLILITERS_PER_TEASPOON },
    teaspoon: { family: 'volume', perBase: MILLILITERS_PER_TEASPOON },
    teaspoons: { family: 'volume', perBase: MILLILITERS_PER_TEASPOON },
    tbsp: { family: 'volume', perBase: MILLILITERS_PER_TABLESPOON },
    tablespoon: { family: 'volume', perBase: MILLILITERS_PER_TABLESPOON },
    tablespoons: { family: 'volume', perBase: MILLILITERS_PER_TABLESPOON },
    cup: { family: 'volume', perBase: MILLILITERS_PER_CUP },
    cups: { family: 'volume', perBase: MILLILITERS_PER_CUP },
    'fl oz': { family: 'volume', perBase: MILLILITERS_PER_FLUID_OUNCE },
    'fluid ounce': { family: 'volume', perBase: MILLILITERS_PER_FLUID_OUNCE },
    'fluid ounces': { family: 'volume', perBase: MILLILITERS_PER_FLUID_OUNCE },

    each: { family: 'count', perBase: IDENTITY_FACTOR },
    piece: { family: 'count', perBase: IDENTITY_FACTOR },
    pieces: { family: 'count', perBase: IDENTITY_FACTOR },
    count: { family: 'count', perBase: IDENTITY_FACTOR },
    whole: { family: 'count', perBase: IDENTITY_FACTOR },
    clove: { family: 'count', perBase: IDENTITY_FACTOR },
    cloves: { family: 'count', perBase: IDENTITY_FACTOR },
    slice: { family: 'count', perBase: IDENTITY_FACTOR },
    slices: { family: 'count', perBase: IDENTITY_FACTOR },
    head: { family: 'count', perBase: IDENTITY_FACTOR },
    heads: { family: 'count', perBase: IDENTITY_FACTOR },
    bunch: { family: 'count', perBase: IDENTITY_FACTOR },
    bunches: { family: 'count', perBase: IDENTITY_FACTOR },
};

const normaliseUnit = (unit: string): string => unit.trim().toLowerCase().replace(/\s+/g, ' ');

const assertFiniteQuantity = (value: number, label: string): void => {
    if (!Number.isFinite(value)) {
        throw new UnitConversionError(`${label} must be a finite number, received ${String(value)}`);
    }
};

// A positive quantity must never display as zero — you buy one egg, not none.
// Only a family's base unit can round down to zero, and only a true zero
// prints as 0.
const clampPositiveToOne = (rounded: number, source: number): number =>
    rounded === 0 && source > 0 ? 1 : rounded;

export const unitFamily = (unit: string): UnitFamily | null => {
    const definition = UNIT_DEFINITIONS[normaliseUnit(unit)];
    return definition ? definition.family : null;
};

export const toBaseQuantity = (amount: number, unit: string): BaseQuantity => {
    assertFiniteQuantity(amount, 'quantity');

    const definition = UNIT_DEFINITIONS[normaliseUnit(unit)];
    if (!definition) {
        throw new UnitConversionError(`Unrecognised unit "${unit}"`);
    }

    return { family: definition.family, amount: amount * definition.perBase };
};

// Millilitres never equal grams. A food without a stored density cannot cross
// families, so the conversion fails loudly (surfacing as a seed failure a human
// fixes in the recipe or catalog data) rather than assuming 1 g/ml.
const requireDensity = (densityGPerMl: number | null | undefined, conversion: string): number => {
    if (densityGPerMl == null || !Number.isFinite(densityGPerMl) || densityGPerMl <= 0) {
        throw new UnitConversionError(
            `A positive density_g_per_ml is required to convert ${conversion}, received ${String(densityGPerMl)}`,
        );
    }
    return densityGPerMl;
};

export const millilitersToGrams = (milliliters: number, densityGPerMl: number | null | undefined): number => {
    assertFiniteQuantity(milliliters, 'millilitres');
    return milliliters * requireDensity(densityGPerMl, 'millilitres to grams');
};

export const gramsToMilliliters = (grams: number, densityGPerMl: number | null | undefined): number => {
    assertFiniteQuantity(grams, 'grams');
    return grams / requireDensity(densityGPerMl, 'grams to millilitres');
};

const roundToInteger = (value: number): number => Math.round(value);

const roundToTenth = (value: number): number => Math.round(value * TENTHS_PER_UNIT) / TENTHS_PER_UNIT;

const roundToQuarter = (value: number): number => Math.round(value * QUARTERS_PER_UNIT) / QUARTERS_PER_UNIT;

// String() prints the shortest round-trip form, so a trailing ".0" is already
// dropped: 4 renders as "4" and 2.5 as "2.5". Rounding to tenths or quarters
// can never produce more digits than that.
const renderDecimal = (value: number): string => String(value);

const QUARTER_GLYPHS = ['', '¼', '½', '¾'];

export const formatQuarters = (value: number): string => {
    assertFiniteQuantity(value, 'quantity');

    const quarters = roundToQuarter(value);
    const sign = quarters < 0 ? '-' : '';
    const magnitude = Math.abs(quarters);
    const whole = Math.floor(magnitude);
    const glyph = QUARTER_GLYPHS[Math.round((magnitude - whole) * QUARTERS_PER_UNIT)];

    if (!glyph) {
        return `${sign}${whole}`;
    }
    // Whole and fraction sit adjacent, with no space: "1¼".
    return whole === 0 ? `${sign}${glyph}` : `${sign}${whole}${glyph}`;
};

interface DisplayTier {
    unit: string;
    /** Plural form, set only where the design pluralises the word (cup/cups). */
    pluralUnit?: string;
    /** Base units in one of this unit. */
    perBase: number;
    /**
     * How many of this unit make one of the next-larger tier. Absent on the
     * largest tier, which is why a promotion can always step to `index - 1`.
     */
    promoteAt?: number;
    round: (value: number) => number;
    render: (value: number) => string;
}

// Largest unit first: the display rule picks the largest unit that keeps the
// value >= 1, so 453.6 g reads "1 lb" and 400 g reads "14.1 oz".
const MASS_TIERS: DisplayTier[] = [
    { unit: 'lb', perBase: GRAMS_PER_POUND, round: roundToTenth, render: renderDecimal },
    {
        unit: 'oz',
        perBase: GRAMS_PER_OUNCE,
        promoteAt: OUNCES_PER_POUND,
        round: roundToTenth,
        render: renderDecimal,
    },
    { unit: 'g', perBase: IDENTITY_FACTOR, promoteAt: GRAMS_PER_OUNCE, round: roundToInteger, render: renderDecimal },
];

const VOLUME_TIERS: DisplayTier[] = [
    { unit: 'cup', pluralUnit: 'cups', perBase: MILLILITERS_PER_CUP, round: roundToQuarter, render: formatQuarters },
    {
        unit: 'tbsp',
        perBase: MILLILITERS_PER_TABLESPOON,
        promoteAt: TABLESPOONS_PER_CUP,
        round: roundToQuarter,
        render: formatQuarters,
    },
    {
        unit: 'ml',
        perBase: IDENTITY_FACTOR,
        promoteAt: MILLILITERS_PER_TABLESPOON,
        round: roundToInteger,
        render: renderDecimal,
    },
];

// Only the cup carries a plural in the design; g, ml, oz, lb and tbsp are
// invariant abbreviations.
const unitWord = (tier: DisplayTier, value: number): string =>
    tier.pluralUnit && value > 1 ? tier.pluralUnit : tier.unit;

const formatTiered = (base: number, tiers: DisplayTier[], label: string): DisplayQuantity => {
    assertFiniteQuantity(base, label);

    let index = tiers.findIndex((tier) => base >= tier.perBase);
    if (index === -1) {
        index = tiers.length - 1;
    }

    let tier = tiers[index];
    let value = clampPositiveToOne(tier.round(base / tier.perBase), base);

    // Selecting the unit and rounding to its precision interact: 15.96 oz
    // rounds to 16.0 oz and 15.9 tbsp rounds to 16 tbsp, yet both have reached
    // the next unit. Promote once and re-round, so "16.0 oz" and "16 tbsp" are
    // impossible outputs. One promotion always suffices — the promoted value is
    // at most 1 of the larger unit.
    if (tier.promoteAt !== undefined && value >= tier.promoteAt) {
        index -= 1;
        tier = tiers[index];
        value = tier.round(base / tier.perBase);
    }

    const unit = unitWord(tier, value);
    return { value, unit, text: `${tier.render(value)} ${unit}` };
};

export const formatMass = (grams: number): DisplayQuantity => formatTiered(grams, MASS_TIERS, 'grams');

export const formatVolume = (milliliters: number): DisplayQuantity =>
    formatTiered(milliliters, VOLUME_TIERS, 'millilitres');

// Irregular plurals the general rule gets wrong ("tomatos", "leafs").
const PLURAL_EXCEPTIONS: Record<string, string> = {
    egg: 'eggs',
    tomato: 'tomatoes',
    leaf: 'leaves',
    loaf: 'loaves',
};

const ES_SUFFIX_PATTERN = /(?:s|x|z|ch|sh)$/;
const CONSONANT_Y_PATTERN = /[^aeiou]y$/;
// The last run of letters in a description: "chicken breast" pluralises its
// last word, and any trailing punctuation or spacing is left untouched. No 'g'
// flag, so exec() carries no lastIndex state between calls.
const LAST_WORD_PATTERN = /[a-z]+(?=[^a-z]*$)/i;

const pluralizeWord = (word: string): string => {
    const lower = word.toLowerCase();

    const exception = PLURAL_EXCEPTIONS[lower];
    if (exception) {
        return exception;
    }
    if (ES_SUFFIX_PATTERN.test(lower)) {
        return `${lower}es`;
    }
    if (CONSONANT_Y_PATTERN.test(lower)) {
        return `${lower.slice(0, -1)}ies`;
    }
    return `${lower}s`;
};

// The exceptions map is keyed in lower case, so the description's own casing is
// restored afterwards: "Egg" stays capitalised, "EGG" stays shouted.
const matchCase = (original: string, replacement: string): string => {
    if (original === original.toUpperCase() && original !== original.toLowerCase()) {
        return replacement.toUpperCase();
    }
    if (original[0] === original[0].toUpperCase()) {
        return replacement[0].toUpperCase() + replacement.slice(1);
    }
    return replacement;
};

export const pluralizeCount = (count: number, description: string): string => {
    if (count === 1 || count === -1) {
        return description;
    }

    const match = LAST_WORD_PATTERN.exec(description);
    if (!match) {
        return description;
    }

    const word = match[0];
    const plural = matchCase(word, pluralizeWord(word));
    return description.slice(0, match.index) + plural + description.slice(match.index + word.length);
};

export const formatCount = (count: number, description: string): DisplayQuantity => {
    assertFiniteQuantity(count, 'count');

    const value = clampPositiveToOne(roundToInteger(count), count);
    const label = description.trim();

    // A count with no portion description renders as the bare number: "3".
    if (!label) {
        return { value, unit: '', text: String(value) };
    }

    const unit = pluralizeCount(value, label);
    return { value, unit, text: `${value} ${unit}` };
};
