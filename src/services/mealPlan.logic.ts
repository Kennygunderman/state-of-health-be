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
import {
    isEligibleForPlanning,
    PlanningPreferences,
    PlanningRecipeVersion,
    scalePlannedNutrition,
} from './recipe.logic';
import type {
    BudgetPreference,
    BudgetTier,
    GeneratePlanPayload,
    InvalidRequestDetail,
    LimitingConstraint,
    MealPlanMacroTotals,
    MealSchedule,
    MealTimeEntry,
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

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const MILLISECONDS_PER_DAY = 86400000;
const PERCENT_SCALE = 100;
const SEED_FIELD_SEPARATOR = '|';

/**
 * The wire vocabulary for a plan `details[].code`. Machine-readable only — the
 * client maps each code to its own copy:
 *  - `invalid_id` — a path id or idempotency key that is not a v4 UUID.
 *  - `invalid_date` — `startDate` is not a real `YYYY-MM-DD` calendar date.
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

/* ---------------------------------------------------------------------------
 * Day keys — arithmetic in the user's calendar, never in the server's
 * ------------------------------------------------------------------------- */

/**
 * Whether a value is a real `YYYY-MM-DD` calendar date.
 *
 * The regex alone is not enough: it accepts `2026-02-30` and `2026-13-01`, and
 * a plan that silently started on a non-existent date would put six of its
 * seven days somewhere the user never asked for. The round-trip through UTC
 * rejects those, and UTC — not local time — is what keeps a day key a day key
 * rather than a moment that shifts with the server's zone.
 */
export const isDayKey = (value: unknown): value is string => {
    if (typeof value !== 'string' || !DAY_KEY_PATTERN.test(value)) {
        return false;
    }

    const year = Number(value.slice(0, 4));
    const month = Number(value.slice(5, 7));
    const day = Number(value.slice(8, 10));
    const parsed = new Date(Date.UTC(year, month - 1, day));

    return (
        parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day
    );
};

const requireDayKey = (value: string, field: string): string => {
    if (!isDayKey(value)) {
        throw new MealPlanInputError(
            `${field} must be a YYYY-MM-DD calendar date, received ${JSON.stringify(value)}`,
            field,
        );
    }

    return value;
};

const dayKeyToUtcMillis = (dayKey: string): number =>
    Date.UTC(Number(dayKey.slice(0, 4)), Number(dayKey.slice(5, 7)) - 1, Number(dayKey.slice(8, 10)));

const formatDayKey = (utcMillis: number): string => new Date(utcMillis).toISOString().slice(0, 10);

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
 */
export const buildPlanCandidates = (
    recipes: readonly PlanRecipeCandidate[],
    preferences: PlanningPreferences,
    seed: number,
    portionPolicy: PortionPolicy = DEFAULT_PORTION_POLICY,
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

    const shuffled = [...candidates];
    const draw = mulberry32(seed);

    for (let index = shuffled.length - 1; index > 0; index -= 1) {
        const target = Math.floor(draw() * (index + 1));
        const held = shuffled[index];
        shuffled[index] = shuffled[target];
        shuffled[target] = held;
    }

    shuffled.forEach((candidate, rank) => {
        candidate.shuffleRank = rank;
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

    const breaches: DayToleranceBreach[] = [];

    if (Math.abs(totals.calories - calorieTarget) > CALORIE_TOLERANCE_RATIO * calorieTarget + TOLERANCE_EPSILON) {
        breaches.push('calories');
    }

    if (
        totals.protein < proteinTarget - PROTEIN_TOLERANCE_UNDER_G - TOLERANCE_EPSILON ||
        totals.protein > proteinTarget + PROTEIN_TOLERANCE_OVER_G + TOLERANCE_EPSILON
    ) {
        breaches.push('protein');
    }

    const carbsBand = Math.max(MACRO_TOLERANCE_ABSOLUTE_G, MACRO_TOLERANCE_RATIO * carbsTarget);
    if (Math.abs(totals.carbs - carbsTarget) > carbsBand + TOLERANCE_EPSILON) {
        breaches.push('carbs');
    }

    const fatBand = Math.max(MACRO_TOLERANCE_ABSOLUTE_G, MACRO_TOLERANCE_RATIO * fatTarget);
    if (Math.abs(totals.fat - fatTarget) > fatBand + TOLERANCE_EPSILON) {
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
 */
export const computeDayTotals = (
    meals: readonly { planned: MealPlanMacroTotals }[],
): MealPlanMacroTotals => {
    const totals: MealPlanMacroTotals = { calories: 0, protein: 0, carbs: 0, fat: 0 };

    for (const meal of meals) {
        totals.calories += meal.planned.calories;
        totals.protein += meal.planned.protein;
        totals.carbs += meal.planned.carbs;
        totals.fat += meal.planned.fat;
    }

    return totals;
};

/* ---------------------------------------------------------------------------
 * The search — depth-first, best-first move order, first feasible, bounded
 * ------------------------------------------------------------------------- */

const EMPTY_RECIPE_IDS: ReadonlySet<string> = new Set<string>();

/** Everything one search run needs, and nothing it could fetch. */
interface SearchInput {
    dates: readonly PlanDate[];
    slots: readonly SlotSchedule[];
    candidatesBySlot: ReadonlyMap<MealSlot, readonly PlanCandidate[]>;
    targets: MealPlanMacroTotals;
    userBudgetTier: BudgetTier;
    /** Injected wall-clock check. Absent means the run is unbounded in time. */
    shouldAbort?: () => boolean;
}

/**
 * What a run found, and if it found nothing, how it ran out.
 *
 * The three failure modes are kept apart because they become three different
 * answers: `aborted` is the only one that is a server failure, `exhausted` and a
 * plain infeasible search are both feasibility verdicts, and `frontierDayIndex`
 * is what the verdict points the user at.
 */
interface SearchOutcome {
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
    /** The injected deadline fired. The caller decides what that means. */
    aborted: boolean;
}

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
 * out ends the search and is reported, never thrown.
 */
const searchWeek = (input: SearchInput): SearchOutcome => {
    const { dates, slots, candidatesBySlot, targets, userBudgetTier, shouldAbort } = input;

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

            if (
                evaluationsPerDay[dayIndex] >= MAX_EVALUATIONS_PER_DAY ||
                evaluations >= MAX_EVALUATIONS_PER_PLAN
            ) {
                exhausted = true;
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
 *      bands, including the case where the evaluation budget ran out.
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
    const { seedInputs, preferences, targets, recipes, shouldAbort } = input;

    const seed = derivePlanSeed(seedInputs);
    const dates = planDatesFrom(seedInputs.startDate);
    const userBudgetTier = resolveUserBudgetTier(
        preferences.budget,
        preferences.no_budget_preference,
        preferences.meal_schedule,
    );

    const probeFeasible = (
        probePreferences: PlanGenerationPreferences,
        portionPolicy: PortionPolicy,
    ): boolean => {
        const slots = resolveSlotSchedule(probePreferences.meal_schedule, probePreferences.meal_times);
        const candidates = buildPlanCandidates(recipes, probePreferences, seed, portionPolicy);

        return (
            searchWeek({
                dates,
                slots,
                candidatesBySlot: groupCandidatesBySlot(candidates, probePreferences, slots, portionPolicy),
                targets,
                userBudgetTier,
                shouldAbort,
            }).days !== null
        );
    };

    const slots = resolveSlotSchedule(preferences.meal_schedule, preferences.meal_times);
    const candidates = buildPlanCandidates(recipes, preferences, seed);

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
        probeFeasible({ ...preferences, cooking_time_limit_min: relaxedCookingTime }, DEFAULT_PORTION_POLICY)
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
        probeFeasible(
            { ...preferences, disliked_food_ids: [], disliked_food_groups: [] },
            DEFAULT_PORTION_POLICY,
        )
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
        probeFeasible({ ...preferences, diet: 'none' }, DEFAULT_PORTION_POLICY)
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

    // Reported only when eligibility actually HELD — the condition the row
    // claims. With a slot empty or thin, the numbers were never the reason the
    // week failed, and saying they were would send the user to change a target
    // that would not have helped.
    if (emptySlots.length === 0 && thinSlots.length === 0) {
        constraints.push(nutritionToleranceRow);
    }

    // Likewise only meaningful once every slot has recipes: with a slot at zero,
    // no portion of anything closes the week.
    if (emptySlots.length === 0 && probeFeasible(preferences, EXTENDED_PORTION_POLICY)) {
        constraints.push({
            constraintKey: 'portion_limits',
            value: null,
            unit: null,
            slots: [],
            editStep: 'goal',
        });
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
 *    honest report is that these preferences do not admit a week.
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

    const outcome = searchWeek({
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
        throw new NoMatchingMealsError(
            analyzeLimitingConstraints({ seedInputs, preferences, targets, recipes, shouldAbort }),
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
        throw new PlanNotActiveError(plan.replacement_plan_id ?? undefined, undefined);
    }

    if (isPlanEnded(plan, today)) {
        throw new PlanNotActiveError(undefined, ENDED_REASON);
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

export type ParsedRegeneratePlanRequest =
    | { kind: 'ok'; planId: string; payload: RegeneratePlanPayload }
    | MealPlanErrorVerdict;

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
 * Judges one revision field: present, an integer, and at least `minimum`.
 *
 * Split from the field list so the three revisions cannot drift apart, and
 * split by code so the client can tell "you sent a string" from "you sent -1".
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
 * Validates `POST /meal-planning/plans`.
 *
 * Every field is judged before returning, so a request with three problems
 * reports three details instead of sending the caller back three times.
 */
export const parseGeneratePlanRequest = (
    body: unknown,
    window: StartDateWindow,
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
    } else if (startDate < window.earliest || startDate > window.latest) {
        details.push({ field: START_DATE_FIELD, code: MEAL_PLAN_FIELD_CODES.OUT_OF_RANGE });
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
