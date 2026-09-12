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
//    text (2.51 -> 2.53 lb) updates the grams and does NOT flag. A flag the
//    user cannot see on the row is noise.
//
//  * THE UNIT-FAMILY LOCK. A row's unit family is chosen once, at plan
//    generation, from the food's default portion, and every later update reads
//    it back from that row's own stored `display_unit`. An update may move
//    oz -> lb but never mass -> count, so "Now X, was Y" is always a comparison
//    inside one family. Re-deriving the family per update is what would
//    eventually break it.
//
// A decrease is deliberately SILENT: the number changes, the check stays, and
// nothing is flagged, sub-lined or announced. Nothing disappears from the
// shopper's list and nothing shouts at them about less shopping.
//
// Division of responsibility, stated once because both boundaries are easy to
// drift across:
//
//  * `utils/units.ts` owns unit families, gram conversions, numeric formatting
//    and pluralisation. It is never re-implemented here — including the rule
//    that millilitres without a stored density cannot become grams, which is
//    why that failure surfaces as its own `UnitConversionError` from that
//    module rather than being pre-empted by a copy of the check.
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
    UnitFamily,
    formatCount,
    formatMass,
    formatQuarters,
    formatVolume,
    gramsToMilliliters,
    pluralizeCount,
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

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

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

/** The food's default portion, as `catalog_food_portions` stores it. */
export interface GroceryDefaultPortion {
    description: string;
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
 * The unit family a new row is created in, chosen from the food's default
 * portion and from nothing else.
 *
 * TOTAL by design, and biased to `mass`: an unrecognised portion unit — the
 * mockup's "1 bottle" is exactly this case — falls back to the grams that were
 * actually measured rather than being counted as containers, which the prompt
 * forbids generating. Only the unit TOKEN is consulted, because the same
 * decision has to be reproducible from a stored `display_unit` on every later
 * update; whether the food can actually be converted is checked when the
 * amount is rendered.
 */
export const displayFamilyForPortion = (portion: GroceryDefaultPortion | null): UnitFamily => {
    if (!portion) {
        return 'mass';
    }

    return unitFamily(portion.unit) ?? 'mass';
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
 *  - `volume` converts through the stored density. A missing density THROWS
 *    (`UnitConversionError`, from `utils/units.ts`, which owns that rule):
 *    millilitres never equal grams, and a plan that reached this point with a
 *    density-less volume food is a seed fault to surface, not to paper over.
 *  - `count` divides by the default portion's gram weight — 600 g of egg at
 *    50 g each is "12 eggs" — and stores {@link COUNT_DISPLAY_UNIT} rather than
 *    the pluralised word, so the row's family stays readable.
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
        const rendered = formatVolume(gramsToMilliliters(quantityGrams, facts.density_g_per_ml));

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
 * The shopping name: the base name, plus the state when the state is worth
 * saying.
 *
 * The suffix appears when the state is not `raw` — "Chicken breast" needs no
 * qualifier, "Rice, dry" does — OR when the same base name is on the list in
 * more than one state, which is what keeps "Rice, dry" and "Rice, cooked" two
 * distinguishable lines. `as_purchased` reads as "as purchased": the stored
 * value is a code, and this is the one place a grocery code becomes words,
 * because the name is text this module owns.
 */
export const buildGroceryName = (baseName: string, foodState: string, statesByName: FoodStatesByName): string => {
    const coexistingStates = statesByName.get(baseName);
    const needsSuffix = foodState !== RAW_FOOD_STATE || (coexistingStates !== undefined && coexistingStates.size > 1);

    if (!needsSuffix) {
        return baseName;
    }

    return `${baseName}, ${foodState.replace(/_/g, ' ')}`;
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
                displayFamilyForPortion(fact.default_portion),
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

/**
 * The delta pill's text, in the row's OWN unit rather than a freshly tiered one.
 *
 * This is the difference between "+0.6 lb" and "+9.6 oz": 0.6 lb is 272 g, and
 * re-tiering 272 g on its own picks ounces, so the three strings the user reads
 * would no longer add up ("was 2.5 lb", "Now 3.1 lb", "+9.6 oz"). The unit's
 * conversion factor comes from `utils/units.ts` — `toBaseQuantity(1, unit)` is
 * how many base units one of it is — and only the per-family precision choice
 * is made here, because that module exposes no "render this value in this unit"
 * entry point. The sign is always "+": a flag is only ever raised by an
 * increase over the acknowledged amount.
 */
const deltaTextFor = ({
    baselineGrams,
    displayQuantity,
    displayUnit,
    family,
    facts,
}: DeltaTextInputs): string => {
    if (family === 'count') {
        const portion = requireCountPortion(facts.default_portion);
        const delta = Math.round(displayQuantity - baselineGrams / portion.gram_weight);

        return `+${delta} ${pluralizeCount(delta, portion.description)}`;
    }

    const perUnit = toBaseQuantity(1, displayUnit).amount;

    if (family === 'volume') {
        const baselineInUnit = gramsToMilliliters(baselineGrams, facts.density_g_per_ml) / perUnit;
        const delta = displayQuantity - baselineInUnit;

        return `+${formatQuarters(delta)} ${deltaUnitWord(displayUnit, delta)}`;
    }

    const delta = roundToTenth(displayQuantity - baselineGrams / perUnit);

    return `+${String(delta)} ${deltaUnitWord(displayUnit, delta)}`;
};

/**
 * The wire flag for a row, or null when the row is not flagged.
 *
 * All three strings are pre-formatted because the client renders them verbatim:
 * it must not recompute a delta from `quantityGrams`, since `previousDisplayText`
 * is the amount the user ACKNOWLEDGED and not the amount before the last change.
 * A row flagged without a recorded baseline describes nothing truthfully, so it
 * reports no flag rather than inventing a "was".
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

    return {
        previousDisplayText: buildGroceryDisplay(baselineGrams, family, facts).text,
        newDisplayText: row.display_text,
        deltaDisplayText: deltaTextFor({
            baselineGrams,
            displayQuantity: row.display_quantity,
            displayUnit: row.display_unit,
            family,
            facts,
        }),
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
 *  - An increase whose rendered text does not move is stored but NOT flagged.
 *  - INCREASED on an unchecked row is just a new amount.
 *  - DECREASED updates the text and stays silent: check kept, no flag.
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
        const flagged =
            row.is_checked &&
            classifyQuantityChange(baselineGrams, quantityGrams) === 'increased' &&
            display.text !== buildGroceryDisplay(baselineGrams, family, fact).text;

        const previousQuantityGrams = row.is_checked ? baselineGrams : null;
        const flaggedAt = flagged ? (row.flagged_at ?? now) : null;

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

const requireDayKey = (value: string, label: string): string => {
    if (!DAY_KEY_PATTERN.test(value)) {
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
        throw new PlanNotActiveError(plan.replacement_plan_id ?? undefined);
    }

    if (requireDayKey(plan.end_date, 'end_date') < requireDayKey(today, 'today')) {
        throw new PlanNotActiveError(undefined, ENDED_REASON);
    }

    return plan;
};

