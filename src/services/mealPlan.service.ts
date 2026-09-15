// The I/O half of the weekly meal plan: the five `/meal-planning/plans*` use
// cases — publish a week, replace one, read the current and upcoming weeks,
// read one day, list the meals a preference change made incompatible — and
// nothing else. Those five and the two typed values they answer with are the
// whole export surface (§5, one use case per exported function); every read
// below them is private to this file.
//
// THIS FILE IS IMPORTED BY NO OTHER SERVICE, deliberately. It once exported its
// transaction-scoped loaders so `swap.service.ts` and
// `plannedMealLog.service.ts` could build their meal and day responses from
// them, and that import was the defect: a service the AAP sequences AFTER both
// of them cannot be a dependency of either. The shape those three services
// share now lives in `mealPlan.mapper.ts` and the rules in `mealPlan.logic.ts`,
// so each service issues its own owner-scoped query and hands the rows to the
// same mapper — one DTO shape, no dependency between services. Anything here
// that a second caller needs belongs in the mapper or the logic module, never
// in an export from this file.
//
// Orchestration only (Rule backend-architecture §5). Every DECISION already
// belongs to a neighbour and is delegated to it, because a rule re-decided here
// would be a rule no unit test could reach (§7, §11):
//
//  * `mealPlan.logic.ts` owns the planner and the lifecycle: `generateWeeklyPlan`
//    (the whole search), `planDatesFrom` / `planEndDate` (the week's dates),
//    `resolveSlotSchedule` (the two orders a day has), `derivePlanSeed`,
//    `computeDayTotals`, `requireWritablePlan`, `requireNonConflictingWeek`,
//    `resolveCurrentAndUpcoming`, `startDateWindow`, the request parsers and the
//    start-date window verdict. Nothing below decides whether a week is
//    feasible, whether a plan is writable, or which plan is "this week".
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
//    or reserves a ledger row. It owns the PREFLIGHT form of that sequence too
//    (`replayCommittedKeyedAction`): asking "has this key already committed?"
//    is the same question the gate answers, so one module answers it, and the
//    two generation entry points below ask rather than re-implement.
//  * `utils/featureFlags.ts` owns both server switches, resolved once at import.
//    The only one this file asks about is `MEAL_PLANNING_FAULT` (§0.9.4), and it
//    asks through `mealPlanningFault()` rather than reading the environment
//    (§5), which is also what makes the injected fault inert in production
//    without this service testing `NODE_ENV` itself. The capability gate
//    `MEAL_PLANNING_ENABLED` is the controller's to apply, not a service's.
//
//  * `mealPlan.mapper.ts` owns the plan, day and meal DTOs. Rule
//    backend-architecture §6 promotes a row -> DTO mapper out of its service
//    "once two services need it or it grows past a screenful", and this shape is
//    both: `swap.service.ts` and `plannedMealLog.service.ts` return the same
//    meal and day shapes, and the mapping ran to some four hundred lines. So
//    nothing below spells out a plan DTO key — the `load*Response` functions
//    query rows and hand them over, and the two values the mapper cannot derive
//    (the user's current targets and the summary counts) are read here and
//    passed in. The import graph stays acyclic because the mapper imports no
//    service.
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
//  * NO FIELD VALIDATION OF ITS OWN. `parseGeneratePlanSyntax`,
//    `checkStartDateWindow`, `parseRegeneratePlanRequest`,
//    `parseMealPlanDayPath` and `parseAffectedMealsPath` are pure verdicts in
//    `mealPlan.logic.ts`, and their refusal is RETURNED unchanged rather than
//    thrown — the convention `preferences.service.ts` and `targets.service.ts`
//    already follow, and the reason the generation entry points take
//    `body: unknown`: the generation parse has a second half,
//    `checkStartDateWindow`, whose `StartDateWindow` only a database read can
//    supply, so that half cannot happen in a controller.
//
//    EVERY ENTRY POINT PARSES FIRST, BEFORE ANY `await`: a `:planId` that is
//    not a UUID would otherwise reach a PostgreSQL `uuid` predicate and a
//    `:date` that is not a real calendar day would reach `toStoredDate`'s
//    `new Date(`${dayKey}T00:00:00.000Z`)`, and each would surface as a generic
//    `500` where §0.5.2 promises a `400 invalid_request` naming the field. The
//    two write entry points do it with the SYNTAX half of their parse, which is
//    also what §0.5.1 requires of them: see the generation section on why the
//    stateful half has to wait for the replay gate.
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
    GeneratePlanPayload,
    LoggedPlannedEntry,
    MealPlanDayEnvelopeResponse,
    MealPlanDayResponse,
    MealPlanMacroTotals,
    MealPlanResponse,
    MealPlanSummary,
    MealSchedule,
    MealTimeEntry,
    PlanStatus,
    RegeneratePlanPayload,
} from '../types/mealPlanning';
import { mealPlanningFault } from '../utils/featureFlags';
import { isGroceryRenderingFault } from './grocery.logic';
import {
    buildPlanGroceryDrafts,
    loadPlannedMealsForGroceries,
    loadStoredGroceryRows,
    writePlanGroceryRows,
} from './grocery.service';
import {
    GeneratedPlan,
    ParsedGeneratePlanRequest,
    PlanGenerationPreferences,
    PlanLifecycleState,
    PlanRecipeCandidate,
    checkStartDateWindow,
    generateWeeklyPlan,
    parseAffectedMealsPath,
    parseGeneratePlanSyntax,
    parseMealPlanDayPath,
    parseRegeneratePlanRequest,
    requireNonConflictingWeek,
    requireWritablePlan,
    resolveCurrentAndUpcoming,
    resolveReportedTargets,
    sameMacroTotals,
    startDateWindow,
    toPlanningPreferences,
} from './mealPlan.logic';
import {
    groupLoggedPlannedEntries,
    readMealSlot,
    readStoredFlags,
    readTargetsSnapshot,
    toDayKey,
    toMealPlanDayEnvelopeResponse,
    toMealPlanDayResponse,
    toMealPlanResponse,
    toPlanLifecycleState,
} from './mealPlan.mapper';
import {
    PlanGenerationError,
    PlanNotFoundError,
    PreferencesIncompleteError,
    StalePlanError,
    StaleRevisionError,
    TargetsUnconfirmedError,
} from './mealPlanning.errors';
import { buildRequestFingerprint } from './mealPlanningAction.logic';
import {
    KeyedActionParams,
    KeyedActionResult,
    MealPlanningTransactionClient,
    replayCommittedKeyedAction,
    runKeyedAction,
} from './mealPlanningAction.service';
import { isClockTime } from './preferences.logic';
import { PreferencesRow, dayKeyInTimeZone, loadPreferencesRow, resolveUserToday } from './preferences.service';
import { isMealSlot } from './recipe.logic';
import { getRecipeVersionsForPlanning } from './recipe.service';
import { getTargets, previewConfirmedTargets, requireConfirmedTargets } from './targets.service';

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


/* ---------------------------------------------------------------------------
 * The one untyped fault this file raises
 * ------------------------------------------------------------------------- */

/**
 * A stored column or a write result contradicting an invariant this module
 * depends on: a preferences row whose schedule is not a schedule, a plan this
 * transaction inserted that cannot be read back, a plan absent from its own
 * owner's plan list, or a compare-and-swap under the per-user lock that wrote a
 * row count other than one.
 *
 * Its own class rather than a bare `Error` so the message names the row and the
 * column, and declared HERE rather than in `mealPlanning.errors.ts` on purpose:
 * that module is the closed vocabulary of failures the CLIENT distinguishes and
 * acts on, one class per §0.5.2 machine code, and a class mapping to no code
 * would be dead weight in it. There is no client action for "the plan row this
 * server just wrote is not readable", so it reaches the controller as a 500 —
 * the same arrangement `swap.service.ts::SwapDataError` and
 * `plannedMealLog.service.ts::PlannedMealLogWriteError` document for their own
 * invariant faults.
 *
 * DISTINCT FROM `mealPlan.mapper.ts::MealPlanMappingError`, which is raised
 * while a stored row is being shaped into a response and is named for that job
 * (as `GroceryMappingError` and `RecipeMappingError` are for theirs). This one
 * is raised by orchestration: reads, writes and lifecycle, none of which a
 * mapper performs. Keeping them apart is what stops a mapper from owning the
 * error vocabulary of the service that calls it.
 */
export class MealPlanDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MealPlanDataError';
    }
}

/* ---------------------------------------------------------------------------
 * Stored columns and the two naming worlds
 *
 * The database is snake_case and the wire is camelCase; that translation belongs
 * to `mealPlan.mapper.ts` (Rule backend-architecture §6), which is also where
 * the column readers this module still needs — `toDayKey`, `readStoredFlags`,
 * `readMealSlot`, `readTargetsSnapshot` — are defined and imported from, along
 * with the two response builders (`toMealPlanResponse`,
 * `toMealPlanDayEnvelopeResponse`) that read the status and lifecycle columns
 * themselves. What remains below is what only a WRITE needs: the day key on
 * the way IN to a `@db.Date` column, the JSON cast a Prisma write demands, and
 * the preference narrowings the generator reads. Every `jsonb` column arrives as
 * `unknown` and is READ DEFENSIVELY — never asserted — because a column is data
 * to inspect, not a shape to assume.
 * ------------------------------------------------------------------------- */


/** A `YYYY-MM-DD` day key as the `@db.Date` column stores it: midnight UTC. */
const toStoredDate = (dayKey: string): Date => new Date(`${dayKey}T00:00:00.000Z`);


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


const MEAL_SCHEDULES: Readonly<Record<MealSchedule, true>> = { three: true, three_plus_snack: true };

const asMember = <T extends string>(set: Readonly<Record<T, true>>, value: unknown): T | null =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(set, value) ? (value as T) : null;


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

/** Meals of one day in the order the day is READ: the clock order generation stored. */
const PLAN_MEAL_ORDER: Prisma.meal_plan_mealsOrderByWithRelationInput[] = [{ sort_order: 'asc' }, { id: 'asc' }];

/** One day with its meals, as the plan and day reads return it. */
const PLAN_DAY_INCLUDE = {
    meal_plan_meals: { include: PLAN_MEAL_INCLUDE, orderBy: PLAN_MEAL_ORDER },
} satisfies Prisma.meal_plan_daysInclude;

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
const loadLoggedEntriesForMeals = async (
    db: Prisma.TransactionClient,
    userId: string,
    mealIds: readonly string[],
): Promise<Map<string, LoggedPlannedEntry[]>> => {
    if (mealIds.length === 0) {
        return new Map<string, LoggedPlannedEntry[]>();
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

    return groupLoggedPlannedEntries(entries);
};


/* ---------------------------------------------------------------------------
 * The two composed reads this file's own use cases are built from
 * ------------------------------------------------------------------------- */

/**
 * One day of a plan as the wire shape, or `null` when the plan is not the
 * caller's or the date is not one of its seven.
 *
 * The day's own `{meal_plan_id, user_id}` predicate is the ownership check, and
 * the `(meal_plan_id, date)` unique index is what makes a date address at most
 * one day. A date outside the week matches nothing and is therefore the same
 * `null` an unowned plan gives.
 */
const loadMealPlanDayResponse = async (
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

    return toMealPlanDayResponse(day, day.meal_plan_meals, {
        endDate: toDayKey(day.meal_plans.end_date, 'meal_plans.end_date', day.meal_plans.id),
        loggedByMealId: logged,
    });
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


/**
 * The targets a plan response reports, and whether they have moved since it was
 * built.
 *
 * The result is the user's CURRENT confirmed targets — the same values Account,
 * Progress and the diary show — read through `targets.service.ts::getTargets` so
 * there is one canonical target read in the product. The comparison against the
 * plan's own snapshot is NOT made here: `mealPlan.mapper.ts` derives
 * `targetsStale` from these values and `targets_snapshot`, so the inequality has
 * one definition beside the two fields it explains.
 *
 * WHICH of the two it reports is `mealPlan.logic.ts::resolveReportedTargets`'s
 * rule — the same rule `swap.service.ts` applies, so the day card and the
 * candidate scoring cannot aim at different numbers. This function is the READ
 * around it: one `getTargets` call, and nothing else.
 *
 * A `legacy` source is deliberately NOT treated as incomplete — those four
 * values are what the user's other surfaces show today, so reporting them here
 * (and flagging the difference) is the honest answer, and refusing them is a
 * decision `requireConfirmedTargets` makes on the WRITE path, where a new week
 * is at stake.
 */
const resolvePlanTargets = async (
    db: Prisma.TransactionClient,
    userId: string,
    generationTargets: MealPlanMacroTotals,
): Promise<MealPlanMacroTotals> =>
    resolveReportedTargets(await getTargets(userId, db), generationTargets);

/**
 * A whole plan as the wire shape, or `null` when it is not the caller's.
 *
 * `null` and never a discriminating error: "no such plan" and "not your plan"
 * must be indistinguishable, and the caller decides whether that is a 404 or
 * (for `plans/current`) simply an absent member (§8).
 *
 * THE THREE READS THIS COMPOSES ARE THE THREE A MAPPER CANNOT DO: the plan's
 * own row, its days with their meals, and the diary entries linked to those
 * meals. `mealPlan.mapper.ts::toMealPlanResponse` shapes all of it, including
 * `hasIncompatibilities` and `targetsStale`, so no field is spelled out here.
 *
 * The two values the mapper is HANDED are the two it could not derive: the
 * user's current confirmed targets (a `targets.service.ts` read) and the summary
 * counts (two of the three live in other tables).
 *
 * Days are queried in `date` order and their meals in `sort_order`; the mapper
 * re-establishes both orderings from the rows themselves, so the response's
 * order is a property of the contract rather than of this query.
 */
const loadMealPlanResponse = async (
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

    return toMealPlanResponse(plan, days, {
        targets: await resolvePlanTargets(db, userId, readTargetsSnapshot(plan.targets_snapshot, plan.id)),
        summary: await loadPlanSummary(db, userId, planId),
        loggedByMealId: logged,
    });
};

/* ---------------------------------------------------------------------------
 * Lifecycle state, read for this file's own current/upcoming resolution
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
const loadPlanLifecycleStates = async (
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

    return plans.map(toPlanLifecycleState);
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
 * The two READ entry points' outcomes: the response, or the path parser's
 * refusal verbatim.
 *
 * Both reuse {@link MealPlanRefusal} — declared with the generation entry
 * points below, and by construction `mealPlan.logic.ts`'s one error verdict —
 * because `parseMealPlanDayPath` and `parseAffectedMealsPath` carry exactly the
 * shape `parseGeneratePlanSyntax` does. One refusal type for the module means
 * the controller maps one vocabulary for every `400 invalid_request` this file
 * can produce, and a hand-written second copy would be free to drift from the
 * details the client renders beside its fields.
 */
export type MealPlanDayResult = { kind: 'ok'; envelope: MealPlanDayEnvelopeResponse } | MealPlanRefusal;

/** Either the plan's incompatible meals, or the path parser's refusal verbatim. */
export type AffectedMealsResult = { kind: 'ok'; response: AffectedMealsResponse } | MealPlanRefusal;

/**
 * `GET /api/meal-planning/plans/:planId/days/:date` — one day, with fresh logged
 * state, without refetching the week.
 *
 * THE PATH IS PARSED BEFORE ANY I/O, as the first statement, so no `await` can
 * precede the judgement (§0.5.2: "server-side validation applied before any
 * Prisma or planning work"). This is the route-facing parse boundary — the
 * arrangement `generatePlan`, `regeneratePlan` and `targets.service.ts::saveTargets`
 * already use — and it is what keeps the two malformed inputs this route can
 * receive out of the database: a `planId` that is not a UUID would otherwise
 * reach a PostgreSQL `uuid` predicate, and a malformed `date` would reach
 * `new Date(\`${dayKey}T00:00:00.000Z\`)` inside {@link loadMealPlanDayResponse},
 * each surfacing as a generic 500 where the contract promises a
 * `400 invalid_request` naming the field. The refusal is RETURNED unchanged for
 * the controller to map, never thrown: a field-level failure is data the client
 * renders (§8).
 *
 * READABLE FOR A SUPERSEDED OR ENDED PLAN, deliberately: §0.5.2 declares no
 * `plan_not_active` for this route, because history has to keep working — the
 * diary still shows what was eaten from last week's plan. What the envelope
 * owes the client instead is an honest answer about whether that week may still
 * be WRITTEN to, and `meal_plans.status` is not that answer: §0.5.1 leaves a
 * finished week stored `'active'`, so reporting the column alone told a client
 * it could swap and log into last month's plan, which every write path then
 * refused with `409 plan_not_active {reason: 'ended'}`. The envelope therefore
 * carries `planLifecycle` and `isWritable` beside `planStatus`, built by
 * `mealPlan.mapper.ts::toMealPlanDayEnvelopeResponse` from the writers' own
 * `isPlanEnded` predicate.
 *
 * WHICH IS WHY THIS FUNCTION TAKES A CLOCK. Endedness is a comparison against
 * the caller's calendar day, resolved from the IANA zone their last save stored
 * — the same "today" `getCurrentMealPlan` resolves, never the server's. `now` is
 * a parameter so a test can fix it rather than wait for a week to finish.
 *
 * THE READS ARE ORDERED SO THE REFUSALS STAY CHEAPEST: the owner-scoped plan
 * read comes first, the day second, and the zone lookup only once the answer is
 * certain to be a `200`. A request for someone else's plan therefore still
 * costs exactly one query, and the parse still precedes all three.
 *
 * `PlanNotFoundError` covers a plan that is absent or not the caller's AND a
 * date outside the plan's week — §0.5.2's 404 for this route — because
 * distinguishing them would confirm the existence of a plan the caller has no
 * right to (§8). A WELL-FORMED id or day key that names nothing is therefore
 * still that 404; only a value that could never denote a plan or a calendar day
 * is the returned 400.
 */
export const getMealPlanDay = async (
    userId: string,
    planId: string,
    date: string,
    now: Date = new Date(),
): Promise<MealPlanDayResult> => {
    const parsed = parseMealPlanDayPath({ planId, date });

    if (parsed.kind !== 'ok') {
        return parsed;
    }

    const plan = await prisma.meal_plans.findFirst({
        where: { id: parsed.planId, user_id: userId },
        // `end_date` is what makes the lifecycle answerable: without it the
        // envelope can only repeat the stored status.
        select: { id: true, revision: true, status: true, end_date: true },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    const day = await loadMealPlanDayResponse(prisma, userId, parsed.planId, parsed.date);

    if (day === null) {
        throw new PlanNotFoundError();
    }

    return {
        kind: 'ok',
        envelope: toMealPlanDayEnvelopeResponse(plan, day, await resolveUserToday(userId, now)),
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
 * stored plan does not carry. This function therefore takes NO clock, unlike the
 * day read above: every member of its answer is a stored value, and no calendar
 * day can change which meals carry a flag.
 *
 * `:planId` is parsed as the FIRST statement, for the reason
 * {@link getMealPlanDay} states: a malformed id would otherwise reach the
 * PostgreSQL `uuid` predicate below as a 500 instead of the contract's
 * `400 invalid_request`. A well-formed id that names no plan of this caller's is
 * still `PlanNotFoundError`.
 */
export const getAffectedMeals = async (userId: string, planId: string): Promise<AffectedMealsResult> => {
    const parsed = parseAffectedMealsPath({ planId });

    if (parsed.kind !== 'ok') {
        return parsed;
    }

    const plan = await prisma.meal_plans.findFirst({
        where: { id: parsed.planId, user_id: userId },
        select: { id: true },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    const meals = await prisma.meal_plan_meals.findMany({
        where: { meal_plan_id: parsed.planId, user_id: userId },
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

    return { kind: 'ok', response: { meals: affected } };
};

/* ---------------------------------------------------------------------------
 * Generation and regeneration
 *
 * Both follow §0.5.1's sequence exactly, and the ORDER is the guarantee:
 *
 *   outside the transaction  PARSE (syntax only, no I/O) -> REPLAY PREFLIGHT
 *                            -> read inputs -> judge state -> search in memory
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
 * first. `mealPlanningAction.service.ts::replayCommittedKeyedAction` — the
 * ledger's own gate, asked one turn earlier — is what keeps that ordering from
 * costing a replay: it asks whether this exact key has already committed, in
 * its own two-statement transaction, and EVERY stateful judgement below runs
 * only after it has answered no.
 *
 * NOTHING BEFORE THE PREFLIGHT MAY READ MUTABLE STATE. That is the rule the two
 * entry points are written to, and it is why the only step in front of the
 * preflight is a parse of the request's own SYNTAX: a request's fingerprint has
 * to be computable from the request alone, or a retry can be refused before the
 * ledger is ever consulted. `generatePlan` observes it through the
 * window-independent `parseGeneratePlanSyntax`, whose stateful other half —
 * `checkStartDateWindow`, which needs today in the user's zone — is applied
 * after the preflight, for a new key only.
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
    // The ADVISORY read, named as such: it runs outside any transaction, takes
    // no lock, and exists only to refuse a request that could never publish
    // before the search spends five seconds proving it. `requirePinnedInputs`
    // re-judges the same gate under the per-user advisory lock AND the owning
    // user row's lock, and that is the one a publication rests on.
    const { targets, targetsRevision } = await previewConfirmedTargets(userId, prisma);

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
 *
 * THE TARGETS READ HERE LOCKS THE OWNING USER ROW AND KEEPS IT LOCKED. The
 * legacy writer takes no advisory lock, so the advisory lock alone would leave
 * it free to commit between this check and the insert a few statements later;
 * `requireConfirmedTargets` therefore reads the pair in one statement with
 * `FOR UPDATE OF u`, and that row lock lives until this transaction commits.
 * Everything after this call — including `insertGeneratedPlan`, which writes
 * `targets_snapshot` — runs against a target value that cannot move.
 */
const requirePinnedInputs = async (
    tx: MealPlanningTransactionClient,
    userId: string,
    candidate: CandidateWeek,
): Promise<void> => {
    const row = await loadPreferencesRow(userId, tx);
    const { targets, targetsRevision } = await requireConfirmedTargets(tx, userId);
    const preferencesRevision = row?.revision ?? 0;

    if (preferencesRevision !== candidate.preferencesRevision || targetsRevision !== candidate.targetsRevision) {
        throw new StaleRevisionError({ preferencesRevision, targetsRevision });
    }

    // The invariant the whole lock exists for, asserted rather than argued:
    // what is about to be stored as `targets_snapshot` is what the locked gate
    // just certified as confirmed. It cannot fire — a canonical save moves
    // `targets_revision` and is caught above, and a legacy write makes the
    // source `legacy` inside `requireConfirmedTargets` — so reaching it means
    // one of those two mechanisms has been broken by a later change, and
    // `targets_unconfirmed` is the honest answer: these numbers are no longer
    // ones this feature can attest to.
    if (!sameMacroTotals(targets, candidate.targets)) {
        throw new TargetsUnconfirmedError();
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
 *
 * THE GROCERY DOMAIN'S FAULTS ARE TRANSLATED HERE, and this is the only place
 * they are. `grocery.logic.ts` and `utils/units.ts` raise their own classes —
 * `GroceryDataError` and `UnitConversionError` — which are deliberately absent
 * from `mealPlanning.errors.ts`'s vocabulary, so left alone they reach the
 * controller as an unclassifiable 500 while §0.5.2 promises `502
 * plan_generation_failed` as this endpoint's only 5xx. One wrap covers BOTH
 * publication paths, because a first generation and a regeneration both write
 * their list through this function; wrapping the two call sites instead would be
 * two copies of the rule, one of which would eventually be forgotten.
 *
 * Only what {@link isGroceryRenderingFault} recognises is translated. Everything
 * else propagates untouched — in particular `grocery.service.ts`'s untyped write
 * invariants ("deleted N rows instead of M"), which describe a state no client
 * can act on and are documented as reaching the controller as a 500. The
 * original fault travels on the typed error's `cause` for the server log, and
 * nothing is persisted either way: the transaction this runs in rolls back
 * whole, so the "nothing was published" assurance of `PlanGenerationError`
 * stays true.
 */
const writeGroceriesForNewPlan = async (
    tx: Prisma.TransactionClient,
    userId: string,
    planId: string,
    replacedPlanId: string | null,
    now: Date,
): Promise<void> => {
    try {
        const meals = await loadPlannedMealsForGroceries(tx, userId, planId);
        const drafts = await buildPlanGroceryDrafts(tx, meals);
        const carryOverFrom =
            replacedPlanId === null ? undefined : await loadStoredGroceryRows(tx, userId, replacedPlanId);

        await writePlanGroceryRows(tx, { userId, planId, drafts, carryOverFrom, now });
    } catch (error) {
        if (isGroceryRenderingFault(error)) {
            throw new PlanGenerationError(error);
        }

        throw error;
    }
};

/**
 * Raises the injected generation fault, if one is armed.
 *
 * CALLED FROM EXACTLY ONE POSITION IN EACH ENTRY POINT: after the in-memory
 * search has returned and before `prisma.$transaction` opens (§0.9.4). That
 * position is the whole point of the switch rather than a detail of it. Thrown
 * here, nothing has run: no advisory lock, no `meal_plan_actions` reservation,
 * no plan row, no grocery list. So the property §0.9.2 asserts of the fault —
 * "leaves no action row and no plan … and the retry without the fault commits
 * once" — holds because the fault never reaches the ledger at all, not because
 * a rollback tidied up after it. Armed one statement later, inside the
 * transaction, the same throw would exercise a rollback instead and prove
 * nothing about the pre-transaction path a real generation failure takes.
 *
 * AFTER THE SEARCH, THOUGH, NOT BEFORE IT. Raising it earlier would pre-empt
 * `NoMatchingMealsError` and `StaleRevisionError`, so a developer arming
 * `generation` to reach 10b would instead be hiding whichever refusal the
 * request genuinely deserved — and 10b's copy ("your answers are saved, try
 * again") would be attached to a request that could never have published.
 *
 * ONE FUNCTION FOR BOTH PUBLICATION PATHS, for the reason
 * {@link writeGroceriesForNewPlan} gives for the grocery translation it
 * centralises: §0.9.4 arms this fault for `POST /plans` AND
 * `POST /plans/:planId/regenerate`, and two copies of the check are one copy
 * that eventually stops matching the other. On a regeneration the throw also
 * carries the assurance the 16b dialog makes — the old week is still the
 * user's, because it is superseded inside the transaction this runs in front of.
 *
 * The value comes from the `featureFlags.ts` accessor and never from
 * `process.env` (§5): that module resolves it once at import and forces it to
 * `'off'` under `NODE_ENV=production`, so this branch is unreachable in
 * production by construction rather than by this service remembering to check
 * the environment. `PlanGenerationError` is raised with no `cause`, because the
 * switch IS the reason — there is no underlying fault to carry to the log.
 */
const raiseInjectedGenerationFault = (): void => {
    if (mealPlanningFault() === 'generation') {
        throw new PlanGenerationError();
    }
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
 * THE ORDER OF THE FIRST THREE STEPS IS THE IDEMPOTENCY CONTRACT (§0.5.1).
 *
 *   1. `parseGeneratePlanSyntax` — the request judged against ITSELF, with no
 *      I/O of any kind, so a malformed body is refused before Prisma is touched
 *      (§0.5.2) and, more importantly, so the fingerprint below is computable
 *      from the request alone.
 *   2. `replayCommittedKeyedAction` — the ledger asked whether this exact
 *      request already committed. A retry of a committed generation is answered
 *      here, with its stored `201` and stored body.
 *   3. only then the STATEFUL judgements: the user's zone and today, the
 *      start-date window, the setup gate, the pinned revisions, the search.
 *
 * Every one of those third-step refusals would otherwise pre-empt a replay, and
 * the window is the one that made the ordering unavoidable rather than merely
 * tidy: its lower bound is TODAY in the user's stored zone, so a client that
 * retries a committed generation after its own local midnight sends a `startDate`
 * that has silently fallen behind `window.earliest`. Judged before the replay
 * gate, that retry is answered `400 invalid_request` for a field the first
 * attempt had already accepted, and the plan it published can never be returned
 * to it. `mealPlan.logic.ts` therefore splits the parse in two —
 * `parseGeneratePlanSyntax` for what the request says, `checkStartDateWindow`
 * for what the clock and the user's plans allow — and this function asks them
 * at the two different moments the ledger requires. The window is applied for a
 * NEW key only, which is exactly the request that has not yet been answered.
 *
 * It is not re-derived inside the publication transaction, and deliberately
 * not: the window is an input-range rule about the moment the user asked, and a
 * request that crosses midnight between its window check and its COMMIT must
 * not be refused because the clock moved under it by a second. What the locked
 * transaction re-checks is the write-safety state — `requirePinnedInputs` for
 * the two revisions and the confirmed targets, `requireNonConflictingWeek` for
 * overlap and the single-upcoming rule — which is what could actually make the
 * publication wrong.
 *
 * Takes `body: unknown` and returns a refusal-or-ok union rather than parsing in
 * a controller, because the second half of the parse needs a `StartDateWindow`
 * that only a database read can supply: the upper bound is the later of today +
 * 30 days and the day after the active plan's last day, so the picker's own rule
 * and the server's agree. Both refusals are the pure verdict UNCHANGED — one
 * representation of an `invalid_request` from the logic module to the
 * controller, the convention `preferences.service.ts` and `targets.service.ts`
 * set.
 *
 * The window's second term is the CURRENT plan's end date: the bound exists to
 * admit the successor week "Plan another week" offers, and an upcoming plan is
 * refused by `requireNonConflictingWeek` regardless of the bound, so widening it
 * for one would only change which error the client sees.
 *
 * On success the ledger's `201` and the stored `MealPlanResponse` come back
 * through `KeyedActionResult`, and a repeated key with the same body replays
 * both verbatim — `runKeyedAction`'s job, which is why nothing here
 * deduplicates.
 */
export const generatePlan = async (
    userId: string,
    body: unknown,
    now: Date = new Date(),
): Promise<GeneratePlanResult> => {
    // STEP 1 — the request judged against itself, before any I/O. Nothing in
    // this parse reads the clock or the database, which is what makes the
    // fingerprint below a property of the request rather than of the moment it
    // arrived, and what lets step 2 run first.
    const parsed = parseGeneratePlanSyntax(body);

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

    // STEP 2 — §0.5.1's replay, before EVERY stateful refusal: the start-date
    // window, the setup gate, the pinned revisions and the search. A retry of a
    // committed generation would otherwise be refused by whichever moved first —
    // today's date in the user's zone (the window's own lower bound, which a
    // local midnight moves under a retry), the setup status the publication
    // itself set to `completed`, a revision another device bumped, or a search
    // that now reports `no_matching_meals` — and would never reach its stored
    // `201`. The gate inside the publication transaction below is unchanged and
    // remains the authority; `replayCommittedKeyedAction` documents why both
    // exist.
    const replayed = await replayCommittedKeyedAction(keyedAction);

    if (replayed !== null) {
        return { kind: 'ok', result: replayed };
    }

    // STEP 3 — the stateful judgements, for a key that has never committed.
    //
    // The preferences row is read first because it supplies the user's IANA
    // zone, from which `today` and therefore the start-date window follow. A
    // null row reads as "no stored zone", exactly as
    // `plannedMealLog.service.ts` resolves the same value, and is refused by
    // `requireGeneratableSetup` two statements down — the row is READ here and
    // JUDGED after the window, so a client sees the field error it can act on
    // rather than a setup error about a request it never got to send.
    const row = await loadPreferencesRow(userId);
    const today = dayKeyInTimeZone(now, row?.time_zone ?? null);
    const { current } = resolveCurrentAndUpcoming(await loadPlanLifecycleStates(prisma, userId), today);
    const windowVerdict = checkStartDateWindow(
        payload.startDate,
        startDateWindow(today, current?.end_date ?? null),
    );

    if (windowVerdict.kind !== 'ok') {
        return windowVerdict;
    }

    const generatable = requireGeneratableSetup(row);
    const candidate = await searchCandidateWeek(userId, generatable, payload, FIRST_GENERATION_ATTEMPT);

    raiseInjectedGenerationFault();

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

    raiseInjectedGenerationFault();

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
