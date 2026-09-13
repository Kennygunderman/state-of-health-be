// The I/O half of the weekly meal plan: the five `/meal-planning/plans*` use
// cases — publish a week, replace one, read the current and upcoming weeks,
// read one day, list the meals a preference change made incompatible — plus the
// plan/day/meal DTO assembly and the two transaction-scoped loaders the swap and
// planned-log services build their own writes from.
//
// Orchestration only (Rule backend-architecture §5). Every DECISION already
// belongs to a neighbour and is delegated to it, because a rule re-decided here
// would be a rule no unit test could reach (§7, §11):
//
//  * `mealPlan.logic.ts` owns the planner and the lifecycle: `generateWeeklyPlan`
//    (the whole search), `planDatesFrom` / `planEndDate` (the week's dates),
//    `resolveSlotSchedule` (the two orders a day has), `derivePlanSeed`,
//    `computeDayTotals`, `requireWritablePlan`, `requireNonConflictingWeek`,
//    `resolveCurrentAndUpcoming`, `startDateWindow` and the two request parsers.
//    Nothing below decides whether a week is feasible, whether a plan is
//    writable, or which plan is "this week".
//  * `targets.service.ts` owns the targets gate — `requireConfirmedTargets` is
//    what stops a week being built on numbers nobody confirmed — and
//    `getTargets` is the one canonical target read every surface shares.
//  * `preferences.service.ts` owns the user's calendar (`dayKeyInTimeZone`) and
//    the stored preference row, so "today" has one definition in the user's own
//    IANA zone.
//  * `recipe.service.ts` owns every recipe read, including the plannable
//    candidate set and its load-bearing `slug, version` order.
//  * `recipe.mapper.ts` owns the recipe projection a plan card renders; no
//    `recipe` object is hand-built below.
//  * `grocery.service.ts` owns the shopping list: the drafts a week implies, the
//    insert that publishes them and the check state a regeneration carries over.
//  * `mealPlanningAction.service.ts` owns the keyed-write sequence — lock,
//    reserve, replay, complete — and is the ONLY thing below that opens a lock
//    or reserves a ledger row.
//
// WHY THE DTO ASSEMBLY LIVES HERE. Agent Action Plan §0.7.1 sketched a
// `mealPlan.mapper.ts`; Rule backend-architecture §6 says a row -> DTO mapper is
// "a private const at the top of the service while there's one, promoted to
// `src/services/<domain>.mapper.ts` once two services need it or it grows past a
// screenful". Exactly one service reads these rows — `swap.service.ts` and
// `plannedMealLog.service.ts` obtain their meal and day DTOs by calling the
// three `load*Response` functions below rather than by mapping rows themselves —
// so the shape has one owner and stays here. That is also what keeps the import
// graph acyclic: this module imports neither of those two.
//
// WHY THE SEARCH RUNS OUTSIDE THE TRANSACTION. §0.5.1 requires the candidate
// week to be computed in memory BEFORE the transaction opens, and the ordering
// is load-bearing rather than stylistic: the search is bounded by a 5-second
// wall-clock deadline, and a transaction holding the per-user advisory lock for
// that long would block every other write the user makes — a grocery toggle, a
// swap, a preference save. So generation reads its inputs, searches, and only
// then opens a short transaction that re-reads the two revisions under the lock
// and refuses to publish against inputs that moved (§0.5.1, `409 stale_revision`).
//
// WHAT THIS FILE DOES NOT DO, each for a stated reason:
//
//  * NO HTTP. No `res`, no status codes. The success statuses the two keyed
//    writes return are values the pure layer produced and the ledger persisted;
//    every typed error is mapped once, at the controller (§8).
//  * NO FIELD VALIDATION OF ITS OWN. `parseGeneratePlanRequest` and
//    `parseRegeneratePlanRequest` are pure verdicts in `mealPlan.logic.ts`, and
//    their refusal is RETURNED unchanged rather than thrown — the convention
//    `preferences.service.ts` and `targets.service.ts` already follow, and the
//    reason both generation entry points take `body: unknown`: the parser needs
//    a `StartDateWindow` that only a database read can supply, so the parse
//    cannot happen in the controller.
//  * NO FLAG RECOMPUTATION. `preferences.service.ts::recomputeActivePlanFlags`
//    owns it. This file READS `meal_plan_meals.flags` and never writes it.
//  * NO READ OF `meal_plans.incompatibility_flags`. That column is an audit
//    record (`preferences.service.ts` says so where it writes it);
//    `hasIncompatibilities` below is derived from the MEALS' own flags, because
//    two sources for one fact is how a banner outlives the meal that caused it.
//  * NO FAILURE RECORD. A generation that fails persists nothing — no `failed`
//    plan row exists (§0.5.1) — so nothing below catches in order to write one.

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    AffectedMeal,
    AffectedMealsResponse,
    BudgetPreference,
    CurrentMealPlanResponse,
    Diet,
    GeneratePlanPayload,
    LoggedPlannedEntry,
    MealFlag,
    MealFlagCode,
    MealPlanDayEnvelopeResponse,
    MealPlanDayResponse,
    MealPlanMacroTotals,
    MealPlanMealResponse,
    MealPlanResponse,
    MealPlanSummary,
    MealSchedule,
    MealTimeEntry,
    PlanStatus,
    PreviousRecipeSummary,
    RegeneratePlanPayload,
} from '../types/mealPlanning';
import { MealSlot } from '../types/recipe';
import { formatQuarters, pluralizeCount } from '../utils/units';
import { PlannedMealForGroceries } from './grocery.logic';
import { buildPlanGroceryDrafts, loadStoredGroceryRows, writePlanGroceryRows } from './grocery.service';
import {
    GeneratedPlan,
    ParsedGeneratePlanRequest,
    PlanGenerationPreferences,
    PlanLifecycleState,
    PlanRecipeCandidate,
    generateWeeklyPlan,
    parseGeneratePlanRequest,
    parseRegeneratePlanRequest,
    requireNonConflictingWeek,
    requireWritablePlan,
    resolveCurrentAndUpcoming,
    startDateWindow,
} from './mealPlan.logic';
import {
    PlanNotFoundError,
    PreferencesIncompleteError,
    StalePlanError,
    StaleRevisionError,
} from './mealPlanning.errors';
import { KeyedActionType, buildRequestFingerprint } from './mealPlanningAction.logic';
import { KeyedActionParams, KeyedActionResult, runKeyedAction } from './mealPlanningAction.service';
import { isClockTime } from './preferences.logic';
import { PreferencesRow, dayKeyInTimeZone, loadPreferencesRow } from './preferences.service';
import { PlanningPreferences, isMealSlot } from './recipe.logic';
import { mapPlannedRecipeSummary } from './recipe.mapper';
import { getRecipeVersionsForPlanning } from './recipe.service';
import { getTargets, requireConfirmedTargets } from './targets.service';

/* ---------------------------------------------------------------------------
 * Policy constants
 * ------------------------------------------------------------------------- */

/**
 * How long the in-memory search may run before it is aborted (§0.7.3).
 *
 * Five seconds is a wall-clock ABORT, not a feasibility verdict: exceeding it
 * raises `PlanGenerationError` (`502 plan_generation_failed`, "we could not
 * finish"), which is a different answer from `NoMatchingMealsError` (`422`, "no
 * week fits these preferences"). The evaluation budget inside
 * `generateWeeklyPlan` is what bounds the search logically; this bounds the
 * REQUEST, so a pathological catalog cannot hold a connection open indefinitely.
 */
export const PLAN_GENERATION_DEADLINE_MS = 5000;

/** `meal_plans.revision` of a freshly published plan, which every insert below writes. */
const FIRST_PLAN_REVISION = 1;

/** `generation_attempt` of a first generation; a regeneration is the old value plus one. */
const FIRST_GENERATION_ATTEMPT = 1;

/** The two `meal_plans.status` values, as the column stores them. */
const ACTIVE_PLAN_STATUS: PlanStatus = 'active';
const SUPERSEDED_PLAN_STATUS: PlanStatus = 'superseded';

/**
 * The setup states a week may be generated from (§0.5.2,
 * `409 preferences_incomplete`).
 *
 * `completed` is admitted beside `ready_for_review` because generating a SECOND
 * week is a normal thing to do: the first publication sets the status to
 * `completed`, and refusing the next week would make "Plan another week"
 * unreachable for exactly the users who have used the feature.
 */
const GENERATABLE_SETUP_STATUSES: readonly string[] = ['ready_for_review', 'completed'];

/** What the preferences row records once a plan has been published from it. */
const COMPLETED_SETUP_STATUS = 'completed';

/** The noun a portion is counted in. Inflected by `utils/units.ts::pluralizeCount`. */
const PORTION_NOUN = 'serving';

const DAY_KEY_LENGTH = 10;

/* ---------------------------------------------------------------------------
 * Stored columns and the two naming worlds
 *
 * The database is snake_case and the wire is camelCase; the translation happens
 * here and nowhere else in this module (Rule backend-architecture §6). Every
 * `jsonb` column arrives as `unknown` and is READ DEFENSIVELY — never asserted —
 * because a column is data to inspect, not a shape to assume.
 * ------------------------------------------------------------------------- */

/**
 * A stored column contradicting the response contract.
 *
 * Its own class rather than a bare `Error` so the message says which column of
 * which row could not be read, and deliberately NOT a member of
 * `mealPlanning.errors.ts`: that vocabulary exists for failures the CLIENT must
 * distinguish and act on, and there is no client action for "the plan row this
 * server wrote is not readable". It reaches the controller as a 500, exactly as
 * `grocery.service.ts`'s and `mealPlanningAction.service.ts`'s own invariant
 * faults do.
 */
export class MealPlanDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MealPlanDataError';
    }
}

/** A `YYYY-MM-DD` day key as the `@db.Date` column stores it: midnight UTC. */
const toStoredDate = (dayKey: string): Date => new Date(`${dayKey}T00:00:00.000Z`);

/**
 * A stored `@db.Date` as a day key, from its UTC components and nothing else.
 *
 * The repository's `toDayKey` convention, spelled the same way in
 * `nutrition.service.ts`, `preferences.service.ts` and `grocery.mapper.ts`: the
 * column holds a calendar day, Prisma returns it as midnight UTC, and reading
 * LOCAL components on a server west of UTC would move a plan's last day back by
 * one and end the week a day early. An unparseable value is named rather than
 * left to surface as `toISOString`'s bare `RangeError`.
 */
const toDayKey = (date: Date, column: string, rowId: string): string => {
    if (!Number.isFinite(date.getTime())) {
        throw new MealPlanDataError(`${column} on row ${rowId} is not a valid date`);
    }

    return date.toISOString().slice(0, DAY_KEY_LENGTH);
};

/**
 * A value as a JSON column value.
 *
 * The same unavoidable cast `preferences.service.ts` and
 * `mealPlanningAction.service.ts` each confine to one helper: Prisma's
 * `InputJsonValue` is a recursive structural type that a declared interface does
 * not satisfy nominally, however JSON-representable every member of it is. Kept
 * here so no call site below carries a cast of its own.
 */
const asJsonValue = (value: MealPlanMacroTotals): Prisma.InputJsonValue =>
    value as unknown as Prisma.InputJsonValue;

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

/**
 * A membership test keyed off the DTO's own union, so it is exhaustive by
 * construction: widening `MealFlagCode` in `types/mealPlanning.ts` stops the
 * literal below compiling until the new code is handled. The construction
 * `recipe.mapper.ts` and `preferences.service.ts` both use, and for the same
 * stated reason — a hand-listed array of the same strings falls behind the
 * contract silently.
 */
const MEAL_FLAG_CODES: Readonly<Record<MealFlagCode, true>> = {
    diet: true,
    allergen: true,
    dislike: true,
    cooking_time: true,
};

const PLAN_STATUSES: Readonly<Record<PlanStatus, true>> = { active: true, superseded: true };

const DIETS: Readonly<Record<Diet, true>> = { none: true, vegetarian: true, vegan: true, pescatarian: true };

const MEAL_SCHEDULES: Readonly<Record<MealSchedule, true>> = { three: true, three_plus_snack: true };

const asMember = <T extends string>(set: Readonly<Record<T, true>>, value: unknown): T | null =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(set, value) ? (value as T) : null;

/**
 * The stored `meal_plan_meals.flags` column as the DTO's flags.
 *
 * VALIDATED, never asserted, and defensive PER ENTRY: a malformed entry is
 * dropped rather than failing the whole read, because the alternative is a plan
 * screen that cannot load — and therefore cannot be used to fix anything. The
 * same reading `preferences.service.ts` applies where it writes the column, so
 * a flag written there round-trips through here unchanged.
 *
 * An array of `{code, detail}` objects rather than of bare codes, because
 * several details can share one code: two milk-bearing meals both flag
 * `allergen` with their own ingredient names.
 */
const readStoredFlags = (stored: unknown): MealFlag[] => {
    if (!Array.isArray(stored)) {
        return [];
    }

    const flags: MealFlag[] = [];

    for (const candidate of stored) {
        const record = asRecord(candidate);

        if (record === null) {
            continue;
        }

        const code = asMember(MEAL_FLAG_CODES, record.code);

        if (code === null) {
            continue;
        }

        const detail = Array.isArray(record.detail)
            ? record.detail.filter((entry): entry is string => typeof entry === 'string')
            : [];

        flags.push({ code, detail });
    }

    return flags;
};

/**
 * The stored `meal_plans.targets_snapshot` column as four macro values.
 *
 * THROWS rather than defaulting, and that is the right trade here even though
 * the flags above are read leniently. The two columns fail differently: a
 * missing flag understates an incompatibility the user can still see on the
 * meal itself, while a fabricated snapshot would report that the week was built
 * against zero calories — it would make `targetsStale` meaningless and caption a
 * plan with a target nobody ever set. The column is written by the insert below
 * from four confirmed positive numbers, so an unreadable value is a data fault
 * to surface and fix.
 */
const readTargetsSnapshot = (stored: unknown, planId: string): MealPlanMacroTotals => {
    const record = asRecord(stored);
    const values = ['calories', 'protein', 'carbs', 'fat'].map((key) => record?.[key]);

    if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) {
        throw new MealPlanDataError(
            `meal_plans.targets_snapshot on plan ${planId} does not carry four finite macro values ` +
                `(${JSON.stringify(stored)}); the plan it was built against cannot be reported without them`,
        );
    }

    const [calories, protein, carbs, fat] = values;

    return { calories, protein, carbs, fat };
};

/**
 * The stored `meal_plans.status` column as the DTO's two-value union.
 *
 * An unrecognised value is a fault rather than a default: the two statuses mean
 * "you may write to this" and "follow the replacement", and guessing either
 * would let a stale screen mutate a plan or send the user nowhere. Note that an
 * ENDED plan is `active` here by design — §0.5.1 keeps the column as it is and
 * makes endedness a RULE (`isPlanEnded`), which every write path applies.
 */
const readPlanStatus = (stored: string, planId: string): PlanStatus => {
    const status = asMember(PLAN_STATUSES, stored);

    if (status === null) {
        throw new MealPlanDataError(
            `meal_plans.status on plan ${planId} is "${stored}", which is neither ` +
                `"${ACTIVE_PLAN_STATUS}" nor "${SUPERSEDED_PLAN_STATUS}"`,
        );
    }

    return status;
};

/**
 * The stored `meal_plan_meals.slot` column as the slot union.
 *
 * `recipe.logic.ts::isMealSlot` decides membership, so the vocabulary has one
 * owner. A meal whose slot is unreadable is a fault: the slot is what the
 * portion set, the eligibility clause and the day's ordering all turn on, so
 * reporting a guessed one would describe a meal that was never planned.
 */
const readMealSlot = (stored: string, mealId: string): MealSlot => {
    if (!isMealSlot(stored)) {
        throw new MealPlanDataError(`meal_plan_meals.slot on meal ${mealId} is "${stored}", which is not a meal slot`);
    }

    return stored;
};

/**
 * The stored `meal_plan_meals.slot_time` column as an `HH:mm` clock time.
 *
 * `preferences.logic.ts::isClockTime` decides the format, so the one definition
 * the schedule parser enforces on the way in is the one applied on the way out.
 */
const readSlotTime = (stored: string, mealId: string): string => {
    if (!isClockTime(stored)) {
        throw new MealPlanDataError(
            `meal_plan_meals.slot_time on meal ${mealId} is "${stored}", which is not an HH:mm time`,
        );
    }

    return stored;
};

/* ---------------------------------------------------------------------------
 * Portion text — ONE definition
 * ------------------------------------------------------------------------- */

/**
 * A portion multiplier as the string the plan card and the swap preview render,
 * e.g. `'1 serving'`, `'½ serving'`, `'1¼ servings'`.
 *
 * THE ONE DEFINITION, exported for that reason: `MealPlanMealResponse.portionText`
 * and `SwapPreviewAlternative.portionText` describe the same quantity, and the
 * preview a user approves must read exactly as the meal they end up with. A
 * second spelling in `swap.service.ts` is how the two come to disagree over
 * three quarters of a serving.
 *
 * The glyph comes from `utils/units.ts::formatQuarters` — the same renderer the
 * grocery list uses for cups and tablespoons — because every allowed multiplier
 * (`{0.5, 0.75, 1, 1.25, 1.5, 1.75, 2}`, snacks `{0.5 … 1.5}`) is an exact
 * quarter, so nothing is rounded away. The noun is inflected by that module's
 * `pluralizeCount`, so "serving" has one plural in the codebase.
 *
 * Singular AT OR BELOW one and plural above it: "½ serving" is the English a
 * reader expects, while `pluralizeCount`'s own numeric rule (plural for
 * anything but exactly one) would render "½ servings". The count handed to it is
 * therefore the INFLECTION, not the quantity — the quantity is already in the
 * glyph.
 */
export const formatPortionText = (portionMultiplier: number): string => {
    if (!Number.isFinite(portionMultiplier) || portionMultiplier <= 0) {
        throw new MealPlanDataError(
            `portion_multiplier must be a finite number greater than 0 to render, received ` +
                `${String(portionMultiplier)}`,
        );
    }

    const noun = pluralizeCount(portionMultiplier > 1 ? 2 : 1, PORTION_NOUN);

    return `${formatQuarters(portionMultiplier)} ${noun}`;
};

/* ---------------------------------------------------------------------------
 * Row projections
 *
 * The recipe version behind a planned meal is read WHOLE rather than projected:
 * `recipe.mapper.ts::RecipeVersionRow` needs twenty-four of the table's columns,
 * so an explicit select would restate the table with one more way to fall behind
 * it. Everything else is projected.
 * ------------------------------------------------------------------------- */

/**
 * What a planned meal joins: the recipe version its summary is mapped from, and
 * the name of the version this slot held before its last swap.
 *
 * `previous_recipe_versions` is an AUDIT join and never the source of logged
 * state — with A logged and the slot swapped to B and then to C it says B, while
 * the diary entries still say A. `loggedEntries` below is what the card derives
 * its state from, which is why it stays right after any number of swaps.
 */
const PLAN_MEAL_INCLUDE = {
    recipe_versions: true,
    previous_recipe_versions: { select: { id: true, name: true } },
} satisfies Prisma.meal_plan_mealsInclude;

/** One planned meal with its joins, as the reads below return it. */
type PlanMealRow = Prisma.meal_plan_mealsGetPayload<{ include: typeof PLAN_MEAL_INCLUDE }>;

/** Meals of one day in the order the day is READ: the clock order generation stored. */
const PLAN_MEAL_ORDER: Prisma.meal_plan_mealsOrderByWithRelationInput[] = [{ sort_order: 'asc' }, { id: 'asc' }];

/** One day with its meals, as the plan and day reads return it. */
const PLAN_DAY_INCLUDE = {
    meal_plan_meals: { include: PLAN_MEAL_INCLUDE, orderBy: PLAN_MEAL_ORDER },
} satisfies Prisma.meal_plan_daysInclude;

type PlanDayRow = Prisma.meal_plan_daysGetPayload<{ include: typeof PLAN_DAY_INCLUDE }>;

/**
 * One day with its meals AND its plan's end date.
 *
 * The end date rides along because `isLastDay` needs it and a day read on its
 * own would otherwise take a second query for one column. Joining the parent
 * through the day is also the ownership check: the day's own
 * `{meal_plan_id, user_id}` predicate already restricts it to the caller's plan.
 */
const PLAN_DAY_WITH_PLAN_INCLUDE = {
    ...PLAN_DAY_INCLUDE,
    meal_plans: { select: { id: true, end_date: true } },
} satisfies Prisma.meal_plan_daysInclude;

/**
 * The `meal_plans` columns every plan read needs, including the audit and
 * snapshot columns the DTO reports.
 *
 * `incompatibility_flags` is deliberately absent: it is an audit record, and
 * `hasIncompatibilities` is derived from the meals (see the module header).
 */
const PLAN_COLUMNS = {
    id: true,
    revision: true,
    generation_attempt: true,
    start_date: true,
    end_date: true,
    status: true,
    preferences_revision: true,
    targets_revision: true,
    targets_snapshot: true,
} satisfies Prisma.meal_plansSelect;

/* ---------------------------------------------------------------------------
 * Linked diary entries — the one thing a plan DTO cannot derive from itself
 * ------------------------------------------------------------------------- */

/**
 * The non-deleted diary entries linked to the given planned meals, keyed by
 * `meal_plan_meal_id`.
 *
 * ORDERED `logged_at` THEN `id`, which is §0.5.2's requirement and not a
 * cosmetic choice: it is what makes "the latest entry" a defined thing, so the
 * client's "View in diary" always targets the same row and two reads of one plan
 * never reorder the captions. `id` breaks a tie at the same instant, which two
 * taps a millisecond apart can genuinely produce.
 *
 * `deleted_at: null` is the whole logged-state contract on the read side:
 * deleting the diary entry clears LOGGED with no `is_logged` column to correct,
 * because the state is derived on every read
 * (`plannedMealLog.logic.ts::deriveLoggedStatus` states the same rule).
 *
 * `user_id` is in the `where` beside the meal ids (§5.1). The ids themselves
 * always come from an owner-scoped plan read, so the predicate is belt and
 * braces — but a loader that trusted its arguments is one refactor away from
 * being handed an id from somewhere else.
 *
 * An entry whose `recipe_version_id` is null is SKIPPED. That is the detached
 * case `nutrition.service.ts::updateMealEntry` creates when a user rewrites an
 * entry's name or macros: it references no recipe, so it is neither this meal
 * logged nor an earlier one, and the DTO has nowhere truthful to put it.
 */
export const loadLoggedEntriesForMeals = async (
    db: Prisma.TransactionClient,
    userId: string,
    mealIds: readonly string[],
): Promise<Map<string, LoggedPlannedEntry[]>> => {
    const byMealId = new Map<string, LoggedPlannedEntry[]>();

    if (mealIds.length === 0) {
        return byMealId;
    }

    const entries = await db.meal_entries.findMany({
        where: {
            user_id: userId,
            deleted_at: null,
            meal_plan_meal_id: { in: [...new Set(mealIds)] },
        },
        select: {
            id: true,
            date: true,
            servings: true,
            logged_at: true,
            meal_plan_meal_id: true,
            recipe_version_id: true,
            meals: { select: { name: true } },
            recipe_versions: { select: { name: true } },
        },
        orderBy: [{ logged_at: 'asc' }, { id: 'asc' }],
    });

    for (const entry of entries) {
        if (entry.meal_plan_meal_id === null || entry.recipe_version_id === null || entry.recipe_versions === null) {
            continue;
        }

        const logged: LoggedPlannedEntry = {
            entryId: entry.id,
            date: toDayKey(entry.date, 'meal_entries.date', entry.id),
            mealName: entry.meals.name,
            servings: entry.servings,
            loggedAt: entry.logged_at.toISOString(),
            recipeVersionId: entry.recipe_version_id,
            recipeName: entry.recipe_versions.name,
        };

        const existing = byMealId.get(entry.meal_plan_meal_id);

        if (existing) {
            existing.push(logged);
        } else {
            byMealId.set(entry.meal_plan_meal_id, [logged]);
        }
    }

    return byMealId;
};

/* ---------------------------------------------------------------------------
 * The DTO boundary — one row shape, one mapper (Rule §6)
 * ------------------------------------------------------------------------- */

/** The recipe this slot held before its last swap, or null when it was never swapped. */
const mapPreviousRecipe = (row: PlanMealRow): PreviousRecipeSummary | null =>
    row.previous_recipe_versions === null
        ? null
        : { versionId: row.previous_recipe_versions.id, name: row.previous_recipe_versions.name };

/**
 * One `meal_plan_meals` row as the wire shape.
 *
 * `planned` carries the stored `planned_*` columns UNROUNDED, which is what
 * keeps a day's total equal to the sum of its meals: the columns hold full
 * precision by design (`mealPlan.logic.ts::computeDayTotals` sums them the same
 * way), and rounding each meal here before the client added them up would drift
 * the card away from the day.
 */
const mapPlanMeal = (row: PlanMealRow, loggedEntries: readonly LoggedPlannedEntry[]): MealPlanMealResponse => ({
    id: row.id,
    revision: row.revision,
    slot: readMealSlot(row.slot, row.id),
    slotTime: readSlotTime(row.slot_time, row.id),
    sortOrder: row.sort_order,
    recipe: mapPlannedRecipeSummary(row.recipe_versions),
    portionMultiplier: row.portion_multiplier,
    portionText: formatPortionText(row.portion_multiplier),
    planned: {
        calories: row.planned_calories,
        protein: row.planned_protein_g,
        carbs: row.planned_carbs_g,
        fat: row.planned_fat_g,
    },
    flags: readStoredFlags(row.flags),
    loggedEntries: [...loggedEntries],
    previousRecipe: mapPreviousRecipe(row),
});

/**
 * One `meal_plan_days` row as the wire shape.
 *
 * `plannedTotals` comes from the STORED `planned_*` columns rather than from
 * re-summing the meals. The two agree — generation writes the sum and a swap
 * rewrites it in the same transaction that rewrites the meal — and reading the
 * column is what makes that agreement checkable: a day whose stored total had
 * drifted would be visible, where a re-sum would silently paper over it.
 *
 * `isLastDay` is `date === endDate`, the plan's seventh day, which is where the
 * client offers the next week. Derived from the plan's own end date rather than
 * from `day_index === 6`, so a day that was stored with a wrong index cannot
 * move the offer to the wrong card.
 */
const mapPlanDay = (
    row: PlanDayRow,
    endDate: string,
    loggedByMealId: ReadonlyMap<string, LoggedPlannedEntry[]>,
): MealPlanDayResponse => {
    const date = toDayKey(row.date, 'meal_plan_days.date', row.id);

    return {
        id: row.id,
        date,
        dayIndex: row.day_index,
        plannedTotals: {
            calories: row.planned_calories,
            protein: row.planned_protein_g,
            carbs: row.planned_carbs_g,
            fat: row.planned_fat_g,
        },
        isLastDay: date === endDate,
        meals: row.meal_plan_meals.map((meal) => mapPlanMeal(meal, loggedByMealId.get(meal.id) ?? [])),
    };
};

/* ---------------------------------------------------------------------------
 * The three composed reads every caller shares
 * ------------------------------------------------------------------------- */

/**
 * One planned meal as the wire shape, or `null` when it is not the caller's.
 *
 * ONE PREDICATE, `{id, meal_plan_id, user_id}` — never an ownership read
 * followed by a lookup by id (§5.1) — so a caller cannot probe another user's
 * meal ids, and "no such meal", "not in that plan" and "not your plan" are the
 * same answer. `null` rather than a throw, because who turns a miss into a 404
 * differs: a plain read answers 404 while a keyed write has already established
 * the plan and treats a missing meal as the fault it would be.
 *
 * This is the function `swap.service.ts` and `plannedMealLog.service.ts` return
 * their meal DTO from, which is what keeps one meal shape in the codebase.
 */
export const loadMealPlanMealResponse = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    mealId: string,
): Promise<MealPlanMealResponse | null> => {
    const meal = await db.meal_plan_meals.findFirst({
        where: { id: mealId, meal_plan_id: planId, user_id: userId },
        include: PLAN_MEAL_INCLUDE,
    });

    if (meal === null) {
        return null;
    }

    const logged = await loadLoggedEntriesForMeals(db, userId, [meal.id]);

    return mapPlanMeal(meal, logged.get(meal.id) ?? []);
};

/**
 * One day of a plan as the wire shape, or `null` when the plan is not the
 * caller's or the date is not one of its seven.
 *
 * The day's own `{meal_plan_id, user_id}` predicate is the ownership check, and
 * the `(meal_plan_id, date)` unique index is what makes a date address at most
 * one day. A date outside the week matches nothing and is therefore the same
 * `null` an unowned plan gives.
 */
export const loadMealPlanDayResponse = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    date: string,
): Promise<MealPlanDayResponse | null> => {
    const day = await db.meal_plan_days.findFirst({
        where: { meal_plan_id: planId, user_id: userId, date: toStoredDate(date) },
        include: PLAN_DAY_WITH_PLAN_INCLUDE,
    });

    if (day === null) {
        return null;
    }

    const logged = await loadLoggedEntriesForMeals(
        db,
        userId,
        day.meal_plan_meals.map((meal) => meal.id),
    );

    return mapPlanDay(day, toDayKey(day.meal_plans.end_date, 'meal_plans.end_date', day.meal_plans.id), logged);
};

/**
 * The counts the plan header and the regeneration dialog render.
 *
 * Counted rather than derived from the loaded rows, because two of the three
 * cannot be: the grocery rows are a different table, and the logged entries are
 * the diary's. `plannedMeals` is counted for symmetry and for the same reason
 * the day totals are read rather than re-summed — a count that disagreed with
 * the loaded days would be visible.
 *
 * Sequential rather than concurrent: `db` may be an interactive transaction
 * client, which is one connection, and all three are index lookups. The
 * `loggedEntryCount` predicate reaches the entries through their planned meal's
 * `{meal_plan_id, user_id}`, so it is scoped by plan AND owner on both sides of
 * the join — this is the count the regeneration dialog promises to keep.
 */
const loadPlanSummary = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
): Promise<MealPlanSummary> => {
    const plannedMeals = await db.meal_plan_meals.count({ where: { meal_plan_id: planId, user_id: userId } });
    const groceryItemCount = await db.grocery_items.count({ where: { meal_plan_id: planId, user_id: userId } });
    const loggedEntryCount = await db.meal_entries.count({
        where: {
            user_id: userId,
            deleted_at: null,
            meal_plan_meals: { meal_plan_id: planId, user_id: userId },
        },
    });

    return { plannedMeals, groceryItemCount, loggedEntryCount };
};

/** Whether two target sets are the same four numbers. */
const sameTotals = (left: MealPlanMacroTotals, right: MealPlanMacroTotals): boolean =>
    left.calories === right.calories &&
    left.protein === right.protein &&
    left.carbs === right.carbs &&
    left.fat === right.fat;

/**
 * The targets a plan response reports, and whether they have moved since it was
 * built.
 *
 * `targets` is the user's CURRENT confirmed targets — the same values Account,
 * Progress and the diary show — read through `targets.service.ts::getTargets` so
 * there is one canonical target read in the product. `generationTargets` is the
 * snapshot the week was actually searched against, and `targetsStale` is simply
 * their inequality; nothing regenerates on its own, the client captions it.
 *
 * THE FALLBACK IS FOR AN INCOMPLETE CURRENT READ ONLY. When the stored targets
 * are not all four present the plan reports its snapshot as its current targets,
 * which keeps `targetsStale` false and the card truthful: the alternative is
 * showing a plan against `null` calories, and a plan that EXISTS was necessarily
 * built against four confirmed values. A `legacy` source is deliberately NOT
 * treated as incomplete — those four values are what the user's other surfaces
 * show today, so reporting them here (and flagging the difference) is the honest
 * answer, and refusing them is a decision `requireConfirmedTargets` makes on the
 * WRITE path, where a new week is at stake.
 */
const resolvePlanTargets = async (
    db: Prisma.TransactionClient,
    userId: string,
    generationTargets: MealPlanMacroTotals,
): Promise<{ targets: MealPlanMacroTotals; targetsStale: boolean }> => {
    const stored = await getTargets(userId, db);
    const values = stored.targets;

    if (
        !stored.complete ||
        values === null ||
        values.calories === null ||
        values.protein === null ||
        values.carbs === null ||
        values.fat === null
    ) {
        return { targets: generationTargets, targetsStale: false };
    }

    const targets: MealPlanMacroTotals = {
        calories: values.calories,
        protein: values.protein,
        carbs: values.carbs,
        fat: values.fat,
    };

    return { targets, targetsStale: !sameTotals(targets, generationTargets) };
};

/**
 * The targets a plan is judged against, for a caller that needs them without
 * the whole plan response.
 *
 * THE SWAP'S ONE SOURCE FOR THEM. `swap.service.ts` scores every candidate
 * against these values and the day card reports them through
 * {@link loadMealPlanResponse}; reading them through the same two steps —
 * `targets_snapshot` narrowed, then reconciled with the current confirmed
 * targets by {@link resolvePlanTargets} — is what makes it impossible for the
 * alternatives list, the preview and the day card to disagree about what the
 * day is aiming at. A swap that scored against the snapshot while the card
 * showed the current targets would offer a meal that visibly misses the number
 * beside it.
 *
 * `PlanNotFoundError` for a plan that is absent or not the caller's, because
 * every caller of this is on a path that has to answer 404 for exactly that.
 */
export const loadPlanTargets = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
): Promise<MealPlanMacroTotals> => {
    const plan = await db.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: { id: true, targets_snapshot: true },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    const { targets } = await resolvePlanTargets(db, userId, readTargetsSnapshot(plan.targets_snapshot, plan.id));

    return targets;
};

/**
 * A whole plan as the wire shape, or `null` when it is not the caller's.
 *
 * `null` and never a discriminating error: "no such plan" and "not your plan"
 * must be indistinguishable, and the caller decides whether that is a 404 or
 * (for `plans/current`) simply an absent member (§8).
 *
 * `hasIncompatibilities` is ANY meal carrying a flag, derived from the meals
 * already loaded. `meal_plans.incompatibility_flags` is the audit record
 * `preferences.service.ts` writes and is never read as authority here — two
 * sources for one fact is how a banner outlives the meal that caused it.
 *
 * Days come back in `date` order and their meals in `sort_order` (clock) order,
 * which is the order the day is read; the search's own slot order is a detail of
 * generation and is not re-derivable from — or needed by — a read.
 */
export const loadMealPlanResponse = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
): Promise<MealPlanResponse | null> => {
    const plan = await db.meal_plans.findFirst({ where: { id: planId, user_id: userId }, select: PLAN_COLUMNS });

    if (plan === null) {
        return null;
    }

    const days = await db.meal_plan_days.findMany({
        where: { meal_plan_id: planId, user_id: userId },
        include: PLAN_DAY_INCLUDE,
        orderBy: [{ date: 'asc' }],
    });

    const logged = await loadLoggedEntriesForMeals(
        db,
        userId,
        days.flatMap((day) => day.meal_plan_meals.map((meal) => meal.id)),
    );

    const generationTargets = readTargetsSnapshot(plan.targets_snapshot, plan.id);
    const { targets, targetsStale } = await resolvePlanTargets(db, userId, generationTargets);
    const endDate = toDayKey(plan.end_date, 'meal_plans.end_date', plan.id);
    // Mapped once and then read for `hasIncompatibilities`, so the banner turns
    // on exactly the flags the response carries rather than on a second reading
    // of the same column.
    const dayResponses = days.map((day) => mapPlanDay(day, endDate, logged));

    return {
        id: plan.id,
        revision: plan.revision,
        generationAttempt: plan.generation_attempt,
        startDate: toDayKey(plan.start_date, 'meal_plans.start_date', plan.id),
        endDate,
        status: readPlanStatus(plan.status, plan.id),
        targets,
        generationTargets,
        targetsStale,
        preferencesRevision: plan.preferences_revision,
        targetsRevision: plan.targets_revision,
        hasIncompatibilities: dayResponses.some((day) => day.meals.some((meal) => meal.flags.length > 0)),
        summary: await loadPlanSummary(db, userId, planId),
        days: dayResponses,
    };
};

/* ---------------------------------------------------------------------------
 * Lifecycle state and the grocery projection — shared with the write services
 * ------------------------------------------------------------------------- */

/**
 * Every plan of the user as the lifecycle rules read it, with
 * `replacement_plan_id` resolved.
 *
 * The plan that superseded another is the one whose `replaced_plan_id` points
 * back at it, and the successor is scoped by `user_id` as well (§5.1), so a
 * superseded plan can only ever report a replacement of the same user. The
 * NEWEST successor wins: a plan replaced and then replaced again should send a
 * stale screen to the current week rather than to an intermediate one — the same
 * resolution `grocery.service.ts` makes for its own writability check.
 *
 * Resolved for every plan rather than only for non-active ones, because which
 * status makes a plan unwritable is `requireWritablePlan`'s rule, and a loader
 * that branched on `status` to save a join would own half of it.
 */
export const loadPlanLifecycleStates = async (
    db: Prisma.TransactionClient,
    userId: string,
): Promise<PlanLifecycleState[]> => {
    const plans = await db.meal_plans.findMany({
        where: { user_id: userId },
        select: {
            id: true,
            status: true,
            start_date: true,
            end_date: true,
            replaced_by_plans: {
                where: { user_id: userId },
                orderBy: [{ published_at: 'desc' }, { id: 'desc' }],
                take: 1,
                select: { id: true },
            },
        },
        orderBy: [{ start_date: 'asc' }, { id: 'asc' }],
    });

    return plans.map((plan) => ({
        id: plan.id,
        status: plan.status,
        start_date: toDayKey(plan.start_date, 'meal_plans.start_date', plan.id),
        end_date: toDayKey(plan.end_date, 'meal_plans.end_date', plan.id),
        replacement_plan_id: plan.replaced_by_plans[0]?.id ?? null,
    }));
};

/**
 * The plan's meals as the grocery rules consume them.
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
 * Exported because a swap's grocery reconciliation needs the plan's meals AFTER
 * its write, and this is the one projection of them. Ordered by day then slot so
 * the aggregation walks the week in plan order — the sum is float addition,
 * which is not associative, and a stable order is what keeps two reads of one
 * plan producing the same grams.
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

/* ---------------------------------------------------------------------------
 * The three route-facing reads
 * ------------------------------------------------------------------------- */

/**
 * `GET /api/meal-planning/plans/current` — the week containing today and the one
 * starting after it.
 *
 * `{current: null, upcoming: null}` is the client's empty state and a perfectly
 * ordinary answer: a user with no plan at all. An ENDED plan is neither member,
 * which is `resolveCurrentAndUpcoming`'s rule and the reason `isPlanEnded` exists
 * as a predicate — a plan whose week finished yesterday is still `active` in the
 * database, and returning it as `current` would show a finished week and invite
 * writes to it.
 *
 * "Today" is the user's own calendar day, resolved from the zone their last save
 * stored. `now` is a parameter so a test fixes the clock rather than waiting for
 * one.
 */
export const getCurrentMealPlan = async (
    userId: string,
    now: Date = new Date(),
): Promise<CurrentMealPlanResponse> => {
    const row = await loadPreferencesRow(userId);
    const today = dayKeyInTimeZone(now, row?.time_zone ?? null);
    const { current, upcoming } = resolveCurrentAndUpcoming(await loadPlanLifecycleStates(prisma, userId), today);

    return {
        current: current === null ? null : await loadMealPlanResponse(prisma, userId, current.id),
        upcoming: upcoming === null ? null : await loadMealPlanResponse(prisma, userId, upcoming.id),
    };
};

/**
 * `GET /api/meal-planning/plans/:planId/days/:date` — one day, with fresh logged
 * state, without refetching the week.
 *
 * READABLE FOR A SUPERSEDED OR ENDED PLAN, deliberately: §0.5.2 declares no
 * `plan_not_active` for this route, because history has to keep working — the
 * diary still shows what was eaten from last week's plan, and `planStatus` is
 * what tells the client whether writes are still allowed. That is also why this
 * function takes no clock: no calendar day can change its answer, so a `now`
 * parameter would be one accepted only to be ignored.
 *
 * `PlanNotFoundError` covers a plan that is absent or not the caller's AND a
 * date outside the plan's week — §0.5.2's 404 for this route — because
 * distinguishing them would confirm the existence of a plan the caller has no
 * right to (§8).
 */
export const getMealPlanDay = async (
    userId: string,
    planId: string,
    date: string,
): Promise<MealPlanDayEnvelopeResponse> => {
    const plan = await prisma.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: { id: true, revision: true, status: true },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    const day = await loadMealPlanDayResponse(prisma, userId, planId, date);

    if (day === null) {
        throw new PlanNotFoundError();
    }

    return {
        planId: plan.id,
        planRevision: plan.revision,
        planStatus: readPlanStatus(plan.status, plan.id),
        day,
    };
};

/**
 * `GET /api/meal-planning/plans/:planId/affected-meals` — every meal of the plan
 * that no longer matches the user's saved preferences.
 *
 * The list behind the 16 "Review affected meals" banner. A meal appears only
 * because it carries flags, so `flags` is never empty on a returned row — the
 * DTO says so — and an empty `meals` array means the plan is fully compatible.
 *
 * The flags are READ, not recomputed: `preferences.service.ts` recomputes them
 * inside the transaction of the preference save that caused them, so a read that
 * re-derived them would either duplicate that rule or report a verdict the
 * stored plan does not carry. No clock parameter for the same reason as the day
 * read — the answer is the plan's stored state.
 */
export const getAffectedMeals = async (userId: string, planId: string): Promise<AffectedMealsResponse> => {
    const plan = await prisma.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: { id: true },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    const meals = await prisma.meal_plan_meals.findMany({
        where: { meal_plan_id: planId, user_id: userId },
        select: {
            id: true,
            slot: true,
            flags: true,
            meal_plan_days: { select: { id: true, date: true } },
            recipe_versions: { select: { name: true } },
        },
        orderBy: [{ meal_plan_days: { date: 'asc' } }, { sort_order: 'asc' }, { id: 'asc' }],
    });

    const affected: AffectedMeal[] = [];

    for (const meal of meals) {
        const flags = readStoredFlags(meal.flags);

        if (flags.length === 0) {
            continue;
        }

        affected.push({
            mealId: meal.id,
            date: toDayKey(meal.meal_plan_days.date, 'meal_plan_days.date', meal.meal_plan_days.id),
            slot: readMealSlot(meal.slot, meal.id),
            recipeName: meal.recipe_versions.name,
            flags,
        });
    }

    return { meals: affected };
};

/* ---------------------------------------------------------------------------
 * Generation and regeneration
 *
 * Both follow §0.5.1's sequence exactly, and the ORDER is the guarantee:
 *
 *   outside the transaction  read inputs -> parse -> REPLAY PREFLIGHT
 *                            -> judge state -> search in memory
 *   inside  the transaction  lock -> reserve -> replay -> re-check -> write
 *
 * The authoritative replay gate sits inside `runKeyedAction`, before `work`
 * runs, which is why every status and revision check below is repeated at the
 * TOP OF `work`: a client whose response was lost must be able to learn that its
 * own generation succeeded even after the plan has moved on.
 *
 * Neither route can put ALL of its state checks there, because §0.5.1 also
 * requires the candidate week to be searched in memory before the transaction
 * opens, and a search worth pre-empting is a search whose inputs were judged
 * first. {@link replayCommittedKeyedAction} is what keeps that ordering from
 * costing a replay: it asks the same gate, in its own two-statement
 * transaction, whether this exact key has already committed, and every
 * pre-transaction refusal below runs only after it has answered no.
 * ------------------------------------------------------------------------- */

/**
 * The refusal half of both generation entry points — the pure parsers' verdict,
 * unchanged.
 *
 * Derived from `ParsedGeneratePlanRequest` rather than re-declared, so it is the
 * same shape `mealPlan.logic.ts` produces by construction: the module does not
 * export the branch by name, and a hand-written copy would be free to drift from
 * the details the client renders beside its fields.
 */
export type MealPlanRefusal = Exclude<ParsedGeneratePlanRequest, { kind: 'ok' }>;

/** Either the ledger's result for a published week, or the parser's refusal verbatim. */
export type GeneratePlanResult = { kind: 'ok'; result: KeyedActionResult } | MealPlanRefusal;

/**
 * The rejection that rolls a preflight transaction back.
 *
 * Module-private and its own class, so {@link replayCommittedKeyedAction} can
 * recognise exactly its own rollback signal and let every other failure — a
 * conflict, a lock timeout, a connection fault — propagate untouched. A boolean
 * return from `work` could not do this: `work` must not RESOLVE, because a
 * resolved `work` is what makes `runKeyedAction` complete the reserved row.
 *
 * Verified rather than assumed: Prisma's interactive `$transaction` rethrows the
 * callback's rejection as the same object (probed against PostgreSQL 16 —
 * identity and `instanceof` both hold), so the `instanceof` test below is not a
 * guess about wrapping behaviour.
 */
class KeyedActionPreflightRollback extends Error {
    constructor(actionType: KeyedActionType) {
        super(
            `Rolling back the ${actionType} idempotency-key preflight: the key is unused, so nothing may ` +
                'persist from a transaction that only asked whether it had committed.',
        );
        this.name = 'KeyedActionPreflightRollback';
    }
}

/**
 * Answers ONE question before a keyed write does any work: has this exact
 * request already committed?
 *
 *  * the stored `KeyedActionResult` — this key committed, so replay it
 *  * `null` — the key has never been used, so the caller proceeds
 *  * throws `IdempotencyConflictError` — the key exists with a different
 *    fingerprint, which is a different request wearing a used key (§0.5.2)
 *
 * WHY THIS EXISTS. §0.5.1 fixes the order of a keyed write: lock, then reserve
 * or replay, and a matching fingerprint "replay[s] the stored `response_status`
 * and `response_snapshot` verbatim and end[s] the transaction BEFORE any
 * revision or status check, so a committed action replays even when the plan has
 * since moved on". `runKeyedAction` honours that for everything inside its
 * transaction — but generation and regeneration must judge mutable state and run
 * a five-second candidate search BEFORE the transaction opens, because §0.5.1
 * equally requires the candidate week to be "computed in memory before the
 * transaction" (see the module header on why the lock cannot be held for a
 * search). Those pre-transaction refusals sit in front of the replay gate, and
 * for a regeneration one of them is CERTAIN to fire on the retry path: a
 * successful regeneration supersedes the very plan the request pinned, so the
 * immediate same-key retry — exactly what a client sends when the response was
 * lost — would be answered `409 plan_not_active` and could never reach its
 * stored `201`. A generation fails the same way less deterministically, through
 * the preference gate, a moved revision or a search that now reports
 * `no_matching_meals`.
 *
 * WHY IT REUSES `runKeyedAction` RATHER THAN READING THE LEDGER ITSELF. The
 * fingerprint comparison, the pending-row invariant and the stored-response
 * shaping all live behind functions `mealPlanningAction.service.ts` keeps
 * private — `reserveAction`, `readAction` and `replayReservedAction`, §0.5.1's
 * reserve-or-replay step — over the pure `decideReplay` / `readStoredResponse`.
 * A second implementation here would be a second replay policy, and the two
 * would drift on the first change to either. So this calls the authoritative
 * gate and supplies a `work` that cannot succeed:
 *
 *  * key committed  -> `runKeyedAction` replays through its own path and never
 *    reaches `work`; the transaction commits, having only read
 *  * key unused     -> the reservation is made, `work` rejects with
 *    {@link KeyedActionPreflightRollback}, and the whole transaction rolls back,
 *    so the reserved row disappears with it (probed: zero `meal_plan_actions`
 *    rows survive) and the answer is `null`
 *  * fingerprint differs -> `IdempotencyConflictError` is raised before `work`
 *    is called at all
 *
 * THIS DOES NOT REPLACE THE FINAL LOCKED GATE, and neither may be "simplified"
 * away. The gate inside the caller's own `prisma.$transaction` stays the
 * authority: a key that commits on another connection WHILE this request is
 * searching must still replay rather than reserve twice, and only a gate in the
 * publishing transaction can see that. This preflight is an early exit on the
 * ERROR path — it turns a refusal that would have pre-empted a replay into the
 * replay itself — and it deliberately makes no decision the gate does not make
 * again.
 *
 * WHY IT LIVES HERE. Beside `runKeyedAction` in `mealPlanningAction.service.ts`
 * is where it belongs, and that file is another work unit's at this checkpoint,
 * so it is exported from here instead: the two callers below share it, and any
 * later keyed write that has to judge state before its transaction can import it
 * rather than writing a third variant. Moving it is a one-line change once both
 * files are in one hand.
 *
 * The transaction is two statements long — the advisory lock and the
 * reservation attempt — so the serialisation it costs the user is negligible
 * beside the search that follows it.
 */
export const replayCommittedKeyedAction = async (
    params: KeyedActionParams,
): Promise<KeyedActionResult | null> => {
    const rollback = new KeyedActionPreflightRollback(params.actionType);

    try {
        return await prisma.$transaction((tx) =>
            runKeyedAction(tx, params, () => Promise.reject(rollback)),
        );
    } catch (error) {
        if (error === rollback || error instanceof KeyedActionPreflightRollback) {
            return null;
        }

        throw error;
    }
};

/**
 * The preference row a week may be built from, or `PreferencesIncompleteError`.
 *
 * A user with no row at all gets the same error as one who stopped halfway: both
 * mean the answers the planner needs are not in yet, and the client resumes
 * onboarding from the step the preferences response reports, which is why the
 * error carries none.
 */
const requireGeneratableSetup = (row: PreferencesRow | null): PreferencesRow => {
    if (row === null || !GENERATABLE_SETUP_STATUSES.includes(row.setup_status)) {
        throw new PreferencesIncompleteError();
    }

    return row;
};

/**
 * The stored `meal_times` column as the schedule entries the generator reads.
 *
 * Defensive per entry, exactly as `preferences.service.ts` reads the same
 * column: a malformed entry is dropped, and `resolveSlotSchedule` — called
 * inside `generateWeeklyPlan` — then throws `MealPlanInputError` for the slot
 * that has no time, which names the fault instead of inventing a `slot_time` the
 * user never chose.
 */
const readMealTimes = (stored: unknown): MealTimeEntry[] => {
    if (!Array.isArray(stored)) {
        return [];
    }

    const entries: MealTimeEntry[] = [];

    for (const candidate of stored) {
        const record = asRecord(candidate);

        if (record === null) {
            continue;
        }

        if (isMealSlot(record.slot) && isClockTime(record.time)) {
            entries.push({ slot: record.slot, time: record.time });
        }
    }

    return entries;
};

/** The stored budget answer, or null — which is the real answer "no amount given". */
const readBudget = (row: PreferencesRow): BudgetPreference | null =>
    row.budget_amount === null || row.budget_currency === null
        ? null
        : { amount: row.budget_amount, currency: row.budget_currency };

/**
 * The five preference columns `recipe.logic.ts::evaluatePlanningEligibility`
 * reads, narrowed out of the stored row.
 *
 * Narrowed here rather than imported because `preferences.service.ts` keeps its
 * own equivalent private, and exported here because BOTH write paths that judge
 * eligibility need it: the generator, through
 * {@link toPlanGenerationPreferences} below, which adds the schedule and the
 * budget only a search needs; and `swap.service.ts`, whose candidate selection
 * needs exactly these five and nothing more. ONE narrowing rather than two is
 * what stops a swap from admitting a recipe the generator would have refused.
 *
 * `diet` goes through a closed set keyed off the contract's own union (see
 * `MEAL_FLAG_CODES` above), so an unrecognised stored value reads as "no diet
 * restriction" rather than reaching the eligibility rules as an unknown code.
 * A null row reads as "nothing restricted", which is what a user who has saved
 * no preference has said.
 */
export const toPlanningPreferences = (row: PreferencesRow | null): PlanningPreferences => ({
    diet: row === null ? null : asMember(DIETS, row.diet),
    allergens: row?.allergens ?? [],
    disliked_food_ids: row?.disliked_food_ids ?? [],
    disliked_food_groups: row?.disliked_food_groups ?? [],
    cooking_time_limit_min: row?.cooking_time_limit_min ?? null,
});

/**
 * The preference row as everything the GENERATOR reads about a user: the five
 * eligibility fields above, plus the schedule, the saved times and the budget
 * that only a search needs.
 *
 * A row with no schedule cannot be searched from — the slots and their guidance
 * shares are derived from it — and that is a data fault rather than a client
 * error, because `requireGeneratableSetup` has already established that setup
 * reached review.
 */
const toPlanGenerationPreferences = (row: PreferencesRow): PlanGenerationPreferences => {
    const schedule = asMember(MEAL_SCHEDULES, row.meal_schedule);

    if (schedule === null) {
        throw new MealPlanDataError(
            `meal_plan_preferences.meal_schedule for user ${row.user_id} is ` +
                `${JSON.stringify(row.meal_schedule)}, which is not a meal schedule; a week cannot be built ` +
                'without the slots it defines',
        );
    }

    return {
        ...toPlanningPreferences(row),
        meal_schedule: schedule,
        meal_times: readMealTimes(row.meal_times),
        budget: readBudget(row),
        no_budget_preference: row.no_budget_preference,
    };
};

/** Everything the transaction needs about a week that has already been searched. */
interface CandidateWeek {
    readonly plan: GeneratedPlan;
    readonly preferencesRevision: number;
    readonly targetsRevision: number;
    readonly targets: MealPlanMacroTotals;
    readonly generationAttempt: number;
}

/**
 * Searches one candidate week IN MEMORY, against inputs read outside any
 * transaction.
 *
 * The reads and the search happen in this order for stated reasons. The
 * client's pinned revisions are checked FIRST, against the values just read, so
 * a stale client is answered `409 stale_revision` immediately instead of after a
 * five-second search whose result it could never publish. The targets gate runs
 * next, so `422 targets_missing` and `409 targets_unconfirmed` also pre-empt the
 * search — both are re-run under the lock inside `work`, where they are
 * authoritative, and running them here costs two indexed reads to avoid a
 * pointless search.
 *
 * `shouldAbort` closes over an ELAPSED-TIME deadline whose origin is the clock
 * the predicate itself reads, taken at the instant before the search starts.
 * That origin is deliberately NOT the injected `now`: `now` is the request's
 * LOGICAL date, which a caller fixes to a past or future day to make day-key
 * arithmetic reproducible, and a five-second budget measured from it would have
 * expired before the search began (an injected past date) or never fire at all
 * (a future one). Anchoring it here is what makes the bound mean five seconds
 * of searching for every caller, which is the guarantee §0.5.1 states.
 * `generateWeeklyPlan` throws `PlanGenerationError` (the deadline fired) or
 * `NoMatchingMealsError` (the search finished and no week fits, carrying the
 * constraints to act on); both propagate untouched, because the difference is
 * exactly what the user is told.
 */
const searchCandidateWeek = async (
    userId: string,
    row: PreferencesRow,
    payload: { startDate: string; expectedPreferencesRevision: number; expectedTargetsRevision: number },
    generationAttempt: number,
): Promise<CandidateWeek> => {
    const { targets, targetsRevision } = await requireConfirmedTargets(prisma, userId);

    if (
        payload.expectedPreferencesRevision !== row.revision ||
        payload.expectedTargetsRevision !== targetsRevision
    ) {
        throw new StaleRevisionError({ preferencesRevision: row.revision, targetsRevision });
    }

    const recipes: readonly PlanRecipeCandidate[] = await getRecipeVersionsForPlanning(prisma);
    const deadline = Date.now() + PLAN_GENERATION_DEADLINE_MS;

    const plan = generateWeeklyPlan({
        seedInputs: {
            userId,
            startDate: payload.startDate,
            preferencesRevision: row.revision,
            targetsRevision,
            generationAttempt,
        },
        preferences: toPlanGenerationPreferences(row),
        targets,
        recipes,
        shouldAbort: () => Date.now() > deadline,
    });

    return { plan, preferencesRevision: row.revision, targetsRevision, targets, generationAttempt };
};

/**
 * Re-reads the two pinned inputs under the per-user lock and refuses to publish
 * against either having moved.
 *
 * THIS IS WHY THE SEQUENCE IS SAFE DESPITE THE SEARCH RUNNING OUTSIDE THE
 * TRANSACTION (§0.5.1). The candidate week was built against a snapshot of the
 * preferences revision and the confirmed targets; between that read and this
 * transaction the user may have saved a preference on another device, or a
 * legacy `PUT /api/user/targets` may have rewritten the numbers. Publishing
 * anyway would present a week built on inputs that no longer exist as a week
 * built on the user's answers. `requireConfirmedTargets` is also what turns that
 * legacy write into `409 targets_unconfirmed` rather than a silently unconfirmed
 * plan.
 */
const requirePinnedInputs = async (
    tx: Prisma.TransactionClient,
    userId: string,
    candidate: CandidateWeek,
): Promise<void> => {
    const row = await loadPreferencesRow(userId, tx);
    const { targetsRevision } = await requireConfirmedTargets(tx, userId);
    const preferencesRevision = row?.revision ?? 0;

    if (preferencesRevision !== candidate.preferencesRevision || targetsRevision !== candidate.targetsRevision) {
        throw new StaleRevisionError({ preferencesRevision, targetsRevision });
    }
};

/** What one publication writes beyond the searched week itself. */
interface PlanPublication {
    readonly userId: string;
    readonly candidate: CandidateWeek;
    readonly idempotencyKey: string;
    /** The plan this one replaces, on a regeneration; null on a first publication. */
    readonly replacedPlanId: string | null;
    readonly now: Date;
}

/**
 * Inserts the plan, its seven days and their meals, and returns the new plan id.
 *
 * Every child row carries BOTH `meal_plan_id`/`meal_plan_day_id` AND `user_id`:
 * those pairs are the referencing side of the tenant foreign keys the schema
 * declares, so a day, meal or grocery row is structurally unable to belong to a
 * plan of a different user (§5.1).
 *
 * `generation_key` stores the idempotency key. That column — unique per
 * `(user_id, generation_key)` — is what lets a client recognise its own
 * committed generation after a lost response, and it is a genuine second line of
 * defence behind the ledger rather than a duplicate of it: the ledger replays a
 * response, the key on the plan row identifies the plan.
 *
 * `generation_seed` is stored as text because the column is TEXT while
 * `derivePlanSeed` yields a 32-bit number — the seed is an identifier of a
 * search, not an arithmetic value, and storing its decimal spelling is what lets
 * a week be replayed exactly.
 *
 * The days are inserted one at a time because each day's meals need its
 * generated id; the meals of one day go in as a single `createMany`. That is 14
 * statements for a week, in a fixed order, so two runs of the same publication
 * issue the same statements.
 */
const insertGeneratedPlan = async (
    tx: Prisma.TransactionClient,
    publication: PlanPublication,
): Promise<string> => {
    const { candidate } = publication;

    const plan = await tx.meal_plans.create({
        data: {
            user_id: publication.userId,
            start_date: toStoredDate(candidate.plan.startDate),
            end_date: toStoredDate(candidate.plan.endDate),
            status: ACTIVE_PLAN_STATUS,
            revision: FIRST_PLAN_REVISION,
            generation_attempt: candidate.generationAttempt,
            preferences_revision: candidate.preferencesRevision,
            targets_revision: candidate.targetsRevision,
            targets_snapshot: asJsonValue(candidate.targets),
            generation_seed: String(candidate.plan.seed),
            generation_key: publication.idempotencyKey,
            replaced_plan_id: publication.replacedPlanId,
            published_at: publication.now,
        },
        select: { id: true },
    });

    for (const day of candidate.plan.days) {
        const inserted = await tx.meal_plan_days.create({
            data: {
                meal_plan_id: plan.id,
                user_id: publication.userId,
                date: toStoredDate(day.date),
                day_index: day.dayIndex,
                planned_calories: day.plannedTotals.calories,
                planned_protein_g: day.plannedTotals.protein,
                planned_carbs_g: day.plannedTotals.carbs,
                planned_fat_g: day.plannedTotals.fat,
            },
            select: { id: true },
        });

        await tx.meal_plan_meals.createMany({
            data: day.meals.map((meal) => ({
                meal_plan_day_id: inserted.id,
                meal_plan_id: plan.id,
                user_id: publication.userId,
                slot: meal.slot,
                slot_time: meal.slotTime,
                sort_order: meal.sortOrder,
                recipe_version_id: meal.recipeVersionId,
                portion_multiplier: meal.portionMultiplier,
                planned_calories: meal.planned.calories,
                planned_protein_g: meal.planned.protein,
                planned_carbs_g: meal.planned.carbs,
                planned_fat_g: meal.planned.fat,
            })),
        });
    }

    return plan.id;
};

/**
 * Writes the new plan's shopping list, carrying check state over from the plan
 * it replaces when there is one.
 *
 * The drafts are built from the meals as STORED rather than from the searched
 * week in memory: the list has to describe the rows the user will actually read,
 * and reading them back is what guarantees the two agree. `carryOverFrom` is the
 * old plan's stored rows, which is the only place a regeneration's check state
 * can come from — the new plan has no rows of its own yet (§0.5.1, "copies
 * grocery check state for unchanged items").
 */
const writeGroceriesForNewPlan = async (
    tx: Prisma.TransactionClient,
    userId: string,
    planId: string,
    replacedPlanId: string | null,
    now: Date,
): Promise<void> => {
    const meals = await loadPlannedMealsForGroceries(tx, userId, planId);
    const drafts = await buildPlanGroceryDrafts(tx, meals);
    const carryOverFrom =
        replacedPlanId === null ? undefined : await loadStoredGroceryRows(tx, userId, replacedPlanId);

    await writePlanGroceryRows(tx, { userId, planId, drafts, carryOverFrom, now });
};

/**
 * Records that the user has published a week.
 *
 * §0.5.2's "Sets setupStatus to completed on success" for `POST /plans`, and
 * the one column of the preferences row a generation writes.
 *
 * `updateMany` with `{user_id}` rather than `update` by a unique key, so the
 * predicate carries the owner (§5.1); the row necessarily exists, because
 * `requireGeneratableSetup` read it. The write is idempotent — a second week
 * published from an already-completed setup stores the same value — so it needs
 * no branch on the current status.
 */
const markSetupCompleted = async (tx: Prisma.TransactionClient, userId: string): Promise<void> => {
    await tx.meal_plan_preferences.updateMany({
        where: { user_id: userId },
        data: { setup_status: COMPLETED_SETUP_STATUS },
    });
};

/**
 * The published plan as the response body, or the fault of it having vanished.
 *
 * Unreachable: the plan was inserted by the same transaction this reads in.
 * Reported rather than defaulted because the alternative is completing a ledger
 * row with a fabricated body, which every later replay would return verbatim.
 */
const requirePublishedPlan = (response: MealPlanResponse | null, planId: string): MealPlanResponse => {
    if (response === null) {
        throw new MealPlanDataError(
            `Plan ${planId} was inserted by this transaction but could not be read back; refusing to store a ` +
                'response body for a publication whose result is unknown.',
        );
    }

    return response;
};

/**
 * The lifecycle state of a plan this caller has already been shown to own.
 *
 * Unreachable — the state list is read from the same `user_id` scope that just
 * returned the plan row — so the absence is a broken invariant rather than a
 * missing resource, and `PlanNotFoundError` would misreport it as "no such
 * plan" and send the client to refetch something that is there.
 */
const requirePlanState = (state: PlanLifecycleState | undefined, planId: string): PlanLifecycleState => {
    if (state === undefined) {
        throw new MealPlanDataError(
            `Plan ${planId} was read for this user but is absent from their plan list; its lifecycle cannot be ` +
                'judged.',
        );
    }

    return state;
};

/**
 * The plan being regenerated, as both the lifecycle rules and the revision check
 * need it, read under whichever client is passed.
 *
 * `PlanNotFoundError` for a plan that is absent or not the caller's — the same
 * answer either way (§8) — and the lifecycle judgement is
 * `requireWritablePlan`'s: a superseded plan answers `409 plan_not_active` with
 * the id of its replacement, an ended one with `reason: 'ended'`.
 */
const loadRegenerationTarget = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    today: string,
): Promise<{ revision: number; generationAttempt: number; startDate: string }> => {
    const plan = await db.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: { id: true, revision: true, generation_attempt: true, start_date: true },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    const states = await loadPlanLifecycleStates(db, userId);

    requireWritablePlan(
        requirePlanState(
            states.find((candidate) => candidate.id === planId),
            planId,
        ),
        today,
    );

    return {
        revision: plan.revision,
        generationAttempt: plan.generation_attempt,
        startDate: toDayKey(plan.start_date, 'meal_plans.start_date', plan.id),
    };
};

/**
 * `POST /api/meal-planning/plans` — search a week and publish it.
 *
 * Takes `body: unknown` and returns a refusal-or-ok union rather than parsing in
 * the controller, because `parseGeneratePlanRequest` needs a `StartDateWindow`
 * that only a database read can supply: the upper bound is the later of today +
 * 30 days and the day after the active plan's last day, so the picker's own rule
 * and the server's agree. The refusal is the parser's verdict UNCHANGED — one
 * representation of an `invalid_request` from the parser to the controller, the
 * convention `preferences.service.ts` and `targets.service.ts` set.
 *
 * The window's second term is the CURRENT plan's end date: the bound exists to
 * admit the successor week "Plan another week" offers, and an upcoming plan is
 * refused by `requireNonConflictingWeek` regardless of the bound, so widening it
 * for one would only change which error the client sees.
 *
 * On success the ledger's `201` and the stored `MealPlanResponse` come back
 * through `KeyedActionResult`, and a repeated key with the same body replays
 * both verbatim — `runKeyedAction`'s job, which is why nothing here
 * deduplicates. {@link replayCommittedKeyedAction} runs that same gate once
 * before the setup check and the search, so a retry is answered by the ledger
 * rather than by a refusal the first attempt's own success produced (§0.5.1).
 */
export const generatePlan = async (
    userId: string,
    body: unknown,
    now: Date = new Date(),
): Promise<GeneratePlanResult> => {
    // The preferences row is READ here but not yet JUDGED, and the order is
    // §0.5.1's rather than a preference. Two things have to happen before the
    // replay preflight: the row supplies the user's IANA zone, from which
    // `today` and therefore the start-date window follow, and the parse needs
    // that window to produce the payload the fingerprint is built from. Judging
    // the row — `requireGeneratableSetup`, the one mutable-state check this
    // route owns — is deferred until AFTER the preflight, because a client
    // retrying a committed generation whose response was lost must learn that it
    // succeeded even if the setup status, the revisions or the catalog have
    // moved since. A null row reads as "no stored zone", exactly as
    // `plannedMealLog.service.ts` resolves the same value, and is refused by
    // `requireGeneratableSetup` a few lines down.
    const row = await loadPreferencesRow(userId);
    const today = dayKeyInTimeZone(now, row?.time_zone ?? null);
    const { current } = resolveCurrentAndUpcoming(await loadPlanLifecycleStates(prisma, userId), today);
    const parsed = parseGeneratePlanRequest(body, startDateWindow(today, current?.end_date ?? null));

    if (parsed.kind !== 'ok') {
        return parsed;
    }

    const payload: GeneratePlanPayload = parsed.payload;
    const keyedAction: KeyedActionParams<'generate'> = {
        userId,
        actionType: 'generate',
        idempotencyKey: payload.idempotencyKey,
        fingerprint: buildRequestFingerprint('POST', 'generate', { userId }, payload),
    };

    // §0.5.1's replay, before every mutable-state check and before the search.
    // A retry of a committed generation would otherwise be refused by whichever
    // moved first — the setup status the publication itself set to `completed`,
    // the preference or target revision another device bumped, or a search that
    // now reports `no_matching_meals` — and would never reach its stored `201`.
    //
    // ONE RESIDUAL THIS ROUTE CANNOT CLOSE FROM HERE: the fingerprint is built
    // from the PARSED payload, and `parseGeneratePlanRequest` rejects a
    // `startDate` outside the window above, which is derived from the database
    // (today in the user's zone, and the current plan's end date). So a retry
    // whose `startDate` has fallen out of that window between attempts — a
    // midnight crossing in the user's zone — is still answered
    // `invalid_request` instead of replaying, because there is no payload to
    // fingerprint. Closing it needs a window-independent SYNTAX parse in
    // `mealPlan.logic.ts` (another work unit's file at this checkpoint) whose
    // verdict feeds the fingerprint while the window check stays a separate,
    // post-replay judgement. The window only ever widens with a new plan, so the
    // clock is the sole trigger.
    const replayed = await replayCommittedKeyedAction(keyedAction);

    if (replayed !== null) {
        return { kind: 'ok', result: replayed };
    }

    const generatable = requireGeneratableSetup(row);
    const candidate = await searchCandidateWeek(userId, generatable, payload, FIRST_GENERATION_ATTEMPT);

    const result = await prisma.$transaction((tx) =>
        runKeyedAction(
            tx,
            keyedAction,
            async (lockedTx) => {
                await requirePinnedInputs(lockedTx, userId, candidate);
                requireNonConflictingWeek(
                    await loadPlanLifecycleStates(lockedTx, userId),
                    payload.startDate,
                    today,
                    null,
                );

                const planId = await insertGeneratedPlan(lockedTx, {
                    userId,
                    candidate,
                    idempotencyKey: payload.idempotencyKey,
                    replacedPlanId: null,
                    now,
                });

                await writeGroceriesForNewPlan(lockedTx, userId, planId, null, now);
                await markSetupCompleted(lockedTx, userId);

                return {
                    body: requirePublishedPlan(await loadMealPlanResponse(lockedTx, userId, planId), planId),
                    planRevisionAfter: FIRST_PLAN_REVISION,
                    mealPlanId: planId,
                };
            },
        ),
    );

    return { kind: 'ok', result };
};

/**
 * `POST /api/meal-planning/plans/:planId/regenerate` — replace one week with
 * another built from the same dates.
 *
 * Four things differ from a first generation, and each is a rule rather than a
 * detail (§0.5.1):
 *
 *  * THE DATES ARE THE OLD PLAN'S, copied and never recomputed from today.
 *    Recomputing them would let a regeneration move a week while claiming to
 *    rebuild it — which is also why the request carries no start date.
 *  * `requireNonConflictingWeek` EXCLUDES THIS PLAN. A plan always overlaps
 *    itself, so without the exclusion "Regenerate this week" would reject
 *    itself every time; every other conflict is still caught.
 *  * THE OLD PLAN IS SUPERSEDED IN THE SAME TRANSACTION, its revision bumped so
 *    a stale screen holding the previous value is answered `409 stale_plan`
 *    rather than silently mutating a replaced week, and the new plan carries
 *    `replaced_plan_id` so that screen can follow the replacement.
 *  * THE DIARY IS UNTOUCHED. `meal_entries` linked to the old plan's meals are
 *    left entirely alone — logged food stays logged, which is what the
 *    regeneration dialog promises — while the grocery list is written with the
 *    old plan's rows as `carryOverFrom`, so a check mark survives for a line the
 *    new week still needs.
 *
 * `expectedPlanRevision` and the plan's status are compared INSIDE `work`, after
 * the replay gate, so a retry of a committed regeneration replays its stored
 * `201` even though the plan it pinned has since been superseded by that very
 * regeneration. The same two checks also run before the transaction, to fail a
 * genuinely stale client without a five-second search — which is exactly why
 * {@link replayCommittedKeyedAction} runs first: a committed key must be
 * answered by the ledger before a check the key's own success invalidated can
 * refuse it.
 */
export const regeneratePlan = async (
    userId: string,
    planId: string,
    body: unknown,
    now: Date = new Date(),
): Promise<GeneratePlanResult> => {
    const parsed = parseRegeneratePlanRequest({ planId }, body);

    if (parsed.kind !== 'ok') {
        return parsed;
    }

    const payload: RegeneratePlanPayload = parsed.payload;
    const keyedAction: KeyedActionParams<'regenerate'> = {
        userId,
        actionType: 'regenerate',
        idempotencyKey: payload.idempotencyKey,
        fingerprint: buildRequestFingerprint('POST', 'regenerate', { planId }, payload),
    };

    // §0.5.1's replay, BEFORE the state this action itself invalidates is judged.
    // A committed regeneration has superseded the plan `expectedPlanRevision`
    // pins, so without this the retry a client sends after a lost response is
    // answered `409 plan_not_active` by `loadRegenerationTarget` below and can
    // never reach its stored `201`. The fingerprint is computable here because
    // `parseRegeneratePlanRequest` needs no database state — the path id and the
    // body are the whole request. The locked gate further down is unchanged and
    // remains the authority; see `replayCommittedKeyedAction` for why both exist.
    const replayed = await replayCommittedKeyedAction(keyedAction);

    if (replayed !== null) {
        return { kind: 'ok', result: replayed };
    }

    const row = requireGeneratableSetup(await loadPreferencesRow(userId));
    const today = dayKeyInTimeZone(now, row.time_zone);
    const existing = await loadRegenerationTarget(prisma, userId, planId, today);

    if (existing.revision !== payload.expectedPlanRevision) {
        throw new StalePlanError(existing.revision);
    }

    const candidate = await searchCandidateWeek(
        userId,
        row,
        { ...payload, startDate: existing.startDate },
        existing.generationAttempt + 1,
    );

    const result = await prisma.$transaction((tx) =>
        runKeyedAction(
            tx,
            keyedAction,
            async (lockedTx) => {
                // Re-judged under the lock, in §0.5.1's order: status first, then
                // the revision. Both were checked outside the transaction to fail
                // a stale client before a five-second search; these are the
                // authoritative checks, and they run AFTER the replay gate so a
                // retry of a committed regeneration still replays its stored 201
                // even though this very action superseded the plan it pinned.
                const locked = await loadRegenerationTarget(lockedTx, userId, planId, today);

                if (locked.revision !== payload.expectedPlanRevision) {
                    throw new StalePlanError(locked.revision);
                }

                await requirePinnedInputs(lockedTx, userId, candidate);

                const superseded = await lockedTx.meal_plans.updateMany({
                    where: { id: planId, user_id: userId, revision: payload.expectedPlanRevision },
                    data: { status: SUPERSEDED_PLAN_STATUS, revision: { increment: 1 } },
                });

                if (superseded.count !== 1) {
                    // The revision was read one statement ago under the advisory
                    // lock this transaction holds, so nothing can have moved it.
                    // An untyped fault, as `grocery.service.ts` raises for its own
                    // broken invariants: there is no client action for it.
                    throw new MealPlanDataError(
                        `Superseding plan ${planId} at revision ${String(payload.expectedPlanRevision)} wrote ` +
                            `${String(superseded.count)} rows instead of 1. The plan was read under the per-user ` +
                            'lock, so it cannot have moved.',
                    );
                }

                requireNonConflictingWeek(
                    await loadPlanLifecycleStates(lockedTx, userId),
                    existing.startDate,
                    today,
                    planId,
                );

                const newPlanId = await insertGeneratedPlan(lockedTx, {
                    userId,
                    candidate,
                    idempotencyKey: payload.idempotencyKey,
                    replacedPlanId: planId,
                    now,
                });

                // No `setup_status` write here, unlike a first generation:
                // §0.5.2 assigns "sets setupStatus to completed on success" to
                // `POST /plans`, and a plan being regenerated necessarily came
                // from a publication that already set it.
                await writeGroceriesForNewPlan(lockedTx, userId, newPlanId, planId, now);

                return {
                    body: requirePublishedPlan(await loadMealPlanResponse(lockedTx, userId, newPlanId), newPlanId),
                    planRevisionAfter: FIRST_PLAN_REVISION,
                    mealPlanId: newPlanId,
                };
            },
        ),
    );

    return { kind: 'ok', result };
};
