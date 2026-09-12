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
 *      verbatim and end the transaction, or answer 409 idempotency_conflict
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
 * `process.env` and no clock: {@link isActionExpired} takes "now" as an
 * argument. The lock-and-reserve behaviour is covered against real PostgreSQL
 * by `src/__tests__/api/concurrency.test.ts`; every rule below is covered with
 * no database at all by `__tests__/mealPlanningAction.logic.test.ts`.
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
 */
export interface StoredResponseRecord {
    readonly responseStatus: number | null;
    readonly responseSnapshot: unknown;
    readonly planRevisionAfter: number | null;
}

/**
 * Just the age of a ledger row or a client-held intent. `createdAt` accepts the
 * three forms it legitimately arrives in: a `Date` from Prisma, an ISO string
 * from the client's persisted `pendingIntents`, or epoch milliseconds.
 */
export interface ActionAgeRecord {
    readonly createdAt: Date | string | number;
}

/**
 * A whole `meal_plan_actions` row as the pure layer sees it, composed from the
 * narrow shapes above. Declared so the service has one type to map its raw row
 * into; the functions below never ask for this much.
 */
export interface MealPlanningActionRecord extends ActionFingerprintRecord, StoredResponseRecord, ActionAgeRecord {
    readonly id: string;
    readonly userId: string;
    readonly idempotencyKey: string;
    readonly actionType: KeyedActionType;
    readonly mealPlanId: string | null;
    readonly mealPlanMealId: string | null;
    readonly mealEntryId: string | null;
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
 *  - `replay`  — the key and the request both match; return the stored
 *                response verbatim.
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

/** A stored response, ready to be sent again exactly as it was sent the first time. */
export interface ReplayableActionResponse {
    readonly status: number;
    readonly body: unknown;
    readonly planRevisionAfter: number | null;
}

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
 * **The status is read, never re-derived.** Deriving it from the action type at
 * read time would let a future change to an endpoint's success status
 * retroactively rewrite what an already-stored action replays; a client can
 * never distinguish a replay from the original response precisely because both
 * the status and the body come back byte-for-byte as they were first sent.
 *
 * `null` means the row is still pending — an unreachable state under the
 * per-user lock (see {@link decideReplay}) that is reported rather than
 * papered over with an invented status.
 */
export const readStoredResponse = (
    row: StoredResponseRecord | null | undefined,
): ReplayableActionResponse | null => {
    if (row === null || row === undefined) {
        return null;
    }

    if (row.responseStatus === null || row.responseStatus === undefined) {
        return null;
    }

    if (row.responseSnapshot === null || row.responseSnapshot === undefined) {
        return null;
    }

    return {
        status: row.responseStatus,
        body: row.responseSnapshot,
        planRevisionAfter: row.planRevisionAfter ?? null,
    };
};

/* ---------------------------------------------------------------------------
 * Intent age
 * ------------------------------------------------------------------------- */

/**
 * How long an unresolved intent may be retried under its original key: seven
 * days, matching the client's `pendingIntents` age guard.
 */
export const ACTION_INTENT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

/** Epoch milliseconds from any of the three forms a timestamp arrives in. */
const toEpochMs = (value: Date | string | number, label: string): number => {
    const epochMs = value instanceof Date ? value.getTime() : typeof value === 'number' ? value : Date.parse(value);

    if (!Number.isFinite(epochMs)) {
        throw new TypeError(
            `Cannot age a meal-planning action: ${label} is not a usable timestamp (${String(value)}).`,
        );
    }

    return epochMs;
};

/**
 * Whether an intent is too old to keep retrying under its original key.
 *
 * `now` is a PARAMETER, never `Date.now()`: Rule 7 §7 forbids reading the clock
 * inside a pure function, and a rule that samples the clock cannot be pinned by
 * a test.
 *
 * The role is narrow and worth stating. `meal_plan_actions` rows are retained
 * indefinitely on the server — they are small, user-scoped and cascade on user
 * deletion — so nothing in the replay path expires a row, and this predicate is
 * NOT consulted there. It exists so the seven-day guard the client applies to
 * its persisted `pendingIntents` is expressed once, in a testable place, and so
 * its boundary is pinned rather than assumed.
 *
 * The boundary is INCLUSIVE: an intent exactly `maxAgeMs` old is not yet
 * expired, so a retry landing on the limit still replays under its own key
 * instead of silently minting a new one. A `now` earlier than `createdAt`
 * (clock skew) yields a negative age and is likewise not expired.
 */
export const isActionExpired = (
    row: ActionAgeRecord,
    now: Date | string | number,
    maxAgeMs: number = ACTION_INTENT_MAX_AGE_MS,
): boolean => {
    if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) {
        throw new TypeError(
            `Cannot age a meal-planning action: maxAgeMs is ${String(maxAgeMs)}, which is not a non-negative ` +
                'duration. A non-numeric window would silently disable the guard.',
        );
    }

    return toEpochMs(now, 'now') - toEpochMs(row.createdAt, 'createdAt') > maxAgeMs;
};

