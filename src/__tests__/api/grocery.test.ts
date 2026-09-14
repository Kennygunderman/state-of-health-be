// The database-backed proof for the weekly grocery list and its two check-mark
// writes (Agent Action Plan §0.5.1 "Grocery writes", §0.5.2's three
// `…/groceries*` rows, §0.7.3's numeric and display contract, §0.9.2's
// `api/grocery.test.ts` row).
//
// WHICH LAYER THIS SUITE DRIVES, AND WHY. It calls `grocery.service.ts`
// (`getGroceryList`, `toggleGroceryItem`, `uncheckAllGroceries`) DIRECTLY,
// against real PostgreSQL, and makes no HTTP request. At this checkpoint the
// meal-planning HTTP boundary does not exist — there is no
// `src/routes/mealPlanning.routes.ts`, no
// `src/controllers/mealPlanning.controller.ts`, and `src/app.ts` mounts neither
// — so a supertest call against `/api/meal-planning/...` would answer 404 and
// prove only that the route is absent. What §0.5.1 promises about a check mark
// (one transaction, the per-user advisory lock, NO idempotency key, NO expected
// revision, and above all no bump of `meal_plans.revision`) lives in the
// service, so the service is where it is provable today. When the routes land,
// the request-level cases — the `invalid_request` bodies from
// `parseGroceryItemPath`/`parseToggleGroceryBody`, the status codes, the
// `503 feature_disabled` gate — are added to THIS file beside what is here.
//
// WHAT EVERY CASE ASSERTS AGAINST. The stored rows after the call, not just the
// returned DTO: a toggle that answers `isChecked: true` over a row it never
// wrote is exactly the failure this suite exists to catch. The plan's own
// `revision` is read before AND after every write, because "a check mark is not
// a plan change" is an assertion about a number that must NOT move.
//
// WHY THE ROWS ARE INSERTED HERE RATHER THAN BUILT BY A FACTORY.
// `src/__tests__/setup/factories.ts` has no grocery factory — the list is
// normally written by a plan publication or by a swap's rebuild — and the states
// this suite needs are precisely the ones a freshly published list never has: a
// row already checked, and a row checked AND flagged with an acknowledged
// baseline behind it. So the rows are inserted directly, with `display_*` values
// stated literally (100 g → "3.5 oz", 200 g → "7.1 oz", 400 g → "14.1 oz", the
// mass tiering `utils/units.ts` documents) so that every string the assertions
// read is a value this file states rather than one it recomputes with the code
// under test. `api/swaps.test.ts` covers the other direction — a list the
// production builder produced and a real diff applied to it.
//
// THE CLOCK IS PINNED. Every entry point takes `now` last, so the suite passes
// fixed instants: `checked_at` and `flagged_at` are exactly assertable, and the
// ended-plan refusal is reached by judging the same plan at a later instant
// rather than by editing stored dates.

import { Prisma, catalog_foods } from '../../generated/prisma';
import { prisma } from '../../prisma/client';
import { getGroceryList, toggleGroceryItem, uncheckAllGroceries } from '../../services/grocery.service';
import { PlanNotFoundError } from '../../services/mealPlanning.errors';
import { FIXTURE_USER_TARGET_COLUMNS, makeCatalogFood, makePlan, makePreferences, makeUser } from '../setup/factories';
import { truncateFeatureTables } from '../setup/testDb';

const USER_ID = 'grocery-suite-user';
const OTHER_USER_ID = 'grocery-suite-other-user';

/** The current plan's first day; `NOW` falls inside it in the user's zone. */
const PLAN_START_DAY_KEY = '2026-06-08';
const PLAN_END_DAY_KEY = '2026-06-14';

/** The plan that starts the week after — used only to prove write scoping. */
const SECOND_PLAN_START_DAY_KEY = '2026-06-15';

/** 11:00 in `America/New_York`, the zone `makePreferences` stores. */
const NOW = new Date('2026-06-10T15:00:00.000Z');

/** Two earlier instants, so a write's own timestamp is distinguishable. */
const CHECKED_AT = new Date('2026-06-09T15:00:00.000Z');
const FLAGGED_AT = new Date('2026-06-09T18:00:00.000Z');

/** After `PLAN_END_DAY_KEY`: the same plan, now ended for every write rule. */
const AFTER_THE_PLAN_ENDED = new Date('2026-06-20T15:00:00.000Z');

/** `makePlan` publishes at revision 1, and no grocery write may move it. */
const PLAN_REVISION = 1;

/** A UUID v4 that is not any row's id. */
const UNKNOWN_ITEM_ID = '33333333-3333-4333-8333-333333333333';

/**
 * One shopping line as this suite inserts it: the amount in grams beside the
 * three `display_*` values that render it, so no assertion below has to
 * recompute a string with the formatter it is testing.
 */
interface FixtureLine {
    readonly name: string;
    readonly aisle: string;
    readonly grams: number;
    readonly displayQuantity: number;
    readonly displayText: string;
    readonly isChecked: boolean;
    /** The last amount the shopper acknowledged; null when nothing is outstanding. */
    readonly acknowledgedGrams: number | null;
    readonly flaggedAt: Date | null;
}

const MASS_DISPLAY_UNIT = 'oz';

const LINES: readonly FixtureLine[] = [
    {
        name: 'Spinach',
        aisle: 'produce',
        grams: 200,
        displayQuantity: 7.1,
        displayText: '7.1 oz',
        isChecked: false,
        acknowledgedGrams: null,
        flaggedAt: null,
    },
    {
        name: 'Tofu',
        aisle: 'protein',
        grams: 400,
        displayQuantity: 14.1,
        displayText: '14.1 oz',
        isChecked: false,
        acknowledgedGrams: null,
        flaggedAt: null,
    },
    {
        name: 'Rice',
        aisle: 'grains_bread',
        grams: 200,
        displayQuantity: 7.1,
        displayText: '7.1 oz',
        isChecked: true,
        acknowledgedGrams: 200,
        flaggedAt: null,
    },
    {
        // The 14b state: an amount that went up on something already checked.
        name: 'Beans',
        aisle: 'pantry_other',
        grams: 400,
        displayQuantity: 14.1,
        displayText: '14.1 oz',
        isChecked: true,
        acknowledgedGrams: 100,
        flaggedAt: FLAGGED_AT,
    },
    {
        name: 'Olive Oil',
        aisle: 'pantry_other',
        grams: 100,
        displayQuantity: 3.5,
        displayText: '3.5 oz',
        isChecked: false,
        acknowledgedGrams: null,
        flaggedAt: null,
    },
];

interface SuiteFixture {
    planId: string;
    /** A second plan of the SAME user, so scoping is provable. */
    secondPlanId: string;
    /** Row ids of the current plan's list, keyed by the line's name. */
    itemIdsByName: Map<string, string>;
    /** Row ids of the second plan's list, keyed the same way. */
    secondPlanItemIdsByName: Map<string, string>;
}

let fixture: SuiteFixture;

/**
 * A food whose default portion is stated in GRAMS.
 *
 * `makeCatalogFood`'s own default portion is "1 cup" — a VOLUME unit — and its
 * `density_g_per_ml` is null, the combination `utils/units.ts` refuses because
 * millilitres never equal grams. A flagged row renders its "was Y" through these
 * facts, so a food without a mass portion could not be read back at all.
 */
const makeShoppableFood = async (displayName: string): Promise<catalog_foods> =>
    makeCatalogFood({
        display_name: displayName,
        food_state: 'raw',
        defaultPortion: { description: '1 portion', amount: 100, unit: 'g', gram_weight: 100 },
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
                food_state: food.food_state,
                category: line.aisle,
                name: line.name,
                quantity_grams: line.grams,
                display_quantity: line.displayQuantity,
                display_unit: MASS_DISPLAY_UNIT,
                display_text: line.displayText,
                is_checked: line.isChecked,
                checked_at: line.isChecked ? CHECKED_AT : null,
                previous_quantity_grams: line.acknowledgedGrams,
                flagged_at: line.flaggedAt,
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
        foodsByName.set(line.name, await makeShoppableFood(line.name));
    }

    // `slots: []` publishes a plan with days and no meals: this suite asserts on
    // the stored list, never on the week that produced it, so planning a recipe
    // into every slot would only add rows nothing here reads.
    const plan = await makePlan(USER_ID, {
        startDate: PLAN_START_DAY_KEY,
        slots: [],
    });
    const secondPlan = await makePlan(USER_ID, {
        startDate: SECOND_PLAN_START_DAY_KEY,
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
            LINES.filter((line) => line.name === 'Rice' || line.name === 'Beans'),
        ),
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
        where: { meal_plan_id: planId, user_id: USER_ID },
        orderBy: [{ sort_order: 'asc' }, { id: 'asc' }],
    });

const storedRow = (name: string): Promise<StoredGroceryRow> =>
    prisma.grocery_items.findUniqueOrThrow({ where: { id: itemId(name) } });

const planRevision = async (planId: string = fixture.planId): Promise<number> =>
    (await prisma.meal_plans.findUniqueOrThrow({ where: { id: planId }, select: { revision: true } })).revision;

/** A `NUMERIC(10,2)` column as a number, so amounts compare as amounts. */
const grams = (value: Prisma.Decimal | null): number | null => (value === null ? null : value.toNumber());

beforeEach(async () => {
    await truncateFeatureTables();
    fixture = await seedFixture();
});

afterAll(async () => {
    await truncateFeatureTables();
});

/* ---------------------------------------------------------------------------
 * Reading the list
 * ------------------------------------------------------------------------- */

describe('the grocery list read', () => {
    it('returns the aisle sections in store order, with the unchecked rows only', async () => {
        const list = await getGroceryList(USER_ID, fixture.planId, NOW);

        // `grains_bread` is absent because its only row is checked, and
        // `pantry_other` closes the list: the aisle order is a rule, not the
        // order the rows were inserted in.
        expect(list.sections.map((section) => section.category)).toEqual(['produce', 'protein', 'pantry_other']);
        expect(list.sections.flatMap((section) => section.items.map((item) => item.name))).toEqual([
            'Spinach',
            'Tofu',
            'Olive Oil',
        ]);
        expect(list.sections[0].items[0]).toMatchObject({
            name: 'Spinach',
            quantityGrams: 200,
            displayText: '7.1 oz',
            isChecked: false,
            flag: null,
        });
    });

    it('holds the checked rows apart, flagged first, and counts the whole list', async () => {
        const list = await getGroceryList(USER_ID, fixture.planId, NOW);

        expect(list.checkedItems.map((item) => item.name)).toEqual(['Beans', 'Rice']);
        // The eyebrow reads "2 of 5 checked", so the total spans the checked
        // rows as well as the visible sections.
        expect(list.totalCount).toBe(5);
        expect(list.checkedCount).toBe(2);
    });

    it("carries the plan's own identity, revision and week", async () => {
        const list = await getGroceryList(USER_ID, fixture.planId, NOW);

        expect(list.planId).toBe(fixture.planId);
        expect(list.planRevision).toBe(PLAN_REVISION);
        expect(list.startDate).toBe(PLAN_START_DAY_KEY);
        expect(list.endDate).toBe(PLAN_END_DAY_KEY);
    });

    it('renders a flagged row against the amount the shopper acknowledged', async () => {
        const list = await getGroceryList(USER_ID, fixture.planId, NOW);
        const flagged = list.checkedItems[0];

        expect(flagged.name).toBe('Beans');
        expect(flagged.isChecked).toBe(true);
        expect(flagged.flag).toEqual({
            // 100 g is what was acknowledged; 400 g is what the week now needs.
            previousDisplayText: '3.5 oz',
            newDisplayText: '14.1 oz',
            deltaDisplayText: '+10.6 oz',
            flaggedAt: FLAGGED_AT.toISOString(),
        });
        // A flag outranks a swap notice, and no swap has run here anyway.
        expect(list.banner).toEqual({ code: 'amount_increased', itemNames: ['Beans'] });
    });

    it('announces nothing for a list with no flag', async () => {
        await prisma.grocery_items.updateMany({
            where: { meal_plan_id: fixture.planId },
            data: { flagged_at: null },
        });

        expect((await getGroceryList(USER_ID, fixture.planId, NOW)).banner).toBeNull();
    });

    it('answers a plan that needs no ingredients with an empty list rather than a failure', async () => {
        const list = await getGroceryList(USER_ID, fixture.secondPlanId, NOW);

        await prisma.grocery_items.deleteMany({ where: { meal_plan_id: fixture.secondPlanId } });

        const emptied = await getGroceryList(USER_ID, fixture.secondPlanId, NOW);

        expect(list.totalCount).toBe(2);
        expect(emptied.sections).toEqual([]);
        expect(emptied.checkedItems).toEqual([]);
        expect(emptied.totalCount).toBe(0);
        expect(emptied.checkedCount).toBe(0);
        expect(emptied.banner).toBeNull();
    });

    it('stays readable for a plan that has ended, which the writes refuse', async () => {
        // §0.5.2 lists no `plan_not_active` for this route: a client holding last
        // week's plan can still show what it shopped for.
        const list = await getGroceryList(USER_ID, fixture.planId, AFTER_THE_PLAN_ENDED);

        expect(list.totalCount).toBe(5);
        await expect(
            toggleGroceryItem(USER_ID, fixture.planId, itemId('Spinach'), { isChecked: true }, AFTER_THE_PLAN_ENDED),
        ).rejects.toMatchObject({ name: 'PlanNotActiveError', data: { reason: 'ended' } });
    });

    it('answers a foreign plan and an unknown plan with the same not-found', async () => {
        await makeUser({ id: OTHER_USER_ID });

        await expect(getGroceryList(OTHER_USER_ID, fixture.planId, NOW)).rejects.toThrow(PlanNotFoundError);
        await expect(getGroceryList(USER_ID, UNKNOWN_ITEM_ID, NOW)).rejects.toThrow(PlanNotFoundError);
    });
});

/* ---------------------------------------------------------------------------
 * One check mark
 * ------------------------------------------------------------------------- */

describe('setting one row\'s check mark', () => {
    it('persists the check, its instant and the amount it acknowledges', async () => {
        const response = await toggleGroceryItem(USER_ID, fixture.planId, itemId('Spinach'), { isChecked: true }, NOW);
        const row = await storedRow('Spinach');

        expect(row.is_checked).toBe(true);
        expect(row.checked_at).toEqual(NOW);
        // Checking records the amount visible at that moment as the new
        // yardstick, so a later increase is measured from what was seen.
        expect(grams(row.previous_quantity_grams)).toBe(200);
        expect(row.flagged_at).toBeNull();
        expect(response.item).toMatchObject({ id: row.id, isChecked: true, flag: null });
        // Counted from the rows rather than adjusted arithmetically.
        expect(response.checkedCount).toBe(3);
    });

    it('does not bump the plan revision, because a check mark is not a plan change', async () => {
        const before = await planRevision();

        await toggleGroceryItem(USER_ID, fixture.planId, itemId('Spinach'), { isChecked: true }, NOW);

        expect(await planRevision()).toBe(before);
        expect(before).toBe(PLAN_REVISION);
    });

    it('clears a flag and resets the baseline when the row is unchecked', async () => {
        const response = await toggleGroceryItem(USER_ID, fixture.planId, itemId('Beans'), { isChecked: false }, NOW);
        const row = await storedRow('Beans');

        expect(row.is_checked).toBe(false);
        expect(row.checked_at).toBeNull();
        // Nothing is outstanding to compare against once the row is unchecked.
        expect(grams(row.previous_quantity_grams)).toBeNull();
        expect(row.flagged_at).toBeNull();
        expect(response.item.flag).toBeNull();
        expect(response.checkedCount).toBe(1);
        expect(await planRevision()).toBe(PLAN_REVISION);
    });

    it('clears a flag and re-acknowledges the current amount when the row is checked again', async () => {
        const response = await toggleGroceryItem(USER_ID, fixture.planId, itemId('Beans'), { isChecked: true }, NOW);
        const row = await storedRow('Beans');

        expect(row.is_checked).toBe(true);
        expect(row.checked_at).toEqual(NOW);
        // Either direction acknowledges what the row is showing: the shopper has
        // just seen 400 g, so that is the new yardstick.
        expect(grams(row.previous_quantity_grams)).toBe(400);
        expect(row.flagged_at).toBeNull();
        expect(response.item.flag).toBeNull();
        expect(response.checkedCount).toBe(2);
    });

    it('takes both of two opposite toggles, last write wins', async () => {
        const later = new Date(NOW.getTime() + 60_000);

        // The body names the desired state rather than asking for a flip, and
        // the write carries no idempotency key and no expected revision (§0.5.1)
        // — so two successive writes simply both take effect.
        const checked = await toggleGroceryItem(USER_ID, fixture.planId, itemId('Spinach'), { isChecked: true }, NOW);

        expect((await storedRow('Spinach')).is_checked).toBe(true);

        const unchecked = await toggleGroceryItem(
            USER_ID,
            fixture.planId,
            itemId('Spinach'),
            { isChecked: false },
            later,
        );
        const row = await storedRow('Spinach');

        expect(checked.checkedCount).toBe(3);
        expect(unchecked.checkedCount).toBe(2);
        expect(row.is_checked).toBe(false);
        expect(row.checked_at).toBeNull();
        expect(await planRevision()).toBe(PLAN_REVISION);
    });

    it('is repeatable: naming the state a row already holds changes nothing', async () => {
        await toggleGroceryItem(USER_ID, fixture.planId, itemId('Spinach'), { isChecked: true }, NOW);
        const afterFirst = await storedRow('Spinach');

        const repeated = await toggleGroceryItem(
            USER_ID,
            fixture.planId,
            itemId('Spinach'),
            { isChecked: true },
            NOW,
        );

        expect(await storedRow('Spinach')).toEqual(afterFirst);
        expect(repeated.checkedCount).toBe(3);
    });

    it('refuses a row of another plan, and one that does not exist, and writes nothing', async () => {
        const before = await storedRows();
        const secondPlanBefore = await storedRows(fixture.secondPlanId);
        const secondPlanRowId = fixture.secondPlanItemIdsByName.get('Rice');

        // The predicate is `{id, meal_plan_id, user_id}` in one statement, so a
        // row id belonging to another plan of the same user is not addressable
        // through this plan.
        await expect(
            toggleGroceryItem(USER_ID, fixture.planId, secondPlanRowId ?? UNKNOWN_ITEM_ID, { isChecked: true }, NOW),
        ).rejects.toThrow(PlanNotFoundError);
        await expect(
            toggleGroceryItem(USER_ID, fixture.planId, UNKNOWN_ITEM_ID, { isChecked: true }, NOW),
        ).rejects.toThrow(PlanNotFoundError);

        expect(await storedRows()).toEqual(before);
        // Nor was the row written through the plan it does belong to.
        expect(await storedRows(fixture.secondPlanId)).toEqual(secondPlanBefore);
        expect(await planRevision()).toBe(PLAN_REVISION);
    });

    it("refuses another user's row with the same not-found, and writes nothing", async () => {
        await makeUser({ id: OTHER_USER_ID });
        const before = await storedRows();

        await expect(
            toggleGroceryItem(OTHER_USER_ID, fixture.planId, itemId('Spinach'), { isChecked: true }, NOW),
        ).rejects.toThrow(PlanNotFoundError);

        expect(await storedRows()).toEqual(before);
    });

    it('refuses a superseded plan and names the plan that replaced it', async () => {
        const before = await storedRows();

        await prisma.meal_plans.update({ where: { id: fixture.planId }, data: { status: 'superseded' } });
        const successor = await makePlan(USER_ID, {
            startDate: PLAN_START_DAY_KEY,
            slots: [],
            replaced_plan_id: fixture.planId,
        });

        await expect(
            toggleGroceryItem(USER_ID, fixture.planId, itemId('Spinach'), { isChecked: true }, NOW),
        ).rejects.toMatchObject({ name: 'PlanNotActiveError', data: { replacementPlanId: successor.id } });

        expect(await storedRows()).toEqual(before);
    });
});

/* ---------------------------------------------------------------------------
 * Clearing every check mark
 * ------------------------------------------------------------------------- */

describe('clearing every check mark', () => {
    it('clears every check and every flag on the plan, and reports zero', async () => {
        const response = await uncheckAllGroceries(USER_ID, fixture.planId, NOW);
        const rows = await storedRows();

        expect(response).toEqual({ checkedCount: 0 });
        expect(rows).toHaveLength(5);
        expect(rows.map((row) => row.is_checked)).toEqual([false, false, false, false, false]);
        // The same statement clears checks and flags, so a flag can never be
        // left standing on a row whose check has just gone.
        expect(rows.map((row) => row.flagged_at)).toEqual([null, null, null, null, null]);
        expect(rows.map((row) => row.checked_at)).toEqual([null, null, null, null, null]);
        expect(rows.map((row) => grams(row.previous_quantity_grams))).toEqual([null, null, null, null, null]);
    });

    it('touches only that plan', async () => {
        const otherPlanBefore = await storedRows(fixture.secondPlanId);

        await uncheckAllGroceries(USER_ID, fixture.planId, NOW);

        expect(await storedRows(fixture.secondPlanId)).toEqual(otherPlanBefore);
        expect(otherPlanBefore.filter((row) => row.is_checked)).toHaveLength(2);
        expect(otherPlanBefore.filter((row) => row.flagged_at !== null)).toHaveLength(1);
    });

    it('leaves the plan revision alone', async () => {
        await uncheckAllGroceries(USER_ID, fixture.planId, NOW);

        expect(await planRevision()).toBe(PLAN_REVISION);
        expect(await planRevision(fixture.secondPlanId)).toBe(PLAN_REVISION);
    });

    it('is a no-op on a list that is already clear', async () => {
        await uncheckAllGroceries(USER_ID, fixture.planId, NOW);
        const afterFirst = await storedRows();

        const repeated = await uncheckAllGroceries(USER_ID, fixture.planId, NOW);

        expect(repeated).toEqual({ checkedCount: 0 });
        expect(await storedRows()).toEqual(afterFirst);
    });

    it('refuses an ended plan and a foreign plan, and writes nothing', async () => {
        await makeUser({ id: OTHER_USER_ID });
        const before = await storedRows();

        await expect(uncheckAllGroceries(USER_ID, fixture.planId, AFTER_THE_PLAN_ENDED)).rejects.toMatchObject({
            name: 'PlanNotActiveError',
            data: { reason: 'ended' },
        });
        await expect(uncheckAllGroceries(OTHER_USER_ID, fixture.planId, NOW)).rejects.toThrow(PlanNotFoundError);

        expect(await storedRows()).toEqual(before);
        expect(await planRevision()).toBe(PLAN_REVISION);
    });
});
