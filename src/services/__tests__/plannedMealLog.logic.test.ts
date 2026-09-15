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
//  - THE SERVINGS BOUNDS, which are the wire contract and not a local choice: a
//    number in `[0.25, 10]` carrying at most two decimals (0.5.2, restated for
//    this endpoint in 0.7.3). Both bounds and both rejections are asserted as
//    LITERALS — and the exported constants are pinned to those literals — so
//    widening `MIN_EATEN_SERVINGS` or `MAX_EATEN_SERVINGS` fails here rather
//    than quietly moving the contract the shipped client validates against.
//    Two decimals is likewise the representation the app already stores (the
//    fraction chips hold '⅓' as 0.33 and '⅔' as 0.66), not a rounding
//    preference, so both values appear by name on the predicate and on the
//    parser.

import { readFileSync } from 'fs';
import { join } from 'path';

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
    parseLogPlannedMealCall,
    parseLogPlannedMealPath,
    parseLogPlannedMealRequest,
    requireLoggableTarget,
} from '../plannedMealLog.logic';
// `plannedIngredientGrams` is the grocery side of the cross-domain traversal at
// the end of this file; both modules are pure, so nothing is mocked.
import { plannedIngredientGrams } from '../grocery.logic';
import { PlanNotFoundError } from '../mealPlanning.errors';
// The one bound every revision parser in this layer shares, imported from the
// module that publishes it rather than restated as a literal here.
import { MAX_REVISION } from '../preferences.logic';
import { RecipeDerivationError } from '../recipe.logic';

/* ---------------------------------------------------------------------------
 * The shared fixture graph
 *
 * `data/meal-planning/fixtures/recipes.fixture.json` and
 * `catalog-foods.fixture.json` are the referentially closed pair the Agent
 * Action Plan §0.3.3 commits — fixed uuid keys, fixed timestamps, snake_case
 * rows — and they are the same rows the recipe, planner and grocery suites
 * read. The recipe versions a planned meal points at below are theirs, so the
 * `recipe_version_id` this suite writes into a diary snapshot is the identity
 * the planner placed and the grocery list shopped, and the historical-version
 * cases use the fixture's REAL retired version rather than a second invented
 * uuid.
 *
 * Read off disk rather than transcribed (the convention
 * `evidence.logic.test.ts` uses), and re-parsed per accessor so a case that
 * mutates a row cannot leak into the next.
 * ------------------------------------------------------------------------- */

const FIXTURE_DIRECTORY = join(__dirname, '..', '..', '..', 'data', 'meal-planning', 'fixtures');

const CATALOG_FOODS_JSON = readFileSync(join(FIXTURE_DIRECTORY, 'catalog-foods.fixture.json'), 'utf8');
const RECIPES_JSON = readFileSync(join(FIXTURE_DIRECTORY, 'recipes.fixture.json'), 'utf8');

/** The `recipe_versions` columns a planned entry reads. */
interface FixtureRecipeVersion {
    id: string;
    recipe_slug: string;
    version: number;
    name: string;
    serving_description: string;
    yield_servings: number;
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
    status: 'current' | 'retired';
}

/** A `recipe_ingredients` row — the grams of one food in the WHOLE recipe. */
interface FixtureRecipeIngredient {
    recipe_version_id: string;
    food_source_key: string;
    catalog_food_id: string;
    snapshot_name: string;
    gram_weight: number;
}

interface RecipeFixtureDocument {
    counts: { recipe_versions: number };
    recipe_versions: FixtureRecipeVersion[];
    recipe_ingredients: FixtureRecipeIngredient[];
}

interface CatalogFixtureDocument {
    foods: { id: string; source_key: string; display_name: string }[];
}

const readRecipeFixture = (): RecipeFixtureDocument => JSON.parse(RECIPES_JSON) as RecipeFixtureDocument;

const readCatalogFixture = (): CatalogFixtureDocument => JSON.parse(CATALOG_FOODS_JSON) as CatalogFixtureDocument;

/** The `(slug, version)` recipe version, or a failure naming the pair. */
const recipeVersionRow = (slug: string, version: number): FixtureRecipeVersion => {
    const row = readRecipeFixture().recipe_versions.find(
        (candidate) => candidate.recipe_slug === slug && candidate.version === version,
    );
    if (!row) {
        throw new Error(`recipes.fixture.json carries no ${slug} v${version}`);
    }

    return row;
};

/** The ingredient rows of one fixture version, in the fixture's own row order. */
const fixtureIngredientRows = (slug: string, version: number): FixtureRecipeIngredient[] => {
    const versionId = recipeVersionRow(slug, version).id;
    const rows = readRecipeFixture().recipe_ingredients.filter((row) => row.recipe_version_id === versionId);
    if (rows.length === 0) {
        throw new Error(`recipes.fixture.json carries no ingredients for ${slug} v${version}`);
    }

    return rows;
};

/** One committed version as the row a planned entry is derived from. */
const plannedRecipeVersion = (slug: string, version: number): PlannedRecipeVersionRow => {
    const row = recipeVersionRow(slug, version);

    return {
        id: row.id,
        name: row.name,
        serving_description: row.serving_description,
        per_serving_calories: row.per_serving_calories,
        per_serving_protein_g: row.per_serving_protein_g,
        per_serving_carbs_g: row.per_serving_carbs_g,
        per_serving_fat_g: row.per_serving_fat_g,
    };
};

/* ---------------------------------------------------------------------------
 * Fixtures
 *
 * The three recipe versions are committed rows, and the baseline is
 * `lemon-herb-chicken-and-rice` v2 — whose per-serving set is deliberately
 * unrounded in the fixture, so every one of the four macros lands on a fraction
 * once multiplied and a missing or extra rounding step is visible rather than
 * hidden behind whole numbers. `OTHER_RECIPE_VERSION_ID` is that recipe's own
 * RETIRED v1, which is the real shape of the mistake the two 404 predicates and
 * the swap chain exist to catch: a request naming a historical version of the
 * recipe the slot holds.
 *
 * The plan, diary and user identifiers stay local: the shared fixtures carry
 * the catalog and recipe graph, not `meal_plan_meals` or `diary_meals` rows.
 * ------------------------------------------------------------------------- */

const RECIPE_VERSION_ID = recipeVersionRow('lemon-herb-chicken-and-rice', 2).id;
const OTHER_RECIPE_VERSION_ID = recipeVersionRow('lemon-herb-chicken-and-rice', 1).id;
const THIRD_RECIPE_VERSION_ID = recipeVersionRow('spinach-egg-white-scramble', 1).id;
const MEAL_ID = '45c48cce-2e2d-4fd8-a0a1-9c8a1b2c3d4e';
/** The `:planId` segment of `POST …/plans/:planId/meals/:mealId/log`. */
const PLAN_ID = 'd3d94468-02a4-4c58-a2a4-1a7b2c3d4e5f';
const DIARY_MEAL_ID = '6512bd43-d9ca-46da-a4d0-f0bcc51aa551';
const IDEMPOTENCY_KEY = 'c20ad4d7-6fe9-4779-a1a0-1a7b2c3d4e5f';
const USER_ID = 'firebase-uid-alice';
const OTHER_USER_ID = 'firebase-uid-bob';

const recipeVersion = (overrides: Partial<PlannedRecipeVersionRow> = {}): PlannedRecipeVersionRow => ({
    ...plannedRecipeVersion('lemon-herb-chicken-and-rice', 2),
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

    /**
     * This name resolves to the shared rule declared in `preferences.logic.ts`
     * — the same binding the preference review step applies, which
     * `preferences.logic.test.ts` asserts by identity.
     *
     * It replaces a round trip through `Date.UTC(year, month - 1, day)`. That
     * constructor maps a year of 0-99 to 1900-1999, so this route read
     * `0004-02-29` as 1904, the round trip could not match, and the log request
     * was refused with `invalid_date` — while the preference review step, which
     * used a month-length table, accepted the very same day as a plan's
     * `startDate`. One request contradicting another about the calendar is the
     * defect; these cases pin the agreement.
     */
    it.each(['0000-01-01', '0001-01-01', '0004-02-29', '0050-06-15', '0099-12-31'])(
        'accepts %s, which the Date round trip placed in the twentieth century',
        (value) => {
            expect(isCalendarDayKey(value)).toBe(true);
        },
    );

    it('takes the leap rule with it, rather than waiving it for those years', () => {
        expect(isCalendarDayKey('0003-02-29')).toBe(false);
        expect(isCalendarDayKey('0100-02-29')).toBe(false);
        expect(isCalendarDayKey('0004-02-30')).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * isEatenServingsInContract
 * ------------------------------------------------------------------------- */

describe('isEatenServingsInContract', () => {
    it('holds the bounds the wire contract fixes, and not whatever the module currently says', () => {
        // The one assertion in this block that must NOT read the constants on
        // both sides: `[0.25, 10]` is published behaviour (0.5.2/0.7.3), so
        // moving either constant is a contract change and has to fail here.
        expect(MIN_EATEN_SERVINGS).toBe(0.25);
        expect(MAX_EATEN_SERVINGS).toBe(10);
    });

    it('accepts both bounds, inclusive', () => {
        expect(isEatenServingsInContract(0.25)).toBe(true);
        expect(isEatenServingsInContract(10)).toBe(true);
    });

    it('rejects either side of the bounds', () => {
        // One contract step below the minimum and above the maximum: both are
        // valid two-decimal numbers, so only the bounds can reject them.
        expect(isEatenServingsInContract(0.24)).toBe(false);
        expect(isEatenServingsInContract(10.01)).toBe(false);
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

        // The committed per-serving set of lemon-herb-chicken-and-rice v2,
        // transcribed so a change to the fixture is a change to this test.
        expect(portion).toEqual({
            calories: 428.2475 * 1.5,
            protein: 38.3846875 * 1.5,
            carbs: 39.715125 * 1.5,
            fat: 12.2653 * 1.5,
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
        expect(derivePlannedServingText(plannedMeal(), recipeVersion())).toBe('1 bowl');
    });

    it('shows the multiplier as a factor of the description, never folded into it', () => {
        // A description carrying a gram figure, which is the case that makes
        // the rule visible: '1.5 bowl (350 g)' would restate a weight that did
        // not scale. The committed descriptions are plain ('1 bowl'), so this
        // one scenario states its own.
        const withGrams = recipeVersion({ serving_description: '1 bowl (350 g)' });

        expect(derivePlannedServingText(plannedMeal({ portion_multiplier: 1.5 }), withGrams)).toBe(
            '1.5 × 1 bowl (350 g)',
        );
        expect(derivePlannedServingText(plannedMeal({ portion_multiplier: 0.5 }), withGrams)).toBe(
            '0.5 × 1 bowl (350 g)',
        );
        expect(derivePlannedServingText(plannedMeal({ portion_multiplier: 2 }), withGrams)).toBe(
            '2 × 1 bowl (350 g)',
        );
    });

    it('drops trailing zeros from the factor', () => {
        expect(derivePlannedServingText(plannedMeal({ portion_multiplier: 1.75 }), recipeVersion())).toBe(
            '1.75 × 1 bowl',
        );
        expect(
            derivePlannedServingText(plannedMeal({ portion_multiplier: 1.2500001 }), recipeVersion()),
        ).toBe('1.25 × 1 bowl');
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
            name: 'Lemon herb chicken and rice',
            serving_text: '1 bowl',
            meal_plan_meal_id: MEAL_ID,
            recipe_version_id: RECIPE_VERSION_ID,
            calories: 428,
            protein_g: 38,
            carbs_g: 40,
            fat_g: 12,
            input_method: PLANNED_ENTRY_INPUT_METHOD,
            nutrition_provenance: PLANNED_ENTRY_NUTRITION_PROVENANCE,
        });
    });

    it('describes ONE stored serving as the planned portion', () => {
        const snapshot = derivePlannedSnapshot(plannedMeal({ portion_multiplier: 0.75 }), recipeVersion());

        expect(snapshot.serving_text).toBe('0.75 × 1 bowl');
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

    it('accepts every portion the stepper and the fraction chips can send, unchanged', () => {
        // The whole contract surface as literals: both bounds, and the chip
        // values the shipped app stores ('⅓' = 0.33, '⅔' = 0.66). Each one
        // comes back as the identical number it was sent as, because the same
        // value feeds the client's card, the request fingerprint and the
        // server's arithmetic — a parser that re-rounded here would desynchronise
        // all three.
        for (const servings of [0.25, 0.33, 0.5, 0.66, 0.75, 1, 2.5, 10]) {
            expect(parsedPayload(validBody({ servings })).servings).toBe(servings);
        }
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
        // 0.24 and 10.01 are the literal steps either side of the published
        // bounds, so a widened MIN/MAX would be caught by the parser too and
        // not only by the predicate. A number is a number to the type check:
        // every one of these reaches `invalid_servings` rather than
        // `invalid_type`, which is the code the client renders under the
        // stepper.
        for (const servings of [0, 0.2, 0.24, 10.01, 10.5, 1.005, Number.NaN, Number.POSITIVE_INFINITY]) {
            expect(codeFor(validBody({ servings }), 'servings')).toBe(
                LOG_PLANNED_MEAL_FIELD_CODES.INVALID_SERVINGS,
            );
        }
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

    it('requires expectedPlanRevision to be a magnitude a revision column can hold', () => {
        // `Number.isInteger(1e30)` is true, so the integer check alone admits
        // whole numbers that no `Int` column can store and that JavaScript
        // cannot compare exactly. Left unchecked they reach
        // `buildRequestFingerprint` (a TypeError, so a 500) or Prisma (an
        // out-of-range `Int`, so a 500) — for what is plainly a malformed
        // request. The bound is `preferences.logic.ts`'s, imported rather than
        // restated.
        expect(MAX_REVISION).toBe(2_147_483_647);
        expect(parsedPayload(validBody({ expectedPlanRevision: MAX_REVISION })).expectedPlanRevision).toBe(
            MAX_REVISION,
        );

        for (const expectedPlanRevision of [MAX_REVISION + 1, 1e30, Number.MAX_SAFE_INTEGER + 2]) {
            expect(codeFor(validBody({ expectedPlanRevision }), 'expectedPlanRevision')).toBe(
                LOG_PLANNED_MEAL_FIELD_CODES.ABOVE_MAXIMUM,
            );
        }
    });

    it('tells a too-large revision apart from a too-small one', () => {
        // Two different things to say to the client: one pinned a revision the
        // plan has not reached yet, the other pinned one no plan can ever have.
        expect(
            codeFor(validBody({ expectedPlanRevision: MIN_PLAN_REVISION - 1 }), 'expectedPlanRevision'),
        ).toBe(LOG_PLANNED_MEAL_FIELD_CODES.BELOW_MINIMUM);
        expect(codeFor(validBody({ expectedPlanRevision: MAX_REVISION + 1 }), 'expectedPlanRevision')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.ABOVE_MAXIMUM,
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

describe('parseLogPlannedMealPath', () => {
    /** The details of a rejected path, or a failure that says it was accepted. */
    const pathDetails = (params: { planId?: unknown; mealId?: unknown }) => {
        const parsed = parseLogPlannedMealPath(params);
        if (parsed.kind !== 'error') {
            throw new Error('expected the parser to reject this path');
        }

        return parsed.details;
    };

    const pathCodeFor = (params: { planId?: unknown; mealId?: unknown }, field: string) =>
        pathDetails(params).find((detail) => detail.field === field)?.code;

    it('accepts two v4 UUIDs and returns them unchanged', () => {
        expect(parseLogPlannedMealPath({ planId: PLAN_ID, mealId: MEAL_ID })).toEqual({
            kind: 'ok',
            planId: PLAN_ID,
            mealId: MEAL_ID,
        });
    });

    it('accepts an upper-case UUID unchanged, as the body parser does', () => {
        expect(
            parseLogPlannedMealPath({ planId: PLAN_ID.toUpperCase(), mealId: MEAL_ID }),
        ).toMatchObject({ kind: 'ok', planId: PLAN_ID.toUpperCase() });
    });

    it.each([
        ['a malformed id', 'plan-1'],
        // A v1 UUID: right shape, wrong version nibble.
        ['a v1 UUID', 'c20ad4d7-6fe9-1779-a1a0-1a7b2c3d4e5f'],
        ['an empty segment', ''],
        ['a number', 42],
        ['an object', {}],
    ])('refuses %s as an invalid plan id', (_label, planId) => {
        expect(pathCodeFor({ planId, mealId: MEAL_ID }, 'planId')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID,
        );
    });

    it.each([
        ['a malformed id', 'meal-1'],
        ['a v1 UUID', 'c20ad4d7-6fe9-1779-a1a0-1a7b2c3d4e5f'],
        ['an empty segment', ''],
        ['a number', 42],
    ])('refuses %s as an invalid meal id', (_label, mealId) => {
        expect(pathCodeFor({ planId: PLAN_ID, mealId }, 'mealId')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID,
        );
    });

    it('reports an absent or null segment as an invalid id, as every other path parser does', () => {
        // A route does not match without its parameters, so an absent segment
        // is not a request a client can issue — `required` would describe a
        // shape that cannot reach the handler. Every path parser in this layer
        // answers `invalid_id` for any state that is not a well-formed id.
        expect(pathCodeFor({ mealId: MEAL_ID }, 'planId')).toBe(LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID);
        expect(pathCodeFor({ planId: null, mealId: MEAL_ID }, 'planId')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID,
        );
        expect(pathCodeFor({ planId: PLAN_ID }, 'mealId')).toBe(LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID);
        expect(pathCodeFor({ planId: PLAN_ID, mealId: null }, 'mealId')).toBe(
            LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID,
        );
    });

    it('reports both malformed ids in one verdict, in path order', () => {
        expect(pathDetails({ planId: 'plan-1', mealId: 'meal-1' })).toEqual([
            { field: 'planId', code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID },
            { field: 'mealId', code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID },
        ]);
    });

    it('names every offending segment in the message', () => {
        const parsed = parseLogPlannedMealPath({});

        expect(parsed.kind).toBe('error');
        if (parsed.kind === 'error') {
            expect(parsed.code).toBe('invalid_request');
            expect(parsed.message).toContain('planId');
            expect(parsed.message).toContain('mealId');
        }
    });

    it('judges the path without reading the body, and the body without the path', () => {
        // One parser per part of the request: a valid path beside an invalid
        // body is still a valid path, which is what lets the controller report
        // the two together instead of guessing which came first.
        expect(parseLogPlannedMealPath({ planId: PLAN_ID, mealId: MEAL_ID }).kind).toBe('ok');
        expect(parseLogPlannedMealRequest(validBody()).kind).toBe('ok');
        expect(parseLogPlannedMealPath({ planId: PLAN_ID, mealId: 'meal-1' }).kind).toBe('error');
    });
});

describe('parseLogPlannedMealCall', () => {
    /** The whole call's rejection details, or a failure that says it was accepted. */
    const callDetails = (params: { planId?: unknown; mealId?: unknown }, body: unknown) => {
        const parsed = parseLogPlannedMealCall(params, body);
        if (parsed.kind !== 'error') {
            throw new Error('expected the parser to reject this call');
        }

        return parsed.details;
    };

    /** The path half's rejection details, or a failure that says the path was accepted. */
    const refusedPathDetails = (params: { planId?: unknown; mealId?: unknown }) => {
        const parsed = parseLogPlannedMealPath(params);
        if (parsed.kind !== 'error') {
            throw new Error('expected the parser to reject this path');
        }

        return parsed.details;
    };

    it('accepts a valid path beside a valid body and returns both halves', () => {
        expect(parseLogPlannedMealCall({ planId: PLAN_ID, mealId: MEAL_ID }, validBody())).toEqual({
            kind: 'ok',
            planId: PLAN_ID,
            mealId: MEAL_ID,
            payload: parsedPayload(validBody()),
        });
    });

    it('produces exactly the payload the body parser produces', () => {
        // The composition adds no coercion of its own: the payload the write
        // fingerprints is the one `parseLogPlannedMealRequest` admitted, or the
        // two would hash different intents for one request.
        const body = validBody({ servings: 0.33, expectedPlanRevision: MIN_PLAN_REVISION });
        const parsed = parseLogPlannedMealCall({ planId: PLAN_ID, mealId: MEAL_ID }, body);

        expect(parsed.kind).toBe('ok');
        if (parsed.kind === 'ok') {
            expect(parsed.payload).toEqual(parsedPayload(body));
        }
    });

    it('refuses a malformed path id on its own, reporting only that field', () => {
        expect(callDetails({ planId: 'plan-1', mealId: MEAL_ID }, validBody())).toEqual([
            { field: 'planId', code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID },
        ]);
    });

    it('refuses a malformed body on its own, reporting only the body fields', () => {
        expect(callDetails({ planId: PLAN_ID, mealId: MEAL_ID }, validBody({ servings: 99 }))).toEqual([
            { field: 'servings', code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_SERVINGS },
        ]);
    });

    it('refuses a body that is not an object at all', () => {
        expect(callDetails({ planId: PLAN_ID, mealId: MEAL_ID }, null)).toEqual([
            { field: 'body', code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE },
        ]);
    });

    it('reports a malformed id and three bad body fields as four details, path first', () => {
        // The whole point of judging the two halves together: a client with a
        // bad id and a bad body is sent back ONCE, with everything it has to fix.
        const params = { planId: 'plan-1', mealId: MEAL_ID };
        const body = validBody({ servings: 99, date: 'nope', mealName: 'Lunch' });

        expect(callDetails(params, body)).toEqual([
            { field: 'planId', code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID },
            { field: 'servings', code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_SERVINGS },
            { field: 'date', code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_DATE },
            { field: 'mealName', code: LOG_PLANNED_MEAL_FIELD_CODES.UNKNOWN_FIELD },
        ]);
    });

    it('is the concatenation of the two parsers it composes, in path-then-body order', () => {
        // Asserted against the two parsers rather than a hand-written list, so
        // a change to either one's details travels here instead of drifting.
        const params = { planId: 'plan-1', mealId: 'meal-1' };
        const body = validBody({ diaryMealId: 'not-a-uuid', expectedPlanRevision: 0.5 });

        expect(callDetails(params, body)).toEqual([
            ...refusedPathDetails(params),
            ...rejectionDetails(body),
        ]);
    });

    it('names every offending field of both halves in the message', () => {
        const parsed = parseLogPlannedMealCall({ mealId: MEAL_ID }, validBody({ date: 'nope' }));

        expect(parsed.kind).toBe('error');
        if (parsed.kind === 'error') {
            expect(parsed.code).toBe('invalid_request');
            expect(parsed.message).toContain('planId');
            expect(parsed.message).toContain('date');
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

/* ---------------------------------------------------------------------------
 * The committed recipe graph
 *
 * Everything above pins one rule with one scenario. This section runs the
 * snapshot chain over every committed `recipe_versions` row, and over the one
 * pair of versions that belong to the SAME recipe — which is the case a
 * hand-built graph of unrelated uuids cannot state at all, because "a
 * historical version of this recipe" and "some other recipe's version" are
 * indistinguishable when every id was invented independently.
 * ------------------------------------------------------------------------- */

/** Every committed version, as the `(slug, version)` pair the accessors take. */
const COMMITTED_VERSIONS: [string, number][] = readRecipeFixture().recipe_versions.map((version) => [
    version.recipe_slug,
    version.version,
]);

describe('the committed recipe graph', () => {
    it('covers every version the fixture records', () => {
        expect(COMMITTED_VERSIONS).toHaveLength(readRecipeFixture().counts.recipe_versions);
        expect(COMMITTED_VERSIONS).toHaveLength(12);
    });

    describe.each(COMMITTED_VERSIONS)('%s v%i', (slug, versionNumber) => {
        const version = recipeVersionRow(slug, versionNumber);
        const row = plannedRecipeVersion(slug, versionNumber);
        const meal = (multiplier: number): PlannedMealRow => ({
            id: MEAL_ID,
            recipe_version_id: version.id,
            portion_multiplier: multiplier,
        });

        it('snapshots one planned serving as its own committed numbers, rounded once', () => {
            const snapshot = derivePlannedSnapshot(meal(1), row);

            expect(snapshot.recipe_version_id).toBe(version.id);
            expect(snapshot.name).toBe(version.name);
            expect(snapshot.serving_text).toBe(version.serving_description);
            expect(snapshot.calories).toBe(Math.round(version.per_serving_calories));
            expect(snapshot.protein_g).toBe(Math.round(version.per_serving_protein_g));
            expect(snapshot.carbs_g).toBe(Math.round(version.per_serving_carbs_g));
            expect(snapshot.fat_g).toBe(Math.round(version.per_serving_fat_g));
        });

        it('rounds the scaled portion once, not the scaled rounding', () => {
            const planned = derivePlannedPortion(meal(1.5), row);
            const snapshot = derivePlannedSnapshot(meal(1.5), row);

            expect(planned.calories).toBeCloseTo(version.per_serving_calories * 1.5, 9);
            expect(snapshot.calories).toBe(Math.round(version.per_serving_calories * 1.5));
            // Stated as the chain rather than as a number: the snapshot is the
            // rounding OF the unrounded planned portion, so a rounding step
            // added inside `derivePlannedPortion` breaks the first assertion
            // and one removed from the snapshot breaks this one.
            expect(snapshot.calories).toBe(Math.round(planned.calories));
            expect(Number.isInteger(snapshot.calories)).toBe(true);
        });

        it('scales a consumed total off the ROUNDED snapshot, which is what was stored', () => {
            const snapshot = derivePlannedSnapshot(meal(1), row);
            const consumed = deriveConsumedTotals(snapshot, 2);

            expect(consumed.calories).toBe(Math.round(snapshot.calories * 2));
            expect(consumed.protein).toBe(Math.round(snapshot.protein_g * 2));
            expect(consumed.calories).toBe(snapshot.calories * 2);
        });

        it('carries the two independent facts on every version', () => {
            const snapshot = derivePlannedSnapshot(meal(1), row);

            expect(snapshot.input_method).toBe(PLANNED_ENTRY_INPUT_METHOD);
            expect(snapshot.nutrition_provenance).toBe(PLANNED_ENTRY_NUTRITION_PROVENANCE);
        });
    });

    describe('the two versions of one recipe', () => {
        const CURRENT = recipeVersionRow('lemon-herb-chicken-and-rice', 2);
        const RETIRED = recipeVersionRow('lemon-herb-chicken-and-rice', 1);

        it('is the fixture pair: same recipe, one current and one retired', () => {
            expect(CURRENT.recipe_slug).toBe(RETIRED.recipe_slug);
            expect(CURRENT.status).toBe('current');
            expect(RETIRED.status).toBe('retired');
            expect(CURRENT.id).not.toBe(RETIRED.id);
            // Different content, which is why the entry must record WHICH one
            // it was: the retired version was made with couscous.
            expect(CURRENT.name).not.toBe(RETIRED.name);
            expect(CURRENT.per_serving_calories).not.toBe(RETIRED.per_serving_calories);
        });

        it('refuses the historical version for a slot holding the current one', () => {
            const call = () =>
                derivePlannedPortion(
                    { id: MEAL_ID, recipe_version_id: CURRENT.id, portion_multiplier: 1 },
                    plannedRecipeVersion('lemon-herb-chicken-and-rice', 1),
                );

            expect(call).toThrow(PlannedMealLogDataError);
            expect(call).toThrow(/is not the one planned for meal/);
        });

        it('refuses the current version for a slot still holding the historical one', () => {
            expect(() =>
                derivePlannedSnapshot(
                    { id: MEAL_ID, recipe_version_id: RETIRED.id, portion_multiplier: 1 },
                    plannedRecipeVersion('lemon-herb-chicken-and-rice', 2),
                ),
            ).toThrow(PlannedMealLogDataError);
        });

        it('snapshots the historical version faithfully when the slot does hold it', () => {
            const snapshot = derivePlannedSnapshot(
                { id: MEAL_ID, recipe_version_id: RETIRED.id, portion_multiplier: 1 },
                plannedRecipeVersion('lemon-herb-chicken-and-rice', 1),
            );

            // A diary entry written before the republication keeps naming the
            // version it was made from, so the numbers it shows stay the ones
            // the user ate.
            expect(snapshot.recipe_version_id).toBe(RETIRED.id);
            expect(snapshot.name).toBe('Lemon herb chicken and couscous');
            expect(snapshot.calories).toBe(Math.round(RETIRED.per_serving_calories));
        });

        it('reads a swap to the republished version as logged_then_swapped', () => {
            const state = deriveLoggedStatus(
                [{ id: 'entry-1', recipe_version_id: RETIRED.id }],
                CURRENT.id,
            );

            expect(state).toEqual({
                status: 'logged_then_swapped',
                isLogged: false,
                previousRecipeVersionIds: [RETIRED.id],
            });
        });
    });

    describe('the log end of the recipe -> plan -> grocery -> log traversal', () => {
        const SLUG = 'lemon-herb-chicken-and-rice';
        const VERSION = 2;
        const PORTION_MULTIPLIER = 1.5;

        it('snapshots the same version whose ingredient rows the grocery list aggregated', () => {
            const version = recipeVersionRow(SLUG, VERSION);
            const chicken = readCatalogFixture().foods.find((food) => food.source_key === 'usda:9200101');
            const chickenRow = fixtureIngredientRows(SLUG, VERSION).find(
                (row) => row.catalog_food_id === chicken?.id,
            );
            const snapshot = derivePlannedSnapshot(
                { id: MEAL_ID, recipe_version_id: version.id, portion_multiplier: PORTION_MULTIPLIER },
                plannedRecipeVersion(SLUG, VERSION),
            );

            // The diary entry and the shopping line are two views of one
            // placement: the entry names this version, and the line's grams are
            // this version's own ingredient row through the same multiplier.
            expect(snapshot.recipe_version_id).toBe(version.id);
            expect(chickenRow?.gram_weight).toBe(600);
            expect(
                plannedIngredientGrams(
                    chickenRow?.gram_weight as number,
                    version.yield_servings,
                    PORTION_MULTIPLIER,
                ),
            ).toBe(225);
            expect(snapshot.calories).toBe(Math.round(version.per_serving_calories * PORTION_MULTIPLIER));
        });

        it('keeps the entry independent of how much of the portion was eaten', () => {
            const version = recipeVersionRow(SLUG, VERSION);
            const snapshot = derivePlannedSnapshot(
                { id: MEAL_ID, recipe_version_id: version.id, portion_multiplier: PORTION_MULTIPLIER },
                plannedRecipeVersion(SLUG, VERSION),
            );

            expect(deriveConsumedTotals(snapshot, MIN_EATEN_SERVINGS).calories).toBe(
                Math.round(snapshot.calories * MIN_EATEN_SERVINGS),
            );
            expect(deriveConsumedTotals(snapshot, MAX_EATEN_SERVINGS).calories).toBe(
                snapshot.calories * MAX_EATEN_SERVINGS,
            );
            // Eating a quarter of it does not rewrite what one stored serving
            // is, which is the row the plan card and the diary both read.
            expect(snapshot.calories).toBe(Math.round(version.per_serving_calories * PORTION_MULTIPLIER));
        });
    });
});
