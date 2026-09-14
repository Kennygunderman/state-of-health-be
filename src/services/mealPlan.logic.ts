// The pure planning domain: given a user's confirmed targets, their saved
// preferences and the eligible recipe catalog, decide WHICH seven days of meals
// they get — or explain, in data the client can act on, why no week exists.
//
// Everything here is deterministic and synchronous — no Prisma, no network, no
// filesystem, no `process.env`, no clock, no HTTP status code. `mealPlan.service.ts`
// owns every await and opens its transaction AFTER this module has produced the
// candidate plan in memory, which is the design that lets a long search coexist
// with a short-lived transaction containing only inserts. Row-shaped inputs are
// declared below as structural snake_case interfaces rather than imported Prisma
// types, so every rule is exercisable from plain object literals, and the
// snake_case ↔ camelCase wire translation happens in `mealPlan.mapper.ts` and
// nowhere near here (Rule backend-architecture §6, §10).
//
// THREE PROPERTIES ARE LOAD-BEARING, and each is one careless edit away from
// being lost. Every one has a named test:
//
//  * PORTABLE PRE-ORDER. Candidates are sorted by the portable identity
//    `(recipes.slug, recipe_versions.version, portion_multiplier)` BEFORE the
//    seeded stream ever runs — never by `id`, by insertion order, or by the
//    order a query happened to return. Database ids are `gen_random_uuid()`
//    values, so ordering by one would make the same user's same week come out
//    differently on two databases loaded from the same catalog release. The
//    second-database determinism check compares plans by exactly that triple
//    per slot, and it is the pre-order that makes the comparison pass.
//
//  * KEY-FREE SEEDING. The seed is derived from the five inputs in
//    {@link PlanSeedInputs} and the idempotency key is not one of them — it is
//    not even a parameter of this module. A retry under a NEW key therefore
//    reproduces the same candidate plan and the same feasibility verdict, so
//    `no_matching_meals` is seed-independent by construction and a user cannot
//    turn an infeasible week into a feasible one by tapping "Try again".
//    Variation between regenerations comes from `generation_attempt` alone.
//
//  * CROSS-DAY BACKTRACKING. When a whole day dead-ends, the search backtracks
//    INTO THE PREVIOUS DAY and takes its next feasible assignment. This is the
//    subtlest requirement in the file: a greedy day-by-day loop would build
//    days 1 through 5 happily and then discover on day 6 that the repetition
//    rule leaves it nothing, with no way to recover. Because repetition only
//    ever looks BACKWARDS (uses so far, plus yesterday's recipes), a later day
//    can never invalidate an earlier one, and that is what makes the
//    depth-first search sound.
//
// Four conventions are worth stating once:
//
//  * ELIGIBILITY IS DELEGATED, NEVER RE-DERIVED. `recipe.logic.ts` owns the one
//    implementation, shared with swap alternatives and incompatibility
//    flagging. A second copy of a diet or allergen rule is how a swap
//    eventually offers a meal the generator would have refused, so this module
//    calls `isEligibleForPlanning` and adds nothing to it. AI-estimated and
//    ingredient-derived nutrition are excluded there, which is why a planned
//    meal is never an estimate — and there is deliberately NO "fall back to
//    estimated foods when the week will not close" path. Infeasibility is
//    reported, never papered over.
//
//  * GUIDANCE ORDERS MOVES; TOLERANCE ACCEPTS DAYS. The slot shares shape the
//    order in which candidates are TRIED and are never a constraint — a
//    candidate is never rejected for missing its share. The only hard nutrition
//    test is {@link evaluateDayTolerance}, applied to a COMPLETED day.
//
//  * NOTHING IS ROUNDED HERE. Day and meal totals are carried at full
//    precision. Display rounding belongs to `recipe.logic.ts::roundNutritionForDisplay`
//    via the mapper, and the diary snapshot rounds exactly once, inside
//    `nutrition.service.ts::insertPlannedMealEntry`. An extra round here would
//    shift every number downstream of it.
//
//  * EXHAUSTION IS A PRODUCT ANSWER, NOT AN ENGINEERING FAILURE. Running out of
//    evaluations throws {@link NoMatchingMealsError} — a 422 carrying
//    constraints the user can act on — and never `PlanGenerationError`. Only an
//    aborted search (the injected wall-clock deadline) is a 5xx. Keeping those
//    two apart is what makes the "not enough meals match" screen honest and the
//    "we couldn't finish" screen rare.
//
// Not this module's job: reading or writing anything, the keyed-write sequence
// (`mealPlanningAction.service.ts`), wire shaping (`mealPlan.mapper.ts`), diet
// and allergen derivation (`recipe.logic.ts`), grocery aggregation
// (`grocery.logic.ts`), and swap candidate ranking and portion selection
// (`swap.logic.ts`, which owns `selectSwapCandidates`/`selectSwapPortion`).

import { createHash } from 'node:crypto';

import {
    NoMatchingMealsError,
    PlanGenerationError,
    PlanNotActiveError,
    PlanOverlapError,
    UpcomingExistsError,
} from './mealPlanning.errors';
import { isCalendarDayKey, MAX_REVISION } from './preferences.logic';
import {
    isEligibleForPlanning,
    PlanningPreferences,
    PlanningRecipeVersion,
    scalePlannedNutrition,
} from './recipe.logic';
import type {
    BudgetPreference,
    BudgetTier,
    Diet,
    GeneratePlanPayload,
    InvalidRequestDetail,
    LimitingConstraint,
    MealPlanMacroTotals,
    MealSchedule,
    MealTimeEntry,
    NutritionTargetValues,
    PlanEndedErrorData,
    PlanStatus,
    RegeneratePlanPayload,
    SetupStep,
} from '../types/mealPlanning';
import type { MealSlot, RecipePerServingNutrition } from '../types/recipe';
import { mulberry32 } from '../utils/seededRandom';

/* ---------------------------------------------------------------------------
 * Errors — the narrow case where a verdict cannot express the problem
 * ------------------------------------------------------------------------- */

/**
 * Thrown for generator input that could not legitimately exist: a non-positive
 * or non-finite nutrition target, a malformed day key, a schedule with no time
 * for one of its slots, or a candidate carrying a non-finite per-serving value.
 *
 * Deliberately NOT one of the wire errors in `mealPlanning.errors.ts`, and
 * deliberately louder than a returned verdict — the same role `GroceryDataError`
 * and `RecipeDerivationError` play in their own modules. Each of these makes
 * the search's arithmetic meaningless rather than merely unsatisfiable, so it
 * is a programming or data-integrity fault to surface and fix, not a
 * feasibility answer to render. The controller maps it like any unexpected
 * throw; it never becomes `no_matching_meals`, because reporting "no meals
 * match your preferences" for a corrupt target would blame the user for a bug.
 */
export class MealPlanInputError extends Error {
    constructor(
        message: string,
        public readonly field: string,
    ) {
        super(message);
        this.name = 'MealPlanInputError';
    }
}

/* ---------------------------------------------------------------------------
 * Policy constants
 *
 * Every threshold the search turns on is named and exported, so a test asserts
 * against the same number the generator uses and a change to one is a visible
 * change to policy rather than an edited literal buried in a comparison.
 * ------------------------------------------------------------------------- */

/** A plan is always exactly one week: `start_date … start_date + 6`. */
export const PLAN_DAY_COUNT = 7;

/**
 * The portion multipliers a main slot may be planned at. Each
 * `(recipe, multiplier)` pair is its OWN candidate, which is what lets the
 * search reach a day target without editing a recipe.
 */
export const MAIN_SLOT_PORTION_MULTIPLIERS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

/**
 * A snack's narrower set. A strict subset of the main set, which is why the
 * global candidate pre-order can be built from the main set alone and filtered
 * per slot.
 */
export const SNACK_PORTION_MULTIPLIERS: readonly number[] = [0.5, 0.75, 1, 1.25, 1.5];

/** A recipe may appear at most twice in the week. */
export const MAX_RECIPE_USES_PER_WEEK = 2;

/**
 * How many eligible recipes a slot needs before the week is merely hard rather
 * than impossible.
 *
 * Four is arithmetic, not taste: a seven-day week needs seven meals per slot,
 * each recipe may be used twice, and no recipe may fall on consecutive days.
 * Three recipes cannot cover seven days under that rule; four can.
 */
export const MIN_ELIGIBLE_RECIPES_PER_SLOT = 4;

/** Evaluation budgets. Placing one candidate in one slot is one evaluation. */
export const MAX_EVALUATIONS_PER_DAY = 2000;
export const MAX_EVALUATIONS_PER_PLAN = 14000;

/** Scoring weights. Fixed: `score = 1.0·proximity + 0.5·budget − 0.25·reuse`, lower better. */
export const TARGET_PROXIMITY_WEIGHT = 1;
export const BUDGET_PENALTY_WEIGHT = 0.5;
export const REUSE_BONUS_WEIGHT = 0.25;

/** Beyond four shared ingredients, more sharing stops earning score. */
export const REUSE_BONUS_CAP = 4;

/** Day tolerances — the only hard nutrition test, applied to a completed day. */
export const CALORIE_TOLERANCE_RATIO = 0.1;
export const PROTEIN_TOLERANCE_UNDER_G = 15;
export const PROTEIN_TOLERANCE_OVER_G = 25;
export const MACRO_TOLERANCE_ABSOLUTE_G = 15;
export const MACRO_TOLERANCE_RATIO = 0.15;

/**
 * Slack on every tolerance comparison, in the unit being compared.
 *
 * The bounds are INCLUSIVE ("within ±10 %"), and a day whose total lands
 * exactly on a bound must be accepted. Summing seven floats rarely produces the
 * exact bound, so a bare `<=` would reject a day that is mathematically inside
 * it by a rounding error in the fifteenth digit. Far too small to admit a day
 * that is genuinely outside.
 */
export const TOLERANCE_EPSILON = 1e-9;

/** The cooking-time limits the client offers, ascending — the relaxation ladder. */
export const COOKING_TIME_TIERS: readonly number[] = [15, 30, 45, 60];

/** Weekly-budget thresholds, in whole units of the single accepted currency, per meal. */
export const BUDGET_TIER_1_MAX_PER_MEAL = 3;
export const BUDGET_TIER_2_MAX_PER_MEAL = 6;

/** How far ahead a plan may start, unless an active plan's successor week is further out. */
export const MAX_START_DATE_OFFSET_DAYS = 30;

/**
 * Cumulative shares of the day target at each slot, in SCHEDULE order.
 *
 * Stored cumulatively rather than per slot so the final entry is exactly 1 —
 * summing 0.25 + 0.35 + 0.40 in floating point is not. The per-slot intent:
 * three meals 25 / 35 / 40 %; with a snack 22 / 30 / 35 / 13 %.
 *
 * Guidance only. A candidate is never rejected for missing its share; the share
 * decides the order candidates are TRIED in, and `evaluateDayTolerance` decides
 * what is acceptable.
 */
export const THREE_MEAL_CUMULATIVE_SHARES: readonly number[] = [0.25, 0.6, 1];
export const THREE_PLUS_SNACK_CUMULATIVE_SHARES: readonly number[] = [0.22, 0.52, 0.87, 1];

/**
 * Slots in SCHEDULE order — the wire order the preferences store meal times in,
 * and the order the search fills them.
 *
 * Distinct from the order a day is DISPLAYED in, which follows the clock: a
 * snack at 15:30 sits between lunch and dinner on screen while remaining the
 * last slot the search fills. {@link resolveSlotSchedule} derives both.
 */
const THREE_MEAL_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner'];
const THREE_PLUS_SNACK_SLOTS: readonly MealSlot[] = ['breakfast', 'lunch', 'dinner', 'snack'];

const ACTIVE_PLAN_STATUS: PlanStatus = 'active';

const ENDED_REASON: PlanEndedErrorData['reason'] = 'ended';

// The day-key shape is NOT declared here: it lives once in
// `preferences.logic.ts` beside the predicate that applies it.
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MILLISECONDS_PER_DAY = 86400000;

/**
 * The locale {@link localDayKey} formats through. Canadian English renders a
 * numeric date as `YYYY-MM-DD`, which is the day-key form this module speaks —
 * it is a formatting choice, and no user-facing text is produced here.
 */
const LOCAL_DAY_KEY_LOCALE = 'en-CA';
const PERCENT_SCALE = 100;
const SEED_FIELD_SEPARATOR = '|';

/**
 * The wire vocabulary for a plan `details[].code`. Machine-readable only — the
 * client maps each code to its own copy:
 *  - `invalid_id` — a path id or idempotency key that is not a v4 UUID.
 *  - `invalid_date` — `startDate`, or a `:date` path segment, is not a real
 *    `YYYY-MM-DD` calendar date.
 *  - `required` — the field is absent or null.
 *  - `invalid_type` — present, but not the type the contract declares.
 *  - `out_of_range` — a well-formed value outside its permitted window.
 */
export const MEAL_PLAN_FIELD_CODES = {
    INVALID_ID: 'invalid_id',
    INVALID_DATE: 'invalid_date',
    REQUIRED: 'required',
    INVALID_TYPE: 'invalid_type',
    OUT_OF_RANGE: 'out_of_range',
} as const;

const START_DATE_FIELD = 'startDate';
const IDEMPOTENCY_KEY_FIELD = 'idempotencyKey';
const PLAN_ID_FIELD = 'planId';
/** The `:date` path segment of the single-day read — not the body's `startDate`. */
const DATE_FIELD = 'date';
const EXPECTED_PLAN_REVISION_FIELD = 'expectedPlanRevision';
const EXPECTED_PREFERENCES_REVISION_FIELD = 'expectedPreferencesRevision';
const EXPECTED_TARGETS_REVISION_FIELD = 'expectedTargetsRevision';

/* ---------------------------------------------------------------------------
 * The rows, preferences and candidates these rules read
 * ------------------------------------------------------------------------- */

/**
 * A plannable recipe version, as the join of `recipes` and `recipe_versions`
 * gives it — extending the eligibility input so a candidate is handed straight
 * to `recipe.logic.ts` without a second shape.
 *
 * `slug` and `version` are the PORTABLE IDENTITY, and carrying them is the
 * whole reason a generated plan can be compared between two databases: they are
 * stable across independent catalog loads where `id` is not.
 */
export interface PlanRecipeCandidate extends PlanningRecipeVersion {
    recipe_version_id: string;
    recipe_id: string;
    /** `recipes.slug` — unique per recipe and stable across databases. */
    slug: string;
    /** `recipe_versions.version` — the monotonic counter within one recipe. */
    version: number;
    /** `recipe_versions.budget_tier`, 1 (cheapest) to 3. */
    budget_tier: number;
    /** `recipe_versions.per_serving_*`, at full precision. */
    per_serving: RecipePerServingNutrition;
}

/**
 * Everything about a user that shapes a week: the eligibility preferences
 * `recipe.logic.ts` reads, plus the schedule and budget only the generator
 * needs.
 */
export interface PlanGenerationPreferences extends PlanningPreferences {
    meal_schedule: MealSchedule;
    /** Exactly one `HH:mm` entry per slot of the chosen schedule. */
    meal_times: readonly MealTimeEntry[];
    /** null means the user expressed no amount, which is a real answer. */
    budget: BudgetPreference | null;
    no_budget_preference: boolean;
}

/**
 * The five facts the generator's seed is derived from — and the complete list.
 *
 * The idempotency key is absent BY DESIGN and is not a member of this type, so
 * a retry under a new key cannot reach the seed even by accident. A
 * regeneration differs from the plan it replaces through `generationAttempt`.
 */
export interface PlanSeedInputs {
    userId: string;
    /** `YYYY-MM-DD`, the plan's first day in the user's own calendar. */
    startDate: string;
    preferencesRevision: number;
    targetsRevision: number;
    /** 1 for a first generation, incremented by each regeneration. */
    generationAttempt: number;
}

/** One `(recipe version, portion multiplier)` pair the search may place. */
export interface PlanCandidate {
    recipe: PlanRecipeCandidate;
    portionMultiplier: number;
    /** `per_serving × portionMultiplier`, at full precision. */
    nutrition: MealPlanMacroTotals;
    /**
     * The candidate's position in the seeded shuffle of the portable pre-order.
     * The ONE tie-break when two candidates score equally, which is what keeps
     * an arbitrary-looking choice reproducible.
     */
    shuffleRank: number;
}

/** One slot of the day, with everything the search and the day view need. */
export interface SlotSchedule {
    slot: MealSlot;
    /** `HH:mm`, straight from the saved preference. */
    time: string;
    /** Position in SCHEDULE order — the order the search fills slots. */
    searchIndex: number;
    /** Position in CLOCK order — `meal_plan_meals.sort_order`, what the day view shows. */
    sortOrder: number;
    /** The cumulative share of the day target guiding this slot's move order. */
    cumulativeShare: number;
}

/** A meal the search placed. Ids and rows are the service's to create. */
export interface PlannedMealAssignment {
    slot: MealSlot;
    slotTime: string;
    sortOrder: number;
    recipeVersionId: string;
    recipeId: string;
    /** Carried for the portable-identity comparison a determinism check makes. */
    slug: string;
    version: number;
    portionMultiplier: number;
    /** Full precision. The mapper rounds for display; the diary rounds on insert. */
    planned: MealPlanMacroTotals;
}

/** One day of the generated week. */
export interface GeneratedPlanDay {
    date: string;
    dayIndex: number;
    isLastDay: boolean;
    plannedTotals: MealPlanMacroTotals;
    /** In `sortOrder` (clock) order, which is how the day is read. */
    meals: PlannedMealAssignment[];
}

/** The candidate plan, built entirely in memory before any transaction opens. */
export interface GeneratedPlan {
    startDate: string;
    endDate: string;
    /** What `meal_plans.generation_seed` records, so a week can be replayed. */
    seed: number;
    days: GeneratedPlanDay[];
    /** Placements attempted. Reported so a slow week is visible in the logs. */
    evaluations: number;
}

/** One explicit date of a plan week. */
export interface PlanDate {
    date: string;
    dayIndex: number;
    isLastDay: boolean;
}

/** The `meal_plans` facts every lifecycle rule turns on. */
export interface PlanLifecycleState {
    id: string;
    status: string;
    start_date: string;
    end_date: string;
    /** The plan that superseded this one, resolved by the caller; null when none did. */
    replacement_plan_id?: string | null;
}

/**
 * The five `meal_plan_preferences` columns eligibility is judged from, as Prisma
 * returns them.
 *
 * Structural on purpose: a service's own `PreferencesRow` satisfies it without
 * this module importing one, which keeps a pure rule free of the service layer
 * (§10) and lets a test hand over five fields instead of a whole row.
 */
export interface PlanningPreferencesRow {
    diet: string | null;
    allergens: readonly string[];
    disliked_food_ids: readonly string[];
    disliked_food_groups: readonly string[];
    cooking_time_limit_min: number | null;
}

/** The diets the contract admits, keyed off its own union so widening it fails here first. */
const DIETS: Readonly<Record<Diet, true>> = { none: true, vegetarian: true, vegan: true, pescatarian: true };

/**
 * A stored TEXT code as a member of a closed set, or `null`.
 *
 * `Object.prototype.hasOwnProperty.call` AND NOT THE `in` OPERATOR, which is
 * the whole reason this is a named helper rather than an inline comparison:
 * `in` walks the prototype chain, so `'toString' in DIETS` and
 * `'constructor' in DIETS` are both true and a stored `toString` would be cast
 * to `Diet` and handed to the eligibility rules as a diet code no recipe
 * carries — every candidate refused, and a week reported as infeasible for a
 * row that merely holds a bad string. Own-property lookup is the only test that
 * matches the set's four members and nothing else.
 *
 * Identical in shape to the private helpers `mealPlan.mapper.ts` and
 * `preferences.service.ts` keep for the same purpose; each module owns its own
 * copy because a pure rule module does not import a service (§10) and a
 * four-line narrowing is not worth a shared module of its own.
 */
const asMember = <T extends string>(set: Readonly<Record<T, true>>, value: unknown): T | null =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(set, value) ? (value as T) : null;

/**
 * The five preference columns `recipe.logic.ts::evaluatePlanningEligibility`
 * reads, narrowed out of the stored row.
 *
 * ONE NARROWING FOR EVERY PATH THAT JUDGES ELIGIBILITY, which is the whole
 * point of it living here: generation narrows this way, and so does
 * `swap.service.ts`'s candidate selection. Two narrowings are how a swap comes
 * to admit a recipe the generator would have refused — and since this is the
 * rule that decides what "the user's restrictions" are, it is a planning rule
 * rather than a row-to-wire mapping.
 *
 * `diet` goes through {@link asMember} over a closed set keyed off the
 * contract's own union, so EVERY value that is not one of the four reads as "no
 * diet restriction" rather than reaching the eligibility rules as an unknown
 * code — including the prototype-member names an `in` test would have admitted.
 * A null row reads as "nothing restricted", which is what a user who has saved
 * no preference has said.
 */
export const toPlanningPreferences = (row: PlanningPreferencesRow | null): PlanningPreferences => ({
    diet: row === null ? null : asMember(DIETS, row.diet),
    allergens: row?.allergens ?? [],
    disliked_food_ids: row?.disliked_food_ids ?? [],
    disliked_food_groups: row?.disliked_food_groups ?? [],
    cooking_time_limit_min: row?.cooking_time_limit_min ?? null,
});

/**
 * The targets a plan is REPORTED against: the user's current confirmed targets
 * when they are complete, otherwise the snapshot the week was generated from.
 *
 * The rule, not the read. `MealPlanResponse.targets` is what the plan card,
 * Account and the diary all show, and `swap.service.ts` scores every candidate
 * against the same values — so the question "which numbers is this week judged
 * by?" has to be answered in one place or the alternatives list will offer a
 * meal that visibly misses the figure printed beside it.
 *
 * Incomplete confirmed targets fall back to the generation snapshot rather than
 * reporting nulls: a plan cannot be generated without four confirmed values
 * (§0.5.2 answers `422 targets_missing` first), so the snapshot is always four
 * real numbers, while a user who has since cleared a target would otherwise
 * blank the figure on a week that was built against something. Reporting the
 * snapshot keeps `targetsStale` meaningful — it is exactly
 * {@link sameMacroTotals} over these two values.
 */
export const resolveReportedTargets = (
    confirmed: { complete: boolean; targets: NutritionTargetValues | null },
    generationTargets: MealPlanMacroTotals,
): MealPlanMacroTotals => {
    const values = confirmed.targets;

    if (
        !confirmed.complete ||
        values === null ||
        values.calories === null ||
        values.protein === null ||
        values.carbs === null ||
        values.fat === null
    ) {
        return generationTargets;
    }

    return { calories: values.calories, protein: values.protein, carbs: values.carbs, fat: values.fat };
};

/* ---------------------------------------------------------------------------
 * Day keys — arithmetic in the user's calendar, never in the server's
 * ------------------------------------------------------------------------- */

/**
 * Whether a value is a real `YYYY-MM-DD` calendar date.
 *
 * The regex alone is not enough: it accepts `2026-02-30` and `2026-13-01`, and
 * a plan that silently started on a non-existent date would put six of its
 * seven days somewhere the user never asked for.
 *
 * THE implementation is shared — `preferences.logic.ts::isCalendarDayKey`, the
 * parser that first admits a date into the system — and this is an alias of it
 * rather than a wrapper, so the binding is identical to the one
 * `plannedMealLog.logic.ts` exposes and the three cannot answer differently.
 * The name stays `isDayKey` because that is what this module's rules and
 * `swap.logic.ts` already call it.
 *
 * It replaces a round trip through `Date.UTC(year, month - 1, day)`, which was
 * subtly wrong rather than merely duplicated: that constructor maps years 0–99
 * to 1900–1999, so it read `0004-02-29` as 1904 and the round trip refused the
 * whole band — while the table-driven implementation accepted it. The shared
 * rule consults no `Date`, so no mapping and no rollover can reach it.
 */
export const isDayKey: (value: unknown) => value is string = isCalendarDayKey;

const requireDayKey = (value: string, field: string): string => {
    if (!isDayKey(value)) {
        throw new MealPlanInputError(
            `${field} must be a YYYY-MM-DD calendar date, received ${JSON.stringify(value)}`,
            field,
        );
    }

    return value;
};

/**
 * A day key as the UTC instant of its midnight — the form day arithmetic needs.
 *
 * NOT `Date.UTC(year, month - 1, day)`, which is the obvious spelling and is
 * wrong for part of the range {@link isDayKey} accepts: that constructor maps a
 * year of 0–99 to 1900–1999, so it would place `0004-02-29` in 1904. Reading a
 * validated key as a year 1,900 off is worse than refusing it — every rule
 * built on this function ({@link addDaysToDayKey},
 * {@link daysBetweenDayKeys}, {@link planDatesFrom} and `swap.logic.ts`'s
 * repetition window) would compute a real but wrong answer, silently.
 *
 * `setUTCFullYear` applies no such mapping, so the written year is the year
 * used. Starting from epoch 0 and setting all three fields together makes the
 * result depend on nothing but the key.
 */
const dayKeyToUtcMillis = (dayKey: string): number => {
    const instant = new Date(0);

    instant.setUTCFullYear(
        Number(dayKey.slice(0, 4)),
        Number(dayKey.slice(5, 7)) - 1,
        Number(dayKey.slice(8, 10)),
    );
    instant.setUTCHours(0, 0, 0, 0);

    return instant.getTime();
};

/**
 * The day key of a UTC instant — the inverse of {@link dayKeyToUtcMillis}.
 *
 * The result is re-validated rather than returned on trust, because the slice
 * is only a day key while the year has four digits: `toISOString` switches to
 * the expanded `±YYYYYY` form outside years 0000–9999, so an arithmetic step
 * past either end of that range would return `'+0100'` — a key-shaped fragment
 * naming no day. A shift that far is a fault in the caller's arithmetic, and it
 * surfaces here as a {@link MealPlanInputError} instead of being stored.
 */
const formatDayKey = (utcMillis: number): string =>
    requireDayKey(new Date(utcMillis).toISOString().slice(0, 10), 'dayKey');

/**
 * THE derivation of a user's calendar day from an instant — the one place an
 * absolute moment becomes a `YYYY-MM-DD` key.
 *
 * Every lifecycle rule in this file takes `today` as a day key, and this is
 * where that key legitimately comes from: the user's stored IANA zone. A rule
 * that read the server's own clock would answer differently on a server in
 * Frankfurt and one in Virginia for the same user at the same moment, which is
 * not a detail — at 20:00 UTC a plan ending today is already over for a user in
 * Auckland and still current for one in Los Angeles, and the difference decides
 * whether they can write to it.
 *
 * THE INSTANT IS AN ARGUMENT, never `Date.now()`: this module owns no clock, so
 * the service passes the moment in and every rule here stays reproducible
 * (Rule backend-architecture §7). Accepts a `Date` or epoch milliseconds
 * because both are what a caller has to hand.
 *
 * `Intl.DateTimeFormat` with the zone does the conversion, and `en-CA` is used
 * for its numeric form: that locale renders a numeric date as `YYYY-MM-DD`,
 * which is the key this module already speaks. The result is re-validated as a
 * real calendar day rather than trusted, so a runtime whose locale data renders
 * something else fails loudly here instead of writing a malformed key into a
 * plan.
 *
 * Zone VALIDATION on the request path belongs to
 * `preferences.logic.ts::normalizeTimeZone`, which is what stores the canonical
 * name; this function re-validates defensively because it is also reachable
 * with a zone read from a row written before that parser existed, and a wrong
 * zone here silently plans someone else's week.
 */
export const localDayKey = (instant: Date | number, timeZone: string): string => {
    const epochMillis = instant instanceof Date ? instant.getTime() : instant;

    if (!Number.isFinite(epochMillis)) {
        throw new MealPlanInputError(
            `instant must be a finite moment in time, received ${String(instant)}`,
            'instant',
        );
    }

    let formatter: Intl.DateTimeFormat;

    try {
        formatter = new Intl.DateTimeFormat(LOCAL_DAY_KEY_LOCALE, {
            timeZone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        });
    } catch (error) {
        // Only a RangeError means "this runtime does not know that zone".
        // Anything else is a runtime without full time-zone data, and reporting
        // that as a bad zone would blame the user's own valid setting for an
        // environment fault — the same split `normalizeTimeZone` makes.
        if (error instanceof RangeError) {
            throw new MealPlanInputError(
                `timeZone must be an IANA time zone this runtime knows, received ${JSON.stringify(timeZone)}`,
                'timeZone',
            );
        }

        throw error;
    }

    return requireDayKey(formatter.format(new Date(epochMillis)), 'timeZone');
};

/**
 * A day key shifted by whole days, staying in the calendar it started in.
 *
 * Computed in UTC so no server time zone can turn "plus one day" into "plus
 * twenty-three hours" across a daylight-saving boundary — the day keys these
 * rules compare are the user's own calendar days, and the server never has a
 * clock in that zone.
 */
export const addDaysToDayKey = (dayKey: string, days: number): string => {
    requireDayKey(dayKey, 'dayKey');

    if (!Number.isInteger(days)) {
        throw new MealPlanInputError(`days must be an integer, received ${String(days)}`, 'days');
    }

    return formatDayKey(dayKeyToUtcMillis(dayKey) + days * MILLISECONDS_PER_DAY);
};

/** Whole days from `from` to `to`; negative when `to` is earlier. */
export const daysBetweenDayKeys = (from: string, to: string): number => {
    requireDayKey(from, 'from');
    requireDayKey(to, 'to');

    return Math.round((dayKeyToUtcMillis(to) - dayKeyToUtcMillis(from)) / MILLISECONDS_PER_DAY);
};

/**
 * The seven explicit dates of a plan, `startDate … startDate + 6`.
 *
 * Every date is stored and rendered, so the day strip always shows the plan's
 * OWN week. The mock's out-of-week day numbers are sample data and have no
 * implementation here.
 */
export const planDatesFrom = (startDate: string): PlanDate[] => {
    requireDayKey(startDate, START_DATE_FIELD);

    const dates: PlanDate[] = [];

    for (let dayIndex = 0; dayIndex < PLAN_DAY_COUNT; dayIndex += 1) {
        dates.push({
            date: addDaysToDayKey(startDate, dayIndex),
            dayIndex,
            isLastDay: dayIndex === PLAN_DAY_COUNT - 1,
        });
    }

    return dates;
};

/** `startDate + 6` — the `meal_plans.end_date` a week implies. */
export const planEndDate = (startDate: string): string =>
    addDaysToDayKey(startDate, PLAN_DAY_COUNT - 1);

/* ---------------------------------------------------------------------------
 * Schedule — search order is the wire order, display order is the clock
 * ------------------------------------------------------------------------- */

/** The slots a schedule plans, in wire (search) order. */
export const scheduleSlots = (schedule: MealSchedule): readonly MealSlot[] =>
    schedule === 'three_plus_snack' ? THREE_PLUS_SNACK_SLOTS : THREE_MEAL_SLOTS;

/** The cumulative day-target shares guiding each slot, in the same order. */
export const scheduleCumulativeShares = (schedule: MealSchedule): readonly number[] =>
    schedule === 'three_plus_snack' ? THREE_PLUS_SNACK_CUMULATIVE_SHARES : THREE_MEAL_CUMULATIVE_SHARES;

/**
 * Which multipliers each kind of slot may be planned at.
 *
 * A parameter rather than a constant only so the limiting-constraint analysis
 * can ask the counterfactual question "would a wider set have closed this
 * week?" and report `portion_limits` truthfully. Generation always uses
 * {@link DEFAULT_PORTION_POLICY}; nothing else may widen it, because a portion
 * outside the offered set is one the client cannot render or edit.
 */
export interface PortionPolicy {
    mainSlot: readonly number[];
    snack: readonly number[];
}

/** The multipliers the product actually offers. The only policy generation uses. */
export const DEFAULT_PORTION_POLICY: PortionPolicy = {
    mainSlot: MAIN_SLOT_PORTION_MULTIPLIERS,
    snack: SNACK_PORTION_MULTIPLIERS,
};

/**
 * A deliberately wider set, used ONLY to diagnose `portion_limits`.
 *
 * Reaches below the smallest offered portion and above the largest, so a week
 * that closes under it but not under the real policy proves the portions — not
 * the recipes — were the binding constraint.
 */
export const EXTENDED_PORTION_POLICY: PortionPolicy = {
    mainSlot: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.5, 3],
    snack: [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2],
};

/** The multipliers a slot may use. A snack's set is the narrower one. */
export const portionMultipliersForSlot = (
    slot: MealSlot,
    policy: PortionPolicy = DEFAULT_PORTION_POLICY,
): readonly number[] => (slot === 'snack' ? policy.snack : policy.mainSlot);

/** Every multiplier any slot may use, ascending — the set candidates are built over. */
const allPortionMultipliers = (policy: PortionPolicy): number[] =>
    [...new Set([...policy.mainSlot, ...policy.snack])].sort((left, right) => left - right);

/** The noun a portion is counted in when the recipe's own serving unit cannot be used. */
const GENERIC_PORTION_UNIT = 'serving';

/**
 * A serving description that is exactly `1` followed by one inflectable word.
 *
 * Anchored, single-word and letters-only (internal hyphens allowed, for a
 * "1 half-wrap"): the leading `1 ` is what makes the rest of the string the unit
 * ONE serving is measured in, which is the only reading that lets a multiplier
 * be applied to it.
 */
const SINGLE_UNIT_SERVING_DESCRIPTION = /^1\s+([a-z][a-z-]*)$/i;

/** A word already in the plural, which `pluralizeCount` would inflect a second time. */
const ALREADY_PLURAL_WORD = /s$/i;

/**
 * The noun a portion of this recipe is counted in, from the recipe's own
 * `recipe_versions.serving_description`.
 *
 * `'1 bowl'` yields `'bowl'`, so the plan card reads "1 bowl" and a portion and
 * a half reads "1½ bowls" — the serving unit the recipe was written and
 * photographed in, rather than the generic noun every recipe would otherwise
 * share. Of the seeded corpus's serving descriptions, the great majority are of
 * exactly this shape (`1 bowl`, `1 plate`, `1 wrap`, `1 wedge`, `1 slice`,
 * `1 square`, `1 omelette`).
 *
 * TOTAL, and falls back to `'serving'` rather than guessing, in four cases the
 * corpus really contains:
 *
 *  - no description at all (`null`, or blank after trimming);
 *  - a description that is not one serving — `'4 meatballs with sauce'`,
 *    `'3 bites'`, `'2 muffins'`, `'¾ cup'`. Its number is part of the recipe's
 *    yield statement, so treating the remainder as a per-serving unit would
 *    multiply an already-multiplied quantity;
 *  - a phrase rather than a unit — `'1 fillet with potato and broccoli'`,
 *    `'1 stuffed bell pepper (2 halves)'`. `pluralizeCount` inflects the LAST
 *    word, which would produce "2 fillet with potato and broccolis";
 *  - a word already plural. `pluralizeCount` would append to it again
 *    ("halves" → "halveses"), so an `s` ending is refused outright. The cost is
 *    a generic noun for a recipe served in, say, "1 couscous"; the alternative
 *    is a visibly broken word.
 *
 * The word is returned VERBATIM, not lower-cased: `utils/units.ts` restores the
 * original casing when it inflects, so a capitalised unit stays capitalised.
 *
 * A rule and not a format, which is why it is here and not in the mapper: what
 * counts as a usable serving unit is a property of the recipe corpus, it is the
 * same question for the plan card and the swap preview, and it is worth pinning
 * case by case in `__tests__/mealPlan.logic.test.ts`. The mapper composes the
 * display string from it.
 */
export const derivePortionUnit = (servingDescription: string | null): string => {
    if (servingDescription === null) {
        return GENERIC_PORTION_UNIT;
    }

    const match = SINGLE_UNIT_SERVING_DESCRIPTION.exec(servingDescription.trim());

    if (match === null || ALREADY_PLURAL_WORD.test(match[1])) {
        return GENERIC_PORTION_UNIT;
    }

    return match[1];
};

const timeOfDayMinutes = (time: string, slot: MealSlot): number => {
    const match = TIME_OF_DAY_PATTERN.exec(time);

    if (!match) {
        throw new MealPlanInputError(
            `meal_times.${slot} must be an HH:mm time, received ${JSON.stringify(time)}`,
            'meal_times',
        );
    }

    return Number(match[1]) * 60 + Number(match[2]);
};

/**
 * The schedule the search and the day view both read: each slot with its saved
 * time, its search position, its display position and its guidance share.
 *
 * TWO ORDERS, deliberately, because they genuinely differ. The SEARCH fills
 * slots in wire order (breakfast, lunch, dinner, then the snack) because that
 * is the order the cumulative shares are stated in. The DAY VIEW sorts by the
 * clock, so a snack saved at 15:30 appears between lunch and dinner — which is
 * exactly what the schedule screen lets a user do, and the AAP requires no
 * ordering between the saved times. Equal times keep wire order, so two meals
 * at the same minute are still deterministically ordered.
 *
 * A slot with no saved time throws rather than defaulting: the preferences
 * parser guarantees one entry per slot, so a gap here is a data fault, and
 * inventing a time would write a `slot_time` the user never chose.
 */
export const resolveSlotSchedule = (
    schedule: MealSchedule,
    mealTimes: readonly MealTimeEntry[],
): SlotSchedule[] => {
    const slots = scheduleSlots(schedule);
    const shares = scheduleCumulativeShares(schedule);

    const withTimes = slots.map((slot, searchIndex) => {
        const entry = mealTimes.find((candidate) => candidate.slot === slot);

        if (!entry) {
            throw new MealPlanInputError(
                `meal_times is missing an entry for the ${slot} slot of the ${schedule} schedule`,
                'meal_times',
            );
        }

        return {
            slot,
            time: entry.time,
            searchIndex,
            minutes: timeOfDayMinutes(entry.time, slot),
            cumulativeShare: shares[searchIndex],
        };
    });

    const clockOrder = [...withTimes].sort(
        (left, right) => left.minutes - right.minutes || left.searchIndex - right.searchIndex,
    );
    const sortOrderBySlot = new Map<MealSlot, number>();
    clockOrder.forEach((entry, index) => sortOrderBySlot.set(entry.slot, index));

    return withTimes.map((entry) => ({
        slot: entry.slot,
        time: entry.time,
        searchIndex: entry.searchIndex,
        sortOrder: sortOrderBySlot.get(entry.slot) ?? entry.searchIndex,
        cumulativeShare: entry.cumulativeShare,
    }));
};

/* ---------------------------------------------------------------------------
 * Budget — a relative preference, never a price
 * ------------------------------------------------------------------------- */

/**
 * The user's cost band, derived from their weekly amount.
 *
 * Per-meal spend is the comparable figure, because the same weekly amount buys
 * more per meal on a three-meal schedule than on four: `amount ÷ (meals per day
 * × 7)`, then `< 3` → tier 1, `3–6` → tier 2, `> 6` → tier 3. Both boundaries
 * fall in tier 2 — exactly 3 and exactly 6 are the mid band.
 *
 * "No budget preference", a null amount, and a non-positive or non-finite one
 * all give tier 3: the highest band carries NO penalty, so the absence of an
 * answer never narrows the week. The thresholds are calibrated to the single
 * currency this version accepts, which is why no conversion appears here.
 */
export const resolveUserBudgetTier = (
    budget: BudgetPreference | null,
    noBudgetPreference: boolean,
    schedule: MealSchedule,
): BudgetTier => {
    if (noBudgetPreference || !budget || !Number.isFinite(budget.amount) || budget.amount <= 0) {
        return 3;
    }

    const mealsPerDay = scheduleSlots(schedule).length;
    const perMeal = budget.amount / (mealsPerDay * PLAN_DAY_COUNT);

    if (perMeal < BUDGET_TIER_1_MAX_PER_MEAL) {
        return 1;
    }

    return perMeal <= BUDGET_TIER_2_MAX_PER_MEAL ? 2 : 3;
};

/* ---------------------------------------------------------------------------
 * Determinism — the seed and the portable candidate pre-order
 * ------------------------------------------------------------------------- */

/**
 * The 32-bit seed `mulberry32` is started from, derived from the five plan
 * inputs and nothing else.
 *
 * THE REDUCTION IS PART OF THE CONTRACT, so it is spelled out rather than left
 * to be "improved": the five fields are joined with `|` in the declared order,
 * hashed with SHA-1, and the FIRST FOUR BYTES of the digest are read as an
 * unsigned big-endian integer. Any other reduction — a different field order, a
 * different separator, a different slice of the digest, `parseInt` on the hex —
 * is a different seed, and a different seed is a different plan for every user
 * in the system. SHA-1 is used for distribution, not security: nothing here
 * authenticates anything, and the digest never leaves the process.
 *
 * `|` is safe as a separator because none of the five fields can contain one: a
 * Firebase uid is alphanumeric, a day key is digits and dashes, and the three
 * revisions are integers. That is what stops two different input tuples from
 * hashing the same material.
 *
 * THE IDEMPOTENCY KEY IS NOT AN INPUT, and {@link PlanSeedInputs} gives it
 * nowhere to live. The consequence is the point: retrying a failed generation
 * under a fresh key replays the same search and reaches the same verdict, so
 * "no meals match" cannot be shaken off by trying again — only a preference, a
 * target or the catalog changing can change the answer. A regeneration varies
 * because `generationAttempt` does.
 */
export const derivePlanSeed = (inputs: PlanSeedInputs): number => {
    const material = [
        inputs.userId,
        inputs.startDate,
        String(inputs.preferencesRevision),
        String(inputs.targetsRevision),
        String(inputs.generationAttempt),
    ].join(SEED_FIELD_SEPARATOR);

    return createHash('sha1').update(material, 'utf8').digest().readUInt32BE(0);
};

/**
 * The portable identity `(slug, version, portionMultiplier)` as one string key.
 *
 * Spelled ONCE, here, because four readers now compare candidates by it — the
 * pre-order, the baseline rank map, the analysis witness and the determinism
 * checks — and four spellings of the same triple is how one of them ends up
 * joining on the wrong thing. `|` is safe as a separator for the same reason it
 * is in the seed material: a slug carries no `|`, and the other two members are
 * numbers.
 *
 * Deliberately NOT built from `recipe_version_id`: this key must mean the same
 * thing in two databases loaded from one catalog release, and their ids differ.
 */
export const portableCandidateIdentity = (
    slug: string,
    version: number,
    portionMultiplier: number,
): string => [slug, String(version), String(portionMultiplier)].join(SEED_FIELD_SEPARATOR);

/** {@link portableCandidateIdentity} for a built candidate. */
export const planCandidateIdentity = (candidate: PlanCandidate): string =>
    portableCandidateIdentity(
        candidate.recipe.slug,
        candidate.recipe.version,
        candidate.portionMultiplier,
    );

/**
 * The shuffle ranks of an existing candidate set, keyed by portable identity.
 *
 * What a counterfactual probe hands back to {@link buildPlanCandidates} so the
 * candidates it shares with the baseline keep the ranks the baseline gave them.
 */
export const baselineCandidateRanks = (
    candidates: readonly PlanCandidate[],
): Map<string, number> => {
    const ranks = new Map<string, number>();

    for (const candidate of candidates) {
        ranks.set(planCandidateIdentity(candidate), candidate.shuffleRank);
    }

    return ranks;
};

/**
 * One Fisher–Yates walk of `items` under `mulberry32(seed)`, as a new array.
 *
 * The walk is stated exactly once even though two callers need it — the whole
 * candidate set, and the newcomers a relaxation admits — because the direction
 * and the draw are the contract: from the end (`for i = n-1 … 1`,
 * `j = floor(rand() × (i+1))`, swap). Walking from the start, or drawing over a
 * different range, is a different permutation and therefore a different plan
 * for every user in the system.
 */
const seededPermutation = <T>(items: readonly T[], seed: number): T[] => {
    const shuffled = [...items];
    const draw = mulberry32(seed);

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const target = Math.floor(draw() * (index + 1));
        const held = shuffled[index];
        shuffled[index] = shuffled[target];
        shuffled[target] = held;
    }

    return shuffled;
};

/**
 * Orders candidates by the portable identity `(slug, version, portionMultiplier)`.
 *
 * Never by `recipe_version_id` or `recipe_id`: those are `gen_random_uuid()`
 * values, so two databases loaded from the same catalog release hold the same
 * recipes under different ids, and an id-ordered pre-order would hand the
 * seeded shuffle a different input on each — producing different plans from
 * identical inputs. Slug is unique per recipe and version is unique within it,
 * so the triple is a total order with no fallback needed.
 */
const comparePortableIdentity = (left: PlanCandidate, right: PlanCandidate): number => {
    if (left.recipe.slug !== right.recipe.slug) {
        return left.recipe.slug < right.recipe.slug ? -1 : 1;
    }
    if (left.recipe.version !== right.recipe.version) {
        return left.recipe.version - right.recipe.version;
    }

    return left.portionMultiplier - right.portionMultiplier;
};

/**
 * Every `(recipe, portion)` pair this user may be served, pre-ordered portably
 * and stamped with its shuffle rank.
 *
 * Three steps, in this order, and the order is the whole rule:
 *
 *   1. FILTER by slot-independent eligibility, delegated whole to
 *      `recipe.logic.ts`. Ineligible recipes are dropped before the stream runs
 *      so they cannot consume draws.
 *   2. PRE-ORDER by portable identity — before any random draw.
 *   3. WALK ONCE with `mulberry32(seed)`, Fisher–Yates from the end
 *      (`for i = n-1 … 1`, `j = floor(rand() × (i+1))`, swap), and take each
 *      candidate's index in the resulting permutation as its `shuffleRank`.
 *      One walk over the whole set, one rank per candidate — not re-seeded per
 *      slot or per day, which would make a candidate's rank depend on where it
 *      was asked about.
 *
 * The result is returned in PRE-ORDER, with the randomness carried entirely in
 * `shuffleRank`, so the return value is readable and the shuffle is still the
 * only thing that breaks a score tie. The portion set is the main-slot one for
 * every recipe; a snack slot narrows it later, which is sound because the snack
 * multipliers are a strict subset.
 *
 * `baselineRanks` — absent for GENERATION, which is the only caller that
 * defines ranks — pins the ranks of candidates a previous set already ranked,
 * and exists because step 3 is otherwise re-run over a DIFFERENT set: a
 * counterfactual probe admits more recipes, the walk draws differently, and
 * every candidate shared with the baseline lands on another rank. A probe whose
 * shared candidates were merely reshuffled can then "succeed" on the baseline's
 * own candidates in a different move order, and the analysis would blame the
 * relaxed preference for a week the relaxation had nothing to do with. So
 * shared candidates keep EXACTLY their baseline rank and only the newcomers are
 * drawn for, ranked after the baseline's highest rank.
 *
 * RANKING NEWCOMERS LAST IS SOUND AND CONSERVATIVE. A rank breaks nothing but
 * an exact score tie, so placing newcomers behind the baseline can only make
 * them tried later than a shared candidate of equal score — never earlier. It
 * therefore cannot manufacture a probe success, and a probe that genuinely
 * needs a newcomer still finds one and says so through the witness the analysis
 * requires before it emits a row.
 */
export const buildPlanCandidates = (
    recipes: readonly PlanRecipeCandidate[],
    preferences: PlanningPreferences,
    seed: number,
    portionPolicy: PortionPolicy = DEFAULT_PORTION_POLICY,
    baselineRanks?: ReadonlyMap<string, number>,
): PlanCandidate[] => {
    const candidates: PlanCandidate[] = [];
    const multipliers = allPortionMultipliers(portionPolicy);

    for (const recipe of recipes) {
        if (!isEligibleForPlanning(recipe, preferences, null)) {
            continue;
        }

        for (const portionMultiplier of multipliers) {
            candidates.push({
                recipe,
                portionMultiplier,
                nutrition: scalePlannedNutrition(recipe.per_serving, portionMultiplier),
                shuffleRank: 0,
            });
        }
    }

    candidates.sort(comparePortableIdentity);

    let highestBaselineRank = -1;
    const newcomers: PlanCandidate[] = [];

    for (const candidate of candidates) {
        const baselineRank = baselineRanks?.get(planCandidateIdentity(candidate));

        if (baselineRank === undefined) {
            newcomers.push(candidate);
        } else {
            candidate.shuffleRank = baselineRank;
        }
    }

    if (baselineRanks) {
        // Over the WHOLE baseline, not just the shared part: a rank the probe's
        // own set does not reach still belongs to the baseline's permutation,
        // and newcomers must sit above all of them for the "tried last among
        // equals" property to hold.
        for (const rank of baselineRanks.values()) {
            highestBaselineRank = Math.max(highestBaselineRank, rank);
        }
    }

    // With no baseline the newcomers ARE the whole pre-ordered set and the
    // highest baseline rank is −1, so this is the one walk of step 3 assigning
    // 0…n−1 — the generation path, unchanged.
    seededPermutation(newcomers, seed).forEach((candidate, index) => {
        candidate.shuffleRank = highestBaselineRank + 1 + index;
    });

    return candidates;
};

/**
 * The candidates a single slot may draw from: eligible FOR THAT SLOT, at a
 * multiplier the slot allows.
 *
 * The slot clause is `isEligibleForPlanning`'s too — this module never reads
 * `meal_slots` itself, because a second membership test is a second place for
 * the rule to drift.
 */
export const candidatesForSlot = (
    candidates: readonly PlanCandidate[],
    preferences: PlanningPreferences,
    slot: MealSlot,
    portionPolicy: PortionPolicy = DEFAULT_PORTION_POLICY,
): PlanCandidate[] => {
    const allowed = new Set(portionMultipliersForSlot(slot, portionPolicy));

    return candidates.filter(
        (candidate) =>
            allowed.has(candidate.portionMultiplier) &&
            isEligibleForPlanning(candidate.recipe, preferences, slot),
    );
};

/** Distinct recipes available to a slot — what the coverage checks count. */
export const eligibleRecipeCountForSlot = (
    candidates: readonly PlanCandidate[],
    preferences: PlanningPreferences,
    slot: MealSlot,
    portionPolicy: PortionPolicy = DEFAULT_PORTION_POLICY,
): number => {
    const recipeIds = new Set<string>();

    for (const candidate of candidatesForSlot(candidates, preferences, slot, portionPolicy)) {
        recipeIds.add(candidate.recipe.recipe_id);
    }

    return recipeIds.size;
};

/* ---------------------------------------------------------------------------
 * Repetition — a HARD rule, and only a hard rule
 * ------------------------------------------------------------------------- */

/**
 * Whether placing this recipe would break the week's repetition rule: at most
 * {@link MAX_RECIPE_USES_PER_WEEK} appearances, and never within a day of
 * another appearance.
 *
 * A HARD eligibility test for the slot, deliberately NOT a soft score penalty.
 * A penalty would let a sufficiently attractive recipe appear five times, and
 * the whole point is that it cannot.
 *
 * "Never on consecutive days" is spacing, so it is read as "at least one clear
 * day between appearances" — which also rules out twice on the SAME day, zero
 * days apart. The alternative reading, allowing a recipe at breakfast and again
 * at dinner while forbidding it the next day, is strictly worse for the user
 * and cannot make a week feasible that this reading refuses: needing one recipe
 * twice in one day means a slot has fewer than two recipes, which is already a
 * coverage failure.
 *
 * Every argument looks BACKWARDS — uses so far, yesterday's recipes, today's
 * placements. That is what lets the depth-first search trust its completed
 * days: no later placement can retroactively invalidate an earlier one.
 */
export const violatesRepetitionRule = (
    recipeId: string,
    usesSoFar: number,
    previousDayRecipeIds: ReadonlySet<string>,
    currentDayRecipeIds: ReadonlySet<string>,
): boolean =>
    usesSoFar >= MAX_RECIPE_USES_PER_WEEK ||
    previousDayRecipeIds.has(recipeId) ||
    currentDayRecipeIds.has(recipeId);

/* ---------------------------------------------------------------------------
 * Scoring — move ORDER, never acceptance
 * ------------------------------------------------------------------------- */

const requirePositiveTarget = (value: number, field: string): number => {
    if (!Number.isFinite(value) || value <= 0) {
        throw new MealPlanInputError(
            `${field} must be a finite number greater than 0 to plan against, received ${String(value)}`,
            field,
        );
    }

    return value;
};

/**
 * How far the day built so far sits from its guidance point, as a sum of
 * relative gaps: `|cumKcal − share·target| / target` plus the same term for
 * protein, carbs and fat.
 *
 * Relative rather than absolute, so a 20 g protein gap and a 200 kcal gap are
 * comparable rather than the larger unit dominating. Each target must be
 * positive — a zero target has no meaningful relative gap, and dividing by it
 * would score every candidate `Infinity` and silently flatten the move order
 * into the shuffle.
 *
 * GUIDANCE, NOT ACCEPTANCE. A high proximity only means a candidate is tried
 * later; {@link evaluateDayTolerance} is the only thing that can refuse a day.
 */
export const targetProximity = (
    cumulative: MealPlanMacroTotals,
    targets: MealPlanMacroTotals,
    cumulativeShare: number,
): number => {
    const calorieTarget = requirePositiveTarget(targets.calories, 'targets.calories');
    const proteinTarget = requirePositiveTarget(targets.protein, 'targets.protein');
    const carbsTarget = requirePositiveTarget(targets.carbs, 'targets.carbs');
    const fatTarget = requirePositiveTarget(targets.fat, 'targets.fat');

    return (
        Math.abs(cumulative.calories - cumulativeShare * calorieTarget) / calorieTarget +
        Math.abs(cumulative.protein - cumulativeShare * proteinTarget) / proteinTarget +
        Math.abs(cumulative.carbs - cumulativeShare * carbsTarget) / carbsTarget +
        Math.abs(cumulative.fat - cumulativeShare * fatTarget) / fatTarget
    );
};

/**
 * How much dearer a recipe is than the user's band, in whole tiers.
 *
 * One-sided: a recipe CHEAPER than the band is not rewarded, because a budget
 * is a ceiling the user expressed, not a target to hit. A user on tier 3 — which
 * is also what "no budget preference" resolves to — is never penalised at all.
 */
export const budgetPenalty = (recipeTier: number, userTier: BudgetTier): number =>
    Math.max(0, recipeTier - userTier);

/**
 * How many of this candidate's ingredients are already on the week's grocery
 * list, capped at {@link REUSE_BONUS_CAP}.
 *
 * The only term that pulls the score DOWN (toward "try this first"), because a
 * week that reuses ingredients is a shorter shopping list and less waste.
 * Counted over DISTINCT foods, so a recipe listing one food twice earns one
 * point, and capped so a recipe made entirely of staples cannot outrank
 * everything on sharing alone.
 */
export const reuseBonus = (candidate: PlanCandidate, plannedFoodIds: ReadonlySet<string>): number => {
    const shared = new Set<string>();

    for (const ingredient of candidate.recipe.ingredients) {
        if (plannedFoodIds.has(ingredient.catalog_food_id)) {
            shared.add(ingredient.catalog_food_id);
        }
    }

    return Math.min(REUSE_BONUS_CAP, shared.size);
};

/**
 * A candidate's move-order score with it placed:
 * `1.0·proximity + 0.5·budgetPenalty − 0.25·reuseBonus`. Lower is tried first.
 *
 * Evaluated on the day INCLUDING this candidate against the cumulative share
 * for its slot, which is what makes a breakfast judged on the quarter of the
 * day it is meant to cover rather than on the whole.
 */
export const scoreCandidate = (
    candidate: PlanCandidate,
    cumulativeBefore: MealPlanMacroTotals,
    cumulativeShare: number,
    targets: MealPlanMacroTotals,
    userBudgetTier: BudgetTier,
    plannedFoodIds: ReadonlySet<string>,
): number => {
    const cumulativeAfter: MealPlanMacroTotals = {
        calories: cumulativeBefore.calories + candidate.nutrition.calories,
        protein: cumulativeBefore.protein + candidate.nutrition.protein,
        carbs: cumulativeBefore.carbs + candidate.nutrition.carbs,
        fat: cumulativeBefore.fat + candidate.nutrition.fat,
    };

    return (
        TARGET_PROXIMITY_WEIGHT * targetProximity(cumulativeAfter, targets, cumulativeShare) +
        BUDGET_PENALTY_WEIGHT * budgetPenalty(candidate.recipe.budget_tier, userBudgetTier) +
        -REUSE_BONUS_WEIGHT * reuseBonus(candidate, plannedFoodIds)
    );
};

/** A candidate with the score its move order was decided by. */
export interface ScoredCandidate {
    candidate: PlanCandidate;
    score: number;
}

/**
 * Move order: ascending score, and on a tie the shuffle rank — THE one and only
 * tie-break.
 *
 * No lexical fallback, deliberately. Adding one would make the seed irrelevant
 * for ties, which is the common case in a catalog of interchangeable recipes,
 * and two users with identical answers would then receive identical weeks.
 * Scores are compared within {@link TOLERANCE_EPSILON} so two candidates whose
 * scores are mathematically equal but summed by different paths still tie into
 * the shuffle instead of being ordered by a rounding artefact. Shuffle ranks are
 * positions in a permutation, so they are distinct and the order is total.
 */
export const compareCandidateMoves = (left: ScoredCandidate, right: ScoredCandidate): number => {
    if (Math.abs(left.score - right.score) > TOLERANCE_EPSILON) {
        return left.score - right.score;
    }

    return left.candidate.shuffleRank - right.candidate.shuffleRank;
};

/* ---------------------------------------------------------------------------
 * Day tolerances — the only hard nutrition test
 * ------------------------------------------------------------------------- */

/**
 * Guards a value that was SUMMED rather than chosen — a day total, or one
 * meal's planned figure on the way into one.
 *
 * Finite-only, and deliberately NOT {@link requirePositiveTarget}: zero is a
 * legal total (an empty day sums to zero, and every band below then reports it
 * as a breach, which is the correct answer) and a negative one is arithmetic to
 * judge rather than an input to refuse. What is never legal is a value that is
 * not a number at all.
 *
 * It has to be refused HERE rather than judged downstream because every band in
 * {@link evaluateDayTolerance} is written in the positive form — `> band`, and
 * `< low || > high` — and every relational comparison with NaN is false. An
 * unguarded NaN pushes no breach, so a day of corrupt arithmetic would be
 * reported as `withinTolerance: true`, the search would accept it as its first
 * feasible assignment, and the fault would reach the user as a published plan.
 *
 * A throw is the right answer and a breach is not. A breach is a FEASIBILITY
 * verdict, which the caller renders as "these preferences don't fit this week";
 * a non-finite stored figure is a programming or data-integrity fault, so it
 * takes the same route as an impossible target one section above — a
 * {@link MealPlanInputError} naming the field, for the controller to surface
 * and an engineer to fix. Infinity is refused on the same ground: it happens to
 * trip a band today, but "your week is infeasible" is the wrong thing to tell a
 * user whose stored data is broken.
 */
const requireFiniteTotal = (value: number, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw new MealPlanInputError(
            `${field} must be a finite number to judge a day against its targets, received ${String(value)}`,
            field,
        );
    }

    return value;
};

/** Which of a completed day's four values fell outside its band. */
export type DayToleranceBreach = 'calories' | 'protein' | 'carbs' | 'fat';

export interface DayToleranceVerdict {
    withinTolerance: boolean;
    /** Every breach, in `calories, protein, carbs, fat` order. Empty when the day passes. */
    breaches: DayToleranceBreach[];
}

/**
 * Whether a COMPLETED day's totals are acceptable.
 *
 * The bands, each inclusive and each deliberate:
 *  - calories within ±10 % of target — proportional, because 10 % of 1,400 and
 *    of 3,000 are different amounts of food;
 *  - protein between target − 15 g and target + 25 g — ASYMMETRIC on purpose:
 *    overshooting protein is harmless where undershooting defeats the point of
 *    setting a protein target, so the room above is wider than the room below;
 *  - carbs and fat within ±15 g OR ±15 %, whichever is LARGER — the absolute
 *    floor keeps a small fat target (say 50 g, where 15 % is 7.5 g) from being
 *    impossible to hit with whole recipes, and the relative band keeps a large
 *    one from being trivial.
 *
 * Applied only to a finished day. Nothing here judges a partial day — that is
 * what the guidance shares are for — and no candidate is ever refused by this
 * function.
 */
export const evaluateDayTolerance = (
    totals: MealPlanMacroTotals,
    targets: MealPlanMacroTotals,
): DayToleranceVerdict => {
    const calorieTarget = requirePositiveTarget(targets.calories, 'targets.calories');
    const proteinTarget = requirePositiveTarget(targets.protein, 'targets.protein');
    const carbsTarget = requirePositiveTarget(targets.carbs, 'targets.carbs');
    const fatTarget = requirePositiveTarget(targets.fat, 'targets.fat');

    // Targets are judged first and on stricter terms — a target must be a
    // usable number to plan against, where a total need only be a number. Both
    // halves are guarded before the first band is applied, and every band below
    // reads the guarded local rather than the argument, so no comparison can be
    // reached by a value this function has not established is finite.
    const calories = requireFiniteTotal(totals.calories, 'totals.calories');
    const protein = requireFiniteTotal(totals.protein, 'totals.protein');
    const carbs = requireFiniteTotal(totals.carbs, 'totals.carbs');
    const fat = requireFiniteTotal(totals.fat, 'totals.fat');

    const breaches: DayToleranceBreach[] = [];

    if (Math.abs(calories - calorieTarget) > CALORIE_TOLERANCE_RATIO * calorieTarget + TOLERANCE_EPSILON) {
        breaches.push('calories');
    }

    if (
        protein < proteinTarget - PROTEIN_TOLERANCE_UNDER_G - TOLERANCE_EPSILON ||
        protein > proteinTarget + PROTEIN_TOLERANCE_OVER_G + TOLERANCE_EPSILON
    ) {
        breaches.push('protein');
    }

    const carbsBand = Math.max(MACRO_TOLERANCE_ABSOLUTE_G, MACRO_TOLERANCE_RATIO * carbsTarget);
    if (Math.abs(carbs - carbsTarget) > carbsBand + TOLERANCE_EPSILON) {
        breaches.push('carbs');
    }

    const fatBand = Math.max(MACRO_TOLERANCE_ABSOLUTE_G, MACRO_TOLERANCE_RATIO * fatTarget);
    if (Math.abs(fat - fatTarget) > fatBand + TOLERANCE_EPSILON) {
        breaches.push('fat');
    }

    return { withinTolerance: breaches.length === 0, breaches };
};

/** {@link evaluateDayTolerance} reduced to the boolean the search asks for. */
export const isDayWithinTolerance = (
    totals: MealPlanMacroTotals,
    targets: MealPlanMacroTotals,
): boolean => evaluateDayTolerance(totals, targets).withinTolerance;

/**
 * A day's planned totals, summed at FULL PRECISION.
 *
 * Never rounded here. `mealPlan.mapper.ts` rounds for display and
 * `nutrition.service.ts::insertPlannedMealEntry` rounds the diary snapshot once
 * on insert; rounding each meal first and summing the results would drift the
 * day total away from both.
 *
 * Each meal's four figures are guarded as they are added, so a non-finite one
 * is named with the meal it came from rather than anonymised into the sum. A
 * sum is where a NaN stops being attributable: `400 + NaN` and `NaN + 400` are
 * the same value, and by the time the total reaches
 * {@link evaluateDayTolerance} nothing can say which meal spoiled it. Summing
 * an empty list still returns four zeros — that is a day with no meals, not a
 * fault.
 */
export const computeDayTotals = (
    meals: readonly { planned: MealPlanMacroTotals }[],
): MealPlanMacroTotals => {
    const totals: MealPlanMacroTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };

    for (let index = 0; index < meals.length; index += 1) {
        const { planned } = meals[index];
        const at = `meals[${index}].planned`;

        totals.calories += requireFiniteTotal(planned.calories, `${at}.calories`);
        totals.protein += requireFiniteTotal(planned.protein, `${at}.protein`);
        totals.carbs += requireFiniteTotal(planned.carbs, `${at}.carbs`);
        totals.fat += requireFiniteTotal(planned.fat, `${at}.fat`);
    }

    return totals;
};

/**
 * Whether two macro sets are the same four numbers.
 *
 * A BUSINESS INVARIANT, not a formatting detail, which is why it lives beside
 * the rest of the planning rules rather than in the mapper. It decides two
 * things the user sees and one the server refuses:
 *
 *  - `MealPlanResponse.targetsStale` — the plan was built against numbers the
 *    user has since changed, so the day card says so instead of silently
 *    showing a week aimed at a target that no longer exists.
 *  - the publication gate in `mealPlan.service.ts`, where what is about to be
 *    written as `targets_snapshot` must equal what the locked targets gate just
 *    certified as confirmed; a mismatch is `targets_unconfirmed` and no plan is
 *    published.
 *
 * Exact equality on purpose, with no tolerance: all four values are integers
 * confirmed by the user or copied from that confirmation, so "close enough"
 * would mean publishing a week against numbers nobody confirmed. Comparing the
 * four keys explicitly rather than by key iteration keeps the comparison
 * exhaustive at compile time — a fifth macro would not silently go unchecked.
 */
export const sameMacroTotals = (left: MealPlanMacroTotals, right: MealPlanMacroTotals): boolean =>
    left.calories === right.calories &&
    left.protein === right.protein &&
    left.carbs === right.carbs &&
    left.fat === right.fat;

/* ---------------------------------------------------------------------------
 * The search — depth-first, best-first move order, first feasible, bounded
 * ------------------------------------------------------------------------- */

const EMPTY_RECIPE_IDS: ReadonlySet<string> = new Set<string>();

/**
 * The two evaluation budgets a run may be held to.
 *
 * Present as a parameter for ONE reason: under the shipped policy the per-plan
 * cap is exactly {@link PLAN_DAY_COUNT} × the per-day cap, so a week that trips
 * one guard would trip the other at the same moment and no fixture could tell
 * them apart. Supplying the caps separately makes each guard independently
 * observable, which is what lets a test prove the per-plan counter spans day
 * boundaries and the per-day counter accumulates across backtracking
 * re-entries. Production never passes it — the shipped policy is
 * {@link MAX_EVALUATIONS_PER_DAY} and {@link MAX_EVALUATIONS_PER_PLAN}, and
 * both {@link generateWeeklyPlan} and the analysis probes leave this absent.
 */
export interface PlanSearchBudget {
    perDay?: number;
    perPlan?: number;
}

/** Everything one search run needs, and nothing it could fetch. */
export interface PlanSearchInput {
    dates: readonly PlanDate[];
    slots: readonly SlotSchedule[];
    candidatesBySlot: ReadonlyMap<MealSlot, readonly PlanCandidate[]>;
    targets: MealPlanMacroTotals;
    userBudgetTier: BudgetTier;
    /** Injected wall-clock check. Absent means the run is unbounded in time. */
    shouldAbort?: () => boolean;
    /** Absent — the production case — means the two policy constants. */
    budget?: PlanSearchBudget;
}

/** Which evaluation budget ran out, or null when neither did. */
export type PlanSearchExhaustion = 'day' | 'plan';

/**
 * What a run found, and if it found nothing, how it ran out.
 *
 * The three failure modes are kept apart because they become three different
 * answers: `aborted` is the only one that is a server failure, `exhausted` and a
 * plain infeasible search are both feasibility verdicts, and `frontierDayIndex`
 * is what the verdict points the user at.
 */
export interface PlanSearchOutcome {
    days: PlannedMealAssignment[][] | null;
    evaluations: number;
    /**
     * The furthest day the search ever failed to close — the wall it kept
     * hitting.
     *
     * Read as "the first day that could not close", which needs saying because
     * the literal first day is useless: if the whole week fails then day 0
     * trivially "could not close" as part of a complete week, every time. The
     * informative day is the frontier — days before it did close, and something
     * about this one did not.
     */
    frontierDayIndex: number;
    /** An evaluation budget ran out. A feasibility verdict, never a 5xx. */
    exhausted: boolean;
    /**
     * WHICH budget ran out, evaluated guard by guard rather than inferred.
     *
     * `exhausted` alone cannot say whether one day spent its whole allowance or
     * the week spent the plan's, and the two mean different things: a day guard
     * says this day is the wall, a plan guard says the week as a whole is. Null
     * whenever `exhausted` is false.
     */
    exhaustedBy: PlanSearchExhaustion | null;
    /** The injected deadline fired. The caller decides what that means. */
    aborted: boolean;
}

/**
 * The diagnostics a failed search hands to the failure it becomes.
 *
 * Deliberately NOT a wire shape. The 422 body is
 * `{limitingConstraints, allergiesKept}` (§0.5.2) and has no member for a day
 * index, so these values travel on {@link NoMatchingMealsError} for logs and
 * for the analysis, and never into a response.
 */
export interface PlanSearchDiagnostics {
    exhausted: boolean;
    exhaustedBy: PlanSearchExhaustion | null;
    /** The first day the search could not close. */
    frontierDayIndex: number;
    evaluations: number;
}

/**
 * Reads one supplied budget, or falls back to the shipped policy constant.
 *
 * A fractional or non-positive cap is a programming fault rather than a
 * feasibility answer — a cap of 0 would report every week as exhausted before
 * the first placement, and a fractional one would trip at an amount no policy
 * states — so it throws for the same reason a non-positive target does.
 */
const resolveEvaluationBudget = (supplied: number | undefined, fallback: number, field: string): number => {
    if (supplied === undefined) {
        return fallback;
    }

    if (!Number.isInteger(supplied) || supplied <= 0) {
        throw new MealPlanInputError(
            `${field} must be a positive integer number of evaluations, received ${String(supplied)}`,
            field,
        );
    }

    return supplied;
};

/**
 * Assigns every day of the week, or reports how it failed.
 *
 * THE OBJECTIVE IS "BEST-FIRST MOVE ORDER, FIRST FEASIBLE" — not a global
 * optimum — and that is a deliberate choice, not an approximation to be
 * upgraded later. A globally optimal week would have to compare whole weeks,
 * which has no deterministic tie-break (two weeks scoring identically would be
 * separated by nothing, so the plan would depend on enumeration order) and no
 * bound on work (it cannot stop at the first solution, so every branch must be
 * explored). Trying candidates in score order and accepting the first feasible
 * week keeps BOTH properties: the same inputs always give the same plan, and
 * the search always terminates inside its budget.
 *
 * The shape of the recursion, and why each piece is there:
 *  - days in DATE order, slots in SCHEDULE order, candidates in move order;
 *  - one *evaluation* is one candidate placed in one slot;
 *  - a day is accepted only when its LAST slot is filled AND the completed
 *    day passes {@link evaluateDayTolerance} — the guidance shares never
 *    accept or reject anything;
 *  - a slot with no candidate left backtracks to the previous slot's next
 *    candidate;
 *  - A DAY THAT DEAD-ENDS BACKTRACKS INTO THE PREVIOUS DAY, which is what
 *    preserves the week-wide repetition rule without a second pass. Day 6
 *    discovering that days 1 to 5 have used up every eligible dinner is
 *    recoverable precisely because day 5 can take its next assignment instead.
 *
 * Budgets are per day AND per plan, and the per-day counter ACCUMULATES across
 * re-entries: a day re-entered by backtracking keeps spending the same 2,000,
 * so a pathological week cannot spend 2,000 per visit and run forever. Running
 * out ends the search and is reported, never thrown. The two guards are
 * evaluated SEPARATELY and the outcome names the one that fired, because
 * "exhausted" on its own cannot distinguish one day hitting its wall from the
 * week spending everything it had — see {@link PlanSearchBudget} for why the
 * caps are a parameter at all.
 *
 * Exported so the guards, the frontier and the evaluation count are observable
 * without reaching through {@link generateWeeklyPlan}; the analysis probes call
 * it too, so there is exactly one search.
 */
export const searchPlanWeek = (input: PlanSearchInput): PlanSearchOutcome => {
    const { dates, slots, candidatesBySlot, targets, userBudgetTier, shouldAbort } = input;

    const perDayBudget = resolveEvaluationBudget(
        input.budget?.perDay,
        MAX_EVALUATIONS_PER_DAY,
        'budget.perDay',
    );
    const perPlanBudget = resolveEvaluationBudget(
        input.budget?.perPlan,
        MAX_EVALUATIONS_PER_PLAN,
        'budget.perPlan',
    );

    const placed: PlannedMealAssignment[][] = dates.map(() => []);
    const dayRecipeIds: Set<string>[] = dates.map(() => new Set<string>());
    const usesByRecipeId = new Map<string, number>();
    // Reference counts beside the set: an ingredient stays "on the list" while
    // ANY placed meal still uses it, so unwinding one meal must not withdraw a
    // food another still needs. The set is what `reuseBonus` reads.
    const plannedFoodCounts = new Map<string, number>();
    const plannedFoodIds = new Set<string>();
    const evaluationsPerDay: number[] = dates.map(() => 0);

    let evaluations = 0;
    let frontierDayIndex = 0;
    let exhausted = false;
    let exhaustedBy: PlanSearchExhaustion | null = null;
    let aborted = false;

    const addFoods = (candidate: PlanCandidate): void => {
        for (const ingredient of candidate.recipe.ingredients) {
            const next = (plannedFoodCounts.get(ingredient.catalog_food_id) ?? 0) + 1;
            plannedFoodCounts.set(ingredient.catalog_food_id, next);
            plannedFoodIds.add(ingredient.catalog_food_id);
        }
    };

    const removeFoods = (candidate: PlanCandidate): void => {
        for (const ingredient of candidate.recipe.ingredients) {
            const next = (plannedFoodCounts.get(ingredient.catalog_food_id) ?? 1) - 1;

            if (next <= 0) {
                plannedFoodCounts.delete(ingredient.catalog_food_id);
                plannedFoodIds.delete(ingredient.catalog_food_id);
            } else {
                plannedFoodCounts.set(ingredient.catalog_food_id, next);
            }
        }
    };

    const place = (dayIndex: number, slot: SlotSchedule, candidate: PlanCandidate): void => {
        const recipeId = candidate.recipe.recipe_id;

        placed[dayIndex].push({
            slot: slot.slot,
            slotTime: slot.time,
            sortOrder: slot.sortOrder,
            recipeVersionId: candidate.recipe.recipe_version_id,
            recipeId,
            slug: candidate.recipe.slug,
            version: candidate.recipe.version,
            portionMultiplier: candidate.portionMultiplier,
            planned: { ...candidate.nutrition },
        });
        // A plain set is safe because `violatesRepetitionRule` forbids the same
        // recipe twice in one day, so this add and the delete below are never
        // unbalanced by a second placement of the same recipe.
        dayRecipeIds[dayIndex].add(recipeId);
        usesByRecipeId.set(recipeId, (usesByRecipeId.get(recipeId) ?? 0) + 1);
        addFoods(candidate);
    };

    const unplace = (dayIndex: number, candidate: PlanCandidate): void => {
        const recipeId = candidate.recipe.recipe_id;

        placed[dayIndex].pop();
        dayRecipeIds[dayIndex].delete(recipeId);

        const remaining = (usesByRecipeId.get(recipeId) ?? 1) - 1;
        if (remaining <= 0) {
            usesByRecipeId.delete(recipeId);
        } else {
            usesByRecipeId.set(recipeId, remaining);
        }

        removeFoods(candidate);
    };

    const orderedMoves = (
        dayIndex: number,
        slot: SlotSchedule,
        cumulative: MealPlanMacroTotals,
    ): ScoredCandidate[] => {
        const previousDayRecipeIds = dayIndex > 0 ? dayRecipeIds[dayIndex - 1] : EMPTY_RECIPE_IDS;
        const currentDayRecipeIds = dayRecipeIds[dayIndex];
        const pool = candidatesBySlot.get(slot.slot) ?? [];
        const moves: ScoredCandidate[] = [];

        for (const candidate of pool) {
            const recipeId = candidate.recipe.recipe_id;

            if (
                violatesRepetitionRule(
                    recipeId,
                    usesByRecipeId.get(recipeId) ?? 0,
                    previousDayRecipeIds,
                    currentDayRecipeIds,
                )
            ) {
                continue;
            }

            moves.push({
                candidate,
                score: scoreCandidate(
                    candidate,
                    cumulative,
                    slot.cumulativeShare,
                    targets,
                    userBudgetTier,
                    plannedFoodIds,
                ),
            });
        }

        moves.sort(compareCandidateMoves);

        return moves;
    };

    const solveSlot = (
        dayIndex: number,
        slotIndex: number,
        cumulative: MealPlanMacroTotals,
    ): boolean => {
        // No stop check on entry: `exhausted` and `aborted` are only ever set
        // inside the move loop below, and the guard that follows each recursive
        // call stops the unwind at the level that observes it — so every entry
        // into this function happens with both flags already known false.
        if (slotIndex === slots.length) {
            if (!isDayWithinTolerance(cumulative, targets)) {
                return false;
            }

            return solveDay(dayIndex + 1);
        }

        const slot = slots[slotIndex];

        for (const move of orderedMoves(dayIndex, slot, cumulative)) {
            if (shouldAbort?.() === true) {
                aborted = true;
                return false;
            }

            // The day guard is asked first because it is the narrower claim: a
            // day that has spent its own allowance is the wall the user hit,
            // whatever the week has left. Only once this day still has room
            // does the plan-wide allowance decide.
            if (evaluationsPerDay[dayIndex] >= perDayBudget) {
                exhausted = true;
                exhaustedBy = 'day';
                return false;
            }

            if (evaluations >= perPlanBudget) {
                exhausted = true;
                exhaustedBy = 'plan';
                return false;
            }

            evaluationsPerDay[dayIndex] += 1;
            evaluations += 1;

            place(dayIndex, slot, move.candidate);

            const next: MealPlanMacroTotals = {
                calories: cumulative.calories + move.candidate.nutrition.calories,
                protein: cumulative.protein + move.candidate.nutrition.protein,
                carbs: cumulative.carbs + move.candidate.nutrition.carbs,
                fat: cumulative.fat + move.candidate.nutrition.fat,
            };

            if (solveSlot(dayIndex, slotIndex + 1, next)) {
                return true;
            }

            unplace(dayIndex, move.candidate);

            if (exhausted || aborted) {
                return false;
            }
        }

        return false;
    };

    const solveDay = (dayIndex: number): boolean => {
        if (dayIndex === dates.length) {
            return true;
        }

        // Reached only from `solveSlot`'s day-complete branch or as the search's
        // own entry point, both of which run with the stop flags false — see the
        // note in `solveSlot`.
        const solved = solveSlot(dayIndex, 0, { calories: 0, protein: 0, carbs: 0, fat: 0 });

        if (!solved) {
            frontierDayIndex = Math.max(frontierDayIndex, dayIndex);
        }

        return solved;
    };

    const solved = solveDay(0);

    return {
        days: solved ? placed : null,
        evaluations,
        frontierDayIndex,
        exhausted,
        exhaustedBy,
        aborted,
    };
};

/** The candidates each slot may draw from, resolved once before the search. */
const groupCandidatesBySlot = (
    candidates: readonly PlanCandidate[],
    preferences: PlanningPreferences,
    slots: readonly SlotSchedule[],
    portionPolicy: PortionPolicy,
): Map<MealSlot, PlanCandidate[]> => {
    const bySlot = new Map<MealSlot, PlanCandidate[]>();

    for (const slot of slots) {
        bySlot.set(slot.slot, candidatesForSlot(candidates, preferences, slot.slot, portionPolicy));
    }

    return bySlot;
};

/* ---------------------------------------------------------------------------
 * Limiting-constraint analysis — deterministic, and allergies are never in it
 * ------------------------------------------------------------------------- */

/** Everything the analysis reasons from. Identical inputs give an identical verdict. */
export interface LimitingConstraintInput {
    seedInputs: PlanSeedInputs;
    preferences: PlanGenerationPreferences;
    targets: MealPlanMacroTotals;
    recipes: readonly PlanRecipeCandidate[];
    /**
     * The same injected deadline the search used. An analysis probe that runs
     * out of time reports nothing rather than throwing: the week is already
     * known to be infeasible, and turning an explained 422 into an
     * unexplained 5xx would be a strictly worse answer.
     */
    shouldAbort?: () => boolean;
    /**
     * What the failed search itself reported, when the caller ran one.
     *
     * OPTIONAL because the analysis is meaningful on its own — a caller asking
     * "what is limiting this profile?" has no search to report — and a call
     * without it reaches exactly the verdict it always did. Supplied, it adds
     * the one fact the catalog counts cannot express: the search ran out of
     * evaluations, so the numbers ARE implicated even where a slot is thin
     * (§0.7.3).
     */
    diagnostics?: PlanSearchDiagnostics;
}

/** The next cooking-time tier above a limit, or null when there is no higher tier. */
export const nextCookingTimeTier = (limit: number | null): number | null => {
    if (limit === null) {
        return null;
    }

    for (const tier of COOKING_TIME_TIERS) {
        if (tier > limit) {
            return tier;
        }
    }

    return null;
};

/**
 * The setup step most likely to open a narrow catalog back up, for a constraint
 * that names no single preference.
 *
 * Ordered by how much room each typically buys: dropping dislikes restores
 * whole recipes, dropping a diet restores more, a looser cooking limit restores
 * the quick-recipe shortfall, and with none of the three set the only remaining
 * lever is the schedule. Allergies are ABSENT from this ladder, as they are
 * from every other suggestion here.
 */
const broadestEditStep = (preferences: PlanGenerationPreferences): SetupStep => {
    if (preferences.disliked_food_ids.length > 0 || preferences.disliked_food_groups.length > 0) {
        return 'dislikes';
    }
    if (preferences.diet !== null && preferences.diet !== 'none') {
        return 'diet';
    }
    if (preferences.cooking_time_limit_min !== null) {
        return 'cooking';
    }

    return 'schedule';
};

/**
 * How many dislike choices the user made.
 *
 * The FOOD count, because that is what the user picked and what the screen
 * shows; a selection stores the food's group alongside it, so adding the two
 * lists would report one choice as two. Groups are counted only when they are
 * all there is.
 */
const dislikeSelectionCount = (preferences: PlanGenerationPreferences): number =>
    preferences.disliked_food_ids.length > 0
        ? preferences.disliked_food_ids.length
        : preferences.disliked_food_groups.length;

/**
 * Why no week could be built, as typed rows the client formats itself.
 *
 * ALLERGIES ARE NEVER A CONSTRAINT AND NEVER A RELAXATION. Not an omission to
 * be tidied up later: the screens promise in so many words that allergies stay
 * in place, and the only way that promise cannot be broken is for this function
 * to have no branch that could break it. `allergiesKept: true` travels on
 * {@link NoMatchingMealsError} itself for the same reason.
 *
 * Rows come back most-limiting first:
 *
 *   1. `slot_coverage` — a slot has ZERO eligible recipes. Nothing about the
 *      rest of the week matters while that is true.
 *   2. `catalog_coverage` — a slot has fewer than {@link MIN_ELIGIBLE_RECIPES_PER_SLOT},
 *      measured on the user's REAL diet ∩ allergen ∩ dislike intersection. Never
 *      assumed from the seed's coverage matrix, which only guarantees four for
 *      the profiles it names.
 *   3. One row per preference whose relaxation — ONE AT A TIME, so each row is a
 *      claim about that preference alone — makes the week feasible:
 *      `cooking_time` (next tier up), `dislikes` (ignored), `diet` (none).
 *   4. `nutrition_tolerance` — eligibility held but no combination met the day
 *      bands, OR the search ran out of evaluations, which the caller reports
 *      through {@link LimitingConstraintInput.diagnostics}. Exhaustion is the
 *      reason this row is not conditional on coverage alone: a slot holding one
 *      to three recipes AND a budget that ran out is a week whose numbers were
 *      never settled, and §0.7.3 requires the exhausted case to say so rather
 *      than blaming the catalog by itself. Exhaustion does NOT reopen the row
 *      for a slot at ZERO recipes, where no target could have closed the week.
 *   5. `portion_limits` — a wider portion set would have closed the week, so the
 *      offered multipliers were the binding constraint.
 *
 * `nutrition_tolerance` reports the tolerance BAND (10, `percent`) rather than
 * the day's calorie target: `unit` has no energy member, and the contract
 * requires `unit` to be non-null whenever `value` is, so the band is the only
 * honest number this row can carry — and it is the actionable one, since the
 * client already holds the targets. Its `slots` is empty because the shortfall
 * belongs to a day rather than to a slot, and `slots` is a list of slots.
 *
 * The list is never empty. A search that failed for no reason this function can
 * name still gets the `nutrition_tolerance` row, because "no meals match" with
 * nothing to act on is not an answer.
 */
export const analyzeLimitingConstraints = (input: LimitingConstraintInput): LimitingConstraint[] => {
    const { seedInputs, preferences, targets, recipes, shouldAbort, diagnostics } = input;

    const seed = derivePlanSeed(seedInputs);
    const dates = planDatesFrom(seedInputs.startDate);
    const userBudgetTier = resolveUserBudgetTier(
        preferences.budget,
        preferences.no_budget_preference,
        preferences.meal_schedule,
    );

    const slots = resolveSlotSchedule(preferences.meal_schedule, preferences.meal_times);
    const candidates = buildPlanCandidates(recipes, preferences, seed);

    // The baseline's ranks and its per-slot admitted sets, resolved once. Every
    // probe is judged against these two: the ranks so a shared candidate cannot
    // move, and the admitted sets so a row is only emitted when the relaxation
    // was actually used.
    const baselineRanks = baselineCandidateRanks(candidates);
    const baselineAdmittedBySlot = new Map<MealSlot, Set<string>>(
        slots.map((slot) => [
            slot.slot,
            new Set(
                candidatesForSlot(candidates, preferences, slot.slot, DEFAULT_PORTION_POLICY).map(
                    planCandidateIdentity,
                ),
            ),
        ]),
    );

    /** The week a counterfactual admits, or null when it admits none. */
    const probeWeek = (
        probePreferences: PlanGenerationPreferences,
        portionPolicy: PortionPolicy,
    ): PlannedMealAssignment[][] | null => {
        const probeSlots = resolveSlotSchedule(
            probePreferences.meal_schedule,
            probePreferences.meal_times,
        );
        const probeCandidates = buildPlanCandidates(
            recipes,
            probePreferences,
            seed,
            portionPolicy,
            baselineRanks,
        );

        return searchPlanWeek({
            dates,
            slots: probeSlots,
            candidatesBySlot: groupCandidatesBySlot(
                probeCandidates,
                probePreferences,
                probeSlots,
                portionPolicy,
            ),
            targets,
            userBudgetTier,
            shouldAbort,
        }).days;
    };

    /**
     * Whether the probe's week actually USED something only the relaxation
     * admitted — at least one placed meal whose `(slot, portable identity)` the
     * baseline could not have offered.
     *
     * The reason a probe's success is not evidence on its own: the probe
     * searches a larger candidate set under a bounded budget, so it can reach a
     * week built entirely from baseline candidates that the baseline search had
     * not got to. Emitting a row from that would tell the user their diet, or
     * their dislikes, is what stands between them and a plan when it is not.
     * The witness is what makes each row a claim about its own preference.
     */
    const placesNewlyAdmittedMeal = (week: readonly PlannedMealAssignment[][]): boolean =>
        week.some((day) =>
            day.some((meal) => {
                const admitted = baselineAdmittedBySlot.get(meal.slot);

                return (
                    admitted === undefined ||
                    !admitted.has(
                        portableCandidateIdentity(meal.slug, meal.version, meal.portionMultiplier),
                    )
                );
            }),
        );

    /** One relaxed preference, reported only when its week needed the relaxation. */
    const relaxationOpensTheWeek = (probePreferences: PlanGenerationPreferences): boolean => {
        const week = probeWeek(probePreferences, DEFAULT_PORTION_POLICY);

        return week !== null && placesNewlyAdmittedMeal(week);
    };

    const emptySlots: MealSlot[] = [];
    const thinSlots: MealSlot[] = [];
    let thinnestCount = MIN_ELIGIBLE_RECIPES_PER_SLOT;

    for (const slot of slots) {
        const count = eligibleRecipeCountForSlot(candidates, preferences, slot.slot);

        if (count === 0) {
            emptySlots.push(slot.slot);
        } else if (count < MIN_ELIGIBLE_RECIPES_PER_SLOT) {
            thinSlots.push(slot.slot);
            thinnestCount = Math.min(thinnestCount, count);
        }
    }

    const constraints: LimitingConstraint[] = [];

    if (emptySlots.length > 0) {
        constraints.push({
            constraintKey: 'slot_coverage',
            value: 0,
            unit: 'recipes',
            slots: emptySlots,
            editStep: 'schedule',
        });
    }

    if (thinSlots.length > 0) {
        constraints.push({
            constraintKey: 'catalog_coverage',
            value: thinnestCount,
            unit: 'recipes',
            slots: thinSlots,
            editStep: broadestEditStep(preferences),
        });
    }

    const relaxedCookingTime = nextCookingTimeTier(preferences.cooking_time_limit_min);
    if (
        preferences.cooking_time_limit_min !== null &&
        relaxedCookingTime !== null &&
        relaxationOpensTheWeek({ ...preferences, cooking_time_limit_min: relaxedCookingTime })
    ) {
        constraints.push({
            constraintKey: 'cooking_time',
            value: preferences.cooking_time_limit_min,
            unit: 'minutes',
            slots: [],
            editStep: 'cooking',
        });
    }

    if (
        dislikeSelectionCount(preferences) > 0 &&
        relaxationOpensTheWeek({ ...preferences, disliked_food_ids: [], disliked_food_groups: [] })
    ) {
        constraints.push({
            constraintKey: 'dislikes',
            value: dislikeSelectionCount(preferences),
            unit: 'foods',
            slots: [],
            editStep: 'dislikes',
        });
    }

    if (
        preferences.diet !== null &&
        preferences.diet !== 'none' &&
        relaxationOpensTheWeek({ ...preferences, diet: 'none' })
    ) {
        constraints.push({
            constraintKey: 'diet',
            value: null,
            unit: null,
            slots: [],
            editStep: 'diet',
        });
    }

    const nutritionToleranceRow: LimitingConstraint = {
        constraintKey: 'nutrition_tolerance',
        value: CALORIE_TOLERANCE_RATIO * PERCENT_SCALE,
        unit: 'percent',
        slots: [],
        editStep: 'goal',
    };

    // Two ways to earn this row, and the second is why the search's diagnostics
    // travel here at all. Eligibility HOLDING is the condition the row claims,
    // so with a slot thin the numbers were not the demonstrated reason the week
    // failed and saying they were would send the user to change a target that
    // would not have helped. But an EXHAUSTED search never settled that
    // question: it stopped mid-answer, so the day bands are still an open
    // reason even where a slot is thin, and §0.7.3 requires the exhausted case
    // to report the tolerance for the day the search could not close. The
    // frontier day itself cannot ride in this row — `slots` is a list of slots,
    // never a day — so it travels on the error beside the rows.
    //
    // A SLOT AT ZERO IS THE ONE CASE EXHAUSTION DOES NOT REOPEN, and it is
    // reachable: a slot with no recipes still lets the other slots spend the
    // whole per-day allowance being placed and unplaced, so the search reports
    // exhaustion for a week that no target would ever have closed. The bands
    // cannot be "an open reason" for a slot nothing can fill, so the honest
    // answer there is `slot_coverage` alone.
    if (emptySlots.length === 0 && (thinSlots.length === 0 || diagnostics?.exhausted === true)) {
        constraints.push(nutritionToleranceRow);
    }

    // Likewise only meaningful once every slot has recipes: with a slot at zero,
    // no portion of anything closes the week.
    if (emptySlots.length === 0) {
        const widerWeek = probeWeek(preferences, EXTENDED_PORTION_POLICY);

        // TWO witnesses, and the multiplier one is written out rather than
        // inferred from the identity set, because it is the row's actual claim:
        // the week closed at a portion the product does not offer. The wider
        // set also contains every offered multiplier, so a week that closes on
        // those alone says nothing about the portions — it says the baseline
        // search had not reached that week yet, which is a different problem
        // and not one the user can act on by resizing a meal.
        if (
            widerWeek !== null &&
            widerWeek.some((day) =>
                day.some(
                    (meal) =>
                        !portionMultipliersForSlot(meal.slot, DEFAULT_PORTION_POLICY).includes(
                            meal.portionMultiplier,
                        ),
                ),
            ) &&
            placesNewlyAdmittedMeal(widerWeek)
        ) {
            constraints.push({
                constraintKey: 'portion_limits',
                value: null,
                unit: null,
                slots: [],
                editStep: 'goal',
            });
        }
    }

    // The three cases above are exhaustive — a slot at zero pushes
    // `slot_coverage`, a thin slot pushes `catalog_coverage`, and neither
    // pushes `nutrition_tolerance` — so this list is already non-empty. The
    // fallback is kept anyway because the promise it protects belongs to the
    // response and not to this function: a 422 must always hand the user
    // something to act on, and a future branch added above must not be able to
    // return an unexplained one.
    return constraints.length > 0 ? constraints : [nutritionToleranceRow];
};

/* ---------------------------------------------------------------------------
 * Generation — the one entry point the service calls
 * ------------------------------------------------------------------------- */

export interface GeneratePlanRequest {
    seedInputs: PlanSeedInputs;
    preferences: PlanGenerationPreferences;
    /** The user's CONFIRMED targets. All four must be positive to plan against. */
    targets: MealPlanMacroTotals;
    /** The plannable catalog. Ineligible rows are filtered here, not by the caller. */
    recipes: readonly PlanRecipeCandidate[];
    /**
     * Injected wall-clock deadline. The service owns the clock — this module
     * never reads one, or its rules would stop being reproducible. Returning
     * true aborts the search with {@link PlanGenerationError}, the 502 that says
     * "we could not finish", as distinct from the 422 that says "no week fits".
     */
    shouldAbort?: () => boolean;
}

/**
 * The candidate week, or a typed explanation of why there is none.
 *
 * Built ENTIRELY IN MEMORY. The caller opens its transaction afterwards and
 * writes the result, which is what keeps a search that may take seconds out of a
 * transaction that holds locks.
 *
 * Throws exactly two things, and the difference matters to the user:
 *  - {@link PlanGenerationError} when the injected deadline fired — the search
 *    did not finish, so nothing is known about feasibility;
 *  - {@link NoMatchingMealsError} when it finished and no week exists, carrying
 *    the constraints to act on. An exhausted evaluation budget is THIS case, not
 *    the first: the search completed within the bounds it was given and the
 *    honest report is that these preferences do not admit a week. The error also
 *    carries the search's own diagnostics — which guard ran out, and the day it
 *    could not close — for the logs, never for the response body.
 *
 * {@link MealPlanInputError} escapes for input that could not be planned from at
 * all (a non-positive target, a malformed date, a slot with no saved time).
 */
export const generateWeeklyPlan = (request: GeneratePlanRequest): GeneratedPlan => {
    const { seedInputs, preferences, targets, recipes, shouldAbort } = request;

    requirePositiveTarget(targets.calories, 'targets.calories');
    requirePositiveTarget(targets.protein, 'targets.protein');
    requirePositiveTarget(targets.carbs, 'targets.carbs');
    requirePositiveTarget(targets.fat, 'targets.fat');

    const dates = planDatesFrom(seedInputs.startDate);
    const slots = resolveSlotSchedule(preferences.meal_schedule, preferences.meal_times);
    const seed = derivePlanSeed(seedInputs);
    const userBudgetTier = resolveUserBudgetTier(
        preferences.budget,
        preferences.no_budget_preference,
        preferences.meal_schedule,
    );
    const candidates = buildPlanCandidates(recipes, preferences, seed);

    const outcome = searchPlanWeek({
        dates,
        slots,
        candidatesBySlot: groupCandidatesBySlot(candidates, preferences, slots, DEFAULT_PORTION_POLICY),
        targets,
        userBudgetTier,
        shouldAbort,
    });

    if (outcome.aborted) {
        throw new PlanGenerationError();
    }

    if (!outcome.days) {
        // The search's own report of HOW it failed is carried into the
        // analysis and onto the error rather than discarded. Without it an
        // exhausted budget is indistinguishable from a settled infeasibility,
        // and a thin slot would be reported as the whole story while the
        // numbers were never actually tested (§0.7.3).
        const diagnostics: PlanSearchDiagnostics = {
            exhausted: outcome.exhausted,
            exhaustedBy: outcome.exhaustedBy,
            frontierDayIndex: outcome.frontierDayIndex,
            evaluations: outcome.evaluations,
        };

        throw new NoMatchingMealsError(
            analyzeLimitingConstraints({
                seedInputs,
                preferences,
                targets,
                recipes,
                shouldAbort,
                diagnostics,
            }),
            {
                ...diagnostics,
                frontierDate: addDaysToDayKey(seedInputs.startDate, diagnostics.frontierDayIndex),
            },
        );
    }

    const searchedDays = outcome.days;

    return {
        startDate: seedInputs.startDate,
        endDate: planEndDate(seedInputs.startDate),
        seed,
        days: dates.map((date, dayIndex) => {
            // Search order is the schedule's; the stored and rendered order is
            // the clock's, so the day is re-sorted once, here, rather than by
            // every reader.
            const meals = [...searchedDays[dayIndex]].sort((left, right) => left.sortOrder - right.sortOrder);

            return {
                date: date.date,
                dayIndex: date.dayIndex,
                isLastDay: date.isLastDay,
                plannedTotals: computeDayTotals(meals),
                meals,
            };
        }),
        evaluations: outcome.evaluations,
    };
};

/* ---------------------------------------------------------------------------
 * Plan lifecycle — "ended" is a predicate, so no caller re-derives it
 * ------------------------------------------------------------------------- */

/**
 * Whether a plan's last date has passed in the user's calendar.
 *
 * THE definition of an ended plan, exported so nothing re-derives it. An ended
 * plan keeps `status = 'active'` in storage — no job rewrites it, and its rows
 * stay readable so history keeps working — but it is ended for every RULE:
 * excluded from current/upcoming resolution, excluded from overlap checks,
 * excluded from incompatibility flagging, and refused by every write path with
 * `plan_not_active {reason: 'ended'}`. A second, subtly different spelling of
 * this comparison somewhere else is how a plan from last month becomes writable
 * again.
 *
 * `today` is a parameter, computed by the caller in the user's stored IANA
 * zone. A day key plus a Firebase identity cannot establish a user's calendar
 * day, and a rule that read the server's clock could neither be tested nor be
 * right for a user who is not in the server's zone.
 */
export const isPlanEnded = (plan: { end_date: string }, today: string): boolean => {
    requireDayKey(plan.end_date, 'end_date');
    requireDayKey(today, 'today');

    return plan.end_date < today;
};

/** Whether the plan still holds the active status, whatever its dates say. */
export const isPlanActiveStatus = (plan: { status: string }): boolean =>
    plan.status === ACTIVE_PLAN_STATUS;

/** Whether a plan may still be written to: active in status AND not yet ended. */
export const isPlanWritable = (plan: PlanLifecycleState, today: string): boolean =>
    isPlanActiveStatus(plan) && !isPlanEnded(plan, today);

/**
 * Returns the plan when it may still be written to, and throws otherwise.
 *
 * The two ways a plan stops accepting writes are reported differently because
 * the client acts on them differently: a SUPERSEDED plan carries the id of the
 * plan that replaced it, so a stale screen can open the right week, while an
 * ENDED plan reports `ended` and sends the user to plan a new one.
 *
 * A plan that is absent or not the caller's is the service's 404 to raise — it
 * knows what it queried for — so this function takes a plan that exists and
 * judges only its lifecycle.
 */
export const requireWritablePlan = <T extends PlanLifecycleState>(plan: T, today: string): T => {
    if (!isPlanActiveStatus(plan)) {
        // Answered only with the successor's id, because following it is the
        // entire purpose of this variant. Regeneration links the successor in
        // the same transaction that supersedes the old plan, so an unresolved
        // one is a caller that did not read the reverse link, or data that
        // contradicts itself — louder than a 409 that omits the id, and never a
        // false `reason: 'ended'`.
        if (!plan.replacement_plan_id) {
            throw new MealPlanInputError(
                `plan ${plan.id} is stored '${plan.status}' but no replacement plan was resolved; ` +
                    'a superseded plan always has a successor',
                'replacement_plan_id',
            );
        }

        throw new PlanNotActiveError({ replacementPlanId: plan.replacement_plan_id });
    }

    if (isPlanEnded(plan, today)) {
        throw new PlanNotActiveError({ reason: ENDED_REASON });
    }

    return plan;
};

/**
 * Earliest start date first, then id — a total order, so a malformed data set
 * holding two plans for one week still resolves to the same one on every read
 * rather than to whichever the database happened to return first.
 */
const compareByStartDateThenId = (left: PlanLifecycleState, right: PlanLifecycleState): number => {
    if (left.start_date !== right.start_date) {
        return left.start_date < right.start_date ? -1 : 1;
    }
    if (left.id === right.id) {
        return 0;
    }

    return left.id < right.id ? -1 : 1;
};

/** Whether two inclusive date ranges share at least one day. */
export const plansOverlap = (
    left: { start_date: string; end_date: string },
    right: { start_date: string; end_date: string },
): boolean => {
    requireDayKey(left.start_date, 'start_date');
    requireDayKey(left.end_date, 'end_date');
    requireDayKey(right.start_date, 'start_date');
    requireDayKey(right.end_date, 'end_date');

    return left.start_date <= right.end_date && right.start_date <= left.end_date;
};

/**
 * Which plan the caller would collide with, considering only plans that are
 * live for the rules — and never the plan being regenerated.
 *
 * EXCLUDING `excludePlanId` IS WHAT MAKES REGENERATION POSSIBLE. A regeneration
 * keeps the same seven dates, so a plan always overlaps itself; excluding only
 * the plan being replaced lets it replace itself while every other conflict is
 * still caught. Getting this wrong does not weaken a check — it makes
 * "Regenerate this week" reject itself, every time.
 */
export const findOverlappingActivePlan = <T extends PlanLifecycleState>(
    plans: readonly T[],
    range: { start_date: string; end_date: string },
    today: string,
    excludePlanId: string | null = null,
): T | null => {
    const conflicts = plans
        .filter(
            (plan) =>
                plan.id !== excludePlanId &&
                isPlanActiveStatus(plan) &&
                !isPlanEnded(plan, today) &&
                plansOverlap(plan, range),
        )
        .sort(compareByStartDateThenId);

    return conflicts.length > 0 ? conflicts[0] : null;
};

/**
 * The one plan allowed to start after today, if it already exists — again
 * excluding the plan being regenerated, for the same reason.
 */
export const findUpcomingActivePlan = <T extends PlanLifecycleState>(
    plans: readonly T[],
    today: string,
    excludePlanId: string | null = null,
): T | null => {
    requireDayKey(today, 'today');

    const upcoming = plans
        .filter(
            (plan) =>
                plan.id !== excludePlanId &&
                isPlanActiveStatus(plan) &&
                !isPlanEnded(plan, today) &&
                plan.start_date > today,
        )
        .sort(compareByStartDateThenId);

    return upcoming.length > 0 ? upcoming[0] : null;
};

/**
 * Asserts a requested week may be published: it collides with nothing live, and
 * it does not become a second upcoming plan.
 *
 * Both checks exclude `excludePlanId`, so a regeneration passes where a fresh
 * generation for the same dates would not.
 */
export const requireNonConflictingWeek = (
    plans: readonly PlanLifecycleState[],
    startDate: string,
    today: string,
    excludePlanId: string | null = null,
): void => {
    const range = { start_date: startDate, end_date: planEndDate(startDate) };
    const conflicting = findOverlappingActivePlan(plans, range, today, excludePlanId);

    if (conflicting) {
        throw new PlanOverlapError(conflicting.id);
    }

    if (startDate > today && findUpcomingActivePlan(plans, today, excludePlanId)) {
        throw new UpcomingExistsError();
    }
};

export interface CurrentAndUpcomingPlans<T> {
    current: T | null;
    upcoming: T | null;
}

/**
 * Which plan is "this week" and which is "next", in the user's calendar.
 *
 * `current` contains today; `upcoming` starts after today. An ENDED plan is
 * neither, which is the whole reason {@link isPlanEnded} exists as a predicate:
 * a plan whose week finished yesterday is still `active` in the database, and
 * returning it as `current` would show the user a finished week and let them
 * write to it.
 */
export const resolveCurrentAndUpcoming = <T extends PlanLifecycleState>(
    plans: readonly T[],
    today: string,
): CurrentAndUpcomingPlans<T> => {
    requireDayKey(today, 'today');

    const live = plans
        .filter((plan) => isPlanActiveStatus(plan) && !isPlanEnded(plan, today))
        .sort(compareByStartDateThenId);

    const current = live.find((plan) => plan.start_date <= today && today <= plan.end_date) ?? null;
    const upcoming = live.find((plan) => plan.start_date > today) ?? null;

    return { current, upcoming };
};

/* ---------------------------------------------------------------------------
 * Request parsing
 *
 * Verdicts are RETURNED, not thrown: a field-level failure is data the client
 * renders beside the field, and every one of these is a 400, so no status code
 * appears here (Rule 7 §8).
 * ------------------------------------------------------------------------- */

type MealPlanErrorVerdict = {
    kind: 'error';
    code: 'invalid_request';
    message: string;
    details: InvalidRequestDetail[];
};

export type ParsedGeneratePlanRequest =
    | { kind: 'ok'; payload: GeneratePlanPayload }
    | MealPlanErrorVerdict;

/**
 * The verdict of the one generation check that needs DATABASE STATE: is the
 * requested start date inside the window today and the user's plans imply?
 *
 * Its own verdict type rather than a branch of
 * {@link ParsedGeneratePlanRequest} because it is judged at a different MOMENT.
 * {@link parseGeneratePlanSyntax} judges the request against itself and can run
 * before any I/O; this judges it against a window derived from the clock in the
 * user's zone and from their active plan, which is state that moves. §0.5.1
 * requires a keyed write's replay gate to run before every stateful refusal, so
 * the two halves cannot be one call: the fingerprint is built from the syntax
 * verdict, the ledger is asked whether that exact request already committed,
 * and only a request that has NOT committed is measured against the current
 * window.
 */
export type StartDateWindowVerdict = { kind: 'ok' } | MealPlanErrorVerdict;

export type ParsedRegeneratePlanRequest =
    | { kind: 'ok'; planId: string; payload: RegeneratePlanPayload }
    | MealPlanErrorVerdict;

export type ParsedMealPlanDayPath =
    | { kind: 'ok'; planId: string; date: string }
    | MealPlanErrorVerdict;

export type ParsedAffectedMealsPath = { kind: 'ok'; planId: string } | MealPlanErrorVerdict;

/** The inclusive window a new plan may start in. */
export interface StartDateWindow {
    earliest: string;
    latest: string;
}

const isUuidV4 = (value: unknown): value is string =>
    typeof value === 'string' && UUID_V4_PATTERN.test(value);

const invalidRequest = (message: string, details: InvalidRequestDetail[]): MealPlanErrorVerdict => ({
    kind: 'error',
    code: 'invalid_request',
    message,
    details,
});

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

/**
 * Judges one revision field: present, an integer, at least `minimum`, and
 * within the range a revision column can hold.
 *
 * Split from the field list so the three revisions cannot drift apart, and
 * split by code so the client can tell "you sent a string" from "you sent -1".
 * Both bounds of the window answer with `out_of_range` — that map's documented
 * code for a well-formed value outside its permitted window — so one field
 * reports one code whichever end it fell off.
 */
const revisionDetail = (
    value: unknown,
    field: string,
    minimum: number,
): InvalidRequestDetail | null => {
    if (value === undefined || value === null) {
        return { field, code: MEAL_PLAN_FIELD_CODES.REQUIRED };
    }
    if (typeof value !== 'number' || !Number.isInteger(value)) {
        return { field, code: MEAL_PLAN_FIELD_CODES.INVALID_TYPE };
    }
    if (value < minimum) {
        return { field, code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE };
    }
    // The integer check above is not sufficient on its own: `Number.isInteger`
    // is true for `1e30`, a whole number that is neither exactly representable
    // nor storable in the PostgreSQL `integer` column every revision counter
    // lives in. Both halves are one bound, spelt as `preferences.logic.ts`
    // spells it — above `MAX_REVISION` no column can hold the value, and above
    // `Number.MAX_SAFE_INTEGER` the comparison against a stored revision would
    // itself be unsound. Left unchecked, such a value reaches
    // `mealPlanningAction.logic.ts::buildRequestFingerprint`, which refuses it
    // with a TypeError — a 500 for what is plainly a malformed request — or
    // Prisma, which refuses it as an out-of-range `Int`.
    if (!Number.isSafeInteger(value) || value > MAX_REVISION) {
        return { field, code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE };
    }

    return null;
};

/**
 * The window a plan may start in: from today to the later of today + 30 days
 * and the day after the active plan's last day.
 *
 * THE UPPER BOUND ALWAYS ADMITS THE SUCCESSOR WEEK. Without the second term,
 * "Plan another week" would be rejected by its own bound whenever the current
 * plan ends more than thirty days out — the one start date the product
 * explicitly offers, refused by the rule meant to stop unbounded scheduling.
 * Day keys are zero-padded, so a lexicographic comparison is a chronological
 * one.
 */
export const startDateWindow = (today: string, activePlanEndDate: string | null): StartDateWindow => {
    requireDayKey(today, 'today');

    const horizon = addDaysToDayKey(today, MAX_START_DATE_OFFSET_DAYS);

    if (activePlanEndDate === null) {
        return { earliest: today, latest: horizon };
    }

    const successor = addDaysToDayKey(requireDayKey(activePlanEndDate, 'activePlanEndDate'), 1);

    return { earliest: today, latest: successor > horizon ? successor : horizon };
};

/**
 * Validates `:planId` and `:date` for `GET /meal-planning/plans/:planId/days/:date`.
 *
 * BOTH SEGMENTS ARE JUDGED BEFORE ANY I/O, which is the point of the parser: a
 * malformed id would otherwise reach a PostgreSQL `uuid` predicate and a
 * malformed key would reach `new Date(\`${dayKey}T00:00:00.000Z\`)`, and each
 * would surface as a generic 500 where §0.5.2 promises a
 * `400 invalid_request` naming the field. `isDayKey` is the real-calendar test,
 * not the shape test, so `2026-02-30` is refused here rather than becoming an
 * `Invalid Date` the query then compares against.
 *
 * Both are reported in one verdict, so a request with two malformed segments
 * does not send the caller back twice.
 */
export const parseMealPlanDayPath = (params: {
    planId?: unknown;
    date?: unknown;
}): ParsedMealPlanDayPath => {
    const details: InvalidRequestDetail[] = [];

    if (!isUuidV4(params.planId)) {
        details.push({ field: PLAN_ID_FIELD, code: MEAL_PLAN_FIELD_CODES.INVALID_ID });
    }

    if (!isDayKey(params.date)) {
        details.push({ field: DATE_FIELD, code: MEAL_PLAN_FIELD_CODES.INVALID_DATE });
    }

    if (details.length > 0) {
        return invalidRequest('planId must be a UUID and date a YYYY-MM-DD calendar date', details);
    }

    return { kind: 'ok', planId: params.planId as string, date: params.date as string };
};

/**
 * Validates `:planId` for `GET /meal-planning/plans/:planId/affected-meals`.
 *
 * The same rule as the day read's id half, kept as its own named parser because
 * the route is its own contract: a controller that borrowed the day parser
 * would have to supply a `date` the route does not have.
 */
export const parseAffectedMealsPath = (params: { planId?: unknown }): ParsedAffectedMealsPath => {
    if (!isUuidV4(params.planId)) {
        return invalidRequest('planId must be a UUID', [
            { field: PLAN_ID_FIELD, code: MEAL_PLAN_FIELD_CODES.INVALID_ID },
        ]);
    }

    return { kind: 'ok', planId: params.planId };
};

/**
 * The one comparison that decides whether a day key is inside a window, so the
 * composed parser and {@link checkStartDateWindow} cannot disagree about it.
 *
 * Day keys are zero-padded, so a lexicographic comparison is a chronological
 * one — the same property {@link startDateWindow} relies on. Both ends answer
 * with `out_of_range`, the field-code map's documented code for a well-formed
 * value outside its permitted window.
 */
const startDateWindowDetail = (
    startDate: string,
    window: StartDateWindow,
): InvalidRequestDetail | null =>
    startDate < window.earliest || startDate > window.latest
        ? { field: START_DATE_FIELD, code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE }
        : null;

/**
 * Judges the start date against the window, as its own step.
 *
 * This is the half of the generation parse that CANNOT run before I/O: the
 * window is derived from today in the user's stored zone and from their active
 * plan's last day, so it moves with the clock and with their plans. Separating
 * it is what lets `mealPlan.service.ts::generatePlan` fingerprint and replay a
 * request before measuring it against anything mutable — without the split, a
 * same-key retry sent after the user's local midnight is answered
 * `400 invalid_request` for a start date that has fallen behind `window.earliest`
 * and can never reach the `201` its first attempt already stored (§0.5.1's
 * "replay ... BEFORE any revision or status check").
 *
 * `startDate` is a day key the syntax parse has already accepted; this adds no
 * shape check of its own, because a value that is not a real calendar day was
 * refused with `invalid_date` before the ledger was consulted.
 */
export const checkStartDateWindow = (
    startDate: string,
    window: StartDateWindow,
): StartDateWindowVerdict => {
    const detail = startDateWindowDetail(startDate, window);

    return detail === null
        ? { kind: 'ok' }
        : invalidRequest('The plan request is not valid', [detail]);
};

/**
 * The shared body of the two generation parses below: `window === null` judges
 * the request against itself alone, and a window judges the range as well.
 *
 * One function rather than two so the details, their order and the message are
 * identical whichever entry point produced them — a client rendering a field
 * error must not see a different verdict depending on which half of the parse
 * its caller used.
 */
const parseGeneratePlanBody = (
    body: unknown,
    window: StartDateWindow | null,
): ParsedGeneratePlanRequest => {
    const record = asRecord(body);

    if (!record) {
        return invalidRequest('A request body is required', [
            { field: START_DATE_FIELD, code: MEAL_PLAN_FIELD_CODES.REQUIRED },
            { field: IDEMPOTENCY_KEY_FIELD, code: MEAL_PLAN_FIELD_CODES.REQUIRED },
        ]);
    }

    const details: InvalidRequestDetail[] = [];
    const startDate = record[START_DATE_FIELD];

    if (startDate === undefined || startDate === null) {
        details.push({ field: START_DATE_FIELD, code: MEAL_PLAN_FIELD_CODES.REQUIRED });
    } else if (!isDayKey(startDate)) {
        details.push({ field: START_DATE_FIELD, code: MEAL_PLAN_FIELD_CODES.INVALID_DATE });
    } else if (window !== null) {
        const outOfWindow = startDateWindowDetail(startDate, window);

        if (outOfWindow !== null) {
            details.push(outOfWindow);
        }
    }

    const idempotencyKey = record[IDEMPOTENCY_KEY_FIELD];

    if (idempotencyKey === undefined || idempotencyKey === null) {
        details.push({ field: IDEMPOTENCY_KEY_FIELD, code: MEAL_PLAN_FIELD_CODES.REQUIRED });
    } else if (!isUuidV4(idempotencyKey)) {
        details.push({ field: IDEMPOTENCY_KEY_FIELD, code: MEAL_PLAN_FIELD_CODES.INVALID_ID });
    }

    const preferencesRevision = revisionDetail(
        record[EXPECTED_PREFERENCES_REVISION_FIELD],
        EXPECTED_PREFERENCES_REVISION_FIELD,
        0,
    );
    if (preferencesRevision) {
        details.push(preferencesRevision);
    }

    const targetsRevision = revisionDetail(
        record[EXPECTED_TARGETS_REVISION_FIELD],
        EXPECTED_TARGETS_REVISION_FIELD,
        0,
    );
    if (targetsRevision) {
        details.push(targetsRevision);
    }

    if (details.length > 0) {
        return invalidRequest('The plan request is not valid', details);
    }

    return {
        kind: 'ok',
        payload: {
            startDate: startDate as string,
            idempotencyKey: idempotencyKey as string,
            expectedPreferencesRevision: record[EXPECTED_PREFERENCES_REVISION_FIELD] as number,
            expectedTargetsRevision: record[EXPECTED_TARGETS_REVISION_FIELD] as number,
        },
    };
};

/**
 * Validates `POST /meal-planning/plans` against the request itself: types,
 * formats, ids and revision bounds, and nothing that needs a database read.
 *
 * Every field is judged before returning, so a request with three problems
 * reports three details instead of sending the caller back three times.
 *
 * THE START DATE IS CHECKED FOR SHAPE, NOT FOR RANGE. `2026-02-30` is refused
 * here — it would otherwise become an `Invalid Date` a query compares as NULL —
 * while a perfectly formed date outside the permitted window is accepted by
 * THIS function and refused by {@link checkStartDateWindow} afterwards. The
 * division is deliberate and is the whole reason this function exists: it makes
 * the request fingerprint computable from the request alone, so a keyed
 * generation can consult the idempotency ledger before it consults the clock
 * (§0.5.1). {@link parseGeneratePlanRequest} is the two halves in one call for
 * a caller that already holds the window.
 */
export const parseGeneratePlanSyntax = (body: unknown): ParsedGeneratePlanRequest =>
    parseGeneratePlanBody(body, null);

/**
 * Validates `POST /meal-planning/plans` completely: the syntax above AND the
 * start-date window, reported together in one verdict.
 *
 * Kept as the single-call form because a request with a malformed key and an
 * out-of-window date is one round trip's worth of problems, and because a
 * caller that already knows the window should be able to ask one question. It
 * is {@link parseGeneratePlanSyntax} and {@link checkStartDateWindow} over one
 * shared comparison, never a second implementation of either — which is why
 * the composed verdict still reports both halves' details together, and why
 * `generatePlan`, which must ask them in two moments, cannot be accused of
 * applying a different rule from this one.
 */
export const parseGeneratePlanRequest = (
    body: unknown,
    window: StartDateWindow,
): ParsedGeneratePlanRequest => parseGeneratePlanBody(body, window);

/**
 * Validates `POST /meal-planning/plans/:planId/regenerate` — the path id and the
 * body together, so one round trip reports every problem.
 *
 * No start date: a regeneration keeps the replaced plan's week by definition,
 * and accepting one would let a client move a week while claiming to rebuild it.
 * `expectedPlanRevision` starts at 1, because `meal_plans.revision` does.
 */
export const parseRegeneratePlanRequest = (
    params: { planId?: unknown },
    body: unknown,
): ParsedRegeneratePlanRequest => {
    const details: InvalidRequestDetail[] = [];

    if (!isUuidV4(params.planId)) {
        details.push({ field: PLAN_ID_FIELD, code: MEAL_PLAN_FIELD_CODES.INVALID_ID });
    }

    const record = asRecord(body);

    if (!record) {
        details.push({ field: IDEMPOTENCY_KEY_FIELD, code: MEAL_PLAN_FIELD_CODES.REQUIRED });

        return invalidRequest('A request body is required', details);
    }

    const idempotencyKey = record[IDEMPOTENCY_KEY_FIELD];

    if (idempotencyKey === undefined || idempotencyKey === null) {
        details.push({ field: IDEMPOTENCY_KEY_FIELD, code: MEAL_PLAN_FIELD_CODES.REQUIRED });
    } else if (!isUuidV4(idempotencyKey)) {
        details.push({ field: IDEMPOTENCY_KEY_FIELD, code: MEAL_PLAN_FIELD_CODES.INVALID_ID });
    }

    for (const [field, minimum] of [
        [EXPECTED_PLAN_REVISION_FIELD, 1],
        [EXPECTED_PREFERENCES_REVISION_FIELD, 0],
        [EXPECTED_TARGETS_REVISION_FIELD, 0],
    ] as const) {
        const detail = revisionDetail(record[field], field, minimum);

        if (detail) {
            details.push(detail);
        }
    }

    if (details.length > 0) {
        return invalidRequest('The regeneration request is not valid', details);
    }

    return {
        kind: 'ok',
        planId: params.planId as string,
        payload: {
            idempotencyKey: idempotencyKey as string,
            expectedPlanRevision: record[EXPECTED_PLAN_REVISION_FIELD] as number,
            expectedPreferencesRevision: record[EXPECTED_PREFERENCES_REVISION_FIELD] as number,
            expectedTargetsRevision: record[EXPECTED_TARGETS_REVISION_FIELD] as number,
        },
    };
};

/**
 * The shorter name the specification uses for
 * {@link parseRegeneratePlanRequest}, exported so a caller written against
 * either spelling resolves to the one implementation. Not a second parser:
 * there is exactly one, and this is another reference to it.
 */
export const parseRegenerateRequest = parseRegeneratePlanRequest;
