/**
 * The I/O half of the meal-planning write ledger (Agent Action Plan §0.5.1,
 * "Plan write-safety model") — and the ONLY implementation of the keyed-write
 * sequence.
 *
 * Generate, regenerate, swap and log must each happen at most once however many
 * times a flaky network makes the client retry. One transaction per keyed write
 * guarantees it, in this order:
 *
 *   1. lock     — the per-user advisory lock, first statement of the transaction
 *   2. reserve  — INSERT … ON CONFLICT (user_id, idempotency_key) DO NOTHING
 *   3. replay   — a key seen before either replays its stored response verbatim
 *                 or is a conflict; BOTH decided before any plan check
 *   4. check    — only now the caller's plan status and revision checks
 *   5. work     — the caller's write, then its revision bump
 *   6. complete — freeze the response into the reserved row
 *
 * Steps 1, 2, 5 and 6 are I/O and live here. Steps 3 and 4 turn on RULES, so
 * they live in `mealPlanningAction.logic.ts` and this module only sequences
 * them: `decideReplay` returns the verdict, `shapeStoredResponse` decides what
 * is stored, `readStoredResponse` decides what a replay returns. Nothing in
 * this file re-derives any of it, which is what keeps those rules testable
 * without a database (Rule 7 §7.1, §11). Conversely, nothing here speaks HTTP:
 * the status codes it moves around are values produced by the pure layer and
 * persisted, and the one error it raises is a typed class the controller maps
 * (Rule 7 §5, §8).
 *
 * Request validation is deliberately absent. Every keyed route parses its body
 * first — uuid, date, servings and revision checks answering 400
 * invalid_request — so by the time a request reaches this ledger its shape is
 * already settled, and re-checking it here would move a rule out of the parser
 * that owns it.
 *
 * Who calls what:
 *
 *   runKeyedAction — exactly three services: `mealPlan.service.ts` (generate,
 *     regenerate), `swap.service.ts` (commit), `plannedMealLog.service.ts`
 *     (log). There are deliberately no per-action wrappers: four thin wrappers
 *     is how one of them starts skipping the replay gate.
 *   withUserLock — additionally `preferences.service.ts` and
 *     `targets.service.ts`, whose saves are revisioned rather than keyed, and
 *     the grocery writes, which are state-setting (no key, no revision, and no
 *     `meal_plans.revision` bump — a check mark is not a plan change). Those
 *     need the serialisation but must never reserve a ledger row: putting a
 *     non-idempotent save into an exactly-once ledger would either lose the
 *     revision guarantee or pollute the ledger.
 *
 * Transactions stay short-lived, and the candidate plan is computed in memory
 * BEFORE the transaction opens, so the only thing between BEGIN and COMMIT is
 * database work. Nothing in this file performs network I/O.
 */

// Type-only use of the generated namespace, for the transaction-client and JSON
// column types. `nutrition.service.ts` imports it the same way; the alternative
// — hand-rolling Prisma's interactive-transaction deny list — would duplicate a
// type Prisma owns and drift from it.
import { Prisma } from '../generated/prisma';

import { IdempotencyConflictError } from './mealPlanning.errors';
import {
    ACTION_TYPES,
    KeyedActionResponseBodies,
    KeyedActionResponseBody,
    KeyedActionType,
    MealPlanningActionRecord,
    StoredActionResponse,
    decideReplay,
    readStoredResponse,
    shapeStoredResponse,
} from './mealPlanningAction.logic';

/* ---------------------------------------------------------------------------
 * The transaction boundary
 * ------------------------------------------------------------------------- */

/**
 * An open interactive transaction — never the global client.
 *
 * The type is the guard. `pg_advisory_xact_lock` is released at the end of the
 * transaction that took it, so on an autocommit client the lock would be gone
 * by the time the next statement ran and every guarantee below would silently
 * evaporate. Prisma's transaction client is also the type that cannot open a
 * nested transaction, which is the other half of "one transaction per keyed
 * write".
 */
export type MealPlanningTransactionClient = Prisma.TransactionClient;

/* ---------------------------------------------------------------------------
 * What a caller hands in, and what it gets back
 * ------------------------------------------------------------------------- */

/** A reserved — not yet completed — ledger row. */
export interface ActionReservation {
    readonly actionId: string;
    /**
     * Carried beside the id so {@link completeAction} cannot be called with a
     * mismatched pair: its `where` needs both, and an id-only write is exactly
     * the cross-user write Rule 7 §5.1 forbids.
     */
    readonly userId: string;
}

/**
 * The four columns that identify a keyed write.
 *
 * `fingerprint` is built by the caller with
 * `mealPlanningAction.logic.ts::buildRequestFingerprint`, which hashes the
 * method, action type, resource ids and canonical body together. It is passed
 * in rather than computed here because only the route knows its own method and
 * path ids — and because what makes two requests "the same request" is a rule,
 * which belongs in the pure layer.
 */
export interface KeyedActionParams<TAction extends KeyedActionType = KeyedActionType> {
    readonly userId: string;
    readonly actionType: TAction;
    readonly idempotencyKey: string;
    readonly fingerprint: string;
}

/**
 * The ids a keyed write creates, recorded on the ledger row.
 *
 * All optional: generate records only a plan, swap a plan and a planned meal,
 * log all three. An explicit `null` is written as `null`; an absent member
 * leaves the column untouched.
 */
export interface KeyedActionCreatedIds {
    readonly mealPlanId?: string | null;
    readonly mealPlanMealId?: string | null;
    readonly mealEntryId?: string | null;
}

/**
 * What `work` returns: the response body, the revision the action produced, and
 * any ids it created.
 *
 * The body is tied to the action type, so a swap cannot be completed with a
 * generate's response shape — that is a compile error rather than a replay that
 * returns the wrong thing. Returning the ids here is why no caller needs to
 * reach for {@link completeAction} itself: an id discovered anywhere inside
 * `work` simply rides out on the completion.
 */
export interface KeyedActionCompletion<TAction extends KeyedActionType = KeyedActionType>
    extends KeyedActionCreatedIds {
    readonly body: KeyedActionResponseBodies[TAction];
    readonly planRevisionAfter: number;
}

/**
 * Exactly what the controller sends, whether this was the first attempt or the
 * hundredth retry of a committed one.
 *
 * There is deliberately no "was this a replay" flag: a client must never be
 * able to tell, and a flag is how a controller starts adding a header or
 * changing a status that lets it. `body` is `unknown` for the same honesty — on
 * a replay it comes back out of a `jsonb` column, so the pure layer types it
 * `unknown` and this module propagates that rather than asserting a shape it
 * did not verify. The controller only forwards it.
 */
export interface KeyedActionResult {
    readonly status: number;
    readonly body: unknown;
    readonly planRevisionAfter: number | null;
}

/* ---------------------------------------------------------------------------
 * Row shape and mapping
 * ------------------------------------------------------------------------- */

/**
 * The `meal_plan_actions` columns this module reads, in database spelling. A
 * Prisma row satisfies it structurally; declaring it locally keeps the mapper
 * readable and matches `nutrition.service.ts`'s row interfaces.
 */
interface MealPlanningActionRow {
    id: string;
    user_id: string;
    idempotency_key: string;
    action_type: string;
    request_fingerprint: string;
    meal_plan_id: string | null;
    meal_plan_meal_id: string | null;
    meal_entry_id: string | null;
    response_status: number | null;
    response_snapshot: unknown;
    plan_revision_after: number | null;
    created_at: Date;
}

/** The reservation's `RETURNING id`. */
interface ReservedActionRow {
    id: string;
}

const isKeyedActionType = (value: string): value is KeyedActionType =>
    (ACTION_TYPES as readonly string[]).includes(value);

/**
 * One row, one mapper (Rule 7 §6): snake_case column → the camelCase record the
 * pure layer declared for exactly this purpose.
 *
 * An `action_type` outside the closed set means something other than this
 * service wrote the row, and replaying a response whose shape nothing can vouch
 * for is worse than failing — so it is reported. It cannot fire on a legitimate
 * replay: the action type is hashed into the fingerprint, so a row whose
 * fingerprint matches necessarily carries a matching action type.
 */
const toActionRecord = (row: MealPlanningActionRow): MealPlanningActionRecord => {
    if (!isKeyedActionType(row.action_type)) {
        throw new Error(
            `meal_plan_actions row ${row.id} has action_type "${row.action_type}", which is not one of ` +
                `${ACTION_TYPES.join(', ')}. Refusing to replay a response of unknown shape.`,
        );
    }

    return {
        id: row.id,
        userId: row.user_id,
        idempotencyKey: row.idempotency_key,
        actionType: row.action_type,
        requestFingerprint: row.request_fingerprint,
        mealPlanId: row.meal_plan_id,
        mealPlanMealId: row.meal_plan_meal_id,
        mealEntryId: row.meal_entry_id,
        responseStatus: row.response_status,
        responseSnapshot: row.response_snapshot,
        planRevisionAfter: row.plan_revision_after,
        createdAt: row.created_at,
    };
};

/**
 * The one cast in this module.
 *
 * The response DTOs in `types/mealPlanning.ts` are interfaces, and a TypeScript
 * interface has no implicit index signature, so it is not structurally
 * assignable to `Prisma.InputJsonValue` however JSON-safe its members are.
 * `shapeStoredResponse` has already tied the body to its action type, so the
 * value is checked before it reaches here; this only restates it for the column.
 */
const asJsonColumnValue = (body: KeyedActionResponseBody): Prisma.InputJsonValue =>
    body as unknown as Prisma.InputJsonValue;

/* ---------------------------------------------------------------------------
 * Step 1 — the per-user lock
 * ------------------------------------------------------------------------- */

/**
 * Takes the per-user advisory lock, then runs `work` inside it.
 *
 * Call this as the FIRST thing in the transaction. One lock per user serialises
 * generate against generate for different overlapping weeks, regenerate against
 * swap, swap against log, swap against a grocery toggle, and a preference or
 * target save against any generation — so every check downstream runs against
 * settled state instead of racing it. The partial unique index on active
 * `(user_id, start_date)` stays a backstop, not the mechanism.
 *
 * `pg_advisory_xact_lock` rather than a session lock: it is released at COMMIT
 * **and at ROLLBACK**, so there is no unlock call to forget and no way for a
 * failed action to leak a lock and wedge the user.
 *
 * Two details are load-bearing. The statement runs through `$executeRaw`, not
 * `$queryRaw`: the function returns `void`, and Prisma cannot deserialize a
 * `void` column — `$queryRaw` fails outright ("Failed to deserialize column of
 * type 'void'"). And `userId` is a bind parameter, never interpolated text; the
 * `'meal-planning:'` prefix stays a SQL literal because it is a compile-time
 * constant that namespaces this feature's keys away from any other advisory
 * lock, and because two bind parameters either side of `||` would leave
 * PostgreSQL unable to resolve the operator.
 *
 * `hashtext` narrows the user id to 32 bits, so two ids can in principle share
 * a lock. That costs those two users a little serialisation and nothing else: a
 * false share is still a correct mutex.
 */
export const withUserLock = async <TResult>(
    tx: MealPlanningTransactionClient,
    userId: string,
    work: (tx: MealPlanningTransactionClient) => Promise<TResult>,
): Promise<TResult> => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('meal-planning:' || ${userId}))`;

    return work(tx);
};

/* ---------------------------------------------------------------------------
 * Step 2 — reserve, and step 3 — replay
 * ------------------------------------------------------------------------- */

/**
 * Claims the key, or reports that it was already claimed.
 *
 * `ON CONFLICT … DO NOTHING RETURNING id` returns one row when the INSERT went
 * in and no rows when it did not, which is the whole test — a single atomic
 * statement rather than a read followed by a write that another transaction
 * could slip between. The conflict target is named explicitly so only the
 * `(user_id, idempotency_key)` unique index is absorbed; any other constraint
 * violation still raises rather than passing silently as a duplicate.
 *
 * The row it creates is PENDING: `response_status`, `response_snapshot` and
 * `plan_revision_after` stay NULL until {@link completeAction}. Because the
 * reservation and the write share one transaction, that pending row is visible
 * only inside this transaction and disappears with it on rollback — so a
 * lock-serialised same-key request always finds either no row (proceed) or a
 * completed one (replay), and never has to guess about a half-finished action.
 */
const reserveAction = async (
    tx: MealPlanningTransactionClient,
    params: KeyedActionParams,
): Promise<ActionReservation | null> => {
    const reserved = await tx.$queryRaw<ReservedActionRow[]>`
        INSERT INTO meal_plan_actions (user_id, idempotency_key, action_type, request_fingerprint)
        VALUES (${params.userId}, ${params.idempotencyKey}, ${params.actionType}, ${params.fingerprint})
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING id
    `;

    if (reserved.length === 0) {
        return null;
    }

    return { actionId: reserved[0].id, userId: params.userId };
};

/**
 * Re-reads a key's row. Owner-scoped by construction: the unique constraint it
 * looks up is `(user_id, idempotency_key)`, so one user's key can never address
 * another's row.
 */
const readAction = async (
    tx: MealPlanningTransactionClient,
    userId: string,
    idempotencyKey: string,
): Promise<MealPlanningActionRecord | null> => {
    const row = await tx.meal_plan_actions.findUnique({
        where: { user_id_idempotency_key: { user_id: userId, idempotency_key: idempotencyKey } },
    });

    return row === null ? null : toActionRecord(row);
};

/**
 * The reservation conflicted, so this key has been used before: replay it or
 * reject it.
 *
 * **This runs before any plan status or revision check, and that ordering is
 * the point.** A client whose response was lost, and whose plan has since moved
 * on through another device's swap, must still be able to learn that its own
 * action succeeded. Check the revision first and it is answered `409 stale_plan`
 * forever, retrying something that is already done. `decideReplay` is handed a
 * record with a single field for exactly this reason: there is no way to pass it
 * a status or a revision, so there is no way to order it wrong.
 *
 * The stored status and body are returned unchanged — never re-derived from the
 * action type — so every replay of a committed action is identical to every
 * other. (`jsonb` normalises key order at rest, so assert on the value rather
 * than on the serialized text.)
 */
const replayReservedAction = async (
    tx: MealPlanningTransactionClient,
    params: KeyedActionParams,
): Promise<KeyedActionResult> => {
    const existing = await readAction(tx, params.userId, params.idempotencyKey);
    const verdict = decideReplay(existing, params.fingerprint);

    if (verdict === 'conflict') {
        throw new IdempotencyConflictError();
    }

    if (verdict === 'proceed' || existing === null) {
        // The INSERT was absorbed by a row that then could not be read, while
        // this transaction holds the user's lock. Under READ COMMITTED that
        // cannot happen: the conflicting row is committed, so the read that
        // follows sees it. Reporting it keeps a genuine anomaly loud instead of
        // silently doing the work twice.
        throw new Error(
            `Idempotency key for ${params.actionType} conflicted on insert but no meal_plan_actions row could ` +
                'be read back under the per-user lock. Refusing to repeat a write that may already have committed.',
        );
    }

    const stored = readStoredResponse(existing);

    if (stored === null) {
        throw new Error(
            `meal_plan_actions row ${existing.id} is still pending, which the per-user advisory lock is ` +
                'supposed to make unobservable. Refusing to invent a response for a write of unknown outcome.',
        );
    }

    return { status: stored.status, body: stored.body, planRevisionAfter: stored.planRevisionAfter };
};

/* ---------------------------------------------------------------------------
 * Step 6 — completion
 * ------------------------------------------------------------------------- */

/**
 * Freezes a finished action's response into its reserved row.
 *
 * {@link runKeyedAction} already does this from the completion `work` returns,
 * which is the normal path; this is exported for a caller that genuinely has to
 * write the row itself, and such a caller must not also return a completion, or
 * the row would be written twice.
 *
 * The `where` carries the owner key beside the id (Rule 7 §5.1). That is not
 * ceremony here: an id-only predicate would let one user's retry overwrite the
 * stored response of another user's action. The affected-row count is checked
 * rather than assumed, because a reservation that has vanished mid-transaction
 * means the invariant above is broken and the response would otherwise be
 * dropped in silence.
 */
export const completeAction = async (
    tx: MealPlanningTransactionClient,
    reservation: ActionReservation,
    response: StoredActionResponse,
    createdIds: KeyedActionCreatedIds = {},
): Promise<void> => {
    const completed = await tx.meal_plan_actions.updateMany({
        where: { id: reservation.actionId, user_id: reservation.userId },
        data: {
            response_status: response.responseStatus,
            response_snapshot: asJsonColumnValue(response.responseSnapshot),
            plan_revision_after: response.planRevisionAfter,
            ...(createdIds.mealPlanId !== undefined ? { meal_plan_id: createdIds.mealPlanId } : {}),
            ...(createdIds.mealPlanMealId !== undefined ? { meal_plan_meal_id: createdIds.mealPlanMealId } : {}),
            ...(createdIds.mealEntryId !== undefined ? { meal_entry_id: createdIds.mealEntryId } : {}),
        },
    });

    if (completed.count !== 1) {
        throw new Error(
            `Completing meal_plan_actions row ${reservation.actionId} updated ${String(completed.count)} rows ` +
                'instead of 1. The reservation this transaction created is gone, so the action cannot be recorded.',
        );
    }
};

/* ---------------------------------------------------------------------------
 * The sequence
 * ------------------------------------------------------------------------- */

/**
 * Runs one keyed write at most once.
 *
 * Lock, reserve, and — if the key is new — run `work` and freeze its response.
 * If the key is not new, replay the stored response verbatim or answer
 * `IdempotencyConflictError` (409), before `work` or any plan check is reached.
 *
 * `work` receives this transaction and the reservation, and must use that
 * client: opening its own transaction or reaching for the global Prisma client
 * would put its writes outside the lock and outside the rollback that protects
 * them. It runs AFTER the replay gate, so the caller's own status and revision
 * checks — `PlanNotActiveError` for a superseded or ended plan,
 * `StalePlanError` for a revision that has moved — belong at the top of `work`,
 * where they cannot pre-empt a replay. Those checks live with the caller
 * because it is the service that knows its own plan shape.
 *
 * Anything `work` throws propagates untouched: the transaction rolls back, the
 * reservation disappears with it, no plan or meal is left half-written, and the
 * key is free to be retried. A failed action deliberately persists nothing, so
 * there is no failure record to write and nothing here catches in order to
 * write one.
 */
export const runKeyedAction = async <TAction extends KeyedActionType>(
    tx: MealPlanningTransactionClient,
    params: KeyedActionParams<TAction>,
    work: (
        tx: MealPlanningTransactionClient,
        reservation: ActionReservation,
    ) => Promise<KeyedActionCompletion<TAction>>,
): Promise<KeyedActionResult> =>
    withUserLock(tx, params.userId, async (lockedTx) => {
        const reservation = await reserveAction(lockedTx, params);

        if (reservation === null) {
            return replayReservedAction(lockedTx, params);
        }

        const completion = await work(lockedTx, reservation);
        const response = shapeStoredResponse(params.actionType, completion.body, completion.planRevisionAfter);

        await completeAction(lockedTx, reservation, response, completion);

        // The stored values, so the first response and every later replay of it
        // are the same response.
        return {
            status: response.responseStatus,
            body: response.responseSnapshot,
            planRevisionAfter: response.planRevisionAfter,
        };
    });
