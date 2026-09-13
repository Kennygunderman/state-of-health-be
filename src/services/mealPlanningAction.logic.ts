/**
 * The pure half of the meal-planning write ledger (Agent Action Plan §0.5.1,
 * "Plan write-safety model").
 *
 * Four user actions — generate, regenerate, swap and log — must each happen AT
 * MOST ONCE however many times a flaky network makes the client retry. The
 * mechanism that guarantees it is one transaction per keyed write:
 *
 *   1. take the per-user advisory lock
 *   2. reserve the row: INSERT … ON CONFLICT (user_id, idempotency_key)
 *      DO NOTHING RETURNING id
 *   3. if nothing came back, {@link decideReplay} — replay the stored response
 *      unchanged ({@link readStoredResponse} states exactly what that means for
 *      the status, the revision and the body) and end the transaction, or answer
 *      409 idempotency_conflict
 *   4. ONLY THEN check the plan's status and revision
 *   5. do the work, bump `meal_plans.revision`
 *   6. complete the reserved row with {@link shapeStoredResponse}
 *
 * Steps 1, 2 and 5 are I/O and live in `mealPlanningAction.service.ts`. Steps
 * 3, 4 and 6 turn on RULES — what makes two requests the same request, what a
 * repeated key means, and what a replay returns — and those live here, because
 * Rule 7 §11 is explicit that "if you find yourself needing a database to test
 * a *rule*, the rule is in the wrong layer — extract it". Everything in this
 * file is therefore deterministic and synchronous, with no Prisma, no I/O, no
 * `process.env` — and no clock AT ALL. That last one is a policy, not an
 * omission: a `meal_plan_actions` row NEVER expires. §0.5.1 retains rows
 * indefinitely (they are small, user-scoped and cascade on user deletion), so a
 * committed action stays replayable however old it is, and nothing here may
 * make a replay conditional on age. The seven-day guard of §0.7.2 belongs to
 * the CLIENT's persisted `pendingIntents` and is implemented in the mobile
 * store; putting a copy of it here would invite a future caller to expire a row
 * the server has promised to replay. The lock-and-reserve behaviour is covered
 * against real PostgreSQL by `src/__tests__/api/concurrency.test.ts`; every
 * rule below is covered with no database at all by
 * `__tests__/mealPlanningAction.logic.test.ts`.
 *
 * The bugs this file exists to prevent are as bad as they get (Rule 7 §7.1):
 * a fingerprint that varies with key order makes a legitimate retry look like a
 * conflict and BLOCKS the user; a fingerprint that ignores a field lets a
 * DIFFERENT request replay a stale result; and a replay decided after the
 * revision check means a committed action can never replay once the plan has
 * moved on, so the client retries forever.
 *
 * Records here are camelCase domain shapes, not Prisma rows: Rule 7 §6/§10 put
 * the snake_case↔camelCase translation at the mapper, so the service maps its
 * raw row once. The correspondence is 1:1 with `meal_plan_actions`
 * (prisma/schema.prisma) — `requestFingerprint`↔`request_fingerprint`,
 * `responseStatus`↔`response_status`, `responseSnapshot`↔`response_snapshot`,
 * `planRevisionAfter`↔`plan_revision_after`, `createdAt`↔`created_at` — and
 * every parameter below is narrowed to the fields its rule actually reads, so a
 * full row satisfies it structurally.
 */

// The `node:` specifier rather than the bare `'crypto'` this repo uses for
// `dns`/`fs`: it cannot resolve to a userland package of the same name, which
// matters for the one import that decides whether two writes are the same
// write. `createHash` is synchronous and deterministic, so it keeps the
// functions below pure under Rule 7 §7.
import { createHash } from 'node:crypto';

import { LogPlannedMealResponse, MealPlanResponse, SwapMealResponse } from '../types/mealPlanning';

/* ---------------------------------------------------------------------------
 * The closed set of keyed actions
 * ------------------------------------------------------------------------- */

/**
 * The four — and only four — writes that go through the idempotency ledger.
 *
 * Grocery toggles and uncheck-all are deliberately absent: they are
 * state-setting (the body names the desired `isChecked`), so they carry no key
 * and no revision and last write wins. Preference and target saves are absent
 * too: they are revisioned, not keyed. Adding a member here without giving it
 * a `KEYED_ACTION_RESPONSE_STATUS` entry is a compile error, which is the
 * point.
 */
export const ACTION_TYPES = ['generate', 'regenerate', 'swap', 'log'] as const;

/**
 * Derived from {@link ACTION_TYPES} rather than written out a second time, so
 * the runtime list and the compile-time union can never drift apart.
 */
export type KeyedActionType = (typeof ACTION_TYPES)[number];

/* ---------------------------------------------------------------------------
 * Ledger record shapes
 * ------------------------------------------------------------------------- */

/**
 * The ONLY field {@link decideReplay} is allowed to see.
 *
 * This one-field shape is load-bearing, not tidiness: it makes it structurally
 * impossible to hand the replay decision a plan status or a plan revision, and
 * therefore impossible to order that decision after the revision check. See
 * {@link decideReplay} for why that ordering would strand the client.
 */
export interface ActionFingerprintRecord {
    readonly requestFingerprint: string;
}

/**
 * The three columns a completed ledger row fills in.
 *
 * All three are nullable because a RESERVED row has not filled them yet. They
 * are typed `| null` to mirror the database exactly rather than to invite
 * optional handling — {@link readStoredResponse} is the one place that reads
 * them.
 *
 * They are also ALL-OR-NOTHING. §0.5.1 fills `response_status`,
 * `response_snapshot` and `plan_revision_after` in the single statement that
 * completes a reserved row, so a row has either none of them (pending) or all
 * three (completed). A row carrying some but not others is corruption, and
 * {@link classifyActionCompletion} names that third state rather than letting
 * it pass for either of the two legitimate ones.
 */
export interface StoredResponseRecord {
    readonly responseStatus: number | null;
    readonly responseSnapshot: unknown;
    readonly planRevisionAfter: number | null;
}

/**
 * A row that has completed: the same three columns with nothing missing.
 *
 * Declared as its own shape so {@link readStoredResponse} can narrow to it
 * through a type predicate and read the values without a cast — a cast is how
 * "checked for null" and "used as a number" drift apart.
 */
export interface CompletedActionResponseRecord {
    readonly responseStatus: number;
    readonly responseSnapshot: unknown;
    readonly planRevisionAfter: number;
}

/**
 * Row identity, optional because most rules here take a narrowed shape that has
 * none. It is carried for ONE purpose: so a ledger-integrity failure can name
 * the row an operator has to go and look at.
 */
export interface IdentifiableRecord {
    readonly id?: string;
}

/**
 * A whole `meal_plan_actions` row as the pure layer sees it, composed from the
 * narrow shapes above. Declared so the service has one type to map its raw row
 * into; the functions below never ask for this much.
 *
 * `createdAt` is here because the column exists and the mapper fills it, NOT
 * because anything in this file reads it: no rule may turn on a row's age (see
 * the file header). It is `Date` alone — the one form Prisma returns — rather
 * than a union that also admitted the client's ISO strings, because the
 * client's intents are the mobile store's business and never reach this module.
 */
export interface MealPlanningActionRecord extends ActionFingerprintRecord, StoredResponseRecord {
    readonly id: string;
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly actionType: KeyedActionType;
    readonly mealPlanId: string | null;
    readonly mealPlanMealId: string | null;
    readonly mealEntryId: string | null;
    readonly createdAt: Date;
}

/* ---------------------------------------------------------------------------
 * Canonicalisation — what makes two requests the same request
 * ------------------------------------------------------------------------- */

/**
 * Every numeric value is canonicalised to this many decimal places.
 *
 * Two matches the servings contract: `servings` is a number in [0.25, 10] with
 * at most two decimals, because the mobile fraction chips store ⅓ as 0.33 and
 * ⅔ as 0.66 — the repository's existing values, unchanged — and portion
 * multipliers (0.5 … 2 in quarter steps) are two-decimal values too. Display,
 * fingerprint and server arithmetic therefore all agree on one number.
 */
const CANONICAL_DECIMALS = 2;

const CANONICAL_SCALE = 10 ** CANONICAL_DECIMALS;

/**
 * The largest magnitude that can be canonicalised. Beyond it `value *
 * CANONICAL_SCALE` exceeds `Number.MAX_SAFE_INTEGER`, so the scaled rounding
 * below stops being able to tell adjacent values apart and the digest would no
 * longer be a faithful function of the request. Nothing in a keyed payload
 * comes close — revisions are small integers — so exceeding it means the caller
 * passed something that does not belong in a request body, and is reported
 * rather than hashed unreliably.
 */
const MAX_CANONICAL_MAGNITUDE = Number.MAX_SAFE_INTEGER / CANONICAL_SCALE;

/**
 * A number in canonical JSON form (RFC 8259 §6): optional minus, an integer
 * part with no leading zero, an optional fraction, an optional exponent.
 *
 * Strings matching this are canonicalised as numbers so `1`, `1.0` and `"1"`
 * cannot yield different fingerprints for the same request. Anything outside it
 * stays a string — `'01'`, `'1.'`, `'+1'`, `'0x10'`, `' '`, `'NaN'` and
 * `'2026-07-05'` are all text, and a date must never be read as a number.
 */
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;

const CANONICALIZE_ERROR_PREFIX = 'Cannot canonicalise a meal-planning request body: ';

/** Left-pads a fraction to {@link CANONICAL_DECIMALS} digits ('7' → '07'). */
const padFraction = (fraction: number): string => {
    const digits = String(fraction);

    return digits.length >= CANONICAL_DECIMALS
        ? digits
        : `${'0'.repeat(CANONICAL_DECIMALS - digits.length)}${digits}`;
};

/**
 * One number as a fixed two-decimal token.
 *
 * Rounding is done on the SCALED integer rather than with `toFixed`, matching
 * `isServingsInContract` in `nutrition.logic.ts`, which takes the same care for
 * the same reason: binary doubles do not hold decimal fractions exactly, so
 * `1.005 * 100` is `100.49999999999999`. A value carrying a third decimal is
 * rounded to two here; it can only reach this point after the servings parser
 * has already rejected it, so rounding is a normalisation rather than a loss.
 *
 * The token is assembled from the scaled integer's digits instead of by
 * dividing back out, so the result is always plain digits — never exponential
 * notation — and `-0` and `-0.001` both render as `0.00` rather than `-0.00`.
 */
const canonicalNumber = (value: number, path: string): string => {
    if (!Number.isFinite(value)) {
        throw new TypeError(
            `${CANONICALIZE_ERROR_PREFIX}${path} is ${String(value)}, which has no canonical form. ` +
                'A request body arriving as JSON cannot contain it, so this is a programming error.',
        );
    }

    if (Math.abs(value) > MAX_CANONICAL_MAGNITUDE) {
        throw new TypeError(
            `${CANONICALIZE_ERROR_PREFIX}${path} is ${String(value)}, whose magnitude exceeds ` +
                `${String(MAX_CANONICAL_MAGNITUDE)} and cannot be rounded to ${String(CANONICAL_DECIMALS)} ` +
                'decimals without losing integer precision. Refusing to hash it unreliably.',
        );
    }

    const scaled = Math.round(value * CANONICAL_SCALE);
    const magnitude = Math.abs(scaled);

    return `${scaled < 0 ? '-' : ''}${String(Math.floor(magnitude / CANONICAL_SCALE))}.${padFraction(
        magnitude % CANONICAL_SCALE,
    )}`;
};

/**
 * Orders object keys by UTF-16 code unit.
 *
 * Deliberately NOT `String.prototype.localeCompare`, which the cache key in
 * `usda.service.ts` uses: its ordering depends on the runtime's locale and ICU
 * data, and two processes that ordered keys differently would disagree about
 * whether a retry is the same request — exactly the failure that blocks a user.
 *
 * Two-way rather than the usual three-way comparator: it only ever sorts the
 * keys of one object, which are unique by definition, so an equality case would
 * be permanently dead code.
 */
const byCodeUnit = (left: string, right: string): number => (left < right ? -1 : 1);

/** True for `{}` and anything `JSON.parse` produces; false for a class instance. */
const isPlainObject = (value: object): boolean => {
    const prototype: unknown = Object.getPrototypeOf(value);

    return prototype === Object.prototype || prototype === null;
};

/**
 * The recursive worker behind {@link canonicalizeRequestBody}. `ancestors` is
 * the current recursion path, used to detect a cycle; entries are removed on
 * the way back out, so an object legitimately referenced twice in the same body
 * is fine and only a true cycle is rejected.
 */
const canonicalize = (value: unknown, path: string, ancestors: Set<object>): string => {
    // An explicit null and an absent value are both `null`, exactly as
    // `JSON.stringify` treats them. Only a top-level `undefined` or an array
    // hole/`undefined` element reaches this branch as `undefined`: an object
    // PROPERTY whose value is `undefined` is dropped below, so "key absent" and
    // "key present and null" stay distinguishable — the distinction the
    // preferences contract depends on elsewhere.
    if (value === null || value === undefined) {
        return 'null';
    }

    if (typeof value === 'boolean') {
        return value ? 'true' : 'false';
    }

    if (typeof value === 'number') {
        return canonicalNumber(value, path);
    }

    if (typeof value === 'string') {
        const trimmed = value.trim();

        // A numeric string is emitted as the bare number token its numeric
        // twin would produce, which is what collapses `1`, `1.0` and `"1"`.
        // Non-numeric text keeps `JSON.stringify`'s quoting and escaping, so it
        // can never collide with a number, a boolean or a null.
        return JSON_NUMBER_PATTERN.test(trimmed) ? canonicalNumber(Number(trimmed), path) : JSON.stringify(value);
    }

    if (typeof value !== 'object') {
        // `bigint`, `function` and `symbol`. None can arrive as JSON, and each
        // would either throw inside `JSON.stringify` or vanish from the digest.
        throw new TypeError(
            `${CANONICALIZE_ERROR_PREFIX}${path} is a ${typeof value}, which has no JSON representation.`,
        );
    }

    if (ancestors.has(value)) {
        throw new TypeError(`${CANONICALIZE_ERROR_PREFIX}${path} is a circular reference.`);
    }

    ancestors.add(value);

    try {
        if (Array.isArray(value)) {
            // Indexed rather than `map`, so a sparse hole canonicalises to
            // `null` the way `JSON.stringify` renders it instead of collapsing
            // into an empty slot. Array ORDER IS SEMANTIC and is preserved:
            // only object keys are sorted.
            const elements: string[] = [];

            for (let index = 0; index < value.length; index += 1) {
                elements.push(canonicalize(value[index], `${path}[${index}]`, ancestors));
            }

            return `[${elements.join(',')}]`;
        }

        if (!isPlainObject(value)) {
            // A `Date`, `Map` or `Set` has no own enumerable keys, so emitting
            // it as `{}` would silently drop its contents from the digest —
            // precisely the field-blind fingerprint that lets a different
            // request replay a stale result. Report it instead.
            throw new TypeError(
                `${CANONICALIZE_ERROR_PREFIX}${path} is a ${value.constructor?.name ?? 'non-plain'} instance, ` +
                    'not plain JSON data. Serialise it at the boundary that produced it.',
            );
        }

        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, nested]) => nested !== undefined)
            .sort(([leftKey], [rightKey]) => byCodeUnit(leftKey, rightKey));

        const members = entries.map(
            ([key, nested]) => `${JSON.stringify(key)}:${canonicalize(nested, `${path}.${key}`, ancestors)}`,
        );

        return `{${members.join(',')}}`;
    } finally {
        ancestors.delete(value);
    }
};

/**
 * A request body as one deterministic string.
 *
 * `JSON.stringify` alone is NOT canonical: it preserves insertion order, so two
 * clients sending the same fields in a different order would produce different
 * fingerprints and a legitimate retry would be rejected as a conflict. This
 * function fixes that and two more things:
 *
 *  - object keys are sorted recursively, by code unit (never by locale);
 *  - every number — and every string holding a canonical JSON number — becomes
 *    the same fixed two-decimal token, so `1`, `1.0` and `"1"` agree while
 *    `0.33` and `0.66` survive intact;
 *  - array order is preserved, because order is meaningful in an array.
 *
 * Anything that cannot be represented faithfully is reported rather than hashed
 * inaccurately: a non-finite or oversized number, a `bigint`/`function`/
 * `symbol`, a class instance such as a `Date`, or a cycle. Non-enumerable and
 * symbol-keyed properties are ignored, as `JSON.stringify` ignores them; they
 * cannot occur in a body parsed from the wire.
 *
 * This is deliberately independent of the private `canonicalJson` in
 * `usda.service.ts`: that one's output is `usda_api_cache.cache_key`, a
 * deployed primary key that must not change, and it neither canonicalises
 * numbers nor avoids locale-dependent key ordering.
 */
export const canonicalizeRequestBody = (body: unknown): string => canonicalize(body, '$', new Set<object>());

/* ---------------------------------------------------------------------------
 * Fingerprinting
 * ------------------------------------------------------------------------- */

const FINGERPRINT_ALGORITHM = 'sha256';

/**
 * The path-derived ids a keyed write addresses, by name: `{}` for generate,
 * `{planId}` for regenerate, `{planId, mealId}` for swap and log.
 *
 * Named rather than positional on purpose — a positional pair would let a
 * caller transpose `planId` and `mealId` and still produce a plausible-looking
 * fingerprint. Key order is irrelevant, since the canonicaliser sorts.
 */
export type ActionResourceIds = Readonly<Record<string, string>>;

/**
 * The `meal_plan_actions.request_fingerprint` value: a SHA-256 hex digest of
 * what the caller asked for.
 *
 * The method, the action type and the resource ids are hashed ALONGSIDE the
 * body. The ids matter because the same key must never be reusable against a
 * different meal, and the action type because two routes must not collide on
 * one key. The four components are hashed as a canonical JSON envelope rather
 * than concatenated with a separator, so no value can impersonate a delimiter
 * and shift the boundary between two components.
 *
 * The expected revisions ride along inside `body`, which is what makes a
 * preview refreshed after `409 preview_stale` a DIFFERENT request: its
 * fingerprint changes, the client correctly mints a new key rather than
 * replaying a dead one, and reusing the old key would be answered with
 * `409 idempotency_conflict`.
 *
 * The `idempotencyKey` field of the body is hashed with everything else and
 * needs no special treatment: the row is looked up BY that key, so it is
 * constant across every request this digest is ever compared against. It never
 * reaches the plan generator's seed, which is derived from the user, start date
 * and revisions alone — that is what keeps a retry under a fresh key
 * reproducing the same candidate plan.
 *
 * Hash the PARSED payload, not the raw `req.body`. Every keyed route validates
 * its body first (§0.5.2: uuid, date, servings and revision checks answering
 * 400 invalid_request), and that ordering is what keeps a hostile body a 400
 * from the parser rather than a 500 from the canonicaliser below — which
 * rightly refuses a value it cannot represent faithfully. Parse revisions with
 * `Number.isSafeInteger`, as `usda.service.ts` parses an FDC id: `1e30`
 * satisfies `Number.isInteger` and would reach this function as an
 * unrepresentable magnitude.
 */
export const buildRequestFingerprint = (
    method: string,
    actionType: KeyedActionType,
    resourceIds: ActionResourceIds,
    body: unknown,
): string => {
    const normalizedMethod = method.trim().toUpperCase();

    if (normalizedMethod.length === 0) {
        throw new TypeError(
            'Cannot build a meal-planning request fingerprint: method is blank. Hashing without it would let ' +
                'two different routes agree on one fingerprint.',
        );
    }

    const preimage = canonicalizeRequestBody({
        actionType,
        body,
        method: normalizedMethod,
        resourceIds,
    });

    return createHash(FINGERPRINT_ALGORITHM).update(preimage, 'utf8').digest('hex');
};

/* ---------------------------------------------------------------------------
 * The replay decision
 * ------------------------------------------------------------------------- */

/**
 * What the service must do about an idempotency key it has just tried to
 * reserve:
 *
 *  - `proceed` — the key is new; do the work.
 *  - `replay`  — the key and the request both match; return the stored response
 *                as {@link readStoredResponse} hands it back — the recorded
 *                status and revision exactly, the body deep-equal to the first
 *                one rather than byte-identical to it.
 *  - `conflict` — the key matches but the request does not; the service throws
 *                 `IdempotencyConflictError` (409).
 */
export type ReplayVerdict = 'proceed' | 'replay' | 'conflict';

/**
 * Fingerprints are lowercase hex, so normalising case and surrounding
 * whitespace can only ever remove an accidental difference in how a value was
 * stored or read — it can never merge two genuinely different digests, and a
 * spurious mismatch here would lock a user out of their own retry.
 */
const normalizeFingerprint = (fingerprint: string): string => fingerprint.trim().toLowerCase();

/**
 * The heart of the ledger: three outcomes, returned as a value.
 *
 * It does not throw. Rule 7 §8 puts status codes at the controller, so the
 * service maps `conflict` to `IdempotencyConflictError` → 409; a pure
 * three-way decision is also trivially testable, which an exception is not.
 *
 * **This decision must be usable BEFORE any revision or status check, and the
 * signature enforces it.** The parameter is an {@link ActionFingerprintRecord}
 * — one field — so there is no way to pass a plan status or revision in, and
 * therefore no way to order this check after them. That ordering is not a
 * stylistic preference: a client whose response was lost, and whose plan then
 * advanced through another device's swap, would be answered `409 stale_plan`
 * forever and could never learn that its own action had already succeeded.
 * Replay first, then check the plan.
 *
 * A row that exists but is still PENDING (`response_status` null) returns
 * `replay` here, because the fingerprint is what decides and the intent does
 * match. That state is unreachable in practice: the reservation and the write
 * share one transaction under the per-user advisory lock, so a pending row is
 * visible only to the transaction that created it and disappears with it on
 * rollback — a lock-serialised same-key request always finds either no row
 * (`proceed`) or a completed one (`replay`). It is not given a fourth verdict
 * for that reason; {@link readStoredResponse} returns `null` for such a row, so
 * the service can treat it as the invariant violation it would be.
 */
export const decideReplay = (
    existingRow: ActionFingerprintRecord | null | undefined,
    incomingFingerprint: string,
): ReplayVerdict => {
    if (existingRow === null || existingRow === undefined) {
        return 'proceed';
    }

    return normalizeFingerprint(existingRow.requestFingerprint) === normalizeFingerprint(incomingFingerprint)
        ? 'replay'
        : 'conflict';
};

/* ---------------------------------------------------------------------------
 * The one replay policy
 * ------------------------------------------------------------------------- */

/**
 * Which response body each keyed action stores, so an action can never be
 * completed with another action's response shape.
 */
export interface KeyedActionResponseBodies {
    generate: MealPlanResponse;
    regenerate: MealPlanResponse;
    swap: SwapMealResponse;
    log: LogPlannedMealResponse;
}

/** Any body the ledger can hold, which is what lands in `response_snapshot`. */
export type KeyedActionResponseBody = KeyedActionResponseBodies[KeyedActionType];

/**
 * The success status of each keyed action: `201` for generate, regenerate and
 * log, because each creates a resource, and `200` for swap, which changes one.
 *
 * Applied when the response is STORED, never when it is read back — see
 * {@link readStoredResponse}.
 */
export const KEYED_ACTION_RESPONSE_STATUS: Readonly<Record<KeyedActionType, number>> = {
    generate: 201,
    regenerate: 201,
    swap: 200,
    log: 201,
};

/** The three column values that complete a reserved ledger row. */
export interface StoredActionResponse {
    readonly responseStatus: number;
    readonly responseSnapshot: KeyedActionResponseBody;
    readonly planRevisionAfter: number;
}

/**
 * A stored response, ready to be sent again — the status and revision exactly as
 * they were recorded, the body deep-equal to the first one (see
 * {@link readStoredResponse}).
 *
 * `planRevisionAfter` is a plain `number`, not `number | null`: a response is
 * only replayable once all three completion columns are filled (see
 * {@link classifyActionCompletion}), so by the time this shape exists the
 * revision the action produced is known. Defaulting a missing revision to
 * `null` here would hand the client a reply that says "your action succeeded"
 * while withholding the revision every keyed response is required to carry.
 */
export interface ReplayableActionResponse {
    readonly status: number;
    readonly body: unknown;
    readonly planRevisionAfter: number;
}

/* ---------------------------------------------------------------------------
 * The completion invariant
 * ------------------------------------------------------------------------- */

/**
 * The columns a completion fills, in one statement, together.
 *
 * Listed once and consumed by every rule below, so "which columns make a row
 * completed" has a single answer. The service's compare-and-set predicate is
 * the snake_case image of this list — `response_status`, `response_snapshot`,
 * `plan_revision_after`.
 */
export const ACTION_COMPLETION_FIELDS = ['responseStatus', 'responseSnapshot', 'planRevisionAfter'] as const;

/** One of the three completion columns, by its camelCase record name. */
export type ActionCompletionField = (typeof ACTION_COMPLETION_FIELDS)[number];

/**
 * What state a reserved row is in:
 *
 *  - `pending`   — none of the completion columns is filled. The action has not
 *                  finished (and under the per-user lock this is only ever
 *                  observable inside the transaction that reserved it).
 *  - `completed` — all three are filled; the row is replayable.
 *  - `corrupt`   — some are filled and some are not, which §0.5.1 never
 *                  produces. Something outside this ledger wrote the row, or a
 *                  completion was interrupted in a way the transaction was
 *                  supposed to make impossible.
 */
export type ActionCompletionState = 'pending' | 'completed' | 'corrupt';

/** A column counts as filled when it holds a value — `null` and `undefined` do not. */
const isColumnFilled = (value: unknown): boolean => value !== null && value !== undefined;

/**
 * Which completion columns a row is still missing, in {@link
 * ACTION_COMPLETION_FIELDS} order.
 *
 * Returned as data rather than reported, because both callers need the names:
 * one to decide what the row is, the other to say which column is absent in an
 * error an operator will read.
 */
export const findMissingCompletionFields = (row: StoredResponseRecord): readonly ActionCompletionField[] =>
    ACTION_COMPLETION_FIELDS.filter((field) => !isColumnFilled(row[field]));

/**
 * The three-way classification the ledger actually needs.
 *
 * A half-filled row is NOT treated as completed. Doing so would replay a
 * response whose provenance nothing can vouch for — the earlier reading of this
 * rule defaulted a missing revision to `null` and returned the row as
 * replayable, which reports success for a write whose recorded outcome is
 * incomplete. It is not treated as pending either: pretending an interrupted
 * completion never happened invites the work to be done a second time, which is
 * the one thing this ledger exists to prevent. It is its own state, so the
 * caller can fail loudly and leave the row for inspection.
 */
export const classifyActionCompletion = (row: StoredResponseRecord): ActionCompletionState => {
    const missing = findMissingCompletionFields(row);

    if (missing.length === ACTION_COMPLETION_FIELDS.length) {
        return 'pending';
    }

    return missing.length === 0 ? 'completed' : 'corrupt';
};

/**
 * A `meal_plan_actions` row that is neither pending nor completed.
 *
 * Its own class rather than a bare `Error` because it is a distinguishable
 * condition a caller may want to catch, and because the fields it names are
 * data the message should not be parsed for. It stays in this module, beside
 * the rule that raises it, for the reason `mealPlanning.errors.ts` states about
 * itself: that file holds the client-facing vocabulary the controllers map to
 * status codes, while a module's own integrity failures belong to the module
 * (as `UnitConversionError` and `FeatureFlagError` do). Nothing maps this to a
 * status: a corrupt ledger row is a 500 the controller's fallback already
 * covers.
 */
export class ActionLedgerIntegrityError extends Error {
    /** The completion columns that were absent, in {@link ACTION_COMPLETION_FIELDS} order. */
    readonly missingFields: readonly ActionCompletionField[];

    /** The row, when the caller had its id to give. */
    readonly actionId: string | null;

    constructor(missingFields: readonly ActionCompletionField[], actionId?: string) {
        super(
            `meal_plan_actions row ${actionId ?? '(id unknown)'} is half-completed: ` +
                `${missingFields.join(', ')} ${missingFields.length === 1 ? 'is' : 'are'} missing while the ` +
                'other completion columns are set. A completion writes all of response_status, ' +
                'response_snapshot and plan_revision_after in one statement, so this row cannot be replayed ' +
                'and must not be repeated. Refusing to guess the outcome of the write it records.',
        );
        this.name = 'ActionLedgerIntegrityError';
        this.missingFields = missingFields;
        this.actionId = actionId ?? null;
    }
}

/** Narrows a row to {@link CompletedActionResponseRecord} without a cast. */
const isCompletedActionRow = (
    row: StoredResponseRecord,
): row is StoredResponseRecord & CompletedActionResponseRecord => findMissingCompletionFields(row).length === 0;

/**
 * Freezes a completed action's response into the row.
 *
 * The generic ties the body to the action: `shapeStoredResponse('swap', …)`
 * accepts only a `SwapMealResponse`, so a mismatch is a compile error rather
 * than a replay that returns the wrong shape. Every body carries the new plan
 * revision, which is why `plan_revision_after` is stored beside it.
 */
export const shapeStoredResponse = <TAction extends KeyedActionType>(
    actionType: TAction,
    body: KeyedActionResponseBodies[TAction],
    planRevisionAfter: number,
): StoredActionResponse => {
    if (!Number.isSafeInteger(planRevisionAfter) || planRevisionAfter < 0) {
        throw new TypeError(
            `Cannot store a meal-planning action response: planRevisionAfter is ${String(planRevisionAfter)}, ` +
                'which is not a non-negative integer revision. Storing it would leave the replay unable to ' +
                'report the revision the action produced.',
        );
    }

    return {
        responseStatus: KEYED_ACTION_RESPONSE_STATUS[actionType],
        responseSnapshot: body,
        planRevisionAfter,
    };
};

/**
 * Reads a stored response back for replay, or `null` when the row has none yet.
 *
 * **The status and the revision are read, never re-derived.** Deriving the
 * status from the action type at read time would let a future change to an
 * endpoint's success status retroactively rewrite what an already-stored action
 * replays. Both are integers and both come back exactly as they were recorded.
 *
 * **The body comes back as the stored VALUE: deep-equal to the first response,
 * with no guarantee of identical text.** `meal_plan_actions.response_snapshot`
 * is a `jsonb` column, and PostgreSQL normalises an object's key order at rest —
 * keys sorted by length, then by bytes, at every nesting level — so a replay
 * serialises its keys in THAT order whatever order they were written in, while
 * every value it carries is preserved exactly. Each of the three keyed response
 * types is reordered somewhere in its tree, so the text does differ in practice;
 * what holds either way is the VALUE, and the value is the only thing to assert
 * on. A client still cannot distinguish the two, which is what §0.5.1 requires:
 * key order carries no meaning in a JSON object, and the mobile io-ts decoders
 * read by key rather than by position.
 *
 * So the achievable form of §0.9.2's replay row — "returns the stored 201/200
 * body byte-for-byte" — is a DEEP-EQUAL parsed body with an exactly equal status
 * and revision, and anything that tests it must compare the PARSED body
 * (`toEqual`), never the serialised JSON text and never a stored snapshot of it.
 * A text comparison there fails against correct code, which is why this
 * module's own suite pins the textual difference as a known property instead of
 * leaving it to be rediscovered as a bug.
 *
 * Age is not consulted, and there is nothing to consult it with: a committed
 * action replays for as long as its row exists (see the file header).
 *
 * The three outcomes are exactly {@link classifyActionCompletion}'s:
 *
 *  - `null` for a pending row — an unreachable state under the per-user lock
 *    (see {@link decideReplay}) that the service reports rather than papering
 *    over with an invented status;
 *  - the stored response for a completed row;
 *  - {@link ActionLedgerIntegrityError} for a half-completed one. A row holding
 *    a status and a body but no revision is NOT a replayable response with an
 *    unknown revision; it is a row no completion in this ledger could have
 *    written, and answering a client from it would report an outcome the ledger
 *    did not record.
 */
export const readStoredResponse = (
    row: (StoredResponseRecord & IdentifiableRecord) | null | undefined,
): ReplayableActionResponse | null => {
    if (row === null || row === undefined) {
        return null;
    }

    if (isCompletedActionRow(row)) {
        return {
            status: row.responseStatus,
            body: row.responseSnapshot,
            planRevisionAfter: row.planRevisionAfter,
        };
    }

    const missing = findMissingCompletionFields(row);

    if (missing.length === ACTION_COMPLETION_FIELDS.length) {
        return null;
    }

    throw new ActionLedgerIntegrityError(missing, row.id);
};

/* ---------------------------------------------------------------------------
 * The ids a completion records
 * ------------------------------------------------------------------------- */

/**
 * The three id columns of `meal_plan_actions`, by their camelCase record names.
 */
export const CREATED_ID_FIELDS = ['mealPlanId', 'mealPlanMealId', 'mealEntryId'] as const;

/** One of the three id columns a completion can fill. */
export type CreatedIdField = (typeof CREATED_ID_FIELDS)[number];

/**
 * Which ids each action records — the whole per-action rule, in one table.
 *
 * §0.5.1 completes a reserved row with "the created ids", and which ids exist
 * depends entirely on the action: a generate and a regenerate each publish a
 * plan; a swap addresses a plan and the one planned meal it replaced; a log
 * additionally creates the diary entry. So the requirement is per action, and
 * an id that has no meaning for an action is as wrong as a missing one — the
 * schema's tenant guards pair each id with `user_id`, so a stray id is not an
 * unused column but a claim about a row this action never touched.
 *
 * `as const` is load-bearing: {@link KeyedActionCreatedIds} is DERIVED from
 * this table, so the compile-time requirement and the runtime check cannot
 * drift apart — the same reason {@link KeyedActionType} is derived from
 * {@link ACTION_TYPES}.
 */
export const KEYED_ACTION_CREATED_ID_FIELDS = {
    generate: ['mealPlanId'],
    regenerate: ['mealPlanId'],
    swap: ['mealPlanId', 'mealPlanMealId'],
    log: ['mealPlanId', 'mealPlanMealId', 'mealEntryId'],
} as const;

/** The ids one named action must record, each required and non-null. */
type CreatedIdsForAction<TAction extends KeyedActionType> = {
    readonly [Field in (typeof KEYED_ACTION_CREATED_ID_FIELDS)[TAction][number]]: string;
};

/**
 * The ids a keyed write records, as the action's own closed shape.
 *
 * A `swap` completion must carry `mealPlanId` and `mealPlanMealId`, both
 * strings, and may carry no `mealEntryId`; a `log` must carry all three. The
 * earlier reading of this contract made every id independently optional and
 * nullable for every action, which let a completion succeed with no ids at all
 * — a ledger row that cannot say what it created — or with an id from another
 * action's shape. Both are compile errors now, and
 * {@link resolveCreatedIdColumns} refuses them at runtime for callers that
 * reach this ledger without those types.
 *
 * The conditional is distributive on purpose: the default parameter then means
 * "one of the four shapes", not "all three ids at once".
 */
export type KeyedActionCreatedIds<TAction extends KeyedActionType = KeyedActionType> =
    TAction extends KeyedActionType ? CreatedIdsForAction<TAction> : never;

/**
 * The exact column values a completion writes: the ids the action records, and
 * an explicit `null` for every column it does not.
 *
 * Explicit rather than omitted, so completing a row always leaves all three
 * columns in a state this ledger chose. An omitted column would inherit
 * whatever was there before, which on a reused row is another action's id.
 */
export interface KeyedActionCreatedIdColumns {
    readonly mealPlanId: string | null;
    readonly mealPlanMealId: string | null;
    readonly mealEntryId: string | null;
}

/**
 * The ids are `uuid` columns filled from `gen_random_uuid()`, so anything that
 * is not a v4 UUID cannot be a row id this ledger may reference. The pattern is
 * local to this module by the same convention every other `*.logic.ts` here
 * follows.
 */
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuidV4 = (value: unknown): value is string => typeof value === 'string' && UUID_V4_PATTERN.test(value);

/** A value as it should read inside an error message. */
const describeValue = (value: unknown): string => {
    if (value === undefined) {
        return 'absent';
    }

    return typeof value === 'string' ? `"${value}"` : String(value);
};

/**
 * Turns a completion's ids into the three column values, or reports why it
 * cannot.
 *
 * Two rules, both from §0.5.1's "fill the reserved action row … and the created
 * ids":
 *
 *  1. every id the action records must be present and be a row id. A completed
 *     row that names no plan cannot be traced to what it wrote, and the
 *     `@@index([meal_plan_id])` lookups and tenant guards that hang off these
 *     columns silently stop covering it.
 *  2. an id the action does NOT record must be absent or null. A generate that
 *     reported a `mealEntryId` would assert a diary entry it never created,
 *     and the tenant guard would tie the row to a meal_entries row of
 *     unrelated provenance.
 *
 * It reports rather than returns a verdict — unlike {@link decideReplay}, which
 * is a genuine three-way domain decision. Every caller of this one has already
 * done the write; there is no branch to take, and the only honest response to
 * "this completion does not describe its own action" is to abort the
 * transaction so nothing is recorded.
 *
 * `createdIds` is `unknown` because that is what it is: the compile-time
 * requirement lives in {@link KeyedActionCreatedIds}, and this function is the
 * guard for everything that reaches the ledger without it — a cast, a
 * JavaScript caller, a test double. Accepting the typed shape here would let
 * the guard trust the very declaration it exists to verify.
 */
export const resolveCreatedIdColumns = (
    actionType: KeyedActionType,
    createdIds: unknown,
): KeyedActionCreatedIdColumns => {
    const required = KEYED_ACTION_CREATED_ID_FIELDS[actionType] as readonly string[] | undefined;

    if (required === undefined) {
        throw new TypeError(
            `Cannot record the created ids of a meal-planning action: "${String(actionType)}" is not one of ` +
                `${ACTION_TYPES.join(', ')}, so which ids it records is undefined.`,
        );
    }

    if (createdIds === null || typeof createdIds !== 'object') {
        throw new TypeError(
            `Cannot record the created ids of a ${actionType} action: the completion is ` +
                `${describeValue(createdIds)}, not an object carrying ${required.join(' and ')}.`,
        );
    }

    const candidates = createdIds as Readonly<Record<string, unknown>>;

    const columns: Record<CreatedIdField, string | null> = {
        mealPlanId: null,
        mealPlanMealId: null,
        mealEntryId: null,
    };

    for (const field of CREATED_ID_FIELDS) {
        const value = candidates[field];

        if (required.includes(field)) {
            if (!isUuidV4(value)) {
                throw new TypeError(
                    `Cannot complete a ${actionType} action: ${field} is ${describeValue(value)}, but a ` +
                        `${actionType} records ${required.join(' and ')}. Completing without it would leave a ` +
                        'ledger row that cannot say what the action wrote.',
                );
            }

            columns[field] = value;
            continue;
        }

        if (value !== undefined && value !== null) {
            throw new TypeError(
                `Cannot complete a ${actionType} action: it carries ${field} ${describeValue(value)}, which a ` +
                    `${actionType} does not create — it records ${required.join(' and ')} only. Recording it ` +
                    'would claim a row this action never touched.',
            );
        }
    }

    return columns;
};

/* ---------------------------------------------------------------------------
 * The transaction-client shape rule
 * ------------------------------------------------------------------------- */

/**
 * The members an interactive transaction client does NOT have, and the global
 * client does.
 *
 * This is Prisma's own deny list — `Prisma.TransactionClient` is
 * `Omit<PrismaClient, "$connect" | "$disconnect" | "$on" | "$transaction" |
 * "$use" | "$extends">` — and the runtime agrees with the types: a client
 * obtained from `$transaction(…)` exposes none of these six, while the global
 * client exposes all of them. So finding any one of them on a candidate is
 * proof that it is the autocommit client rather than an open transaction.
 */
export const AUTOCOMMIT_CLIENT_MEMBERS = [
    '$connect',
    '$disconnect',
    '$on',
    '$transaction',
    '$use',
    '$extends',
] as const;

/**
 * The members every statement the ledger issues goes through: the advisory
 * lock (`$executeRaw`) and the reservation (`$queryRaw`). A candidate without
 * them is not a Prisma client at all.
 */
export const TRANSACTION_CLIENT_MEMBERS = ['$queryRaw', '$executeRaw'] as const;

/** What a candidate database client turned out to be. */
export interface TransactionClientDiagnosis {
    readonly verdict: 'interactive' | 'autocommit' | 'unusable';
    /** The deny-list members found on it — non-empty exactly when `autocommit`. */
    readonly autocommitMembers: readonly string[];
    /** The required members it lacks — non-empty exactly when `unusable`. */
    readonly missingMembers: readonly string[];
}

/** Whether `member` is a callable own-or-inherited property of `candidate`. */
const hasFunctionMember = (candidate: unknown, member: string): boolean => {
    if (candidate === null || (typeof candidate !== 'object' && typeof candidate !== 'function')) {
        return false;
    }

    return typeof (candidate as Record<string, unknown>)[member] === 'function';
};

/**
 * Classifies the client a caller is about to run the ledger on.
 *
 * The check is a RULE, not I/O — it reads the shape of an object and nothing
 * else — which is why it lives here and is tested with no database, while the
 * statements it protects are integration-tested.
 *
 * Why it has to exist at all: `pg_advisory_xact_lock` is released at the end of
 * the transaction that took it. Run the sequence on the autocommit client and
 * the lock is gone the moment its own statement returns, the reservation
 * commits by itself, and a failure half-way through leaves a permanently
 * pending row that no later request can complete or replay — the ledger's
 * central guarantee, silently absent. The type in
 * `mealPlanningAction.service.ts` refuses the global client at compile time;
 * this refuses it at run time, for a caller that reached the ledger through a
 * cast, from JavaScript, or from a test double.
 *
 * The deny list is consulted FIRST: the global client also has `$queryRaw` and
 * `$executeRaw`, so it would otherwise pass as interactive.
 */
export const diagnoseTransactionClient = (candidate: unknown): TransactionClientDiagnosis => {
    const autocommitMembers = AUTOCOMMIT_CLIENT_MEMBERS.filter((member) => hasFunctionMember(candidate, member));

    if (autocommitMembers.length > 0) {
        return { verdict: 'autocommit', autocommitMembers, missingMembers: [] };
    }

    const missingMembers = TRANSACTION_CLIENT_MEMBERS.filter((member) => !hasFunctionMember(candidate, member));

    if (missingMembers.length > 0) {
        return { verdict: 'unusable', autocommitMembers: [], missingMembers };
    }

    return { verdict: 'interactive', autocommitMembers: [], missingMembers: [] };
};

/**
 * Refuses anything but an open interactive transaction, naming what gave the
 * candidate away.
 *
 * `usage` is the entry point being protected, so the message says which call
 * has to be fixed rather than only what was wrong.
 */
export const assertInteractiveTransactionClient = (candidate: unknown, usage: string): void => {
    const diagnosis = diagnoseTransactionClient(candidate);

    if (diagnosis.verdict === 'interactive') {
        return;
    }

    if (diagnosis.verdict === 'autocommit') {
        throw new TypeError(
            `${usage} was given the global Prisma client, not an open interactive transaction — it exposes ` +
                `${diagnosis.autocommitMembers.join(', ')}, which a transaction client never does. The per-user ` +
                'advisory lock would be released at the end of its own statement and the reservation would ' +
                'commit on its own, so the write could not be rolled back as one unit. Open the transaction ' +
                'with withMealPlanningTransaction (or prisma.$transaction) and pass the client it provides.',
        );
    }

    throw new TypeError(
        `${usage} was given a value that is not a Prisma client: it lacks ${diagnosis.missingMembers.join(', ')}. ` +
            'The ledger issues its advisory lock and its reservation through those, so it cannot run on this ' +
            'value.',
    );
};
