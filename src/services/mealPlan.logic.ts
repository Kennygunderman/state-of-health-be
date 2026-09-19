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
//    `plannedMealLog.logic.ts::derivePlannedSnapshot` — whose integers
//    `nutrition.service.ts::insertPlannedMealEntry` then stores verbatim. An
//    extra round here would shift every number downstream of it.
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

/**
 * Evaluation budgets, in units of search work.
 *
 * Placing one candidate in one slot is one evaluation, and so is proving a
 * whole day unfillable before any candidate is placed — the two things the
 * search can spend time on. Charging both is what makes these two numbers bound
 * the search rather than merely bound its placements; see `solveDay`. Work that
 * proves nothing about arithmetic is free: a slot with no candidate at all, and
 * a branch the bounds discard before it is placed.
 */
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
 * The "nothing to exclude" set, shared rather than allocated per call.
 *
 * Declared here rather than beside the search because it is both
 * {@link violatesRepetitionRule}'s default fourth argument and day 0's
 * non-existent previous day inside {@link searchPlanWeek}. Typed
 * `ReadonlySet` so a holder cannot add to the set everyone shares.
 */
const EMPTY_RECIPE_IDS: ReadonlySet<string> = new Set<string>();

/**
 * Whether placing this recipe would break the week's repetition rule.
 *
 * THE RULE IS §0.7.3'S TWO CLAUSES AND NOTHING ELSE: a recipe may appear at
 * most {@link MAX_RECIPE_USES_PER_WEEK} times in the week, and never on
 * consecutive days. Both uses may therefore fall on the SAME day, in two
 * different slots — a lunch and a dinner that both declare a dish are two
 * distinct meals, and the plan permits the dish in both.
 *
 * A third, unwritten clause used to sit here, refusing a recipe already placed
 * today on the reading that "never on consecutive days" means "at least one
 * clear day between appearances". It was removed because it can refuse a week
 * §0.7.3 allows: two different slots can share a recipe, so a tight pool can
 * need one dish twice on one day while EVERY slot holds plenty of recipes. The
 * argument that used to justify the clause — "needing one recipe twice in one
 * day means a slot has fewer than two recipes" — was simply wrong for that
 * reason, and the price of it was a feasible week answered with
 * `422 no_matching_meals`.
 *
 * Its ABSENCE here is not indifference to the same dish twice in one day.
 * Leaving the rule as §0.7.3 writes it had every third planned week serving one
 * recipe at two of its slots — legal, and still poor. The preference is
 * expressed where a preference belongs: in the MOVE ORDER, and in the two
 * passes `searchPlanWeek`'s `solveDay` runs, which offer a day's distinct
 * assignments first and reopen the legal pair only for a day that cannot be
 * filled any other way. A rule refuses weeks; an order only chooses between
 * them, and only the second can prefer variety without ever costing a week.
 *
 * A HARD eligibility test for the slot, deliberately NOT a soft score penalty.
 * A penalty would let a sufficiently attractive recipe appear five times, and
 * the whole point is that it cannot.
 *
 * `additionalExcludedRecipeIds` is an OPTIONAL exclusion set the CALLER chooses,
 * on top of the rule — it is not part of §0.7.3 and defaults to empty, so a
 * caller that says nothing gets exactly the two clauses above. NO CURRENT CALLER
 * PASSES IT: `searchPlanWeek` omits it and so does `swap.logic.ts`, which
 * applies the two clauses to the week with the meal being replaced removed and
 * narrows nothing further. That is deliberate rather than incidental — a
 * swap-only narrowing would make the alternatives sheet refuse a dish the
 * generator would have planted in the same slot, and the list, the preview and
 * the commit all read the sheet's own rows. The parameter is kept because the
 * exclusion it expresses is a caller's to name, and because keeping it here is
 * what stops a caller that ever needs one from spelling the repetition rule a
 * second time.
 *
 * Every argument looks BACKWARDS — uses so far, the adjacent day's recipes, and
 * whatever extra the caller excludes. That is what lets the depth-first search
 * trust its completed days: no later placement can retroactively invalidate an
 * earlier one.
 */
export const violatesRepetitionRule = (
    recipeId: string,
    usesSoFar: number,
    adjacentDayRecipeIds: ReadonlySet<string>,
    additionalExcludedRecipeIds: ReadonlySet<string> = EMPTY_RECIPE_IDS,
): boolean =>
    usesSoFar >= MAX_RECIPE_USES_PER_WEEK ||
    adjacentDayRecipeIds.has(recipeId) ||
    additionalExcludedRecipeIds.has(recipeId);

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

/** The inclusive interval one of a day's four values must land in. */
export interface DayToleranceBand {
    low: number;
    high: number;
}

/** The four bands of §3.6, in `calories, protein, carbs, fat` order. */
export interface DayToleranceBands {
    calories: DayToleranceBand;
    protein: DayToleranceBand;
    carbs: DayToleranceBand;
    fat: DayToleranceBand;
}

/**
 * The four accepted intervals, derived once from the targets.
 *
 * ONE derivation, TWO readers, and that is the whole point of extracting it.
 * {@link evaluateDayTolerance} judges a completed day against these bands, and
 * the search's admissibility bound asks whether a partial day can still REACH
 * them. Written twice, the two would drift, and a drifted bound is the worst
 * kind: it would prune branches the tolerance would have accepted and the
 * failure would surface as a refusal for a week that fits.
 *
 * `TOLERANCE_EPSILON` is folded INTO the bounds rather than left to each
 * comparison, so every reader compares strictly (`< low`, `> high`) and none
 * can forget the slack. The bands are therefore inclusive of the policy bound
 * in §3.6's sense: a day landing exactly on it is inside.
 *
 * Each target is guarded in `calories, protein, carbs, fat` order, so an
 * unusable target is named the same way whichever reader reached it first.
 */
export const dayToleranceBands = (targets: MealPlanMacroTotals): DayToleranceBands => {
    const calorieTarget = requirePositiveTarget(targets.calories, 'targets.calories');
    const proteinTarget = requirePositiveTarget(targets.protein, 'targets.protein');
    const carbsTarget = requirePositiveTarget(targets.carbs, 'targets.carbs');
    const fatTarget = requirePositiveTarget(targets.fat, 'targets.fat');

    const calorieBand = CALORIE_TOLERANCE_RATIO * calorieTarget;
    const carbsBand = Math.max(MACRO_TOLERANCE_ABSOLUTE_G, MACRO_TOLERANCE_RATIO * carbsTarget);
    const fatBand = Math.max(MACRO_TOLERANCE_ABSOLUTE_G, MACRO_TOLERANCE_RATIO * fatTarget);

    return {
        calories: {
            low: calorieTarget - calorieBand - TOLERANCE_EPSILON,
            high: calorieTarget + calorieBand + TOLERANCE_EPSILON,
        },
        // Asymmetric on purpose — see `evaluateDayTolerance`.
        protein: {
            low: proteinTarget - PROTEIN_TOLERANCE_UNDER_G - TOLERANCE_EPSILON,
            high: proteinTarget + PROTEIN_TOLERANCE_OVER_G + TOLERANCE_EPSILON,
        },
        carbs: {
            low: carbsTarget - carbsBand - TOLERANCE_EPSILON,
            high: carbsTarget + carbsBand + TOLERANCE_EPSILON,
        },
        fat: {
            low: fatTarget - fatBand - TOLERANCE_EPSILON,
            high: fatTarget + fatBand + TOLERANCE_EPSILON,
        },
    };
};

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
 * Applied only to a finished day, and the ONLY acceptance test there is. No
 * candidate is ever refused by this function.
 *
 * A partial day is judged in one narrower sense and no other: {@link
 * canReachDayBands} asks whether the slots still to be filled could carry the
 * day into these same bands, and cuts the branch when they provably cannot.
 * That is a REACHABILITY test over the identical intervals — see {@link
 * dayToleranceBands}, which both read — never a verdict on the partial totals
 * themselves. The guidance shares remain the only thing with an opinion about
 * how a half-built day ought to look, and they only order moves.
 */
export const evaluateDayTolerance = (
    totals: MealPlanMacroTotals,
    targets: MealPlanMacroTotals,
): DayToleranceVerdict => {
    const bands = dayToleranceBands(targets);

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

    // Each comparison is strict because `dayToleranceBands` has already folded
    // `TOLERANCE_EPSILON` into the bounds; the bands stay inclusive of the
    // policy bound and no reader has to remember the slack.
    if (calories < bands.calories.low || calories > bands.calories.high) {
        breaches.push('calories');
    }

    if (protein < bands.protein.low || protein > bands.protein.high) {
        breaches.push('protein');
    }

    if (carbs < bands.carbs.low || carbs > bands.carbs.high) {
        breaches.push('carbs');
    }

    if (fat < bands.fat.low || fat > bands.fat.high) {
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
 * `plannedMealLog.logic.ts::derivePlannedSnapshot` rounds the diary snapshot
 * once; rounding each meal first and summing the results would drift the day
 * total away from both.
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

/**
 * The two evaluation budgets a run may be held to.
 *
 * Present as a parameter for two reasons. The first is observability: under the
 * shipped policy the per-plan cap is exactly {@link PLAN_DAY_COUNT} × the
 * per-day cap, so a week that trips one guard would trip the other at the same
 * moment and no fixture could tell them apart — supplying the caps separately
 * is what lets a test prove the per-plan counter spans day boundaries and the
 * per-day counter accumulates across backtracking re-entries.
 *
 * The second is the request-wide bound. {@link generateWeeklyPlan}'s own search
 * leaves this absent and gets the shipped policy, but
 * {@link analyzeLimitingConstraints}' probes run AFTER that search and must fit
 * inside what §0.7.3 allows one plan request in total, so each probe passes the
 * pool's remainder here. Without it four probes would each start a fresh
 * {@link MAX_EVALUATIONS_PER_PLAN}.
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
 * What the slots a day has not filled yet can still contribute to its totals.
 *
 * `min` and `max` are per-nutrient sums over the remaining slots, each taken
 * across that slot's WHOLE candidate pool. The two flags say whether the sums
 * mean anything:
 *  - `reachable` is false when some remaining slot has no candidate at all, so
 *    the day cannot be completed however the earlier slots are filled;
 *  - `bounded` is false when some remaining contribution is not a finite
 *    number, so the sums cannot be trusted and no arithmetic conclusion may be
 *    drawn from them.
 */
export interface RemainingContributionBounds {
    reachable: boolean;
    bounded: boolean;
    min: MealPlanMacroTotals;
    max: MealPlanMacroTotals;
}

const MACRO_KEYS = ['calories', 'protein', 'carbs', 'fat'] as const;

/** The widest and narrowest each nutrient can be across one slot's pool. */
export const slotContributionBounds = (
    pool: readonly PlanCandidate[],
): RemainingContributionBounds => {
    if (pool.length === 0) {
        return {
            reachable: false,
            bounded: true,
            min: { calories: 0, protein: 0, carbs: 0, fat: 0 },
            max: { calories: 0, protein: 0, carbs: 0, fat: 0 },
        };
    }

    const min: MealPlanMacroTotals = {
        calories: Number.POSITIVE_INFINITY,
        protein: Number.POSITIVE_INFINITY,
        carbs: Number.POSITIVE_INFINITY,
        fat: Number.POSITIVE_INFINITY,
    };
    const max: MealPlanMacroTotals = {
        calories: Number.NEGATIVE_INFINITY,
        protein: Number.NEGATIVE_INFINITY,
        carbs: Number.NEGATIVE_INFINITY,
        fat: Number.NEGATIVE_INFINITY,
    };
    let bounded = true;

    for (const candidate of pool) {
        for (const key of MACRO_KEYS) {
            const value = candidate.nutrition[key];

            if (!Number.isFinite(value)) {
                // Left to the day-total guard to name, exactly as before this
                // bound existed: a corrupt candidate is a data fault for
                // `evaluateDayTolerance`'s reader to report, and pruning on a
                // NaN would turn that fault into a silent refusal.
                bounded = false;
                continue;
            }

            min[key] = Math.min(min[key], value);
            max[key] = Math.max(max[key], value);
        }
    }

    return { reachable: true, bounded, min, max };
};

/**
 * The per-slot bounds accumulated from the END of the day forwards.
 *
 * Entry `i` describes slots `i` onwards, so entry `slots.length` is the empty
 * tail: nothing left to add, trivially reachable and bounded. Computed once per
 * search rather than per visit — the pools do not change while a week is being
 * built, so this is seven days' worth of arithmetic done once.
 */
export const remainingContributionBounds = (
    perSlot: readonly RemainingContributionBounds[],
): RemainingContributionBounds[] => {
    const suffixes: RemainingContributionBounds[] = new Array(perSlot.length + 1);

    suffixes[perSlot.length] = {
        reachable: true,
        bounded: true,
        min: { calories: 0, protein: 0, carbs: 0, fat: 0 },
        max: { calories: 0, protein: 0, carbs: 0, fat: 0 },
    };

    for (let index = perSlot.length - 1; index >= 0; index -= 1) {
        const slot = perSlot[index];
        const next = suffixes[index + 1];
        const min: MealPlanMacroTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };
        const max: MealPlanMacroTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };

        for (const key of MACRO_KEYS) {
            min[key] = slot.min[key] + next.min[key];
            max[key] = slot.max[key] + next.max[key];
        }

        suffixes[index] = {
            reachable: slot.reachable && next.reachable,
            bounded: slot.bounded && next.bounded,
            min,
            max,
        };
    }

    return suffixes;
};

/**
 * Whether a day standing at `total` can still finish inside its bands.
 *
 * THE ADMISSIBILITY ARGUMENT, because the whole correctness of the search
 * rests on it. The bounds are taken over each remaining slot's WHOLE pool,
 * which is a SUPERSET of the candidates actually available on any given day
 * (the repetition rule removes more as the week fills). A superset can only
 * widen the reachable interval, so this predicate is OPTIMISTIC: whenever it
 * answers false, no assignment of the remaining slots — under this pool or any
 * subset of it — could have landed the day inside its bands. Cutting such a
 * branch therefore removes only completions that do not exist. The move order,
 * the scoring and "first feasible wins" are untouched, so the week this search
 * returns is the week it would have returned without the bound; what changes is
 * only how much work it does to get there.
 *
 * The converse is deliberately NOT claimed. A true answer means "not provably
 * impossible", never "completable" — {@link evaluateDayTolerance} on the
 * finished day remains the only acceptance test, and it is what refuses a day
 * this predicate let through.
 *
 * Unsound inputs decline to conclude rather than guess: an unbounded remainder
 * returns true and leaves the branch to be explored as it was before.
 */
export const canReachDayBands = (
    total: MealPlanMacroTotals,
    remaining: RemainingContributionBounds,
    bands: DayToleranceBands,
): boolean => {
    if (!remaining.reachable) {
        return false;
    }

    if (!remaining.bounded) {
        return true;
    }

    for (const key of MACRO_KEYS) {
        const value = total[key];

        if (!Number.isFinite(value)) {
            return true;
        }

        // The least this nutrient can still become already overshoots, or the
        // most it can become still undershoots. Either way the band is out of
        // reach for every completion of this branch.
        if (value + remaining.min[key] > bands[key].high) {
            return false;
        }

        if (value + remaining.max[key] < bands[key].low) {
            return false;
        }
    }

    return true;
};

/**
 * Whether a COMPLETE day's four totals all sit inside their bands.
 *
 * The same judgement {@link evaluateDayTolerance} makes, reduced to a boolean
 * and taken against bands already derived — which is what the two predicates
 * below need, since both ask it of hypothetical days thousands of times and
 * neither has any use for the breach list.
 *
 * Non-finite input returns TRUE, and that is deliberate rather than lax: these
 * predicates exist to PRUNE, so declining to conclude has to mean "explore it",
 * leaving a corrupt candidate to be named by `computeDayTotals` and
 * `evaluateDayTolerance` on the real day. Pruning on a NaN would turn a data
 * fault into a silent refusal with no row to point at.
 */
const isTotalWithinBands = (total: MealPlanMacroTotals, bands: DayToleranceBands): boolean => {
    for (const key of MACRO_KEYS) {
        const value = total[key];

        if (!Number.isFinite(value)) {
            return true;
        }

        if (value < bands[key].low || value > bands[key].high) {
            return false;
        }
    }

    return true;
};

/**
 * Whether any single candidate in a day's LAST slot would land the day inside
 * its bands.
 *
 * WHY THIS EXISTS BESIDE {@link canReachDayBands}. That predicate bounds each
 * nutrient independently, so it admits a remainder no candidate actually has:
 * "some dinner supplies between 300 and 900 kcal, and some dinner supplies
 * between 20 and 60 g of fat" does not mean one dinner supplies both at once.
 * On the penultimate slot that relaxation is the search's dominant cost — every
 * lunch it lets through is PLACED, and therefore charged an evaluation, before
 * the exact test one slot later finds nothing to follow it. With a dozen
 * breakfasts and a hundred-odd lunches over a portion grid, a day can spend its
 * whole allowance on prefixes that were never completable, and report the wall
 * it hit as though the week were infeasible.
 *
 * The last slot needs no relaxation, because there is nothing after it to
 * bound: the day's final total is `total` plus exactly one candidate's
 * nutrition, so asking whether ANY candidate closes the day is an exact
 * question over a finite pool, and answering it costs one pass over that pool.
 *
 * ADMISSIBILITY, on the same terms as {@link canReachDayBands}: `pool` is the
 * slot's entry-time pool, a SUPERSET of what the repetition rule leaves
 * available once the day's earlier slots are filled. A superset can only add
 * candidates that might close the day, so a false answer means no completion
 * exists under that pool or any subset of it — nothing reachable is cut. The
 * converse is not claimed and not needed: a true answer only means this branch
 * is not provably dead, and {@link evaluateDayTolerance} on the finished day
 * remains the single acceptance test.
 *
 * Unsound inputs decline to conclude, exactly as the interval bound does: a
 * candidate carrying a non-finite nutrient is treated as closing the day, so a
 * corrupt row stays a data fault for {@link evaluateDayTolerance}'s reader to
 * name rather than becoming a silent refusal here.
 */
export const someCandidateClosesDay = (
    total: MealPlanMacroTotals,
    pool: readonly PlanCandidate[],
    bands: DayToleranceBands,
): boolean => {
    for (const key of MACRO_KEYS) {
        if (!Number.isFinite(total[key])) {
            return true;
        }
    }

    for (const candidate of pool) {
        if (
            isTotalWithinBands(
                {
                    calories: total.calories + candidate.nutrition.calories,
                    protein: total.protein + candidate.nutrition.protein,
                    carbs: total.carbs + candidate.nutrition.carbs,
                    fat: total.fat + candidate.nutrition.fat,
                },
                bands,
            )
        ) {
            return true;
        }
    }

    return false;
};

/**
 * Whether ANY assignment of a day's slots, drawn from the pools given, lands
 * the day inside its bands.
 *
 * WHY A WHOLE-DAY TEST EARNS ITS KEEP, when the two bounds above already prune
 * inside the day. A day's allowance is spent one placement at a time, and a day
 * that cannot be closed at all spends the whole allowance discovering it.
 * That is not merely slow: running an allowance out ends the SEARCH (§0.7.3),
 * so the one doomed day takes the week with it — and the days before it are
 * never revisited, even though changing one of them is precisely what would
 * have freed the recipes this day needed. A week that exists is then refused,
 * and the refusal names `nutrition_tolerance` as though the targets were at
 * fault.
 *
 * Asking the question ONCE, before the first placement, converts that
 * catastrophe into an ordinary dead end: the day returns false for the price of
 * a single evaluation rather than an allowance, the recursion unwinds into the
 * previous day's next candidate, and the week-level allowance goes on buying
 * week-level alternatives instead of being burned on a single impossible day.
 * The budgets are untouched; what changes is that they are spent on days that
 * can close.
 *
 * The caller charges that one evaluation — see `solveDay` — and charges it for
 * a reason worth stating here, because it looks like bookkeeping and is not:
 * every other dead end in the search costs at least one evaluation, and that is
 * what makes the two allowances bound the search at all. A dead end answered
 * for free would let the search re-enter a doomed day once per candidate of
 * every day above it, with nothing but the wall clock to stop it. The one
 * exception is a day with a structurally EMPTY slot, which is charged nothing
 * because no search was possible: that is coverage rather than arithmetic, and
 * `analyzeLimitingConstraints` answers it with `slot_coverage` alone.
 *
 * It is a SEARCH, not a formula, because feasibility couples the nutrients:
 * this walks the slots in order, prunes each prefix with
 * {@link canReachDayBands}, and settles the final slot exactly with
 * {@link someCandidateClosesDay} — so it returns as soon as one witness exists
 * and, in the common case, long before the pools are enumerated. No score is
 * computed and no order is imposed: it answers only "does a witness exist",
 * which is why it cannot influence WHICH week the search returns.
 *
 * ADMISSIBILITY, the same argument a third time: `pools` are the day's
 * entry-time pools, a superset of what remains available as the day fills. A
 * false answer therefore means no assignment exists under those pools or any
 * subset, so the day is genuinely unfillable and cutting it removes nothing
 * reachable. Unsound inputs decline to conclude — an unbounded or non-finite
 * remainder makes the prunes answer true, and the walk then finds a witness or
 * not on the arithmetic alone, exactly as the search itself would.
 *
 * The walk is bounded, and the bound is not merely a speed knob: stopping keeps
 * the predicate sound but costs the shortcut, so a doomed day it declines to
 * judge is discovered the expensive way instead. The reasoning and the
 * measurements behind the figure are in the body, at its declaration.
 *
 * @param pools   Each slot's entry-time candidates, in slot order.
 * @param bands   The day's tolerance bands, already derived from the targets.
 * @param weekUsesByRecipeId How many times each recipe the WEEK has already
 *   planned; the walk serves no recipe more often than §0.7.3's remaining
 *   allowance permits, so a "witness" is never a day the search could not
 *   actually build. Defaulted empty for callers testing a day in isolation.
 */
export const dayHasFeasibleAssignment = (
    pools: readonly (readonly PlanCandidate[])[],
    bands: DayToleranceBands,
    weekUsesByRecipeId: ReadonlyMap<string, number> = new Map<string, number>(),
): boolean => {
    if (pools.length === 0) {
        return false;
    }

    // Work this walk may do before it stops and says "explore it".
    //
    // Why a bound is needed: this walk is itself a search. On a pool where no
    // assignment closes the day it enumerates prefixes to prove that, and the
    // measured cost of one such proof on the shipped corpus runs to ~150,000
    // steps. Unbounded, a few hundred of them spend the request's whole
    // `PLAN_GENERATION_DEADLINE_MS` — and that deadline is a `502`, where the
    // truthful answer is the `422` this predicate exists to make reachable.
    //
    // What the bound trades, stated plainly rather than waved away. Stopping
    // keeps the predicate SOUND — it never answers `false` for a day that has a
    // feasible assignment, so no week legal under §0.7.3 is made unreachable by
    // it. What it can cost is the shortcut: a doomed day it declines to judge is
    // discovered the expensive way instead, by the search spending evaluations
    // on it, and a search that then runs out of allowance refuses. So the cap is
    // outcome-relevant through the budget, not merely a speed knob, and it is
    // set from measurement in both directions: the pools that need the proof to
    // plan at all conclude within ~13,400 steps, while the pools that cost
    // ~150,000 are refusals whatever is done with them.
    //
    // It is not a policy threshold and is deliberately not published as one: it
    // names an amount of work, changes no rule, and appears in no response.
    const MAX_FEASIBILITY_WALK_STEPS = 25000;
    let steps = 0;

    const suffixes = remainingContributionBounds(pools.map((pool) => slotContributionBounds(pool)));

    if (!suffixes[0].reachable) {
        return false;
    }

    const lastIndex = pools.length - 1;
    // How many more times each recipe may be served THIS day, spent as the walk
    // places and refunded as it unwinds. Without this the witness is allowed to
    // serve one dish in every slot, which §0.7.3's two-use cap forbids — and
    // that is not a hypothetical looseness but the exact case this check exists
    // for: a week whose earlier days have spent the high-calorie recipes leaves
    // a day that can only be "filled" by reusing one of them a third time, so a
    // walk without accounting calls the day feasible and the search then pays
    // its whole allowance discovering otherwise.
    const remainingUses = new Map<string, number>();
    const allowanceFor = (recipeId: string): number => {
        const known = remainingUses.get(recipeId);

        if (known !== undefined) {
            return known;
        }

        const spent = weekUsesByRecipeId.get(recipeId) ?? 0;
        const allowance = Math.max(0, MAX_RECIPE_USES_PER_WEEK - spent);

        remainingUses.set(recipeId, allowance);

        return allowance;
    };

    const walk = (slotIndex: number, total: MealPlanMacroTotals): boolean => {
        for (const candidate of pools[slotIndex]) {
            steps += 1;

            if (steps > MAX_FEASIBILITY_WALK_STEPS) {
                // Out of work, so the honest answer is "I do not know", and the
                // only safe way to say that here is `true` — the day is handed
                // to the search to settle the ordinary way. Every caller reads
                // this as "explore", never as "a day exists".
                return true;
            }

            const recipeId = candidate.recipe.recipe_id;

            if (allowanceFor(recipeId) <= 0) {
                continue;
            }

            const next: MealPlanMacroTotals = {
                calories: total.calories + candidate.nutrition.calories,
                protein: total.protein + candidate.nutrition.protein,
                carbs: total.carbs + candidate.nutrition.carbs,
                fat: total.fat + candidate.nutrition.fat,
            };

            if (slotIndex === lastIndex) {
                // The final slot judged exactly: `next` IS a complete day.
                if (isTotalWithinBands(next, bands)) {
                    return true;
                }

                continue;
            }

            if (!canReachDayBands(next, suffixes[slotIndex + 1], bands)) {
                continue;
            }

            remainingUses.set(recipeId, allowanceFor(recipeId) - 1);

            if (walk(slotIndex + 1, next)) {
                return true;
            }

            remainingUses.set(recipeId, allowanceFor(recipeId) + 1);
        }

        return false;
    };

    return walk(0, { calories: 0, protein: 0, carbs: 0, fat: 0 });
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
 *  - a candidate whose branch PROVABLY cannot finish inside the day's bands is
 *    not placed at all — see {@link canReachDayBands} for why cutting it
 *    removes no completion that exists. It costs no evaluation, because
 *    nothing was placed;
 *  - a day is accepted only when its LAST slot is filled AND the completed
 *    day passes {@link evaluateDayTolerance} — the guidance shares never
 *    accept or reject anything, and neither does the bound above;
 *  - within one slot, a recipe NOT yet used earlier today is tried before one
 *    that has been. This is move ORDER and not a rule: §0.7.3's two clauses
 *    stay the only hard ones, and a same-day pair is still reached by
 *    backtracking when the day cannot close without it;
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

    // The day's acceptance interval, derived once for the whole search.
    const bands = dayToleranceBands(targets);

    const placed: PlannedMealAssignment[][] = dates.map(() => []);
    // Reference counts beside the per-day sets, for the same reason the
    // ingredient bookkeeping below has them: §0.7.3 permits a recipe in two
    // slots of ONE day, so a day's membership is a count and not a flag. The
    // set is what the next day reads as its adjacent-day exclusion.
    const dayRecipeCounts: Map<string, number>[] = dates.map(() => new Map<string, number>());
    const dayRecipeIds: Set<string>[] = dates.map(() => new Set<string>());
    const usesByRecipeId = new Map<string, number>();
    // Reference counts beside the set: an ingredient stays "on the list" while
    // ANY placed meal still uses it, so unwinding one meal must not withdraw a
    // food another still needs. The set is what `reuseBonus` reads.
    const plannedFoodCounts = new Map<string, number>();
    const plannedFoodIds = new Set<string>();
    const evaluationsPerDay: number[] = dates.map(() => 0);

    /**
     * What each unfilled tail of slots can still contribute, as of the moment
     * the day was entered — one entry per day, indexed by slot.
     *
     * Recomputed on ENTRY TO EACH DAY rather than once for the search, and that
     * is what makes the bound bite where it matters. By day five the week has
     * spent most recipes' two permitted uses, so a slot's genuinely available
     * pool is a fraction of its whole one; a bound taken over the whole pool
     * would promise calories the day cannot actually reach and prune almost
     * nothing on exactly the days the search spends its budget on.
     *
     * Still a SUPERSET of what is available deeper in the day, so still
     * admissible: within a day the only further exclusions come from the day's
     * own placements, which can only remove candidates. A bound computed at
     * entry therefore over-promises, never under-promises — see
     * {@link canReachDayBands}. The same reasoning covers re-entry by
     * backtracking: unwinding a later day only returns uses, so the entry-time
     * bound of an earlier day stays a superset of its state on every revisit.
     */
    const dayRemainingBounds: RemainingContributionBounds[][] = dates.map(() => []);

    /**
     * The day's LAST slot pool as of the moment the day was entered — the pool
     * {@link someCandidateClosesDay} asks its exact question over.
     *
     * Captured alongside {@link dayRemainingBounds} and from the same filtered
     * lists, for the same reason and with the same admissibility: it is a
     * superset of what is available once the day's earlier slots are placed, so
     * the exact test over it is optimistic exactly as the interval bound is.
     */
    const dayFinalSlotPool: PlanCandidate[][] = dates.map(() => []);

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

    /**
     * Records one more occurrence of a recipe on a day.
     *
     * THE INVARIANT: `dayRecipeIds[dayIndex]` holds a recipe exactly while
     * `dayRecipeCounts[dayIndex]` counts at least one placement of it on that
     * day. A plain set would break the moment §0.7.3's two same-day uses are
     * both taken — unwinding one of them would withdraw the recipe from the
     * day, and the NEXT day's adjacent-day exclusion would then silently stop
     * enforcing "never on consecutive days" for a dish still sitting in the
     * earlier day's other slot.
     */
    const addDayRecipe = (dayIndex: number, recipeId: string): void => {
        dayRecipeCounts[dayIndex].set(recipeId, (dayRecipeCounts[dayIndex].get(recipeId) ?? 0) + 1);
        dayRecipeIds[dayIndex].add(recipeId);
    };

    /** Withdraws one occurrence, and the set entry only at the last of them. */
    const removeDayRecipe = (dayIndex: number, recipeId: string): void => {
        const remaining = (dayRecipeCounts[dayIndex].get(recipeId) ?? 1) - 1;

        if (remaining <= 0) {
            dayRecipeCounts[dayIndex].delete(recipeId);
            dayRecipeIds[dayIndex].delete(recipeId);
        } else {
            dayRecipeCounts[dayIndex].set(recipeId, remaining);
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
        addDayRecipe(dayIndex, recipeId);
        usesByRecipeId.set(recipeId, (usesByRecipeId.get(recipeId) ?? 0) + 1);
        addFoods(candidate);
    };

    const unplace = (dayIndex: number, candidate: PlanCandidate): void => {
        const recipeId = candidate.recipe.recipe_id;

        placed[dayIndex].pop();
        removeDayRecipe(dayIndex, recipeId);

        const remaining = (usesByRecipeId.get(recipeId) ?? 1) - 1;
        if (remaining <= 0) {
            usesByRecipeId.delete(recipeId);
        } else {
            usesByRecipeId.set(recipeId, remaining);
        }

        removeFoods(candidate);
    };

    /**
     * A move plus the only thing ordered ahead of its score: whether taking it
     * would put a recipe on this day for the second time.
     */
    interface TieredMove {
        repeatsToday: boolean;
        repeatsThisWeek: boolean;
        move: ScoredCandidate;
    }

    /**
     * Variety first — today's, then the week's — and then the scored order.
     *
     * A candidate already on today's plate sorts behind every candidate that is
     * not, whatever the two score. That makes same-day variety a PREFERENCE
     * expressed in the order rather than a third repetition clause: the repeat
     * is still in the list, still reached by backtracking, and still taken when
     * the day cannot close without it — which is exactly what §0.7.3 permits
     * and what the removed same-day ban used to refuse.
     *
     * THE WEEK TIER IS NOT COSMETIC, and it is the difference between finding a
     * week and refusing one. §0.7.3 makes a recipe's two weekly uses a SCARCE
     * RESOURCE, and `reuseBonus` actively rewards spending it: a recipe already
     * on the list scores better, so the day that scored best is scored best
     * again tomorrow. The result was a week whose third day was a copy of its
     * first and whose fourth was a copy of its second — four days spending the
     * two permitted uses of every recipe that could carry a large target — after
     * which the remaining days had nothing left to reach the band with and the
     * week was refused as though the targets were impossible. Trying an unused
     * recipe before a used one defers that spending instead of front-loading
     * it, which is the least-constraining choice and keeps the later days
     * solvable.
     *
     * It cannot refuse a week, for the same reason the day tier cannot: a used
     * recipe is still offered, still reached by backtracking, and still taken
     * when nothing else closes the day. Only the order in which equally legal
     * weeks are discovered changes. Inside a tier the comparison is the shipped
     * one, so the scored order and its shuffle tie-break are untouched.
     */
    const compareTieredMoves = (left: TieredMove, right: TieredMove): number => {
        if (left.repeatsToday !== right.repeatsToday) {
            return left.repeatsToday ? 1 : -1;
        }

        if (left.repeatsThisWeek !== right.repeatsThisWeek) {
            return left.repeatsThisWeek ? 1 : -1;
        }

        return compareCandidateMoves(left.move, right.move);
    };

    const orderedMoves = (
        dayIndex: number,
        slotIndex: number,
        cumulative: MealPlanMacroTotals,
        allowSameDayRepeat: boolean,
    ): ScoredCandidate[] => {
        const slot = slots[slotIndex];
        const previousDayRecipeIds = dayIndex > 0 ? dayRecipeIds[dayIndex - 1] : EMPTY_RECIPE_IDS;
        const todaysRecipeIds = dayRecipeIds[dayIndex];
        const remaining = dayRemainingBounds[dayIndex][slotIndex + 1];
        const pool = candidatesBySlot.get(slot.slot) ?? [];
        // True when filling THIS slot leaves exactly the last one unfilled —
        // the single case in which the day's remainder is one candidate's
        // nutrition and can therefore be tested exactly rather than bounded.
        const isPenultimateSlot = slotIndex + 1 === slots.length - 1;
        const moves: TieredMove[] = [];

        for (const candidate of pool) {
            const recipeId = candidate.recipe.recipe_id;

            // The variety pass, and the ONLY thing it does differently: a dish
            // already on today's plate is not offered at all. `solveDay` runs
            // this pass first and the permissive one after, so the exclusion
            // can never refuse a week — see the two-pass note there.
            if (!allowSameDayRepeat && todaysRecipeIds.has(recipeId)) {
                continue;
            }

            // Three arguments, not four: the week is held to §0.7.3's two
            // clauses and to no exclusion of this module's own. `swap.logic.ts`
            // calls it with the same three, so the generator and the
            // alternatives sheet accept exactly the same meals; the optional
            // fourth argument is a caller-chosen exclusion outside the rule
            // that neither of them passes — see {@link violatesRepetitionRule}.
            if (
                violatesRepetitionRule(recipeId, usesByRecipeId.get(recipeId) ?? 0, previousDayRecipeIds)
            ) {
                continue;
            }

            const wouldTotal: MealPlanMacroTotals = {
                calories: cumulative.calories + candidate.nutrition.calories,
                protein: cumulative.protein + candidate.nutrition.protein,
                carbs: cumulative.carbs + candidate.nutrition.carbs,
                fat: cumulative.fat + candidate.nutrition.fat,
            };

            // The admissibility bound, applied where it costs nothing: a
            // candidate whose branch cannot finish inside the day's bands never
            // enters the move list, so it is never placed and never charged an
            // evaluation. At the LAST slot the remaining bounds are zero and
            // this is precisely the day tolerance, asked one step before the
            // placement that would have had to be undone.
            if (!canReachDayBands(wouldTotal, remaining, bands)) {
                continue;
            }

            // ONE SLOT LEFT AFTER THIS ONE, so the interval bound above is a
            // relaxation that can be replaced by the exact question — does any
            // candidate in the final slot's pool actually close this day? —
            // and that is where the search's budget was going. A prefix the
            // intervals admit but no single final meal completes would
            // otherwise be placed and charged, only for the exact test one slot
            // later to find an empty move list. See
            // {@link someCandidateClosesDay} for why this cuts nothing
            // reachable.
            if (
                isPenultimateSlot &&
                !someCandidateClosesDay(wouldTotal, dayFinalSlotPool[dayIndex], bands)
            ) {
                continue;
            }

            moves.push({
                repeatsToday: todaysRecipeIds.has(recipeId),
                repeatsThisWeek: (usesByRecipeId.get(recipeId) ?? 0) > 0,
                move: {
                    candidate,
                    score: scoreCandidate(
                        candidate,
                        cumulative,
                        slot.cumulativeShare,
                        targets,
                        userBudgetTier,
                        plannedFoodIds,
                    ),
                },
            });
        }

        moves.sort(compareTieredMoves);

        return moves.map((entry) => entry.move);
    };

    const solveSlot = (
        dayIndex: number,
        slotIndex: number,
        cumulative: MealPlanMacroTotals,
        allowSameDayRepeat: boolean,
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

        for (const move of orderedMoves(dayIndex, slotIndex, cumulative, allowSameDayRepeat)) {
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

            if (solveSlot(dayIndex, slotIndex + 1, next, allowSameDayRepeat)) {
                return true;
            }

            unplace(dayIndex, move.candidate);

            if (exhausted || aborted) {
                return false;
            }
        }

        return false;
    };

    /**
     * Takes this day's admissibility bound from the week as it stands.
     *
     * The filter is §0.7.3's own test, asked of each slot's whole pool: a
     * recipe at its weekly cap, or sitting on yesterday's plate, cannot appear
     * today whatever else happens, so its nutrition must not count towards what
     * today can still reach. Reusing `violatesRepetitionRule` rather than
     * restating its clauses is deliberate — a bound that disagreed with the
     * rule it models would prune branches the search would have accepted.
     */
    const captureDayRemainingBounds = (dayIndex: number): PlanCandidate[][] => {
        const previousDayRecipeIds = dayIndex > 0 ? dayRecipeIds[dayIndex - 1] : EMPTY_RECIPE_IDS;
        const availableForSlot = (slot: SlotSchedule): PlanCandidate[] =>
            (candidatesBySlot.get(slot.slot) ?? []).filter(
                (candidate) =>
                    !violatesRepetitionRule(
                        candidate.recipe.recipe_id,
                        usesByRecipeId.get(candidate.recipe.recipe_id) ?? 0,
                        previousDayRecipeIds,
                    ),
            );
        const perSlot = slots.map(availableForSlot);

        dayRemainingBounds[dayIndex] = remainingContributionBounds(
            perSlot.map((pool) => slotContributionBounds(pool)),
        );
        // The same entry-time pools the interval bounds are taken over, kept for
        // the exact last-slot test. Sharing the one filtered list is what keeps
        // the two bounds from ever disagreeing about what a day may still use.
        dayFinalSlotPool[dayIndex] = perSlot.length === 0 ? [] : perSlot[perSlot.length - 1];

        return perSlot;
    };

    /**
     * Fills one day, preferring a day whose dishes are all different.
     *
     * TWO PASSES OVER ONE DAY, and the order is the whole guarantee: the first
     * pass offers no dish already on today's plate, so a day that CAN be filled
     * from distinct recipes is. Only once that pass has been explored to
     * exhaustion — every distinct assignment of this day tried, and the rest of
     * the week tried on top of each — does the second pass reopen §0.7.3's
     * legal same-day pair. The property this buys is statable and testable: a
     * day serves one dish twice ONLY when, given the days before it, it cannot
     * be filled any other way.
     *
     * It cannot refuse a week. The second pass offers exactly what the rule
     * permits, so every week reachable under §0.7.3 is still reachable; the
     * first pass only changes which of them is found first. And it cannot run
     * away with the budget: both passes spend the same accumulating per-day
     * counter, so a day still costs at most its own allowance however it is
     * filled and however often it is re-entered.
     *
     * The passes are per DAY, not per week, because the recursion is: a later
     * day that dead-ends unwinds into this day's next candidate within the pass
     * it is in, and this day goes permissive only when its distinct pass has
     * nothing left anywhere below it.
     */
    const solveDay = (dayIndex: number): boolean => {
        if (dayIndex === dates.length) {
            return true;
        }

        const availablePools = captureDayRemainingBounds(dayIndex);

        // THE DAY'S OWN DEAD END, recognised before it is paid for. Days before
        // this one have already spent recipes' two permitted uses, so a day late
        // in a tightly-constrained week can be genuinely unfillable; without
        // this it would spend its entire allowance proving that, and running an
        // allowance out ENDS THE SEARCH rather than unwinding — taking with it
        // every week reachable by changing an earlier day. Answered here it is
        // an ordinary dead end costing ONE evaluation rather than an allowance:
        // the frontier still records this as the day that could not close, and
        // the recursion unwinds into the previous day's next candidate exactly
        // as a day that ran out of candidates would. See
        // {@link dayHasFeasibleAssignment}, and the two notes below for what is
        // charged and what is not.
        if (!dayHasFeasibleAssignment(availablePools, bands, usesByRecipeId)) {
            frontierDayIndex = Math.max(frontierDayIndex, dayIndex);

            // A SLOT WITH NOTHING IN IT IS FREE. There was no search to charge
            // for: the day is impossible because a slot has no candidate at all,
            // which is coverage, not arithmetic, and `analyzeLimitingConstraints`
            // answers it with `slot_coverage` alone. A week impossible for that
            // reason still refuses at zero cost, as it always has.
            if (availablePools.some((pool) => pool.length === 0)) {
                return false;
            }

            // THE PROOF IS WORK, SO IT IS CHARGED — one evaluation, to this day
            // and to the week, on the same guard-then-charge order `solveSlot`
            // uses.
            //
            // Not bookkeeping for its own sake. Every other dead end costs at
            // least one evaluation, which is what makes the two allowances bound
            // the whole search; a dead end that cost nothing would let the
            // search re-enter this day once per candidate of every day above it,
            // unbounded, with only the five-second wall to stop it — and that
            // wall is a `502`, where the truthful answer is a `422`. Charged,
            // the day can prove itself unfillable at most its own allowance
            // times and the week at most its own, so the refusal arrives inside
            // the budget that was always meant to bound it.
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

            return false;
        }

        // Reached only from `solveSlot`'s day-complete branch or as the search's
        // own entry point, both of which run with the stop flags false — see the
        // note in `solveSlot`.
        for (const allowSameDayRepeat of [false, true]) {
            if (solveSlot(dayIndex, 0, { calories: 0, protein: 0, carbs: 0, fat: 0 }, allowSameDayRepeat)) {
                return true;
            }

            // A budget wall or an abort is not a pass that came up empty: the
            // day was cut short, so reopening the repeat would spend a second
            // pass on a search that has already been stopped.
            if (exhausted || aborted) {
                break;
            }
        }

        frontierDayIndex = Math.max(frontierDayIndex, dayIndex);

        return false;
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
     * (§0.7.3) — and its `evaluations` is what the primary search already spent,
     * which is what {@link LimitingConstraintInput.probeEvaluationBudget}
     * subtracts from the request's allowance by default.
     */
    diagnostics?: PlanSearchDiagnostics;
    /**
     * How many candidate evaluations ALL the probes together may spend.
     *
     * Absent — the production case — means
     * `MAX_EVALUATIONS_PER_PLAN − (diagnostics?.evaluations ?? 0)`, floored at
     * zero: §0.7.3 bounds one plan request at {@link MAX_EVALUATIONS_PER_PLAN}
     * evaluations, the failed primary search has already spent
     * `diagnostics.evaluations` of them, and what is left is all the diagnosis
     * may spend. Deriving it here rather than at the call site is deliberate —
     * the bound must hold whether or not a caller remembers it.
     *
     * A caller may state the pool explicitly, which is how a test pins the
     * skip-and-report behaviour without constructing a 14,000-evaluation search
     * first. Zero is a legal value and means "no probe runs"; a negative or
     * fractional pool is a programming fault and throws
     * {@link MealPlanInputError}.
     */
    probeEvaluationBudget?: number;
}

/**
 * How the diagnosis's probe pool ended, which is a fact about the VERDICT and
 * not about the week.
 *
 *  - `complete` — every probe the verdict needed ran to completion.
 *  - `aborted` — a probe hit the injected deadline. That probe established
 *    nothing, and no later probe ran, because the deadline has already fired.
 *  - `budget_exhausted` — the request's evaluation allowance (§0.7.3) was spent
 *    before a probe the verdict would have run, so that probe was skipped.
 *
 * The last two mean the same thing to a reader of the rows: a relaxation row
 * that is ABSENT may be absent because nothing tested it. A row is a claim that
 * needs a witness, so an untested relaxation is reported as no row rather than
 * as a negative claim — and this value is how a caller can tell the difference.
 */
export type LimitingConstraintProbeOutcome = 'complete' | 'aborted' | 'budget_exhausted';

/** The verdict, plus what establishing it cost and how it ended. */
export interface LimitingConstraintVerdict {
    /** The rows, most-limiting first. Never empty. */
    constraints: LimitingConstraint[];
    /**
     * What the probes spent, in candidate evaluations — never more than
     * {@link LimitingConstraintInput.probeEvaluationBudget}, which is how a
     * caller can check §0.7.3's per-request bound rather than trust it.
     */
    probeEvaluations: number;
    /** Whether anything went untested, and why. */
    probeOutcome: LimitingConstraintProbeOutcome;
}

/**
 * Reads the probes' shared evaluation pool, or derives it from what the primary
 * search already spent.
 *
 * Zero is accepted where {@link resolveEvaluationBudget} refuses it, and the
 * difference is the point: a per-search cap of zero would report every week as
 * exhausted before the first placement, whereas a pool of zero is a legitimate
 * state of the world — the primary search spent the request's whole allowance —
 * and the caller's answer to it is to run no probe at all.
 */
const resolveProbeEvaluationPool = (input: LimitingConstraintInput): number => {
    const supplied = input.probeEvaluationBudget;

    if (supplied === undefined) {
        return Math.max(0, MAX_EVALUATIONS_PER_PLAN - (input.diagnostics?.evaluations ?? 0));
    }

    if (!Number.isInteger(supplied) || supplied < 0) {
        throw new MealPlanInputError(
            'probeEvaluationBudget must be a non-negative integer number of evaluations, received ' +
                String(supplied),
            'probeEvaluationBudget',
        );
    }

    return supplied;
};

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
 *
 * ONE EVALUATION POOL FOR THE WHOLE REQUEST. Each relaxation above is tested by
 * a real search, and there can be four of them, so probes run against a single
 * remaining-evaluation pool — {@link LimitingConstraintInput.probeEvaluationBudget},
 * by default whatever §0.7.3's per-plan bound has left after the primary search
 * — debited by each probe as it spends. Without it one 422 could run five full
 * searches and spend five times the bound the AAP states for a plan.
 *
 * The pool makes later probes CHEAPER, never differently ordered: the probes run
 * in the order written above whatever the pool holds, each still sees the
 * baseline ranks and the baseline admitted sets, and the same inputs still reach
 * the same verdict — a pool derived from the inputs is itself an input. The
 * honest consequence is that with the pool spent a relaxation row may be
 * OMITTED, and that is the correct trade: a row is a claim that needs a witness,
 * and a probe that never ran has none. {@link LimitingConstraintVerdict.probeOutcome}
 * is what says so out loud.
 *
 * An ABORTED probe is INCONCLUSIVE, never evidence. A probe cut off by the
 * deadline has established nothing about its relaxation, so it emits no row and
 * no further probe runs — the deadline has fired, and a second probe would only
 * spend the remaining pool discovering that again.
 */
export const analyzeLimitingConstraints = (
    input: LimitingConstraintInput,
): LimitingConstraintVerdict => {
    // `diagnostics` is read through `input` by `probeBudgetFor` rather than
    // destructured here: since the admissibility bound made a settled search
    // the normal outcome, no ROW is conditioned on how the search ended — only
    // the probes' remaining allowance is.
    const { seedInputs, preferences, targets, recipes, shouldAbort } = input;

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

    // The request's one evaluation pool, and what became of it. Every probe
    // below draws from `remainingEvaluations` and debits it; `probeEvaluations`
    // is the total drawn, which is what makes the §0.7.3 bound checkable by a
    // caller instead of a promise in a comment.
    let remainingEvaluations = resolveProbeEvaluationPool(input);
    let probeEvaluations = 0;
    let probeOutcome: LimitingConstraintProbeOutcome = 'complete';

    /**
     * Runs one counterfactual search, or declines to.
     *
     * Returns the search's whole outcome so nothing about it can be silently
     * dropped — the `aborted` flag in particular, whose loss is what let a
     * deadline expiry read as "this relaxation does not open the week". `null`
     * means the probe did NOT establish anything and the caller must treat its
     * relaxation as untested: the pool was empty, the deadline had already
     * fired, or this probe itself was cut off.
     *
     * The per-day cap is the smaller of the policy constant and what the pool
     * holds, because a day may not spend more than the request has left; both
     * are positive here, since a pool at zero returns before the search.
     */
    const probeWeek = (
        probePreferences: PlanGenerationPreferences,
        portionPolicy: PortionPolicy,
    ): PlanSearchOutcome | null => {
        if (probeOutcome === 'aborted') {
            return null;
        }

        if (remainingEvaluations <= 0) {
            probeOutcome = 'budget_exhausted';

            return null;
        }

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

        const outcome = searchPlanWeek({
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
            budget: {
                perPlan: remainingEvaluations,
                perDay: Math.min(MAX_EVALUATIONS_PER_DAY, remainingEvaluations),
            },
        });

        probeEvaluations += outcome.evaluations;
        remainingEvaluations = Math.max(0, remainingEvaluations - outcome.evaluations);

        if (outcome.aborted) {
            probeOutcome = 'aborted';

            return null;
        }

        return outcome;
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

    /**
     * One relaxed preference, reported only when its week needed the relaxation.
     *
     * False covers three different facts, and that is sound in exactly one
     * direction: the probe ran and found no week, the probe ran and found one it
     * could have built without the relaxation, or the probe never ran at all.
     * All three mean "no row", because a row asserts that THIS preference is
     * what stands between the user and a plan, and none of the three
     * establishes that. Which of them it was travels on
     * {@link LimitingConstraintVerdict.probeOutcome}.
     */
    const relaxationOpensTheWeek = (probePreferences: PlanGenerationPreferences): boolean => {
        const outcome = probeWeek(probePreferences, DEFAULT_PORTION_POLICY);

        return outcome?.days != null && placesNewlyAdmittedMeal(outcome.days);
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

    // The row is earned whenever every slot has something to put in it, and the
    // two routes to it are why the search's diagnostics travel here at all.
    // A SETTLED search that found no week has DEMONSTRATED the bands as the
    // reason: it explored every assignment the rule allows — the admissibility
    // bound cuts only branches that provably could not have closed the day — so
    // "no combination met the day bands" is a proved statement rather than a
    // guess. An EXHAUSTED search never settled the question: it stopped
    // mid-answer, so the bands remain an OPEN reason, and §0.7.3 requires that
    // case to report the tolerance for the day the search could not close.
    // Either way the row belongs. The frontier day itself cannot ride in it —
    // `slots` is a list of slots, never a day — so it travels on the error
    // beside the rows.
    //
    // A SLOT AT ZERO IS THE ONE CASE THAT EARNS NO ROW, whichever way the
    // search ended: the bands cannot be a reason, open or demonstrated, for a
    // week that no target would ever have closed because one meal of the day
    // has nothing to fill it. The honest answer there is `slot_coverage` alone.
    //
    // A THIN SLOT IS ITS OWN EXPLANATION, and a settled search over one reports
    // that alone: §0.7.3 asks for the tolerance when eligibility holds and no
    // combination meets the bands, and a shelf below
    // MIN_ELIGIBLE_RECIPES_PER_SLOT is precisely the case where it does not.
    // Adding the band there would offer a user with two dinners a target to
    // edit instead of the shelf that actually stopped the week. An exhausted
    // search is the exception the clause above already covers: nothing was
    // settled, so the band stays open and is reported beside the thin shelf.
    if (emptySlots.length === 0 && (thinSlots.length === 0 || input.diagnostics?.exhausted === true)) {
        constraints.push(nutritionToleranceRow);
    }

    // Likewise only meaningful once every slot has recipes: with a slot at zero,
    // no portion of anything closes the week.
    if (emptySlots.length === 0) {
        const widerWeek = probeWeek(preferences, EXTENDED_PORTION_POLICY)?.days ?? null;

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
    // return an unexplained one. It holds whatever became of the probe pool: an
    // aborted or exhausted analysis still answers with a row.
    return {
        constraints: constraints.length > 0 ? constraints : [nutritionToleranceRow],
        probeEvaluations,
        probeOutcome,
    };
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
 *    did not finish, so nothing is known about feasibility. THIS COVERS THE
 *    DEADLINE FIRING DURING THE LIMITING-CONSTRAINT ANALYSIS TOO, not only
 *    during the primary search: the probes run on the same clock and a
 *    part-finished analysis cannot name which constraint is limiting, so it is
 *    the same 502 rather than a 422 built from whatever was measured first;
 *  - {@link NoMatchingMealsError} when it finished and no week exists, carrying
 *    the constraints to act on. An exhausted evaluation budget is THIS case, not
 *    the first — including a diagnostic pool that ran dry, which skips the
 *    remaining probes by design: the search completed within the bounds it was
 *    given and the honest report is that these preferences do not admit a week.
 *    The error also carries the search's own diagnostics — which guard ran out,
 *    and the day it could not close — for the logs, never for the response body.
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

        // `diagnostics` is what bounds the probes — it carries the evaluations
        // the search above just spent, and the analysis subtracts them from
        // §0.7.3's per-plan allowance before running any probe.
        const verdict = analyzeLimitingConstraints({
            seedInputs,
            preferences,
            targets,
            recipes,
            shouldAbort,
            diagnostics,
        });

        // THE DEADLINE IS A 502 WHEREVER IT FIRES, INCLUDING IN HERE.
        //
        // The primary search's own abort is handled above, but the deadline can
        // just as easily first expire inside a diagnostic probe: the probes run
        // after the search, on the same clock, and each one is a full week
        // search of its own. This module's header states the rule that decides
        // it — only an aborted search is a 5xx, and an exhausted evaluation
        // budget is not — so an abort discovered here is the SAME event as an
        // abort discovered above and gets the same answer.
        //
        // Reporting it as `no_matching_meals` instead would be the one dishonest
        // outcome available: the probes are what establish WHICH constraint is
        // limiting, so an abort part-way through them means the analysis never
        // finished, and 10c would name whichever constraints happened to be
        // measured before the clock ran out as though they were the whole story.
        // "We couldn't finish your plan" is the truthful screen for that.
        //
        // `budget_exhausted` deliberately does NOT come here. That is the pool
        // running dry, not the clock — the search completed within the bounds it
        // was given, the remaining probes were skipped by design, and §0.7.3
        // makes exhaustion the 422. The two outcomes are separate values for
        // exactly this decision.
        if (verdict.probeOutcome === 'aborted') {
            throw new PlanGenerationError();
        }

        // `.constraints` only: the 422 body is `{limitingConstraints,
        // allergiesKept}` (§0.5.2) and the error's diagnostics are the search's
        // own, so the verdict's probe accounting stays on this side of the
        // boundary.
        throw new NoMatchingMealsError(verdict.constraints, {
            ...diagnostics,
            frontierDate: addDaysToDayKey(seedInputs.startDate, diagnostics.frontierDayIndex),
        });
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
