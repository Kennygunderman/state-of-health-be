// The I/O half of a meal swap: the three `…/meals/:mealId` swap use cases —
// list what could replace one planned meal, preview one of those replacements,
// and commit it.
//
// ONE RULE SET, THREE ENTRY POINTS, and that is the whole design (Agent Action
// Plan §0.7.3). All three functions below build the SAME
// `SwapSelectionContext` through {@link loadSwapSelection} and reach their
// candidate through `swap.logic.ts::selectSwapCandidates` /
// `selectSwapCandidate`. Nothing here decides which recipes fit a slot, at what
// portion, or in what order; three independent implementations of that is how a
// preview eventually shows a portion the commit refuses — or, worse, how a
// commit writes a meal the list would never have offered.
//
// WHAT THE THREE DO NOT SHARE IS WRITE ELIGIBILITY. `loadSwapSelection` resolves
// the caller's OWN meal and builds the selection; whether the plan may
// still be written to is `commitSwap`'s question alone, because §0.5.2 declares
// `200` for the two GETs and lists `plan_not_active` only on the mutation
// routes, and §0.5.1 keeps reads available for history. A superseded or ended
// plan therefore still lists its alternatives and still previews one; only the
// commit answers `409 plan_not_active`. Ownership is never relaxed by that
// split — a foreign or invented plan or meal id is a `404` on all three.
//
// Orchestration only (Rule backend-architecture §5). Every DECISION belongs to
// a neighbour:
//
//  * `swap.logic.ts` owns the selection: eligibility (delegated in turn to
//    `recipe.logic.ts`), the repetition window with the current meal REMOVED,
//    the portion choice, the ranking, the eight-row truncation — which the
//    preview and the commit inherit, because `selectSwapCandidate` picks one of
//    the LISTED rows (§0.7.3) — the preview binding (`requireBoundPortion`),
//    the columns a commit writes (`swapMealWrite`) and the predicate they are
//    written through (`swapMealWhere`), which are one pair built from one row so
//    the revision the write advances is the revision the write is addressed by.
//  * `mealPlan.mapper.ts` owns the plan's SHAPE: the meal and day DTOs,
//    portion-text rendering, the reading of stored day keys, flags and targets
//    snapshots, the grouping of linked diary entries, and the one display
//    rounding a planned figure gets. This module never maps a plan row itself,
//    which is what keeps one meal shape and one day shape in the codebase —
//    while the READS that fetch those rows are this module's own, owner-scoped
//    as §5.1 requires, because a service does not borrow another service's I/O.
//  * `mealPlan.logic.ts` owns the plan's RULES: `requireWritablePlan` — a
//    superseded or ended plan cannot be COMMITTED to, which is why only
//    {@link commitSwap} applies it — `computeDayTotals`, whose output a commit
//    stores, `toPlanningPreferences`, the one narrowing of a preferences row
//    into the restrictions eligibility is judged by, and
//    `resolveReportedTargets`, which decides whether a week is judged against
//    its snapshot or the user's current confirmed targets.
//  * `grocery.service.ts` owns the list: `loadPlannedMealsForGroceries` is the
//    one projection of a plan's meals into shopping input, and
//    `rebuildPlanGroceries` diffs the week against what is stored and reports
//    what changed.
//  * `recipe.service.ts` owns every recipe read — the plannable candidate set,
//    the preview's full recipe detail, and the whole rows behind the
//    alternatives list. This module issues no `recipe_versions` query of its
//    own.
//  * `targets.service.ts` owns the canonical target read (`getTargets`), which
//    the plan card reads through as well. Each of the three use cases calls it
//    ONCE, where its context is assembled, and threads the value down —
//    `loadCurrentTargets` states why it must stay one statement.
//
// `mealPlan.service.ts` IS DELIBERATELY ABSENT FROM THAT LIST. Nothing here
// imports it: a swap needs the plan's shape, its rules, its grocery projection
// and its targets, and each of those has an owner above that is not the plan's
// own orchestrator. Depending on it would make this module's reads wait on the
// module that generates weeks, and would put a second service between a swap
// and its own database.
//  * `mealPlanningAction.service.ts` owns the keyed-write sequence.
//
// WHY THE COMMIT IS ONE TRANSACTION. §0.5.2's 13e copy promises that a failed
// swap leaves the original meal standing and the grocery list untouched. That
// is only true if the meal write, the day's recomputed totals, the grocery
// reconciliation and the plan's revision bump all commit or all roll back
// together — so they share one interactive transaction, which is also the one
// holding the per-user advisory lock, so a grocery toggle cannot interleave with
// the rebuild.
//
// WHY THE LIST MAY BE EMPTY. A slot with nothing admissible answers `[]`, which
// is the client's 13d "No alternatives fit" state and a truthful answer under
// the user's own restrictions. Padding it with a best-effort candidate would
// trade an honest empty screen for a meal that breaks the day the user just
// approved — `swap.logic.ts` excludes such a recipe rather than offering its
// least-bad portion, and nothing here re-adds it.
//
// WHAT THIS FILE DOES NOT DO, each for a stated reason:
//
//  * NO HTTP. The `200` a commit answers with is the value the pure layer
//    assigned and the ledger persisted; every typed error — `PlanNotFoundError`,
//    `PlanNotActiveError`, `StalePlanError`, `RecipeIneligibleError`,
//    `PreviewStaleError`, `IdempotencyConflictError` — is mapped once, at the
//    controller (§8).
//  * NO REQUEST SHAPE OF ITS OWN — IT PARSES ONE. Each of the three entry
//    points calls its parser from `swap.logic.ts`
//    ({@link parseSwapAlternativesPath}, {@link parseSwapPreviewPath},
//    {@link parseSwapCommitRequest}) as its FIRST statement and returns that
//    parser's verdict UNCHANGED when it refuses, which is the arrangement
//    `mealPlan.service.ts::generatePlan` and `targets.service.ts::saveTargets`
//    already have: the route-facing service function is the parse boundary, the
//    parsers stay pure and testable in the logic module (Rule
//    backend-architecture §4, §0.5.2's "validation applied before any Prisma or
//    planning work"), and the controller still owns every status — it maps a
//    returned refusal to `400 invalid_request` (§8) exactly as it maps
//    `MealPlanRefusal`.
//
//    THE PARSE PRECEDES EVERY `await`, and two separate failures are what
//    makes that position load-bearing rather than tidy. A malformed id must not
//    reach Prisma through {@link loadSwapContext} or
//    {@link loadSwapCommitContext}, nor a malformed portion
//    reach `swap.logic.ts::requireBoundPortion` — which refuses every value
//    that is not the recomputed portion, so `'half'` would be answered
//    `409 preview_stale` ("your preview went stale, re-preview it") for a
//    request that was simply invalid and would fail the same way again. And the
//    commit's idempotency fingerprint is built from the PARSED payload, as
//    `mealPlanningAction.logic.ts::buildRequestFingerprint` requires: it raises
//    a `TypeError` on a magnitude it cannot canonicalise faithfully, which
//    would surface as a `500` for a body the parser had already judged
//    invalid.
//  * NO DEDUPLICATION OF ITS OWN. A double tap or a retry replays the stored
//    `200` through `runKeyedAction`; a second guard here would be a second
//    policy.
//  * NO ENVIRONMENT READS, THOUGH IT DOES CARRY ONE INJECTED FAULT. The commit
//    asks `utils/featureFlags.ts` whether `MEAL_PLANNING_FAULT` names this
//    action and throws `SwapFailedError` before opening its transaction when it
//    does (§0.9.4) — the development switch that makes frame 13e reachable from
//    a device. The accessor resolves the value once at import and forces it to
//    `'off'` in production, so nothing here branches on `process.env` (§5) and
//    the branch cannot fire in production at all.
//  * NO FLAG EVALUATION. The commit DOES write `meal_plan_meals.flags` — it
//    writes the empty value `swapMealWrite` decides, because §0.7.3 has a swap
//    to a compatible recipe clear that meal's flags, and the candidate's
//    compatibility was established by the selection itself. Nothing here reads
//    a preference to reach that value; recomputing flags from preferences is
//    `preferences.service.ts`'s, and stays one implementation.

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    GroceryChangeSummary,
    LoggedPlannedEntry,
    MealPlanDayResponse,
    MealPlanMacroTotals,
    MealPlanMealResponse,
    SwapAlternativesResponse,
    SwapMealPayload,
    SwapPreviewResponse,
    TargetsResponse,
} from '../types/mealPlanning';
import { MealSlot } from '../types/recipe';
import { mealPlanningFault } from '../utils/featureFlags';
import { isGroceryRenderingFault } from './grocery.logic';
import {
    PlanGroceryRebuildParams,
    loadPlannedMealsForGroceries,
    rebuildPlanGroceries,
} from './grocery.service';
import {
    PlanLifecycleState,
    requireWritablePlan,
    resolveReportedTargets,
    toPlanningPreferences,
} from './mealPlan.logic';
import {
    LoggedPlannedEntryRow,
    formatPortionText,
    groupLoggedPlannedEntries,
    readTargetsSnapshot,
    toMealPlanDayResponse,
    toMealPlanMealResponse,
    toPlanLifecycleState,
} from './mealPlan.mapper';
import {
    PlanNotFoundError,
    RecipeIneligibleError,
    StalePlanError,
    SwapFailedError,
} from './mealPlanning.errors';
import { buildRequestFingerprint } from './mealPlanningAction.logic';
import { KeyedActionResult, runKeyedAction } from './mealPlanningAction.service';
import { dayKeyInTimeZone, loadPreferencesRow } from './preferences.service';
import { PlanningPreferences, isMealSlot, roundNutritionForDisplay } from './recipe.logic';
import { RecipeVersionRow, mapSwapAlternative } from './recipe.mapper';
import { getRecipeVersionDetail, getRecipeVersionRowsByIds, getRecipeVersionsForPlanning } from './recipe.service';
import {
    ParsedSwapCommitRequest,
    SwapCandidate,
    SwapDayMeal,
    SwapSelectionContext,
    SwapWeekMeal,
    parseSwapAlternativesPath,
    parseSwapCommitRequest,
    parseSwapPreviewPath,
    requireBoundPortion,
    selectSwapCandidate,
    selectSwapCandidates,
    swapMealWhere,
    swapMealWrite,
} from './swap.logic';
import { getTargets } from './targets.service';

/* ---------------------------------------------------------------------------
 * Row projections
 * ------------------------------------------------------------------------- */

const DAY_KEY_LENGTH = 10;

/**
 * A stored column contradicting what a swap needs to be decidable.
 *
 * Its own class rather than a bare `Error`, and deliberately not a member of
 * `mealPlanning.errors.ts`: that vocabulary is for failures the CLIENT
 * distinguishes and acts on, and there is no client action for "the meal row
 * this server wrote is unreadable". It reaches the controller as a 500, exactly
 * as `grocery.service.ts`'s and `mealPlan.service.ts`'s own invariant faults do.
 */
export class SwapDataError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SwapDataError';
    }
}

/**
 * Everything one selection reads about the plan's meals, in one projection.
 *
 * The whole WEEK is read rather than just the day, because the two collections
 * `SwapSelectionContext` declares have different jobs and both are required:
 * `dayMeals` answers "what does this day total if I swap" (nutrition) and
 * `weekMeals` answers "may this recipe appear here at all" (spacing, across
 * every other day). One query serves both — a week is twenty-one or
 * twenty-eight rows — so the day and the week can never be read at two
 * different instants.
 */
const SWAP_MEAL_SELECT = {
    id: true,
    slot: true,
    recipe_version_id: true,
    portion_multiplier: true,
    planned_calories: true,
    planned_protein_g: true,
    planned_carbs_g: true,
    planned_fat_g: true,
    revision: true,
    meal_plan_day_id: true,
    meal_plan_days: { select: { id: true, date: true } },
    recipe_versions: { select: { recipe_id: true } },
} satisfies Prisma.meal_plan_mealsSelect;

type SwapMealRow = Prisma.meal_plan_mealsGetPayload<{ select: typeof SWAP_MEAL_SELECT }>;

/**
 * Plan-order traversal: day date, then the day's clock order, then id.
 *
 * The repetition window and the day sum both walk these rows, and float
 * addition is not associative — a stable order is what keeps two reads of one
 * plan producing the same totals and the same candidate list.
 */
const SWAP_MEAL_ORDER: Prisma.meal_plan_mealsOrderByWithRelationInput[] = [
    { meal_plan_days: { date: 'asc' } },
    { sort_order: 'asc' },
    { id: 'asc' },
];

/**
 * A stored `@db.Date` as a day key, from its UTC components only — the
 * repository's `toDayKey` convention. Reading local components on a server west
 * of UTC would put a meal on the wrong calendar day and judge the spacing rule
 * against the wrong neighbours.
 */
const toSwapDayKey = (date: Date, mealId: string): string => {
    if (!Number.isFinite(date.getTime())) {
        throw new SwapDataError(`meal_plan_days.date behind meal ${mealId} is not a valid date`);
    }

    return date.toISOString().slice(0, DAY_KEY_LENGTH);
};

/**
 * The stored `slot` column as the slot union, membership decided by
 * `recipe.logic.ts::isMealSlot` so the vocabulary keeps one owner.
 *
 * A fault rather than a default: the slot decides the portion set and the
 * eligibility clause, so judging a lunch under breakfast's rules would offer
 * meals the generator would never have placed. `swap.logic.ts` refuses a context
 * whose slot disagrees with the stored row for the same reason, and this is the
 * narrowing that keeps it from having to.
 */
const readSwapSlot = (row: SwapMealRow): MealSlot => {
    if (!isMealSlot(row.slot)) {
        throw new SwapDataError(`meal_plan_meals.slot on meal ${row.id} is "${row.slot}", which is not a meal slot`);
    }

    return row.slot;
};

/** One stored meal as the day-level shape, at the full precision the columns hold. */
const toSwapDayMeal = (row: SwapMealRow): SwapDayMeal => ({
    id: row.id,
    slot: readSwapSlot(row),
    recipeId: row.recipe_versions.recipe_id,
    recipeVersionId: row.recipe_version_id,
    portionMultiplier: row.portion_multiplier,
    planned: {
        calories: row.planned_calories,
        protein: row.planned_protein_g,
        carbs: row.planned_carbs_g,
        fat: row.planned_fat_g,
    },
    revision: row.revision,
});

/** One stored meal as the week-level shape: the two facts spacing turns on. */
const toSwapWeekMeal = (row: SwapMealRow): SwapWeekMeal => ({
    id: row.id,
    date: toSwapDayKey(row.meal_plan_days.date, row.id),
    recipeId: row.recipe_versions.recipe_id,
});

/** A `@db.Date` day key, matching `mealPlan.service.ts`'s own conversion. */
const toStoredDate = (dayKey: string): Date => new Date(`${dayKey}T00:00:00.000Z`);

/* ---------------------------------------------------------------------------
 * Reading the plan back as the wire shape
 *
 * A swap answers with `MealPlanMealResponse` and `MealPlanDayResponse`, so it
 * reads the meal and the day it just resolved or wrote and hands the rows to
 * `mealPlan.mapper.ts`. THE MAPPING IS SHARED AND THE READS ARE THIS MODULE'S:
 * the DTO shapes, the day-key reading, the logged-entry grouping and the display
 * rounding all live in the mapper, so a swap's day cannot be shaped differently
 * from the same day read through `GET …/days/:date` — while the queries stay
 * here, owner-scoped, as §5.1 requires of every service's own I/O.
 *
 * The projections below are checked against the mapper's row contracts at the
 * call sites: a column omitted here stops `toMealPlanMealResponse` compiling,
 * which is what keeps the three services that perform this read in agreement
 * without any of them borrowing another's function.
 * ------------------------------------------------------------------------- */

/** What the planned-meal DTO needs joined — `mealPlan.mapper.ts::PlanMealWithRecipeRow`. */
const DTO_MEAL_INCLUDE = {
    recipe_versions: true,
    previous_recipe_versions: { select: { id: true, name: true } },
} satisfies Prisma.meal_plan_mealsInclude;

/** Meals of one day in the order the day is READ: the clock order generation stored. */
const DTO_MEAL_ORDER: Prisma.meal_plan_mealsOrderByWithRelationInput[] = [{ sort_order: 'asc' }, { id: 'asc' }];

/** One day with its meals and its plan's end date, which `isLastDay` is derived from. */
const DTO_DAY_INCLUDE = {
    meal_plan_meals: { include: DTO_MEAL_INCLUDE, orderBy: DTO_MEAL_ORDER },
    meal_plans: { select: { id: true, end_date: true } },
} satisfies Prisma.meal_plan_daysInclude;

/** What a linked diary entry must supply — `mealPlan.mapper.ts::LoggedPlannedEntryRow`. */
const LOGGED_ENTRY_SELECT = {
    id: true,
    date: true,
    servings: true,
    logged_at: true,
    meal_plan_meal_id: true,
    recipe_version_id: true,
    meals: { select: { name: true } },
    recipe_versions: { select: { name: true } },
} satisfies Prisma.meal_entriesSelect;

/**
 * The non-deleted diary entries linked to the given planned meals, grouped by
 * meal.
 *
 * The two predicates that make them truthful are this read's responsibility —
 * `deleted_at IS NULL` and the owner's `user_id` — and the grouping, including
 * the dropping of entries a user has since detached by editing, is
 * `mealPlan.mapper.ts::groupLoggedPlannedEntries`'s.
 *
 * No ids means no query: a day with no meals cannot have logged entries.
 */
const loadLoggedEntries = async (
    db: Prisma.TransactionClient,
    userId: string,
    mealIds: readonly string[],
): Promise<Map<string, LoggedPlannedEntry[]>> => {
    if (mealIds.length === 0) {
        return new Map<string, LoggedPlannedEntry[]>();
    }

    const entries: LoggedPlannedEntryRow[] = await db.meal_entries.findMany({
        where: { user_id: userId, deleted_at: null, meal_plan_meal_id: { in: [...new Set(mealIds)] } },
        select: LOGGED_ENTRY_SELECT,
        orderBy: [{ logged_at: 'asc' }, { id: 'asc' }],
    });

    return groupLoggedPlannedEntries(entries);
};

/**
 * A decided value as a JSON column value.
 *
 * The cast is unavoidable and is the same one `preferences.service.ts` and
 * `mealPlanningAction.service.ts` make: Prisma's `InputJsonValue` is a recursive
 * structural type that TypeScript does not accept a declared INTERFACE for —
 * it infers an implicit index signature for a type alias but not for an
 * interface — however JSON-representable every member of it is. `MealFlag` is
 * such an interface, so `swapMealWrite`'s `flags` passes through here. Confined
 * to this one helper so no call site carries a cast of its own.
 */
const asJsonValue = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/* ---------------------------------------------------------------------------
 * The context every selection is made from
 * ------------------------------------------------------------------------- */

/**
 * The caller's current targets, read through the product's canonical target
 * read — AND THE ONLY `getTargets` CALL THIS MODULE MAKES.
 *
 * Each of the three entry points calls it EXACTLY ONCE, at the point its
 * context is assembled ({@link loadSwapContext} for the two reads,
 * {@link loadSwapCommitContext} under the commit's lock), and the value is then
 * threaded to {@link resolveSwapTargets} rather than re-resolved downstream. A
 * second call inside the commit would be a second round trip — and a second
 * `meal_plan_preferences` read — inside an interactive transaction holding one
 * connection and the per-user advisory lock, which is time every other writer of
 * this user's plan spends queued behind it.
 *
 * WHY THIS IS A CALL AND NOT AN INLINE READ, AND WHY THE STATEMENT BEHIND IT
 * MUST STAY ONE STATEMENT. `getTargets` is one `users ⋈ meal_plan_preferences`
 * join (`targets.service.ts::readStoredTargets`), so it does read the
 * preferences row a second time on the commit path — {@link
 * loadSwapCommitContext} has already read it for the time zone and the
 * restrictions. That is deliberate and must not be "optimised" by handing the
 * already-loaded row in and splitting the join into two reads: the verdict
 * `targets.logic.ts::deriveTargetsResponse` reaches is a COMPARISON between
 * `users.target_*` and `meal_plan_preferences.confirmed_targets`, and the legacy
 * `PUT /api/user/targets` route is untouched by this feature and holds NO
 * meal-planning lock (AAP §0.5.1). Two statements are two READ COMMITTED
 * snapshots, so a legacy target write could commit between them and the pair
 * would look self-consistent while the canonical numbers had already moved —
 * `source: 'estimated'` on figures that no longer match, i.e. a week scored and
 * published against stale targets while presenting as confirmed, which is
 * exactly the `legacy` signal §0.5.2 requires the planner to refuse on. One
 * statement is one snapshot, so that reading cannot be assembled. Reconstructing
 * the join's projection here instead would duplicate a schema-coupled read that
 * `targets.service.ts` owns.
 *
 * The transaction's client is passed through, so a commit scores against the
 * targets as they stand inside its own lock.
 */
const loadCurrentTargets = async (db: Prisma.TransactionClient, userId: string): Promise<TargetsResponse> =>
    getTargets(userId, db);

/**
 * The targets this plan is judged against: the caller's current confirmed
 * targets when they are complete, otherwise the snapshot the week was generated
 * from.
 *
 * THE SWAP'S ONE SOURCE FOR THEM, and the same two steps the day card takes —
 * `targets_snapshot` narrowed by `mealPlan.mapper.ts::readTargetsSnapshot`, then
 * reconciled with the confirmed targets by
 * `mealPlan.logic.ts::resolveReportedTargets`. Sharing the RULE rather than the
 * read is what makes it impossible for the alternatives list, the preview and
 * the day card to disagree about what the day is aiming at: a swap that scored
 * against the snapshot while the card showed the current targets would offer a
 * meal that visibly misses the number printed beside it.
 *
 * PURE, AND THAT POSITION IS LOAD-BEARING RATHER THAN TIDY. `current` is the
 * value {@link loadCurrentTargets} already resolved for this request, so no
 * target read happens here; what remains is the snapshot narrowing, which
 * FAULTS (`MealPlanMappingError`, a 500) on a plan whose `targets_snapshot`
 * does not carry four finite macros. Leaving that fault inside
 * {@link loadSwapSelection} — i.e. after `commitSwap`'s `requireWritablePlan` —
 * is what keeps §0.5.1's order intact: a superseded plan carrying a bad
 * snapshot is still answered `409 plan_not_active` rather than a 500 about a
 * column the client cannot act on.
 *
 * The plan row is the one the caller has already read ({@link loadSwapContext}
 * on a read path, {@link loadSwapCommitContext} under the commit's lock) — the
 * column rides along on that statement rather than taking a second round trip
 * for it, which matters inside an interactive transaction holding one
 * connection.
 */
const resolveSwapTargets = (
    current: TargetsResponse,
    plan: { id: string; targets_snapshot: unknown },
): MealPlanMacroTotals => resolveReportedTargets(current, readTargetsSnapshot(plan.targets_snapshot, plan.id));

/** A resolved swap request: the plan, the meal, and the selection context. */
interface SwapContext {
    readonly planId: string;
    readonly planRevision: number;
    readonly mealId: string;
    /** The day key the meal sits on, which is also the day a commit rewrites. */
    readonly date: string;
    readonly selection: SwapSelectionContext;
}

/**
 * The plan columns a selection is computed against, however the caller read
 * them.
 *
 * Structural rather than a Prisma payload type, so both readers below satisfy it
 * with their own projection: the read paths select these three columns, and the
 * commit selects them on the same statement that carries the lifecycle columns.
 */
interface SwapPlanFacts {
    readonly id: string;
    readonly revision: number;
    readonly targets_snapshot: unknown;
}

/**
 * Builds the selection context for one meal of an ALREADY-READ plan, or throws
 * the answer the client gets.
 *
 * THE ONE SELECTION LOADER ALL THREE ENTRY POINTS REACH, which is what makes it
 * impossible for the list, the preview and the commit to judge different facts:
 * they differ only in how the plan, the preferences and the current targets
 * arrived ({@link loadSwapContext} for the two reads,
 * {@link loadSwapCommitContext} under the lock for the commit), never in what a
 * candidate is measured against.
 *
 * THE THREE FACTS ARE HANDED IN, NEVER RE-READ HERE, and the targets are the
 * one that used to be: this function called `getTargets` itself, so a commit
 * resolved them AFTER its own context loader had already read the preferences
 * row — a second `meal_plan_preferences` read inside the transaction holding
 * the per-user advisory lock. Each caller now resolves them ONCE through
 * {@link loadCurrentTargets} and passes the value down, and what is left here is
 * the pure reconciliation with the plan's snapshot
 * ({@link resolveSwapTargets}).
 *
 * OWNER-SCOPED READ RESOLUTION ONLY — it establishes what the rules must be
 * applied to, and it says nothing about whether the plan may still be written
 * to. That division is the contract §0.5.2 states in its endpoint rows: the
 * alternatives list and the preview answer `200` (the preview also
 * `422 recipe_ineligible`) and neither lists `plan_not_active`, which appears
 * only on the mutation routes, because §0.5.1 keeps reads available for
 * history — an owned plan that has been superseded or has ended is a legitimate
 * thing to look at, and a user opening last week's plan is entitled to see what
 * could have replaced a meal without being told the plan is gone. Write
 * eligibility is therefore `commitSwap`'s and `commitSwap`'s alone; a read path
 * cannot become writable by sharing this loader, because this loader grants
 * nothing.
 *
 * The order here is the contract:
 *
 *  1. THE MEAL, matched on `{id, meal_plan_id, user_id}` — the plan's own
 *     owner-scoped meal set, filtered by id, so the predicate is the same one a
 *     direct lookup would use without a second round trip (§5.1). An absent id
 *     is `PlanNotFoundError` — "no such meal" and "not your meal" are one
 *     answer (§8) — so a caller cannot probe another user's meal ids.
 *  2. THE SELECTION CONTEXT: the day's meals INCLUDING the one being replaced
 *     (its nutrition has to be replaced, not added to), every meal of the week
 *     for the spacing rule, the plannable catalog, the user's eligibility
 *     preferences, and the plan's targets.
 *
 * `db` is a parameter rather than the global client because the commit builds
 * this context INSIDE its transaction, under the lock: a context read outside
 * would be judged against state the write could no longer rely on.
 */
const loadSwapSelection = async (
    db: Prisma.TransactionClient,
    userId: string,
    plan: SwapPlanFacts,
    preferences: PlanningPreferences,
    currentTargets: TargetsResponse,
    mealId: string,
): Promise<SwapContext> => {
    const rows = await db.meal_plan_meals.findMany({
        where: { meal_plan_id: plan.id, user_id: userId },
        select: SWAP_MEAL_SELECT,
        orderBy: SWAP_MEAL_ORDER,
    });

    const current = rows.find((row) => row.id === mealId);

    if (current === undefined) {
        throw new PlanNotFoundError();
    }

    const dayRows = rows.filter((row) => row.meal_plan_day_id === current.meal_plan_day_id);
    const date = toSwapDayKey(current.meal_plan_days.date, current.id);

    const targets = resolveSwapTargets(currentTargets, plan);
    const recipes = await getRecipeVersionsForPlanning(db);

    return {
        planId: plan.id,
        planRevision: plan.revision,
        mealId: current.id,
        date,
        selection: {
            mealId: current.id,
            date,
            slot: readSwapSlot(current),
            dayMeals: dayRows.map(toSwapDayMeal),
            weekMeals: rows.map(toSwapWeekMeal),
            targets,
            preferences,
            recipes,
        },
    };
};

/**
 * Resolves one READ's swap request into the context the rules read — the plan,
 * the meal and the selection — or throws the answer the client gets.
 *
 * The loader the alternatives list and the preview share. Both are open to a
 * superseded or ended plan by design (see {@link loadSwapSelection}), so this
 * reads no lifecycle column and asks no calendar question: it issues the plan
 * read, by `{id, user_id}` (a miss is `PlanNotFoundError`, so existence never
 * leaks), the preferences read the eligibility narrowing needs, and the one
 * canonical target read ({@link loadCurrentTargets}) — one statement each, all
 * three resolved here at the entry so nothing below resolves them again. The
 * target statement is itself a `users ⋈ meal_plan_preferences` join, so the
 * preferences row is read inside it a second time; {@link loadCurrentTargets}
 * records why that join must stay one statement. The commit does not use this
 * loader, because it needs the plan row to answer more than this; the reads it
 * does instead are {@link loadSwapCommitContext}'s.
 */
const loadSwapContext = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    mealId: string,
): Promise<SwapContext> => {
    const plan = await db.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: { id: true, revision: true, targets_snapshot: true },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    // Sequential rather than concurrent: `db` may be an interactive transaction
    // client, which is one connection.
    const preferences = toPlanningPreferences(await loadPreferencesRow(userId, db));
    const currentTargets = await loadCurrentTargets(db, userId);

    return loadSwapSelection(db, userId, plan, preferences, currentTargets, mealId);
};

/**
 * What a commit judges and selects from: the plan row, the preferences row and
 * the caller's current targets, each resolved once for the whole commit.
 */
interface SwapCommitContext {
    /**
     * The caller's own calendar day, in the IANA zone their last preference save
     * stored — the value `requireWritablePlan` compares a plan's `end_date`
     * with. `preferences.service.ts::dayKeyInTimeZone` is the ONE definition of
     * it, so a plan cannot be writable on one code path and ended on another.
     */
    readonly today: string;
    /** The lifecycle facts `mealPlan.logic.ts::requireWritablePlan` judges. */
    readonly lifecycle: PlanLifecycleState;
    /** The same plan row's selection columns, for {@link loadSwapSelection}. */
    readonly plan: SwapPlanFacts;
    /** The same preferences row, narrowed to the restrictions eligibility reads. */
    readonly preferences: PlanningPreferences;
    /**
     * The caller's current targets as `targets.service.ts::getTargets` reports
     * them, resolved once here and threaded to {@link loadSwapSelection} —
     * which used to resolve them for itself, a second target resolution inside
     * the lock. {@link resolveSwapTargets} reconciles them with the plan's
     * snapshot.
     */
    readonly currentTargets: TargetsResponse;
}

/**
 * Reads everything a commit is judged on, while the per-user advisory lock is
 * held, in as few statements as the reads can honestly be expressed in.
 *
 * THREE STATEMENTS, AND WHAT EACH IS FOR. A commit needs five things: the
 * plan's lifecycle (to refuse a superseded or ended week), its `revision` (to
 * refuse a stale one) and its `targets_snapshot` (to score candidates), the
 * caller's stored time zone (to know what "today" is) together with their
 * restrictions (to judge eligibility), and the caller's current targets (the
 * other half of the scoring). That is ONE plan read carrying the UNION of the
 * three plan answers, ONE `loadPreferencesRow` carrying both preference
 * answers, and ONE canonical target resolution — because every round trip
 * inside this transaction is time any other writer of this user's plan spends
 * queued behind the same lock, and a read-again for a column already on the
 * wire is lock duration spent for nothing.
 *
 * THE TARGET RESOLUTION READS `meal_plan_preferences` A SECOND TIME, and that
 * is stated here rather than glossed over: `getTargets` is one
 * `users ⋈ meal_plan_preferences` join, so the row this function has already
 * read for the zone and the restrictions is read again inside that join's
 * single snapshot. {@link loadCurrentTargets} records why that join must not be
 * split or fed the row this function holds. What the commit no longer does is
 * resolve the TARGETS twice: the value is resolved once here and threaded
 * through, where it was previously re-resolved inside
 * {@link loadSwapSelection} after this function had already run.
 *
 * IT GATHERS; IT DOES NOT DECIDE — WITH ONE EXCEPTION. The exception is
 * ownership: a plan that is absent or not the caller's is `PlanNotFoundError`
 * here, because the answer is a property of the read itself and must precede
 * every other check (§8 — "no such plan" and "not your plan" are one answer).
 * Everything else is returned as facts for `commitSwap` to judge IN §0.5.1's
 * order, which is what keeps that order in one readable place: the status before
 * the meal and the meal before the revision, so a superseded plan addressed with
 * a meal id it never had is still answered `409 plan_not_active` rather than
 * `404`.
 *
 * THE TARGET RESOLUTION DECIDES NOTHING EITHER, AND CANNOT, which is what makes
 * it safe to perform HERE rather than after the checks: `targets.logic.ts`
 * throws nowhere, so `getTargets` running ahead of `commitSwap`'s
 * `requireWritablePlan` cannot change which refusal a client sees. The one part
 * of target handling that CAN fault — `readTargetsSnapshot`, on a plan whose
 * snapshot does not carry four finite macros — deliberately stays BEHIND that
 * check, inside {@link resolveSwapTargets}, so an unreadable snapshot on a
 * superseded week is still `409 plan_not_active` and not a 500.
 *
 * The two derivations are the shared ones rather than local copies:
 * `mealPlan.mapper.ts::toPlanLifecycleState` reads the `@db.Date` columns into
 * day keys and flattens the newest successor out of the ordered relation take,
 * and `mealPlan.logic.ts::toPlanningPreferences` narrows the five eligibility
 * columns — the same two every other path uses, so "newest successor wins" and
 * "what the user restricts" are decided in one place each.
 */
const loadSwapCommitContext = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    now: Date,
): Promise<SwapCommitContext> => {
    const plan = await db.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: {
            id: true,
            status: true,
            start_date: true,
            end_date: true,
            revision: true,
            targets_snapshot: true,
            replaced_by_plans: {
                where: { user_id: userId },
                orderBy: [{ published_at: 'desc' }, { id: 'desc' }],
                take: 1,
                select: { id: true },
            },
        },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    // Sequential rather than concurrent: `db` is the commit's interactive
    // transaction client, which is one connection.
    const preferences = await loadPreferencesRow(userId, db);
    const currentTargets = await loadCurrentTargets(db, userId);

    return {
        today: dayKeyInTimeZone(now, preferences?.time_zone ?? null),
        lifecycle: toPlanLifecycleState(plan),
        plan,
        preferences: toPlanningPreferences(preferences),
        currentTargets,
    };
};

/**
 * The recipe version rows behind a set of candidates, keyed by version id.
 *
 * THROUGH `recipe.service.ts`, NEVER `db.recipe_versions` DIRECTLY. That file is
 * the single owner of recipe reads — the guarantee its header states and the
 * reason the planner and the planned-log service call in as well — so the
 * projection and the bounds of this read live there and exist once. Querying the
 * table here would be a second projection of the same rows and a second place
 * for it to drift from `recipe.mapper.ts::RecipeVersionRow`, which is the shape
 * `mapSwapAlternative` consumes.
 *
 * At most eight ids are ever asked for, because the list is truncated before
 * this runs. Nothing else about the read is this module's concern, including the
 * §5.1 exception that recipes are shared reference data with no owner column.
 */
const loadCandidateVersions = async (
    db: Prisma.TransactionClient,
    candidates: readonly SwapCandidate[],
): Promise<Map<string, RecipeVersionRow>> =>
    getRecipeVersionRowsByIds(
        candidates.map((candidate) => candidate.recipe.recipe_version_id),
        db,
    );

/**
 * The row behind one candidate, or the fault of it having vanished.
 *
 * The candidate came from the plannable set read a statement ago, and
 * `recipe_versions` rows are never deleted by this feature (a retired version
 * keeps its row so historical plans stay readable), so an absence here is a data
 * fault rather than something to skip: dropping the row would hand the user a
 * shorter list with no explanation.
 */
const requireCandidateVersion = (
    versions: ReadonlyMap<string, RecipeVersionRow>,
    candidate: SwapCandidate,
): RecipeVersionRow => {
    const version = versions.get(candidate.recipe.recipe_version_id);

    if (version === undefined) {
        throw new SwapDataError(
            `Recipe version ${candidate.recipe.recipe_version_id} was selected as a swap candidate but could ` +
                'not be read back; its alternatives row cannot be rendered without it.',
        );
    }

    return version;
};

/**
 * The meal DTO, which cannot be absent on any path that reaches it: the meal was
 * resolved from the plan's own owner-scoped set, and on the commit path it was
 * just written by this transaction. Reported rather than defaulted, because the
 * alternative is completing a ledger row with a fabricated body that every later
 * replay would return verbatim.
 */
const requireMealResponse = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    mealId: string,
): Promise<MealPlanMealResponse> => {
    const meal = await db.meal_plan_meals.findFirst({
        where: { id: mealId, meal_plan_id: planId, user_id: userId },
        include: DTO_MEAL_INCLUDE,
    });

    if (meal === null) {
        throw new SwapDataError(
            `Planned meal ${mealId} of plan ${planId} could not be read back after being resolved for a swap.`,
        );
    }

    const logged = await loadLoggedEntries(db, userId, [meal.id]);

    return toMealPlanMealResponse(meal, meal.recipe_versions, logged.get(meal.id) ?? []);
};

/** The day DTO, absent for the same impossible reason as the meal above. */
const requireDayResponse = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    date: string,
): Promise<MealPlanDayResponse> => {
    const day = await db.meal_plan_days.findFirst({
        where: { meal_plan_id: planId, user_id: userId, date: toStoredDate(date) },
        include: DTO_DAY_INCLUDE,
    });

    if (day === null) {
        throw new SwapDataError(
            `Day ${date} of plan ${planId} could not be read back after a swap was written to it.`,
        );
    }

    const logged = await loadLoggedEntries(
        db,
        userId,
        day.meal_plan_meals.map((meal) => meal.id),
    );

    return toMealPlanDayResponse(day, day.meal_plan_meals, {
        endDate: toSwapDayKey(day.meal_plans.end_date, day.meal_plans.id),
        loggedByMealId: logged,
    });
};

/* ---------------------------------------------------------------------------
 * What the three entry points answer with
 * ------------------------------------------------------------------------- */

/**
 * A malformed request, exactly as `swap.logic.ts`'s parsers report one.
 *
 * DERIVED rather than re-declared, for the reason
 * `mealPlan.service.ts::MealPlanRefusal` states: the logic module does not
 * export its error branch by name, and a hand-written copy would be free to
 * drift from the `message`/`details` pairs the client renders beside its own
 * fields. `ParsedSwapCommitRequest` is the one derived from because the three
 * parsers share ONE error verdict — only their `ok` branches differ — so a
 * single refusal type serves all three routes and the alternatives, preview and
 * commit cannot come to disagree about what an `invalid_request` looks like.
 *
 * RETURNED, never thrown, and carrying no status code: the controller maps it to
 * `400 invalid_request` (§8), while a state conflict stays one of the typed
 * classes in `mealPlanning.errors.ts`. That split is the same one
 * `targets.service.ts` documents, and it is why there is no
 * `InvalidRequestError` to throw.
 */
export type SwapRefusal = Exclude<ParsedSwapCommitRequest, { kind: 'ok' }>;

/** The alternatives list, or the path parser's refusal verbatim. */
export type SwapAlternativesResult = { kind: 'ok'; response: SwapAlternativesResponse } | SwapRefusal;

/** One candidate's preview, or the path parser's refusal verbatim. */
export type SwapPreviewResult = { kind: 'ok'; response: SwapPreviewResponse } | SwapRefusal;

/** The ledger's result for a committed swap, or the request parser's refusal verbatim. */
export type CommitSwapResult = { kind: 'ok'; result: KeyedActionResult } | SwapRefusal;

/* ---------------------------------------------------------------------------
 * The list
 * ------------------------------------------------------------------------- */

/**
 * `GET /api/meal-planning/plans/:planId/meals/:mealId/alternatives` — what could
 * replace this meal.
 *
 * `current` is the meal being replaced, so the sheet can keep it visible while
 * the user chooses; it is never cleared while looking for a replacement, which
 * is why it is part of this response rather than something the client holds.
 *
 * The rows are `selectSwapCandidates`' output in its order, mapped one for one:
 * ranked by the resulting day's proximity to target and then by the PORTABLE
 * identity `(slug, version)`, truncated to eight, PRNG-free so the list does not
 * reshuffle under the user's thumb between two reads of the same plan. An empty
 * array is a real answer (13d) and is passed through untouched.
 *
 * `mapSwapAlternative` takes the candidate's nutrition ALREADY rounded — its own
 * stated contract, because the row renders "540 cal · 38g protein" — so
 * `roundNutritionForDisplay` is applied here and the scaling itself stays
 * `swap.logic.ts`'s.
 *
 * A READ, so the plan's lifecycle is not consulted. §0.5.2 declares `200` for
 * this route and lists `plan_not_active` only on the mutation routes, and
 * §0.5.1 keeps reads available for history: an owned plan that has been
 * superseded or has ended still answers its alternatives, and the write that
 * would follow is the only thing `plan_not_active` refuses (`commitSwap`). The
 * plan does not have to be WRITABLE for the question "what else fits this slot"
 * to have a truthful answer, and a `409` here would break the day the client
 * composes around it. Ownership is still absolute: a foreign or invented plan or
 * meal id is `PlanNotFoundError` from `loadSwapSelection`, whatever the plan's
 * status.
 *
 * BOTH PATH IDS ARE PARSED FIRST, before the read: an id that is not a UUID v4
 * is {@link SwapRefusal} (the controller's `400 invalid_request`) rather than a
 * predicate handed to Prisma, so a route reached with `meals/undefined` says
 * what was wrong with the request instead of answering `404` for a plan that was
 * never named.
 */
export const getSwapAlternatives = async (
    userId: string,
    planId: string,
    mealId: string,
): Promise<SwapAlternativesResult> => {
    const parsed = parseSwapAlternativesPath({ planId, mealId });

    if (parsed.kind !== 'ok') {
        return parsed;
    }

    const context = await loadSwapContext(prisma, userId, parsed.planId, parsed.mealId);
    const candidates = selectSwapCandidates(context.selection);
    const versions = await loadCandidateVersions(prisma, candidates);

    return {
        kind: 'ok',
        response: {
            current: await requireMealResponse(prisma, userId, parsed.planId, parsed.mealId),
            alternatives: candidates.map((candidate) =>
                mapSwapAlternative(
                    requireCandidateVersion(versions, candidate),
                    candidate.portionMultiplier,
                    roundNutritionForDisplay(candidate.nutrition),
                ),
            ),
        },
    };
};

/* ---------------------------------------------------------------------------
 * The preview
 * ------------------------------------------------------------------------- */

/**
 * `GET …/meals/:mealId/alternatives/:recipeVersionId/preview` — one candidate,
 * with the day it would produce.
 *
 * `selectSwapCandidate` is the SAME function the commit calls, which is what
 * makes the two incapable of disagreeing about the portion: it selects from the
 * rows `selectSwapCandidates` produced — the ranked, eight-row list, truncation
 * included — and throws `RecipeIneligibleError` (`422`) for anything else, a
 * recipe outside the listed set included. §0.7.3 asks the preview to compute
 * deltas "for exactly the listed (recipe, portion)", so a dish the sheet never
 * offered is never previewable and never committable, and §0.5.2's row for this
 * endpoint declares precisely those two answers: `200` or
 * `422 recipe_ineligible`.
 *
 * The recipe detail comes from `recipe.service.ts::getRecipeVersionDetail`, the
 * read WITHOUT the visibility rule, and that is correct here rather than
 * convenient: the visibility right was established by the selection itself,
 * which ran against the caller's own plan, and the owner-scoped read would
 * REFUSE this version — a candidate is not yet referenced by any meal or entry
 * of this user, which is exactly the condition that read requires for a
 * non-current version. That callee's own docblock names this call site as the
 * one qualifying caller.
 *
 * EVERY FIGURE IS DISPLAY-ROUNDED, which is what makes the preview's numbers
 * directly comparable with the day card's. §0.7.3 rounds for display once, at
 * the wire boundary, and the client is forbidden from rounding at all, so the
 * three paths that describe this candidate have to round in the same place:
 * `getSwapAlternatives` already rounds each row's meta line,
 * `mealPlan.mapper.ts::readPlannedTotals` rounds the meal and the day, and this
 * envelope rounds its own. A preview reporting 1834.6 beside a day card
 * reporting 1835 would be the same day quoted two ways.
 *
 * ROUNDING STOPS AT THE RESPONSE. The commit stores
 * `candidate.dayTotalsIfSwapped` at full precision (`applySwap`), as generation
 * does, so the stored column and `mealPlan.logic.ts::computeDayTotals` stay
 * exact and the day the user gets is the day they approved to the integer.
 *
 * `calorieDelta` is rounded on its own rather than recomputed from the rounded
 * totals: it is a signed difference the sheet shows as a pill ("−70 cal") and
 * the day's CURRENT total is not on that screen, so there is nothing for a
 * reader to subtract it from. Rounding the difference is therefore the more
 * accurate of the two — it cannot inherit both totals' rounding error.
 *
 * `targets` are not rounded because they are integers already: confirmed
 * targets are whole kilocalories and whole grams by §0.7.3.
 *
 * `nutrition` IS THE PORTION'S; `alternative.recipe.ingredients` ARE THE WHOLE
 * RECIPE'S. That asymmetry is inherent to the envelope rather than an
 * oversight, and it is written down here because a client that misses it draws
 * frame 13b with whole-recipe ingredient amounts beside portion-scaled
 * nutrition. `nutrition` is this candidate AT `portionMultiplier`, already
 * scaled by `recipe.logic.ts::scalePlannedNutrition`, while the recipe is the
 * unmodified `RecipeVersionResponse` — that DTO carries no planned-meal context
 * by design (§0.5.2), so its `quantity`, `gramWeight` and `displayText` are the
 * recipe as published, for `recipe.yieldServings` servings.
 *
 * No second, pre-scaled ingredient collection is sent, because the envelope
 * already carries both factors the client needs — `portionMultiplier` here and
 * `yieldServings` on the recipe — so a portion amount is
 * `quantity × portionMultiplier / yieldServings`, exactly as recipe detail
 * derives its "Your portion" column. Emitting a scaled copy as well would give
 * one number two sources of truth and put a display-rounding rule in a second
 * place. The mobile side applies that formula through the one shared helper both
 * screens call: `mobile/src/utility/ServingsUtility.ts`, whose
 * `plannedPortionFactor` is the `portionMultiplier / yieldServings` above and
 * whose `scaleIngredientsForDisplay` renders each row at that factor.
 *
 * `planRevision` is the revision the preview was computed against; the client
 * sends it back as `expectedPlanRevision` to commit, and a plan that has moved
 * since is answered `409 stale_plan` there.
 *
 * A READ, so the plan's lifecycle is not consulted, for the same reason the
 * alternatives list does not consult it: §0.5.2's row for this endpoint declares
 * `200` or `422 recipe_ineligible` and nothing else, and §0.5.1 keeps reads
 * available for history. Previewing a candidate on a superseded or ended plan is
 * a truthful answer to a truthful question — the numbers describe the day that
 * plan would have had — and the commit that follows is where
 * `409 plan_not_active` belongs, which is also where the client learns to move
 * to the replacement week. Ownership is unaffected: a foreign or invented id is
 * still `PlanNotFoundError`.
 *
 * ALL THREE PATH IDS ARE PARSED FIRST, before the read, and `recipeVersionId`
 * is the one that would otherwise be mislabelled: an unvalidated value reaches
 * `selectSwapCandidate`, which answers `422 recipe_ineligible` — "that meal no
 * longer fits" — for a caller that in fact requested
 * `alternatives/undefined/preview`. Parsed here, it is {@link SwapRefusal} and
 * the controller's `400 invalid_request`.
 */
export const getSwapPreview = async (
    userId: string,
    planId: string,
    mealId: string,
    recipeVersionId: string,
): Promise<SwapPreviewResult> => {
    const parsed = parseSwapPreviewPath({ planId, mealId, recipeVersionId });

    if (parsed.kind !== 'ok') {
        return parsed;
    }

    const context = await loadSwapContext(prisma, userId, parsed.planId, parsed.mealId);
    const candidate = selectSwapCandidate(context.selection, parsed.recipeVersionId);
    const recipe = await getRecipeVersionDetail(candidate.recipe.recipe_version_id, prisma);

    if (recipe === null) {
        // The candidate came from the plannable set read moments ago, so the row
        // disappearing between the two reads means a catalog load retired it
        // mid-request. `recipe_ineligible` is precisely what the client is told
        // in that case — "that meal no longer fits" — so it is the honest answer
        // rather than a 500.
        throw new RecipeIneligibleError();
    }

    return {
        kind: 'ok',
        response: {
            alternative: {
                recipe,
                portionMultiplier: candidate.portionMultiplier,
                portionText: formatPortionText(candidate.portionMultiplier, recipe.servingDescription),
                nutrition: roundNutritionForDisplay(candidate.nutrition),
            },
            dayTotalsIfSwapped: roundNutritionForDisplay(candidate.dayTotalsIfSwapped),
            targets: context.selection.targets,
            calorieDelta: Math.round(candidate.calorieDelta),
            planRevision: context.planRevision,
        },
    };
};

/* ---------------------------------------------------------------------------
 * The commit
 * ------------------------------------------------------------------------- */

/**
 * Step 7's grocery reconciliation, with the grocery domain's faults translated
 * into this endpoint's own refusal.
 *
 * `grocery.logic.ts` and `utils/units.ts` raise their own classes —
 * `GroceryDataError` and `UnitConversionError` — which are deliberately absent
 * from `mealPlanning.errors.ts`'s vocabulary, so left alone they would reach the
 * controller as an unclassifiable 500 while §0.5.2 promises `502 swap_failed` as
 * this endpoint's only 5xx. WORSE THAN THE STATUS CODE: the rebuild runs after
 * the preview has already answered, so the user meets the failure having just
 * been shown a correct preview, and `swap_failed` is precisely the answer 13e is
 * drawn for — "your lunch is unchanged and your grocery list was not updated",
 * which this transaction's rollback makes literally true.
 *
 * Only what {@link isGroceryRenderingFault} recognises is translated; anything
 * else propagates untouched, which is what keeps `grocery.service.ts`'s untyped
 * write invariants ("deleted N rows instead of M") reaching the controller as
 * the 500 they are documented to be. The original fault travels on the typed
 * error's `cause` for the server log.
 */
const rebuildGroceriesOrRefuse = async (
    tx: Prisma.TransactionClient,
    params: PlanGroceryRebuildParams,
): Promise<GroceryChangeSummary> => {
    try {
        return await rebuildPlanGroceries(tx, params);
    } catch (error) {
        if (isGroceryRenderingFault(error)) {
            throw new SwapFailedError(error);
        }

        throw error;
    }
};

/**
 * `POST …/meals/:mealId/swap` — replace the meal, in one transaction.
 *
 * The sequence inside `work` is §0.5.1's, and every step is ordered for a
 * reason:
 *
 *  1. WRITE ELIGIBILITY IS ESTABLISHED HERE, AND ONLY HERE.
 *     `requireWritablePlan` is applied in this function rather than in the
 *     shared `loadSwapSelection`, because this is the only one of the three swap
 *     use cases that writes: a SUPERSEDED plan answers `409 plan_not_active`
 *     with the id of its replacement and an ENDED one with `reason: 'ended'`
 *     (§0.5.1, §0.5.2's row for this endpoint), while the two GETs stay
 *     available for history. It runs inside `work`, so it is under the per-user
 *     lock and AFTER `runKeyedAction`'s replay gate — the position it always
 *     effectively occupied, and the one that lets a retry of an already
 *     committed swap replay its stored `200` even when the plan has since been
 *     superseded by a regeneration. Status is judged BEFORE the revision, in
 *     §0.5.1's order, so a stale screen holding a replaced plan is told where
 *     the current week is instead of being sent to refetch a revision of a plan
 *     it may no longer write to. A plan that is absent or not the caller's is
 *     `PlanNotFoundError` from the same lookup, so ownership still answers
 *     first.
 *
 *     THE FACTS IT JUDGES COME FROM {@link loadSwapCommitContext}, which issues
 *     one plan read, one preferences read and one canonical target resolution,
 *     and decides nothing beyond ownership. The four checks stay in this
 *     function, in this order — plan (404), status (409 `plan_not_active`), meal
 *     (404), revision (409 `stale_plan`) — because the order IS the answer a
 *     client sees: a superseded plan addressed with a meal id it never had must
 *     still be told the week has moved, not that the meal does not exist.
 *  2. THE SELECTION IS REBUILT UNDER THE LOCK. `loadSwapSelection` re-reads the
 *     meal, the week and the plannable catalog from the state this transaction
 *     will commit in — against the plan, preference and target facts step 1
 *     already resolved, none of which it reads again — so nothing the preview
 *     saw is trusted and no context row is resolved twice inside the lock.
 *     `expectedPlanRevision` is compared next — `409 stale_plan` carrying the
 *     current value, so the client refetches at a revision that exists.
 *  3. `selectSwapCandidate` re-selects the named recipe FROM THE LISTED ROWS —
 *     `422 recipe_ineligible` if a preference change or a catalog refresh has
 *     ruled it out since the preview, or if the freshly ranked list no longer
 *     carries it, because a recipe the sheet does not offer is not committable
 *     (§0.7.3).
 *  4. `requireBoundPortion` compares the committed portion with the recomputed
 *     one at two decimals and with no tolerance — `409 preview_stale` when they
 *     differ, because committing anyway would swap in an amount of food the user
 *     never approved.
 *  5. THE MEAL is written from `swapMealWrite`: the new version and portion, the
 *     planned macros at full precision, the outgoing version as
 *     `previous_recipe_version_id`, the injected `now` as `swapped_at`, and the
 *     meal's next revision — through `swapMealWhere`'s predicate, so the
 *     statement carries the owner, the parent plan AND the revision the
 *     selection read (§0.5.1). The meal's own counter is compare-and-swapped
 *     here for the same reason the plan's is at step 8: the two move
 *     independently, so a change that reached THIS row since step 2 is invisible
 *     to the plan's check and would otherwise be overwritten.
 *  6. THE DAY'S `planned_*` are rewritten from the candidate's
 *     `dayTotalsIfSwapped`, which IS `computeDayTotals` over this day with this
 *     candidate substituted in the stored order — the very value the preview
 *     showed — so the stored totals cannot differ from the preview in the last
 *     bits.
 *  7. THE GROCERY LIST is reconciled by `rebuildPlanGroceries` in THIS
 *     transaction, which is what makes "a failed swap never touches groceries"
 *     true rather than merely likely, and what returns the change summary the
 *     confirmation copy renders.
 *  8. `meal_plans.revision` is incremented, as a compare-and-swap on the pinned
 *     value, and the response carries the new number.
 *
 * STEP ZERO IS THE PARSE, and it is outside the transaction because it reads no
 * state: `parseSwapCommitRequest` judges the two path ids and the four body
 * fields together, and its refusal is returned for the controller to answer
 * `400 invalid_request`. Nothing below may run before it — including the
 * injected `MEAL_PLANNING_FAULT=swap` fault, which sits between the parse and
 * the transaction so that a faulted run is a truthful `502 swap_failed` over a
 * valid request while a malformed one is still the `400` it would be with the
 * switch off. The fingerprint the reservation is keyed against is built from
 * `parsed.payload` — the requirement
 * `mealPlanningAction.logic.ts::buildRequestFingerprint` states, because it
 * refuses a magnitude it cannot canonicalise and a raw body would make that a
 * `500` — and `requireBoundPortion` at step 4 must never see an unparsed
 * portion, which it would refuse as `409 preview_stale` and send the client back
 * to re-preview a request that is invalid however often it is retried.
 */
export const commitSwap = async (
    userId: string,
    planId: string,
    mealId: string,
    body: unknown,
    now: Date = new Date(),
): Promise<CommitSwapResult> => {
    const parsed = parseSwapCommitRequest({ planId, mealId }, body);

    if (parsed.kind !== 'ok') {
        return parsed;
    }

    const payload: SwapMealPayload = parsed.payload;

    // THE INJECTED FAULT, AND IT FIRES BEFORE THE TRANSACTION OPENS (§0.9.4).
    //
    // `MEAL_PLANNING_FAULT=swap` is how a developer on a device reaches frame
    // 13e without breaking the backend, and 13e's copy — "your lunch is
    // unchanged and your grocery list was not updated" — is the thing this
    // position keeps true. Thrown here, nothing has run: no advisory lock, no
    // `meal_plan_actions` reservation, no meal write, no grocery
    // reconciliation. That is what §0.9.2 asserts of it (no action row, no meal
    // change, no grocery change, and a retry WITHOUT the fault that commits
    // exactly once) and it holds because the fault never reaches the ledger to
    // be rolled back rather than because a rollback cleaned up after it.
    //
    // AFTER THE PARSE, THOUGH, NOT BEFORE IT. A malformed body is a `400`
    // whether or not a developer has the switch on; answering `502 swap_failed`
    // for a request the parser had already judged invalid would hide the real
    // defect behind the injected one, and 13e's assurance would be attached to
    // a request that was never committable in the first place.
    //
    // The value comes from the `featureFlags.ts` accessor and never from
    // `process.env` (§5): that module resolves it once at import and forces it
    // to `'off'` under `NODE_ENV=production`, so this branch is unreachable in
    // production by construction rather than by this service remembering to
    // check the environment. Only the commit is faulted — the two GETs stay
    // truthful, because the device flow has to reach 13b before there is a
    // commit to fail.
    if (mealPlanningFault() === 'swap') {
        throw new SwapFailedError();
    }

    const result = await prisma.$transaction((tx) =>
        runKeyedAction(
            tx,
            {
                userId,
                actionType: 'swap',
                idempotencyKey: payload.idempotencyKey,
                fingerprint: buildRequestFingerprint(
                    'POST',
                    'swap',
                    { planId: parsed.planId, mealId: parsed.mealId },
                    payload,
                ),
            },
            async (lockedTx) => {
                // One plan read, one preferences read and one target resolution
                // — judged below in §0.5.1's order, which is the order the
                // loader deliberately leaves to this function.
                const commitContext = await loadSwapCommitContext(lockedTx, userId, parsed.planId, now);

                requireWritablePlan(commitContext.lifecycle, commitContext.today);

                const context = await loadSwapSelection(
                    lockedTx,
                    userId,
                    commitContext.plan,
                    commitContext.preferences,
                    commitContext.currentTargets,
                    parsed.mealId,
                );

                if (context.planRevision !== payload.expectedPlanRevision) {
                    throw new StalePlanError(context.planRevision);
                }

                const candidate = selectSwapCandidate(context.selection, payload.recipeVersionId);

                requireBoundPortion(payload.portionMultiplier, candidate.portionMultiplier);

                const planRevisionAfter = await applySwap(lockedTx, {
                    userId,
                    context,
                    candidate,
                    expectedPlanRevision: payload.expectedPlanRevision,
                    now,
                });
                const groceryChangeSummary = await rebuildGroceriesOrRefuse(lockedTx, {
                    userId,
                    planId: parsed.planId,
                    meals: await loadPlannedMealsForGroceries(lockedTx, userId, parsed.planId),
                    now,
                });

                return {
                    body: {
                        meal: await requireMealResponse(lockedTx, userId, parsed.planId, parsed.mealId),
                        day: await requireDayResponse(lockedTx, userId, parsed.planId, context.date),
                        planRevision: planRevisionAfter,
                        groceryChangeSummary,
                    },
                    planRevisionAfter,
                    mealPlanId: parsed.planId,
                    mealPlanMealId: parsed.mealId,
                };
            },
        ),
    );

    return { kind: 'ok', result };
};

/** What one committed swap writes, beyond the grocery reconciliation. */
interface SwapWrite {
    readonly userId: string;
    readonly context: SwapContext;
    readonly candidate: SwapCandidate;
    readonly expectedPlanRevision: number;
    readonly now: Date;
}

/**
 * Writes the meal, its day's totals and the plan's revision, and returns the
 * new plan revision.
 *
 * Each predicate carries the owner key AND the parent chain — `{id, user_id,
 * meal_plan_id, revision}` for the meal (from `swap.logic.ts::swapMealWhere`),
 * `{meal_plan_id, user_id, date}` for the day, `{id, user_id, revision}` for the
 * plan (§5.1, §0.5.1) — and `updateMany` is used rather than `update` precisely
 * so the full predicate can be expressed: `update` needs a unique key and would
 * become an id-only write after a separate ownership read, which is the pattern
 * the rule forbids.
 *
 * TWO OF THE THREE ARE COMPARE-AND-SWAPS, on two counters that move
 * independently. The plan's write pins `revision`, so a stale commit cannot win
 * even if the lock were somehow not held; the meal's write pins ITS OWN
 * `revision`, because a change confined to this row moves no plan counter and
 * the plan's check would pass straight over it. Without that second pin, a write
 * that reached this meal between the context read at step 2 and this statement
 * would be silently overwritten and the commit would report success for a meal
 * it had clobbered — so the meal is addressed by the revision the selection was
 * computed from, and by nothing looser.
 *
 * Every affected-row count is CHECKED rather than assumed. All three rows were
 * read under the per-user advisory lock this transaction holds, so a count of
 * anything but one means either that invariant is broken or a compare-and-swap
 * lost, and reporting a successful swap for a write that did not happen would be
 * worse than failing. The failure is one class — `SwapDataError`, a 500 — and
 * deliberately so: every writer of these rows takes the lock, so there is no
 * legitimate concurrent path for a client to be told to retry, and a swap that
 * cannot write the row it selected is a server fault to surface rather than a
 * conflict to negotiate.
 *
 * THE MEAL'S `flags` COLUMN IS PART OF THAT WRITE, and it is written on every
 * commit rather than only when something was flagged: `swapMealWrite` decides
 * the value (`[]`, §0.7.3 — a swap to a compatible recipe clears that meal's
 * flags) and this is the statement that lands it, because a flag left standing
 * would keep `getAffectedMeals` and `MealPlanResponse.hasIncompatibilities`
 * reporting a meal the selection has just established as compatible. The
 * `flags` member is separated from the rest only to pass it through
 * {@link asJsonValue}; every other column takes its value verbatim.
 */
const applySwap = async (tx: Prisma.TransactionClient, write: SwapWrite): Promise<number> => {
    const { context, candidate, userId } = write;
    const meal = context.selection.dayMeals.find((dayMeal) => dayMeal.id === context.mealId);

    if (meal === undefined) {
        throw new SwapDataError(
            `The day of meal ${context.mealId} no longer contains it; the swap cannot be written against a day ` +
                'it is not part of.',
        );
    }

    const { flags, ...mealColumns } = swapMealWrite(meal, candidate, write.now);

    const written = await tx.meal_plan_meals.updateMany({
        where: swapMealWhere(meal, { userId, planId: context.planId }),
        data: { ...mealColumns, flags: asJsonValue(flags) },
    });

    requireSingleWrite(written.count, `meal_plan_meals row ${context.mealId}`);

    const dayWritten = await tx.meal_plan_days.updateMany({
        where: { meal_plan_id: context.planId, user_id: userId, date: toStoredDate(context.date) },
        data: {
            planned_calories: candidate.dayTotalsIfSwapped.calories,
            planned_protein_g: candidate.dayTotalsIfSwapped.protein,
            planned_carbs_g: candidate.dayTotalsIfSwapped.carbs,
            planned_fat_g: candidate.dayTotalsIfSwapped.fat,
        },
    });

    requireSingleWrite(dayWritten.count, `meal_plan_days row of ${context.planId} on ${context.date}`);

    const planWritten = await tx.meal_plans.updateMany({
        where: { id: context.planId, user_id: userId, revision: write.expectedPlanRevision },
        data: { revision: { increment: 1 } },
    });

    requireSingleWrite(planWritten.count, `meal_plans row ${context.planId}`);

    return write.expectedPlanRevision + 1;
};

/** Every write above touches exactly one row, or the commit is not what it claims. */
const requireSingleWrite = (count: number, subject: string): void => {
    if (count !== 1) {
        throw new SwapDataError(
            `Swapping wrote ${String(count)} rows instead of 1 for ${subject}. It was read under the per-user ` +
                'lock, so it cannot have moved.',
        );
    }
};
