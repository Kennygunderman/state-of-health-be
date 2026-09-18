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
 *   3. replay   — a key seen before either replays its stored response
 *                 unchanged ({@link KeyedActionResult} says what "unchanged"
 *                 guarantees) or is a conflict; BOTH decided before any plan
 *                 check
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
 *     ledger, to OPEN the transaction, AND every service that needs only the
 *     per-user lock (the revisioned preference and target saves, and the
 *     state-setting grocery writes). It is the sanctioned source of the client
 *     the functions below accept: their parameter type refuses the global
 *     Prisma client, because on an autocommit client the lock and the
 *     reservation would each commit alone and none of the guarantees above
 *     would hold. The same branded type is what a multi-write helper inside
 *     one of those services asks for when it must run under the lock —
 *     `MealPlanningTransactionClient` is the only way a signature can say
 *     "an open interactive transaction, never the global client".
 *   runKeyedAction — exactly three services: `mealPlan.service.ts` (generate,
 *     regenerate), `swap.service.ts` (commit), `plannedMealLog.service.ts`
 *     (log). There are deliberately no per-action wrappers: four thin wrappers
 *     is how one of them starts skipping the replay gate.
 *   replayCommittedKeyedAction — the same sequence asked ONE TURN EARLIER, by a
 *     caller that must judge mutable state before it can open its own
 *     transaction: today's date in the user's zone, a setup status, a pinned
 *     revision, a five-second candidate search. Both generation entry points
 *     use it, because every one of those refusals would otherwise pre-empt the
 *     replay a lost response entitles the client to. It lives here rather than
 *     with them because what a used key means is this module's decision, and a
 *     second implementation would be a second replay policy.
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
 * NOTHING A CLIENT RECEIVES SAYS WHICH ATTEMPT IT WAS. `replayed` below is
 * SERVER-INTERNAL: `mealPlanning.controller.ts` reads it for the event it emits
 * and copies it into no body, no header and no status, because a client able to
 * tell a replay from the original answer is exactly what §0.5.1 forbids. The
 * `replayed` paragraph further down states that contract in full, and why the
 * flag exists at all.
 *
 * `body` is `unknown` for a related honesty — on a replay it comes back out of a
 * `jsonb` column, so the pure layer types it `unknown` and this module
 * propagates that rather than asserting a shape it did not verify. The
 * controller only forwards it.
 *
 * **The two attempts agree on the status, on the revision, and on the BYTES the
 * body serialises to.** They reach the body by different routes — a fresh action
 * answers from memory ({@link runKeyedAction} returns what `shapeStoredResponse`
 * froze), while only a replay reads `meal_plan_actions.response_snapshot` back —
 * and what makes the two routes agree is that both serialise a CANONICALLY
 * ORDERED value. `shapeStoredResponse` stores the body with its object keys
 * already in the order `jsonb` would impose (UTF-8 byte length, then bytes), so
 * the column holds the same key order it was given, and `readStoredResponse`
 * hands that order straight back. `JSON.stringify` of a replayed body therefore
 * equals `JSON.stringify` of the first one exactly, which is §0.9.2's
 * "byte-for-byte" read literally rather than approximated — no `json`-column
 * change and no schema change was needed to get there.
 *
 * Two things ride on that and are worth knowing before touching either
 * function. A body carrying a value with no faithful JSON representation — a
 * non-finite number, a `Date` or a Prisma `Decimal` a mapper forgot to convert,
 * a `bigint`, a cycle — is REFUSED by `canonicalizeResponseBody` rather than
 * written in a form the replay could not reproduce, so the transaction rolls
 * back and the key stays retryable. And a key whose value is `undefined` is
 * dropped on the way in, exactly as `JSON.stringify` drops it, so the stored
 * text and the served text cannot disagree about whether the field was there.
 * `readStoredResponse` in `mealPlanningAction.logic.ts` states the whole
 * contract.
 *
 * `planRevisionAfter` is a plain `number` in both directions. A fresh action
 * knows the revision it produced, and a replay is only ever answered from a row
 * whose three completion columns are all filled — a half-completed row is
 * reported, never answered — so there is no case in which a keyed response
 * exists without the revision it is required to carry.
 *
 * `replayed` IS THE ONE THING THE CALLER CAN LEARN THAT THE CLIENT CANNOT. It
 * says which of the two routes above answered, and it exists for the server
 * event the HTTP edge emits: without it an operator reading the log cannot tell
 * a committed write from the retry that replayed it, which is the difference
 * between "this user generated a plan twice" and "this user's first response
 * was lost". It is deliberately NOT part of any response — no handler puts it
 * in a body, a header or a status — because a client that could see it would be
 * able to distinguish a replay from the original answer, and §0.5.1 requires
 * exactly the opposite ("a client can never distinguish a replay from the
 * original response"). The two construction sites below are the only places it
 * is set, and they are the same two points at which the body's route diverges,
 * so the flag cannot drift from the thing it describes.
 */
export interface KeyedActionResult {
    readonly status: number;
    readonly body: unknown;
    readonly planRevisionAfter: number;
    readonly replayed: boolean;
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
 * `shapeStoredResponse` has already tied the body to its action type AND walked
 * it through `canonicalizeResponseBody`, which refuses anything a JSON column
 * cannot hold faithfully — so by the time a value reaches here it is plain JSON
 * data in the column's own key order, and this only restates that for Prisma.
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
 * action type — so every replay of a committed action answers with the same
 * status, the same revision and a body that serialises to the same bytes as
 * every other, the first response included (see {@link KeyedActionResult}). A
 * row's age is never consulted: rows are kept indefinitely and a committed
 * action replays for as long as its row exists.
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

    return {
        status: stored.status,
        body: stored.body,
        planRevisionAfter: stored.planRevisionAfter,
        // The only path that reads `response_snapshot` back, so the only path
        // that can be a replay.
        replayed: true,
    };
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
 *    revision or created ids. Replaying the FIRST response depends on the stored
 *    response never changing after it is written, and nothing but this predicate
 *    enforces that: the columns are nullable by design, so the database will
 *    happily accept a second write.
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
 * If the key is not new, replay the stored response unchanged or answer
 * `IdempotencyConflictError` (409), before `work` or any plan check is reached.
 * What a fresh answer and a replay of it are guaranteed to share, and what they
 * are not, is {@link KeyedActionResult}'s.
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

        // The stored values, never the caller's own object, so the first
        // response serialises from the same canonically ordered value the column
        // now holds. That is the half of the byte guarantee that lives on this
        // path: the replay path reads the column back, and the two texts can
        // only agree if this one answers from what was frozen (see
        // KeyedActionResult).
        return {
            status: response.responseStatus,
            body: response.responseSnapshot,
            planRevisionAfter: response.planRevisionAfter,
            // This transaction ran `work` and completed the reserved row, so
            // this is the commit itself and never a retry of one.
            replayed: false,
        };
    });

/* ---------------------------------------------------------------------------
 * The preflight — the same gate, asked before a caller does any work
 * ------------------------------------------------------------------------- */

/**
 * The rejection that rolls a preflight transaction back.
 *
 * Module-private and its own class, so {@link replayCommittedKeyedAction} can
 * recognise exactly its own rollback signal and let every other failure — a
 * conflict, a lock timeout, a connection fault — propagate untouched. A boolean
 * return from `work` could not do this: `work` must not RESOLVE, because a
 * resolved `work` is what makes {@link runKeyedAction} complete the reserved
 * row.
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
 *  * the stored {@link KeyedActionResult} — this key committed, so replay it
 *  * `null` — the key has never been used, so the caller proceeds
 *  * throws `IdempotencyConflictError` — the key exists with a different
 *    fingerprint, which is a different request wearing a used key (§0.5.2)
 *
 * WHY THIS EXISTS. §0.5.1 fixes the order of a keyed write: lock, then reserve
 * or replay, and a matching fingerprint "replay[s] the stored `response_status`
 * and `response_snapshot` verbatim and end[s] the transaction BEFORE any
 * revision or status check, so a committed action replays even when the plan has
 * since moved on". {@link runKeyedAction} honours that for everything inside its
 * transaction — but generation and regeneration must judge mutable state and run
 * a five-second candidate search BEFORE the transaction opens, because §0.5.1
 * equally requires the candidate week to be "computed in memory before the
 * transaction" (a transaction holding the per-user lock for a five-second search
 * would block every other write that user makes). Those pre-transaction
 * refusals sit in front of the replay gate, and for a regeneration one of them
 * is CERTAIN to fire on the retry path: a successful regeneration supersedes the
 * very plan the request pinned, so the immediate same-key retry — exactly what a
 * client sends when the response was lost — would be answered
 * `409 plan_not_active` and could never reach its stored `201`. A generation
 * fails the same way less deterministically, through the preference gate, a
 * moved revision, a start-date window the clock has shifted under it, or a
 * search that now reports `no_matching_meals`.
 *
 * WHY IT REUSES `runKeyedAction` RATHER THAN READING THE LEDGER ITSELF. The
 * fingerprint comparison, the pending-row invariant and the stored-response
 * shaping all live behind functions this module keeps private —
 * `reserveAction`, `readAction` and `replayReservedAction`, §0.5.1's
 * reserve-or-replay step — over the pure `decideReplay` / `readStoredResponse`.
 * A second implementation would be a second replay policy, and the two would
 * drift on the first change to either. So this calls the authoritative gate and
 * supplies a `work` that cannot succeed:
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
 * away. The gate inside the caller's own transaction stays the authority: a key
 * that commits on another connection WHILE this request is searching must still
 * replay rather than reserve twice, and only a gate in the publishing
 * transaction can see that. This preflight is an early exit on the ERROR path —
 * it turns a refusal that would have pre-empted a replay into the replay itself
 * — and it deliberately makes no decision the gate does not make again.
 *
 * WHY IT LIVES HERE. It is the keyed-write sequence asked one turn earlier, so
 * it belongs to the module that owns that sequence (Rule `backend-architecture`
 * §5, §7.1): one file decides what a used key means, and a caller that must
 * judge mutable state before its transaction imports this rather than writing a
 * variant of it. It is generic in exactly the way `runKeyedAction` is — it takes
 * {@link KeyedActionParams} and nothing about plans — and it is not a
 * per-action wrapper; there are still none of those.
 *
 * The transaction is two statements long — the advisory lock and the
 * reservation attempt — so the serialisation it costs the user is negligible
 * beside the work that follows it. BOTH OF THEM ARE UNDONE BEFORE THIS RETURNS
 * `null`: the lock is released and the attempted reservation vanishes at the
 * rollback, which is what lets a caller that runs later work — a five-second
 * search, or `mealPlan.service.ts::raiseInjectedGenerationFault` — still say
 * truthfully that no lock is held and no ledger row exists at that point.
 */
export const replayCommittedKeyedAction = async (
    params: KeyedActionParams,
): Promise<KeyedActionResult | null> => {
    const rollback = new KeyedActionPreflightRollback(params.actionType);

    try {
        return await withMealPlanningTransaction((tx) =>
            runKeyedAction(tx, params, () => Promise.reject(rollback)),
        );
    } catch (error) {
        if (error === rollback || error instanceof KeyedActionPreflightRollback) {
            return null;
        }

        throw error;
    }
};
