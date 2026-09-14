// The I/O half of a meal swap: the three `…/meals/:mealId` swap use cases —
// list what could replace one planned meal, preview one of those replacements,
// and commit it.
//
// ONE RULE SET, THREE ENTRY POINTS, and that is the whole design (Agent Action
// Plan §0.7.3). All three functions below build the SAME
// `SwapSelectionContext` through {@link loadSwapContext} and reach their
// candidate through `swap.logic.ts::selectSwapCandidates` /
// `selectSwapCandidate`. Nothing here decides which recipes fit a slot, at what
// portion, or in what order; three independent implementations of that is how a
// preview eventually shows a portion the commit refuses — or, worse, how a
// commit writes a meal the list would never have offered.
//
// WHAT THE THREE DO NOT SHARE IS WRITE ELIGIBILITY. `loadSwapContext` resolves
// the caller's OWN plan and meal and builds the selection; whether the plan may
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
//    the LISTED rows (§0.7.3) — the preview binding (`requireBoundPortion`) and
//    the columns a commit writes (`swapMealWrite`).
//  * `mealPlan.service.ts` owns the plan: its lifecycle states, its targets,
//    its meal and day DTOs, its portion-text rendering and the grocery
//    projection of its meals. This module never maps a plan row itself, which
//    is what keeps one meal shape and one day shape in the codebase.
//  * `mealPlan.logic.ts` owns `requireWritablePlan` — a superseded or ended plan
//    cannot be COMMITTED to, which is why only {@link commitSwap} applies it —
//    and `computeDayTotals`, whose output a commit stores.
//  * `grocery.service.ts` owns the list: `rebuildPlanGroceries` diffs the week
//    against what is stored and reports what changed.
//  * `recipe.service.ts` owns every recipe read, including the plannable
//    candidate set and the preview's full recipe detail.
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
//    reach Prisma through {@link loadSwapContext}, nor a malformed portion
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
//  * NO FLAG EVALUATION. The commit DOES write `meal_plan_meals.flags` — it
//    writes the empty value `swapMealWrite` decides, because §0.7.3 has a swap
//    to a compatible recipe clear that meal's flags, and the candidate's
//    compatibility was established by the selection itself. Nothing here reads
//    a preference to reach that value; recomputing flags from preferences is
//    `preferences.service.ts`'s, and stays one implementation.

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    MealPlanDayResponse,
    MealPlanMealResponse,
    SwapAlternativesResponse,
    SwapMealPayload,
    SwapPreviewResponse,
} from '../types/mealPlanning';
import { MealSlot } from '../types/recipe';
import { rebuildPlanGroceries } from './grocery.service';
import { PlanLifecycleState, requireWritablePlan } from './mealPlan.logic';
import { formatPortionText } from './mealPlan.mapper';
import {
    loadMealPlanDayResponse,
    loadMealPlanMealResponse,
    loadPlanLifecycleStates,
    loadPlanTargets,
    loadPlannedMealsForGroceries,
    toPlanningPreferences,
} from './mealPlan.service';
import { PlanNotFoundError, RecipeIneligibleError, StalePlanError } from './mealPlanning.errors';
import { buildRequestFingerprint } from './mealPlanningAction.logic';
import { KeyedActionResult, runKeyedAction } from './mealPlanningAction.service';
import { dayKeyInTimeZone, loadPreferencesRow } from './preferences.service';
import { isMealSlot, roundNutritionForDisplay } from './recipe.logic';
import { RecipeVersionRow, mapSwapAlternative } from './recipe.mapper';
import { getRecipeVersionDetail, getRecipeVersionsForPlanning } from './recipe.service';
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
    swapMealWrite,
} from './swap.logic';

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
 * The plan's lifecycle state, with its replacement resolved — the input
 * `requireWritablePlan` judges, and read by the COMMIT alone.
 *
 * Read through `mealPlan.service.ts::loadPlanLifecycleStates` rather than with a
 * query of its own, so the "newest successor wins" resolution has one
 * implementation: a plan replaced and then replaced again must send a stale
 * screen to the current week rather than to an intermediate one, and that is a
 * decision, not a join.
 */
const loadSwapPlanState = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
): Promise<PlanLifecycleState> => {
    const state = (await loadPlanLifecycleStates(db, userId)).find((plan) => plan.id === planId);

    if (state === undefined) {
        throw new PlanNotFoundError();
    }

    return state;
};

/** The user's own calendar day, from the zone their last save stored. */
const resolveToday = async (userId: string, now: Date, db: Prisma.TransactionClient): Promise<string> =>
    dayKeyInTimeZone(now, (await loadPreferencesRow(userId, db))?.time_zone ?? null);

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
 * Resolves one swap request into the context the rules read, or throws the
 * answer the client gets.
 *
 * OWNER-SCOPED READ RESOLUTION ONLY — it establishes WHOSE plan and meal these
 * are and what the rules must be applied to, and it says nothing about whether
 * the plan may still be written to. That division is the contract §0.5.2 states
 * in its endpoint rows: the alternatives list and the preview answer `200` (the
 * preview also `422 recipe_ineligible`) and neither lists `plan_not_active`,
 * which appears only on the mutation routes, because §0.5.1 keeps reads
 * available for history — an owned plan that has been superseded or has ended is
 * a legitimate thing to look at, and a user opening last week's plan is entitled
 * to see what could have replaced a meal without being told the plan is gone.
 * Write eligibility is therefore `commitSwap`'s and `commitSwap`'s alone; a read
 * path cannot become writable by sharing this loader, because this loader grants
 * nothing.
 *
 * The order here is the contract:
 *
 *  1. THE PLAN, by `{id, user_id}`. A miss is `PlanNotFoundError` — "no such
 *     plan" and "not your plan" are one answer (§8), so a foreign or invented id
 *     is a `404` on every one of the three routes and existence never leaks.
 *  2. THE MEAL, matched on `{id, meal_plan_id, user_id}` — the plan's own
 *     owner-scoped meal set, filtered by id, so the predicate is the same one a
 *     direct lookup would use without a second round trip (§5.1). An absent id
 *     is again `PlanNotFoundError`, so a caller cannot probe another user's meal
 *     ids.
 *  3. THE SELECTION CONTEXT: the day's meals INCLUDING the one being replaced
 *     (its nutrition has to be replaced, not added to), every meal of the week
 *     for the spacing rule, the plannable catalog, the user's eligibility
 *     preferences, and the plan's targets.
 *
 * `db` is a parameter rather than the global client because the commit builds
 * this context INSIDE its transaction, under the lock: a context read outside
 * would be judged against state the write could no longer rely on.
 */
const loadSwapContext = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    mealId: string,
): Promise<SwapContext> => {
    const plan = await db.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: { id: true, revision: true },
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    const rows = await db.meal_plan_meals.findMany({
        where: { meal_plan_id: planId, user_id: userId },
        select: SWAP_MEAL_SELECT,
        orderBy: SWAP_MEAL_ORDER,
    });

    const current = rows.find((row) => row.id === mealId);

    if (current === undefined) {
        throw new PlanNotFoundError();
    }

    const dayRows = rows.filter((row) => row.meal_plan_day_id === current.meal_plan_day_id);
    const date = toSwapDayKey(current.meal_plan_days.date, current.id);

    // Sequential rather than concurrent: `db` may be an interactive transaction
    // client, which is one connection.
    const targets = await loadPlanTargets(db, userId, planId);
    const preferences = toPlanningPreferences(await loadPreferencesRow(userId, db));
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
 * The recipe version rows behind a set of candidates, keyed by version id.
 *
 * Read WHOLE rather than projected: `recipe.mapper.ts::RecipeVersionRow` needs
 * twenty-four of this table's columns, so an explicit select would restate the
 * table with one more way to fall behind it. At most eight rows are ever asked
 * for, because the list is truncated before this runs.
 *
 * NO TENANT PREDICATE, and this is the sanctioned §5.1 exception
 * `recipe.service.ts` and `catalog.service.ts` both document: `recipe_versions`
 * holds no `user_id` at all — recipes are shared reference data — so there is no
 * owner to scope to. The ids arrive from a selection run against the caller's
 * own plan, so nothing here can be turned into a probe.
 */
const loadCandidateVersions = async (
    db: Prisma.TransactionClient,
    candidates: readonly SwapCandidate[],
): Promise<Map<string, RecipeVersionRow>> => {
    if (candidates.length === 0) {
        return new Map();
    }

    const versions = await db.recipe_versions.findMany({
        where: { id: { in: [...new Set(candidates.map((candidate) => candidate.recipe.recipe_version_id))] } },
    });

    return new Map(versions.map((version) => [version.id, version]));
};

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
    const meal = await loadMealPlanMealResponse(db, userId, planId, mealId);

    if (meal === null) {
        throw new SwapDataError(
            `Planned meal ${mealId} of plan ${planId} could not be read back after being resolved for a swap.`,
        );
    }

    return meal;
};

/** The day DTO, absent for the same impossible reason as the meal above. */
const requireDayResponse = async (
    db: Prisma.TransactionClient,
    userId: string,
    planId: string,
    date: string,
): Promise<MealPlanDayResponse> => {
    const day = await loadMealPlanDayResponse(db, userId, planId, date);

    if (day === null) {
        throw new SwapDataError(
            `Day ${date} of plan ${planId} could not be read back after a swap was written to it.`,
        );
    }

    return day;
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
 * meal id is `PlanNotFoundError` from `loadSwapContext`, whatever the plan's
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
 * Every number is reported at FULL PRECISION, matching §0.7.3's rounding
 * contract and `MealPlanDayResponse.plannedTotals`: the client applies
 * `Math.round` for display, so the preview's figures are directly comparable
 * with the day card's, and the integer it shows for this candidate is the same
 * integer the alternatives row showed.
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
 * place. The mobile side applies that formula through the one shared helper
 * both screens call (`mobile/src/utility/RecipeIngredientUtility.ts`).
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
                portionText: formatPortionText(candidate.portionMultiplier),
                nutrition: candidate.nutrition,
            },
            dayTotalsIfSwapped: candidate.dayTotalsIfSwapped,
            targets: context.selection.targets,
            calorieDelta: candidate.calorieDelta,
            planRevision: context.planRevision,
        },
    };
};

/* ---------------------------------------------------------------------------
 * The commit
 * ------------------------------------------------------------------------- */

/**
 * `POST …/meals/:mealId/swap` — replace the meal, in one transaction.
 *
 * The sequence inside `work` is §0.5.1's, and every step is ordered for a
 * reason:
 *
 *  1. WRITE ELIGIBILITY IS ESTABLISHED HERE, AND ONLY HERE.
 *     `requireWritablePlan` is applied in this function rather than in the
 *     shared `loadSwapContext`, because this is the only one of the three swap
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
 *  2. THE CONTEXT IS REBUILT UNDER THE LOCK. `loadSwapContext` re-reads the
 *     plan, the meal and the selection from the state this transaction will
 *     commit in, so nothing the preview saw is trusted. `expectedPlanRevision`
 *     is compared next — `409 stale_plan` carrying the current value, so the
 *     client refetches at a revision that exists.
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
 *     meal's next revision.
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
 * `400 invalid_request`. Nothing below may run before it. The fingerprint the
 * reservation is keyed against is built from `parsed.payload` — the requirement
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
                const today = await resolveToday(userId, now, lockedTx);

                requireWritablePlan(await loadSwapPlanState(lockedTx, userId, parsed.planId), today);

                const context = await loadSwapContext(lockedTx, userId, parsed.planId, parsed.mealId);

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
                const groceryChangeSummary = await rebuildPlanGroceries(lockedTx, {
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
 * meal_plan_id}` for the meal, `{id, user_id, meal_plan_id}` for the day,
 * `{id, user_id, revision}` for the plan (§5.1, §0.5.1) — and `updateMany` is
 * used rather than `update` precisely so the full predicate can be expressed:
 * `update` needs a unique key and would become an id-only write after a separate
 * ownership read, which is the pattern the rule forbids.
 *
 * Every affected-row count is CHECKED rather than assumed. All three rows were
 * read under the per-user advisory lock this transaction holds, so a count of
 * anything but one means an invariant this module depends on is broken, and
 * reporting a successful swap for a write that did not happen would be worse
 * than failing. The plan's write additionally pins `revision`, so it is a
 * compare-and-swap: even if the lock were somehow not held, a stale commit could
 * not win.
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
        where: { id: context.mealId, user_id: userId, meal_plan_id: context.planId },
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
