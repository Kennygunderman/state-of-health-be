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
 *   6. complete — freeze the response into the reserved row, ONCE: the
 *                 completion matches only a row that is still pending, so a
 *                 duplicate can never rewrite a stored response
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
 *   withMealPlanningTransaction — every service that writes through this
 *     ledger, to OPEN the transaction. It is the sanctioned source of the
 *     client the functions below accept: their parameter type refuses the
 *     global Prisma client, because on an autocommit client the lock and the
 *     reservation would each commit alone and none of the guarantees above
 *     would hold.
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

// The generated namespace, for the transaction-client and JSON column types and
// for `Prisma.DbNull` — the value that spells "IS NULL" for a nullable `jsonb`
// column in a `where`. `nutrition.service.ts` imports it the same way; the
// alternative — hand-rolling Prisma's interactive-transaction deny list — would
// duplicate a type Prisma owns and drift from it.
import { Prisma } from '../generated/prisma';
// The shared singleton, so the one place that opens a meal-planning
// transaction is this module rather than each calling service.
import { prisma } from '../prisma/client';

import { IdempotencyConflictError } from './mealPlanning.errors';
import {
    ACTION_TYPES,
    ActionLedgerIntegrityError,
    KeyedActionCreatedIds,
    KeyedActionResponseBodies,
    KeyedActionResponseBody,
    KeyedActionType,
    MealPlanningActionRecord,
    StoredActionResponse,
    assertInteractiveTransactionClient,
    classifyActionCompletion,
    decideReplay,
    findMissingCompletionFields,
    readStoredResponse,
    resolveCreatedIdColumns,
    shapeStoredResponse,
} from './mealPlanningAction.logic';

/* ---------------------------------------------------------------------------
 * The transaction boundary
 * ------------------------------------------------------------------------- */

/**
 * An open interactive transaction — never the global client.
 *
 * `Prisma.TransactionClient` alone does not say that. It is
 * `Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" |
 * "$use" | "$extends">`, which is structurally WIDER than `PrismaClient`, so
 * the global client satisfies it and `runKeyedAction(prisma, …)` used to
 * compile. It must not: `pg_advisory_xact_lock` is released at the end of the
 * transaction that took it, so on the autocommit client the lock would be gone
 * the moment its own statement returned, the reservation would commit by
 * itself, and a failure part-way through would leave a permanently pending row
 * that no later request can complete or replay. Every guarantee in this file
 * would evaporate in silence.
 *
 * Intersecting the six deny-list members as `never` is what closes it. A
 * genuine transaction client HAS none of them, so it still satisfies this type
 * with no cast and no wrapper at the call site; the global client HAS all of
 * them, so it is now a compile error wherever it is passed. Prisma's transaction
 * client is also the one that cannot open a nested transaction, which is the
 * other half of "one transaction per keyed write".
 *
 * The type is the first guard, not the only one:
 * {@link assertInteractiveTransactionClient} repeats the check at run time for
 * a caller that arrives through a cast, from JavaScript or from a test double,
 * and {@link withMealPlanningTransaction} is the sanctioned way to obtain one.
 */
export type MealPlanningTransactionClient = Prisma.TransactionClient & {
    readonly $connect?: never;
    readonly $disconnect?: never;
    readonly $on?: never;
    readonly $transaction?: never;
    readonly $use?: never;
    readonly $extends?: never;
};

/** The Prisma transaction options this module simply forwards. */
export interface MealPlanningTransactionOptions {
    readonly maxWait?: number;
    readonly timeout?: number;
    readonly isolationLevel?: Prisma.TransactionIsolationLevel;
}

/**
 * Opens one interactive transaction and hands `work` a client the ledger
 * accepts.
 *
 * This exists so no caller has to reason about where its client came from: a
 * service that needs the lock or the ledger calls this, writes its statements
 * against the client it is given, and gets the whole sequence — lock,
 * reservation, write, completion — inside a single transaction that rolls back
 * as one unit. The client is validated before `work` sees it, so a future
 * change to Prisma's transaction client cannot quietly turn this into an
 * autocommit path.
 *
 * Options are forwarded rather than defaulted: the timeout a plan publish needs
 * is a property of that write, and the service issuing it is the only thing
 * that knows. What this module does require is that the transaction stay
 * short-lived — no vendor call, no model call, nothing but database work
 * between BEGIN and COMMIT (§0.5.1).
 */
export const withMealPlanningTransaction = async <TResult>(
    work: (tx: MealPlanningTransactionClient) => Promise<TResult>,
    options?: MealPlanningTransactionOptions,
): Promise<TResult> =>
    prisma.$transaction(async (tx) => {
        assertInteractiveTransactionClient(tx, 'withMealPlanningTransaction');

        return work(tx);
    }, options);

/* ---------------------------------------------------------------------------
 * What a caller hands in, and what it gets back
 * ------------------------------------------------------------------------- */

/** A reserved — not yet completed — ledger row. */
export interface ActionReservation<TAction extends KeyedActionType = KeyedActionType> {
    readonly actionId: string;
    /**
     * Carried beside the id so {@link completeAction} cannot be called with a
     * mismatched pair: its `where` needs both, and an id-only write is exactly
     * the cross-user write Rule 7 §5.1 forbids.
     */
    readonly userId: string;
    /**
     * The action this row was reserved for, carried so the completion knows
     * which ids it must record without being told a second time — and so it
     * cannot be told a different action's ids than the row was reserved for.
     */
    readonly actionType: TAction;
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
 * The ids a keyed write records, per action.
 *
 * Re-exported from the pure layer, which owns both the table of which ids
 * belong to which action and the runtime check that enforces it, so this
 * module's public surface still names the type its callers use. A generate and
 * a regenerate each record the plan they published; a swap records the plan and
 * the planned meal it replaced; a log records the plan, the meal and the diary
 * entry it created — each REQUIRED and non-null for its action, and an id
 * belonging to no other.
 */
export type { KeyedActionCreatedIds };

/**
 * What `work` returns: the response body, the revision the action produced, and
 * the ids its action records.
 *
 * Both halves are tied to the action type. A swap cannot be completed with a
 * generate's response shape, and a generate cannot be completed without the
 * plan id it published or with a diary entry id it never created — compile
 * errors, rather than a replay that returns the wrong thing or a ledger row
 * that misdescribes its own write. Returning the ids here is why no caller
 * needs to reach for {@link completeAction} itself: an id discovered anywhere
 * inside `work` simply rides out on the completion.
 */
export type KeyedActionCompletion<TAction extends KeyedActionType = KeyedActionType> = KeyedActionCreatedIds<TAction> & {
    readonly body: KeyedActionResponseBodies[TAction];
    readonly planRevisionAfter: number;
};

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
 *
 * `planRevisionAfter` is a plain `number` in both directions. A fresh action
 * knows the revision it produced, and a replay is only ever answered from a row
 * whose three completion columns are all filled — a half-completed row is
 * reported, never answered — so there is no case in which a keyed response
 * exists without the revision it is required to carry.
 */
export interface KeyedActionResult {
    readonly status: number;
    readonly body: unknown;
    readonly planRevisionAfter: number;
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
    // Before the lock, not after: a lock taken on the autocommit client is
    // released as its own statement returns, so everything after it would run
    // unserialised while looking exactly like this code path. Checked here
    // rather than only at `runKeyedAction` because the preference, target and
    // grocery writes take the lock through this function alone.
    assertInteractiveTransactionClient(tx, 'withUserLock');

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
const reserveAction = async <TAction extends KeyedActionType>(
    tx: MealPlanningTransactionClient,
    params: KeyedActionParams<TAction>,
): Promise<ActionReservation<TAction> | null> => {
    const reserved = await tx.$queryRaw<ReservedActionRow[]>`
        INSERT INTO meal_plan_actions (user_id, idempotency_key, action_type, request_fingerprint)
        VALUES (${params.userId}, ${params.idempotencyKey}, ${params.actionType}, ${params.fingerprint})
        ON CONFLICT (user_id, idempotency_key) DO NOTHING
        RETURNING id
    `;

    if (reserved.length === 0) {
        return null;
    }

    return { actionId: reserved[0].id, userId: params.userId, actionType: params.actionType };
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
 * Re-reads a reservation by its id, owner-scoped (Rule 7 §5.1).
 *
 * Called on exactly one path: a completion that matched no row, where the only
 * useful next thing is to say why. `findFirst` rather than `findUnique` because
 * the predicate is the id AND the owner — the pair is what makes one user's id
 * unable to address another user's row.
 */
const readReservedAction = async (
    tx: MealPlanningTransactionClient,
    reservation: ActionReservation,
): Promise<MealPlanningActionRecord | null> => {
    const row = await tx.meal_plan_actions.findFirst({
        where: { id: reservation.actionId, user_id: reservation.userId },
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
 * than on the serialized text.) A row's age is never consulted: rows are kept
 * indefinitely and a committed action replays for as long as its row exists.
 *
 * Two abnormal shapes are reported rather than answered. A PENDING row is
 * handled below; a HALF-COMPLETED one raises `ActionLedgerIntegrityError` out
 * of `readStoredResponse`, because a row holding a status and a body but no
 * revision records an outcome no completion in this ledger could have written,
 * and answering the client from it would report a result the ledger cannot
 * vouch for.
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
 * Says why a completion matched no row, having read the row back.
 *
 * Separated from {@link completeAction} so the write path stays one statement
 * and one check: everything here runs only when the compare-and-set has
 * already failed. Reading is safe at that point — `updateMany` matching nothing
 * is not an error, so the transaction is still usable — and it is what turns
 * "0 rows" into the one thing an operator needs to know.
 */
const failedCompletion = async (
    tx: MealPlanningTransactionClient,
    reservation: ActionReservation,
    matched: number,
): Promise<Error> => {
    if (matched > 1) {
        return new Error(
            `Completing meal_plan_actions row ${reservation.actionId} matched ${String(matched)} rows. The ` +
                'primary key cannot match more than one row, so the ledger is not the table this ledger thinks ' +
                'it is.',
        );
    }

    const row = await readReservedAction(tx, reservation);

    if (row === null) {
        return new Error(
            `Completing meal_plan_actions row ${reservation.actionId} matched no row: the reservation this ` +
                `transaction created for user ${reservation.userId} is gone, so the action cannot be recorded.`,
        );
    }

    const state = classifyActionCompletion(row);

    if (state === 'completed') {
        // The point of the compare-and-set. The first response stands: it is
        // what the client has already been told, or will be told on its next
        // retry, and overwriting it here would make two retries of one action
        // disagree about what happened.
        return new Error(
            `meal_plan_actions row ${row.id} is already completed with status ${String(row.responseStatus)} at ` +
                `plan revision ${String(row.planRevisionAfter)}, so this completion updated no row. A completed ` +
                'action is frozen — its stored response is what every replay returns — and this ' +
                `${reservation.actionType} attempted to record a second outcome over it. The transaction is ` +
                'rolled back rather than allowing the first response to be rewritten.',
        );
    }

    if (state === 'corrupt') {
        return new ActionLedgerIntegrityError(findMissingCompletionFields(row), row.id);
    }

    return new Error(
        `meal_plan_actions row ${row.id} is still pending, yet completing it updated no row. The compare-and-set ` +
            'predicate and the pending state disagree, which means one of them no longer describes the ledger.',
    );
};

/**
 * Freezes a finished action's response into its reserved row — once, and only
 * while that row is still pending.
 *
 * {@link runKeyedAction} already does this from the completion `work` returns,
 * which is the normal path; this is exported for a caller that genuinely has to
 * write the row itself, and such a caller must not also return a completion, or
 * the row would be written twice.
 *
 * The `where` is a COMPARE-AND-SET, and that is the whole safety of it:
 *
 *  - the owner key sits beside the id (Rule 7 §5.1) — an id-only predicate
 *    would let one user's retry overwrite another user's stored response;
 *  - the three completion columns must still be NULL, which is exactly the
 *    pending state §0.5.1 defines. A row that has already completed therefore
 *    matches nothing, so a duplicate or misordered completion updates ZERO
 *    rows and fails instead of silently replacing the stored status, body,
 *    revision or created ids. Verbatim first-response replay depends on the
 *    stored response never changing after it is written, and nothing but this
 *    predicate enforces that: the columns are nullable by design, so the
 *    database will happily accept a second write.
 *
 * The created ids are resolved through the pure per-action rule first, so a
 * completion that does not describe its own action aborts the transaction
 * before any of it is recorded — and all three id columns are written
 * explicitly, so a completed row never inherits a value this ledger did not
 * choose.
 */
export const completeAction = async <TAction extends KeyedActionType>(
    tx: MealPlanningTransactionClient,
    reservation: ActionReservation<TAction>,
    response: StoredActionResponse,
    createdIds: KeyedActionCreatedIds<TAction>,
): Promise<void> => {
    assertInteractiveTransactionClient(tx, 'completeAction');

    const columns = resolveCreatedIdColumns(reservation.actionType, createdIds);

    const completed = await tx.meal_plan_actions.updateMany({
        where: {
            id: reservation.actionId,
            user_id: reservation.userId,
            response_status: null,
            response_snapshot: { equals: Prisma.DbNull },
            plan_revision_after: null,
        },
        data: {
            response_status: response.responseStatus,
            response_snapshot: asJsonColumnValue(response.responseSnapshot),
            plan_revision_after: response.planRevisionAfter,
            meal_plan_id: columns.mealPlanId,
            meal_plan_meal_id: columns.mealPlanMealId,
            meal_entry_id: columns.mealEntryId,
        },
    });

    if (completed.count !== 1) {
        throw await failedCompletion(tx, reservation, completed.count);
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
 * `tx` must be an open interactive transaction — obtain it from
 * {@link withMealPlanningTransaction}. The type refuses the global client and
 * the lock re-checks it at run time, because on the autocommit client the lock
 * and the reservation would each commit alone and nothing below would hold.
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
 * What `work` returns is the whole record of the action: the response body, the
 * revision it produced, and the ids its action records (a plan for a generate
 * or regenerate, a plan and a planned meal for a swap, those and the diary
 * entry for a log). Each is required for its action, so an action cannot be
 * completed without the ids that make its ledger row traceable.
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
        reservation: ActionReservation<TAction>,
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
