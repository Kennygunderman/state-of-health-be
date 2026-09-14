// Every number and every state transition on the weekly grocery list.
//
// The list is MEASURED. Planned portions are aggregated as real grams and shown
// through the stored portion conversions of `utils/units.ts`; a container unit
// like the mockup's "1 bottle" is sample data and is never generated here.
//
// Everything below is deterministic and synchronous — no Prisma, no fetch, no
// `process.env`, no clock. `grocery.service.ts` owns the awaits and the
// transaction, `grocery.mapper.ts` owns row -> DTO, and both delegate their
// DECISIONS here, which is why each rule is a function over its data and why
// every rule is reachable from a unit test with no database (Rule 7 §5, §7,
// §11). Anything that needs "now" takes it as an argument.
//
// Four rules in this file exist for one reason — the flags have to be
// TRUSTWORTHY — and every one of them is easy to "simplify" away:
//
//  * THE EPSILON. Two quantities are equal within {@link GROCERY_EPSILON_G}.
//    Sub-epsilon drift from an unrelated swap is neither an increase nor a
//    decrease, so floating-point noise can never flag a checked item.
//
//  * THE ACKNOWLEDGED BASELINE. `previous_quantity_grams` is the amount the
//    user last ACKNOWLEDGED — what they saw when they checked the row, or when
//    they last cleared its flag — and not the amount before the most recent
//    change. Three successive swaps that each nudge chicken breast upward still
//    read "was 2.5 lb", because a baseline that moved with each diff would
//    quietly lie about what the shopper actually bought.
//
//  * THE SAME-DISPLAY EXCEPTION. An increase that does not move the rendered
//    text (2.51 -> 2.53 lb) updates the grams and raises no flag. A flag the
//    user cannot see on the row is noise — and that holds however far the
//    amount has drifted from the acknowledged one, so an invisible increase
//    onto a row a decrease has already unflagged raises nothing either.
//
//  * THE UNIT-FAMILY LOCK. A row's unit family is chosen once, at plan
//    generation, from the food's default portion, and every later update reads
//    it back from that row's own stored `display_unit`. An update may move
//    oz -> lb but never mass -> count, so "Now X, was Y" is always a comparison
//    inside one family. Re-deriving the family per update is what would
//    eventually break it.
//
// A decrease is deliberately SILENT: the number changes, the check stays, and
// nothing is flagged, sub-lined or announced — a flag the row was already
// carrying is cleared rather than left standing over an amount that has come
// back down. Nothing disappears from the shopper's list and nothing shouts at
// them about less shopping.
//
// Division of responsibility, stated once because both boundaries are easy to
// drift across:
//
//  * `utils/units.ts` owns unit families, gram conversions, numeric formatting
//    and pluralisation. It is never re-implemented here — including the rule
//    that millilitres without a density cannot become grams, which is why that
//    failure surfaces as its own `UnitConversionError` from that module rather
//    than being pre-empted by a copy of the check, and including the arithmetic
//    that reads a density off a stored volume portion (`portionVolumeDensity`).
//    What THIS file decides is which of a food's two possible densities a row
//    is rendered through (`volumeDensityFor`) and, when it can state neither,
//    that the row is weighed rather than measured (`displayFamilyForPortion`).
//  * `catalog.logic.ts` owns the catalog category -> aisle mapping and the
//    aisle sort order. A second copy is how a newly added catalog category
//    lands in the right aisle in one place and the wrong one in the other.
//  * THIS file owns the aggregation, the epsilon, the `food_state` name suffix,
//    and all delta and flag text.
//
// Not this module's job: reading or writing anything, snake_case <-> camelCase
// mapping (`grocery.mapper.ts`), swap candidate selection (`swap.logic.ts`),
// display prose for the aisle codes (the client's `strings.ts`), HTTP status
// codes (the controller), and the no-plan-versus-empty-list distinction, which
// is a client decision: an empty list is returned as an empty list and no
// "the list was emptied" signal is invented.

import {
    GROCERY_CATEGORY_ORDER,
    GroceryCategory,
    groceryCategorySortIndex,
    isGroceryCategory,
    mapCategoryToGroceryCategory,
} from './catalog.logic';
import { PlanNotActiveError, PlanNotFoundError } from './mealPlanning.errors';
import { isCalendarDayKey } from './preferences.logic';
import {
    GroceryBanner,
    GroceryChangeSummary,
    GroceryItemFlag,
    InvalidRequestDetail,
    PlanEndedErrorData,
    ToggleGroceryItemPayload,
} from '../types/mealPlanning';
import { MealSlot } from '../types/recipe';
import {
    UnitConversionError,
    UnitFamily,
    formatCount,
    formatInUnit,
    formatMass,
    formatQuarters,
    formatVolume,
    gramsToMilliliters,
    pluralizeCount,
    portionVolumeDensity,
    toBaseQuantity,
    unitFamily,
} from '../utils/units';

/* ---------------------------------------------------------------------------
 * Constants and the local failure class
 * ------------------------------------------------------------------------- */

/**
 * The equality tolerance, in grams. Two quantities are EQUAL when they differ
 * by less than this.
 *
 * Exported so the tests assert against the same number the rules use. Half a
 * gram is below the resolution of anything a shopper buys, which is the point:
 * re-running the aggregation after a swap of an unrelated meal can shift a
 * total by a floating-point hair, and flagging a checked item over that would
 * teach the user to ignore flags.
 */
export const GROCERY_EPSILON_G = 0.5;

/** `quantity_grams` is `NUMERIC(10,2)`, so a stored value carries two decimals. */
const STORED_GRAM_DECIMALS = 2;

const STORED_GRAM_SCALE = 10 ** STORED_GRAM_DECIMALS;

/** Tenths for pounds and ounces — the display precision of the mass family. */
const TENTHS_SCALE = 10;

/**
 * Quarters for cups and tablespoons — the display precision of the volume
 * family, and the step `formatQuarters` renders at.
 *
 * The delta pill is this module's text, so it needs the delta as a ROUNDED
 * NUMBER and not only as a glyph: whether a delta has vanished at its own
 * precision, and whether "cup" or "cups" describes it, are both decisions about
 * the rounded value. `utils/units.ts` still owns the rendering — the number
 * goes back through `formatQuarters` to become "1¾".
 */
const QUARTERS_SCALE = 4;

/**
 * The `display_unit` stored for a count row.
 *
 * It is NOT the word the row renders. `formatCount` returns the pluralised
 * portion description as its unit ("eggs"), and `unitFamily('eggs')` is null —
 * so storing that would make the row's family unreadable and break the
 * unit-family lock on the next update. The rendered "12 eggs" lives in
 * `display_text`; `display_unit` stays a token `utils/units.ts` resolves.
 */
export const COUNT_DISPLAY_UNIT = 'count';

/** The one `food_state` that never earns a name suffix on its own. */
const RAW_FOOD_STATE = 'raw';

/** Separates the two halves of an aggregation key; neither half can contain it. */
const IDENTITY_KEY_SEPARATOR = '\u0000';

// The day-key shape is NOT declared here: `preferences.logic.ts` owns it and
// the calendar rule that applies it.

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Data that cannot produce a truthful shopping line: a planned meal with a
 * non-positive yield, an aggregated food with no catalog facts, a count row
 * whose default portion has no gram weight, a stored `display_unit` that no
 * longer resolves to a family, or a malformed day key.
 *
 * A local class, following `catalog.logic.ts`'s `CatalogIdentityError`: these
 * are seed or programming faults rather than anything a client did, so they
 * belong to the module that detects them and not to the meal-planning error
 * vocabulary the controllers map (`mealPlanning.errors.ts` states that
 * boundary). The density rule is deliberately NOT one of these — it is
 * `utils/units.ts`'s rule and raises that module's `UnitConversionError`.
 */
export class GroceryDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GroceryDataError';
    }
}

/**
 * True when a failure came from BUILDING A SHOPPING LINE — this module's
 * {@link GroceryDataError} or `utils/units.ts`'s `UnitConversionError`.
 *
 * Its purpose is the boundary above: a plan publication and a swap commit each
 * do their grocery work inside a transaction whose failure the client must be
 * told about in the vocabulary of `mealPlanning.errors.ts` — §0.5.2's `502
 * plan_generation_failed` and `502 swap_failed` — and neither of these two
 * classes is in that vocabulary, so without this predicate they escape as a
 * generic 500 the client cannot classify. The callers translate exactly what
 * this recognises and RE-THROW everything else untouched, which is what keeps
 * `grocery.service.ts`'s deliberate untyped invariant failures ("deleted N rows
 * instead of M") reaching the controller as the 500 they are documented to be.
 *
 * IT LIVES HERE, NOT IN THE ERROR MODULE, on that module's own stated ground:
 * its header records that vendor and utility failures — `UnitConversionError`
 * among them — belong to the modules that raise them and are deliberately not
 * re-exported there, because a barrel would rebuild the coupling the boundary
 * exists to prevent (§9). This file already owns one of the two classes and
 * already imports the other, so recognising the pair costs no new edge.
 *
 * Pure and total: a thrown string, a rejected null, anything at all — it
 * answers false rather than assuming a shape.
 */
export const isGroceryRenderingFault = (error: unknown): boolean =>
    error instanceof GroceryDataError || error instanceof UnitConversionError;

/**
 * The wire vocabulary for a grocery `details[].code`. Machine-readable only —
 * the client maps each code to its own copy:
 *  - `invalid_id` — a path id that is not a v4 UUID.
 *  - `required` — `isChecked` is absent or null.
 *  - `invalid_type` — `isChecked` is present but not a boolean.
 */
export const GROCERY_FIELD_CODES = {
    INVALID_ID: 'invalid_id',
    REQUIRED: 'required',
    INVALID_TYPE: 'invalid_type',
} as const;

const PLAN_ID_FIELD = 'planId';
const ITEM_ID_FIELD = 'itemId';
const IS_CHECKED_FIELD = 'isChecked';

const requirePositiveFinite = (value: number, label: string): number => {
    if (!Number.isFinite(value) || value <= 0) {
        throw new GroceryDataError(`${label} must be a positive finite number, received ${String(value)}`);
    }
    return value;
};

/** Rounds to the two decimals the `quantity_grams` column stores. */
const toStoredGrams = (grams: number): number => Math.round(grams * STORED_GRAM_SCALE) / STORED_GRAM_SCALE;

const roundToTenth = (value: number): number => Math.round(value * TENTHS_SCALE) / TENTHS_SCALE;

const roundToQuarter = (value: number): number => Math.round(value * QUARTERS_SCALE) / QUARTERS_SCALE;

/* ---------------------------------------------------------------------------
 * Aggregation — grams, and only grams
 *
 * Row shapes are declared STRUCTURALLY in the stored snake_case so a Prisma row
 * satisfies them without this module importing Prisma, which is the one
 * internal shape this file uses throughout (Rule 7 §10, and the convention
 * `targets.logic.ts` sets). `Decimal` columns arrive as numbers: the service
 * converts, because a decimal library type in a pure rule would be a dependency
 * the rule does not need.
 * ------------------------------------------------------------------------- */

/** One ingredient of a planned meal, as `recipe_ingredients` stores it. */
export interface PlannedMealIngredient {
    catalog_food_id: string;
    /**
     * The ingredient food's own state. It travels with the ingredient because
     * it is half of the aggregation identity, and raw, dry and cooked amounts
     * of one food must never merge into a single shopping line.
     */
    food_state: string;
    /** Grams for the WHOLE recipe yield, which is what the column holds. */
    gram_weight: number;
}

/** One planned meal, as `meal_plan_meals` joined to its recipe version gives it. */
export interface PlannedMealForGroceries {
    /** `recipe_versions.yield_servings` — how many servings `gram_weight` covers. */
    yield_servings: number;
    /** `meal_plan_meals.portion_multiplier`. */
    portion_multiplier: number;
    ingredients: readonly PlannedMealIngredient[];
}

/** Grams for one `(catalog_food_id, food_state)` identity, at full precision. */
export interface AggregatedGroceryQuantity {
    catalog_food_id: string;
    food_state: string;
    quantity_grams: number;
}

/**
 * The grams one planned portion of one ingredient contributes:
 * `gram_weight / yield_servings * portion_multiplier`.
 *
 * Kept at full float precision — the sum is rounded once, when it becomes a
 * stored row, so rounding each contribution first cannot drift the total.
 */
export const plannedIngredientGrams = (
    gramWeight: number,
    yieldServings: number,
    portionMultiplier: number,
): number => {
    requirePositiveFinite(gramWeight, 'gram_weight');
    requirePositiveFinite(yieldServings, 'yield_servings');
    requirePositiveFinite(portionMultiplier, 'portion_multiplier');

    return (gramWeight / yieldServings) * portionMultiplier;
};

const identityKey = (catalogFoodId: string, foodState: string): string =>
    `${catalogFoodId}${IDENTITY_KEY_SEPARATOR}${foodState}`;

/**
 * Sums every planned portion of the week into one quantity per
 * `(catalog_food_id, food_state)` — the identity of
 * `grocery_items.@@unique([meal_plan_id, catalog_food_id, food_state])` and the
 * key every later diff is matched on.
 *
 * Ordered by that identity rather than by encounter order, so the same plan
 * aggregates identically whichever order the meals were read in.
 */
export const aggregatePlannedGrams = (
    meals: readonly PlannedMealForGroceries[],
): AggregatedGroceryQuantity[] => {
    const totals = new Map<string, AggregatedGroceryQuantity>();

    for (const meal of meals) {
        for (const ingredient of meal.ingredients) {
            const grams = plannedIngredientGrams(
                ingredient.gram_weight,
                meal.yield_servings,
                meal.portion_multiplier,
            );
            const key = identityKey(ingredient.catalog_food_id, ingredient.food_state);
            const running = totals.get(key);

            if (running) {
                running.quantity_grams += grams;
            } else {
                totals.set(key, {
                    catalog_food_id: ingredient.catalog_food_id,
                    food_state: ingredient.food_state,
                    quantity_grams: grams,
                });
            }
        }
    }

    // Map keys are unique, so two identities can never compare equal and the
    // comparator needs no third answer.
    return [...totals.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([, total]) => total);
};

/* ---------------------------------------------------------------------------
 * Equality — the epsilon
 * ------------------------------------------------------------------------- */

/** How a recomputed quantity compares with the one already on the list. */
export type GroceryQuantityChange = 'unchanged' | 'increased' | 'decreased';

/** True when the two quantities differ by less than {@link GROCERY_EPSILON_G}. */
export const quantitiesAreEqual = (a: number, b: number): boolean => Math.abs(a - b) < GROCERY_EPSILON_G;

/**
 * Classifies a change with the epsilon applied FIRST, so a sub-epsilon
 * difference is `unchanged` and never a one-gram "increase" that flags a
 * checked row.
 */
export const classifyQuantityChange = (previous: number, next: number): GroceryQuantityChange => {
    if (quantitiesAreEqual(previous, next)) {
        return 'unchanged';
    }

    return next > previous ? 'increased' : 'decreased';
};

/* ---------------------------------------------------------------------------
 * Display — the unit family is locked at generation
 * ------------------------------------------------------------------------- */

/**
 * The food's default portion, as `catalog_food_portions` stores it.
 *
 * `amount` travels with the unit because the two only mean something together:
 * "0.5 cup / 107 g" states a different density from "1 cup / 107 g", and
 * {@link volumeDensityFor} divides it out. A projection that dropped it would
 * read every portion as one of its unit and misstate every volume row whose
 * portion is not.
 */
export interface GroceryDefaultPortion {
    description: string;
    /** How many `unit` the portion is. Often not 1 across the catalog. */
    amount: number;
    unit: string;
    gram_weight: number;
}

/** The `catalog_foods` facts a shopping line needs, as stored. */
export interface GroceryFoodFacts {
    catalog_food_id: string;
    food_state: string;
    /** `catalog_foods.display_name` — the base name, before any state suffix. */
    name: string;
    /** One of the 21 coverage-plan categories, mapped to an aisle below. */
    category: string;
    density_g_per_ml: number | null;
    /**
     * The `is_default` portion. Null is possible only for a food validation
     * should have quarantined, so it is tolerated for mass rows (grams need no
     * portion) and rejected for count rows, which cannot be counted without it.
     */
    default_portion: GroceryDefaultPortion | null;
}

/** The subset of {@link GroceryFoodFacts} a gram -> display conversion needs. */
export type GroceryConversionFacts = Pick<GroceryFoodFacts, 'density_g_per_ml' | 'default_portion'>;

/** One row's rendered amount: the three `display_*` columns plus its family. */
export interface GroceryDisplay {
    family: UnitFamily;
    /** `display_quantity` — the rounded number `text` renders. */
    quantity: number;
    /** `display_unit`. Always a token `unitFamily()` resolves, so the family is readable back off the row. */
    unit: string;
    /** `display_text` — the amount as the shopper reads it. */
    text: string;
}

/**
 * The grams-per-millilitre a volume row is rendered through, or null when this
 * food cannot state one.
 *
 * TWO SOURCES, IN THIS ORDER, and the order is the rule:
 *
 *  1. The food's own stored `density_g_per_ml`. A `per_100ml` food carries a
 *     curated figure, and that figure is the authority on what its millilitres
 *     weigh — a number a human or a source stated about the substance, which
 *     `catalog.logic.ts` also computes its nutrition through.
 *  2. Failing that, the density the DEFAULT PORTION itself states:
 *     `gram_weight` grams per `amount` of a volume unit is a density, computed
 *     by `utils/units.ts`'s `portionVolumeDensity`. §0.1.4 names the stored
 *     portion as the sanctioned conversion source — "display in the
 *     contributors' shared unit family through stored portion conversions (e.g.
 *     'Olive oil · 6 tbsp')" — and it is what the shipped release actually
 *     holds: every published food is `per_100g` with a null density, and 4,622
 *     of them measure their default portion in cups, tablespoons or teaspoons.
 *
 * So a row shows the volume the catalog measured it in, and the derived figure
 * is only ever reached for a food whose curated one is absent. Null means this
 * food cannot be shown as a volume at all — the caller chooses a family it can
 * be shown in ({@link displayFamilyForPortion}) rather than rendering
 * millilitres nothing measured.
 *
 * THE DERIVED FIGURE NEVER LEAVES THE DISPLAY PATH. It is a packing density
 * ("what a cup of this weighs"), not a substance density, so it is fit for
 * deciding that 202 g of cooked rice reads "1 cup" and unfit for converting a
 * nutrient basis — which is why `utils/units.ts` still refuses a missing density
 * in `millilitersToGrams`/`gramsToMilliliters` and nothing here weakens that.
 */
export const volumeDensityFor = (facts: GroceryConversionFacts): number | null => {
    if (facts.density_g_per_ml !== null && Number.isFinite(facts.density_g_per_ml) && facts.density_g_per_ml > 0) {
        return facts.density_g_per_ml;
    }

    return facts.default_portion ? portionVolumeDensity(facts.default_portion) : null;
};

/**
 * The unit family a new row is created in, chosen from the food's default
 * portion and from nothing else.
 *
 * TOTAL by design, and biased to `mass`: this function DEGRADES and never
 * throws, because grams are always renderable — they are what was actually
 * measured — so every food has a truthful shopping line available to it. Three
 * answers, each with a condition that has to hold for the row to be renderable
 * at all:
 *
 *  * `volume` — the portion's unit token is a volume one AND
 *    {@link volumeDensityFor} resolves. A food whose density is neither stored
 *    nor derivable from its portion becomes a MASS row: "152 g" is the truth,
 *    and demanding millilitres of it would fail the whole shopping list over a
 *    unit choice nobody asked for. (This is the defect the shipped release
 *    exposed: 41 of 42 seeded recipes carry such an ingredient.)
 *  * `count` — the token is a count one AND the portion has a positive gram
 *    weight, the same requirement `requireCountPortion` enforces when the amount
 *    is rendered. Without it there is no "50 g each" to divide by, so the row
 *    cannot be counted and is weighed instead.
 *  * `mass` — everything else, including an unrecognised portion unit (the
 *    mockup's "1 bottle" is exactly this case, and container units are never
 *    generated) and a food with no default portion at all.
 *
 * The decision still rests on the portion, because it has to be reproducible:
 * the family is chosen ONCE at plan generation and read back from the row's own
 * stored `display_unit` on every later update (§0.7.3, and the unit-family lock
 * in this file's header). A stored row is therefore never re-judged here — see
 * {@link storedRowFamily}, which keeps failing loudly for a stored volume row
 * whose food can no longer state a density, since that is a real invariant break
 * rather than a rendering choice.
 *
 * Takes the whole {@link GroceryConversionFacts} rather than the portion alone
 * because the density is half of the volume question and lives beside it.
 */
export const displayFamilyForPortion = (facts: GroceryConversionFacts): UnitFamily => {
    const portion = facts.default_portion;

    if (!portion) {
        return 'mass';
    }

    const family = unitFamily(portion.unit);

    if (family === 'volume') {
        return volumeDensityFor(facts) === null ? 'mass' : 'volume';
    }

    if (family === 'count') {
        return Number.isFinite(portion.gram_weight) && portion.gram_weight > 0 ? 'count' : 'mass';
    }

    return 'mass';
};

const requireCountPortion = (portion: GroceryDefaultPortion | null): GroceryDefaultPortion => {
    if (!portion || !Number.isFinite(portion.gram_weight) || portion.gram_weight <= 0) {
        throw new GroceryDataError(
            'A count row needs a default portion with a positive gram_weight to convert grams into items, ' +
                `received ${JSON.stringify(portion)}`,
        );
    }

    return portion;
};

/**
 * Renders an aggregated gram total in a given family.
 *
 * Each family reaches its numbers a different way, and only the mass family
 * needs nothing but the grams:
 *  - `volume` converts through the density {@link volumeDensityFor} resolves —
 *    the food's stored one, or the one its default portion states. A food that
 *    can state NEITHER still THROWS (`UnitConversionError`, from
 *    `utils/units.ts`, which owns that rule): millilitres never equal grams, and
 *    {@link displayFamilyForPortion} never chooses this family for such a food,
 *    so reaching it here means a STORED row's recorded `display_unit` says
 *    volume while its food can no longer be converted — the unit-family lock
 *    broken upstream, which is a fault to surface rather than paper over.
 *  - `count` divides by the default portion's gram weight — 600 g of egg at
 *    50 g each is "12 eggs" — and stores {@link COUNT_DISPLAY_UNIT} rather than
 *    the pluralised word, so the row's family stays readable. The stored
 *    quantity counts ITEMS, not portions: a portion that counts several items
 *    ("5 sprigs", 1 g) is multiplied out by `utils/units.ts`, so 9 g of dill is
 *    45 sprigs. Every count comparison below therefore works in items too.
 *  - `mass` tiers grams -> oz -> lb in `utils/units.ts`.
 */
export const buildGroceryDisplay = (
    quantityGrams: number,
    family: UnitFamily,
    facts: GroceryConversionFacts,
): GroceryDisplay => {
    if (!Number.isFinite(quantityGrams) || quantityGrams < 0) {
        throw new GroceryDataError(
            `A grocery quantity must be a finite, non-negative number of grams, received ${String(quantityGrams)}`,
        );
    }

    if (family === 'volume') {
        const rendered = formatVolume(gramsToMilliliters(quantityGrams, volumeDensityFor(facts)));

        return { family, quantity: rendered.value, unit: rendered.unit, text: rendered.text };
    }

    if (family === 'count') {
        const portion = requireCountPortion(facts.default_portion);
        const rendered = formatCount(quantityGrams / portion.gram_weight, portion.description);

        return { family, quantity: rendered.value, unit: COUNT_DISPLAY_UNIT, text: rendered.text };
    }

    const rendered = formatMass(quantityGrams);

    return { family, quantity: rendered.value, unit: rendered.unit, text: rendered.text };
};

/* ---------------------------------------------------------------------------
 * The food_state name suffix
 * ------------------------------------------------------------------------- */

/** Which states each base name appears in, across one list. */
export type FoodStatesByName = ReadonlyMap<string, ReadonlySet<string>>;

/**
 * Indexes the states each base name appears in.
 *
 * Built from the foods actually ON the list, because coexistence is a property
 * of the list rather than of the catalog: "Rice" needs disambiguating only
 * while both its dry and its cooked row are present.
 */
export const indexFoodStatesByName = (
    entries: readonly Pick<GroceryFoodFacts, 'name' | 'food_state'>[],
): Map<string, Set<string>> => {
    const index = new Map<string, Set<string>>();

    for (const entry of entries) {
        const states = index.get(entry.name);

        if (states) {
            states.add(entry.food_state);
        } else {
            index.set(entry.name, new Set([entry.food_state]));
        }
    }

    return index;
};

/**
 * The states that need no qualifier of their own: a shopper buys the food as
 * the shop sells it. `raw` is the catalog's default and `as_purchased` says the
 * same thing about a food that is never sold in another state — oil, honey,
 * vinegar, milk — so "Olive oil, as purchased" adds a code where §0.1.4's own
 * grocery example reads "Olive oil".
 */
const SHOPPING_FORM_STATES: ReadonlySet<string> = new Set([RAW_FOOD_STATE, 'as_purchased']);

/**
 * The words that already state a given preparation, per state.
 *
 * Catalog display names carry their own preparation qualifier — "Brown rice,
 * cooked", "Black beans, canned", "Turkey breast, sliced" — so appending the
 * state produces "Brown rice, cooked, cooked" and "Black beans, canned,
 * cooked". Matching is per state and against the name's LAST qualifier only,
 * never a keyword scan of the whole name: "Rolled oats, dry" on a `cooked` row
 * is a different food from the dry one and must still read "..., cooked".
 */
const STATE_SYNONYMS: Record<string, readonly string[]> = {
    dry: ['dry', 'dried', 'uncooked'],
    cooked: ['cooked', 'canned', 'boiled', 'roasted', 'braised', 'steamed', 'grilled', 'baked'],
    prepared: [
        'prepared',
        'canned',
        'jarred',
        'bottled',
        'sliced',
        'shredded',
        'smoked',
        'roasted',
        'pickled',
        'cured',
    ],
};

// Only the qualifiers are read — everything after the FIRST comma — so the
// food's own noun can never be mistaken for a preparation. "Tuna, canned in
// water" states its preparation inside a phrase and "Beef, ground, cooked" in
// the last of two qualifiers, so every qualifier word is tested rather than one
// of them compared whole.
const statesItsOwnPreparation = (baseName: string, foodState: string): boolean => {
    const synonyms = Object.prototype.hasOwnProperty.call(STATE_SYNONYMS, foodState)
        ? STATE_SYNONYMS[foodState]
        : null;

    if (!synonyms) {
        return false;
    }

    const [, ...qualifiers] = baseName.split(',');
    const words = qualifiers.join(' ').toLowerCase().match(/[a-z]+/g) ?? [];

    return words.some((word) => synonyms.includes(word));
};

/**
 * The shopping name: the base name, plus the state when the state is worth
 * saying.
 *
 * Three rules, in this order, because they can disagree:
 *
 *  1. COEXISTENCE ALWAYS WINS. While one base name is on the list in more than
 *     one state, every one of its rows is qualified — that is what keeps
 *     "Rice, dry" and "Rice, cooked" two distinguishable lines, and suppressing
 *     either would collapse two rows to one name.
 *  2. A SHOPPING-FORM STATE IS SILENT. {@link SHOPPING_FORM_STATES} needs no
 *     qualifier: "Chicken breast", "Olive oil".
 *  3. A NAME THAT ALREADY SAYS IT IS LEFT ALONE. "Brown rice, cooked" on a
 *     `cooked` row is complete; §0.7.3's suffix exists to tell states apart,
 *     not to repeat one the catalog already wrote.
 *
 * Otherwise the state is appended, and `as_purchased` reads as "as purchased":
 * the stored value is a code, and this is the one place a grocery code becomes
 * words, because the name is text this module owns.
 */
export const buildGroceryName = (baseName: string, foodState: string, statesByName: FoodStatesByName): string => {
    const coexistingStates = statesByName.get(baseName);
    const suffixed = `${baseName}, ${foodState.replace(/_/g, ' ')}`;

    if (coexistingStates !== undefined && coexistingStates.size > 1) {
        return suffixed;
    }

    if (SHOPPING_FORM_STATES.has(foodState) || statesItsOwnPreparation(baseName, foodState)) {
        return baseName;
    }

    return suffixed;
};

/* ---------------------------------------------------------------------------
 * Aisles and list order
 * ------------------------------------------------------------------------- */

/** A new shopping line, ready for `grocery_items`. */
export interface GroceryRowDraft {
    catalog_food_id: string;
    food_state: string;
    category: GroceryCategory;
    name: string;
    /** Rounded to the column's two decimals. */
    quantity_grams: number;
    display_quantity: number;
    display_unit: string;
    display_text: string;
    sort_order: number;
}

/**
 * List order: aisle first, then name.
 *
 * The aisle index comes from `catalog.logic.ts`, which is where `pantry_other`
 * closing the list is pinned. Equal keys return 0 and keep their incoming
 * order, which is deterministic because the aggregation is already sorted by
 * identity and `Array.prototype.sort` is stable.
 */
const compareDrafts = (
    a: Pick<GroceryRowDraft, 'category' | 'name'>,
    b: Pick<GroceryRowDraft, 'category' | 'name'>,
): number => {
    const byAisle = groceryCategorySortIndex(a.category) - groceryCategorySortIndex(b.category);

    if (byAisle !== 0) {
        return byAisle;
    }

    if (a.name < b.name) {
        return -1;
    }

    if (a.name > b.name) {
        return 1;
    }

    return 0;
};

const indexFactsByIdentity = (facts: readonly GroceryFoodFacts[]): Map<string, GroceryFoodFacts> => {
    const index = new Map<string, GroceryFoodFacts>();

    for (const fact of facts) {
        index.set(identityKey(fact.catalog_food_id, fact.food_state), fact);
    }

    return index;
};

/**
 * Turns a week of planned meals into the shopping list: aggregate the grams,
 * name each line, file it in an aisle, render its amount, then order the whole
 * list and number it.
 *
 * `facts` must cover every aggregated identity — a line with no catalog facts
 * can be neither named nor filed, so a missing one throws rather than being
 * dropped from the shop. Every line is numbered from its final position, so
 * `sort_order` alone reproduces this order without re-deriving it.
 */
export const buildGroceryRows = (
    meals: readonly PlannedMealForGroceries[],
    facts: readonly GroceryFoodFacts[],
): GroceryRowDraft[] => {
    const totals = aggregatePlannedGrams(meals);
    const factsByIdentity = indexFactsByIdentity(facts);

    const lines = totals.map((total) => {
        const fact = factsByIdentity.get(identityKey(total.catalog_food_id, total.food_state));

        if (!fact) {
            throw new GroceryDataError(
                `No catalog facts for grocery identity ${total.catalog_food_id} (${total.food_state}); ` +
                    'a shopping line cannot be named or categorised without them',
            );
        }

        return { total, fact };
    });

    const statesByName = indexFoodStatesByName(lines.map(({ fact }) => fact));

    return lines
        .map(({ total, fact }) => {
            const display = buildGroceryDisplay(
                total.quantity_grams,
                displayFamilyForPortion(fact),
                fact,
            );

            return {
                catalog_food_id: total.catalog_food_id,
                food_state: total.food_state,
                category: mapCategoryToGroceryCategory(fact.category),
                name: buildGroceryName(fact.name, total.food_state, statesByName),
                quantity_grams: toStoredGrams(total.quantity_grams),
                display_quantity: display.quantity,
                display_unit: display.unit,
                display_text: display.text,
                sort_order: 0,
            };
        })
        .sort(compareDrafts)
        .map((draft, index) => ({ ...draft, sort_order: index }));
};


/* ---------------------------------------------------------------------------
 * Stored rows, the acknowledged baseline and the flag
 * ------------------------------------------------------------------------- */

/** One `grocery_items` row as stored. `Decimal` columns arrive as numbers. */
export interface StoredGroceryRow {
    id: string;
    catalog_food_id: string;
    food_state: string;
    name: string;
    /** The stored aisle code. */
    category: string;
    quantity_grams: number;
    display_quantity: number;
    display_unit: string;
    display_text: string;
    is_checked: boolean;
    /** The last amount the user acknowledged; null when nothing is outstanding. */
    previous_quantity_grams: number | null;
    flagged_at: Date | null;
    sort_order: number;
}

/**
 * The amount the user last acknowledged — the yardstick every "was Y" is
 * measured from.
 *
 * `previous_quantity_grams` holds it, recorded when they checked the row or
 * last cleared its flag. The fallback to the row's current quantity covers a
 * row checked before the column carried a value: treating "unknown" as "what
 * is on the row now" is the only reading that cannot overstate the change.
 */
export const acknowledgedBaselineGrams = (
    row: Pick<StoredGroceryRow, 'quantity_grams' | 'previous_quantity_grams'>,
): number => row.previous_quantity_grams ?? row.quantity_grams;

/**
 * The family a stored row lives in, read back off its own `display_unit`.
 *
 * This is the unit-family lock. Every update renders through the family the row
 * was created in, so an amount may move oz -> lb but never mass -> count and
 * "Now X, was Y" is always one family's comparison. A `display_unit` that no
 * longer resolves means the lock has already been broken upstream, so it throws
 * rather than guessing a family and silently changing what the row measures.
 */
export const storedRowFamily = (row: Pick<StoredGroceryRow, 'display_unit'>): UnitFamily => {
    const family = unitFamily(row.display_unit);

    if (!family) {
        throw new GroceryDataError(
            `Stored display_unit "${row.display_unit}" does not belong to a unit family; ` +
                'a grocery row must keep the family it was created in',
        );
    }

    return family;
};

/**
 * Pluralises the one display unit that carries a plural form.
 *
 * `utils/units.ts` pluralises `cup` when it renders an amount, but the delta is
 * a number this module computes, so it needs the same courtesy: "+¼ cup", not
 * "+¼ cups". Every other unit in the mass and volume families is an invariant
 * abbreviation (g, ml, oz, lb, tbsp).
 */
const DELTA_UNIT_PLURALS: Record<string, { singular: string; plural: string }> = {
    cup: { singular: 'cup', plural: 'cups' },
    cups: { singular: 'cup', plural: 'cups' },
};

const deltaUnitWord = (unit: string, value: number): string => {
    const forms = Object.prototype.hasOwnProperty.call(DELTA_UNIT_PLURALS, unit) ? DELTA_UNIT_PLURALS[unit] : null;

    if (!forms) {
        return unit;
    }

    return Math.abs(value) > 1 ? forms.plural : forms.singular;
};

interface DeltaTextInputs {
    baselineGrams: number;
    /** The row's rendered amount — the delta is expressed in ITS unit. */
    displayQuantity: number;
    displayUnit: string;
    family: UnitFamily;
    facts: GroceryConversionFacts;
}

/** A delta that has rounded away at the row unit's own precision. */
const VANISHED_DELTA = 0;

/**
 * The floor on a count delta: a flag that stands is worth at least one whole
 * item, because you buy an egg rather than a fifth of one.
 */
const MIN_COUNT_DELTA_ITEMS = 1;

/** The two strings a flagged row's "Now X, was Y" sub-line and delta pill render. */
interface FlagStrings {
    previousDisplayText: string;
    deltaDisplayText: string;
}

/**
 * A count row's pair, both derived from the SAME rendered baseline.
 *
 * The baseline is rendered once, and the delta subtracts the whole number that
 * rendering produced — not the fractional item count behind it. Rounding the
 * baseline twice, once for "was" and once for the pill, is what let the two
 * disagree by a whole item: 37.5 sprigs renders as "38 sprigs" while 43 − 37.5
 * rounds to 6, and the shopper reads "was 38, Now 43, +6". Subtracting the
 * displayed numbers is the only arithmetic that reconciles, and it needs no
 * rounding of its own because both sides are already whole items.
 *
 * Counting items rather than portions matters here too: `display_quantity`
 * counts items and a portion may count several ("5 sprigs"), so comparing items
 * against portions would report a fifth of the real increase — which is why the
 * baseline goes through the same renderer as the row.
 *
 * The floor is one whole item: a flag that stands is worth at least one thing to
 * buy, and the count family has no smaller unit to fall back to the way a mass
 * row falls back to grams. It binds only when the increase is under one item,
 * which `diffGroceryList` does not flag in the first place — a row whose
 * rendered text did not change is never flagged.
 */
const countFlagStrings = ({ baselineGrams, displayQuantity, family, facts }: DeltaTextInputs): FlagStrings => {
    const portion = requireCountPortion(facts.default_portion);
    const baseline = buildGroceryDisplay(baselineGrams, family, facts);
    const items = Math.max(displayQuantity - baseline.quantity, MIN_COUNT_DELTA_ITEMS);

    return {
        previousDisplayText: baseline.text,
        deltaDisplayText: `+${items} ${pluralizeCount(items, portion.description)}`,
    };
};

/**
 * A mass or volume row's pair, both rendered in the ROW'S unit.
 *
 * All three strings the shopper reads together — "was Y", "Now X" and the pill
 * — are one unit's worth of arithmetic, so they are computed here together
 * rather than each finding its own unit. Re-tiering the baseline on its own is
 * what put "was 14 tbsp" beside "2 cups" with "+1 cup": each string was
 * truthful and the three did not reconcile. The baseline is therefore rendered
 * in the row's own `display_unit` at that unit's precision, and the delta is
 * the difference of the two ROUNDED amounts, so the pill is exactly what the
 * shopper gets by subtracting the numbers in front of them. The sign is always
 * "+": a flag is only ever raised by an increase over the acknowledged amount.
 *
 * Two invariants hold whatever the numbers do:
 *
 *  * A FLAGGED INCREASE NEVER RENDERS ZERO. An increase that crosses a
 *    promotion boundary is, by definition, smaller than one step of the unit it
 *    promoted INTO: 447.9 g and 453.6 g are "15.8 oz" and "1 lb", and in pounds
 *    both round to 1, so the row's own unit can only call the gap "+0 lb". That
 *    degenerate case — a baseline the row's unit cannot tell apart from the
 *    current amount, or one that rounds away entirely — is the ONE place the
 *    pair falls back to `utils/units.ts`'s tiered formatter, which picks a unit
 *    small enough to show the difference and clamps a positive amount away from
 *    zero ("was 15.8 oz", "+6 g"). Both strings fall back together, so they
 *    still describe the same two amounts.
 *  * THE DELTA STAYS INSIDE THE ROW'S UNIT FAMILY. The row's unit, and the
 *    fallback's formatter, both belong to the family the row was created with,
 *    so a mass row's delta is always a mass and a volume row's always a volume
 *    — the unit-family lock the header states, applied to the pill.
 */
const measuredFlagStrings = ({
    baselineGrams,
    displayQuantity,
    displayUnit,
    family,
    facts,
}: DeltaTextInputs): FlagStrings => {
    const baseAmount = family === 'volume' ? gramsToMilliliters(baselineGrams, volumeDensityFor(facts)) : baselineGrams;
    const baseline = formatInUnit(baseAmount, displayUnit);
    const difference = displayQuantity - baseline.value;
    const delta = family === 'volume' ? roundToQuarter(difference) : roundToTenth(difference);

    if (baseline.value > 0 && delta !== VANISHED_DELTA) {
        return {
            previousDisplayText: baseline.text,
            deltaDisplayText: `+${family === 'volume' ? formatQuarters(delta) : String(delta)} ${deltaUnitWord(displayUnit, delta)}`,
        };
    }

    const perUnit = toBaseQuantity(1, displayUnit).amount;
    const exactDifference = Math.abs(displayQuantity - baseAmount / perUnit) * perUnit;
    const smallerUnit = family === 'volume' ? formatVolume(exactDifference) : formatMass(exactDifference);

    return {
        previousDisplayText: buildGroceryDisplay(baselineGrams, family, facts).text,
        deltaDisplayText: `+${smallerUnit.text}`,
    };
};

const buildFlagStrings = (inputs: DeltaTextInputs): FlagStrings =>
    inputs.family === 'count' ? countFlagStrings(inputs) : measuredFlagStrings(inputs);

/**
 * The wire flag for a row, or null when the row is not flagged.
 *
 * All three strings are pre-formatted because the client renders them verbatim:
 * it must not recompute a delta from `quantityGrams`, since `previousDisplayText`
 * is the amount the user ACKNOWLEDGED and not the amount before the last change.
 * A row flagged without a recorded baseline describes nothing truthfully, so it
 * reports no flag rather than inventing a "was".
 *
 * "was Y" and the delta are built together, in ONE unit, so the three strings
 * the shopper reads side by side reconcile — see {@link measuredFlagStrings}.
 */
export const buildGroceryFlag = (
    row: Pick<
        StoredGroceryRow,
        'quantity_grams' | 'previous_quantity_grams' | 'display_quantity' | 'display_unit' | 'display_text' | 'flagged_at'
    >,
    facts: GroceryConversionFacts,
): GroceryItemFlag | null => {
    if (!row.flagged_at || row.previous_quantity_grams === null) {
        return null;
    }

    const family = storedRowFamily(row);
    const baselineGrams = row.previous_quantity_grams;
    const { previousDisplayText, deltaDisplayText } = buildFlagStrings({
        baselineGrams,
        displayQuantity: row.display_quantity,
        displayUnit: row.display_unit,
        family,
        facts,
    });

    return {
        previousDisplayText,
        newDisplayText: row.display_text,
        deltaDisplayText,
        flaggedAt: row.flagged_at.toISOString(),
    };
};

/* ---------------------------------------------------------------------------
 * The diff — applied after a swap or a regeneration
 * ------------------------------------------------------------------------- */

/** The stored fields a surviving row is updated to. `is_checked` is absent by design. */
export interface GroceryRowUpdate {
    id: string;
    name: string;
    category: GroceryCategory;
    quantity_grams: number;
    display_quantity: number;
    display_unit: string;
    display_text: string;
    sort_order: number;
    previous_quantity_grams: number | null;
    flagged_at: Date | null;
}

/** A line the new plan no longer needs. `is_checked` travels so a checked removal can be reported. */
export interface GroceryRowRemoval {
    id: string;
    name: string;
    is_checked: boolean;
}

/** What the service must write to bring the stored list in line with a new plan. */
export interface GroceryDiffPlan {
    inserts: GroceryRowDraft[];
    updates: GroceryRowUpdate[];
    removals: GroceryRowRemoval[];
    /** Rows needing no write at all. */
    unchangedItemIds: string[];
    summary: GroceryChangeSummary;
}

const sameInstant = (a: Date | null, b: Date | null): boolean => {
    if (a === null || b === null) {
        return a === b;
    }

    return a.getTime() === b.getTime();
};

/**
 * Reconciles the stored list with a freshly aggregated one, row by row.
 *
 * The outcomes, and why each is what it is:
 *  - UNCHANGED within the epsilon keeps its check AND its text; the stored
 *    quantity is left alone so noise cannot rewrite a line the shopper is
 *    reading.
 *  - INCREASED on a CHECKED row keeps the check — nothing may disappear from
 *    the list — and flags instead, against the acknowledged baseline.
 *  - An increase whose rendered text does not move is stored but RAISES no
 *    flag — including once a decrease has cleared one and left the row reading
 *    more than was acknowledged. A flag that already stands survives such an
 *    increase, because retracting a warning the user is looking at over a
 *    change they cannot see would be the same noise in reverse.
 *  - INCREASED on an unchecked row is just a new amount.
 *  - DECREASED updates the text and stays silent: check kept, and any standing
 *    flag CLEARED — the amount the shopper was warned about has gone away, so
 *    the warning goes with it, even when the new amount is still above what
 *    they acknowledged. The acknowledged baseline itself is kept, so a later
 *    increase is still measured from the amount they actually saw.
 *  - NEW arrives unchecked; REMOVED is deleted and counted, checked or not.
 *
 * `is_checked` is never part of an update: a recomputation of the week is not a
 * statement about what the user has shopped for. An existing flag's
 * `flagged_at` is preserved while the flag stands, because the divergence dates
 * from when it was raised, which is also what keeps the baseline stable across
 * repeated swaps.
 */
export const diffGroceryList = (
    existing: readonly StoredGroceryRow[],
    drafts: readonly GroceryRowDraft[],
    facts: readonly GroceryFoodFacts[],
    now: Date,
): GroceryDiffPlan => {
    const existingByIdentity = new Map(
        existing.map((row) => [identityKey(row.catalog_food_id, row.food_state), row] as const),
    );
    const factsByIdentity = indexFactsByIdentity(facts);

    const inserts: GroceryRowDraft[] = [];
    const updates: GroceryRowUpdate[] = [];
    const unchangedItemIds: string[] = [];
    const survivingIds = new Set<string>();
    let increased = 0;

    for (const draft of drafts) {
        const key = identityKey(draft.catalog_food_id, draft.food_state);
        const row = existingByIdentity.get(key);

        if (!row) {
            inserts.push(draft);
            continue;
        }

        survivingIds.add(row.id);

        const fact = factsByIdentity.get(key);

        if (!fact) {
            throw new GroceryDataError(
                `No catalog facts for grocery identity ${draft.catalog_food_id} (${draft.food_state}); ` +
                    'an existing line cannot be re-rendered without them',
            );
        }

        const change = classifyQuantityChange(row.quantity_grams, draft.quantity_grams);

        if (change === 'increased') {
            increased += 1;
        }

        const family = storedRowFamily(row);
        const quantityGrams = change === 'unchanged' ? row.quantity_grams : draft.quantity_grams;
        const display =
            change === 'unchanged'
                ? { quantity: row.display_quantity, unit: row.display_unit, text: row.display_text }
                : buildGroceryDisplay(quantityGrams, family, fact);

        const baselineGrams = acknowledgedBaselineGrams(row);
        // A flag the user cannot see on the row is noise, and the two texts it
        // has to be visible against are different questions. It must differ
        // from the ACKNOWLEDGED amount, or the pill would read "was 2.5 lb,
        // Now 2.5 lb"; and RAISING a new one additionally requires this diff to
        // have moved the row's OWN text, because an increase that leaves "2.9
        // lb" reading "2.9 lb" is the same-display exception however far the
        // amount has drifted from what was acknowledged. The second test is
        // skipped for a flag that already stands: a later invisible increase
        // must not retract a warning the user is already looking at.
        const aboveAcknowledged = classifyQuantityChange(baselineGrams, quantityGrams) === 'increased';
        const visibleAgainstAcknowledged =
            display.text !== buildGroceryDisplay(baselineGrams, family, fact).text;
        const raisesOrKeepsAFlag = row.flagged_at !== null || display.text !== row.display_text;

        const flagged =
            change === 'increased' &&
            row.is_checked &&
            aboveAcknowledged &&
            visibleAgainstAcknowledged &&
            raisesOrKeepsAFlag;

        const previousQuantityGrams = row.is_checked ? baselineGrams : null;
        // Only the change that actually arrived may re-judge the flag, which is
        // why the direction is consulted and not just the baseline comparison.
        // An INCREASE raises one, or keeps the instant an earlier one carries. A
        // DECREASE clears it, because a smaller amount is nothing to warn about
        // even while it stays above the acknowledged baseline. An UNCHANGED row
        // keeps whatever it already had, deliberately WITHOUT re-deriving the
        // predicate: the baseline is still below the current amount after a
        // decrease has cleared a flag, so re-deriving it would raise a brand-new
        // flag on an inert re-aggregation that told the shopper nothing.
        const flaggedAt = change === 'unchanged' ? row.flagged_at : flagged ? (row.flagged_at ?? now) : null;

        const needsWrite =
            row.name !== draft.name ||
            row.category !== draft.category ||
            row.quantity_grams !== quantityGrams ||
            row.display_quantity !== display.quantity ||
            row.display_unit !== display.unit ||
            row.display_text !== display.text ||
            row.sort_order !== draft.sort_order ||
            row.previous_quantity_grams !== previousQuantityGrams ||
            !sameInstant(row.flagged_at, flaggedAt);

        if (!needsWrite) {
            unchangedItemIds.push(row.id);
            continue;
        }

        updates.push({
            id: row.id,
            name: draft.name,
            category: draft.category,
            quantity_grams: quantityGrams,
            display_quantity: display.quantity,
            display_unit: display.unit,
            display_text: display.text,
            sort_order: draft.sort_order,
            previous_quantity_grams: previousQuantityGrams,
            flagged_at: flaggedAt,
        });
    }

    const removals = existing
        .filter((row) => !survivingIds.has(row.id))
        .sort((a, b) => a.sort_order - b.sort_order)
        .map((row) => ({ id: row.id, name: row.name, is_checked: row.is_checked }));

    return {
        inserts,
        updates,
        removals,
        unchangedItemIds,
        summary: { added: inserts.length, removed: removals.length, increased },
    };
};


/* ---------------------------------------------------------------------------
 * Check marks — state-setting, last write wins
 * ------------------------------------------------------------------------- */

/** The four columns a check mark owns. Never mixed with a quantity update. */
export interface GroceryCheckUpdate {
    is_checked: boolean;
    checked_at: Date | null;
    previous_quantity_grams: number | null;
    /** Always null: interacting with a row acknowledges whatever it now says. */
    flagged_at: null;
}

/**
 * The update "Uncheck all" applies: checks cleared and flags cleared.
 *
 * Row-independent on purpose, so the service can apply it to a whole plan in
 * one statement. Clearing the baseline is correct rather than merely
 * convenient: it is only ever consulted for a checked row, and checking a row
 * again records the amount visible at that moment.
 */
export const applyUncheckAll = (): GroceryCheckUpdate => ({
    is_checked: false,
    checked_at: null,
    previous_quantity_grams: null,
    flagged_at: null,
});

/**
 * Applies a desired check state to one row.
 *
 * The request names the state it wants rather than asking for a flip, which is
 * what makes this write safely repeatable with no idempotency key and no
 * expected revision — last write wins — and why it never bumps the plan
 * revision: a check mark is not a plan change.
 *
 * Both directions clear the flag and RESET THE ACKNOWLEDGED BASELINE, because
 * either way the user has just seen the amount the row is showing. Checking
 * records that amount as the new yardstick; unchecking leaves nothing
 * outstanding to compare against — the same update "Uncheck all" applies — and
 * re-checking later records it afresh.
 */
export const applyToggle = (
    row: Pick<StoredGroceryRow, 'quantity_grams'>,
    isChecked: boolean,
    now: Date,
): GroceryCheckUpdate => {
    if (!isChecked) {
        return applyUncheckAll();
    }

    return {
        is_checked: true,
        checked_at: now,
        previous_quantity_grams: row.quantity_grams,
        flagged_at: null,
    };
};

/* ---------------------------------------------------------------------------
 * List shape and the banner
 * ------------------------------------------------------------------------- */

/** One aisle of the list. Generic in the item, so no DTO mapping happens here. */
export interface GrocerySectionOf<TItem> {
    category: GroceryCategory;
    items: TItem[];
}

/** Unchecked rows by aisle, and the checked ones held apart. */
export interface GroceryListPartition<TItem> {
    sections: GrocerySectionOf<TItem>[];
    checkedItems: TItem[];
}

/**
 * Splits a plan's rows into aisle sections and a checked list.
 *
 * Sections follow the store order `catalog.logic.ts` pins, which closes with
 * `pantry_other`, and an aisle with nothing in it is omitted rather than
 * rendered empty. Checked rows are held apart so they stay visible below the
 * list instead of vanishing from it.
 *
 * A stored aisle code that is no longer recognised is shopped under
 * `pantry_other` rather than dropped: a row missing from every section is a row
 * missing from the shop.
 */
export const partitionGroceryList = <
    TItem extends Pick<StoredGroceryRow, 'category' | 'is_checked' | 'sort_order'>,
>(
    rows: readonly TItem[],
): GroceryListPartition<TItem> => {
    const byAisle = new Map<GroceryCategory, TItem[]>();
    const checkedItems: TItem[] = [];

    for (const row of rows) {
        if (row.is_checked) {
            checkedItems.push(row);
            continue;
        }

        const category = isGroceryCategory(row.category) ? row.category : 'pantry_other';
        const items = byAisle.get(category);

        if (items) {
            items.push(row);
        } else {
            byAisle.set(category, [row]);
        }
    }

    const bySortOrder = (a: TItem, b: TItem): number => a.sort_order - b.sort_order;

    const sections = GROCERY_CATEGORY_ORDER.flatMap((category) => {
        const items = byAisle.get(category);

        return items ? [{ category, items: items.sort(bySortOrder) }] : [];
    });

    return { sections, checkedItems: checkedItems.sort(bySortOrder) };
};

/** The swap that last touched a plan's list, as the banner needs it. */
export interface GrocerySwapContext {
    /** The slot whose swap it was — the banner names it. */
    mealSlot: MealSlot;
    /** False when the swap left every quantity alone; there is then nothing to announce. */
    changedList: boolean;
}

/**
 * The banner code for a list, or null when there is nothing to announce.
 *
 * A flag outranks a swap notice: once an amount has gone up on something the
 * user already checked, that is the thing they need to know, and it is the
 * state frame 14b draws. Codes only — the client owns the copy and pluralises
 * it from `itemNames`.
 */
export const bannerFor = (
    rows: readonly Pick<StoredGroceryRow, 'name' | 'flagged_at'>[],
    lastSwap: GrocerySwapContext | null,
): GroceryBanner | null => {
    const flaggedNames = rows.filter((row) => row.flagged_at !== null).map((row) => row.name);

    if (flaggedNames.length > 0) {
        return { code: 'amount_increased', itemNames: flaggedNames };
    }

    if (lastSwap && lastSwap.changedList) {
        return { code: 'updated_after_swap', mealSlot: lastSwap.mealSlot };
    }

    return null;
};

/* ---------------------------------------------------------------------------
 * Request parsing
 *
 * Verdicts are RETURNED, not thrown: a field-level failure is data the client
 * renders beside the field, and every one of these is a 400, so no status code
 * appears here (Rule 7 §8).
 * ------------------------------------------------------------------------- */

type GroceryErrorVerdict = {
    kind: 'error';
    code: 'invalid_request';
    message: string;
    details: InvalidRequestDetail[];
};

export type ParsedGroceryListPath = { kind: 'ok'; planId: string } | GroceryErrorVerdict;

export type ParsedGroceryItemPath = { kind: 'ok'; planId: string; itemId: string } | GroceryErrorVerdict;

export type ParsedToggleGroceryBody = { kind: 'ok'; payload: ToggleGroceryItemPayload } | GroceryErrorVerdict;

const isUuidV4 = (value: unknown): value is string => typeof value === 'string' && UUID_V4_PATTERN.test(value);

const invalidRequest = (message: string, details: InvalidRequestDetail[]): GroceryErrorVerdict => ({
    kind: 'error',
    code: 'invalid_request',
    message,
    details,
});

/** Validates `:planId` for reading a list and for "Uncheck all". */
export const parseGroceryListPath = (params: { planId?: unknown }): ParsedGroceryListPath => {
    if (!isUuidV4(params.planId)) {
        return invalidRequest('planId must be a UUID', [
            { field: PLAN_ID_FIELD, code: GROCERY_FIELD_CODES.INVALID_ID },
        ]);
    }

    return { kind: 'ok', planId: params.planId };
};

/**
 * Validates `:planId` and `:itemId` for a single-item toggle.
 *
 * Both ids are judged, so a request with two malformed ids reports two details
 * instead of sending the caller back twice.
 */
export const parseGroceryItemPath = (params: {
    planId?: unknown;
    itemId?: unknown;
}): ParsedGroceryItemPath => {
    const details: InvalidRequestDetail[] = [];

    if (!isUuidV4(params.planId)) {
        details.push({ field: PLAN_ID_FIELD, code: GROCERY_FIELD_CODES.INVALID_ID });
    }

    if (!isUuidV4(params.itemId)) {
        details.push({ field: ITEM_ID_FIELD, code: GROCERY_FIELD_CODES.INVALID_ID });
    }

    if (details.length > 0) {
        return invalidRequest('planId and itemId must be UUIDs', details);
    }

    return { kind: 'ok', planId: params.planId as string, itemId: params.itemId as string };
};

/**
 * Validates the toggle body.
 *
 * `isChecked` must be an actual boolean: a truthy string or a 0/1 would let a
 * client set a check mark by accident, and the desired state is the whole
 * request.
 */
export const parseToggleGroceryBody = (body: unknown): ParsedToggleGroceryBody => {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return invalidRequest('isChecked is required', [
            { field: IS_CHECKED_FIELD, code: GROCERY_FIELD_CODES.REQUIRED },
        ]);
    }

    const isChecked = (body as Record<string, unknown>)[IS_CHECKED_FIELD];

    if (isChecked === undefined || isChecked === null) {
        return invalidRequest('isChecked is required', [
            { field: IS_CHECKED_FIELD, code: GROCERY_FIELD_CODES.REQUIRED },
        ]);
    }

    if (typeof isChecked !== 'boolean') {
        return invalidRequest('isChecked must be a boolean', [
            { field: IS_CHECKED_FIELD, code: GROCERY_FIELD_CODES.INVALID_TYPE },
        ]);
    }

    return { kind: 'ok', payload: { isChecked } };
};

/* ---------------------------------------------------------------------------
 * Plan writability
 * ------------------------------------------------------------------------- */

/** The plan facts a grocery write is judged against. */
export interface GroceryPlanState {
    id: string;
    /** `meal_plans.status`. */
    status: string;
    /** `meal_plans.end_date` as a day key in the user's own time zone. */
    end_date: string;
    /** The plan that superseded this one, resolved by the caller; null when none did. */
    replacement_plan_id: string | null;
}

const ACTIVE_PLAN_STATUS = 'active';

const ENDED_REASON: PlanEndedErrorData['reason'] = 'ended';

/**
 * A stored day key this module may compare, or a data fault.
 *
 * Asks the shared calendar predicate rather than the shape alone. The shape
 * would accept `2026-02-30`, and a plan whose stored `end_date` names a day
 * that does not exist has its lifecycle decided by a string comparison against
 * a date no calendar contains — which is exactly the "malformed one would
 * silently decide a plan's lifecycle by comparing nonsense" this guard exists
 * to prevent, so it is refused on the same ground.
 */
const requireDayKey = (value: string, label: string): string => {
    if (!isCalendarDayKey(value)) {
        throw new GroceryDataError(`${label} must be a YYYY-MM-DD day key, received ${JSON.stringify(value)}`);
    }

    return value;
};

/**
 * Returns the plan when it may still be written to, and throws otherwise.
 *
 * Two plans stop accepting writes for different reasons, and the client needs
 * to tell them apart: a SUPERSEDED plan reports the plan that replaced it, so a
 * stale screen can open the right week, while an ENDED plan — still `active` in
 * storage, but its last date has passed — reports `ended`. A plan that is
 * absent or not the caller's is the same answer, `PlanNotFoundError`, because
 * "no such plan" and "not your plan" must be indistinguishable.
 *
 * `today` is a parameter, computed by the caller in the user's stored time zone:
 * a day key plus a Firebase identity cannot establish a user's calendar day,
 * and a rule that read the clock could not be tested. Both keys are format-
 * checked, since a malformed one would silently decide a plan's lifecycle by
 * comparing nonsense.
 */
export const requireGroceryWritablePlan = (plan: GroceryPlanState | null, today: string): GroceryPlanState => {
    if (!plan) {
        throw new PlanNotFoundError();
    }

    if (plan.status !== ACTIVE_PLAN_STATUS) {
        // The superseded variant exists so a stale screen can open the plan that
        // replaced this one, so it is answered only when that id is actually
        // known. A regeneration links the successor in the same transaction that
        // supersedes the old plan, so a missing one here means the caller did
        // not resolve the reverse link or the data contradicts itself — a fault
        // to surface, not a 409 whose body omits what the variant promises.
        if (!plan.replacement_plan_id) {
            throw new GroceryDataError(
                `plan ${plan.id} is stored '${plan.status}' but no replacement plan was resolved; ` +
                    'a superseded plan always has a successor',
            );
        }

        throw new PlanNotActiveError({ replacementPlanId: plan.replacement_plan_id });
    }

    if (requireDayKey(plan.end_date, 'end_date') < requireDayKey(today, 'today')) {
        throw new PlanNotActiveError({ reason: ENDED_REASON });
    }

    return plan;
};
