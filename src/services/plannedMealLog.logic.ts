// The pure rules that turn a planned meal into a food-diary entry: how much of
// it is stored, what the stored numbers mean, whether a given diary bucket may
// receive the entry at all, and whether the plan card reads as logged
// afterwards.
//
// Everything here is deterministic and synchronous — no Prisma, no network, no
// clock, no `process.env`, no HTTP. Every rule takes the rows it judges as
// ARGUMENTS (the planned meal, the recipe version, the candidate diary meal,
// the plan's week, the linked entries), declared below as structural snake_case
// interfaces rather than imported Prisma types, so each one is unit-testable
// from plain object literals (Rule 7 §11). `plannedMealLog.service.ts` owns
// every await — the advisory lock, the action reservation, the insert through
// `nutrition.service.ts::insertPlannedMealEntry`, the revision bump — and
// DERIVES through this module rather than restating a rule here, because all
// three rules below are ones a reimplementation could get quietly wrong.
//
// THE ROUNDING CONTRACT is the reason this file exists, and it has exactly one
// rounding step. The diary this feature writes into has been shipping for two
// versions, and its arithmetic is the reference: `nutrition.service.ts`
// multiplies a stored per-serving value by the servings eaten and rounds the
// product once (`asEaten`), and the daily and history aggregates mirror that in
// SQL as `SUM(ROUND(x * servings))::int`. So:
//
//   1. {@link derivePlannedPortion} — per-serving × `portion_multiplier`, at
//      FULL precision. Nothing is rounded. (The multiplication itself is
//      `recipe.logic.ts::scalePlannedNutrition`, so the rule lives in one
//      place; recipe detail and the plan cards round for DISPLAY through that
//      module's `roundNutritionForDisplay`, which never reaches storage.)
//   2. {@link derivePlannedSnapshot} — the SINGLE rounding step: each of the
//      four values is rounded exactly once into the integer per-serving
//      snapshot that `insertPlannedMealEntry` writes onto the `meal_entries`
//      row (whose macro columns are `Int`).
//   3. {@link deriveConsumedTotals} — `Math.round(snapshot × eatenServings)`
//      per value, computed from the ROUNDED snapshot and never from the
//      full-precision planned figure.
//
// The order is what makes the two sides agree. The client cannot see
// full-precision planned values — it holds the stored snapshot — so a server
// that rounded only after multiplying by the servings eaten would disagree with
// the "This adds" card by a calorie or two on every fractional serving, and the
// numbers on screen would not add up. Rounding once, at the snapshot, makes the
// agreement structural instead of coincidental. Never round the same number
// twice, and never re-round a snapshot.
//
// The user-visible guarantee that buys: "1 serving" in the diary equals the
// planned portion, exactly.
//
// THREE INDEPENDENT FACTS travel with a planned entry and are never collapsed
// into one field: its ORIGIN (`input_method = 'meal_plan'`, which is what earns
// the "From meal plan" caption), its nutrition PROVENANCE
// (`nutrition_provenance = 'source_backed'`), and its CALCULATION METHOD
// (recipe nutrition computed from exact stored ingredient gram weights, which
// `recipe.logic.ts` owns). A different answer to any one of them leaves the
// other two unchanged.
//
// Not this module's job: any I/O or transaction (`plannedMealLog.service.ts`),
// the idempotency sequence (`mealPlanningAction.service.ts`), inserting the row
// or mapping it to a DTO (`nutrition.service.ts::insertPlannedMealEntry` and
// `::mapEntry`), creating a diary bucket (nothing creates one on this path —
// see {@link isDiaryMealAcceptable}), shaping `loggedEntries` for the wire
// (`mealPlan.mapper.ts` owns the ordering and the joined recipe name), recipe
// nutrition derivation and planning eligibility (`recipe.logic.ts`), and
// choosing a status code (the controller).

import { PlanNotFoundError } from './mealPlanning.errors';
import { scalePlannedNutrition } from './recipe.logic';
import { InvalidRequestDetail, LogPlannedMealPayload } from '../types/mealPlanning';
import { MacroTotals, NutritionProvenance } from '../types/nutrition';

/* ---------------------------------------------------------------------------
 * The stored facts, and the local failure class
 * ------------------------------------------------------------------------- */

/**
 * `meal_entries.input_method` for a planned meal — the ORIGIN fact.
 *
 * Its presence is what the diary reads to caption a row "From meal plan", and
 * it is deliberately not a provenance value: where the numbers came from is the
 * separate column below.
 */
export const PLANNED_ENTRY_INPUT_METHOD = 'meal_plan';

/**
 * `meal_entries.nutrition_provenance` for a planned meal — the PROVENANCE fact.
 *
 * A fact of the domain rather than a column copied off a row: planning admits
 * only recipes whose EVERY ingredient is source-backed and whose allergen
 * review is `known` (`recipe.logic.ts::evaluatePlanningEligibility`), so a
 * planned meal is never an estimate. That is precisely why its diary caption
 * needs no class qualifier.
 *
 * Typed through `Extract` rather than as a bare literal so the value stays
 * narrow for {@link PlannedMealEntrySnapshot} while still failing to compile if
 * the provenance union ever loses this member.
 */
export const PLANNED_ENTRY_NUTRITION_PROVENANCE: Extract<NutritionProvenance, 'source_backed'> = 'source_backed';

/**
 * Data that cannot produce a truthful diary entry: a planned meal and recipe
 * version that do not belong together, a blank recipe name or serving
 * description, a non-positive portion multiplier or servings value, a stored
 * date that is not a calendar day, or a plan whose week runs backwards.
 *
 * A local class, following `grocery.logic.ts`'s `GroceryDataError` and
 * `catalog.logic.ts`'s `CatalogIdentityError`: none of these is anything a
 * client did — the request parser has already rejected client input by the time
 * these rules run — so they belong to the module that detects them rather than
 * to the meal-planning error vocabulary the controllers map
 * (`mealPlanning.errors.ts` states that boundary). Nutrition values that are
 * absent, non-finite or negative are NOT this error: they surface as
 * `recipe.logic.ts`'s `RecipeDerivationError`, which owns that rule.
 */
export class PlannedMealLogDataError extends Error {
    constructor(
        message: string,
        public readonly field: string,
    ) {
        super(message);
        this.name = 'PlannedMealLogDataError';
    }
}

/* ---------------------------------------------------------------------------
 * The servings contract and the shared patterns
 * ------------------------------------------------------------------------- */

/**
 * The portion-eaten bounds and precision, exported so tests assert against the
 * same numbers the rule uses.
 *
 * Two decimals is not a rounding preference — it is the representation the
 * shipped app already stores. `FoodDetail`'s fraction chips hold `⅓` as `0.33`
 * and `⅔` as `0.66`, and the displayed card, the request fingerprint and the
 * server's arithmetic must all use the identical number; "improving" either to
 * a third decimal would desynchronise the client's "This adds" card from the
 * server's snapshot and change every fingerprint. The same contract is enforced
 * for the catalog logging path by `nutrition.logic.ts`, restated there rather
 * than shared because these two modules deliberately depend on different
 * neighbours — both are pinned by their own tests.
 */
export const MIN_EATEN_SERVINGS = 0.25;

/** @see MIN_EATEN_SERVINGS */
export const MAX_EATEN_SERVINGS = 10;

/** @see MIN_EATEN_SERVINGS */
export const EATEN_SERVINGS_DECIMALS = 2;

/** `meal_plans.revision` starts at 1, so no smaller value can pin a real plan. */
export const MIN_PLAN_REVISION = 1;

const SERVINGS_SCALE = 10 ** EATEN_SERVINGS_DECIMALS;

/**
 * IEEE-754 slack for the decimal-places check.
 *
 * `0.33 * 100` is `33.000000000000004`, so `Number.isInteger` would reject one
 * of the two fraction values the app already stores. A third decimal still
 * fails: `1.005 * 100` is `100.49999999999999`, which is nowhere near an
 * integer at this tolerance.
 */
const SERVINGS_SCALE_TOLERANCE = 1e-9;

/** Captures the three parts so the day key can be checked against the calendar. */
const DAY_KEY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

const DAY_KEY_LENGTH = 10;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MONTH_OFFSET = 1;

/** The one portion multiplier at which a planned portion IS one recipe serving. */
const PORTION_MULTIPLIER_ONE = 1;

const PORTION_MULTIPLIER_DECIMALS = 2;

/** The U+00D7 form the diary already uses for an unscalable portion label. */
const PORTION_TIMES_SEPARATOR = ' × ';

const isUuidV4 = (value: unknown): value is string => typeof value === 'string' && UUID_V4_PATTERN.test(value);

/**
 * Whether a value is a `YYYY-MM-DD` key naming a day that exists.
 *
 * The calendar check is not decoration. `'2026-02-30'` matches the shape and
 * sorts inside a late-February plan week, and `new Date('2026-02-30')` rolls
 * forward to 2 March — so a shape-only check would let a request store an entry
 * on a day the user never chose. Verified by round-trip rather than by a
 * month-length table, so leap years need no special case.
 */
export const isCalendarDayKey = (value: unknown): value is string => {
    if (typeof value !== 'string') {
        return false;
    }

    const parts = DAY_KEY_PATTERN.exec(value);
    if (!parts) {
        return false;
    }

    const year = Number(parts[1]);
    const month = Number(parts[2]);
    const day = Number(parts[3]);
    const parsed = new Date(Date.UTC(year, month - MONTH_OFFSET, day));

    return (
        parsed.getUTCFullYear() === year &&
        parsed.getUTCMonth() === month - MONTH_OFFSET &&
        parsed.getUTCDate() === day
    );
};

/**
 * Whether a portion eaten is inside the servings contract: a real number in
 * `[0.25, 10]` carrying at most two decimals.
 *
 * @see MIN_EATEN_SERVINGS for why two decimals is a compatibility requirement
 * rather than a preference.
 */
export const isEatenServingsInContract = (value: unknown): value is number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return false;
    }

    if (value < MIN_EATEN_SERVINGS || value > MAX_EATEN_SERVINGS) {
        return false;
    }

    const scaled = value * SERVINGS_SCALE;

    return Math.abs(scaled - Math.round(scaled)) < SERVINGS_SCALE_TOLERANCE;
};

/**
 * A stored date as a day key in the plan's own date space.
 *
 * `meals.date`, `meal_plans.start_date` and `meal_plans.end_date` are all
 * `@db.Date` columns, which Prisma materialises as a `Date` at UTC midnight —
 * so the UTC slice is the column's own day and not a timezone conversion, which
 * is the convention `nutrition.service.ts::toDayKey` already follows. A string
 * is accepted in either form the callers hold, a bare day key or a full ISO
 * timestamp, and both resolve to the same day; anything else is stored data this
 * module refuses to guess at, because comparing nonsense would silently decide
 * whose diary an entry lands in.
 */
const toDayKey = (value: Date | string, field: string): string => {
    if (value instanceof Date) {
        if (Number.isNaN(value.getTime())) {
            throw new PlannedMealLogDataError(`${field} must be a valid date, received an invalid Date`, field);
        }

        return value.toISOString().slice(0, DAY_KEY_LENGTH);
    }

    const candidate = typeof value === 'string' ? value.slice(0, DAY_KEY_LENGTH) : '';
    if (!isCalendarDayKey(candidate)) {
        throw new PlannedMealLogDataError(
            `${field} must be a YYYY-MM-DD calendar day, received ${JSON.stringify(value)}`,
            field,
        );
    }

    return candidate;
};

const requireText = (value: string, field: string): string => {
    const trimmed = typeof value === 'string' ? value.trim() : '';
    if (trimmed.length === 0) {
        throw new PlannedMealLogDataError(`${field} must be a non-empty string`, field);
    }

    return trimmed;
};

const requirePositiveFinite = (value: number, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
        throw new PlannedMealLogDataError(
            `${field} must be a finite number greater than 0, received ${String(value)}`,
            field,
        );
    }

    return value;
};

/* ---------------------------------------------------------------------------
 * The rows these rules read
 * ------------------------------------------------------------------------- */

/** The `meal_plan_meals` facts a planned diary entry is derived from. */
export interface PlannedMealRow {
    id: string;
    recipe_version_id: string;
    /** How much of one recipe serving this slot plans, e.g. 0.5, 1, 1.75. */
    portion_multiplier: number;
}

/**
 * The `recipe_versions` facts a planned diary entry snapshots.
 *
 * The four per-serving nutrients are REQUIRED at the type level, which excludes
 * the impossible input before it can reach the arithmetic: the columns are
 * non-null and `recipe.logic.ts` derived them from source-backed ingredients, so
 * a null here could only come from an unchecked cast. A non-finite or negative
 * value that did arrive that way is still caught — by `scalePlannedNutrition`,
 * which owns that rule.
 */
export interface PlannedRecipeVersionRow {
    id: string;
    name: string;
    /** How one recipe serving is described, e.g. '1 bowl (350 g)'. */
    serving_description: string;
    per_serving_calories: number;
    per_serving_protein_g: number;
    per_serving_carbs_g: number;
    per_serving_fat_g: number;
}

/**
 * Four macro values at full precision.
 *
 * Structurally identical to `RecipePerServingNutrition` in `../types/recipe`
 * and to `MacroTotals`, and deliberately its own declaration: this module's
 * imports are the four modules its rules actually need, the same restatement
 * `recipe.logic.ts` makes for `RecipeDietPreference`. Not a totals type —
 * nothing in it is rounded.
 */
export interface PlannedPortionNutrition {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}

/**
 * What a planned meal contributes to the `meal_entries` row, in that table's
 * own column terms.
 *
 * Row facts in, row facts out: the snake_case → camelCase boundary is the wire
 * DTO, and `nutrition.service.ts::mapEntry` owns it (Rule 7 §10). The four
 * macro values are the ROUNDED per-serving integers — the `Int` columns' actual
 * contents — so anything computing a consumed total reads them and not the
 * planned portion they came from.
 */
export interface PlannedMealEntrySnapshot {
    name: string;
    /** Describes ONE stored serving, which is the planned portion. */
    serving_text: string;
    meal_plan_meal_id: string;
    recipe_version_id: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    input_method: typeof PLANNED_ENTRY_INPUT_METHOD;
    nutrition_provenance: typeof PLANNED_ENTRY_NUTRITION_PROVENANCE;
}

/** The stored per-serving integers alone — what a consumed total scales. */
export type PlannedEntryMacros = Pick<PlannedMealEntrySnapshot, 'calories' | 'protein_g' | 'carbs_g' | 'fat_g'>;

/**
 * Guards against snapshotting a recipe the slot does not hold.
 *
 * Cheap, and the one mix-up that would be invisible afterwards: the stored row
 * would carry one recipe's name beside another's macros, and every later
 * derivation — the diary caption, the plan card's logged state, the history
 * aggregate — would faithfully report the wrong meal.
 */
const requireMatchingRecipeVersion = (mealPlanMeal: PlannedMealRow, recipeVersion: PlannedRecipeVersionRow): void => {
    if (mealPlanMeal.recipe_version_id !== recipeVersion.id) {
        throw new PlannedMealLogDataError(
            `recipe version ${JSON.stringify(recipeVersion.id)} is not the one planned for meal ` +
                `${JSON.stringify(mealPlanMeal.id)} (${JSON.stringify(mealPlanMeal.recipe_version_id)})`,
            'recipe_version_id',
        );
    }
};

/* ---------------------------------------------------------------------------
 * The rounding contract — step 1: the planned portion, at full precision
 * ------------------------------------------------------------------------- */

/**
 * The planned portion's nutrition: the recipe's per-serving values times the
 * slot's `portion_multiplier`, UNROUNDED.
 *
 * Step 1 of the rounding contract, and the step where an extra `Math.round`
 * would be both invisible and wrong — it would shift the snapshot, every
 * consumed total derived from it, and the client's card. The multiplication
 * itself is delegated to `recipe.logic.ts::scalePlannedNutrition` so the rule
 * lives in exactly one place; that function is also what rejects a
 * non-positive multiplier or a nutrient that is absent, non-finite or negative,
 * with its own `RecipeDerivationError`.
 */
export const derivePlannedPortion = (
    mealPlanMeal: PlannedMealRow,
    recipeVersion: PlannedRecipeVersionRow,
): PlannedPortionNutrition => {
    requireMatchingRecipeVersion(mealPlanMeal, recipeVersion);

    return scalePlannedNutrition(
        {
            calories: recipeVersion.per_serving_calories,
            protein: recipeVersion.per_serving_protein_g,
            carbs: recipeVersion.per_serving_carbs_g,
            fat: recipeVersion.per_serving_fat_g,
        },
        mealPlanMeal.portion_multiplier,
    );
};

/**
 * How one stored serving is described in the diary.
 *
 * Derived from the recipe, never accepted from the client: the row's per-serving
 * snapshot IS the planned portion, so the label has to describe that portion and
 * nothing else. At a multiplier of 1 the planned portion is exactly one recipe
 * serving, so the recipe's own description stands. Otherwise the multiplier is
 * shown as a factor OF that description — `'1.5 × 1 bowl (350 g)'` — rather than
 * folded into its leading number, because `'1.5 bowl (350 g)'` would restate a
 * gram figure that did not scale, and claim something untrue.
 *
 * The form composes with the diary's own label rule: `entryServingText` scales
 * the leading number by the servings eaten, so two of a 1.5× portion renders
 * '3 × 1 bowl (350 g)', which is still the truth.
 */
export const derivePlannedServingText = (
    mealPlanMeal: PlannedMealRow,
    recipeVersion: PlannedRecipeVersionRow,
): string => {
    const description = requireText(recipeVersion.serving_description, 'serving_description');
    const multiplier = requirePositiveFinite(mealPlanMeal.portion_multiplier, 'portion_multiplier');

    if (multiplier === PORTION_MULTIPLIER_ONE) {
        return description;
    }

    const factor = String(Number(multiplier.toFixed(PORTION_MULTIPLIER_DECIMALS)));

    return `${factor}${PORTION_TIMES_SEPARATOR}${description}`;
};

/* ---------------------------------------------------------------------------
 * The rounding contract — step 2: the one rounding
 * ------------------------------------------------------------------------- */

/**
 * The planned meal as a `meal_entries` snapshot: every value the row stores
 * about WHAT was eaten, with each of the four macros rounded exactly once.
 *
 * This is the only rounding step in the whole path. `insertPlannedMealEntry`
 * applies the identical `Math.round` per value as it writes, which is a no-op on
 * these integers, so the stored row is the same whether the service hands it
 * this snapshot or the full-precision planned portion — and the integers here
 * are what {@link deriveConsumedTotals} and the client's "This adds" card both
 * scale. That is what makes "1 serving" in the diary equal the planned portion
 * exactly, and what keeps the two sides agreeing to the integer.
 *
 * The three independent facts travel together and unmixed: the ORIGIN
 * (`input_method`), the PROVENANCE (`nutrition_provenance`), and the two links
 * (`meal_plan_meal_id`, `recipe_version_id`) that let the plan card derive its
 * logged state and the diary caption itself. Pure: the arguments are read, never
 * written.
 */
export const derivePlannedSnapshot = (
    mealPlanMeal: PlannedMealRow,
    recipeVersion: PlannedRecipeVersionRow,
): PlannedMealEntrySnapshot => {
    const planned = derivePlannedPortion(mealPlanMeal, recipeVersion);

    return {
        name: requireText(recipeVersion.name, 'name'),
        serving_text: derivePlannedServingText(mealPlanMeal, recipeVersion),
        meal_plan_meal_id: mealPlanMeal.id,
        recipe_version_id: recipeVersion.id,
        calories: Math.round(planned.calories),
        protein_g: Math.round(planned.protein),
        carbs_g: Math.round(planned.carbs),
        fat_g: Math.round(planned.fat),
        input_method: PLANNED_ENTRY_INPUT_METHOD,
        nutrition_provenance: PLANNED_ENTRY_NUTRITION_PROVENANCE,
    };
};

/* ---------------------------------------------------------------------------
 * The rounding contract — step 3: what was actually eaten
 * ------------------------------------------------------------------------- */

/**
 * What a logged planned meal adds to the day: the STORED snapshot times the
 * servings eaten, each value rounded once.
 *
 * Deliberately reads the rounded snapshot and not the planned portion. This is
 * `nutrition.service.ts::asEaten` applied to the four values — the same
 * arithmetic the shipped diary's totals and its `SUM(ROUND(x * servings))::int`
 * aggregates perform, and the same the client's "This adds" card performs on the
 * same snapshot — so all three agree by construction rather than by luck.
 *
 * Returns `MacroTotals`, which is what a diary total is; the servings value is
 * the one the request parser has already accepted.
 */
export const deriveConsumedTotals = (snapshot: PlannedEntryMacros, eatenServings: number): MacroTotals => {
    const servings = requirePositiveFinite(eatenServings, 'servings');

    return {
        calories: Math.round(snapshot.calories * servings),
        protein: Math.round(snapshot.protein_g * servings),
        carbs: Math.round(snapshot.carbs_g * servings),
        fat: Math.round(snapshot.fat_g * servings),
    };
};


/* ---------------------------------------------------------------------------
 * Request parsing
 *
 * Verdicts are RETURNED, not thrown: a field-level failure is data the client
 * renders beside the field it names, every one of them is a 400, and
 * `invalid_request` deliberately has no error class (Rule 7 §8).
 * ------------------------------------------------------------------------- */

/**
 * The wire vocabulary for a planned-log `details[].code`. Machine-readable
 * only — the client maps each code to its own copy:
 *  - `required` — the field is absent or null.
 *  - `invalid_type` — present, but not the JSON type the field takes.
 *  - `invalid_id` — a string that is not a v4 UUID.
 *  - `invalid_date` — a string that is not a `YYYY-MM-DD` calendar day.
 *  - `invalid_servings` — a number outside the servings contract.
 *  - `not_an_integer` / `below_minimum` — `expectedPlanRevision` is fractional,
 *    or below the first revision a plan can have.
 *  - `unknown_field` — a key this endpoint does not accept, `mealName` above
 *    all: the diary bucket is named by id, and honouring a name would let a
 *    client target — or invent — a bucket of its own choosing.
 *
 * The codes are spelt as `grocery.logic.ts`, `nutrition.logic.ts` and
 * `targets.logic.ts` spell the same conditions, so the client needs one mapping
 * and not four.
 */
export const LOG_PLANNED_MEAL_FIELD_CODES = {
    REQUIRED: 'required',
    INVALID_TYPE: 'invalid_type',
    INVALID_ID: 'invalid_id',
    INVALID_DATE: 'invalid_date',
    INVALID_SERVINGS: 'invalid_servings',
    NOT_AN_INTEGER: 'not_an_integer',
    BELOW_MINIMUM: 'below_minimum',
    UNKNOWN_FIELD: 'unknown_field',
} as const;

type LogPlannedMealFieldCode = (typeof LOG_PLANNED_MEAL_FIELD_CODES)[keyof typeof LOG_PLANNED_MEAL_FIELD_CODES];

const SERVINGS_FIELD = 'servings';
const DATE_FIELD = 'date';
const DIARY_MEAL_ID_FIELD = 'diaryMealId';
const EXPECTED_PLAN_REVISION_FIELD = 'expectedPlanRevision';
const IDEMPOTENCY_KEY_FIELD = 'idempotencyKey';
const BODY_FIELD = 'body';

/**
 * Every key this endpoint accepts — and therefore, by omission, the definition
 * of an unknown one. `mealName` is absent deliberately (see `unknown_field`).
 */
const ACCEPTED_FIELDS: readonly string[] = [
    SERVINGS_FIELD,
    DATE_FIELD,
    DIARY_MEAL_ID_FIELD,
    EXPECTED_PLAN_REVISION_FIELD,
    IDEMPOTENCY_KEY_FIELD,
];

export type ParsedLogPlannedMealRequest =
    | { kind: 'ok'; payload: LogPlannedMealPayload }
    | { kind: 'error'; code: 'invalid_request'; message: string; details: InvalidRequestDetail[] };

const asRecord = (body: unknown): Record<string, unknown> | null =>
    typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

const invalidRequest = (message: string, details: InvalidRequestDetail[]): ParsedLogPlannedMealRequest => ({
    kind: 'error',
    code: 'invalid_request',
    message,
    details,
});

const servingsFieldCode = (value: unknown): LogPlannedMealFieldCode | null => {
    if (!isPresent(value)) {
        return LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED;
    }

    // A numeric string is rejected rather than coerced: the value is also part
    // of the request fingerprint, so '1' and 1 must not become the same intent
    // wearing two spellings.
    if (typeof value !== 'number') {
        return LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE;
    }

    return isEatenServingsInContract(value) ? null : LOG_PLANNED_MEAL_FIELD_CODES.INVALID_SERVINGS;
};

const dayKeyFieldCode = (value: unknown): LogPlannedMealFieldCode | null => {
    if (!isPresent(value)) {
        return LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED;
    }

    if (typeof value !== 'string') {
        return LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE;
    }

    return isCalendarDayKey(value) ? null : LOG_PLANNED_MEAL_FIELD_CODES.INVALID_DATE;
};

const uuidFieldCode = (value: unknown): LogPlannedMealFieldCode | null => {
    if (!isPresent(value)) {
        return LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED;
    }

    if (typeof value !== 'string') {
        return LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE;
    }

    return isUuidV4(value) ? null : LOG_PLANNED_MEAL_FIELD_CODES.INVALID_ID;
};

/**
 * `expectedPlanRevision` is required and never defaulted: it is the stale-plan
 * guard, and a request that omitted it would silently overwrite whatever the
 * plan had become since the screen was drawn.
 */
const planRevisionFieldCode = (value: unknown): LogPlannedMealFieldCode | null => {
    if (!isPresent(value)) {
        return LOG_PLANNED_MEAL_FIELD_CODES.REQUIRED;
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE;
    }

    if (!Number.isInteger(value)) {
        return LOG_PLANNED_MEAL_FIELD_CODES.NOT_AN_INTEGER;
    }

    return value < MIN_PLAN_REVISION ? LOG_PLANNED_MEAL_FIELD_CODES.BELOW_MINIMUM : null;
};

/**
 * Validates the `POST …/meals/:mealId/log` body.
 *
 * Every field is judged before answering, so a body with four problems reports
 * four details and the client shows all of its inline errors at once instead of
 * sending the user back five times. Unknown keys are reported rather than
 * ignored: silently dropping one would let a client believe a value it sent was
 * honoured.
 */
export const parseLogPlannedMealRequest = (body: unknown): ParsedLogPlannedMealRequest => {
    const record = asRecord(body);
    if (!record) {
        return invalidRequest('request body must be a JSON object', [
            { field: BODY_FIELD, code: LOG_PLANNED_MEAL_FIELD_CODES.INVALID_TYPE },
        ]);
    }

    const details: InvalidRequestDetail[] = [];
    const judge = (field: string, code: LogPlannedMealFieldCode | null): void => {
        if (code) {
            details.push({ field, code });
        }
    };

    judge(SERVINGS_FIELD, servingsFieldCode(record[SERVINGS_FIELD]));
    judge(DATE_FIELD, dayKeyFieldCode(record[DATE_FIELD]));
    judge(DIARY_MEAL_ID_FIELD, uuidFieldCode(record[DIARY_MEAL_ID_FIELD]));
    judge(EXPECTED_PLAN_REVISION_FIELD, planRevisionFieldCode(record[EXPECTED_PLAN_REVISION_FIELD]));
    judge(IDEMPOTENCY_KEY_FIELD, uuidFieldCode(record[IDEMPOTENCY_KEY_FIELD]));

    for (const key of Object.keys(record)) {
        if (!ACCEPTED_FIELDS.includes(key)) {
            details.push({ field: key, code: LOG_PLANNED_MEAL_FIELD_CODES.UNKNOWN_FIELD });
        }
    }

    if (details.length > 0) {
        return invalidRequest(
            `invalid or missing fields: ${details.map((detail) => detail.field).join(', ')}`,
            details,
        );
    }

    // The five guards above established each type; the assertions carry that
    // knowledge into the payload, as `grocery.logic.ts`'s path parsers do,
    // rather than re-testing it in a branch no input could ever reach.
    return {
        kind: 'ok',
        payload: {
            servings: record[SERVINGS_FIELD] as number,
            date: record[DATE_FIELD] as string,
            diaryMealId: record[DIARY_MEAL_ID_FIELD] as string,
            expectedPlanRevision: record[EXPECTED_PLAN_REVISION_FIELD] as number,
            idempotencyKey: record[IDEMPOTENCY_KEY_FIELD] as string,
        },
    };
};

/* ---------------------------------------------------------------------------
 * The two 404 predicates
 *
 * Two independent conditions with one answer. Dropping either is a real hole:
 * without the owner check a client could write into another user's diary, and
 * without the date check it could file a Tuesday meal under Monday's bucket.
 * Both are pure predicates over rows handed in — neither fetches anything, and
 * neither reads a clock.
 * ------------------------------------------------------------------------- */

/** The `meals` facts a planned entry's destination bucket is judged on. */
export interface DiaryMealRow {
    user_id: string;
    /** `meals.date`, as the `@db.Date` `Date` Prisma returns or as a day key. */
    date: Date | string;
    /** Absent and null both mean the bucket is live. */
    deleted_at?: Date | string | null;
}

/** The `meal_plans` week a logged date must fall inside. */
export interface PlanWeekRow {
    start_date: Date | string;
    end_date: Date | string;
}

/**
 * Whether this diary bucket may receive the entry: it is the caller's, it is
 * not deleted, and its own date is the date being logged.
 *
 * The bucket ALWAYS already exists by the time this runs — the client took
 * `diaryMealId` from `GET /macros/:date`, and `getDailyMacros` tops up the four
 * default buckets on every read, so the day is materialised before the id is
 * ever handed out. This rule therefore verifies and never creates; a
 * create-if-missing branch anywhere on this path would duplicate buckets and
 * diverge from that backfill.
 *
 * The date comparison is day-KEYED, not instant-based: `meals.date` is a
 * `@db.Date` column, so an evening request in any zone must still land on the
 * calendar day the client named. A `null` row is accepted as an argument and
 * answers `false`, which is how "no such bucket" and "not your bucket" stay one
 * indistinguishable answer for the caller to report.
 */
export const isDiaryMealAcceptable = (
    diaryMeal: DiaryMealRow | null | undefined,
    userId: string,
    date: string,
): boolean => {
    if (!diaryMeal) {
        return false;
    }

    // An empty caller id owns nothing. It cannot arrive from a verified token,
    // but it must never be the thing that makes two rows match.
    if (typeof userId !== 'string' || userId.length === 0 || diaryMeal.user_id !== userId) {
        return false;
    }

    if (isPresent(diaryMeal.deleted_at)) {
        return false;
    }

    if (!isCalendarDayKey(date)) {
        return false;
    }

    return toDayKey(diaryMeal.date, 'diary meal date') === date;
};

/**
 * Whether a date falls inside the plan's week, both endpoints INCLUSIVE.
 *
 * Logging a planned meal outside its own plan is meaningless — the day it names
 * does not exist in this plan, which is the same answer
 * `GET …/plans/:planId/days/:date` gives — and it would corrupt the logged
 * state the card derives.
 *
 * Compared as day keys, so seven local calendar days are seven days across a
 * month boundary and across a DST transition alike: no instant is constructed,
 * so there is no hour to be shifted. A malformed request date is refused rather
 * than coerced; a malformed STORED key throws, because comparing nonsense would
 * decide a plan's boundaries silently.
 */
export const isDateInPlanWeek = (date: string, plan: PlanWeekRow): boolean => {
    if (!isCalendarDayKey(date)) {
        return false;
    }

    const startDate = toDayKey(plan.start_date, 'start_date');
    const endDate = toDayKey(plan.end_date, 'end_date');

    if (startDate > endDate) {
        throw new PlannedMealLogDataError(
            `plan week runs backwards: start_date ${startDate} is after end_date ${endDate}`,
            'start_date',
        );
    }

    return date >= startDate && date <= endDate;
};

/** Everything a planned log is aimed at, judged together. */
export interface PlannedLogTarget {
    plan: PlanWeekRow;
    diaryMeal: DiaryMealRow | null;
    userId: string;
    date: string;
}

/**
 * Passes when the log may proceed, and throws `PlanNotFoundError` when it may
 * not.
 *
 * One class for every refusal on purpose: a bucket that does not exist, a
 * bucket belonging to someone else, a bucket filed under another day and a date
 * outside the plan's week must all be the same 404, or the response itself
 * becomes an oracle for what exists in another user's diary. The two predicates
 * stay exported beside it so each can be tested — and can fail — on its own.
 */
export const requireLoggableTarget = (target: PlannedLogTarget): void => {
    if (!isDateInPlanWeek(target.date, target.plan)) {
        throw new PlanNotFoundError();
    }

    if (!isDiaryMealAcceptable(target.diaryMeal, target.userId, target.date)) {
        throw new PlanNotFoundError();
    }
};

/* ---------------------------------------------------------------------------
 * Logged state — derived live, never stored
 * ------------------------------------------------------------------------- */

/** The `meal_entries` facts a planned meal's logged state is derived from. */
export interface LinkedDiaryEntryRow {
    id: string;
    /** Cleared to null when an edit detaches the entry from the plan. */
    recipe_version_id: string | null;
    /** Absent and null both mean the entry is live. */
    deleted_at?: Date | string | null;
}

/**
 * What the plan card shows for a slot:
 *  - `logged` — the LOGGED badge and "View in diary".
 *  - `logged_then_swapped` — the slot holds a new recipe while the diary keeps
 *    what was actually eaten, so the card renders the new recipe as unlogged and
 *    captions the earlier meal.
 *  - `not_logged` — the ordinary card.
 */
export type PlannedMealLoggedStatus = 'not_logged' | 'logged' | 'logged_then_swapped';

export interface PlannedMealLoggedState {
    status: PlannedMealLoggedStatus;
    /** True only for `logged` — a swapped-away entry is not this meal eaten. */
    isLogged: boolean;
    /**
     * Distinct recipe versions the live entries reference that are NOT the
     * slot's current one, in first-seen order. Populated whenever such entries
     * exist, including alongside a current one; only `logged_then_swapped`
     * renders a caption from it.
     */
    previousRecipeVersionIds: string[];
}

/**
 * Derives a planned meal's logged state from its linked diary entries.
 *
 * The rule: LOGGED when ANY live entry references the slot's CURRENT recipe
 * version; logged-then-swapped when at least one references a DIFFERENT version
 * and none references the current one. A slot holding both — the old recipe
 * logged, then the new one logged after a swap — is LOGGED, because the user has
 * eaten what the card now offers.
 *
 * Read from the entries ALONE, which is what makes it right after any number of
 * swaps: with A logged and the slot swapped to B and then to C, the entries
 * still say A and the caption names A, while `previous_recipe_version_id` — an
 * audit value, and only ever the last swap's — would say B.
 *
 * Nothing is stored, and that is the design rather than an omission. Because the
 * state is derived on every read, deleting the diary entry clears LOGGED,
 * editing the servings changes only the consumed total and keeps the link, and
 * editing the name or a macro detaches the entry
 * (`nutrition.service.ts::updateMealEntry` clears the three links) and so clears
 * LOGGED too — with no `is_logged` column to correct and no reconciliation job
 * to run. An entry whose `recipe_version_id` is null is exactly that detached
 * case: it references no recipe, so it is neither this meal logged nor an
 * earlier one.
 */
export const deriveLoggedStatus = (
    entries: readonly LinkedDiaryEntryRow[] | null | undefined,
    currentRecipeVersionId: string,
): PlannedMealLoggedState => {
    const currentVersionId = requireText(currentRecipeVersionId, 'currentRecipeVersionId');
    const liveEntries = (entries ?? []).filter((entry) => !isPresent(entry.deleted_at));

    let isLogged = false;
    const previousRecipeVersionIds: string[] = [];

    for (const entry of liveEntries) {
        const versionId = entry.recipe_version_id;
        if (versionId === null || versionId === undefined) {
            continue;
        }

        if (versionId === currentVersionId) {
            isLogged = true;
        } else if (!previousRecipeVersionIds.includes(versionId)) {
            previousRecipeVersionIds.push(versionId);
        }
    }

    const status: PlannedMealLoggedStatus = isLogged
        ? 'logged'
        : previousRecipeVersionIds.length > 0
          ? 'logged_then_swapped'
          : 'not_logged';

    return { status, isLogged, previousRecipeVersionIds };
};

