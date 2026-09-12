// The row -> DTO boundary for the weekly grocery list: the one place a
// `grocery_items` row becomes the camelCase shapes `src/types/mealPlanning.ts`
// declares and the mobile io-ts codecs decode. Two services return grocery
// shapes and both come through here — `grocery.service.ts` for the list, the
// toggle and "Uncheck all", and `swap.service.ts` for the change summary a swap
// reports — which is the promotion test Rule 7 §6 sets for a mapper of its own.
//
// Pure and synchronous: no Prisma client, no fetch, no clock, no `process.env`.
// Rows arrive as arguments because the services own every query, and the row
// types below are structural snake_case rather than Prisma's generated models,
// following `catalog.mapper.ts` — a mapper that insisted on a model type would
// push its callers into casts wherever a row is assembled from a join.
//
// Two details here cause outsized damage when they are missed, and neither one
// shows up in a passing typecheck:
//
//  * A DECIMAL IS NOT A NUMBER. `quantity_grams` and `previous_quantity_grams`
//    are `NUMERIC(10,2)`, so Prisma hands back a `Decimal` object. Serialised
//    into JSON as it stands it emits an object (or a string) where the client's
//    codec declares `io.number`, and a single unconverted column therefore
//    fails the WHOLE response rather than the one field. Every stored amount
//    passes through {@link decimalToNumber} exactly once, and that converted
//    value is what both the DTO field and the flag are built from.
//
//  * DAY KEYS ARE UTC. `start_date` and `end_date` are `@db.Date`, which Prisma
//    returns as a `Date` at UTC midnight. They are formatted from the UTC
//    components — the repository's `toDayKey` convention, as
//    `nutrition.service.ts` spells it — because reading local components on a
//    server west of UTC would shift the whole displayed week back by a day.
//
// The list's SHAPE is the other thing this file owns, and frame 14b is what it
// has to produce: unchecked rows stay in their aisles (`sections`, with an
// empty aisle omitted rather than rendered as a dead heading) while checked
// rows collect below (`checkedItems`), FLAGGED FIRST so an amount that went up
// is the first thing the shopper sees. Every array is ordered from the rows'
// own stored fields and never from the order Prisma returned them, so two loads
// of one list are byte-identical.
//
// What this file does NOT do, because each of these already has an owner:
//
//  * NO RULES. Aggregation, the epsilon, the diff, the flag decisions and every
//    display string belong to `grocery.logic.ts` and to `utils/units.ts`
//    beneath it. `name`, `display_text` and the flag's three strings arrive
//    FINAL and are copied verbatim: a second formatting path is exactly how the
//    flag's "was 2.5 lb" stops matching the row's own "3.1 lb".
//  * NO AISLE MAPPING. `partitionGroceryList` groups the rows and
//    `catalog.logic.ts` pins the store order that closes with `pantry_other`. A
//    second copy of that order is how one aisle ends up in two places at once.
//  * NO PROSE AND NO STATUS CODES. The banner travels as its code object; the
//    client owns the copy, including 14b's pluralisation.
//  * NO CLAIM ABOUT AN EMPTY LIST. An empty list is returned as an empty list.
//    Whether that reads as "no plan yet" (14c) or "this plan needs nothing" is
//    the client's decision, so no "the list was emptied" signal is invented.
//
// Per Rule 7 §11, mappers sit outside the `*.logic.ts` branch-coverage gate
// `jest.config.ts` derives from disk, and this one is verified end to end by
// `src/__tests__/api/grocery.test.ts` and `src/__tests__/api/swaps.test.ts` —
// so there is deliberately no `grocery.mapper.test.ts`.

import { GroceryConversionFacts, GroceryDiffPlan, buildGroceryFlag, partitionGroceryList } from './grocery.logic';
import {
    GroceryBanner,
    GroceryChangeSummary,
    GroceryItem,
    GroceryListResponse,
    GrocerySection,
} from '../types/mealPlanning';

/* ---------------------------------------------------------------------------
 * The one failure this boundary can have
 * ------------------------------------------------------------------------- */

/**
 * A stored row contradicted a guarantee `src/types/mealPlanning.ts` makes to
 * the client: an amount that does not convert to a finite number, or a plan
 * date that is not a real instant.
 *
 * Loud on purpose, and for the same reason `catalog.mapper.ts` throws rather
 * than defaulting: both quiet alternatives are worse than a 500. Emitting
 * `null` breaks a field the mobile decoder declares non-nullable and fails the
 * entire response, and defaulting a quantity to 0 states that the shopper needs
 * none of that ingredient — a number nothing measured. Every one of these is
 * prevented upstream (`grocery.logic.ts` rounds to the column's two decimals
 * and the columns are `NOT NULL`), so reaching this error means a row was
 * written around that path.
 */
export class GroceryMappingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'GroceryMappingError';
    }
}

/* ---------------------------------------------------------------------------
 * Row inputs — snake_case, exactly as stored
 * ------------------------------------------------------------------------- */

/**
 * A `NUMERIC` column as it can reach this boundary.
 *
 * Prisma returns `Decimal` for `quantity_grams`, which is the case this type
 * exists for; `number` covers a value a caller or a test has already converted,
 * and `string` covers a raw query whose driver hands numerics back as text.
 * Accepting all three here is what keeps the conversion in ONE place —
 * {@link decimalToNumber} — instead of at each of the two call sites that would
 * otherwise each need to know which form they hold.
 */
export type StoredDecimal = number | string | { toNumber(): number };

/**
 * One `grocery_items` row, narrowed to the columns the wire shape and the flag
 * need, plus the catalog facts of the row's own food.
 *
 * `facts` is REQUIRED rather than optional even though only a flagged row
 * consumes it: `buildGroceryFlag` renders "was Y" through the food's density or
 * default portion so the flag's three strings stay inside the row's unit
 * family, and a service that forgot to load them should fail when it is
 * compiled — not with a 500 on the rare path where an amount has gone up.
 */
export interface GroceryItemRow {
    id: string;
    catalog_food_id: string;
    /** `'raw' | 'cooked' | 'prepared' | 'dry' | 'as_purchased'`, passed through as the stored code. */
    food_state: string;
    /** Already carries the `food_state` suffix where one is due ("Rice, dry"). */
    name: string;
    /** The stored aisle code. Read only to group the row; never re-derived here. */
    category: string;
    quantity_grams: StoredDecimal;
    /** The number `display_text` renders; the flag's delta is expressed in its unit. */
    display_quantity: number;
    display_unit: string;
    /** The amount as the shopper reads it ("2.5 lb", "6 tbsp", "12 eggs"). Final. */
    display_text: string;
    is_checked: boolean;
    /** The last amount the user acknowledged; null when nothing is outstanding. */
    previous_quantity_grams: StoredDecimal | null;
    flagged_at: Date | null;
    sort_order: number;
    facts: GroceryConversionFacts;
}

/** The `meal_plans` columns the list response reports about its plan. */
export interface GroceryPlanRow {
    id: string;
    revision: number;
    /** `@db.Date`, so a `Date` at UTC midnight. */
    start_date: Date;
    end_date: Date;
}

/* ---------------------------------------------------------------------------
 * Column conversions
 * ------------------------------------------------------------------------- */

const DAY_KEY_LENGTH = 10;

/**
 * A stored `NUMERIC` amount as a plain number, whichever form it arrived in.
 *
 * The blank-string guard is not ceremony: `Number('')` and `Number(' ')` are
 * both `0`, so a blank amount would otherwise pass every check and put a
 * silent "0 g" on the shopping list. It is mapped to `NaN` so the finiteness
 * check below reports it as the fault it is.
 */
const decimalToNumber = (value: StoredDecimal, column: string, rowId: string): number => {
    let numeric: number;

    if (typeof value === 'number') {
        numeric = value;
    } else if (typeof value === 'string') {
        numeric = value.trim().length === 0 ? Number.NaN : Number(value);
    } else {
        numeric = value.toNumber();
    }

    if (!Number.isFinite(numeric)) {
        throw new GroceryMappingError(
            `grocery_items.${column} on row ${rowId} does not convert to a finite number ` +
                `(received ${String(value)})`,
        );
    }

    return numeric;
};

/**
 * A `@db.Date` plan boundary as a `YYYY-MM-DD` day key.
 *
 * The UTC components and nothing else, for the reason the header gives: the
 * column stores a calendar day, Prisma returns it as midnight UTC, and reading
 * local components on a server west of UTC would move the whole displayed week
 * back a day. This is the repository's `toDayKey` convention, which
 * `nutrition.service.ts` spells the same way for diary days; it is repeated
 * rather than imported, because reaching into a service from a mapper would
 * invert the layering for one expression.
 *
 * An unparseable `Date` is reported rather than allowed to surface as
 * `toISOString`'s bare `RangeError`, which names neither the column nor the
 * plan.
 */
const toPlanDayKey = (date: Date, column: string, planId: string): string => {
    if (!Number.isFinite(date.getTime())) {
        throw new GroceryMappingError(`meal_plans.${column} on plan ${planId} is not a valid date`);
    }

    return date.toISOString().slice(0, DAY_KEY_LENGTH);
};

/* ---------------------------------------------------------------------------
 * One item
 * ------------------------------------------------------------------------- */

/**
 * One `grocery_items` row as the client reads it.
 *
 * Everything textual is a pass-through by design — see the header: re-rounding
 * a quantity or re-pluralising a count here would be a second formatting path
 * and the flag's "was" text is the first thing it would contradict. The only
 * work this function does is the `Decimal` conversion, which it performs once
 * and shares with the flag so the number the client reads and the number the
 * flag was measured against cannot diverge.
 */
export const toGroceryItem = (row: GroceryItemRow): GroceryItem => {
    const quantityGrams = decimalToNumber(row.quantity_grams, 'quantity_grams', row.id);
    const previousQuantityGrams =
        row.previous_quantity_grams === null
            ? null
            : decimalToNumber(row.previous_quantity_grams, 'previous_quantity_grams', row.id);

    return {
        id: row.id,
        catalogFoodId: row.catalog_food_id,
        foodState: row.food_state,
        name: row.name,
        quantityGrams,
        displayText: row.display_text,
        isChecked: row.is_checked,
        // null, never absent: the client renders the flagged row from this
        // object's presence, so an omitted key would read as "not flagged" only
        // by accident of `undefined`.
        flag: buildGroceryFlag(
            {
                quantity_grams: quantityGrams,
                previous_quantity_grams: previousQuantityGrams,
                display_quantity: row.display_quantity,
                display_unit: row.display_unit,
                display_text: row.display_text,
                flagged_at: row.flagged_at,
            },
            row.facts,
        ),
    };
};

/* ---------------------------------------------------------------------------
 * Ordering — from the rows, never from the query
 * ------------------------------------------------------------------------- */

/**
 * Position in the list: `sort_order`, then name, then id.
 *
 * `sort_order` is the entire order in normal operation — `grocery.logic.ts`
 * numbers every line from its final position after sorting by aisle and then by
 * name — so the other two keys only ever settle a tie. They are here because
 * `Array.prototype.sort` is stable, which means a tie would otherwise be
 * decided by the order Prisma happened to return the rows in and two loads of
 * one list would stop being byte-identical.
 *
 * `<` rather than `localeCompare`, deliberately: it is the comparison
 * `grocery.logic.ts` used to assign `sort_order` in the first place, so the
 * tiebreak agrees with the numbering instead of quietly disagreeing with it,
 * and it cannot shift with the server's locale.
 */
const byListPosition = (a: GroceryItemRow, b: GroceryItemRow): number => {
    if (a.sort_order !== b.sort_order) {
        return a.sort_order - b.sort_order;
    }

    if (a.name !== b.name) {
        return a.name < b.name ? -1 : 1;
    }

    if (a.id !== b.id) {
        return a.id < b.id ? -1 : 1;
    }

    return 0;
};

/** Sorts a COPY: a mapper never reorders the array its caller handed it. */
const sortRows = (rows: readonly GroceryItemRow[]): GroceryItemRow[] => [...rows].sort(byListPosition);

const isFlagged = (row: GroceryItemRow): boolean => row.flagged_at !== null;

/**
 * A row handed to `partitionGroceryList` purely to be grouped into its aisle.
 *
 * `is_checked` is forced false so the partition files the row by aisle instead
 * of into its checked bucket, and the ORIGINAL row travels alongside rather
 * than being spread into a copy: a copy carrying `is_checked: false` would map
 * to `isChecked: false` on the wire, which is the one thing a checked row must
 * not say.
 */
interface AisleGroupingView {
    row: GroceryItemRow;
    category: string;
    is_checked: boolean;
    sort_order: number;
}

/**
 * Rows in store order, grouped through the module that owns that order.
 *
 * `checkedItems` needs aisle order within each of its two groups, and going
 * back through `partitionGroceryList` is what keeps `pantry_other` closing the
 * list — and an unrecognised aisle code shopped rather than dropped — decided
 * in exactly one place instead of copied into a comparator here.
 */
const aisleOrderedRows = (rows: readonly GroceryItemRow[]): GroceryItemRow[] =>
    partitionGroceryList(
        rows.map(
            (row): AisleGroupingView => ({
                row,
                category: row.category,
                is_checked: false,
                sort_order: row.sort_order,
            }),
        ),
    ).sections.flatMap((section) => sortRows(section.items.map((view) => view.row)));

/* ---------------------------------------------------------------------------
 * The whole list
 * ------------------------------------------------------------------------- */

/**
 * The weekly list as frames 14 and 14b draw it.
 *
 * `totalCount` and `checkedCount` span the WHOLE list, checked and unchecked
 * alike, because the eyebrow reads "6 of 14 checked": a total that covered only
 * the visible sections would be wrong by exactly the number of items the
 * shopper has already put in the basket.
 *
 * `sections` carries the unchecked rows and `checkedItems` the checked ones,
 * flagged first. All three of `sections`, `checkedItems` and `banner` are always
 * present — arrays, and null for "nothing to announce" — because the client
 * reads each of them unconditionally.
 */
export const toGroceryListResponse = (
    plan: GroceryPlanRow,
    rows: readonly GroceryItemRow[],
    banner: GroceryBanner | null,
): GroceryListResponse => {
    const { sections, checkedItems } = partitionGroceryList(rows);

    const aisleSections: GrocerySection[] = sections.map((section) => ({
        category: section.category,
        items: sortRows(section.items).map(toGroceryItem),
    }));

    // Flagged first: frame 37:261 leads the Checked card with the flagged row,
    // so an amount that went up is read before the rows the shopper has already
    // settled. Store order applies inside each of the two groups.
    const checkedInReadingOrder: GroceryItem[] = [
        ...aisleOrderedRows(checkedItems.filter(isFlagged)),
        ...aisleOrderedRows(checkedItems.filter((row) => !isFlagged(row))),
    ].map(toGroceryItem);

    return {
        planId: plan.id,
        planRevision: plan.revision,
        startDate: toPlanDayKey(plan.start_date, 'start_date', plan.id),
        endDate: toPlanDayKey(plan.end_date, 'end_date', plan.id),
        totalCount: rows.length,
        checkedCount: checkedItems.length,
        banner,
        sections: aisleSections,
        checkedItems: checkedInReadingOrder,
    };
};

/* ---------------------------------------------------------------------------
 * What a swap changed
 * ------------------------------------------------------------------------- */

/**
 * The counts a swap reports beside its new meal and day.
 *
 * Taken from the diff's own verdicts, which is the only place they can be read
 * truthfully: `removed` counts every line the new plan no longer needs
 * INCLUDING one the shopper had already checked, and by the time the write has
 * been applied that line is gone from the stored rows — so a count re-derived
 * from the final list would report 0 removals for a swap that removed
 * something. `increased` is likewise a verdict: an update alone does not say
 * which direction the amount moved, since a decrease produces one too.
 *
 * Copied field by field into a fresh object rather than returning
 * `diff.summary` itself, for the two reasons the mapper boundary exists: the
 * annotation makes a drift between `GroceryDiffPlan` and the wire contract a
 * compile error here instead of a decode failure on the client, and no part of
 * the service's internal diff is aliased into a response body.
 */
export const toGroceryChangeSummary = (diff: GroceryDiffPlan): GroceryChangeSummary => ({
    added: diff.summary.added,
    removed: diff.summary.removed,
    increased: diff.summary.increased,
});
