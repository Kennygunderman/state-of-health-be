// The HTTP proof for the weekly grocery list and its two check-mark writes
// (Agent Action Plan §0.5.1 "Grocery writes", §0.5.2's three `…/groceries*`
// rows, §0.7.3's numeric and display contract, §0.9.2's `api/grocery.test.ts`
// row).
//
// WHAT ONLY THIS SUITE CAN PROVE. Two things, and neither is reachable from a
// pure test.
//
//  1. THE DTO THE CLIENT DECODES. `src/services/grocery.mapper.ts` has no logic
//     test of its own — Rule 7 §11 files a mapper as "unit-testable if
//     non-trivial; otherwise covered by integration" — so every member of
//     `GroceryItem`, every grouping decision, and above all the
//     `NUMERIC(10,2)` → `Decimal` → `number` conversion are asserted here,
//     through `JSON.stringify`, because that is what the wire does and a
//     `Decimal` that reads fine in a JS object still serialises as `{s,e,d}`.
//
//  2. THAT A CHECK MARK IS NOT A PLAN CHANGE. §0.5.1 makes the grocery writes
//     state-setting rather than keyed: no idempotency key, no expected
//     revision, the per-user lock, an active plan required, and NO bump of
//     `meal_plans.revision`. The plan's revision and the `meal_plan_actions`
//     ledger are therefore read after every write, because the claim is about
//     a number that must not move and a row that must not appear. A toggle
//     that bumped the revision would invalidate every client's plan cache on
//     every tick.
//
// WHERE THE LINE WITH `grocery.logic.test.ts` FALLS. That suite owns the rules
// as pure functions: the aggregation formula, the epsilon comparison, the
// largest-unit display rule and its precisions, the state suffix, the aisle
// mapping, every diff verdict, unit-family stability, singular and plural
// counts. Rule §11's converse — "if you find yourself needing a database to
// test a rule, the rule is in the wrong layer" — is the test applied to every
// case below: what is here needs the database, the mount order, or the status
// map to be true at all. One case per unit family is read back, never the
// exhaustive table.
//
// WHAT EVERY CASE ASSERTS AGAINST. The stored rows as well as the response: a
// toggle that answers `isChecked: true` over a row it never wrote is exactly
// the failure this suite exists to catch, and a response body alone cannot see
// it.
//
// WHY THE ROWS ARE INSERTED RATHER THAN PUBLISHED. `../setup/factories` has no
// grocery factory — a list is normally written by a plan publication or a
// swap's rebuild — and the states most cases here need are the ones a freshly
// published list never has: a row already checked, and a row checked AND
// flagged with an acknowledged baseline behind it. So the shared fixture
// inserts its rows with the `display_*` values stated literally, and every
// string an assertion reads is a value this file states rather than one it
// recomputes with the code under test. "The list a week of meals implies" is
// the separate concern of the last describe, which publishes a real plan and
// runs the production builder over it.
//
// THE CLOCK IS NOT INJECTABLE HERE, AND THAT IS THE POINT. The controllers call
// the service without a `now`, so a grocery write is judged against the real
// clock in the user's stored zone. The fixture therefore takes `makePlan`'s
// CURRENT-week default, and the two unwritable states are reached by name —
// `FIXTURE_ENDED_PLAN_START_DAY_KEY` for a plan whose week has passed, and a
// `superseded` status with a successor for a plan that was replaced.

import { Prisma, catalog_foods } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import { loadPlannedMealsForGroceries, rebuildPlanGroceries } from '../../services/grocery.service';
import {
    GroceryItem,
    GroceryListResponse,
    ToggleGroceryItemResponse,
    UncheckAllGroceriesResponse,
} from '../../types/mealPlanning';
import * as featureFlags from '../../utils/featureFlags';
import {
    FIXTURE_ENDED_PLAN_START_DAY_KEY,
    FIXTURE_USER_TARGET_COLUMNS,
    addDaysToDayKey,
    currentPlanStartDayKey,
    makeCatalogFood,
    makePlan,
    makePreferences,
    makeRecipeVersion,
    makeUser,
    utcTodayDayKey,
} from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

const USER_ID = 'grocery-suite-user';
const OTHER_USER_ID = 'grocery-suite-other-user';

/** A UUID v4 that is no row's id, for the "does not exist" half of the 404 pair. */
const UNKNOWN_ID = '33333333-3333-4333-8333-333333333333';

/** `makePlan` publishes at revision 1, and no grocery write may move it. */
const PLAN_REVISION = 1;

/* ---------------------------------------------------------------------------
 * Routes, spelled once
 * ------------------------------------------------------------------------- */

const groceriesPath = (planId: string): string => `/api/meal-planning/plans/${planId}/groceries`;

const groceryItemPath = (planId: string, itemId: string): string => `${groceriesPath(planId)}/${itemId}`;

const uncheckAllPath = (planId: string): string => `${groceriesPath(planId)}/uncheck-all`;

/* ---------------------------------------------------------------------------
 * Requests
 *
 * The identity travels in the header the auth mock reads, and nowhere else:
 * `getUserId(req)` is the only channel a handler learns the caller through
 * (Rule §4), which is what gives the foreign-id 404s below their meaning.
 * ------------------------------------------------------------------------- */

const getList = (planId: string, uid: string = USER_ID) => asUser(request.get(groceriesPath(planId)), { uid });

/**
 * `body` is typed as supertest accepts it rather than as the payload, so the
 * malformed cases below can send a wrong type, an array or nothing at all
 * without a cast at each call site.
 */
const putItem = (planId: string, itemId: string, body: string | object | undefined, uid: string = USER_ID) =>
    asUser(request.put(groceryItemPath(planId, itemId)).send(body), { uid });

const postUncheckAll = (planId: string, uid: string = USER_ID) =>
    asUser(request.post(uncheckAllPath(planId)), { uid });

const readList = async (planId: string, uid: string = USER_ID): Promise<GroceryListResponse> => {
    const response = await getList(planId, uid).expect(200);

    return response.body as GroceryListResponse;
};

/* ---------------------------------------------------------------------------
 * The shared fixture
 *
 * One current-week plan whose list spans all five aisles and all three unit
 * families, with one food on it in two states so the `(food, state)`
 * aggregation key is observable, and with a checked row and a checked-and-
 * flagged row already in place.
 * ------------------------------------------------------------------------- */

/**
 * One shopping line as this suite inserts it: the grams beside the three
 * `display_*` values that render them, so no assertion has to recompute a
 * string with the formatter it is testing.
 */
interface FixtureLine {
    /** The stored shopping name, already carrying its state suffix where one is due. */
    readonly name: string;
    /**
     * The food's own `display_name`, which is the BASE the suffix is built from.
     * The two rice lines share one, which is what makes them two states of one
     * food rather than two unrelated foods.
     */
    readonly foodDisplayName: string;
    /** The aisle code stored on the row. */
    readonly aisle: string;
    /** The catalog category, which decides the aisle when a row is REBUILT. */
    readonly catalogCategory: string;
    readonly foodState: string;
    readonly grams: number;
    readonly displayQuantity: number;
    readonly displayUnit: string;
    readonly displayText: string;
    /** The portion the food states, which fixes the row's unit family. */
    readonly portion: { description: string; amount: number; unit: string; gram_weight: number };
    readonly isChecked: boolean;
    /** The last amount the shopper acknowledged; null when nothing is outstanding. */
    readonly acknowledgedGrams: number | null;
    readonly isFlagged: boolean;
}

/** A gram portion, for the lines whose amounts are read back in ounces. */
const gramPortion = { description: '1 portion', amount: 100, unit: 'g', gram_weight: 100 };

/**
 * The five aisles, the three families, and the one food in two states.
 *
 * The mass strings are `utils/units.ts`'s own tiering (100 g → "3.5 oz",
 * 200 g → "7.1 oz", 400 g → "14.1 oz"); the volume line is a cup-portioned
 * food at 300 g of a 200 g cup, which is a cup and a half; the count line is an
 * `each` portion of 50 g, so 600 g is twelve of them.
 */
const LINES: readonly FixtureLine[] = [
    {
        name: 'Spinach',
        foodDisplayName: 'Spinach',
        aisle: 'produce',
        catalogCategory: 'produce_vegetable',
        foodState: 'raw',
        grams: 200,
        displayQuantity: 7.1,
        displayUnit: 'oz',
        displayText: '7.1 oz',
        portion: gramPortion,
        isChecked: false,
        acknowledgedGrams: null,
        isFlagged: false,
    },
    {
        name: 'Tofu',
        foodDisplayName: 'Tofu',
        aisle: 'protein',
        catalogCategory: 'protein_plant',
        foodState: 'raw',
        grams: 400,
        displayQuantity: 14.1,
        displayUnit: 'oz',
        displayText: '14.1 oz',
        portion: gramPortion,
        isChecked: false,
        acknowledgedGrams: null,
        isFlagged: false,
    },
    {
        // The count family: an `each` portion, which is what makes a row
        // countable at all, and a description the formatter pluralises.
        name: 'Eggs',
        foodDisplayName: 'Eggs',
        aisle: 'protein',
        catalogCategory: 'protein_egg',
        foodState: 'raw',
        grams: 600,
        displayQuantity: 12,
        displayUnit: 'count',
        displayText: '12 eggs, large',
        portion: { description: '1 egg, large', amount: 1, unit: 'each', gram_weight: 50 },
        isChecked: false,
        acknowledgedGrams: null,
        isFlagged: false,
    },
    {
        // The volume family: a cup portion whose gram weight states the density
        // the conversion needs.
        name: 'Greek Yogurt',
        foodDisplayName: 'Greek Yogurt',
        aisle: 'dairy_alternatives',
        catalogCategory: 'dairy',
        foodState: 'as_purchased',
        grams: 300,
        displayQuantity: 1.5,
        displayUnit: 'cups',
        displayText: '1½ cups',
        portion: { description: '1 cup', amount: 1, unit: 'cup', gram_weight: 200 },
        isChecked: false,
        acknowledgedGrams: null,
        isFlagged: false,
    },
    {
        // Two states of ONE base name, so the coexistence rule qualifies BOTH
        // and the two lines stay distinguishable. Checked, so the checked list
        // has something in it besides the flagged row.
        name: 'Rice, dry',
        foodDisplayName: 'Rice',
        aisle: 'grains_bread',
        catalogCategory: 'grain',
        foodState: 'dry',
        grams: 200,
        displayQuantity: 7.1,
        displayUnit: 'oz',
        displayText: '7.1 oz',
        portion: gramPortion,
        isChecked: true,
        acknowledgedGrams: 200,
        isFlagged: false,
    },
    {
        name: 'Rice, cooked',
        foodDisplayName: 'Rice',
        aisle: 'grains_bread',
        catalogCategory: 'grain',
        foodState: 'cooked',
        grams: 450,
        displayQuantity: 15.9,
        displayUnit: 'oz',
        displayText: '15.9 oz',
        portion: gramPortion,
        isChecked: false,
        acknowledgedGrams: null,
        isFlagged: false,
    },
    {
        // The 14b state: an amount that went up on something already checked.
        // 100 g was acknowledged, 400 g is what the week now needs.
        name: 'Beans',
        foodDisplayName: 'Beans',
        aisle: 'pantry_other',
        catalogCategory: 'legume',
        foodState: 'dry',
        grams: 400,
        displayQuantity: 14.1,
        displayUnit: 'oz',
        displayText: '14.1 oz',
        portion: gramPortion,
        isChecked: true,
        acknowledgedGrams: 100,
        isFlagged: true,
    },
];

/** A fractional amount, so the `NUMERIC(10,2)` round trip has decimals to lose. */
const FRACTIONAL_GRAMS = 2.51;

const CHECKED_AT = new Date('2026-01-05T15:00:00.000Z');
const FLAGGED_AT = new Date('2026-01-05T18:00:00.000Z');

interface SuiteFixture {
    planId: string;
    /** A second current-era plan of the SAME user, so write scoping is provable. */
    secondPlanId: string;
    itemIdsByName: Map<string, string>;
    secondPlanItemIdsByName: Map<string, string>;
    foodIdsByName: Map<string, string>;
}

let fixture: SuiteFixture;

/**
 * The ONE clock read each test makes, and every day key below is derived from
 * it.
 *
 * `makePlan` reads the clock itself to place its default week, so a suite that
 * read it a second time in an assertion would disagree with the fixture on any
 * run that crossed UTC midnight between the two — which is exactly the
 * straddle `../setup/factories` warns about and exports `utcTodayDayKey` to
 * avoid. Anchoring both to one value closes the window instead of narrowing it.
 */
let anchorDayKey: string;

/** The current week's first day, as the fixture placed it. */
const planStartDayKey = (): string => currentPlanStartDayKey(anchorDayKey);

/** A day key `days` after the current week's first day. */
const weekOffsetDayKey = (days: number): string => addDaysToDayKey(planStartDayKey(), days);

const makeLineFood = async (line: FixtureLine): Promise<catalog_foods> =>
    makeCatalogFood({
        display_name: line.foodDisplayName,
        category: line.catalogCategory,
        food_state: line.foodState,
        defaultPortion: line.portion,
    });

const insertLines = async (
    userId: string,
    planId: string,
    foodsByName: ReadonlyMap<string, catalog_foods>,
    lines: readonly FixtureLine[],
): Promise<Map<string, string>> => {
    const idsByName = new Map<string, string>();

    for (const [index, line] of lines.entries()) {
        const food = foodsByName.get(line.name);

        if (food === undefined) {
            throw new Error(`The grocery fixture has no catalog food for "${line.name}".`);
        }

        const row = await prisma.grocery_items.create({
            data: {
                meal_plan_id: planId,
                user_id: userId,
                catalog_food_id: food.id,
                food_state: line.foodState,
                category: line.aisle,
                name: line.name,
                quantity_grams: line.grams,
                display_quantity: line.displayQuantity,
                display_unit: line.displayUnit,
                display_text: line.displayText,
                is_checked: line.isChecked,
                checked_at: line.isChecked ? CHECKED_AT : null,
                previous_quantity_grams: line.acknowledgedGrams,
                flagged_at: line.isFlagged ? FLAGGED_AT : null,
                sort_order: index,
            },
        });

        idsByName.set(line.name, row.id);
    }

    return idsByName;
};

const seedFixture = async (): Promise<SuiteFixture> => {
    await makeUser({ id: USER_ID, ...FIXTURE_USER_TARGET_COLUMNS });
    await makePreferences(USER_ID);

    const foodsByName = new Map<string, catalog_foods>();

    for (const line of LINES) {
        foodsByName.set(line.name, await makeLineFood(line));
    }

    // `slots: []` publishes a plan with days and no meals: every case in the
    // first three describes asserts on the STORED list, never on the week that
    // produced it, so planning a recipe into every slot would add rows nothing
    // reads. The last describe publishes a plan with meals precisely because
    // that is the claim it makes.
    const plan = await makePlan(USER_ID, { today: anchorDayKey, slots: [] });
    const secondPlan = await makePlan(USER_ID, {
        startDate: weekOffsetDayKey(7),
        slots: [],
    });

    return {
        planId: plan.id,
        secondPlanId: secondPlan.id,
        itemIdsByName: await insertLines(USER_ID, plan.id, foodsByName, LINES),
        // The second plan carries a checked line and a flagged one of its own,
        // so "this plan and only this plan" is a claim with something to fail.
        secondPlanItemIdsByName: await insertLines(
            USER_ID,
            secondPlan.id,
            foodsByName,
            LINES.filter((line) => line.name === 'Rice, dry' || line.name === 'Beans'),
        ),
        foodIdsByName: new Map([...foodsByName].map(([name, food]) => [name, food.id])),
    };
};

/* ---------------------------------------------------------------------------
 * Stored-state readers
 * ------------------------------------------------------------------------- */

type StoredGroceryRow = Prisma.grocery_itemsGetPayload<Record<string, never>>;

const itemId = (name: string): string => {
    const id = fixture.itemIdsByName.get(name);

    if (id === undefined) {
        throw new Error(`The grocery fixture has no row for "${name}".`);
    }

    return id;
};

const storedRows = (planId: string = fixture.planId): Promise<StoredGroceryRow[]> =>
    prisma.grocery_items.findMany({
        where: { meal_plan_id: planId },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });

const storedRow = (name: string): Promise<StoredGroceryRow> =>
    prisma.grocery_items.findUniqueOrThrow({ where: { id: itemId(name) } });

const planRevision = async (planId: string = fixture.planId): Promise<number> =>
    (await prisma.meal_plans.findUniqueOrThrow({ where: { id: planId }, select: { revision: true } })).revision;

const actionRowCount = (): Promise<number> => prisma.meal_plan_actions.count();

/** A `NUMERIC(10,2)` column as a number, so amounts compare as amounts. */
const grams = (value: Prisma.Decimal | null): number | null => (value === null ? null : value.toNumber());

const everyItem = (list: GroceryListResponse): GroceryItem[] => [
    ...list.sections.flatMap((section) => section.items),
    ...list.checkedItems,
];

beforeEach(async () => {
    await truncateFeatureTables();
    anchorDayKey = utcTodayDayKey();
    fixture = await seedFixture();
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * GET …/groceries — the DTO and the grouping
 *
 * This is the mapper's charter: `grocery.mapper.ts` has no logic test, so every
 * member it derives is pinned here against the response the client actually
 * receives.
 * ------------------------------------------------------------------------- */

describe('GET the grocery list', () => {
    it('answers with every member of the list contract', async () => {
        const response = await getList(fixture.planId).expect(200);
        const list = response.body as GroceryListResponse;

        // Named exhaustively rather than sampled: the client reads each of these
        // unconditionally, so a member the mapper stopped emitting would be
        // `undefined` at the decode boundary rather than a caught omission.
        expect(Object.keys(list).sort()).toEqual([
            'banner',
            'checkedCount',
            'checkedItems',
            'endDate',
            'planId',
            'planRevision',
            'sections',
            'startDate',
            'totalCount',
        ]);
        expect(list.planId).toBe(fixture.planId);
        // The client reads the revision to notice a list it holds has gone
        // stale, so its presence is part of the contract, not a detail.
        expect(list.planRevision).toBe(PLAN_REVISION);
        expect(list.startDate).toBe(planStartDayKey());
        expect(list.endDate).toBe(weekOffsetDayKey(6));
    });

    it('gives an unflagged item every member of the item contract, with flag null rather than absent', async () => {
        const list = await readList(fixture.planId);
        const spinach = list.sections[0].items[0];

        expect(Object.keys(spinach).sort()).toEqual([
            'catalogFoodId',
            'displayText',
            'flag',
            'foodState',
            'id',
            'isChecked',
            'name',
            'quantityGrams',
        ]);
        expect(spinach).toEqual({
            id: itemId('Spinach'),
            catalogFoodId: fixture.foodIdsByName.get('Spinach'),
            foodState: 'raw',
            name: 'Spinach',
            quantityGrams: 200,
            displayText: '7.1 oz',
            isChecked: false,
            // `null`, never omitted: the client renders the flagged row from
            // this member's presence, so an absent key would read as "not
            // flagged" only by accident of `undefined` (Rule §6).
            flag: null,
        });
    });

    describe('quantityGrams', () => {
        /**
         * The column is `NUMERIC(10,2)`, so Prisma hands the mapper a `Decimal`
         * — an OBJECT. A mapper that passed it through would put `{s,e,d}` or a
         * quoted string on the wire and break the client's codec, and no pure
         * test can see that because no pure test has a `Decimal` to begin with.
         */
        it('is a number, not a Decimal or a string', async () => {
            const list = await readList(fixture.planId);

            for (const item of everyItem(list)) {
                expect(typeof item.quantityGrams).toBe('number');
            }
        });

        it('survives the wire exactly, decimals included', async () => {
            await prisma.grocery_items.update({
                where: { id: itemId('Spinach') },
                data: { quantity_grams: FRACTIONAL_GRAMS },
            });

            const response = await getList(fixture.planId).expect(200);
            // Through `JSON.stringify` and back, because that is what the wire
            // does: a `Decimal` can read as a plain object in a JS assertion and
            // still serialise as `{"s":1,"e":0,"d":[2,5100000]}`.
            const roundTripped = JSON.parse(JSON.stringify(response.body)) as GroceryListResponse;
            const spinach = roundTripped.sections[0].items[0];

            expect(spinach.quantityGrams).toBe(FRACTIONAL_GRAMS);
            expect(typeof spinach.quantityGrams).toBe('number');
            // The stored column really does hold the fraction, so the assertion
            // above is about the mapper rather than about a value rounded away
            // before it got there.
            expect(grams((await storedRow('Spinach')).quantity_grams)).toBe(FRACTIONAL_GRAMS);
        });
    });

    describe('the aisle sections', () => {
        it('groups the unchecked rows into store-order aisles and omits the empty ones', async () => {
            const list = await readList(fixture.planId);

            // `grains_bread` appears for the cooked rice alone — the dry rice is
            // checked — and `dairy_alternatives` for the yogurt. `pantry_other`
            // is absent because its only row is the checked, flagged one, which
            // is exactly the "no unchecked rows means no section" rule.
            expect(list.sections.map((section) => section.category)).toEqual([
                'produce',
                'protein',
                'dairy_alternatives',
                'grains_bread',
            ]);
            expect(list.sections.map((section) => section.items.map((item) => item.name))).toEqual([
                ['Spinach'],
                ['Tofu', 'Eggs'],
                ['Greek Yogurt'],
                ['Rice, cooked'],
            ]);
        });

        it('closes the list with pantry_other whenever that aisle has something unchecked', async () => {
            await prisma.grocery_items.update({
                where: { id: itemId('Beans') },
                data: { is_checked: false, checked_at: null, previous_quantity_grams: null, flagged_at: null },
            });

            const list = await readList(fixture.planId);

            // The terminal position is a rule, not the order the rows were
            // inserted in: `Beans` was inserted last but its aisle would close
            // the list from any position.
            expect(list.sections[list.sections.length - 1].category).toBe('pantry_other');
            expect(list.sections.map((section) => section.category)).toEqual([
                'produce',
                'protein',
                'dairy_alternatives',
                'grains_bread',
                'pantry_other',
            ]);
        });

        it('never renders a section with no items', async () => {
            const list = await readList(fixture.planId);

            for (const section of list.sections) {
                expect(section.items.length).toBeGreaterThan(0);
            }
        });

        /**
         * `category`, `food_state` and the banner code are plain TEXT columns
         * with no enum and no CHECK constraint behind them (§0.5.1), so the
         * vocabulary is enforced at this boundary or nowhere. It is therefore
         * proven through the API rather than by inserting a bad value and
         * expecting the database to object — which it would not.
         */
        it('speaks in machine codes, never in the prose the client owns', async () => {
            const list = await readList(fixture.planId);

            for (const section of list.sections) {
                expect(['produce', 'protein', 'dairy_alternatives', 'grains_bread', 'pantry_other']).toContain(
                    section.category,
                );
            }

            for (const item of everyItem(list)) {
                expect(['raw', 'cooked', 'prepared', 'dry', 'as_purchased']).toContain(item.foodState);
            }

            // The rendered aisle words of frames 14 and 14b — "Dairy &
            // alternatives", "Grains & bread", "Pantry & other" — belong to the
            // client's `strings.ts`, so none of them may appear on the wire.
            expect(JSON.stringify(list.sections.map((section) => section.category))).not.toMatch(/ |&|[A-Z]/);
        });

        it('shops an unrecognised aisle code under pantry_other rather than dropping the row', async () => {
            await prisma.grocery_items.update({
                where: { id: itemId('Spinach') },
                data: { category: 'aisle_from_a_later_release' },
            });

            const list = await readList(fixture.planId);
            const closing = list.sections[list.sections.length - 1];

            // A row missing from every section is a row missing from the shop,
            // so an unknown code is shopped last instead of silently vanishing —
            // and the response still speaks only the five codes.
            expect(closing.category).toBe('pantry_other');
            expect(closing.items.map((item) => item.name)).toContain('Spinach');
            expect(list.totalCount).toBe(LINES.length);
            expect(everyItem(list)).toHaveLength(LINES.length);
        });
    });

    describe('the checked list', () => {
        it('holds the checked rows apart, flagged first', async () => {
            const list = await readList(fixture.planId);

            // `Beans` leads although `Rice, dry` sits in an earlier aisle and a
            // lower `sort_order`: frame 37:261 leads the Checked card with the
            // flagged row, so an amount that went up is read before the rows the
            // shopper has already settled.
            expect(list.checkedItems.map((item) => item.name)).toEqual(['Beans', 'Rice, dry']);
            expect(list.checkedItems[0].flag).not.toBeNull();
            expect(list.checkedItems[1].flag).toBeNull();
        });

        it('moves a checked row out of its section rather than duplicating it', async () => {
            const before = await readList(fixture.planId);

            await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(200);

            const after = await readList(fixture.planId);
            const sectionNames = after.sections.flatMap((section) => section.items.map((item) => item.name));

            expect(before.sections[0].items.map((item) => item.name)).toEqual(['Spinach']);
            expect(sectionNames).not.toContain('Spinach');
            expect(after.checkedItems.map((item) => item.name)).toContain('Spinach');
            // Every row appears exactly once across the whole response, so no
            // item can be shopped twice or counted twice.
            expect(everyItem(after).map((item) => item.id).sort()).toEqual(
                (await storedRows()).map((row) => row.id).sort(),
            );
        });
    });

    describe('the counts', () => {
        it('spans the whole list, checked rows included', async () => {
            const list = await readList(fixture.planId);

            // The eyebrow reads "2 of 7 checked", so a total covering only the
            // visible sections would be wrong by exactly the number of items
            // already in the basket.
            expect(list.totalCount).toBe(LINES.length);
            expect(list.checkedCount).toBe(2);
        });

        it('reports zero checked when nothing is', async () => {
            await postUncheckAll(fixture.planId).expect(200);

            const list = await readList(fixture.planId);

            expect(list.totalCount).toBe(LINES.length);
            expect(list.checkedCount).toBe(0);
            expect(list.checkedItems).toEqual([]);
        });

        it('reports every row checked when they all are', async () => {
            for (const line of LINES) {
                await putItem(fixture.planId, itemId(line.name), { isChecked: true }).expect(200);
            }

            const list = await readList(fixture.planId);

            expect(list.checkedCount).toBe(LINES.length);
            expect(list.totalCount).toBe(LINES.length);
            // Nothing left to shop, and an empty `sections` here means "all
            // checked" rather than "no ingredients" — the counts are what tell
            // the client which it is looking at.
            expect(list.sections).toEqual([]);
        });
    });

    describe('one food in two states', () => {
        it('keeps the two rows apart and qualifies both names', async () => {
            const list = await readList(fixture.planId);
            const rice = everyItem(list).filter((item) => item.name.startsWith('Rice'));

            // Raw, dry and cooked amounts of one food never merge:
            // `(catalog_food_id, food_state)` is the aggregation key, so two
            // states are two lines with independent amounts.
            expect(rice).toHaveLength(2);
            expect(rice.map((item) => item.name).sort()).toEqual(['Rice, cooked', 'Rice, dry']);
            expect(rice.map((item) => item.foodState).sort()).toEqual(['cooked', 'dry']);
            expect(new Set(rice.map((item) => item.catalogFoodId)).size).toBe(2);
            expect(rice.find((item) => item.foodState === 'dry')?.quantityGrams).toBe(200);
            expect(rice.find((item) => item.foodState === 'cooked')?.quantityGrams).toBe(450);
        });
    });

    describe('displayText', () => {
        /**
         * One case per unit family, and no more: the exhaustive tiering table
         * belongs to `grocery.logic.test.ts` and `units.test.ts`. What is
         * proven here is that the STORED string is what reaches the client —
         * the mapper passes `display_text` through rather than re-rendering it,
         * which is what keeps a row's amount and its flag's "was" text in one
         * family.
         */
        it('renders the mass, volume and count families as stored', async () => {
            const list = await readList(fixture.planId);
            const byName = new Map(everyItem(list).map((item) => [item.name, item.displayText]));

            expect(byName.get('Spinach')).toBe('7.1 oz');
            expect(byName.get('Greek Yogurt')).toBe('1½ cups');
            // The count family pluralises the portion's own noun, so one egg and
            // twelve read differently.
            expect(byName.get('Eggs')).toBe('12 eggs, large');
        });

        it('never invents a container unit', async () => {
            const list = await readList(fixture.planId);

            // §0.1.4 resolves the mockup's "1 bottle" as sample data and fixes
            // the contract as MEASURED quantities. A stored description that
            // happens to be a container word is the food's own fact; what must
            // never happen is the formatter synthesising one.
            for (const item of everyItem(list)) {
                expect(item.displayText).not.toMatch(/bottle|pack|can\b|carton|jar|bag|box/i);
            }
        });
    });

    describe('the banner', () => {
        it('names the flagged items when an amount has gone up on a checked row', async () => {
            const list = await readList(fixture.planId);

            expect(list.banner).toEqual({ code: 'amount_increased', itemNames: ['Beans'] });
        });

        it('announces nothing when there is nothing to announce', async () => {
            await prisma.grocery_items.updateMany({
                where: { meal_plan_id: fixture.planId },
                data: { flagged_at: null },
            });

            expect((await readList(fixture.planId)).banner).toBeNull();
        });

        /**
         * The swap notice is read from the keyed-write ledger, because the
         * grocery rows record amounts and not causes. The ledger row is written
         * here rather than by driving a real swap: what this case claims is that
         * the list REPORTS a swap that changed it, and `api/swaps.test.ts` owns
         * the claim that a commit writes such a row.
         */
        it('reports the slot of the last swap that changed the list', async () => {
            await prisma.grocery_items.updateMany({
                where: { meal_plan_id: fixture.planId },
                data: { flagged_at: null },
            });
            await prisma.meal_plan_actions.create({
                data: {
                    user_id: USER_ID,
                    idempotency_key: '44444444-4444-4444-8444-444444444444',
                    action_type: 'swap',
                    request_fingerprint: 'grocery-suite-swap',
                    meal_plan_id: fixture.planId,
                    response_status: 200,
                    response_snapshot: {
                        meal: { slot: 'lunch' },
                        groceryChangeSummary: { added: 1, removed: 0, increased: 1 },
                    },
                },
            });

            expect((await readList(fixture.planId)).banner).toEqual({
                code: 'updated_after_swap',
                mealSlot: 'lunch',
            });
        });

        it('lets a flag outrank a swap notice', async () => {
            await prisma.meal_plan_actions.create({
                data: {
                    user_id: USER_ID,
                    idempotency_key: '55555555-5555-4555-8555-555555555555',
                    action_type: 'swap',
                    request_fingerprint: 'grocery-suite-swap-outranked',
                    meal_plan_id: fixture.planId,
                    response_status: 200,
                    response_snapshot: {
                        meal: { slot: 'dinner' },
                        groceryChangeSummary: { added: 0, removed: 0, increased: 1 },
                    },
                },
            });

            // Once an amount has gone up on something already checked, that is
            // the thing the shopper needs to know.
            expect((await readList(fixture.planId)).banner).toEqual({
                code: 'amount_increased',
                itemNames: ['Beans'],
            });
        });
    });

    describe('a plan that needs no ingredients', () => {
        /**
         * The empty LIST and the absence of a plan are different screens with
         * different copy (§0.2.5), and only the first of them is a server
         * concern: a client with no plan never sends a `planId` at all. So this
         * is a decoded empty list — `200`, never `404` and never an error.
         */
        it('answers 200 with an empty list that still carries the plan week', async () => {
            await prisma.grocery_items.deleteMany({ where: { meal_plan_id: fixture.secondPlanId } });

            const list = await readList(fixture.secondPlanId);

            expect(list.sections).toEqual([]);
            expect(list.checkedItems).toEqual([]);
            expect(list.totalCount).toBe(0);
            expect(list.checkedCount).toBe(0);
            expect(list.banner).toBeNull();
            // The range is what lets the client render the accurate empty-list
            // copy instead of the no-plan copy.
            expect(list.startDate).toBe(weekOffsetDayKey(7));
            expect(list.endDate).toBe(weekOffsetDayKey(13));
        });
    });

    describe('a plan the writes would refuse', () => {
        it('stays readable after the week has ended', async () => {
            await makeUser({ id: OTHER_USER_ID });
            const endedPlan = await makePlan(OTHER_USER_ID, {
                startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY,
                slots: [],
            });

            // §0.5.2 lists no `plan_not_active` for this route: a client holding
            // last week's plan can still show what it shopped for, and the
            // write against that same plan is refused below.
            const list = (await asUser(request.get(groceriesPath(endedPlan.id)), { uid: OTHER_USER_ID }).expect(200))
                .body as GroceryListResponse;

            expect(list.planId).toBe(endedPlan.id);
            expect(list.startDate).toBe(FIXTURE_ENDED_PLAN_START_DAY_KEY);
        });
    });
});

/* ---------------------------------------------------------------------------
 * PUT …/groceries/:itemId — one check mark, state-setting
 * ------------------------------------------------------------------------- */

describe('PUT one check mark', () => {
    describe('the refusals', () => {
        it('refuses a malformed itemId, naming the parameter', async () => {
            const before = await storedRows();

            const response = await putItem(fixture.planId, 'not-a-uuid', { isChecked: true }).expect(400);

            expect(response.body).toEqual({
                error: 'invalid_request',
                details: [{ field: 'itemId', code: 'invalid_id' }],
            });
            // A non-UUID reaching a `where: { id }` predicate is a PostgreSQL
            // cast error and a 500, so the parse has to happen before the query
            // — and the list must be untouched either way.
            expect(await storedRows()).toEqual(before);
        });

        it('names both ids when both are malformed', async () => {
            const response = await putItem('not-a-plan', 'not-an-item', { isChecked: true }).expect(400);

            expect(response.body).toEqual({
                error: 'invalid_request',
                details: [
                    { field: 'planId', code: 'invalid_id' },
                    { field: 'itemId', code: 'invalid_id' },
                ],
            });
        });

        it('refuses a body with no isChecked, naming the field', async () => {
            const response = await putItem(fixture.planId, itemId('Spinach'), {}).expect(400);

            expect(response.body).toEqual({
                error: 'invalid_request',
                details: [{ field: 'isChecked', code: 'required' }],
            });
            expect((await storedRow('Spinach')).is_checked).toBe(false);
        });

        it('refuses a non-boolean isChecked, naming the field', async () => {
            // A truthy string would otherwise set a check mark by accident: the
            // desired state IS the whole request, so its type is load-bearing.
            const response = await putItem(fixture.planId, itemId('Spinach'), { isChecked: 'yes' }).expect(400);

            expect(response.body).toEqual({
                error: 'invalid_request',
                details: [{ field: 'isChecked', code: 'invalid_type' }],
            });
            expect((await storedRow('Spinach')).is_checked).toBe(false);
        });

        it('answers an item of another plan and an item that does not exist identically, and writes nothing', async () => {
            const before = await storedRows();
            const secondPlanBefore = await storedRows(fixture.secondPlanId);
            const foreignPlanItemId = fixture.secondPlanItemIdsByName.get('Rice, dry');

            if (foreignPlanItemId === undefined) {
                throw new Error('The grocery fixture published no second-plan row to address through the first.');
            }

            // The predicate is `{id, meal_plan_id, user_id}` in one statement,
            // so a row of another plan of the SAME user is not addressable
            // through this plan.
            const throughWrongPlan = await putItem(fixture.planId, foreignPlanItemId, { isChecked: true }).expect(404);
            const neverExisted = await putItem(fixture.planId, UNKNOWN_ID, { isChecked: true }).expect(404);

            // Byte-equal bodies: "isn't yours" must be indistinguishable from
            // "doesn't exist", or the 404 becomes an existence oracle (Rule
            // §1.5, §8).
            expect(throughWrongPlan.body).toEqual(neverExisted.body);
            expect(await storedRows()).toEqual(before);
            // Nor was it written through the plan it does belong to.
            expect(await storedRows(fixture.secondPlanId)).toEqual(secondPlanBefore);
            expect(await planRevision()).toBe(PLAN_REVISION);
        });

        it('refuses a superseded plan and names the plan that replaced it', async () => {
            const before = await storedRows();

            await prisma.meal_plans.update({ where: { id: fixture.planId }, data: { status: 'superseded' } });
            const successor = await makePlan(USER_ID, {
                startDate: weekOffsetDayKey(14),
                slots: [],
                replaced_plan_id: fixture.planId,
            });

            const response = await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(409);

            // The variant exists so a stale screen can open the right week.
            expect(response.body).toEqual({
                error: 'plan_not_active',
                replacementPlanId: successor.id,
            });
            expect(await storedRows()).toEqual(before);
        });

        it('refuses a plan whose week has ended', async () => {
            await makeUser({ id: OTHER_USER_ID });
            await makePreferences(OTHER_USER_ID);
            const endedPlan = await makePlan(OTHER_USER_ID, {
                startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY,
                slots: [],
            });
            const food = await makeLineFood(LINES[0]);
            const row = await prisma.grocery_items.create({
                data: {
                    meal_plan_id: endedPlan.id,
                    user_id: OTHER_USER_ID,
                    catalog_food_id: food.id,
                    food_state: 'raw',
                    category: 'produce',
                    name: 'Spinach',
                    quantity_grams: 200,
                    display_quantity: 7.1,
                    display_unit: 'oz',
                    display_text: '7.1 oz',
                    is_checked: false,
                    sort_order: 0,
                },
            });

            const response = await asUser(
                request.put(groceryItemPath(endedPlan.id, row.id)).send({ isChecked: true }),
                { uid: OTHER_USER_ID },
            ).expect(409);

            // Stored `active`, but its last date has passed, so the reason is
            // `ended` rather than a replacement id.
            expect(response.body).toEqual({ error: 'plan_not_active', reason: 'ended' });
            expect((await prisma.grocery_items.findUniqueOrThrow({ where: { id: row.id } })).is_checked).toBe(false);
        });
    });

    describe('setting a check mark', () => {
        it('answers with the updated row and the new total, and persists both', async () => {
            const response = await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(200);
            const body = response.body as ToggleGroceryItemResponse;
            const row = await storedRow('Spinach');

            expect(Object.keys(body).sort()).toEqual(['checkedCount', 'item']);
            expect(body.item).toMatchObject({
                id: itemId('Spinach'),
                name: 'Spinach',
                isChecked: true,
                quantityGrams: 200,
                displayText: '7.1 oz',
                flag: null,
            });
            // Counted from the rows rather than adjusted arithmetically, so a
            // client that retried a toggle it had already applied is not handed
            // a count that drifted by one.
            expect(body.checkedCount).toBe(3);
            // The response is not taken on trust: the returned `isChecked` must
            // be a statement about a row that was actually written.
            expect(row.is_checked).toBe(true);
            expect(row.checked_at).not.toBeNull();
            // Checking records the amount visible at that moment as the new
            // yardstick, so a later increase is measured from what was seen.
            expect(grams(row.previous_quantity_grams)).toBe(200);
            expect(row.flagged_at).toBeNull();
        });

        it('needs no idempotency key and no expected revision', async () => {
            // The whole body: the request names the desired state and nothing
            // else, which is what makes the write safely repeatable without a
            // key (§0.5.1).
            const response = await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(200);

            expect((response.body as ToggleGroceryItemResponse).item.isChecked).toBe(true);
        });

        it('reserves nothing in the keyed-write ledger', async () => {
            await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(200);

            // A check mark is not one of the four keyed actions, so it must not
            // consume a ledger row — a reservation here would be an entry no
            // client could ever replay.
            expect(await actionRowCount()).toBe(0);
        });

        it('does not bump the plan revision, because a check mark is not a plan change', async () => {
            const before = await planRevision();

            await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(200);

            // The load-bearing assertion of this suite: a toggle that moved the
            // revision would invalidate every client's plan cache on every tick.
            expect(await planRevision()).toBe(before);
            expect(before).toBe(PLAN_REVISION);
        });

        it('takes both of two opposite writes, last write wins', async () => {
            const checked = await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(200);

            expect((await storedRow('Spinach')).is_checked).toBe(true);

            const unchecked = await putItem(fixture.planId, itemId('Spinach'), { isChecked: false }).expect(200);
            const row = await storedRow('Spinach');

            // No conflict, no key, no revision: two successive writes simply
            // both take effect.
            expect((checked.body as ToggleGroceryItemResponse).checkedCount).toBe(3);
            expect((unchecked.body as ToggleGroceryItemResponse).checkedCount).toBe(2);
            expect(row.is_checked).toBe(false);
            expect(row.checked_at).toBeNull();
            expect(await planRevision()).toBe(PLAN_REVISION);
        });

        it('is repeatable: naming the state a row already holds leaves that state alone', async () => {
            await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(200);
            const afterFirst = await storedRow('Spinach');

            const repeated = await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(200);
            const afterRepeat = await storedRow('Spinach');

            // Repeating the write is not an error and does not double-count.
            expect((repeated.body as ToggleGroceryItemResponse).checkedCount).toBe(3);
            expect({
                is_checked: afterRepeat.is_checked,
                flagged_at: afterRepeat.flagged_at,
                previous_quantity_grams: grams(afterRepeat.previous_quantity_grams),
            }).toEqual({
                is_checked: afterFirst.is_checked,
                flagged_at: afterFirst.flagged_at,
                previous_quantity_grams: grams(afterFirst.previous_quantity_grams),
            });
            // `checked_at` is the exception, and correctly so: every check
            // re-records the moment the shopper acknowledged what the row says,
            // so a second write advances it rather than preserving the first.
            expect(afterRepeat.checked_at?.getTime() ?? 0).toBeGreaterThanOrEqual(
                afterFirst.checked_at?.getTime() ?? 0,
            );
        });
    });

    describe('the flag and its acknowledged baseline', () => {
        it('clears the flag and the baseline when the row is unchecked', async () => {
            const response = await putItem(fixture.planId, itemId('Beans'), { isChecked: false }).expect(200);
            const row = await storedRow('Beans');

            // §0.5.2: checking OR unchecking clears the flag. Either way the
            // user has just interacted with the row, so the warning has been
            // seen.
            expect(row.is_checked).toBe(false);
            expect(row.flagged_at).toBeNull();
            expect(row.checked_at).toBeNull();
            // Nothing is outstanding to compare against once the row is
            // unchecked.
            expect(grams(row.previous_quantity_grams)).toBeNull();
            expect((response.body as ToggleGroceryItemResponse).item.flag).toBeNull();
            expect((response.body as ToggleGroceryItemResponse).checkedCount).toBe(1);
            expect(await planRevision()).toBe(PLAN_REVISION);
        });

        it('clears the flag and re-acknowledges the current amount when the row is checked again', async () => {
            const response = await putItem(fixture.planId, itemId('Beans'), { isChecked: true }).expect(200);
            const row = await storedRow('Beans');

            expect(row.is_checked).toBe(true);
            expect(row.flagged_at).toBeNull();
            // The shopper has just seen 400 g, so 400 g is the new yardstick —
            // not the 100 g the flag was measured against.
            expect(grams(row.previous_quantity_grams)).toBe(400);
            expect((response.body as ToggleGroceryItemResponse).item.flag).toBeNull();
            expect((response.body as ToggleGroceryItemResponse).checkedCount).toBe(2);
        });

        /**
         * `previous_quantity_grams` is the LAST ACKNOWLEDGED amount, not merely
         * the previous one, and the toggle's baseline reset is what makes that
         * true. Proven by driving a real increase through the production
         * rebuild — the same function a swap commits — after the toggle, and
         * reading what the new flag says "was".
         */
        it('resets the baseline, so the next increase is measured from what the shopper just saw', async () => {
            const plannedFood = await makeCatalogFood({
                display_name: 'Chickpeas',
                category: 'legume',
                food_state: 'dry',
                defaultPortion: gramPortion,
            });
            const planned = await makeRecipeVersion({
                slug: 'grocery-suite-baseline',
                name: 'Chickpea Bowl',
                catalogFoodId: plannedFood.id,
                yield_servings: 1,
                ingredients: [
                    {
                        catalogFoodId: plannedFood.id,
                        gram_weight: 100,
                        quantity: 100,
                        unit: 'g',
                        display_text: '100 g',
                    },
                ],
            });
            const plan = await makePlan(USER_ID, {
                startDate: weekOffsetDayKey(21),
                dayCount: 1,
                slots: [{ slot: 'lunch', slot_time: '12:30', recipeVersionId: planned.id }],
            });

            const rebuild = async (): Promise<void> => {
                await prisma.$transaction(async (tx) => {
                    await rebuildPlanGroceries(tx, {
                        userId: USER_ID,
                        planId: plan.id,
                        meals: await loadPlannedMealsForGroceries(tx, USER_ID, plan.id),
                        now: new Date(),
                    });
                });
            };

            await rebuild();
            const published = await readList(plan.id);
            const rowId = published.sections[0].items[0].id;

            // 100 g published, acknowledged at 100 g by checking it.
            expect(published.sections[0].items[0].quantityGrams).toBe(100);
            await putItem(plan.id, rowId, { isChecked: true }).expect(200);

            // First increase: 100 g → 300 g, flagged against the acknowledged 100 g.
            await prisma.meal_plan_meals.updateMany({
                where: { meal_plan_id: plan.id },
                data: { portion_multiplier: 3 },
            });
            await rebuild();
            const firstFlag = (await readList(plan.id)).checkedItems[0];

            expect(firstFlag.flag).toMatchObject({ previousDisplayText: '3.5 oz', newDisplayText: '10.6 oz' });

            // The shopper acknowledges 300 g by toggling the row, which resets
            // the baseline to what they have now seen.
            await putItem(plan.id, rowId, { isChecked: false }).expect(200);
            await putItem(plan.id, rowId, { isChecked: true }).expect(200);
            expect(grams((await prisma.grocery_items.findUniqueOrThrow({ where: { id: rowId } })).previous_quantity_grams)).toBe(300);

            // Second increase: 300 g → 400 g, deliberately still inside the
            // ounce tier so the two texts are comparable at a glance. "was"
            // names the INTERMEDIATE amount the shopper acknowledged, never the
            // original 100 g — which is the whole difference between "the last
            // acknowledged amount" and "the previous amount".
            await prisma.meal_plan_meals.updateMany({
                where: { meal_plan_id: plan.id },
                data: { portion_multiplier: 4 },
            });
            await rebuild();
            const secondFlag = (await readList(plan.id)).checkedItems[0];

            expect(secondFlag.flag).toMatchObject({
                previousDisplayText: '10.6 oz',
                newDisplayText: '14.1 oz',
                deltaDisplayText: '+3.5 oz',
            });
            expect(
                grams((await prisma.grocery_items.findUniqueOrThrow({ where: { id: rowId } })).previous_quantity_grams),
            ).toBe(300);
        });

        it('gives a flagged row all four flag members', async () => {
            const list = await readList(fixture.planId);
            const flagged = list.checkedItems[0];

            expect(flagged.name).toBe('Beans');
            expect(Object.keys(flagged.flag ?? {}).sort()).toEqual([
                'deltaDisplayText',
                'flaggedAt',
                'newDisplayText',
                'previousDisplayText',
            ]);
            expect(flagged.flag).toEqual({
                // 100 g acknowledged, 400 g needed, in the row's own family.
                previousDisplayText: '3.5 oz',
                newDisplayText: '14.1 oz',
                deltaDisplayText: '+10.6 oz',
                flaggedAt: FLAGGED_AT.toISOString(),
            });
        });
    });
});

/* ---------------------------------------------------------------------------
 * POST …/groceries/uncheck-all
 * ------------------------------------------------------------------------- */

describe('POST uncheck-all', () => {
    /**
     * The one live registration-order hazard in the router: `/groceries/
     * uncheck-all` is a LITERAL path sitting beside `/groceries/:itemId`, and a
     * parameterized route declared first would swallow it with
     * `itemId = "uncheck-all"` (Rule §3.1, with `foodRoutes` before
     * `nutritionRoutes` as the shipped precedent). The methods differ, which
     * helps, but the order is what is actually load-bearing, so it is asserted
     * rather than assumed.
     */
    it('reaches its own handler rather than the single-item route', async () => {
        const response = await postUncheckAll(fixture.planId).expect(200);

        // The uncheck-all response shape, not the toggle's `{item, checkedCount}`
        // — which is how a capture would show itself.
        expect(response.body).toEqual({ checkedCount: 0 });
        expect(response.body).not.toHaveProperty('item');
        // And no row was addressed as if "uncheck-all" were an id: the parser
        // would have rejected that as a malformed UUID with a 400.
        expect((await storedRows()).every((row) => !row.is_checked)).toBe(true);
    });

    it('clears every check and every flag on the plan, and reports zero', async () => {
        const response = await postUncheckAll(fixture.planId).expect(200);
        const rows = await storedRows();

        expect(response.body as UncheckAllGroceriesResponse).toEqual({ checkedCount: 0 });
        expect(rows).toHaveLength(LINES.length);
        expect(rows.map((row) => row.is_checked)).toEqual(rows.map(() => false));
        // The same statement clears checks and flags, so a flag can never be
        // left standing on a row whose check has just gone.
        expect(rows.map((row) => row.flagged_at)).toEqual(rows.map(() => null));
        expect(rows.map((row) => row.checked_at)).toEqual(rows.map(() => null));
        expect(rows.map((row) => grams(row.previous_quantity_grams))).toEqual(rows.map(() => null));
    });

    it('leaves the plan revision alone and reserves no ledger row', async () => {
        await postUncheckAll(fixture.planId).expect(200);

        expect(await planRevision()).toBe(PLAN_REVISION);
        expect(await actionRowCount()).toBe(0);
    });

    it('is a no-op on a list that is already clear', async () => {
        await postUncheckAll(fixture.planId).expect(200);
        const afterFirst = await storedRows();

        const repeated = await postUncheckAll(fixture.planId).expect(200);

        expect(repeated.body).toEqual({ checkedCount: 0 });
        expect(await storedRows()).toEqual(afterFirst);
    });

    it('touches only the plan it was asked about', async () => {
        const otherPlanBefore = await storedRows(fixture.secondPlanId);

        await postUncheckAll(fixture.planId).expect(200);

        expect(await storedRows(fixture.secondPlanId)).toEqual(otherPlanBefore);
        expect(otherPlanBefore.filter((row) => row.is_checked)).toHaveLength(2);
        expect(otherPlanBefore.filter((row) => row.flagged_at !== null)).toHaveLength(1);
    });

    it('leaves the list fully shoppable again on the next read', async () => {
        await postUncheckAll(fixture.planId).expect(200);

        const list = await readList(fixture.planId);

        expect(list.checkedCount).toBe(0);
        expect(list.checkedItems).toEqual([]);
        expect(everyItem(list)).toHaveLength(LINES.length);
        expect(list.sections.flatMap((section) => section.items.map((item) => item.name)).sort()).toEqual(
            LINES.map((line) => line.name).sort(),
        );
        // Every flag went with the checks, so nothing is announced either.
        expect(list.banner).toBeNull();
    });

    it('refuses a malformed planId, naming the parameter', async () => {
        const response = await asUser(request.post(uncheckAllPath('not-a-uuid')), { uid: USER_ID }).expect(400);

        expect(response.body).toEqual({
            error: 'invalid_request',
            details: [{ field: 'planId', code: 'invalid_id' }],
        });
    });

    it('answers a foreign plan and an unknown plan identically, and writes nothing', async () => {
        await makeUser({ id: OTHER_USER_ID });
        await makePreferences(OTHER_USER_ID);
        const before = await storedRows();

        const foreign = await postUncheckAll(fixture.planId, OTHER_USER_ID).expect(404);
        const unknown = await postUncheckAll(UNKNOWN_ID).expect(404);

        expect(foreign.body).toEqual(unknown.body);
        expect(await storedRows()).toEqual(before);
    });

    it('refuses a superseded plan and an ended plan', async () => {
        await makeUser({ id: OTHER_USER_ID });
        await makePreferences(OTHER_USER_ID);
        const endedPlan = await makePlan(OTHER_USER_ID, {
            startDate: FIXTURE_ENDED_PLAN_START_DAY_KEY,
            slots: [],
        });

        const ended = await postUncheckAll(endedPlan.id, OTHER_USER_ID).expect(409);

        expect(ended.body).toEqual({ error: 'plan_not_active', reason: 'ended' });

        await prisma.meal_plans.update({ where: { id: fixture.planId }, data: { status: 'superseded' } });
        const successor = await makePlan(USER_ID, {
            startDate: weekOffsetDayKey(14),
            slots: [],
            replaced_plan_id: fixture.planId,
        });

        const superseded = await postUncheckAll(fixture.planId).expect(409);

        expect(superseded.body).toEqual({ error: 'plan_not_active', replacementPlanId: successor.id });
        // The checks the refusal did not clear are still there.
        expect((await storedRows()).filter((row) => row.is_checked)).toHaveLength(2);
    });
});

/* ---------------------------------------------------------------------------
 * The list a week of meals implies
 *
 * Everything above reads a list this file inserted. This describe publishes a
 * real week and lets the production builder derive the list from it, which is
 * the only way to prove note 37:157's promise — "amounts combined across the
 * week for planned portions" — end to end. The expectations are computed from
 * the seeded recipe data rather than restated, so the arithmetic is what is
 * being measured.
 * ------------------------------------------------------------------------- */

describe('the list aggregated from planned portions', () => {
    /** Two servings per recipe, so the per-serving divisor is not 1. */
    const YIELD_SERVINGS = 2;

    /** Grams of each ingredient in the WHOLE recipe, before the yield divides it. */
    const SPINACH_PER_RECIPE = 300;
    const RICE_DRY_PER_RECIPE = 200;
    const RICE_COOKED_PER_RECIPE = 500;

    /** The lunch slot is planned at a portion other than one serving. */
    const LUNCH_MULTIPLIER = 1.5;

    /** `gram_weight ÷ yield_servings × portion_multiplier`, the §0.7.3 formula. */
    const plannedGrams = (gramWeightPerRecipe: number, portionMultiplier: number): number =>
        (gramWeightPerRecipe / YIELD_SERVINGS) * portionMultiplier;

    interface PlannedWorld {
        planId: string;
        spinachId: string;
        riceDryId: string;
        riceCookedId: string;
        unusedId: string;
    }

    let world: PlannedWorld;

    beforeEach(async () => {
        // Two foods sharing the base name "Rice" in two states, which is what
        // makes the coexistence naming rule and the `(food, state)` aggregation
        // key observable on a list the builder produced.
        const spinach = await makeCatalogFood({
            display_name: 'Spinach',
            category: 'produce_vegetable',
            food_state: 'raw',
            defaultPortion: gramPortion,
        });
        const riceDry = await makeCatalogFood({
            display_name: 'Rice',
            category: 'grain',
            food_state: 'dry',
            defaultPortion: gramPortion,
        });
        const riceCooked = await makeCatalogFood({
            display_name: 'Rice',
            category: 'grain',
            food_state: 'cooked',
            defaultPortion: gramPortion,
        });
        // Published, eligible, and planned by nothing.
        const unused = await makeCatalogFood({
            display_name: 'Unplanned Lentils',
            category: 'legume',
            food_state: 'dry',
            defaultPortion: gramPortion,
        });

        const ingredient = (food: catalog_foods, gramWeight: number) => ({
            catalogFoodId: food.id,
            gram_weight: gramWeight,
            quantity: gramWeight,
            unit: 'g',
            display_text: `${gramWeight} g`,
        });

        // Spinach is in BOTH recipes, so its line has two contributors and the
        // single-row-per-identity claim has something to fail.
        const breakfast = await makeRecipeVersion({
            slug: 'grocery-suite-planned-breakfast',
            name: 'Spinach And Dry Rice',
            catalogFoodId: spinach.id,
            yield_servings: YIELD_SERVINGS,
            ingredients: [ingredient(spinach, SPINACH_PER_RECIPE), ingredient(riceDry, RICE_DRY_PER_RECIPE)],
        });
        const lunch = await makeRecipeVersion({
            slug: 'grocery-suite-planned-lunch',
            name: 'Spinach And Cooked Rice',
            catalogFoodId: spinach.id,
            yield_servings: YIELD_SERVINGS,
            ingredients: [ingredient(spinach, SPINACH_PER_RECIPE), ingredient(riceCooked, RICE_COOKED_PER_RECIPE)],
        });

        // Its own week: the shared fixture already holds the current week and
        // the one after it, and the partial unique index on
        // `(user_id, start_date) WHERE status = 'active'` refuses a second
        // active plan starting on the same day. Every case here only READS the
        // list, so the week it sits in is immaterial.
        const plan = await makePlan(USER_ID, {
            startDate: weekOffsetDayKey(28),
            dayCount: 1,
            slots: [
                { slot: 'breakfast', slot_time: '08:00', recipeVersionId: breakfast.id },
                {
                    slot: 'lunch',
                    slot_time: '12:30',
                    recipeVersionId: lunch.id,
                    portion_multiplier: LUNCH_MULTIPLIER,
                },
            ],
        });

        await prisma.$transaction(async (tx) => {
            await rebuildPlanGroceries(tx, {
                userId: USER_ID,
                planId: plan.id,
                meals: await loadPlannedMealsForGroceries(tx, USER_ID, plan.id),
                now: new Date(),
            });
        });

        world = {
            planId: plan.id,
            spinachId: spinach.id,
            riceDryId: riceDry.id,
            riceCookedId: riceCooked.id,
            unusedId: unused.id,
        };
    });

    it('sums each ingredient across the week by gram weight, yield and portion', async () => {
        const list = await readList(world.planId);
        const byFoodId = new Map(everyItem(list).map((item) => [item.catalogFoodId, item]));

        // Spinach is planned twice — once at one serving and once at 1.5 — so
        // its line is the sum of both contributions and nothing else.
        expect(byFoodId.get(world.spinachId)?.quantityGrams).toBe(
            plannedGrams(SPINACH_PER_RECIPE, 1) + plannedGrams(SPINACH_PER_RECIPE, LUNCH_MULTIPLIER),
        );
        expect(byFoodId.get(world.riceDryId)?.quantityGrams).toBe(plannedGrams(RICE_DRY_PER_RECIPE, 1));
    });

    it('scales a contribution by its portion multiplier', async () => {
        const list = await readList(world.planId);
        const cooked = everyItem(list).find((item) => item.catalogFoodId === world.riceCookedId);

        // 500 g of a two-serving recipe planned at 1.5 servings is 375 g, not
        // the 250 g one serving would need.
        expect(cooked?.quantityGrams).toBe(plannedGrams(RICE_COOKED_PER_RECIPE, LUNCH_MULTIPLIER));
        expect(cooked?.quantityGrams).not.toBe(plannedGrams(RICE_COOKED_PER_RECIPE, 1));
    });

    it('keeps one row per (food, state) however many meals contribute', async () => {
        const rows = await storedRows(world.planId);
        const identities = rows.map((row) => `${row.catalog_food_id}:${row.food_state}`);

        // `UNIQUE (meal_plan_id, catalog_food_id, food_state)` in practice: the
        // two spinach contributions are one line, not two.
        expect(new Set(identities).size).toBe(identities.length);
        expect(rows.filter((row) => row.catalog_food_id === world.spinachId)).toHaveLength(1);
        expect(rows).toHaveLength(3);
    });

    it('gives one food in two states two independent lines, each qualified by its state', async () => {
        const list = await readList(world.planId);
        const rice = everyItem(list).filter((item) => item.name.startsWith('Rice'));

        // The builder — not the fixture — derived these names: while one base
        // name is on the list in more than one state, every one of its rows is
        // qualified, which is what keeps the two lines distinguishable.
        expect(rice).toHaveLength(2);
        expect(rice.map((item) => `${item.name} (${item.foodState})`).sort()).toEqual([
            'Rice, cooked (cooked)',
            'Rice, dry (dry)',
        ]);
        expect(rice.find((item) => item.foodState === 'dry')?.quantityGrams).toBe(
            plannedGrams(RICE_DRY_PER_RECIPE, 1),
        );
        expect(rice.find((item) => item.foodState === 'cooked')?.quantityGrams).toBe(
            plannedGrams(RICE_COOKED_PER_RECIPE, LUNCH_MULTIPLIER),
        );
    });

    it('renders every derived amount as a measure, never as a container', async () => {
        const list = await readList(world.planId);

        // The counterpart of the same claim in the GET describe, and the
        // stronger half: there the strings were stored by the fixture and the
        // mapper passed them through, while here `units.ts` DERIVED them from
        // grams. Synthesising "1 bottle" could only happen on this path, which
        // is why §0.1.4 treats the mockup's bottle as sample data and fixes the
        // contract as measured quantities.
        for (const item of everyItem(list)) {
            expect(item.displayText).not.toMatch(/bottle|pack|can\b|carton|jar|bag|box/i);
            expect(item.displayText).toMatch(/^[\d¼½¾.]+ (g|oz|lb|ml|tbsp|cups?)$/);
        }
    });

    it('shops for nothing no meal uses', async () => {
        const list = await readList(world.planId);

        expect(everyItem(list).map((item) => item.catalogFoodId)).not.toContain(world.unusedId);
        expect(await prisma.grocery_items.count({ where: { catalog_food_id: world.unusedId } })).toBe(0);
    });

    it('files every derived line in the aisle its catalog category maps to', async () => {
        const list = await readList(world.planId);

        // Aisles are derived from the catalog category by the builder here,
        // rather than stored by the fixture: `produce_*` → produce, `grain` →
        // grains & bread.
        expect(list.sections.map((section) => section.category)).toEqual(['produce', 'grains_bread']);
        expect(list.sections.map((section) => section.items.map((item) => item.name))).toEqual([
            ['Spinach'],
            ['Rice, cooked', 'Rice, dry'],
        ]);
    });
});

/* ---------------------------------------------------------------------------
 * Ownership, the capability gate, and what a refusal may say
 * ------------------------------------------------------------------------- */

describe('ownership and the capability gate', () => {
    describe('with meal planning switched off', () => {
        /**
         * `featureFlags.ts` reads `MEAL_PLANNING_ENABLED` ONCE at import and
         * exposes it behind an accessor (Rule §9), so mutating `process.env`
         * here would change nothing. The accessor is therefore the lever, and it
         * is restored in `afterEach` so the neighbouring suites — which run in
         * the same process under `--runInBand` — are unaffected.
         */
        beforeEach(() => {
            jest.spyOn(featureFlags, 'isMealPlanningEnabled').mockReturnValue(false);
        });

        afterEach(() => {
            jest.restoreAllMocks();
            expect(featureFlags.isMealPlanningEnabled()).toBe(true);
        });

        it('answers all three endpoints with the capability code', async () => {
            const read = await getList(fixture.planId).expect(503);
            const toggle = await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(503);
            const uncheckAll = await postUncheckAll(fixture.planId).expect(503);

            for (const body of [read.body, toggle.body, uncheckAll.body]) {
                expect(body).toEqual({ error: 'feature_disabled' });
            }
        });

        it('writes nothing while it is off', async () => {
            const before = await storedRows();

            await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(503);
            await postUncheckAll(fixture.planId).expect(503);

            expect(await storedRows()).toEqual(before);
        });
    });

    it('never lets one user reach another user\'s rows', async () => {
        await makeUser({ id: OTHER_USER_ID });
        await makePreferences(OTHER_USER_ID);
        const before = await storedRows();

        await getList(fixture.planId, OTHER_USER_ID).expect(404);
        await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }, OTHER_USER_ID).expect(404);
        await postUncheckAll(fixture.planId, OTHER_USER_ID).expect(404);

        // Read back directly: every `where` carries the owner key, including on
        // the updates (Rule §5.1), so not one row may have moved.
        expect(await storedRows()).toEqual(before);
    });

    it("refuses another user's item nested under the caller's own plan, leaving that item alone", async () => {
        await makeUser({ id: OTHER_USER_ID });
        await makePreferences(OTHER_USER_ID);
        const otherPlan = await makePlan(OTHER_USER_ID, { slots: [] });
        const food = await makeLineFood(LINES[0]);
        const otherRow = await prisma.grocery_items.create({
            data: {
                meal_plan_id: otherPlan.id,
                user_id: OTHER_USER_ID,
                catalog_food_id: food.id,
                food_state: 'raw',
                category: 'produce',
                name: 'Spinach',
                quantity_grams: 200,
                display_quantity: 7.1,
                display_unit: 'oz',
                display_text: '7.1 oz',
                is_checked: false,
                sort_order: 0,
            },
        });

        // The nested shape specifically: a real item id of a real row, addressed
        // through a plan the caller does own. The exhaustive route-by-id matrix
        // is `api/ownership.test.ts`'s; this is the local proof.
        const nested = await putItem(fixture.planId, otherRow.id, { isChecked: true }).expect(404);
        const unknown = await putItem(fixture.planId, UNKNOWN_ID, { isChecked: true }).expect(404);

        expect(nested.body).toEqual(unknown.body);
        expect((await prisma.grocery_items.findUniqueOrThrow({ where: { id: otherRow.id } })).is_checked).toBe(false);
    });

    it('ignores a userId in the body', async () => {
        await makeUser({ id: OTHER_USER_ID });
        await makePreferences(OTHER_USER_ID);

        // `getUserId(req)` reads the verified token claims and nothing else
        // (Rule §4), so a body field naming another user is inert rather than
        // an escalation.
        const response = await putItem(fixture.planId, itemId('Spinach'), {
            isChecked: true,
            userId: OTHER_USER_ID,
        }).expect(200);

        expect((response.body as ToggleGroceryItemResponse).item.isChecked).toBe(true);
        expect((await storedRow('Spinach')).user_id).toBe(USER_ID);
        expect(await prisma.grocery_items.count({ where: { user_id: OTHER_USER_ID } })).toBe(0);
    });

    it('never answers 403, and never leaks an error object, a stack or Prisma text', async () => {
        await makeUser({ id: OTHER_USER_ID });
        await makePreferences(OTHER_USER_ID);
        await prisma.meal_plans.update({ where: { id: fixture.secondPlanId }, data: { status: 'superseded' } });
        await makePlan(USER_ID, {
            startDate: weekOffsetDayKey(14),
            slots: [],
            replaced_plan_id: fixture.secondPlanId,
        });

        const refusals = [
            await getList(fixture.planId, OTHER_USER_ID),
            await getList(UNKNOWN_ID),
            await asUser(request.get(groceriesPath('not-a-uuid')), { uid: USER_ID }),
            await putItem(fixture.planId, 'not-a-uuid', { isChecked: true }),
            await putItem(fixture.planId, itemId('Spinach'), { isChecked: 'yes' }),
            await putItem(fixture.planId, itemId('Spinach'), {}),
            await putItem(fixture.planId, UNKNOWN_ID, { isChecked: true }),
            await putItem(fixture.secondPlanId, UNKNOWN_ID, { isChecked: true }),
            await postUncheckAll(fixture.secondPlanId),
            await asUser(request.post(uncheckAllPath('not-a-uuid')), { uid: USER_ID }),
        ];

        for (const refusal of refusals) {
            expect(refusal.status).toBeGreaterThanOrEqual(400);
            // Cross-user access is 404, never 403: a 403 would confirm the
            // resource exists (Rule §1.5).
            expect(refusal.status).not.toBe(403);
            // And never a 500: every refusal here is a case the handlers
            // recognise and answer with a code.
            expect(refusal.status).toBeLessThan(500);

            const serialised = JSON.stringify(refusal.body);

            expect(typeof refusal.body.error).toBe('string');
            expect(Object.keys(refusal.body)).not.toContain('stack');
            // `{ error: err }` is the anti-pattern Rule §4 names as the one to
            // fix rather than follow, and Prisma's own prose names columns and
            // constraints a client has no business reading.
            expect(serialised).not.toMatch(/PrismaClient|prisma\.|Invalid `|\\n {4}at |node_modules/);
            expect(serialised).not.toMatch(/grocery_items|meal_plans\b|meal_plan_id|user_id/);
        }
    });

    it('reports a status, a machine code and its payload, never an error class', async () => {
        await prisma.meal_plans.update({ where: { id: fixture.planId }, data: { status: 'superseded' } });
        const successor = await makePlan(USER_ID, {
            startDate: weekOffsetDayKey(14),
            slots: [],
            replaced_plan_id: fixture.planId,
        });

        const response = await putItem(fixture.planId, itemId('Spinach'), { isChecked: true }).expect(409);

        // `mealPlanning.errors.ts` is deliberately status-free — the controller
        // owns the mapping (Rule §8) — so the client reads a code and a payload
        // and never a class name.
        expect(response.body).toEqual({ error: 'plan_not_active', replacementPlanId: successor.id });
        expect(JSON.stringify(response.body)).not.toMatch(/PlanNotActiveError|PlanNotFoundError|Error/);
    });
});
