// Unit and quantity arithmetic behind the weekly grocery list — the numeric
// and display contract of the meal planner, expressed as pure functions.
//
// Deliberately dependency-free: no imports, no I/O, no locale lookup. Every
// conversion factor is a named constant below, so the rules that are easy to
// get wrong (the 16 oz / 16 tbsp promotion thresholds, quarter rounding, the
// one-family invariant, a missing density) are pinned by unit tests instead of
// being discovered in someone's shopping list.
//
// Two of those rules are about the words rather than the numbers, and both
// exist because a portion description is data the catalog wrote, not a label
// this module chose:
//
//  * A COUNT PORTION MAY COUNT SEVERAL ITEMS, AND THE STRUCTURED AMOUNT SAYS
//    HOW MANY. `catalog_food_portions.amount` is the cardinality — "5 sprigs"
//    is one portion of five sprigs because its `amount` is 5 — and the
//    description is only the LABEL, with any amount it happens to repeat
//    stripped off it. The two disagree in the shipped catalog: 139 default
//    count portions carry an `amount` other than 1 and 138 of those state
//    something else, or nothing, in front of their noun ("cookies" at
//    `amount: 3`, "crackers (1 NLEA serving)" at `amount: 11`), so reading the
//    text would undercount them.
//  * THE ITEM IS THE HEAD NOUN. "egg, large" pluralises to "eggs, large": the
//    qualifier after the comma is not the thing being counted.
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

// A finite quantity times a finite factor is not necessarily finite: 1e308 g is
// a valid double and 1e308 kg is not. Every conversion below therefore checks
// its RESULT as well as its inputs, because a silent Infinity would travel on
// as a quantity — dividing to a plausible-looking zero in an aggregation, or
// being stored as a number no comparison behaves sensibly against. The loud
// failure is this module's existing contract: recipe seeding and catalog
// validation both surface UnitConversionError as a fault a human fixes in the
// data, which is the right outcome for a quantity this large.
const requireFiniteResult = (value: number, conversion: string): number => {
    if (!Number.isFinite(value)) {
        throw new UnitConversionError(
            `Converting ${conversion} produced ${String(value)}, which is not a finite quantity`,
        );
    }
    return value;
};

// A positive quantity must never display as zero — you buy one egg, not none.
// Only a family's base unit can round down to zero, and only a true zero
// prints as 0.
const clampPositiveToOne = (rounded: number, source: number): number =>
    rounded === 0 && source > 0 ? 1 : rounded;

// Own properties only. The table is an object literal, so a bare index lookup
// also reaches Object.prototype: "constructor" and "__proto__" normalise to
// themselves and would resolve to a truthy non-definition, making `unitFamily`
// answer `undefined` against its own return type and handing `toBaseQuantity` a
// quantity with no family and a NaN amount. Both are the unrecognised-token
// case, so both must take it.
const definitionFor = (unit: string): UnitDefinition | null => {
    const key = normaliseUnit(unit);

    return Object.prototype.hasOwnProperty.call(UNIT_DEFINITIONS, key) ? UNIT_DEFINITIONS[key] : null;
};

export const unitFamily = (unit: string): UnitFamily | null => {
    const definition = definitionFor(unit);
    return definition ? definition.family : null;
};

export const toBaseQuantity = (amount: number, unit: string): BaseQuantity => {
    assertFiniteQuantity(amount, 'quantity');

    const definition = definitionFor(unit);
    if (!definition) {
        throw new UnitConversionError(`Unrecognised unit "${unit}"`);
    }

    return {
        family: definition.family,
        amount: requireFiniteResult(amount * definition.perBase, `${String(amount)} ${unit} to base units`),
    };
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

    const density = requireDensity(densityGPerMl, 'millilitres to grams');

    return requireFiniteResult(
        milliliters * density,
        `${String(milliliters)} ml at ${String(density)} g/ml to grams`,
    );
};

export const gramsToMilliliters = (grams: number, densityGPerMl: number | null | undefined): number => {
    assertFiniteQuantity(grams, 'grams');

    const density = requireDensity(densityGPerMl, 'grams to millilitres');

    return requireFiniteResult(
        grams / density,
        `${String(grams)} g at ${String(density)} g/ml to millilitres`,
    );
};

const isPositiveFinite = (value: number): boolean => Number.isFinite(value) && value > 0;

/** The `catalog_food_portions` columns a stored portion states its volume with. */
export interface PortionVolumeMeasurement {
    /** `amount` — how many `unit` this portion is. Often not 1 ("0.5 cup"). */
    amount: number;
    unit: string;
    /** `gram_weight` — what `amount` of `unit` actually weighs. */
    gram_weight: number;
}

/**
 * The grams-per-millilitre a stored VOLUME portion states about its own food,
 * or null when the portion cannot state one.
 *
 * `amount` units of volume weighing `gram_weight` grams IS a density:
 * `gram_weight / (amount * millilitres per one unit)`. A "1 cup / 150 g" portion
 * therefore states 0.634 g/ml and a "0.5 cup / 107 g" portion 0.905 g/ml — which
 * is why `amount` is divided out rather than assumed to be 1. The conversion
 * factor comes from the same {@link UNIT_DEFINITIONS} table every other
 * conversion in this module reads, so a unit cannot state one volume here and a
 * different one three functions up.
 *
 * NULL RATHER THAN A THROW, deliberately, and it is the only density entry point
 * that answers that way. This is a QUESTION about a portion ("can this row be
 * shown as a volume?") rather than a conversion being performed, and the two
 * callers want opposite things from an unanswerable one: the grocery display
 * rules choose a different unit family and show the grams they actually measured,
 * while nutrition arithmetic must still fail loudly. So the question is answered
 * here and {@link millilitersToGrams} / {@link gramsToMilliliters} keep refusing
 * a missing density exactly as before — `catalog.logic.ts`'s `per_100ml` basis
 * and `recipes-seed.ts` depend on that refusal, and a packing density inferred
 * from a cup measure must never reach a nutrient calculation.
 *
 * Null is returned for every input that cannot yield a truthful figure: a
 * non-volume unit (grams per gram is not a density), an unrecognised token, a
 * non-positive or non-finite `amount` or `gram_weight` — validation's
 * `unsupported_portion` and `missing_gram_weight` checks quarantine those, so
 * reaching one here means the food was never publishable — and a result that
 * overflows to a non-finite number.
 *
 * @example
 * // A shipped per_100g food whose default portion is volumetric.
 * portionVolumeDensity({ amount: 1, unit: 'cup', gram_weight: 150 });   // 0.634…
 * portionVolumeDensity({ amount: 0.5, unit: 'cup', gram_weight: 107 }); // 0.904…
 * portionVolumeDensity({ amount: 1, unit: 'oz', gram_weight: 28.35 });  // null
 */
export const portionVolumeDensity = (portion: PortionVolumeMeasurement): number | null => {
    const definition = definitionFor(portion.unit);

    if (!definition || definition.family !== 'volume') {
        return null;
    }

    if (!isPositiveFinite(portion.amount) || !isPositiveFinite(portion.gram_weight)) {
        return null;
    }

    const density = portion.gram_weight / (portion.amount * definition.perBase);

    return isPositiveFinite(density) ? density : null;
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

const TIERS_BY_FAMILY: Record<'mass' | 'volume', DisplayTier[]> = { mass: MASS_TIERS, volume: VOLUME_TIERS };

// A unit outside its family's display tiers (kg, tsp, fl oz) still has to
// render somewhere, so it borrows its family's precision: tenths for a mass,
// quarters for a volume.
const PRECISION_BY_FAMILY: Record<'mass' | 'volume', Pick<DisplayTier, 'round' | 'render'>> = {
    mass: { round: roundToTenth, render: renderDecimal },
    volume: { round: roundToQuarter, render: formatQuarters },
};

/**
 * Renders a base-unit amount — grams, millilitres — in a NAMED unit.
 *
 * `formatMass` and `formatVolume` choose the unit themselves, which is right
 * for an amount being shown on its own and wrong for one that has to be read
 * beside an amount already rendered in a fixed unit: re-tiering it is how
 * "14 tbsp" comes to sit beside "2 cups". This renders at the named unit's own
 * display precision instead, and does NOT clamp a small amount up to one,
 * because "1 lb" for five grams would be a lie — an amount too small for the
 * unit returns a value of zero, and the caller decides what that means. Throws
 * for a count unit, whose amounts are items rather than base units, and for an
 * unrecognised one.
 */
export const formatInUnit = (baseAmount: number, unit: string): DisplayQuantity => {
    assertFiniteQuantity(baseAmount, 'quantity');

    const definition = definitionFor(unit);
    if (!definition) {
        throw new UnitConversionError(`Unrecognised unit "${unit}"`);
    }
    if (definition.family === 'count') {
        throw new UnitConversionError(`"${unit}" counts items, so it cannot render a base-unit amount`);
    }

    const key = normaliseUnit(unit);
    const tier =
        TIERS_BY_FAMILY[definition.family].find((candidate) => candidate.unit === key || candidate.pluralUnit === key) ??
        { unit: key, perBase: definition.perBase, ...PRECISION_BY_FAMILY[definition.family] };

    const value = tier.round(baseAmount / tier.perBase);
    const word = unitWord(tier, value);

    return { value, unit: word, text: `${tier.render(value)} ${word}` };
};

// Irregular plurals the general rule gets wrong ("tomatos", "leafs"). The list
// is closed against the catalog rather than against English: of the 262 head
// nouns the shipped count portions use, these are the ones the rules below
// inflect incorrectly, in one direction or the other. Every other -o noun in
// that set takes a plain s (avocados, burritos, tacos, matzos), which is why
// there is no -o rule.
//
// The table is read BOTH ways — `SINGULAR_EXCEPTIONS` below is its inverse — so
// one entry fixes one noun in both directions, which is why the last three sit
// here rather than in a second mechanism:
//
//  * `-o` and `-f` singulars whose plural is not a plain s: tomato, potato,
//    leaf, loaf, half. `egg` is regular and is kept because it is the count
//    row the design names ("1 egg", "12 eggs").
//  * `cookie` and `pierogi`, because the -ies plural rule has no correct
//    inverse for a singular that already ends in a vowel + e or i: "cookies"
//    read backwards through it is "cooky" and "pierogies" is "pierogy". Both
//    are real catalog head nouns, and "1 cooky" is what a shopper saw.
//  * `goldfish`, an invariant plural: the -sh rule would append -es to a word
//    that does not take it. (`crayfish`, the other -fish noun in the set, is
//    deliberately absent — "crayfishes" is a standard plural of it.)
const PLURAL_EXCEPTIONS: Record<string, string> = {
    egg: 'eggs',
    tomato: 'tomatoes',
    potato: 'potatoes',
    leaf: 'leaves',
    loaf: 'loaves',
    half: 'halves',
    cookie: 'cookies',
    pierogi: 'pierogies',
    goldfish: 'goldfish',
};

const ES_SUFFIX_PATTERN = /(?:s|x|z|ch|sh)$/;
const CONSONANT_Y_PATTERN = /[^aeiou]y$/;
// An -s that ends a SINGULAR word: "glass", "hummus", "iris". A description
// already written in the plural ("5 sprigs", "slices") must not be inflected a
// second time into "sprigses", and a trailing "s" alone cannot tell the two
// apart — these three endings are what separates them.
const SINGULAR_S_ENDING_PATTERN = /(?:ss|us|is)$/;
// The counted noun's own last word. USDA portion descriptions name the item
// first and qualify it afterwards — "egg, large", "can, drained",
// "container (6 oz)" — so inflecting the description's last word pluralises the
// qualifier ("larges", "draineds") instead of the thing being counted. The head
// segment ends at the first comma or opening parenthesis; the last run of
// letters inside it is the noun. Neither pattern carries a 'g' flag, so exec()
// keeps no lastIndex state between calls.
const HEAD_SEGMENT_PATTERN = /^[^,(]*/;
const LAST_WORD_PATTERN = /[a-z]+(?=[^a-z]*$)/i;

// A head segment with no letters of its own ("(6 oz) tub") falls back to the
// whole description, which is where the noun then has to be. The head is a
// prefix of the description either way, so `match.index` addresses both.
const headNounMatch = (description: string): RegExpExecArray | null => {
    const head = HEAD_SEGMENT_PATTERN.exec(description);
    const withinHead = head ? LAST_WORD_PATTERN.exec(head[0]) : null;

    return withinHead ?? LAST_WORD_PATTERN.exec(description);
};

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

const alreadyPlural = (word: string): boolean => {
    const lower = word.toLowerCase();

    return lower.endsWith('s') && !SINGULAR_S_ENDING_PATTERN.test(lower);
};

const invert = (table: Record<string, string>): Record<string, string> => {
    const inverted: Record<string, string> = {};

    for (const key of Object.keys(table)) {
        inverted[table[key]] = key;
    }

    return inverted;
};

// The same irregulars read the other way, built from the table above so the
// pair cannot drift apart: adding an entry fixes both directions at once.
const SINGULAR_EXCEPTIONS: Record<string, string> = invert(PLURAL_EXCEPTIONS);

const ES_PLURAL_PATTERN = /(?:s|x|z|ch|sh)es$/;
const IES_PLURAL_PATTERN = /[^aeiou]ies$/;

// The inverse of pluralizeWord, for a description the catalog already wrote in
// the plural ("5 sprigs", "slices"): one of them has to read "1 sprig".
const singularizeWord = (word: string): string => {
    const lower = word.toLowerCase();

    const exception = Object.prototype.hasOwnProperty.call(SINGULAR_EXCEPTIONS, lower)
        ? SINGULAR_EXCEPTIONS[lower]
        : null;
    if (exception) {
        return exception;
    }
    if (ES_PLURAL_PATTERN.test(lower)) {
        return lower.slice(0, -2);
    }
    if (IES_PLURAL_PATTERN.test(lower)) {
        return `${lower.slice(0, -3)}y`;
    }
    return lower.slice(0, -1);
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

/**
 * The `catalog_food_portions` columns a stored COUNT portion is counted from.
 *
 * Both columns, because they answer different questions and the catalog needs
 * both answered: `amount` is how many items one portion IS, and `description`
 * is what to call them.
 */
export interface CountPortionMeasure {
    /**
     * `amount` — countable items in ONE stored portion. 3 for a
     * `{amount: 3, description: 'cookies', gram_weight: 44}` portion, so 132 g
     * is nine cookies.
     */
    amount: number;
    /** `description` — the label, as the catalog wrote it: "1 egg, large", "5 sprigs", "cookies". */
    description: string;
}

// The amount a description may repeat in front of its noun. It is stripped
// because the structured `amount` is what multiplies out: printing the item
// count in front of the text as well reads "9 5 sprigs", and inflecting the
// text with its amount still attached reads "6 1 egg, larges". Only a positive
// finite leading number is treated as a repeated amount; "12oz" (no space) and
// "0 slices" are not, so a label that merely begins with digits keeps them.
const LEADING_AMOUNT_PATTERN = /^(\d+(?:\.\d+)?)\s+(\S.*)$/;

/**
 * The label of a count portion: its description with a repeated leading amount
 * removed.
 *
 * "1 egg, large" -> "egg, large", "5 sprigs" -> "sprigs", "cookies" ->
 * "cookies". Purely textual — it decides nothing about HOW MANY, which is
 * {@link CountPortionMeasure.amount}'s job.
 */
export const countPortionLabel = (description: string): string => {
    const label = description.trim();
    const match = LEADING_AMOUNT_PATTERN.exec(label);

    if (!match) {
        return label;
    }

    const leadingAmount = Number(match[1]);

    // A leading zero, or anything else that is not a positive finite number, is
    // not an amount this description is repeating, so the label keeps it.
    return Number.isFinite(leadingAmount) && leadingAmount > 0 ? match[2] : label;
};

/**
 * Countable items in ONE portion, taken from the structured column.
 *
 * DEFENSIVE BY DESIGN: a non-finite, zero or negative `amount` behaves as 1
 * rather than erasing or inverting the row. Validation's `unsupported_portion`
 * check should have quarantined such a food long before it reached a shopping
 * list, so the choice here is between a row that counts portions and a row that
 * silently counts nothing — and "one portion is one item" is the reading that
 * still puts a truthful line in front of the shopper.
 */
const itemsPerPortion = (amount: number): number => (Number.isFinite(amount) && amount > 0 ? amount : 1);

/** Items in `portions` of a stored count portion. */
export const countPortionItems = (portions: number, portion: CountPortionMeasure): number => {
    assertFiniteQuantity(portions, 'count');

    return requireFiniteResult(
        portions * itemsPerPortion(portion.amount),
        `${String(portions)} portions of "${portion.description.trim()}" to items`,
    );
};

/**
 * The item noun of a count portion, in the number `count` calls for.
 *
 * The portion's own repeated amount is dropped first — "6" portions of
 * "1 egg, large" is "6 eggs, large", never "6 1 egg, larges" — and a
 * description the catalog already wrote in the plural is inflected in whichever
 * direction it needs, or left alone when it is already right.
 *
 * Takes the description alone, and keeps doing so: the cardinality is the
 * caller's already-computed `count`, and `mealPlan.mapper.ts` pluralises a
 * serving description that has no stored portion behind it at all.
 */
export const pluralizeCount = (count: number, description: string): string => {
    const noun = countPortionLabel(description);
    const match = headNounMatch(noun);

    if (!match) {
        return noun;
    }

    const word = match[0];
    const wantsSingular = count === 1 || count === -1;
    const isPlural = alreadyPlural(word);

    // Nothing to do when the description is already in the number asked for.
    if (wantsSingular !== isPlural) {
        return noun;
    }

    const inflected = matchCase(word, wantsSingular ? singularizeWord(word) : pluralizeWord(word));

    return noun.slice(0, match.index) + inflected + noun.slice(match.index + word.length);
};

/**
 * A count row's rendered amount: `portions` of a stored count portion, as whole
 * items and their label.
 *
 * `portions` is the grams-over-gram-weight figure the caller divided out, so
 * the items it stands for are `portions × portion.amount` — 132 g of a
 * `{amount: 3, description: 'cookies', gram_weight: 44}` portion is three
 * portions and therefore nine cookies. Rounded to a whole item, because half a
 * lime is not a shopping instruction, and clamped away from zero so a positive
 * amount never reads as none.
 */
export const formatCount = (portions: number, portion: CountPortionMeasure): DisplayQuantity => {
    assertFiniteQuantity(portions, 'count');

    const noun = countPortionLabel(portion.description);
    const items = countPortionItems(portions, portion);
    const value = clampPositiveToOne(roundToInteger(items), items);

    // A count with no portion description renders as the bare number: "3".
    if (!noun) {
        return { value, unit: '', text: String(value) };
    }

    const unit = pluralizeCount(value, noun);
    return { value, unit, text: `${value} ${unit}` };
};
