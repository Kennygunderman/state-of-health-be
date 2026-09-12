// Unit tests for the planned-meal logging rules. No database, no mocks, no
// clock: every rule in `plannedMealLog.logic.ts` takes the rows it judges as
// arguments, so each test states a whole scenario from object literals and
// asserts a returned value.
//
// The scenarios that matter most are the ones a future change could plausibly
// "simplify" away:
//
//  - THE ROUNDING CONTRACT's single rounding step. The suite asserts the three
//    steps against each other rather than against three hand-written numbers:
//    the planned portion stays unrounded, the snapshot rounds once, and a
//    consumed total scales the ROUNDED snapshot. A round-then-round or a
//    round-only-at-the-end regression breaks the cross-step assertions below,
//    which is exactly the disagreement the client's "This adds" card would show.
//  - THE TWO 404 PREDICATES, tested separately and then through
//    `requireLoggableTarget`, because dropping either is a real hole: one lets a
//    client write into another user's diary, the other files a Tuesday meal
//    under Monday's bucket.
//  - LOGGED STATE derived from the entries ALONE, including after two swaps,
//    which is the case a `previous_recipe_version_id` shortcut gets wrong.
//  - The calendar check inside the day-key rule, since '2026-02-30' matches the
//    shape and sorts inside a late-February plan week.
//
// Bounds and precision are expressed through the module's own exported
// constants wherever a test needs them, so a test can never disagree with the
// rule it exercises about what the contract is.

import {
    DiaryMealRow,
    EATEN_SERVINGS_DECIMALS,
    LOG_PLANNED_MEAL_FIELD_CODES,
    LinkedDiaryEntryRow,
    MAX_EATEN_SERVINGS,
    MIN_EATEN_SERVINGS,
    MIN_PLAN_REVISION,
    PLANNED_ENTRY_INPUT_METHOD,
    PLANNED_ENTRY_NUTRITION_PROVENANCE,
    PlanWeekRow,
    PlannedMealLogDataError,
    PlannedMealRow,
    PlannedRecipeVersionRow,
    deriveConsumedTotals,
    deriveLoggedStatus,
    derivePlannedPortion,
    derivePlannedServingText,
    derivePlannedSnapshot,
    isCalendarDayKey,
    isDateInPlanWeek,
    isDiaryMealAcceptable,
    isEatenServingsInContract,
    parseLogPlannedMealRequest,
    requireLoggableTarget,
} from '../plannedMealLog.logic';
import { PlanNotFoundError } from '../mealPlanning.errors';
import { RecipeDerivationError } from '../recipe.logic';

/* ---------------------------------------------------------------------------
 * Fixtures
 *
 * Deliberately awkward per-serving values: every one of the four macros lands
 * on a fraction once multiplied, so a missing or extra rounding step is visible
 * rather than hidden behind whole numbers.
 * ------------------------------------------------------------------------- */

const RECIPE_VERSION_ID = '8f14e45f-ceea-467a-94f4-0b0a8fa3ac2f';
const OTHER_RECIPE_VERSION_ID = 'c9f0f895-fb98-4b41-9b2a-7d0e5a1d3b7c';
const THIRD_RECIPE_VERSION_ID = 'd41d8cd9-8f00-4204-a980-0998ecf8427e';
const MEAL_ID = '45c48cce-2e2d-4fd8-a0a1-9c8a1b2c3d4e';
const DIARY_MEAL_ID = '6512bd43-d9ca-46da-a4d0-f0bcc51aa551';
const IDEMPOTENCY_KEY = 'c20ad4d7-6fe9-4779-a1a0-1a7b2c3d4e5f';
const USER_ID = 'firebase-uid-alice';
const OTHER_USER_ID = 'firebase-uid-bob';

const recipeVersion = (overrides: Partial<PlannedRecipeVersionRow> = {}): PlannedRecipeVersionRow => ({
    id: RECIPE_VERSION_ID,
    name: 'Chicken burrito bowl',
    serving_description: '1 bowl (350 g)',
    per_serving_calories: 610.4,
    per_serving_protein_g: 45.5,
    per_serving_carbs_g: 58.25,
    per_serving_fat_g: 21.7,
    ...overrides,
});

const plannedMeal = (overrides: Partial<PlannedMealRow> = {}): PlannedMealRow => ({
    id: MEAL_ID,
    recipe_version_id: RECIPE_VERSION_ID,
    portion_multiplier: 1,
    ...overrides,
});

const planWeek = (overrides: Partial<PlanWeekRow> = {}): PlanWeekRow => ({
    start_date: '2026-07-05',
    end_date: '2026-07-11',
    ...overrides,
});

const diaryMeal = (overrides: Partial<DiaryMealRow> = {}): DiaryMealRow => ({
    user_id: USER_ID,
    date: '2026-07-05',
    ...overrides,
});

const validBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    servings: 1,
    date: '2026-07-05',
    diaryMealId: DIARY_MEAL_ID,
    expectedPlanRevision: 3,
    idempotencyKey: IDEMPOTENCY_KEY,
    ...overrides,
});

/** The parsed payload, or a failure that names what the parser rejected. */
const parsedPayload = (body: unknown) => {
    const parsed = parseLogPlannedMealRequest(body);
    if (parsed.kind !== 'ok') {
        throw new Error(`expected a parsed payload, got ${JSON.stringify(parsed.details)}`);
    }

    return parsed.payload;
};

/** The details of a rejection, or a failure that says it was accepted. */
const rejectionDetails = (body: unknown) => {
    const parsed = parseLogPlannedMealRequest(body);
    if (parsed.kind !== 'error') {
        throw new Error('expected the parser to reject this body');
    }

    return parsed.details;
};

const codeFor = (body: unknown, field: string): string | undefined =>
    rejectionDetails(body).find((detail) => detail.field === field)?.code;

/* ---------------------------------------------------------------------------
 * The two stored facts
 * ------------------------------------------------------------------------- */

describe('the facts a planned entry carries', () => {
    it('records its origin as meal_plan, which is what earns the diary caption', () => {
        expect(PLANNED_ENTRY_INPUT_METHOD).toBe('meal_plan');
    });

    it('records its provenance as source_backed, independently of its origin', () => {
        expect(PLANNED_ENTRY_NUTRITION_PROVENANCE).toBe('source_backed');
        expect(PLANNED_ENTRY_NUTRITION_PROVENANCE).not.toBe(PLANNED_ENTRY_INPUT_METHOD);
    });
});

/* ---------------------------------------------------------------------------
 * isCalendarDayKey
 * ------------------------------------------------------------------------- */

describe('isCalendarDayKey', () => {
    it('accepts a day that exists', () => {
        expect(isCalendarDayKey('2026-07-05')).toBe(true);
        expect(isCalendarDayKey('2026-12-31')).toBe(true);
        expect(isCalendarDayKey('2026-01-01')).toBe(true);
    });

    it('accepts 29 February in a leap year and rejects it otherwise', () => {
        expect(isCalendarDayKey('2028-02-29')).toBe(true);
        expect(isCalendarDayKey('2026-02-29')).toBe(false);
    });

    it('rejects a well-shaped date that names no day', () => {
        // The case a shape-only check would let through: it sorts inside a late
        // February plan week, and `new Date` rolls it forward to 2 March.
        expect(isCalendarDayKey('2026-02-30')).toBe(false);
        expect(isCalendarDayKey('2026-13-01')).toBe(false);
        expect(isCalendarDayKey('2026-00-10')).toBe(false);
        expect(isCalendarDayKey('2026-04-31')).toBe(false);
        expect(isCalendarDayKey('2026-07-00')).toBe(false);
    });

    it('rejects anything that is not a YYYY-MM-DD string', () => {
        expect(isCalendarDayKey('2026-7-5')).toBe(false);
        expect(isCalendarDayKey('05/07/2026')).toBe(false);
        expect(isCalendarDayKey('2026-07-05T12:00:00.000Z')).toBe(false);
        expect(isCalendarDayKey('')).toBe(false);
        expect(isCalendarDayKey(20260705)).toBe(false);
        expect(isCalendarDayKey(null)).toBe(false);
        expect(isCalendarDayKey(undefined)).toBe(false);
        expect(isCalendarDayKey(new Date('2026-07-05T00:00:00.000Z'))).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * isEatenServingsInContract
 * ------------------------------------------------------------------------- */

describe('isEatenServingsInContract', () => {
    it('accepts both bounds, inclusive', () => {
        expect(isEatenServingsInContract(MIN_EATEN_SERVINGS)).toBe(true);
        expect(isEatenServingsInContract(MAX_EATEN_SERVINGS)).toBe(true);
    });

    it('rejects either side of the bounds', () => {
        expect(isEatenServingsInContract(MIN_EATEN_SERVINGS - 0.01)).toBe(false);
        expect(isEatenServingsInContract(MAX_EATEN_SERVINGS + 0.01)).toBe(false);
        expect(isEatenServingsInContract(0)).toBe(false);
        expect(isEatenServingsInContract(-1)).toBe(false);
    });

    it('accepts the two decimals the shipped fraction chips already store', () => {
        // 0.33 * 100 is 33.000000000000004, so an exact integer check on the
        // scaled value would reject a value the app has been storing for two
        // versions.
        expect(EATEN_SERVINGS_DECIMALS).toBe(2);
        expect(isEatenServingsInContract(0.33)).toBe(true);
        expect(isEatenServingsInContract(0.66)).toBe(true);
        expect(isEatenServingsInContract(1.25)).toBe(true);
        expect(isEatenServingsInContract(2.5)).toBe(true);
    });

    it('rejects a third decimal', () => {
        expect(isEatenServingsInContract(1.005)).toBe(false);
        expect(isEatenServingsInContract(0.333)).toBe(false);
    });

    it('rejects non-numbers and non-finite numbers', () => {
        expect(isEatenServingsInContract('1')).toBe(false);
        expect(isEatenServingsInContract(null)).toBe(false);
        expect(isEatenServingsInContract(undefined)).toBe(false);
        expect(isEatenServingsInContract(Number.NaN)).toBe(false);
        expect(isEatenServingsInContract(Number.POSITIVE_INFINITY)).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * Step 1 — the planned portion, unrounded
 * ------------------------------------------------------------------------- */

describe('derivePlannedPortion', () => {
    it('multiplies the per-serving values and rounds nothing', () => {
        const portion = derivePlannedPortion(plannedMeal({ portion_multiplier: 1.5 }), recipeVersion());

        expect(portion).toEqual({
            calories: 610.4 * 1.5,
            protein: 45.5 * 1.5,
            carbs: 58.25 * 1.5,
            fat: 21.7 * 1.5,
        });
        // Stated explicitly: an added Math.round here would be invisible in the
        // equality above if the fixture used whole numbers.
        expect(Number.isInteger(portion.calories)).toBe(false);
    });

    it('returns the recipe values unchanged at a multiplier of 1', () => {
        const version = recipeVersion();

        expect(derivePlannedPortion(plannedMeal(), version)).toEqual({
            calories: version.per_serving_calories,
            protein: version.per_serving_protein_g,
            carbs: version.per_serving_carbs_g,
            fat: version.per_serving_fat_g,
        });
    });

    it('refuses a recipe version the slot does not hold', () => {
        const call = () =>
            derivePlannedPortion(plannedMeal(), recipeVersion({ id: OTHER_RECIPE_VERSION_ID }));

        expect(call).toThrow(PlannedMealLogDataError);
        expect(call).toThrow(/is not the one planned for meal/);
        try {
            call();
        } catch (error) {
            expect((error as PlannedMealLogDataError).field).toBe('recipe_version_id');
        }
    });

    it('leaves a non-positive multiplier and an unusable nutrient to recipe.logic', () => {
        expect(() => derivePlannedPortion(plannedMeal({ portion_multiplier: 0 }), recipeVersion())).toThrow(
            RecipeDerivationError,
        );
        expect(() => derivePlannedPortion(plannedMeal({ portion_multiplier: -1 }), recipeVersion())).toThrow(
            RecipeDerivationError,
        );
        expect(() =>
            derivePlannedPortion(
                plannedMeal(),
                recipeVersion({ per_serving_protein_g: Number.NaN }),
            ),
        ).toThrow(RecipeDerivationError);
        expect(() =>
            derivePlannedPortion(plannedMeal(), recipeVersion({ per_serving_fat_g: -3 })),
        ).toThrow(RecipeDerivationError);
    });
});

/* ---------------------------------------------------------------------------
 * The serving label
 * ------------------------------------------------------------------------- */

describe('derivePlannedServingText', () => {
    it("uses the recipe's own description when the portion is one serving", () => {
        expect(derivePlannedServingText(plannedMeal(), recipeVersion())).toBe('1 bowl (350 g)');
    });

    it('shows the multiplier as a factor of the description, never folded into it', () => {
        // '1.5 bowl (350 g)' would restate a gram figure that did not scale.
        expect(derivePlannedServingText(plannedMeal({ portion_multiplier: 1.5 }), recipeVersion())).toBe(
            '1.5 × 1 bowl (350 g)',
        );
        expect(derivePlannedServingText(plannedMeal({ portion_multiplier: 0.5 }), recipeVersion())).toBe(
            '0.5 × 1 bowl (350 g)',
        );
        expect(derivePlannedServingText(plannedMeal({ portion_multiplier: 2 }), recipeVersion())).toBe(
            '2 × 1 bowl (350 g)',
        );
    });

    it('drops trailing zeros from the factor', () => {
        expect(derivePlannedServingText(plannedMeal({ portion_multiplier: 1.75 }), recipeVersion())).toBe(
            '1.75 × 1 bowl (350 g)',
        );
        expect(
            derivePlannedServingText(plannedMeal({ portion_multiplier: 1.2500001 }), recipeVersion()),
        ).toBe('1.25 × 1 bowl (350 g)');
    });

    it('trims a padded description', () => {
        expect(
            derivePlannedServingText(plannedMeal(), recipeVersion({ serving_description: '  1 wrap  ' })),
        ).toBe('1 wrap');
    });

    it('refuses a blank serving description', () => {
        const call = () =>
            derivePlannedServingText(plannedMeal(), recipeVersion({ serving_description: '   ' }));

        expect(call).toThrow(PlannedMealLogDataError);
        try {
            call();
        } catch (error) {
            expect((error as PlannedMealLogDataError).field).toBe('serving_description');
        }
    });

    it('refuses a portion multiplier that is not a positive finite number', () => {
        for (const multiplier of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const call = () =>
                derivePlannedServingText(plannedMeal({ portion_multiplier: multiplier }), recipeVersion());

            expect(call).toThrow(PlannedMealLogDataError);
            try {
                call();
            } catch (error) {
                expect((error as PlannedMealLogDataError).field).toBe('portion_multiplier');
            }
        }
    });
});

/* ---------------------------------------------------------------------------
 * Step 2 — the one rounding
 * ------------------------------------------------------------------------- */

describe('derivePlannedSnapshot', () => {
    it('rounds each macro exactly once, off the unrounded planned portion', () => {
        const meal = plannedMeal({ portion_multiplier: 1.5 });
        const version = recipeVersion();
        const planned = derivePlannedPortion(meal, version);

        const snapshot = derivePlannedSnapshot(meal, version);

        expect(snapshot.calories).toBe(Math.round(planned.calories));
        expect(snapshot.protein_g).toBe(Math.round(planned.protein));
        expect(snapshot.carbs_g).toBe(Math.round(planned.carbs));
        expect(snapshot.fat_g).toBe(Math.round(planned.fat));
        for (const value of [snapshot.calories, snapshot.protein_g, snapshot.carbs_g, snapshot.fat_g]) {
            expect(Number.isInteger(value)).toBe(true);
        }
    });

    it('carries the two links and the two independent facts, unmixed', () => {
        const snapshot = derivePlannedSnapshot(plannedMeal(), recipeVersion());

        expect(snapshot).toEqual({
            name: 'Chicken burrito bowl',
            serving_text: '1 bowl (350 g)',
            meal_plan_meal_id: MEAL_ID,
            recipe_version_id: RECIPE_VERSION_ID,
            calories: 610,
            protein_g: 46,
            carbs_g: 58,
            fat_g: 22,
            input_method: PLANNED_ENTRY_INPUT_METHOD,
            nutrition_provenance: PLANNED_ENTRY_NUTRITION_PROVENANCE,
        });
    });

    it('describes ONE stored serving as the planned portion', () => {
        const snapshot = derivePlannedSnapshot(plannedMeal({ portion_multiplier: 0.75 }), recipeVersion());

        expect(snapshot.serving_text).toBe('0.75 × 1 bowl (350 g)');
    });

    it('trims the recipe name and refuses a blank one', () => {
        expect(derivePlannedSnapshot(plannedMeal(), recipeVersion({ name: '  Tofu bowl ' })).name).toBe(
            'Tofu bowl',
        );

        const call = () => derivePlannedSnapshot(plannedMeal(), recipeVersion({ name: '' }));
        expect(call).toThrow(PlannedMealLogDataError);
        try {
            call();
        } catch (error) {
            expect((error as PlannedMealLogDataError).field).toBe('name');
        }
    });

    it('refuses a name that is not a string at all', () => {
        // Reachable only through an unchecked cast; the defensive arm keeps a
        // non-string out of the stored row instead of coercing it to '42'.
        expect(() =>
            derivePlannedSnapshot(plannedMeal(), recipeVersion({ name: 42 as unknown as string })),
        ).toThrow(PlannedMealLogDataError);
    });

    it('does not write to its arguments', () => {
        const meal = plannedMeal({ portion_multiplier: 1.25 });
        const version = recipeVersion();

        derivePlannedSnapshot(meal, version);

        expect(meal).toEqual(plannedMeal({ portion_multiplier: 1.25 }));
        expect(version).toEqual(recipeVersion());
    });

    it('refuses a recipe version the slot does not hold', () => {
        expect(() =>
            derivePlannedSnapshot(plannedMeal(), recipeVersion({ id: OTHER_RECIPE_VERSION_ID })),
        ).toThrow(PlannedMealLogDataError);
    });
});

/* ---------------------------------------------------------------------------
 * Step 3 — what was actually eaten
 * ------------------------------------------------------------------------- */

describe('deriveConsumedTotals', () => {
    it('equals the stored snapshot at one serving, so "1 serving" is the planned portion', () => {
        const snapshot = derivePlannedSnapshot(plannedMeal({ portion_multiplier: 1.5 }), recipeVersion());

        expect(deriveConsumedTotals(snapshot, 1)).toEqual({
            calories: snapshot.calories,
            protein: snapshot.protein_g,
            carbs: snapshot.carbs_g,
            fat: snapshot.fat_g,
        });
    });

    it('scales the ROUNDED snapshot, not the full-precision planned portion', () => {
        // Chosen so the two orders genuinely disagree: 121 × 0.5 plans 60.5,
        // which the snapshot rounds to 61, and half of that is 30.5 → 31, while
        // half of the unrounded 60.5 is 30.25 → 30. The client holds the
        // snapshot and nothing else, so 31 is the only answer its "This adds"
        // card can produce — a server that rounded after multiplying would say
        // 30 and the numbers on screen would not add up.
        const meal = plannedMeal({ portion_multiplier: 0.5 });
        const version = recipeVersion({ per_serving_protein_g: 121 });
        const planned = derivePlannedPortion(meal, version);
        const snapshot = derivePlannedSnapshot(meal, version);

        const totals = deriveConsumedTotals(snapshot, 0.5);

        expect(planned.protein).toBe(60.5);
        expect(snapshot.protein_g).toBe(61);
        expect(totals.protein).toBe(31);
        expect(Math.round(planned.protein * 0.5)).toBe(30);
        expect(Math.round(planned.protein * 0.5)).not.toBe(totals.protein);
    });

    it('rounds each value once at a fractional serving', () => {
        const snapshot = { calories: 611, protein_g: 45, carbs_g: 58, fat_g: 21 };

        expect(deriveConsumedTotals(snapshot, 0.33)).toEqual({
            calories: Math.round(611 * 0.33),
            protein: Math.round(45 * 0.33),
            carbs: Math.round(58 * 0.33),
            fat: Math.round(21 * 0.33),
        });
    });

    it('refuses a servings value that is not a positive finite number', () => {
        const snapshot = { calories: 400, protein_g: 30, carbs_g: 40, fat_g: 10 };

        for (const servings of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
            const call = () => deriveConsumedTotals(snapshot, servings);

            expect(call).toThrow(PlannedMealLogDataError);
            try {
                call();
            } catch (error) {
                expect((error as PlannedMealLogDataError).field).toBe('servings');
            }
        }
    });
});

/* ---------------------------------------------------------------------------
 * Request parsing
 * ------------------------------------------------------------------------- */

describe('parseLogPlannedMealRequest', () => {
    it('accepts a well-formed body and returns only the five accepted fields', () => {
        expect(parsedPayload(validBody())).toEqual({
            servings: 1,
            date: '2026-07-05',
            diaryMealId: DIARY_MEAL_ID,
            expectedPlanRevision: 3,
            idempotencyKey: IDEMPOTENCY_KEY,
        });
    });

    it('accepts a fractional portion inside the contract', () => {
        expect(parsedPayload(validBody({ servings: 0.25 })).servings).toBe(0.25);
        expect(parsedPayload(validBody({ servings: 0.66 })).servings).toBe(0.66);
    });

    it('rejects a body that is not a JSON object', () => {
        for (const body of [null, undefined, 'servings=1', 42, true, [validBody()]]) {
            const parsed = parseLogPlannedMealRequest(body);

            expect(parsed.kind).toBe('error');
            if (parsed.kind === 'error') {
                expect(parsed.code).toBe('invalid_request');
                expect(parsed.details).toEqual([
                    { field: 'body', code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE },
                ]);
            }
        }
    });

    it('reports every missing field at once rather than the first', () => {
        const details = rejectionDetails({});

        expect(details).toEqual([
            { field: 'servings', code: LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED },
            { field: 'date', code: LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED },
            { field: 'diaryMealId', code: LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED },
            { field: 'expectedPlanRevision', code: LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED },
            { field: 'idempotencyKey', code: LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED },
        ]);
    });

    it('treats an explicit null as absent', () => {
        expect(codeFor(validBody({ servings: null }), 'servings')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED,
        );
        expect(codeFor(validBody({ date: null }), 'date')).toBe(LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED);
        expect(codeFor(validBody({ diaryMealId: null }), 'diaryMealId')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED,
        );
        expect(codeFor(validBody({ expectedPlanRevision: null }), 'expectedPlanRevision')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED,
        );
        expect(codeFor(validBody({ idempotencyKey: null }), 'idempotencyKey')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED,
        );
    });

    it('rejects a numeric string for servings rather than coercing it', () => {
        // The value is part of the request fingerprint, so '1' and 1 must not
        // become the same intent wearing two spellings.
        expect(codeFor(validBody({ servings: '1' }), 'servings')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE,
        );
    });

    it('rejects a servings value outside the contract', () => {
        expect(codeFor(validBody({ servings: 0 }), 'servings')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_SERVINGS,
        );
        expect(codeFor(validBody({ servings: 0.2 }), 'servings')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_SERVINGS,
        );
        expect(codeFor(validBody({ servings: 10.5 }), 'servings')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_SERVINGS,
        );
        expect(codeFor(validBody({ servings: 1.005 }), 'servings')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_SERVINGS,
        );
        expect(codeFor(validBody({ servings: Number.NaN }), 'servings')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_SERVINGS,
        );
    });

    it('rejects a date that is not a calendar day', () => {
        expect(codeFor(validBody({ date: 20260705 }), 'date')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE,
        );
        expect(codeFor(validBody({ date: '2026-02-30' }), 'date')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_DATE,
        );
        expect(codeFor(validBody({ date: '2026-07-05T00:00:00Z' }), 'date')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_DATE,
        );
    });

    it('rejects an id that is not a v4 UUID', () => {
        expect(codeFor(validBody({ diaryMealId: 42 }), 'diaryMealId')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE,
        );
        expect(codeFor(validBody({ diaryMealId: 'not-a-uuid' }), 'diaryMealId')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID,
        );
        // A v1 UUID: right shape, wrong version nibble.
        expect(
            codeFor(validBody({ idempotencyKey: 'c20ad4d7-6fe9-1779-a1a0-1a7b2c3d4e5f' }), 'idempotencyKey'),
        ).toBe(LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID);
    });

    it('accepts an upper-case UUID', () => {
        expect(parsedPayload(validBody({ diaryMealId: DIARY_MEAL_ID.toUpperCase() })).diaryMealId).toBe(
            DIARY_MEAL_ID.toUpperCase(),
        );
    });

    it('requires expectedPlanRevision to be a whole revision a plan can have', () => {
        expect(codeFor(validBody({ expectedPlanRevision: '3' }), 'expectedPlanRevision')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE,
        );
        expect(codeFor(validBody({ expectedPlanRevision: Number.NaN }), 'expectedPlanRevision')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE,
        );
        expect(
            codeFor(validBody({ expectedPlanRevision: Number.POSITIVE_INFINITY }), 'expectedPlanRevision'),
        ).toBe(LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE);
        expect(codeFor(validBody({ expectedPlanRevision: 2.5 }), 'expectedPlanRevision')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.NOT_AN_INTEGER,
        );
        expect(
            codeFor(validBody({ expectedPlanRevision: MIN_PLAN_REVISION - 1 }), 'expectedPlanRevision'),
        ).toBe(LOG_PLANNED_MEAL_FIELD_CODES.BELOW_MINIMUM);
        expect(parsedPayload(validBody({ expectedPlanRevision: MIN_PLAN_REVISION })).expectedPlanRevision).toBe(
            MIN_PLAN_REVISION,
        );
    });

    it('reports an unknown key rather than dropping it', () => {
        // mealName above all: honouring a name would let a client target — or
        // invent — a diary bucket of its own choosing.
        expect(codeFor(validBody({ mealName: 'Breakfast' }), 'mealName')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.UNKNOWN_FIELD,
        );
        expect(codeFor(validBody({ nutritionProvenance: 'ai_estimated' }), 'nutritionProvenance')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.UNKNOWN_FIELD,
        );
    });

    it('names every offending field in the message', () => {
        const parsed = parseLogPlannedMealRequest({ servings: 99, date: 'nope', mealName: 'Lunch' });

        expect(parsed.kind).toBe('error');
        if (parsed.kind === 'error') {
            expect(parsed.message).toContain('servings');
            expect(parsed.message).toContain('date');
            expect(parsed.message).toContain('diaryMealId');
            expect(parsed.message).toContain('mealName');
        }
    });
});

/* ---------------------------------------------------------------------------
 * The two 404 predicates
 * ------------------------------------------------------------------------- */

describe('isDiaryMealAcceptable', () => {
    it("accepts the caller's own live bucket filed under the logged date", () => {
        expect(isDiaryMealAcceptable(diaryMeal(), USER_ID, '2026-07-05')).toBe(true);
    });

    it('accepts a @db.Date Date at UTC midnight as that column\'s own day', () => {
        expect(
            isDiaryMealAcceptable(
                diaryMeal({ date: new Date('2026-07-05T00:00:00.000Z') }),
                USER_ID,
                '2026-07-05',
            ),
        ).toBe(true);
    });

    it('accepts a stored ISO timestamp string by its day', () => {
        expect(
            isDiaryMealAcceptable(diaryMeal({ date: '2026-07-05T00:00:00.000Z' }), USER_ID, '2026-07-05'),
        ).toBe(true);
    });

    it("refuses another user's bucket", () => {
        expect(isDiaryMealAcceptable(diaryMeal({ user_id: OTHER_USER_ID }), USER_ID, '2026-07-05')).toBe(
            false,
        );
    });

    it('refuses a missing bucket, so "no such bucket" and "not yours" are one answer', () => {
        expect(isDiaryMealAcceptable(null, USER_ID, '2026-07-05')).toBe(false);
        expect(isDiaryMealAcceptable(undefined, USER_ID, '2026-07-05')).toBe(false);
    });

    it('refuses an empty or non-string caller id, which owns nothing', () => {
        expect(isDiaryMealAcceptable(diaryMeal({ user_id: '' }), '', '2026-07-05')).toBe(false);
        expect(isDiaryMealAcceptable(diaryMeal(), undefined as unknown as string, '2026-07-05')).toBe(false);
    });

    it('refuses a soft-deleted bucket', () => {
        expect(
            isDiaryMealAcceptable(diaryMeal({ deleted_at: new Date('2026-07-04T10:00:00.000Z') }), USER_ID, '2026-07-05'),
        ).toBe(false);
        expect(
            isDiaryMealAcceptable(diaryMeal({ deleted_at: '2026-07-04T10:00:00.000Z' }), USER_ID, '2026-07-05'),
        ).toBe(false);
    });

    it('treats an absent or null deleted_at as live', () => {
        expect(isDiaryMealAcceptable(diaryMeal({ deleted_at: null }), USER_ID, '2026-07-05')).toBe(true);
        expect(isDiaryMealAcceptable(diaryMeal({ deleted_at: undefined }), USER_ID, '2026-07-05')).toBe(true);
    });

    it("refuses a bucket filed under another day, keyed by day and not by instant", () => {
        expect(isDiaryMealAcceptable(diaryMeal({ date: '2026-07-06' }), USER_ID, '2026-07-05')).toBe(false);
    });

    it('refuses a request date that is not a calendar day', () => {
        expect(isDiaryMealAcceptable(diaryMeal(), USER_ID, '2026-02-30')).toBe(false);
        expect(isDiaryMealAcceptable(diaryMeal(), USER_ID, 'today')).toBe(false);
    });

    it('throws on a stored date it cannot read, rather than guessing whose diary it is', () => {
        const call = () => isDiaryMealAcceptable(diaryMeal({ date: 'not-a-date' }), USER_ID, '2026-07-05');

        expect(call).toThrow(PlannedMealLogDataError);
        try {
            call();
        } catch (error) {
            expect((error as PlannedMealLogDataError).field).toBe('diary meal date');
        }
        expect(() =>
            isDiaryMealAcceptable(diaryMeal({ date: new Date('nonsense') }), USER_ID, '2026-07-05'),
        ).toThrow(/must be a valid date/);
    });

    it('throws on a stored date that is neither a Date nor a string', () => {
        // Only reachable through an unchecked cast, which is exactly why the
        // defensive arm exists: a numeric column value must refuse rather than
        // stringify into something that happens to compare.
        expect(() =>
            isDiaryMealAcceptable(
                diaryMeal({ date: 20260705 as unknown as string }),
                USER_ID,
                '2026-07-05',
            ),
        ).toThrow(PlannedMealLogDataError);
    });
});

describe('isDateInPlanWeek', () => {
    it('includes both endpoints', () => {
        expect(isDateInPlanWeek('2026-07-05', planWeek())).toBe(true);
        expect(isDateInPlanWeek('2026-07-11', planWeek())).toBe(true);
        expect(isDateInPlanWeek('2026-07-08', planWeek())).toBe(true);
    });

    it('excludes the days either side', () => {
        expect(isDateInPlanWeek('2026-07-04', planWeek())).toBe(false);
        expect(isDateInPlanWeek('2026-07-12', planWeek())).toBe(false);
    });

    it('counts seven local days across a month boundary', () => {
        const week = planWeek({ start_date: '2026-07-29', end_date: '2026-08-04' });

        expect(isDateInPlanWeek('2026-07-31', week)).toBe(true);
        expect(isDateInPlanWeek('2026-08-01', week)).toBe(true);
        expect(isDateInPlanWeek('2026-08-05', week)).toBe(false);
    });

    it('reads @db.Date endpoints held as Dates', () => {
        const week = planWeek({
            start_date: new Date('2026-07-05T00:00:00.000Z'),
            end_date: new Date('2026-07-11T00:00:00.000Z'),
        });

        expect(isDateInPlanWeek('2026-07-11', week)).toBe(true);
        expect(isDateInPlanWeek('2026-07-12', week)).toBe(false);
    });

    it('refuses a malformed request date rather than coercing it', () => {
        expect(isDateInPlanWeek('2026-02-30', planWeek({ start_date: '2026-02-25', end_date: '2026-03-03' }))).toBe(
            false,
        );
        expect(isDateInPlanWeek('', planWeek())).toBe(false);
    });

    it('throws when the stored week runs backwards', () => {
        const call = () =>
            isDateInPlanWeek('2026-07-08', planWeek({ start_date: '2026-07-11', end_date: '2026-07-05' }));

        expect(call).toThrow(PlannedMealLogDataError);
        expect(call).toThrow(/runs backwards/);
        try {
            call();
        } catch (error) {
            expect((error as PlannedMealLogDataError).field).toBe('start_date');
        }
    });

    it('throws on a stored endpoint it cannot read', () => {
        expect(() => isDateInPlanWeek('2026-07-08', planWeek({ end_date: 'whenever' }))).toThrow(
            PlannedMealLogDataError,
        );
    });
});

describe('requireLoggableTarget', () => {
    const target = (overrides: Partial<Parameters<typeof requireLoggableTarget>[0]> = {}) => ({
        plan: planWeek(),
        diaryMeal: diaryMeal(),
        userId: USER_ID,
        date: '2026-07-05',
        ...overrides,
    });

    it('passes when the date is in the week and the bucket is the caller\'s', () => {
        expect(() => requireLoggableTarget(target())).not.toThrow();
    });

    it('answers one 404 for every refusal, so the response is no existence oracle', () => {
        expect(() => requireLoggableTarget(target({ date: '2026-07-12' }))).toThrow(PlanNotFoundError);
        expect(() => requireLoggableTarget(target({ diaryMeal: null }))).toThrow(PlanNotFoundError);
        expect(() =>
            requireLoggableTarget(target({ diaryMeal: diaryMeal({ user_id: OTHER_USER_ID }) })),
        ).toThrow(PlanNotFoundError);
        expect(() =>
            requireLoggableTarget(target({ diaryMeal: diaryMeal({ date: '2026-07-07' }) })),
        ).toThrow(PlanNotFoundError);
        expect(() =>
            requireLoggableTarget(
                target({ diaryMeal: diaryMeal({ deleted_at: '2026-07-04T00:00:00.000Z' }) }),
            ),
        ).toThrow(PlanNotFoundError);
    });

    it('checks the plan week before it looks at the bucket', () => {
        // A date outside the week refuses even when the bucket is unreadable,
        // so the cheap check cannot be short-circuited by stored nonsense.
        expect(() =>
            requireLoggableTarget(target({ date: '2026-07-20', diaryMeal: diaryMeal({ date: 'garbage' }) })),
        ).toThrow(PlanNotFoundError);
    });
});

/* ---------------------------------------------------------------------------
 * Logged state
 * ------------------------------------------------------------------------- */

describe('deriveLoggedStatus', () => {
    const entry = (overrides: Partial<LinkedDiaryEntryRow> = {}): LinkedDiaryEntryRow => ({
        id: 'entry-1',
        recipe_version_id: RECIPE_VERSION_ID,
        ...overrides,
    });

    it('is not_logged with no entries at all', () => {
        expect(deriveLoggedStatus([], RECIPE_VERSION_ID)).toEqual({
            status: 'not_logged',
            isLogged: false,
            previousRecipeVersionIds: [],
        });
        expect(deriveLoggedStatus(null, RECIPE_VERSION_ID).status).toBe('not_logged');
        expect(deriveLoggedStatus(undefined, RECIPE_VERSION_ID).status).toBe('not_logged');
    });

    it('is logged when a live entry references the current recipe version', () => {
        expect(deriveLoggedStatus([entry()], RECIPE_VERSION_ID)).toEqual({
            status: 'logged',
            isLogged: true,
            previousRecipeVersionIds: [],
        });
    });

    it('ignores soft-deleted entries, so deleting the diary entry clears LOGGED', () => {
        expect(
            deriveLoggedStatus([entry({ deleted_at: new Date('2026-07-05T12:00:00.000Z') })], RECIPE_VERSION_ID),
        ).toEqual({ status: 'not_logged', isLogged: false, previousRecipeVersionIds: [] });
        expect(deriveLoggedStatus([entry({ deleted_at: '2026-07-05T12:00:00.000Z' })], RECIPE_VERSION_ID).isLogged).toBe(
            false,
        );
        expect(deriveLoggedStatus([entry({ deleted_at: null })], RECIPE_VERSION_ID).isLogged).toBe(true);
    });

    it('is logged_then_swapped when the only live entries name another version', () => {
        expect(
            deriveLoggedStatus([entry({ recipe_version_id: OTHER_RECIPE_VERSION_ID })], RECIPE_VERSION_ID),
        ).toEqual({
            status: 'logged_then_swapped',
            isLogged: false,
            previousRecipeVersionIds: [OTHER_RECIPE_VERSION_ID],
        });
    });

    it('names the recipe actually eaten after two swaps, from the entries alone', () => {
        // A logged, slot swapped to B and then to C: the entries still say A,
        // while `previous_recipe_version_id` — the last swap's audit value —
        // would say B.
        const state = deriveLoggedStatus(
            [entry({ id: 'a', recipe_version_id: OTHER_RECIPE_VERSION_ID })],
            THIRD_RECIPE_VERSION_ID,
        );

        expect(state.status).toBe('logged_then_swapped');
        expect(state.previousRecipeVersionIds).toEqual([OTHER_RECIPE_VERSION_ID]);
    });

    it('is logged when the old and the new recipe are both logged', () => {
        const state = deriveLoggedStatus(
            [
                entry({ id: 'a', recipe_version_id: OTHER_RECIPE_VERSION_ID }),
                entry({ id: 'b', recipe_version_id: RECIPE_VERSION_ID }),
            ],
            RECIPE_VERSION_ID,
        );

        expect(state.status).toBe('logged');
        expect(state.isLogged).toBe(true);
        // Still reported, because the caption data is derived either way; only
        // logged_then_swapped renders it.
        expect(state.previousRecipeVersionIds).toEqual([OTHER_RECIPE_VERSION_ID]);
    });

    it('lists distinct earlier versions once, in first-seen order', () => {
        const state = deriveLoggedStatus(
            [
                entry({ id: 'a', recipe_version_id: THIRD_RECIPE_VERSION_ID }),
                entry({ id: 'b', recipe_version_id: OTHER_RECIPE_VERSION_ID }),
                entry({ id: 'c', recipe_version_id: THIRD_RECIPE_VERSION_ID }),
            ],
            RECIPE_VERSION_ID,
        );

        expect(state.previousRecipeVersionIds).toEqual([THIRD_RECIPE_VERSION_ID, OTHER_RECIPE_VERSION_ID]);
    });

    it('treats a detached entry as neither this meal logged nor an earlier one', () => {
        // An edit to the name or a macro clears the three links, so the entry
        // references no recipe.
        expect(deriveLoggedStatus([entry({ recipe_version_id: null })], RECIPE_VERSION_ID)).toEqual({
            status: 'not_logged',
            isLogged: false,
            previousRecipeVersionIds: [],
        });
        expect(
            deriveLoggedStatus(
                [entry({ recipe_version_id: undefined as unknown as null })],
                RECIPE_VERSION_ID,
            ).status,
        ).toBe('not_logged');
    });

    it('refuses a blank current recipe version, which would match a detached entry', () => {
        const call = () => deriveLoggedStatus([entry()], '   ');

        expect(call).toThrow(PlannedMealLogDataError);
        try {
            call();
        } catch (error) {
            expect((error as PlannedMealLogDataError).field).toBe('currentRecipeVersionId');
        }
    });

    it('does not write to the entries it reads', () => {
        const entries = [entry({ id: 'a', recipe_version_id: OTHER_RECIPE_VERSION_ID }), entry({ id: 'b' })];
        const snapshot = JSON.parse(JSON.stringify(entries));

        deriveLoggedStatus(entries, RECIPE_VERSION_ID);

        expect(JSON.parse(JSON.stringify(entries))).toEqual(snapshot);
    });
});
