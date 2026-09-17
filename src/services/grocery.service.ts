// The I/O half of the weekly grocery list: the three `/meal-planning/plans/
// :planId/groceries*` use cases — read the list, set one check mark, clear every
// check mark — plus the transaction-scoped building blocks the plan and swap
// services assemble their own writes from.
//
// Orchestration only (Rule backend-architecture §5). Every DECISION already
// belongs to a neighbour and is delegated to it, because a rule this file
// re-decided would be a rule no unit test could reach (§7, §11):
//
//  * `grocery.logic.ts` owns the rules — `buildGroceryRows` (aggregation,
//    naming, aisle, display), `diffGroceryList` (the epsilon, the acknowledged
//    baseline, the same-display exception, what a flag means), `applyToggle` /
//    `applyUncheckAll` (the four columns a check mark owns), `bannerFor` (a flag
//    outranks a swap notice) and `requireGroceryWritablePlan` (superseded versus
//    ended). Nothing below re-derives any of them, and nothing below decides
//    whether an amount "went up".
//  * `grocery.mapper.ts` owns the row -> DTO boundary, including the one
//    `Decimal` -> number conversion each response needs and the shape of the
//    list itself. No response object is assembled here by hand.
//  * `preferences.service.ts` owns the user's calendar: `resolveUserToday` is
//    the ONE definition of "today" in the user's stored IANA zone, and it is
//    imported rather than re-spelled so a plan cannot be writable on one code
//    path and ended on another.
//  * `mealPlanningAction.service.ts` owns the per-user advisory lock.
//
// WHY THE TWO WRITES CARRY NO KEY AND NO REVISION. A check mark is not a plan
// change (Agent Action Plan §0.5.1, "Grocery writes"). Both writes name the
// DESIRED state rather than asking for a flip, which makes them safely
// repeatable with no idempotency key, no `expectedPlanRevision` and no bump of
// `meal_plans.revision` — last write wins. They still take the per-user lock,
// because a swap rebuilds the whole list inside its own transaction and a toggle
// that interleaved with that rebuild could write a check mark onto a row the
// rebuild is deleting. That is also why nothing here reserves a ledger row:
// putting a non-idempotent, state-setting write into an exactly-once ledger
// would either lose the guarantee or pollute the ledger.
//
// WHY THE READ IS OPEN AND THE WRITES ARE NOT. `GET …/groceries` answers for a
// superseded or ended plan, so a client holding last week's plan can still show
// what it shopped for (§0.5.2 lists no `plan_not_active` for that route). Every
// WRITE path against such a plan answers `409 plan_not_active` —
// `requireGroceryWritablePlan` decides which half of that union applies, and
// this file only hands it the facts, including the id of the plan that
// superseded this one.
//
// WHAT THIS FILE DOES NOT DO, each for a stated reason:
//
//  * NO REQUEST VALIDATION. `parseGroceryListPath`, `parseGroceryItemPath` and
//    `parseToggleGroceryBody` are pure verdicts in `grocery.logic.ts` and are
//    called by the controller (§4). By the time a request reaches here its ids
//    are UUIDs and `isChecked` is a real boolean.
//  * NO HTTP. No `res`, no status codes: the two typed errors it raises —
//    `PlanNotFoundError` and (through the logic layer) `PlanNotActiveError` —
//    are mapped once, at the controller (§8).
//  * NO PLAN DECISIONS. This file reads a plan's meals — one owner-scoped
//    projection, `loadPlannedMealsForGroceries`, because it is the INPUT the
//    rules below consume and a caller supplying its own could omit an optional
//    ingredient or a food's state and silently shop for a different week — but
//    it knows nothing about how a week is searched or how a swap candidate is
//    chosen. `PlannedMealForGroceries` is the whole of what it understands
//    about a plan, which is what lets `mealPlan.service.ts` and
//    `swap.service.ts` reuse every building block below.
//  * NO REVISION WRITE. Neither `meal_plans.revision` nor
//    `meal_plan_meals.revision` is touched anywhere in this module.

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    GroceryChangeSummary,
    GroceryListResponse,
    ToggleGroceryItemPayload,
    ToggleGroceryItemResponse,
    UncheckAllGroceriesResponse,
} from '../types/mealPlanning';
import {
    GroceryCheckUpdate,
    GroceryConversionFacts,
    GroceryDataError,
    GroceryFoodFacts,
    GroceryPlanState,
    GroceryRowDraft,
    GroceryRowUpdate,
    GrocerySwapContext,
    PlannedMealForGroceries,
    StoredGroceryRow,
    applyToggle,
    applyUncheckAll,
    bannerFor,
    buildGroceryRows,
    diffGroceryList,
    requireGroceryWritablePlan,
} from './grocery.logic';
import { GroceryItemRow, toGroceryChangeSummary, toGroceryItem, toGroceryListResponse } from './grocery.mapper';
import { PlanNotFoundError } from './mealPlanning.errors';
import { withUserLock } from './mealPlanningAction.service';
import { resolveUserToday } from './preferences.service';
import { isMealSlot } from './recipe.logic';

/* ---------------------------------------------------------------------------
 * Columns, row shapes and the two column conventions
 * ------------------------------------------------------------------------- */

/**
 * Every `grocery_items` column this module reads, in one place.
 *
 * One selection serves all three reads — the list, the single row a toggle
 * touches, and the rows a diff is computed against — because the two consumers
 * need the same columns for different reasons: `StoredGroceryRow` (the rules)
 * and `GroceryItemRow` (the DTO) are the same column set viewed twice. A second
 * selection is how one of them would quietly stop carrying `flagged_at` and a
 * flag would disappear from a response without a single type error.
 *
 * `checked_at` is deliberately absent. It is written by both check-mark paths
 * and read by nothing: no wire field exposes it, and every rule that needs to
 * know what the user acknowledged reads `previous_quantity_grams` instead.
 */
const GROCERY_ROW_COLUMNS = {
    id: true,
    catalog_food_id: true,
    food_state: true,
    name: true,
    category: true,
    quantity_grams: true,
    display_quantity: true,
    display_unit: true,
    display_text: true,
    is_checked: true,
    previous_quantity_grams: true,
    flagged_at: true,
    sort_order: true,
} satisfies Prisma.grocery_itemsSelect;

/**
 * One selected `grocery_items` row, derived from the selection above rather than
 * re-declared, so adding a column to {@link GROCERY_ROW_COLUMNS} cannot leave a
 * hand-written interface behind (the convention `src/__tests__/setup/factories.ts`
 * already uses for its fixture payloads).
 */
type GroceryRowColumns = Prisma.grocery_itemsGetPayload<{ select: typeof GROCERY_ROW_COLUMNS }>;

/** Deterministic list order, from the rows' own stored fields. */
const GROCERY_ROW_ORDER: Prisma.grocery_itemsOrderByWithRelationInput[] = [
    { sort_order: 'asc' },
    { name: 'asc' },
    { id: 'asc' },
];

const DAY_KEY_LENGTH = 10;

/**
 * Separates the two halves of a local identity index key.
 *
 * `grocery.logic.ts` aggregates on the same `(catalog_food_id, food_state)`
 * identity and keys its own maps the same way, but its separator is private and
 * never crosses the boundary — the shapes it exchanges carry the two columns
 * separately. This key is therefore local by design: it exists only to look one
 * row up from another inside this module, and NUL cannot occur in a UUID or in a
 * `food_state` code.
 */
const IDENTITY_KEY_SEPARATOR = '\u0000';

const identityKeyOf = (row: { catalog_food_id: string; food_state: string }): string =>
    `${row.catalog_food_id}${IDENTITY_KEY_SEPARATOR}${row.food_state}`;

/**
 * A `NUMERIC(10,2)` amount as the plain number the pure rules take.
 *
 * `grocery.logic.ts` states this conversion is the service's job: a decimal
 * library type inside a rule would be a dependency the rule does not need. The
 * finiteness check is not ceremony — a non-finite quantity would silently
 * become an aggregation of `NaN` and flag or unflag every row downstream — and
 * it cannot fire on a row this module wrote, since the logic layer rounds to the
 * column's two decimals before any insert.
 */
const decimalGrams = (value: Prisma.Decimal, column: string, rowId: string): number => {
    const numeric = value.toNumber();

    if (!Number.isFinite(numeric)) {
        throw new GroceryDataError(
            `grocery_items.${column} on row ${rowId} does not convert to a finite number of grams ` +
                `(received ${value.toString()})`,
        );
    }

    return numeric;
};

/**
 * A `@db.Date` plan boundary as a `YYYY-MM-DD` day key.
 *
 * The UTC components and nothing else — the repository's `toDayKey` convention,
 * spelled the same way in `nutrition.service.ts` and `grocery.mapper.ts`: the
 * column stores a calendar day, Prisma returns it as midnight UTC, and reading
 * local components on a server west of UTC would move the plan's last day back
 * by one and end a plan a day early. It is repeated rather than imported for the
 * reason the mapper states — reaching into a mapper for one expression would
 * invert the layering — and an unparseable date is named rather than allowed to
 * surface as `toISOString`'s bare `RangeError`.
 */
const toPlanDayKey = (date: Date, column: string, planId: string): string => {
    if (!Number.isFinite(date.getTime())) {
        throw new GroceryDataError(`meal_plans.${column} on plan ${planId} is not a valid date`);
    }

    return date.toISOString().slice(0, DAY_KEY_LENGTH);
};

/* ---------------------------------------------------------------------------
 * Catalog facts — the one read without a tenant predicate
 * ------------------------------------------------------------------------- */

/**
 * The `catalog_foods` facts every shopping line needs, for the given ids.
 *
 * THE SANCTIONED EXCEPTION TO §5.1, documented the way `catalog.service.ts`
 * documents its own: Rule backend-architecture §5.1 requires `user_id` in every
 * `where`, and this read carries no tenant predicate because `catalog_foods`
 * and `catalog_food_portions` hold no `user_id` at all. The catalog is shared
 * reference data — the same foods for every user — so there is no owner to
 * scope to and no cross-user row to leak. The ids themselves always arrive from
 * a row or a plan that WAS owner-scoped, so no caller can turn this into an
 * enumeration of anything private.
 *
 * NO `publication_status` FILTER, also deliberately. A published recipe version
 * snapshots its ingredients at publication and `grocery_items.catalog_food_id`
 * is an ON DELETE RESTRICT reference, so a food that a newer release retired is
 * still on last week's plan — and a retired food must still be nameable and
 * convertible, or the shopper's list would lose a line it needs.
 *
 * Only the `is_default` portion is read: a partial unique index allows at most
 * one per food, and it is the only portion the display rule consults. A food
 * without one keeps `default_portion: null`, which the rules tolerate for a mass
 * row and reject for a count row — validation quarantines exactly that case, so
 * inventing a gram weight here would be inventing the number every quantity is
 * then computed from.
 *
 * `amount` IS PART OF THAT PROJECTION, not incidental to it. A volume row is
 * rendered through the density its portion states, and `grocery.logic.ts`'s
 * `volumeDensityFor` computes that as `gram_weight / (amount * ml per unit)` —
 * so a projection that read "107 g" and "cup" without the "0.5" would state
 * half the real density for every food whose portion is not one of its unit,
 * and the catalog ships thousands that are not.
 */
export const loadGroceryFoodFacts = async (
    catalogFoodIds: readonly string[],
    db: Prisma.TransactionClient = prisma,
): Promise<GroceryFoodFacts[]> => {
    const ids = [...new Set(catalogFoodIds)];

    if (ids.length === 0) {
        return [];
    }

    const foods = await db.catalog_foods.findMany({
        where: { id: { in: ids } },
        select: {
            id: true,
            display_name: true,
            category: true,
            food_state: true,
            density_g_per_ml: true,
            catalog_food_portions: {
                where: { is_default: true },
                select: { description: true, amount: true, unit: true, gram_weight: true },
            },
        },
    });

    return foods.map((food) => ({
        catalog_food_id: food.id,
        food_state: food.food_state,
        name: food.display_name,
        category: food.category,
        density_g_per_ml: food.density_g_per_ml,
        default_portion: food.catalog_food_portions[0] ?? null,
    }));
};

/**
 * The conversion facts of a set of foods, keyed by food id.
 *
 * BY FOOD ID, not by the `(catalog_food_id, food_state)` identity the rows are
 * aggregated on: a density and a default portion are properties of the FOOD,
 * and nothing about rendering an amount depends on the row's state. Keying by
 * the id alone is what keeps a stored row renderable if a release load ever
 * moves a food's `food_state` — the row would no longer match on identity, and
 * failing to render a whole list over a metadata change nobody shopped for
 * would be the wrong outcome. The ids are deduplicated on the way in, so one
 * food contributes exactly one entry.
 */
const conversionFactsByFoodId = (facts: readonly GroceryFoodFacts[]): Map<string, GroceryConversionFacts> =>
    new Map(facts.map((fact) => [fact.catalog_food_id, fact] as const));

/**
 * The facts of one stored row's food, or a reported fault.
 *
 * Unreachable in a consistent database — `catalog_food_id` is an ON DELETE
 * RESTRICT foreign key, so the food a row points at cannot go missing — which
 * is exactly why it is reported rather than defaulted. `grocery.mapper.ts`
 * requires the facts for every row because a flagged row renders "was Y"
 * through them, and a fabricated density or portion would make that string
 * describe an amount nothing measured.
 */
const requireFactsFor = (
    facts: ReadonlyMap<string, GroceryConversionFacts>,
    row: GroceryRowColumns,
): GroceryConversionFacts => {
    const fact = facts.get(row.catalog_food_id);

    if (fact === undefined) {
        throw new GroceryDataError(
            `No catalog facts for grocery row ${row.id} (${row.catalog_food_id}, ${row.food_state}); ` +
                'its amount cannot be rendered without them',
        );
    }

    return fact;
};

/* ---------------------------------------------------------------------------
 * Stored rows
 * ------------------------------------------------------------------------- */

/**
 * A plan's stored list, in the shape the pure rules take.
 *
 * Takes the client FIRST, breaking §5's `userId`-first convention exactly as
 * `nutrition.service.ts::insertPlannedMealEntry` does and for the same reason:
 * this is a transaction-scoped building block whose callers — a swap's commit,
 * a regeneration — have already taken the per-user advisory lock, and the client
 * is what binds the read to that lock. `userId` is still in the `where`
 * alongside `meal_plan_id` (§5.1): the pair is the referencing side of the
 * tenant foreign key, so one user's plan id can never address another's rows.
 */
export const loadStoredGroceryRows = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
): Promise<StoredGroceryRow[]> => {
    const rows = await db.grocery_items.findMany({
        where: { meal_plan_id: planId, user_id: userId },
        select: GROCERY_ROW_COLUMNS,
        orderBy: GROCERY_ROW_ORDER,
    });

    return rows.map((row) => ({
        id: row.id,
        catalog_food_id: row.catalog_food_id,
        food_state: row.food_state,
        name: row.name,
        category: row.category,
        quantity_grams: decimalGrams(row.quantity_grams, 'quantity_grams', row.id),
        display_quantity: row.display_quantity,
        display_unit: row.display_unit,
        display_text: row.display_text,
        is_checked: row.is_checked,
        previous_quantity_grams:
            row.previous_quantity_grams === null
                ? null
                : decimalGrams(row.previous_quantity_grams, 'previous_quantity_grams', row.id),
        flagged_at: row.flagged_at,
        sort_order: row.sort_order,
    }));
};

/**
 * One selected row as the DTO boundary takes it.
 *
 * `checkState` is how a check-mark write answers with the row it just wrote
 * instead of reading it back: `applyToggle` returns precisely the columns that
 * changed, so overlaying them on the row that was read under the lock describes
 * the stored state exactly, one round trip cheaper inside a transaction that is
 * holding a user's lock. The list read passes `null` and maps the row as stored.
 */
const toGroceryItemRow = (
    row: GroceryRowColumns,
    facts: GroceryConversionFacts,
    checkState: GroceryCheckUpdate | null,
): GroceryItemRow => ({
    id: row.id,
    catalog_food_id: row.catalog_food_id,
    food_state: row.food_state,
    name: row.name,
    category: row.category,
    quantity_grams: row.quantity_grams,
    display_quantity: row.display_quantity,
    display_unit: row.display_unit,
    display_text: row.display_text,
    is_checked: checkState === null ? row.is_checked : checkState.is_checked,
    previous_quantity_grams: checkState === null ? row.previous_quantity_grams : checkState.previous_quantity_grams,
    flagged_at: checkState === null ? row.flagged_at : checkState.flagged_at,
    sort_order: row.sort_order,
    facts,
});

/* ---------------------------------------------------------------------------
 * Drafts — a week of planned meals as shopping lines
 * ------------------------------------------------------------------------- */

/**
 * A plan's meals as the grocery rules consume them.
 *
 * The projection `grocery.logic.ts::PlannedMealForGroceries` declares and
 * nothing more: the yield the ingredient gram weights are stated per, the slot's
 * portion multiplier, and each ingredient's `(catalog_food_id, food_state,
 * gram_weight)`. `food_state` is joined from `catalog_foods` because it is the
 * FOOD's property and half of the aggregation identity — raw, dry and cooked
 * amounts of one food must never merge into one shopping line — while
 * `gram_weight` is the recipe's.
 *
 * OPTIONAL INGREDIENTS ARE INCLUDED. They are part of the recipe's nutrition
 * (`recipe.logic.ts` sums every ingredient) and of its allergen derivation, so
 * omitting them from the list would hand the user a week whose shopping does not
 * make the meals the plan promises.
 *
 * THE ONE PROJECTION OF A PLAN'S MEALS INTO SHOPPING INPUT, and it lives beside
 * the rules that consume it: {@link buildPlanGroceryDrafts} and
 * {@link rebuildPlanGroceries} are this module's, and both of their callers —
 * the plan service when it publishes or regenerates a week, and
 * `swap.service.ts` when it reconciles the list after a commit — need the
 * meals AFTER their own write. Reading them here is what keeps the list one
 * feature: a caller supplying its own projection could omit optional
 * ingredients or a food's state and silently shop for a different week.
 *
 * Ordered by day then slot so the aggregation walks the week in plan order — the
 * sum is float addition, which is not associative, and a stable order is what
 * keeps two reads of one plan producing the same grams.
 */
export const loadPlannedMealsForGroceries = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
): Promise<PlannedMealForGroceries[]> => {
    const meals = await db.meal_plan_meals.findMany({
        where: { meal_plan_id: planId, user_id: userId },
        select: {
            portion_multiplier: true,
            recipe_versions: {
                select: {
                    yield_servings: true,
                    recipe_ingredients: {
                        select: {
                            catalog_food_id: true,
                            gram_weight: true,
                            catalog_foods: { select: { food_state: true } },
                        },
                        orderBy: [{ sort_order: 'asc' }, { catalog_food_id: 'asc' }],
                    },
                },
            },
        },
        orderBy: [{ meal_plan_days: { date: 'asc' } }, { sort_order: 'asc' }, { id: 'asc' }],
    });

    return meals.map((meal) => ({
        yield_servings: meal.recipe_versions.yield_servings,
        portion_multiplier: meal.portion_multiplier,
        ingredients: meal.recipe_versions.recipe_ingredients.map((ingredient) => ({
            catalog_food_id: ingredient.catalog_food_id,
            food_state: ingredient.catalog_foods.food_state,
            gram_weight: ingredient.gram_weight,
        })),
    }));
};

/**
 * The catalog facts a set of planned meals needs, loaded once.
 *
 * Shared by {@link buildPlanGroceryDrafts} and {@link rebuildPlanGroceries}
 * because the diff needs the SAME facts the drafts were built from: loading them
 * twice inside one transaction would be two round trips and, in principle, two
 * different answers if a release load committed between them.
 */
const loadFactsForMeals = async (
    db: Prisma.TransactionClient,
    meals: readonly PlannedMealForGroceries[],
): Promise<GroceryFoodFacts[]> =>
    loadGroceryFoodFacts(
        meals.flatMap((meal) => meal.ingredients.map((ingredient) => ingredient.catalog_food_id)),
        db,
    );

/**
 * The shopping lines a set of planned meals implies — aggregated, named, filed
 * in an aisle, rendered and numbered.
 *
 * Every one of those decisions is `buildGroceryRows`'s; this function exists to
 * supply it with the catalog facts of the ingredients actually planned. A plan
 * with no meals, or meals with no ingredients, yields no drafts and issues no
 * query at all.
 */
export const buildPlanGroceryDrafts = async (
    db: Prisma.TransactionClient,
    meals: readonly PlannedMealForGroceries[],
): Promise<GroceryRowDraft[]> => buildGroceryRows(meals, await loadFactsForMeals(db, meals));

/* ---------------------------------------------------------------------------
 * Publishing a plan's rows, and carrying check state across a regeneration
 * ------------------------------------------------------------------------- */

/** What {@link writePlanGroceryRows} needs to insert a plan's list. */
export interface PlanGroceryWriteParams {
    readonly userId: string;
    readonly planId: string;
    readonly drafts: readonly GroceryRowDraft[];
    /**
     * The OLD plan's stored rows, on a regeneration.
     *
     * The new plan has no rows of its own yet, so the check state a regeneration
     * preserves (Agent Action Plan §0.5.1, "copies grocery check state for
     * unchanged items") can only come from the plan being replaced. Absent on a
     * first publication, where every line starts unchecked.
     */
    readonly carryOverFrom?: readonly StoredGroceryRow[];
    readonly now?: Date;
}

/** How many rows the insert created. */
export interface PlanGroceryWriteResult {
    readonly insertedCount: number;
}

/**
 * The four check-mark columns a new row is created with.
 *
 * Deliberately NOT `GroceryCheckUpdate`: that shape types `flagged_at` as `null`
 * because interacting with a row always clears the flag, while a row created by
 * a regeneration may be born already flagged — an amount that went up on
 * something the shopper had checked is the one case where a flag must survive
 * the plan it was raised on.
 */
interface CarriedCheckState {
    readonly is_checked: boolean;
    readonly checked_at: Date | null;
    readonly previous_quantity_grams: number | null;
    readonly flagged_at: Date | null;
}

/** A line nobody has shopped for yet: the state every first publication writes. */
const UNCHECKED_NEW_ROW: CarriedCheckState = {
    is_checked: false,
    checked_at: null,
    previous_quantity_grams: null,
    flagged_at: null,
};

/**
 * The check state each `(catalog_food_id, food_state)` identity of the new plan
 * inherits from the plan being replaced, keyed by that identity.
 *
 * ROUTED THROUGH `diffGroceryList`, WHICH IS THE POINT. A regeneration asks the
 * same question a swap asks — "given what this shopper last acknowledged, does
 * the new amount keep the check, and does it raise a flag?" — and the answer
 * carries four rules that are easy to get subtly wrong: the half-gram epsilon,
 * the acknowledged baseline that must NOT drift to an intermediate amount, the
 * same-display exception (2.51 -> 2.53 lb updates the grams and does not flag),
 * and the unit-family lock that renders the comparison in the family the row was
 * created in. Re-assembling that here from the primitives would be a second copy
 * of all four, and the copy that drifts is the one that starts lying to the
 * shopper. So the diff decides, and this function only reads its verdicts:
 *
 *  - an identity WITH an update inherits that update's `previous_quantity_grams`
 *    and `flagged_at`;
 *  - an identity the diff reported UNCHANGED inherits the old row's own two
 *    values, which is what "no write needed" means;
 *  - `is_checked` comes from the old row, because the diff deliberately never
 *    touches it — recomputing a week is not a statement about what the user has
 *    already put in the basket.
 *
 * THE IDS IN THAT DIFF BELONG TO THE OLD PLAN. They are used here as lookup keys
 * and nothing else; the new plan's rows are inserts, and no write in this module
 * ever targets a `GroceryRowUpdate.id` that came from a `carryOverFrom` row.
 *
 * `checked_at` records when THIS row's check was set, which is the regeneration
 * instant: the column is audit-only (no wire field reads it) and
 * `StoredGroceryRow` does not carry it, so the old row's value is not available
 * to copy. Nothing is lost, because the value the flag actually needs — the
 * amount the user acknowledged — travels in `previous_quantity_grams`.
 */
const resolveCarriedCheckState = async (
    tx: Prisma.TransactionClient,
    params: PlanGroceryWriteParams,
    now: Date,
): Promise<Map<string, CarriedCheckState>> => {
    const carried = new Map<string, CarriedCheckState>();
    const carryOverFrom = params.carryOverFrom ?? [];

    if (carryOverFrom.length === 0) {
        return carried;
    }

    const facts = await loadGroceryFoodFacts(
        params.drafts.map((draft) => draft.catalog_food_id),
        tx,
    );
    const diff = diffGroceryList(carryOverFrom, params.drafts, facts, now);
    const decidedByPreviousId = new Map(diff.updates.map((update) => [update.id, update] as const));

    for (const previous of carryOverFrom) {
        const decided = decidedByPreviousId.get(previous.id);

        carried.set(identityKeyOf(previous), {
            is_checked: previous.is_checked,
            checked_at: previous.is_checked ? now : null,
            previous_quantity_grams: decided ? decided.previous_quantity_grams : previous.previous_quantity_grams,
            flagged_at: decided ? decided.flagged_at : previous.flagged_at,
        });
    }

    return carried;
};

/**
 * Inserts a plan's shopping lines, carrying check state over from the plan it
 * replaces when there is one.
 *
 * One `createMany`, every row carrying both `meal_plan_id` and `user_id`: the
 * pair is the referencing side of the tenant foreign key, so a row is
 * structurally unable to belong to a plan of a different user (§5.1). It is also
 * the insert path for a diff's new lines, so "a new identity arrives unchecked"
 * is decided in exactly one place.
 *
 * An empty draft list writes nothing and reports zero — a plan that needs no
 * ingredients is an empty list, not a failure, and `createMany` is not called
 * with an empty payload.
 */
export const writePlanGroceryRows = async (
    tx: Prisma.TransactionClient,
    params: PlanGroceryWriteParams,
): Promise<PlanGroceryWriteResult> => {
    if (params.drafts.length === 0) {
        return { insertedCount: 0 };
    }

    const now = params.now ?? new Date();
    const carried = await resolveCarriedCheckState(tx, params, now);

    const inserted = await tx.grocery_items.createMany({
        data: params.drafts.map((draft) => {
            const checkState = carried.get(identityKeyOf(draft)) ?? UNCHECKED_NEW_ROW;

            return {
                meal_plan_id: params.planId,
                user_id: params.userId,
                catalog_food_id: draft.catalog_food_id,
                food_state: draft.food_state,
                category: draft.category,
                name: draft.name,
                quantity_grams: draft.quantity_grams,
                display_quantity: draft.display_quantity,
                display_unit: draft.display_unit,
                display_text: draft.display_text,
                is_checked: checkState.is_checked,
                checked_at: checkState.checked_at,
                previous_quantity_grams: checkState.previous_quantity_grams,
                flagged_at: checkState.flagged_at,
                sort_order: draft.sort_order,
            };
        }),
    });

    return { insertedCount: inserted.count };
};

/* ---------------------------------------------------------------------------
 * Same-plan reconciliation — what a swap applies
 * ------------------------------------------------------------------------- */

/** What {@link rebuildPlanGroceries} needs to reconcile a plan's list. */
export interface PlanGroceryRebuildParams {
    readonly userId: string;
    readonly planId: string;
    /** The plan's meals AFTER the change, which is the list the week now implies. */
    readonly meals: readonly PlannedMealForGroceries[];
    /**
     * Required rather than defaulted: the instant a flag is raised at belongs to
     * the transaction that raised it, and a swap already has that instant for
     * its own writes. Two clocks inside one commit is how `flagged_at` starts
     * disagreeing with the action that caused it.
     */
    readonly now: Date;
}

/**
 * How many characters of an ISO-8601 instant are the `TIMESTAMP(3)` wall time:
 * `YYYY-MM-DDTHH:mm:ss.mmm`, the zone designator excluded.
 */
const ISO_WALL_TIME_LENGTH = 23;

/**
 * One changed row as a `VALUES` tuple, every column explicitly cast.
 *
 * THE CASTS ARE LOAD-BEARING, NOT DECORATION. PostgreSQL infers a `VALUES`
 * list's row type from its FIRST row, and two of these columns are nullable
 * (`previous_quantity_grams`, `flagged_at`) — so a diff whose first update
 * carries `NULL` in either would leave the column typed `text` (the type an
 * untyped parameter falls back to) and the UPDATE would fail on the assignment
 * to a `numeric`/`timestamp` column. Casting every column of every row makes the
 * row type a property of this statement rather than of the diff's ordering, and
 * pins each value to the column it lands in: `numeric(10,2)` for the two gram
 * amounts, `double precision` for `display_quantity`, `integer` for
 * `sort_order`, `uuid` for the row id, `text` for the four string columns.
 *
 * `flagged_at` IS `timestamp(3)` WITHOUT TIME ZONE, AND IS BOUND AS ONE.
 * Prisma stores UTC wall time in such a column, so the instant travels as its
 * ISO-8601 wall time with the zone designator dropped
 * (`2026-09-16T16:58:57.708`) and is cast `::timestamp(3)`. `::timestamptz`
 * would be wrong rather than merely different: converting a `timestamptz` to
 * `timestamp` applies the SESSION's `TimeZone`, so the same diff would store a
 * different instant on a server whose session zone is not UTC, and a flag would
 * start disagreeing with the swap that raised it.
 *
 * An unusable instant is named rather than allowed to surface as
 * `toISOString`'s bare `RangeError`, the same way {@link decimalGrams} names a
 * non-finite amount: it cannot occur on a value this module produced (the diff
 * raises a flag at the caller's `now` or carries a stored timestamp forward),
 * which is exactly why it is reported if it ever does.
 */
const groceryUpdateValues = (update: GroceryRowUpdate): Prisma.Sql => {
    if (update.flagged_at !== null && !Number.isFinite(update.flagged_at.getTime())) {
        throw new GroceryDataError(
            `The flag instant decided for grocery row ${update.id} is not a valid date, so the row cannot be written`,
        );
    }

    const flaggedAt =
        update.flagged_at === null ? null : update.flagged_at.toISOString().slice(0, ISO_WALL_TIME_LENGTH);

    return Prisma.sql`(
        ${update.id}::uuid,
        ${update.name}::text,
        ${update.category}::text,
        ${update.quantity_grams}::numeric(10,2),
        ${update.display_quantity}::double precision,
        ${update.display_unit}::text,
        ${update.display_text}::text,
        ${update.sort_order}::integer,
        ${update.previous_quantity_grams}::numeric(10,2),
        ${flaggedAt}::timestamp(3)
    )`;
};

/**
 * Applies every changed row of one diff in a SINGLE statement.
 *
 * ONE `UPDATE … FROM (VALUES …)` RATHER THAN ONE STATEMENT PER ROW, and the
 * reason is the lock this runs under. A swap's or a regeneration's commit holds
 * the per-user advisory lock for the whole of its interactive transaction, so
 * every statement issued inside it is time another writer of this user's plan
 * spends waiting; a weekly swap can move most of the week's distinct
 * ingredients, so a per-row write made both the statement count and the lock's
 * duration grow with the size of the shopping list. Set-based, the cost is one
 * round trip whatever the diff's size, which is what the no-per-item-query
 * requirement asks for (Agent Action Plan §0.7.3).
 *
 * THE `VALUES` LIST IS BUILT IN THE DIFF'S ORDER, so a transaction that replays
 * issues the identical statement with the identical parameters every time —
 * the determinism the per-row loop got from its ordering, kept without its
 * round trips. Row order inside one statement has no effect on the outcome
 * (each tuple addresses one row by primary key), so this is about reproducing
 * the statement, not about the result.
 *
 * The predicate carries `{meal_plan_id, user_id}` beside the join on the row id
 * (§5.1): the pair is the referencing side of the tenant foreign key, so one
 * user's plan id cannot address another's rows — the same predicate the per-row
 * writes carried, expressed once. Every value is a bind parameter; nothing is
 * interpolated as SQL text.
 *
 * NOTHING IS ISSUED FOR AN EMPTY DIFF. A swap that moved no surviving line —
 * the common case for a change confined to new and removed lines — performs no
 * statement at all, and `Prisma.join` is never handed an empty list (which
 * would produce `VALUES ()`, a syntax error).
 *
 * The affected-row count is checked ONCE, against the number of rows the diff
 * decided, and the failure keeps the semantics the per-row check had: these rows
 * were read under the per-user lock, so a miscount means an invariant this
 * module depends on is broken rather than a conflict a client could act on, and
 * it is therefore an untyped `Error` reaching the controller as a 500 (§8).
 */
const applyGroceryRowUpdates = async (
    tx: Prisma.TransactionClient,
    params: PlanGroceryRebuildParams,
    updates: readonly GroceryRowUpdate[],
): Promise<void> => {
    if (updates.length === 0) {
        return;
    }

    const written = await tx.$executeRaw(Prisma.sql`
        UPDATE grocery_items AS g
        SET name = v.name,
            category = v.category,
            quantity_grams = v.quantity_grams,
            display_quantity = v.display_quantity,
            display_unit = v.display_unit,
            display_text = v.display_text,
            sort_order = v.sort_order,
            previous_quantity_grams = v.previous_quantity_grams,
            flagged_at = v.flagged_at
        FROM (VALUES ${Prisma.join(updates.map(groceryUpdateValues))}) AS v (
            id,
            name,
            category,
            quantity_grams,
            display_quantity,
            display_unit,
            display_text,
            sort_order,
            previous_quantity_grams,
            flagged_at
        )
        WHERE g.id = v.id
            AND g.meal_plan_id = ${params.planId}::uuid
            AND g.user_id = ${params.userId}
    `);

    if (written !== updates.length) {
        throw new Error(
            `Updating the grocery rows of plan ${params.planId} wrote ${String(written)} rows instead of ` +
                `${String(updates.length)}. Every one of them was read under the per-user lock, so none of ` +
                'them can have moved.',
        );
    }
};

/**
 * Brings a plan's stored list in line with its current meals, and reports what
 * changed.
 *
 * The reconciliation a swap performs inside its own commit: aggregate the week
 * again, diff it against what is stored, then apply exactly the writes the diff
 * asked for — removals, then the surviving rows' updates, then the new lines —
 * and touch nothing for `unchangedItemIds`, which is what keeps a checked row
 * the user is reading byte-identical when a swap elsewhere in the week did not
 * move its amount.
 *
 * CORRECT FOR AN EMPTY STORED LIST, which is not a special case but the one a
 * brand-new plan's publication uses: with nothing stored, every draft is an
 * insert and the summary reports `added` alone.
 *
 * Each write carries `{meal_plan_id, user_id}` beside the row id (§5.1) and the
 * affected-row count is CHECKED rather than assumed: the rows were read under
 * the caller's per-user lock, so a row that has vanished between the read and
 * the write means an invariant this module depends on is broken, and reporting a
 * change summary for a write that did not happen would be worse than failing.
 * That fault is an untyped `Error`, exactly as `mealPlanningAction.service.ts`
 * raises for its own broken invariants: it describes a state no client can act
 * on, so it joins no error vocabulary and reaches the controller as a 500.
 *
 * THE WHOLE RECONCILIATION IS THREE STATEMENTS AT MOST, WHATEVER THE LIST'S
 * SIZE, because every one of them runs inside the caller's transaction while its
 * per-user advisory lock is held: one batched `deleteMany` for the removals, one
 * set-based `UPDATE … FROM (VALUES …)` for every changed row
 * ({@link applyGroceryRowUpdates}), one `createMany` for the new lines. None of
 * the three is issued when its half of the diff is empty. A per-row write would
 * make the statement count — and the time every other writer of this user's plan
 * spends queued behind the lock — grow with the number of distinct ingredients
 * the week plans, which §0.7.3's no-per-item-query requirement forbids; each
 * statement here is instead built from the diff in the diff's order, so a
 * transaction that replays issues exactly the same statements with exactly the
 * same parameters.
 */
export const rebuildPlanGroceries = async (
    tx: Prisma.TransactionClient,
    params: PlanGroceryRebuildParams,
): Promise<GroceryChangeSummary> => {
    const facts = await loadFactsForMeals(tx, params.meals);
    const drafts = buildGroceryRows(params.meals, facts);
    const existing = await loadStoredGroceryRows(tx, params.userId, params.planId);
    const diff = diffGroceryList(existing, drafts, facts, params.now);

    if (diff.removals.length > 0) {
        const removed = await tx.grocery_items.deleteMany({
            where: {
                id: { in: diff.removals.map((removal) => removal.id) },
                meal_plan_id: params.planId,
                user_id: params.userId,
            },
        });

        if (removed.count !== diff.removals.length) {
            throw new Error(
                `Removing grocery rows of plan ${params.planId} deleted ${String(removed.count)} rows instead ` +
                    `of ${String(diff.removals.length)}. The list changed under the per-user lock, so the ` +
                    'change summary cannot be reported truthfully.',
            );
        }
    }

    await applyGroceryRowUpdates(tx, params, diff.updates);

    await writePlanGroceryRows(tx, {
        userId: params.userId,
        planId: params.planId,
        drafts: diff.inserts,
        now: params.now,
    });

    return toGroceryChangeSummary(diff);
};

/* ---------------------------------------------------------------------------
 * Reading the list, and the banner's swap context
 * ------------------------------------------------------------------------- */

/** The one `meal_plan_actions.action_type` whose response can change a list. */
const SWAP_ACTION_TYPE = 'swap';

const isJsonRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const isFiniteCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * The banner's swap context, read out of a stored `SwapMealResponse`.
 *
 * `response_snapshot` is a `jsonb` column, so it arrives as `unknown` and every
 * member is checked before it is believed: a row written by an earlier release,
 * or by anything other than the swap path, must read as "no swap context"
 * instead of as a confidently asserted shape that then renders a banner naming a
 * slot nothing swapped. `isMealSlot` is `recipe.logic.ts`'s guard over the same
 * closed set the wire contract declares, so the slot is never widened here.
 *
 * `changedList` is the swap's OWN report of what it did — `added + removed +
 * increased` from the summary it persisted — and not a guess. A swap that moved
 * no quantity at all (a candidate with the same ingredients at the same portion)
 * announces nothing, because there is nothing for the shopper to re-check.
 */
const readSwapContext = (snapshot: unknown): GrocerySwapContext | null => {
    if (!isJsonRecord(snapshot)) {
        return null;
    }

    const meal = snapshot.meal;
    const summary = snapshot.groceryChangeSummary;

    if (!isJsonRecord(meal) || !isJsonRecord(summary) || !isMealSlot(meal.slot)) {
        return null;
    }

    const { added, removed, increased } = summary;

    if (!isFiniteCount(added) || !isFiniteCount(removed) || !isFiniteCount(increased)) {
        return null;
    }

    return { mealSlot: meal.slot, changedList: added + removed + increased > 0 };
};

/**
 * The last COMPLETED swap of this plan, from the keyed-write ledger.
 *
 * The ledger is the only truthful source for "did a swap change this list, and
 * which slot was it?": the grocery rows themselves record amounts, not causes,
 * and `meal_plan_meals.swapped_at` records that a meal was swapped without
 * recording whether the shop moved. A reserved-but-pending row is excluded by
 * `response_status: { not: null }` — a swap still inside its own transaction has
 * not changed anything yet, and its rebuild is part of the same commit.
 *
 * `created_at desc` with the primary key as a tiebreaker, so two swaps sharing a
 * timestamp still resolve to one deterministic answer rather than to whichever
 * row the planner happened to return first.
 *
 * Bounded by the caller's reference instant, which is the only role `now` plays
 * in this read: the response then describes the list as of that instant and is
 * reproducible under a fixed clock, and a clock-skewed future-dated row can
 * never announce a swap the caller's own read did not see.
 */
const loadLastSwapContext = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    now: Date,
): Promise<GrocerySwapContext | null> => {
    const action = await db.meal_plan_actions.findFirst({
        where: {
            user_id: userId,
            meal_plan_id: planId,
            action_type: SWAP_ACTION_TYPE,
            response_status: { not: null },
            created_at: { lte: now },
        },
        orderBy: [{ created_at: 'desc' }, { id: 'desc' }],
        select: { response_snapshot: true },
    });

    return action === null ? null : readSwapContext(action.response_snapshot);
};

/**
 * `GET /api/meal-planning/plans/:planId/groceries` — the whole weekly list.
 *
 * Available for a superseded or an ended plan, deliberately: a client holding
 * last week's plan can still read what it shopped for, and §0.5.2 declares no
 * `plan_not_active` for this route. A plan that is absent or not the caller's is
 * the same answer — `PlanNotFoundError`, which the controller maps to 404 —
 * because "no such plan" and "not your plan" must be indistinguishable (§8).
 *
 * The banner is DERIVED, never guessed: `bannerFor` weighs the rows' own flags
 * against the last swap's stored report and already encodes that a flagged row
 * outranks a swap notice. `db` accepts an open transaction so a caller that has
 * just rebuilt the list under its own lock reads back the state it wrote.
 */
export const getGroceryList = async (
    userId: string,
    planId: string,
    now: Date = new Date(),
    db: Prisma.TransactionClient = prisma,
): Promise<GroceryListResponse> => {
    const plan = await db.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: { id: true, revision: true, start_date: true, end_date: true },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    const rows = await db.grocery_items.findMany({
        where: { meal_plan_id: planId, user_id: userId },
        select: GROCERY_ROW_COLUMNS,
        orderBy: GROCERY_ROW_ORDER,
    });

    const facts = conversionFactsByFoodId(
        await loadGroceryFoodFacts(
            rows.map((row) => row.catalog_food_id),
            db,
        ),
    );
    const lastSwap = await loadLastSwapContext(db, userId, planId, now);

    return toGroceryListResponse(
        plan,
        rows.map((row) => toGroceryItemRow(row, requireFactsFor(facts, row), null)),
        bannerFor(rows, lastSwap),
    );
};

/* ---------------------------------------------------------------------------
 * The two check-mark writes
 * ------------------------------------------------------------------------- */

/**
 * The plan facts `requireGroceryWritablePlan` judges a grocery write against.
 *
 * `replacement_plan_id` is resolved here rather than inside the rule because it
 * is a read: the plan that superseded this one is the one whose
 * `replaced_plan_id` points back at it, and the successor is scoped by
 * `user_id` as well (§5.1), so a superseded plan can only ever report a
 * replacement of the same user. The newest successor wins — a plan replaced and
 * then replaced again should send a stale screen to the CURRENT week, not to an
 * intermediate one.
 *
 * The successor is looked up unconditionally rather than only for a non-active
 * plan: which status makes a plan unwritable is `requireGroceryWritablePlan`'s
 * rule, and a loader that branched on `status` to save a read would own half of
 * that rule.
 */
const loadGroceryPlanState = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
): Promise<GroceryPlanState | null> => {
    const plan = await db.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: {
            id: true,
            status: true,
            end_date: true,
            replaced_by_plans: {
                where: { user_id: userId },
                orderBy: [{ published_at: 'desc' }, { id: 'desc' }],
                take: 1,
                select: { id: true },
            },
        },
    });

    if (plan === null) {
        return null;
    }

    return {
        id: plan.id,
        status: plan.status,
        end_date: toPlanDayKey(plan.end_date, 'end_date', plan.id),
        replacement_plan_id: plan.replaced_by_plans[0]?.id ?? null,
    };
};

/**
 * The preamble both check-mark writes share: ONE interactive transaction, the
 * per-user advisory lock as its first statement, then the writability check.
 *
 * The order is the guarantee. The lock is taken before anything is read, so a
 * toggle cannot interleave with the rebuild a swap performs under the same lock
 * — otherwise a check mark could land on a row that rebuild is deleting, or be
 * read back from a list that has since changed underneath it. "Today" is then
 * resolved inside the lock, against the same snapshot the write will commit in,
 * so an `end_date` comparison cannot be decided by a preferences row that
 * changed a statement later.
 *
 * No ledger row is reserved and no revision is bumped: see the module header.
 */
const withWritableGroceryPlan = async <TResult>(
    userId: string,
    planId: string,
    now: Date,
    work: (tx: Prisma.TransactionClient) => Promise<TResult>,
): Promise<TResult> =>
    prisma.$transaction((tx) =>
        withUserLock(tx, userId, async (lockedTx) => {
            const today = await resolveUserToday(userId, now, lockedTx);

            requireGroceryWritablePlan(await loadGroceryPlanState(lockedTx, userId, planId), today);

            return work(lockedTx);
        }),
    );

/**
 * `PUT /api/meal-planning/plans/:planId/groceries/:itemId` — set one row's check
 * mark to the state the request names.
 *
 * The item's `where` carries `{id, meal_plan_id, user_id}` in ONE predicate,
 * both to read it and to write it — never an ownership read followed by an
 * id-only update (§5.1) — and a miss is `PlanNotFoundError`, the same answer an
 * unknown plan gets, so a caller cannot probe another user's item ids.
 *
 * `applyToggle` owns what changes: it clears the flag and resets the
 * acknowledged baseline in BOTH directions, because either way the user has just
 * seen the amount the row is showing. Nothing is added to that here.
 *
 * `checkedCount` is counted from the rows rather than adjusted arithmetically:
 * it is the number the eyebrow renders ("6 of 14 checked"), and a client that
 * retried a toggle it had already applied would otherwise be handed a count that
 * drifted by one.
 */
export const toggleGroceryItem = async (
    userId: string,
    planId: string,
    itemId: string,
    payload: ToggleGroceryItemPayload,
    now: Date = new Date(),
): Promise<ToggleGroceryItemResponse> =>
    withWritableGroceryPlan(userId, planId, now, async (tx) => {
        const row = await tx.grocery_items.findFirst({
            where: { id: itemId, meal_plan_id: planId, user_id: userId },
            select: GROCERY_ROW_COLUMNS,
        });

        if (row === null) {
            throw new PlanNotFoundError();
        }

        const checkState = applyToggle(
            { quantity_grams: decimalGrams(row.quantity_grams, 'quantity_grams', row.id) },
            payload.isChecked,
            now,
        );

        const written = await tx.grocery_items.updateMany({
            where: { id: itemId, meal_plan_id: planId, user_id: userId },
            data: checkState,
        });

        if (written.count !== 1) {
            throw new Error(
                `Toggling grocery row ${itemId} of plan ${planId} wrote ${String(written.count)} rows instead ` +
                    'of 1. The row was read under the per-user lock, so it cannot have moved.',
            );
        }

        const facts = conversionFactsByFoodId(await loadGroceryFoodFacts([row.catalog_food_id], tx));
        const checkedCount = await tx.grocery_items.count({
            where: { meal_plan_id: planId, user_id: userId, is_checked: true },
        });

        return {
            item: toGroceryItem(toGroceryItemRow(row, requireFactsFor(facts, row), checkState)),
            checkedCount,
        };
    });

/**
 * `POST /api/meal-planning/plans/:planId/groceries/uncheck-all` — clear every
 * check mark on the plan.
 *
 * One `updateMany` over the plan's rows with `applyUncheckAll`'s row-independent
 * update, which is what that rule is shaped for. The predicate deliberately does
 * NOT narrow to `is_checked: true`: the same statement clears checks and flags,
 * so a flag can never be left standing on a row whose check has just been
 * cleared, and re-running the action on an already-cleared list is a no-op
 * rather than a different outcome.
 *
 * `checkedCount` is 0 by construction, returned so the client updates its
 * counter from the server instead of assuming.
 */
export const uncheckAllGroceries = async (
    userId: string,
    planId: string,
    now: Date = new Date(),
): Promise<UncheckAllGroceriesResponse> =>
    withWritableGroceryPlan(userId, planId, now, async (tx) => {
        await tx.grocery_items.updateMany({
            where: { meal_plan_id: planId, user_id: userId },
            data: applyUncheckAll(),
        });

        return { checkedCount: 0 };
    });
