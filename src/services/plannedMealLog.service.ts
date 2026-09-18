// The I/O half of logging a planned meal: ONE use case,
// `POST …/plans/:planId/meals/:mealId/log`, and one keyed write.
//
// Orchestration only (Rule backend-architecture §5). Every decision belongs to a
// neighbour, and the delegation is what makes each of them testable without a
// database (§7, §11):
//
//  * `plannedMealLog.logic.ts` owns the rules: `requireLoggableTarget` (the two
//    independent 404 conditions — the diary bucket must be the caller's and
//    filed under the date being logged, and the date must fall inside the plan's
//    week) and `derivePlannedSnapshot` (what the `meal_entries` row claims the
//    food IS, with each macro rounded exactly once).
//  * `mealPlan.logic.ts` owns `requireWritablePlan`: a superseded or ended plan
//    cannot be logged against.
//  * `mealPlan.mapper.ts` owns the SHAPE of the meal DTO this response carries
//    — `toMealPlanMealResponse`, the grouping of the diary entries its logged
//    state is derived from, and the reading of the plan row the writability
//    rule judges — so the card the client redraws from a log result is the same
//    shape every other plan read produces. The READS are this module's own and
//    owner-scoped (§5.1): a service does not borrow another service's I/O, and
//    nothing here imports `mealPlan.service.ts`.
//  * `nutrition.service.ts::insertPlannedMealEntry` owns the insert, and ONLY
//    the insert: it stores the snapshot's four integers verbatim and refuses a
//    fractional one. The single rounding belongs to `derivePlannedSnapshot`
//    above.
//  * `mealPlanningAction.service.ts` owns the keyed-write sequence.
//
// WHY A DOUBLE TAP IS SAFE, and why nothing here deduplicates. A second serving
// of the same meal is a legitimate, distinct diary entry (`loggedEntries` is a
// LIST for exactly that reason), so "an entry already exists for this meal" can
// never be the test for a repeat. The idempotency key is: a retry with the same
// key and the same body replays the stored `201` verbatim through
// `runKeyedAction`, and the same key with a different body is
// `409 idempotency_conflict`. A guard of our own here would either block the
// deliberate second serving or duplicate a policy that already has one owner.
//
// WHY NOT `logMealEntry`. `nutrition.service.ts::logMealEntry` is the legacy
// hand-logging path and carries a dedupe-by-`food_id` branch that merges a new
// entry into an existing one for the same food. A planned meal has no `food_id`
// at all, and merging is precisely the wrong behaviour for it — the second
// serving must be its own row so the plan card and the diary agree about what
// was eaten. `insertPlannedMealEntry` exists to keep that path unreachable from
// here, and this module is its only caller (AAP §0.5.1).
//
// WHAT THIS FILE DOES NOT DO, each for a stated reason:
//
//  * NO ROUNDING — here or in the writer. The planned portion is computed at
//    full precision by `derivePlannedPortion`, rounded ONCE by
//    `derivePlannedSnapshot`, stored verbatim by `insertPlannedMealEntry`, and
//    the diary then shows `Math.round(snapshot × servings)`. A second rounding
//    anywhere on this path is how the app's "This adds" card and the server's
//    totals come to disagree (§0.7.3's rounding contract), so the one owner is
//    named at every site rather than assumed.
//  * NO `meal_plan_meals.revision` BUMP. No column of the meal row changes — the
//    link lives on the diary entry — so bumping it would invalidate every
//    client's pinned meal revision for a write that did not touch the meal.
//    `meal_plans.revision` IS bumped, because the plan's derived logged state
//    changed and the response carries the new value.
//  * NO FIELD VALIDATION OF ITS OWN. `parseLogPlannedMealCall` is a pure verdict
//    in `plannedMealLog.logic.ts` — the composition of that module's path and
//    body parsers, so the two path ids and the five body fields are answered
//    together — and `logPlannedMeal` CALLS IT as its first statement, before any
//    await, returning its refusal unchanged for the controller to map to
//    `400 invalid_request` (§4's "validation lives at this boundary, but the
//    predicate is pure logic"; §8's "a field-level failure is a value, not a
//    throw"). The parse boundary is the route-facing service entry point rather
//    than the controller, exactly as `mealPlan.service.ts`'s two generation
//    entry points and `targets.service.ts::saveTargets` place it, which is why
//    this function takes `body: unknown`. It also has to be here rather than
//    upstream of it: `buildRequestFingerprint` hashes the PARSED payload
//    (`mealPlanningAction.logic.ts`), so a raw body reaching the reservation
//    below would make a hostile value a 500 from the canonicaliser instead of a
//    400 from the parser.
//  * NO DIARY BUCKET CREATION. The bucket always already exists — the client took
//    `diaryMealId` from `GET /macros/:date`, which backfills the four default
//    buckets on every read — so this path verifies and never creates. A
//    create-if-missing branch here would duplicate buckets and diverge from that
//    backfill.
//  * NO HTTP. The `201` is the value the pure layer assigned and the ledger
//    persisted; `PlanNotFoundError`, `PlanNotActiveError`, `StalePlanError` and
//    `IdempotencyConflictError` are mapped once, at the controller (§8).

import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import { LogPlannedMealPayload, MealPlanMealResponse } from '../types/mealPlanning';
import { requireWritablePlan } from './mealPlan.logic';
import {
    LoggedPlannedEntryRow,
    groupLoggedPlannedEntries,
    toMealPlanMealResponse,
    toPlanLifecycleState,
} from './mealPlan.mapper';
import { PlanNotFoundError, StalePlanError } from './mealPlanning.errors';
import { buildRequestFingerprint } from './mealPlanningAction.logic';
import { KeyedActionResult, runKeyedAction } from './mealPlanningAction.service';
import { insertPlannedMealEntry } from './nutrition.service';
import {
    ParsedLogPlannedMealRequest,
    derivePlannedSnapshot,
    parseLogPlannedMealCall,
    requireLoggableTarget,
} from './plannedMealLog.logic';
import { dayKeyInTimeZone, loadPreferencesRow } from './preferences.service';

/* ---------------------------------------------------------------------------
 * Row projections
 * ------------------------------------------------------------------------- */

/**
 * A stored column contradicting what a log needs to be writable.
 *
 * Its own class rather than a bare `Error`, and deliberately not a member of
 * `mealPlanning.errors.ts`: that vocabulary is for failures the CLIENT
 * distinguishes, and there is no client action for a plan row this server wrote
 * being unreadable. It reaches the controller as a 500, as the sibling services'
 * own invariant faults do.
 */
export class PlannedMealLogWriteError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'PlannedMealLogWriteError';
    }
}

/**
 * The planned meal and the recipe version it holds, in one read.
 *
 * The recipe version is joined rather than fetched separately because
 * `derivePlannedSnapshot` needs the two TOGETHER and refuses a pair that does
 * not match (`recipe_version_id` on the meal against `id` on the version): the
 * row would otherwise carry one recipe's name beside another's macros, and every
 * later derivation — the diary caption, the card's logged state, the history
 * aggregate — would faithfully report the wrong meal. Reading them in one
 * statement makes the mismatch unreachable rather than merely checked.
 */
const PLANNED_MEAL_SELECT = {
    id: true,
    recipe_version_id: true,
    portion_multiplier: true,
    recipe_versions: {
        select: {
            id: true,
            name: true,
            serving_description: true,
            per_serving_calories: true,
            per_serving_protein_g: true,
            per_serving_carbs_g: true,
            per_serving_fat_g: true,
        },
    },
} satisfies Prisma.meal_plan_mealsSelect;

/** The plan facts a log is judged against, with its dates as day keys. */
interface LoggablePlan {
    readonly revision: number;
    readonly startDate: string;
    readonly endDate: string;
}

/**
 * The plan, judged writable, or the answer the client gets.
 *
 * THIS MODULE'S OWN READ, owner-scoped as §5.1 requires, shaped by
 * `mealPlan.mapper.ts::toPlanLifecycleState` and judged by
 * `mealPlan.logic.ts::requireWritablePlan`. Those two are shared and the query
 * is not: the replacement id a superseded plan reports is resolved in one place
 * — "newest successor wins", which sends a stale screen to the current week
 * rather than to an intermediate one — while the statement that fetches it
 * belongs to the service holding the lock.
 *
 * One plan rather than the user's whole list, since the successor comes from the
 * ordered relation take. "Today" is resolved from the user's stored IANA zone
 * INSIDE the transaction, against the same snapshot the write will commit in, so
 * an `end_date` comparison cannot be decided by a preferences row that changed a
 * statement later.
 */
const requireWritablePlanForLog = async (
    tx: Prisma.TransactionClient,
    userId: string,
    planId: string,
    now: Date,
): Promise<LoggablePlan> => {
    const plan = await tx.meal_plans.findFirst({
        where: { id: planId, user_id: userId },
        select: {
            id: true,
            revision: true,
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
    });

    if (plan === null) {
        throw new PlanNotFoundError();
    }

    const today = dayKeyInTimeZone(now, (await loadPreferencesRow(userId, tx))?.time_zone ?? null);
    const writable = requireWritablePlan(toPlanLifecycleState(plan), today);

    return { revision: plan.revision, startDate: writable.start_date, endDate: writable.end_date };
};

/** A `YYYY-MM-DD` day key as the `@db.Date` column stores it: midnight UTC. */
const toStoredDate = (dayKey: string): Date => new Date(`${dayKey}T00:00:00.000Z`);

/**
 * Increments the plan's revision and returns the new value.
 *
 * A compare-and-swap on the pinned revision, with the owner key beside the id
 * (§5.1). The row was read under the per-user advisory lock this transaction
 * holds, so a count of anything but one means an invariant this module depends
 * on is broken — and reporting a revision the database does not hold would send
 * every client refetching at a number that never existed.
 *
 * `meal_plan_meals.revision` is NOT touched: no column of the meal row changes,
 * because the link to the diary lives on the entry. The PLAN's revision moves
 * because its derived logged state did.
 */
const bumpPlanRevision = async (
    tx: Prisma.TransactionClient,
    userId: string,
    planId: string,
    expectedPlanRevision: number,
): Promise<number> => {
    const written = await tx.meal_plans.updateMany({
        where: { id: planId, user_id: userId, revision: expectedPlanRevision },
        data: { revision: { increment: 1 } },
    });

    if (written.count !== 1) {
        throw new PlannedMealLogWriteError(
            `Bumping plan ${planId} from revision ${String(expectedPlanRevision)} wrote ` +
                `${String(written.count)} rows instead of 1. The plan was read under the per-user lock, so it ` +
                'cannot have moved.',
        );
    }

    return expectedPlanRevision + 1;
};

/** What the planned-meal DTO needs joined — `mealPlan.mapper.ts::PlanMealWithRecipeRow`. */
const DTO_MEAL_INCLUDE = {
    recipe_versions: true,
    previous_recipe_versions: { select: { id: true, name: true } },
} satisfies Prisma.meal_plan_mealsInclude;

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
 * The planned meal DTO, which cannot be absent here: the meal was read in this
 * transaction one statement ago. Reported rather than defaulted, because the
 * alternative is completing a ledger row with a fabricated body that every later
 * replay would return verbatim.
 *
 * TWO OWNER-SCOPED READS OF THIS MODULE'S OWN (§5.1), shaped by the shared
 * mapper: `toMealPlanMealResponse` builds the DTO and
 * `groupLoggedPlannedEntries` groups the diary rows the card derives its logged
 * state from — which is what makes the meal this response returns identical to
 * the same meal read through `GET …/days/:date` a moment later. The entry this
 * transaction has just inserted is included, because it is committed to this
 * snapshot and is precisely what the client needs to see.
 *
 * The mapper's row contracts check both projections at the call site, so a
 * column omitted here fails to compile rather than silently shipping a
 * differently-shaped meal.
 */
const requireMealResponse = async (
    tx: Prisma.TransactionClient,
    userId: string,
    planId: string,
    mealId: string,
): Promise<MealPlanMealResponse> => {
    const meal = await tx.meal_plan_meals.findFirst({
        where: { id: mealId, meal_plan_id: planId, user_id: userId },
        include: DTO_MEAL_INCLUDE,
    });

    if (meal === null) {
        throw new PlannedMealLogWriteError(
            `Planned meal ${mealId} of plan ${planId} could not be read back after an entry was logged against it.`,
        );
    }

    const entries: LoggedPlannedEntryRow[] = await tx.meal_entries.findMany({
        where: { user_id: userId, deleted_at: null, meal_plan_meal_id: meal.id },
        select: LOGGED_ENTRY_SELECT,
        orderBy: [{ logged_at: 'asc' }, { id: 'asc' }],
    });

    return toMealPlanMealResponse(meal, meal.recipe_versions, groupLoggedPlannedEntries(entries).get(meal.id) ?? []);
};

/* ---------------------------------------------------------------------------
 * The one use case
 * ------------------------------------------------------------------------- */

/**
 * The refusal half of this route — `parseLogPlannedMealCall`'s verdict,
 * unchanged.
 *
 * Derived from `ParsedLogPlannedMealRequest` rather than re-declared, so it is
 * the same shape `plannedMealLog.logic.ts` produces by construction (both of
 * that module's parsers and their composition carry one verdict type). A
 * hand-written copy would be free to drift from the `details` the client
 * renders beside its fields, which is the reason `mealPlan.service.ts` derives
 * its own `MealPlanRefusal` the same way.
 */
export type LogPlannedMealRefusal = Exclude<ParsedLogPlannedMealRequest, { kind: 'ok' }>;

/** Either the ledger's result for a logged meal, or the parser's refusal verbatim. */
export type LogPlannedMealResult = { kind: 'ok'; result: KeyedActionResult } | LogPlannedMealRefusal;

/**
 * `POST /api/meal-planning/plans/:planId/meals/:mealId/log` — record that a
 * planned meal was eaten.
 *
 * THE REQUEST IS PARSED FIRST, before any await, and that ordering is a rule
 * rather than a style: this is a WRITE, so an unvalidated value would reach the
 * advisory lock, the ledger reservation and `buildRequestFingerprint` — which
 * hashes the PARSED payload and rightly refuses a magnitude it cannot represent
 * faithfully, turning a malformed request into a 500 where §0.5.2 promises a
 * `400 invalid_request` naming the field. Both path ids and the body are judged
 * in one verdict by `parseLogPlannedMealCall`, so a request with a malformed
 * `planId` and three bad body fields reports all four at once, and the refusal
 * is RETURNED unchanged for the controller to map (§8). Every other failure on
 * this path stays a THROWN typed error — `PlanNotFoundError`,
 * `StalePlanError`, `IdempotencyConflictError` — because those are states of
 * the stored data rather than faults in the request.
 *
 * ONE TRANSACTION, and the sequence inside `work` is §0.5.1's, in this order for
 * stated reasons:
 *
 *  1. THE PLAN, by `{id, user_id}` — a miss is `PlanNotFoundError`, because "no
 *     such plan" and "not your plan" are one answer (§8) — then
 *     `requireWritablePlan`, so a superseded plan answers `409 plan_not_active`
 *     with its replacement's id and an ended one with `reason: 'ended'`.
 *  2. `expectedPlanRevision` against the stored revision — `409 stale_plan`
 *     carrying the current value. Both of these run AFTER `runKeyedAction`'s
 *     replay gate, which is what lets a client whose response was lost learn
 *     that its own log succeeded even though the plan has since moved on; check
 *     the revision first and such a client is answered `409 stale_plan` forever,
 *     retrying something already done.
 *  3. THE MEAL, in one owner-bearing predicate `{id, meal_plan_id, user_id}`
 *     (§5.1), joined to its recipe version.
 *  4. THE DIARY BUCKET, by `{id, user_id}`, then `requireLoggableTarget` — which
 *     answers `PlanNotFoundError` for a bucket that is not the caller's, one
 *     filed under another day, and a date outside the plan's week alike. One
 *     class for all four, because a response that distinguished them would be an
 *     oracle for what exists in another user's diary (§0.5.2's 404).
 *  5. THE SNAPSHOT, from `derivePlannedSnapshot` — which owns the single
 *     rounding — inserted through `insertPlannedMealEntry` with the servings
 *     the request asked for. The writer stores those integers verbatim, so
 *     nothing on this path rounds a second time.
 *  6. `meal_plans.revision` incremented as a compare-and-swap on the pinned
 *     value; `meal_plan_meals.revision` deliberately untouched.
 *
 * The response body carries the created diary entry AND the planned meal with
 * its new `loggedEntries`, so the card can switch to its logged state from this
 * response alone — which is why the meal DTO is re-read AFTER the insert rather
 * than reused from step 3.
 */
export const logPlannedMeal = async (
    userId: string,
    planId: string,
    mealId: string,
    body: unknown,
    now: Date = new Date(),
): Promise<LogPlannedMealResult> => {
    const parsed = parseLogPlannedMealCall({ planId, mealId }, body);

    if (parsed.kind !== 'ok') {
        return parsed;
    }

    // The parsed values from here down, never the arguments: the fingerprint,
    // the reservation and every predicate below must see the request the parser
    // admitted, so the ids and the payload have exactly one representation once
    // the parse has passed.
    const payload: LogPlannedMealPayload = parsed.payload;
    const { planId: parsedPlanId, mealId: parsedMealId } = parsed;

    const result = await prisma.$transaction((tx) =>
        runKeyedAction(
            tx,
            {
                userId,
                actionType: 'log',
                idempotencyKey: payload.idempotencyKey,
                fingerprint: buildRequestFingerprint(
                    'POST',
                    'log',
                    { planId: parsedPlanId, mealId: parsedMealId },
                    payload,
                ),
            },
            async (lockedTx) => {
                const plan = await requireWritablePlanForLog(lockedTx, userId, parsedPlanId, now);

                if (plan.revision !== payload.expectedPlanRevision) {
                    throw new StalePlanError(plan.revision);
                }

                const meal = await lockedTx.meal_plan_meals.findFirst({
                    where: { id: parsedMealId, meal_plan_id: parsedPlanId, user_id: userId },
                    select: PLANNED_MEAL_SELECT,
                });

                if (meal === null) {
                    throw new PlanNotFoundError();
                }

                const diaryMeal = await lockedTx.meals.findFirst({
                    where: { id: payload.diaryMealId, user_id: userId },
                    select: { id: true, user_id: true, date: true, deleted_at: true },
                });

                requireLoggableTarget({
                    plan: { start_date: plan.startDate, end_date: plan.endDate },
                    diaryMeal,
                    userId,
                    date: payload.date,
                });

                const snapshot = derivePlannedSnapshot(meal, meal.recipe_versions);
                const entry = await insertPlannedMealEntry(lockedTx, {
                    userId,
                    mealId: payload.diaryMealId,
                    date: toStoredDate(payload.date),
                    mealPlanMealId: meal.id,
                    recipeVersionId: snapshot.recipe_version_id,
                    name: snapshot.name,
                    servingText: snapshot.serving_text,
                    // The eaten fraction the stepper produced, stored as sent.
                    // `isEatenServingsInContract` has already bounded it to
                    // [0.25, 10] at two decimals, and the four macros beside it
                    // describe ONE serving — so scaling it here would double-count
                    // what the diary already multiplies.
                    servings: payload.servings,
                    perServing: {
                        calories: snapshot.calories,
                        protein: snapshot.protein_g,
                        carbs: snapshot.carbs_g,
                        fat: snapshot.fat_g,
                    },
                });

                const planRevisionAfter = await bumpPlanRevision(
                    lockedTx,
                    userId,
                    parsedPlanId,
                    payload.expectedPlanRevision,
                );

                return {
                    body: {
                        entry,
                        mealPlanMeal: await requireMealResponse(
                            lockedTx,
                            userId,
                            parsedPlanId,
                            parsedMealId,
                        ),
                        planRevision: planRevisionAfter,
                    },
                    planRevisionAfter,
                    mealPlanId: parsedPlanId,
                    mealPlanMealId: meal.id,
                    mealEntryId: entry.id,
                };
            },
        ),
    );

    return { kind: 'ok', result };
};
