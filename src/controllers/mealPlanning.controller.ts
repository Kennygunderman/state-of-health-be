// The meal-planning HTTP edge: 18 handlers, each `getUserId(req)` → parse →
// ONE service call → typed-error mapping (Rule backend-architecture §4,
// AAP §0.7.2).
//
// THE PARSE HAPPENS TWICE, ON PURPOSE. Every handler below judges the request
// against ITSELF before any I/O, using the same pure parser its service calls:
// a malformed path id, an unusable revision or an unknown body key is answered
// `400 invalid_request` here, before a `where: { id }` predicate can reject a
// uuid cast as a 500, before an idempotency key can be reserved, and before a
// row is read on behalf of a request that was never well formed (§0.5.2 —
// "server-side validation applied before any Prisma or planning work").
//
// The service then re-parses under its per-user lock, and that second parse is
// NOT redundant: it is the authority for everything the request alone cannot
// settle — the start-date window (a property of the clock in the user's stored
// zone), per-step coherence against the stored row, and the revision race. Its
// refusal branches therefore stay exactly as they are; after this wiring they
// are unreachable for pure-syntax problems and remain the only answer for the
// row-dependent ones. Both stages call the same function with the same
// arguments, so the two cannot disagree about a code, a field or their order.
//
// WHAT CROSSES THE BOUNDARY IS THE PARSER'S OUTPUT WHEREVER THE PARSER
// PRODUCES ONE THE SERVICE CAN CONSUME. Every handler passes narrowed path ids,
// and the four keyed writes — generate, regenerate, swap commit, planned log —
// pass the parser's own payload object in place of `req.body`.
//
// For those four the substitution is provably invisible to the client. Each
// derives its idempotency fingerprint from the PARSED PAYLOAD and never from
// the body it arrived in (`buildRequestFingerprint(..., payload)` in
// `mealPlan.service.ts` and `swap.service.ts`), and their payloads are the
// parser's normalised copies of the same wire field names, so re-parsing one
// yields the identical payload and therefore the identical fingerprint, replay
// decision and response bytes. What it removes is a request-shaped object
// travelling one layer past the layer that validates it.
//
// THREE HANDLERS STILL PASS THEIR BODY, each for a reason in the parser rather
// than an omission here.
//
//   * The targets save has a parsed value, but it is a NORMALISED DTO and not a
//     narrowing of the wire shape: `ManualSaveRequest` nests the four macros
//     under `values` where the body carries them flat, so handing it on would
//     hand the service a different value, which its own parse then rightly
//     refuses. Its signature is the sibling-owned contract every direct caller
//     already uses, so the wire body is what it takes.
//   * The two preference saves have no parsed value to give. Their request
//     stage answers `ok` / `needs_context` / refusal and carries no payload,
//     because a step's authoritative payload is only decidable against the
//     stored row — that is the `needs_context` arm in `preferences.logic.ts`,
//     and inventing a request-stage payload would mean deciding coherence
//     without the half of the tuple that lives in the database.
//
// All three are still refused here on everything the request alone condemns,
// which is the property AAP §0.5.2 asks for; the row-backed parse then produces
// the narrowed value at the only point it can be produced.

import { Request, Response } from 'express';
import {
    parseGroceryItemPath,
    parseGroceryListPath,
    parseToggleGroceryBody,
} from '../services/grocery.logic';
import { getGroceryList, toggleGroceryItem, uncheckAllGroceries } from '../services/grocery.service';
import {
    parseAffectedMealsPath,
    parseGeneratePlanSyntax,
    parseMealPlanDayPath,
    parseRegeneratePlanRequest,
} from '../services/mealPlan.logic';
import {
    generatePlan,
    getAffectedMeals,
    getCurrentMealPlan,
    getMealPlanDay,
    regeneratePlan,
} from '../services/mealPlan.service';
import {
    CatalogFoodNotFoundError,
    EstimateStaleError,
    EstimateUnavailableError,
    IdempotencyConflictError,
    MealPlanningDisabledError,
    NoMatchingMealsError,
    OutsidePlanWeekError,
    PlanGenerationError,
    PlanNotActiveError,
    PlanNotFoundError,
    PlanOverlapError,
    PreferencesIncompleteError,
    PreviewStaleError,
    ReadOnlyFieldError,
    RecipeIneligibleError,
    StalePlanError,
    StaleRevisionError,
    StaleTargetsError,
    SwapFailedError,
    TargetsMissingError,
    TargetsUnconfirmedError,
    UpcomingExistsError,
} from '../services/mealPlanning.errors';
import { parseLogPlannedMealCall } from '../services/plannedMealLog.logic';
import { logPlannedMeal } from '../services/plannedMealLog.service';
import {
    PreferenceErrorVerdict,
    parsePreferencesUpdateRequest,
    parseSetupStepRequest,
    readOnlyFieldRefusal,
} from '../services/preferences.logic';
import { getPreferences, savePreferences, saveSetupStep } from '../services/preferences.service';
import {
    parseSwapAlternativesPath,
    parseSwapCommitRequest,
    parseSwapPreviewPath,
} from '../services/swap.logic';
import { commitSwap, getSwapAlternatives, getSwapPreview } from '../services/swap.service';
import { parseSaveTargetsRequest } from '../services/targets.logic';
import { getTargetEstimate, getTargets, saveTargets } from '../services/targets.service';
// The error CLASS only, for the `instanceof` arm below. Nothing in this file
// calls `user.service.ts` — the owner-existence guard runs inside the per-user
// lock, where it cannot be overtaken (`mealPlanningAction.service.ts::
// withUserLock`) — so this adds a mapping and not a service call at the edge.
import { UserNotProvisionedError } from '../services/user.service';
// Type-only, so this stays a compile-time reference and adds no runtime import
// of the keyed-action service to the controller: the result shape a keyed write
// answers with is declared once, where the write produces it.
import type { KeyedActionResult } from '../services/mealPlanningAction.service';
import { InvalidRequestDetail } from '../types/mealPlanning';
import type { MealPlanningActionType } from '../utils/featureFlags';
import { POST_COMMIT_ABORT_HEADER, isMealPlanningEnabled, postCommitAbort } from '../utils/featureFlags';
import { getUserId } from '../utils/getUserId';
import { SafeLogFields, describeErrorSafely, logSafeEvent } from '../utils/safeLogger';

const FEATURE_DISABLED = 'feature_disabled';
const INVALID_REQUEST = 'invalid_request';
const PLAN_NOT_FOUND = 'Plan not found';

/**
 * The answer for an authenticated identity that has no `users` row.
 *
 * A machine code, unlike `PLAN_NOT_FOUND` above, and deliberately so: the
 * legacy diary family answers this state with the human sentence
 * `"User not found"` and keeps it, while every meal-planning body carries a code
 * the client maps (§0.5.2). The client already declares this exact string, so a
 * `404 user_not_found` classifies as a CONFIRMED failure rather than the unknown
 * outcome an unmapped 5xx produced (§0.2.5).
 */
const USER_NOT_FOUND = 'user_not_found';

/**
 * The residual 500's body, for every handler in this file.
 *
 * ONE stable machine code rather than each handler's prose. §0.5.2 requires
 * meal-planning responses to carry codes a client can map, and a body of
 * "Failed to regenerate the meal plan" is neither mappable nor documented —
 * eighteen handlers produced eighteen undocumented 500 shapes. The prose
 * survives as the `action` descriptor inside the server event, which is where a
 * route description is useful and where it costs the client nothing.
 */
const INTERNAL_ERROR = 'internal_error';

/* ---------------------------------------------------------------------------
 * The server events this edge emits
 *
 * Exactly ONE event per answered request, and only these five names, because a
 * log an operator can count is a log with a closed vocabulary (AAP §0.7.1's
 * diagnosability requirement). An expected refusal and an expected rejection
 * are `warn`, a server fault is `error`, and an answered keyed write is `info`.
 *
 * What may travel in one is bounded by `SafeLogFields`: a scoped `userId`, the
 * action, the resource ids, the idempotency key, the status and code, and the
 * safe counters the typed errors already carry. Never a message, never a
 * response body, never a request body, never an error object — see
 * `utils/safeLogger.ts` for why that is a property of the logger rather than a
 * rule each call site remembers.
 * ------------------------------------------------------------------------- */

/** A 400 this edge emitted, with the fields the client was told to fix. */
const REQUEST_REFUSED = 'request_refused';

/** An expected non-2xx outcome mapped from a typed error (404, 409, 422, 503, and the read-only-field 400). */
const REQUEST_REJECTED = 'request_rejected';

/** A server fault: the 502 vendor/generation boundaries and the residual 500. */
const REQUEST_FAILED = 'request_failed';

/** One of the four idempotency-keyed writes answered — freshly committed or replayed. */
const KEYED_WRITE_ANSWERED = 'keyed_write_answered';

/** A committed keyed write whose response was deliberately withheld. */
const RESPONSE_ABORTED_AFTER_COMMIT = 'response_aborted_after_commit';

/** Why a response was withheld, as a fixed code rather than prose. */
const ABORT_REASON = 'post_commit_abort_requested';

/**
 * The route descriptors that appear as `action`. Fixed literals, one per
 * handler: this is the only place a handler's identity enters a log line, and a
 * value assembled from the request would make an alert on it forgeable.
 */
const ACTIONS = {
    preferencesRead: 'preferences.read',
    preferencesSaveStep: 'preferences.saveStep',
    preferencesSave: 'preferences.save',
    targetsEstimate: 'targets.estimate',
    targetsRead: 'targets.read',
    targetsSave: 'targets.save',
    plansGenerate: 'plans.generate',
    plansCurrent: 'plans.current',
    plansDay: 'plans.day',
    plansRegenerate: 'plans.regenerate',
    plansAffectedMeals: 'plans.affectedMeals',
    swapsAlternatives: 'swaps.alternatives',
    swapsPreview: 'swaps.preview',
    swapsCommit: 'swaps.commit',
    groceriesList: 'groceries.list',
    groceriesToggleItem: 'groceries.toggleItem',
    groceriesUncheckAll: 'groceries.uncheckAll',
    logPlannedMeal: 'log.plannedMeal',
} as const;

/**
 * What a handler knows about the request it is answering, for correlation.
 *
 * MUTABLE and filled in as the handler learns each value, which is what lets
 * the `catch` emit an event carrying whatever had been resolved when the throw
 * happened: a `MealPlanningDisabledError` raised before `getUserId` carries the
 * action alone, while a `StalePlanError` raised inside a keyed write carries
 * the user, the plan, the meal and the key.
 *
 * The ids come from the parsed request wherever one exists, so they are
 * already-validated UUIDs; on the refusal paths they may be arbitrary client
 * text, which the logger sanitizes and bounds.
 */
interface EdgeContext {
    readonly action: string;
    userId?: string;
    planId?: string;
    mealId?: string;
    idempotencyKey?: string;
}

/** The correlation fields every event carries, so no call site can spell them differently. */
const correlationFields = (context: EdgeContext): SafeLogFields => ({
    action: context.action,
    userId: context.userId,
    planId: context.planId,
    mealId: context.mealId,
    idempotencyKey: context.idempotencyKey,
});

/** At most this many distinct offending field names travel in one event. */
const MAX_LOGGED_FIELDS = 10;

/**
 * What a field name is replaced by when it is not one of the names below.
 *
 * Deliberately the spelling of the `unknown_field` detail CODE: an operator
 * reading `fields: "unknown_field"` beside `unknownFieldCount: 200` learns
 * exactly what happened — a body full of keys the contract does not have — and
 * learns it without any of those keys being written down.
 */
const UNKNOWN_FIELD_NAME = 'unknown_field';

/**
 * The bound a candidate name is judged against BEFORE anything scans it.
 *
 * The longest name in the vocabulary is `expectedPreferencesRevision` at 27
 * characters, so this is generous headroom; what it buys is that a megabyte-long
 * object key is rejected by a length comparison rather than normalised first.
 * It is the same bound `safeLogger.ts` puts on a field key, for the same reason.
 */
const MAX_FIELD_NAME_LENGTH = 64;

/**
 * An array subscript, collapsed so the POSITION drops out of the name.
 *
 * `preferences.logic.ts` builds `allergens[3]` and `mealTimes[1].time` itself,
 * so the index is server-derived and the name is genuinely one of ours — but the
 * index makes it a different string on every request, which a fixed vocabulary
 * cannot hold and an operator's alert cannot match. `allergens[]` is the name;
 * `detailCount` and the response's own `details` carry the rest.
 */
const ARRAY_SUBSCRIPT_PATTERN = /\[\d+\]/g;

const COLLAPSED_SUBSCRIPT = '[]';

/**
 * Every field name the six parsers reachable from this edge AUTHOR, normalised,
 * and the only strings this file will write into a log line.
 *
 * WHY A CLOSED SET AND NOT A SANITIZER. A detail's `field` is only sometimes
 * ours. For the codes `unknown_field` and `read_only_field` it is a CLIENT-CHOSEN
 * OBJECT KEY, copied out of the request body by the unaccepted-key arms of
 * `preferences.logic.ts`, `targets.logic.ts`, `swap.logic.ts` and
 * `plannedMealLog.logic.ts` — so without this gate arbitrary client text reaches
 * an operator's log: an email address or a note a user typed into a key
 * (CWE-532), or a bidi override that reorders the rendering of every character
 * after it and makes one log line read as another (CWE-117). `logSafeEvent`
 * collapses the C0 controls that could END a line, which is a different
 * guarantee and not this one — it does not, and should not have to, know which
 * of its callers' strings came from a client.
 *
 * MEMBERSHIP IS EXACT, not a pattern. A pattern for "looks like one of our
 * field names" admits `secretToken` and `user@example.com`-shaped keys just as
 * happily as `startDate`, which would leave the same hole with more code in it.
 * A name absent here is not logged at all — it is counted instead.
 *
 * Derived by reading the `detail(…)` / `{ field: … }` sites and the `*_FIELD`
 * constants of `{preferences,targets,mealPlan,swap,plannedMealLog,grocery}.logic.ts`.
 * A parser that grows a field adds it here; until it does, the refusal is still
 * recorded, still counted, and merely unnamed.
 */
const LOGGABLE_FIELD_NAMES: ReadonlySet<string> = new Set([
    // Path ids and envelope members (mealPlan, swap, plannedMealLog, grocery)
    'planId',
    'mealId',
    'itemId',
    'date',
    'startDate',
    'step',
    'body',
    'idempotencyKey',
    'expectedPlanRevision',
    'expectedPreferencesRevision',
    'expectedTargetsRevision',
    'expectedRevision',
    'estimateRevision',
    // Swap, planned log and grocery payloads
    'recipeVersionId',
    'portionMultiplier',
    'servings',
    'diaryMealId',
    'isChecked',
    'timeZone',
    // Targets
    'source',
    'calories',
    'protein',
    'carbs',
    'fat',
    // Preferences: setup answers and measurements
    'goal',
    'goalWeightKg',
    'paceLbPerWeek',
    'age',
    'height',
    'heightCm',
    'weightKg',
    'sexForEstimate',
    'heightUnitPref',
    'weightUnitPref',
    'activityLevel',
    'diet',
    'allergens',
    `allergens${COLLAPSED_SUBSCRIPT}`,
    'dislikedFoodIds',
    `dislikedFoodIds${COLLAPSED_SUBSCRIPT}`,
    'dislikedFoodGroups',
    `dislikedFoodGroups${COLLAPSED_SUBSCRIPT}`,
    'mealSchedule',
    'mealTimes',
    `mealTimes${COLLAPSED_SUBSCRIPT}`,
    `mealTimes${COLLAPSED_SUBSCRIPT}.slot`,
    `mealTimes${COLLAPSED_SUBSCRIPT}.time`,
    'cookingTimeLimitMin',
    'budget',
    'budget.amount',
    'budget.currency',
    'noBudgetPreference',
    'skipped',
    // The six server-owned members of `PreferencesResponse` (AAP §0.5.2's
    // editable-DTO paragraph). A body carrying one of these is the documented
    // cause of `read_only_field`, and naming it is the difference between "a
    // client is trying to write onboarding state" and "some key was refused" —
    // so these six spellings, and no near-miss of them, stay loggable. They
    // arrive as client keys like any other, which is exactly why membership
    // here is an equality test against a fixed literal.
    'setupStatus',
    'setupStep',
    'revision',
    'budgetTier',
    'hasActivePlan',
    'targetRoute',
]);

/**
 * One detail's field name as it may be logged: itself when this edge authored
 * it, and the fixed token otherwise.
 *
 * The order of the three steps is the whole function. The length bound runs
 * first so an oversized key costs one comparison; the subscript collapse runs
 * second so a server-built `mealTimes[2].time` is recognised; membership runs
 * last and admits nothing else.
 *
 * The non-string arm is unreachable through the declared type and kept for the
 * same reason `safeLogger.ts` keeps its own: a `field` originates in a parsed
 * JSON body, and a value that arrives as something else must be replaced rather
 * than have `.replace` called on it — a log call may never be the thing that
 * fails the request it was describing.
 */
const loggableFieldName = (field: string): string => {
    if (typeof field !== 'string' || field.length > MAX_FIELD_NAME_LENGTH) {
        return UNKNOWN_FIELD_NAME;
    }

    const normalized = field.replace(ARRAY_SUBSCRIPT_PATTERN, COLLAPSED_SUBSCRIPT);

    return LOGGABLE_FIELD_NAMES.has(normalized) ? normalized : UNKNOWN_FIELD_NAME;
};

/**
 * What a refusal says about the fields it refused, for both log sites that
 * report one — the returned verdicts and the `ReadOnlyFieldError` branch.
 *
 * Three fields, and each answers a question the other two cannot:
 *
 *  * `fields` — the distinct names, in the order the parser found them, bounded
 *    at {@link MAX_LOGGED_FIELDS}. Deduplicated because the token collapses:
 *    two hundred unknown keys are one `unknown_field`, not ten copies of it,
 *    which is what keeps the real names beside it visible.
 *  * `detailCount` — how many details the client was actually sent, which is
 *    what stays truthful once the list is deduplicated and cut.
 *  * `unknownFieldCount` — how many of those details named something this edge
 *    will not write down, so the line never implies the list was complete.
 *
 * The RESPONSE is untouched by all of this: `details: [{field, code}]` still
 * carries the client's own key, because §0.5.2 requires the client to be told
 * which key to fix. Only the log line is closed-vocabulary.
 */
const refusalLogFields = (details: readonly InvalidRequestDetail[]): SafeLogFields => {
    const named: string[] = [];
    const seen = new Set<string>();
    let unknownFieldCount = 0;

    for (const detail of details) {
        const name = loggableFieldName(detail.field);

        if (name === UNKNOWN_FIELD_NAME) {
            unknownFieldCount += 1;
        }
        if (seen.has(name)) {
            continue;
        }

        seen.add(name);

        if (named.length < MAX_LOGGED_FIELDS) {
            named.push(name);
        }
    }

    return { fields: named.join(','), detailCount: details.length, unknownFieldCount };
};

/**
 * The server-side kill switch, checked by every gated handler.
 *
 * CALLED AFTER `getUserId(req)`, NOT BEFORE IT, in all fifteen. The order does
 * not change a single response — every route here is mounted behind
 * `authenticateFirebaseToken`, so `req.user` is already populated and
 * `getUserId` cannot fail where this function would have run — but it decides
 * whether the `503 feature_disabled` event names the caller. A capability
 * refusal with no `userId` answers "someone was refused" and nothing an
 * operator can act on; with it, a support question about one account during a
 * rollout is answerable from the log (AAP §0.7.5's kill switch).
 */
const assertMealPlanningEnabled = (): void => {
    if (!isMealPlanningEnabled()) {
        throw new MealPlanningDisabledError();
    }
};

const refuseInvalidRequest = (
    res: Response,
    verdict: { code: string; details: InvalidRequestDetail[] },
    context: EdgeContext,
) => {
    logSafeEvent('warn', REQUEST_REFUSED, {
        ...correlationFields(context),
        status: 400,
        code: verdict.code,
        ...refusalLogFields(verdict.details),
    });

    return res.status(400).json({ error: verdict.code, details: verdict.details });
};

/**
 * Answers one expected, mapped outcome and records it.
 *
 * The body is built by the caller so each mapping keeps its exact shape and key
 * order; this function only adds the event, so a 404 or a 409 can no longer
 * leave the server with nothing to say about it. `safeData` is the data the
 * error class already carries for the client — revisions, a replacement plan
 * id, a reason, a count — never its message.
 */
const rejectRequest = (
    res: Response,
    context: EdgeContext,
    error: Error,
    status: number,
    body: { error: string } & Record<string, unknown>,
    safeData: SafeLogFields = {},
) => {
    logSafeEvent('warn', REQUEST_REJECTED, {
        ...correlationFields(context),
        status,
        // The body's own `error` member, so a log line and the answer the client
        // received cannot disagree about what the outcome was called.
        code: body.error,
        ...describeErrorSafely(error),
        ...safeData,
    });

    return res.status(status).json(body);
};

/**
 * Answers one server fault and records it — the 502 boundaries and the
 * residual 500.
 *
 * `describeErrorSafely` is the whole of what is said about the throw: a name
 * and, when the runtime supplies one, a machine code. The `cause` of a
 * `PlanGenerationError` or a `SwapFailedError` is described the same way rather
 * than printed, which is what replaced `console.error('…', error.cause ?? …)` —
 * that line could render a stack, a Prisma `meta` carrying the failing
 * statement's values, a connection string or a vendor response body into the
 * log (AAP §0.3.2/§0.7.1, Rule backend-architecture §8).
 */
const failRequest = (
    res: Response,
    context: EdgeContext,
    error: unknown,
    status: number,
    code: string,
    cause?: unknown,
) => {
    const described = describeErrorSafely(error);
    const describedCause = cause === undefined ? undefined : describeErrorSafely(cause);

    logSafeEvent('error', REQUEST_FAILED, {
        ...correlationFields(context),
        status,
        code,
        ...described,
        causeName: describedCause?.errorName,
        causeCode: describedCause?.errorCode,
    });

    return res.status(status).json({ error: code });
};

/**
 * Sends one keyed write's answer, or records that the answer was deliberately
 * withheld after the write had already committed.
 *
 * Shared by all four keyed handlers so the abort seam and the success event
 * cannot drift apart between them, and so "exactly one event per answered
 * request" is structural: the abort branch returns, and the two events are
 * mutually exclusive.
 *
 * The abort branch is the one place a client receives NOTHING for a write that
 * succeeded, and it is reached two ways: the test-only
 * `POST_COMMIT_ABORT_HEADER`, honoured per request exactly as asked, and the
 * `log` fault a developer drives from a device, which is ONE-SHOT. The
 * distinction is `result.replayed`, which is why it is passed to the predicate:
 * §0.9.4 arms that switch so the first tap reaches the unconfirmed-outcome
 * state and "the same-key retry must return the committed 201", so the ambient
 * switch must never swallow a stored replay — a device whose replay was also
 * dropped could not resolve until the server's environment was edited.
 * `postCommitAbort` owns which of the two is answering; this function only
 * reports the fact.
 *
 * Without this event the socket simply died: the completed
 * `meal_plan_actions` row proved the commit, but nothing said the response had
 * been withheld on purpose or tied the loss to that row. The event carries the
 * stored status and the post-write plan revision — never the response snapshot,
 * which is the plan itself.
 *
 * BOTH EVENTS CARRY `replayed`, and it is the field that makes a retried write
 * readable. `201 generate` at revision 1 twice under one key is two very
 * different situations — a duplicate the ledger absorbed, or a single commit
 * whose first response never arrived — and the status and revision are
 * identical in both. `KeyedActionResult.replayed` is set at the two points
 * where the answer's route diverges inside `mealPlanningAction.service.ts`, so
 * the edge reports which route answered rather than guessing from values that
 * cannot tell them apart. It never reaches the response: §0.5.1 requires that a
 * client cannot distinguish a replay from the original, and this is the
 * operator's side of that same fact.
 */
const answerKeyedWrite = (
    req: Request,
    res: Response,
    context: EdgeContext,
    actionType: MealPlanningActionType,
    result: KeyedActionResult,
) => {
    if (postCommitAbort(actionType, req.header(POST_COMMIT_ABORT_HEADER), { replayed: result.replayed })) {
        logSafeEvent('warn', RESPONSE_ABORTED_AFTER_COMMIT, {
            ...correlationFields(context),
            status: result.status,
            planRevision: result.planRevisionAfter,
            replayed: result.replayed,
            reason: ABORT_REASON,
        });
        res.socket?.destroy();

        return;
    }

    logSafeEvent('info', KEYED_WRITE_ANSWERED, {
        ...correlationFields(context),
        status: result.status,
        planRevision: result.planRevisionAfter,
        replayed: result.replayed,
    });

    return res.status(result.status).json(result.body);
};

const handleMealPlanningError = (res: Response, error: unknown, context: EdgeContext) => {
    if (error instanceof PreferencesIncompleteError) {
        return rejectRequest(res, context, error, 409, { error: 'preferences_incomplete' });
    }
    if (error instanceof StaleRevisionError) {
        return rejectRequest(res, context, error, 409, { error: 'stale_revision', ...error.data }, {
            // The payload is exclusive, so exactly one of these three is set and
            // the other two drop out of the event — which is itself the signal
            // for which form of the refusal the client received.
            currentRevision: error.data.currentRevision,
            preferencesRevision: error.data.preferencesRevision,
            targetsRevision: error.data.targetsRevision,
        });
    }
    if (error instanceof StaleTargetsError) {
        return rejectRequest(
            res,
            context,
            error,
            409,
            { error: 'stale_targets', currentRevision: error.currentRevision },
            { currentRevision: error.currentRevision },
        );
    }
    if (error instanceof EstimateStaleError) {
        return rejectRequest(res, context, error, 409, { error: 'estimate_stale' });
    }
    if (error instanceof EstimateUnavailableError) {
        return rejectRequest(
            res,
            context,
            error,
            409,
            { error: 'estimate_unavailable', reason: error.reason },
            { reason: error.reason },
        );
    }
    if (error instanceof TargetsUnconfirmedError) {
        return rejectRequest(res, context, error, 409, { error: 'targets_unconfirmed' });
    }
    if (error instanceof PlanOverlapError) {
        return rejectRequest(
            res,
            context,
            error,
            409,
            { error: 'plan_overlap', conflictingPlanId: error.conflictingPlanId },
            { conflictingPlanId: error.conflictingPlanId },
        );
    }
    if (error instanceof UpcomingExistsError) {
        return rejectRequest(res, context, error, 409, { error: 'upcoming_exists' });
    }
    if (error instanceof StalePlanError) {
        return rejectRequest(
            res,
            context,
            error,
            409,
            { error: 'stale_plan', currentRevision: error.currentRevision },
            { currentRevision: error.currentRevision },
        );
    }
    if (error instanceof PlanNotActiveError) {
        return rejectRequest(res, context, error, 409, { error: 'plan_not_active', ...error.data }, {
            replacementPlanId: error.data.replacementPlanId,
            reason: error.data.reason,
        });
    }
    if (error instanceof IdempotencyConflictError) {
        // The key and the user are already in the correlation fields, which is
        // what turns this line into "this caller reused that key with a
        // different request" — the one question the stored action row cannot
        // answer on its own, because the conflicting attempt writes no row.
        return rejectRequest(res, context, error, 409, { error: 'idempotency_conflict' });
    }
    if (error instanceof PreviewStaleError) {
        return rejectRequest(res, context, error, 409, { error: 'preview_stale' });
    }
    if (error instanceof ReadOnlyFieldError) {
        // Every offending key travels in the BODY, in the order the parser found
        // them — the same body a returned verdict produced, so the refusal stays
        // one round trip however many server-owned keys the client sent. The
        // event beside it says the same thing in the closed vocabulary
        // `refusalLogFields` bounds it to, because these keys are the client's.
        return rejectRequest(
            res,
            context,
            error,
            400,
            { error: INVALID_REQUEST, details: error.details },
            refusalLogFields(error.details),
        );
    }
    if (error instanceof OutsidePlanWeekError) {
        // The second thrown 400 on this edge, and it renders exactly like the
        // returned verdicts: `invalid_request` with the field named, so a client
        // marks up the date control it already marks up for `invalid_date` on
        // the same route. The detail list belongs to the class — both members are
        // server constants — which is why nothing is assembled here.
        return rejectRequest(
            res,
            context,
            error,
            400,
            { error: INVALID_REQUEST, details: error.details },
            refusalLogFields(error.details),
        );
    }
    if (error instanceof TargetsMissingError) {
        return rejectRequest(
            res,
            context,
            error,
            422,
            { error: 'targets_missing', missing: error.missing },
            { missing: error.missing.join(','), missingCount: error.missing.length },
        );
    }
    if (error instanceof NoMatchingMealsError) {
        // The search frontier as COUNTS AND CODES, never the diagnostics object
        // the previous line handed to `console.error`. Every member here is
        // server-derived and closed-set or numeric, which is what makes the
        // line safe to keep at this volume; the constraint keys are what let an
        // operator see whether one preference is refusing every week.
        return rejectRequest(
            res,
            context,
            error,
            422,
            {
                error: 'no_matching_meals',
                limitingConstraints: error.limitingConstraints,
                allergiesKept: error.allergiesKept,
            },
            {
                constraintKeys: error.limitingConstraints
                    .slice(0, MAX_LOGGED_FIELDS)
                    .map((constraint) => constraint.constraintKey)
                    .join(','),
                constraintCount: error.limitingConstraints.length,
                searchExhausted: error.searchDiagnostics?.exhausted,
                exhaustedBy: error.searchDiagnostics?.exhaustedBy,
                frontierDayIndex: error.searchDiagnostics?.frontierDayIndex,
                frontierDate: error.searchDiagnostics?.frontierDate,
                evaluations: error.searchDiagnostics?.evaluations,
            },
        );
    }
    if (error instanceof RecipeIneligibleError) {
        return rejectRequest(res, context, error, 422, { error: 'recipe_ineligible' });
    }
    if (error instanceof PlanGenerationError) {
        return failRequest(res, context, error, 502, 'plan_generation_failed', error.cause);
    }
    if (error instanceof SwapFailedError) {
        return failRequest(res, context, error, 502, 'swap_failed', error.cause);
    }
    if (error instanceof UserNotProvisionedError) {
        // An authenticated identity with no `users` row: permanent, wrote
        // nothing, and the same 404 the shipped `PUT /api/user/targets` has
        // always answered for it. A MACHINE CODE rather than that route's human
        // sentence, because every meal-planning body carries a code the client
        // maps (§0.5.2) and `user_not_found` is already declared in the client's
        // own code map — which is what turns this from an unknown outcome, with
        // its automatic retry and "We couldn't confirm that", into a confirmed
        // one (§0.2.5, §0.7.2). The id the class carries is never rendered: the
        // caller is the correlation field the event already has.
        return rejectRequest(res, context, error, 404, { error: USER_NOT_FOUND });
    }
    if (error instanceof PlanNotFoundError) {
        return rejectRequest(res, context, error, 404, { error: PLAN_NOT_FOUND });
    }
    if (error instanceof CatalogFoodNotFoundError) {
        return rejectRequest(res, context, error, 404, { error: 'catalog_food_not_found' });
    }
    if (error instanceof MealPlanningDisabledError) {
        return rejectRequest(res, context, error, 503, { error: FEATURE_DISABLED });
    }

    // Unmapped: a bug, a data-integrity class or an infrastructure failure. The
    // event is the only place it is described, and `failRequest` describes it
    // without rendering it.
    return failRequest(res, context, error, 500, INTERNAL_ERROR);
};

/**
 * Refuses a preferences request the request-stage parse rejected, delivering
 * the ONE field-level condition that has a typed class as that class.
 *
 * A body whose only fault is keys the client may not write is exactly
 * `ReadOnlyFieldError` (AAP §0.5.2's `read_only_field`, and the class the AAP's
 * error inventory pairs with a 400), so it is constructed here and handed to the
 * single mapping table below rather than answered as a generic verdict. Two
 * things follow, and both are the point: the HTTP path raises the same class
 * `preferences.service.ts` raises for every other caller, instead of shadowing
 * it with an identical hand-built body; and the server event then carries
 * `read_only_field`'s own class name rather than a bare `invalid_request`.
 *
 * The response is byte-identical either way — the class carries the whole
 * detail list — and `readOnlyFieldRefusal` (the pure layer) is what decides
 * which refusals qualify, so the boundary and the service cannot classify the
 * same body differently. Every other refusal stays a verdict, because a mixed
 * body must keep naming every offending control at once (AAP §0.7.4).
 */
const refusePreferenceRequest = (
    res: Response,
    verdict: PreferenceErrorVerdict,
    context: EdgeContext,
) => {
    const readOnlyDetails = readOnlyFieldRefusal(verdict);

    return readOnlyDetails === null
        ? refuseInvalidRequest(res, verdict, context)
        : handleMealPlanningError(res, new ReadOnlyFieldError(readOnlyDetails), context);
};

export const getPreferencesController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.preferencesRead };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const preferences = await getPreferences(userId);
        return res.json(preferences);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const saveSetupStepController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.preferencesSaveStep };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        // `=== 'error'` rather than `!== 'ok'`, here and on the full save below:
        // the request-only verdict has a third arm for the problems it cannot
        // settle without the stored row, and only the error arm is a 400. A
        // guard written the other way round would turn that arm into a spurious
        // refusal of a well-formed request.
        const verdict = parseSetupStepRequest(req.params.step, req.body);
        if (verdict.kind === 'error') {
            return refusePreferenceRequest(res, verdict, context);
        }
        const saved = await saveSetupStep(userId, req.params.step, req.body);
        if (saved.kind !== 'ok') {
            return refuseInvalidRequest(res, saved, context);
        }
        return res.json(saved.response);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const savePreferencesController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.preferencesSave };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const verdict = parsePreferencesUpdateRequest(req.body);
        if (verdict.kind === 'error') {
            return refusePreferenceRequest(res, verdict, context);
        }
        const saved = await savePreferences(userId, req.body);
        if (saved.kind !== 'ok') {
            return refuseInvalidRequest(res, saved, context);
        }
        return res.json(saved.response);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

// The three targets routes are deliberately NOT gated by
// `assertMealPlanningEnabled()`, unlike every other handler in this file:
// Account, Progress and the diary's target editor read and write nutrition
// targets through them, so turning meal planning off must leave them answering
// normally rather than 503 (AAP §0.5.2, §0.7.5).
export const getTargetEstimateController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.targetsEstimate };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        const estimate = await getTargetEstimate(userId);
        return res.json(estimate);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const getNutritionTargetsController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.targetsRead };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        const targets = await getTargets(userId);
        return res.json(targets);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const saveNutritionTargetsController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.targetsSave };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        const request = parseSaveTargetsRequest(req.body);
        if (request.kind === 'error') {
            return refuseInvalidRequest(res, request, context);
        }
        const saved = await saveTargets(userId, req.body);
        if (saved.kind !== 'ok') {
            return refuseInvalidRequest(res, saved, context);
        }
        return res.json(saved.response);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const generatePlanController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.plansGenerate };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        // The SYNTAX half only. The start-date window is judged against the
        // clock in the user's stored zone and must stay behind the idempotency
        // ledger's replay gate (§0.5.1), so `parseGeneratePlanRequest` — the
        // composed form — would move a stateful refusal in front of a replay
        // that is entitled to its stored 201.
        const syntax = parseGeneratePlanSyntax(req.body);
        if (syntax.kind === 'error') {
            return refuseInvalidRequest(res, syntax, context);
        }
        // Taken from the PARSED payload, so every event this request emits is
        // keyed by a value the parser has already admitted as a UUID. The plan
        // id is absent by nature: this write creates it.
        context.idempotencyKey = syntax.payload.idempotencyKey;
        const generated = await generatePlan(userId, syntax.payload);
        if (generated.kind !== 'ok') {
            return refuseInvalidRequest(res, generated, context);
        }
        return answerKeyedWrite(req, res, context, 'generate', generated.result);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const getCurrentPlansController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.plansCurrent };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const plans = await getCurrentMealPlan(userId);
        return res.json(plans);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const getPlanDayController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.plansDay };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const path = parseMealPlanDayPath(req.params);
        if (path.kind === 'error') {
            return refuseInvalidRequest(res, path, context);
        }
        context.planId = path.planId;
        const day = await getMealPlanDay(userId, path.planId, path.date);
        if (day.kind !== 'ok') {
            return refuseInvalidRequest(res, day, context);
        }
        return res.json(day.envelope);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const regeneratePlanController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.plansRegenerate };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const parsed = parseRegeneratePlanRequest(req.params, req.body);
        if (parsed.kind === 'error') {
            return refuseInvalidRequest(res, parsed, context);
        }
        context.planId = parsed.planId;
        context.idempotencyKey = parsed.payload.idempotencyKey;
        const regenerated = await regeneratePlan(userId, parsed.planId, parsed.payload);
        if (regenerated.kind !== 'ok') {
            return refuseInvalidRequest(res, regenerated, context);
        }
        return answerKeyedWrite(req, res, context, 'regenerate', regenerated.result);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const getAffectedMealsController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.plansAffectedMeals };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const path = parseAffectedMealsPath(req.params);
        if (path.kind === 'error') {
            return refuseInvalidRequest(res, path, context);
        }
        context.planId = path.planId;
        const affected = await getAffectedMeals(userId, path.planId);
        if (affected.kind !== 'ok') {
            return refuseInvalidRequest(res, affected, context);
        }
        return res.json(affected.response);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const getSwapAlternativesController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.swapsAlternatives };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const path = parseSwapAlternativesPath(req.params);
        if (path.kind === 'error') {
            return refuseInvalidRequest(res, path, context);
        }
        context.planId = path.planId;
        context.mealId = path.mealId;
        const alternatives = await getSwapAlternatives(userId, path.planId, path.mealId);
        if (alternatives.kind !== 'ok') {
            return refuseInvalidRequest(res, alternatives, context);
        }
        return res.json(alternatives.response);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const getSwapPreviewController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.swapsPreview };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const path = parseSwapPreviewPath(req.params);
        if (path.kind === 'error') {
            return refuseInvalidRequest(res, path, context);
        }
        context.planId = path.planId;
        context.mealId = path.mealId;
        const preview = await getSwapPreview(userId, path.planId, path.mealId, path.recipeVersionId);
        if (preview.kind !== 'ok') {
            return refuseInvalidRequest(res, preview, context);
        }
        return res.json(preview.response);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const swapMealController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.swapsCommit };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const parsed = parseSwapCommitRequest(req.params, req.body);
        if (parsed.kind === 'error') {
            return refuseInvalidRequest(res, parsed, context);
        }
        context.planId = parsed.planId;
        context.mealId = parsed.mealId;
        context.idempotencyKey = parsed.payload.idempotencyKey;
        const swapped = await commitSwap(userId, parsed.planId, parsed.mealId, parsed.payload);
        if (swapped.kind !== 'ok') {
            return refuseInvalidRequest(res, swapped, context);
        }
        return answerKeyedWrite(req, res, context, 'swap', swapped.result);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const getGroceryListController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.groceriesList };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const path = parseGroceryListPath(req.params);
        if (path.kind !== 'ok') {
            return refuseInvalidRequest(res, path, context);
        }
        context.planId = path.planId;
        const groceries = await getGroceryList(userId, path.planId);
        return res.json(groceries);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const toggleGroceryItemController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.groceriesToggleItem };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const path = parseGroceryItemPath(req.params);
        if (path.kind !== 'ok') {
            return refuseInvalidRequest(res, path, context);
        }
        context.planId = path.planId;
        const body = parseToggleGroceryBody(req.body);
        if (body.kind !== 'ok') {
            return refuseInvalidRequest(res, body, context);
        }
        const toggled = await toggleGroceryItem(userId, path.planId, path.itemId, body.payload);
        return res.json(toggled);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const uncheckAllGroceriesController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.groceriesUncheckAll };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const path = parseGroceryListPath(req.params);
        if (path.kind !== 'ok') {
            return refuseInvalidRequest(res, path, context);
        }
        context.planId = path.planId;
        const unchecked = await uncheckAllGroceries(userId, path.planId);
        return res.json(unchecked);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};

export const logPlannedMealController = async (req: Request, res: Response) => {
    const context: EdgeContext = { action: ACTIONS.logPlannedMeal };
    try {
        const userId = getUserId(req);
        context.userId = userId;
        assertMealPlanningEnabled();
        const parsed = parseLogPlannedMealCall(req.params, req.body);
        if (parsed.kind === 'error') {
            return refuseInvalidRequest(res, parsed, context);
        }
        context.planId = parsed.planId;
        context.mealId = parsed.mealId;
        context.idempotencyKey = parsed.payload.idempotencyKey;
        const logged = await logPlannedMeal(userId, parsed.planId, parsed.mealId, parsed.payload);
        if (logged.kind !== 'ok') {
            return refuseInvalidRequest(res, logged, context);
        }
        return answerKeyedWrite(req, res, context, 'log', logged.result);
    } catch (error) {
        return handleMealPlanningError(res, error, context);
    }
};
