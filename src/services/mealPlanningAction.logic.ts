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
// Imported rather than taken from the global scope, for the same reason and
// with the same specifier: it decides the key order a stored response is
// replayed in, and `Buffer` is the one measurement — UTF-8 byte length — that
// `String.prototype.length` gets wrong for any non-ASCII key.
import { Buffer } from 'node:buffer';

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
 * optional handling: {@link readStoredResponse} is the one place that turns them
 * into a response, and the only other consumer —
 * `grocery.service.ts::loadLastSwapContext`, which needs the last COMPLETED swap
 * of a plan and not a replay of it — asks {@link classifyActionCompletion} over
 * this same shape rather than testing a column of its own choosing. Both
 * therefore mean the same thing by "completed"; a third reading of these columns
 * belongs behind one of those two functions.
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
 * Canonicalisation — what makes a REPLAY byte-for-byte
 *
 * The section above answers "are these two requests the same request". This one
 * answers the other half of the ledger's promise: §0.5.1 requires the stored
 * first-response status and body to come back "unchanged … so a client can
 * never distinguish a replay from the original response", and §0.9.2 states it
 * as "returns the stored 201/200 body BYTE-FOR-BYTE". The obstacle is that
 * `meal_plan_actions.response_snapshot` is a `jsonb` column, and `jsonb`
 * re-orders an object's keys at rest — so a body stored in one order is served
 * back in another, and the two texts differ.
 *
 * `jsonb`'s order is not arbitrary, though: it is deterministic and knowable.
 * So the fix is not a column change but a canonical form — order the keys the
 * way the column will order them BEFORE storing, and the column's reordering
 * becomes the identity. The first response then serialises from a value ordered
 * exactly as the column holds it, and every later replay serialises the same
 * bytes.
 * ------------------------------------------------------------------------- */

const CANONICALIZE_RESPONSE_ERROR_PREFIX = 'Cannot canonicalise a meal-planning action response: ';

/**
 * Orders two object keys exactly as `jsonb` orders them at rest: by UTF-8 BYTE
 * length first, then by the bytes themselves.
 *
 * Measured against the PostgreSQL 16 this service runs on rather than inferred:
 * `SELECT '{"ab":1,"é":2,"zzz":3,"b":4}'::jsonb::text` returns
 * `{"b": 4, "ab": 1, "é": 2, "zzz": 3}`. `é` is ONE JavaScript character and
 * TWO UTF-8 bytes, so it ties with `ab` on length and loses to it on bytes
 * (`0xC3` > `0x62`). `String.prototype.length` would have ordered it first, and
 * the stored text would then disagree with the served text for every body
 * carrying a non-ASCII key — the exact failure this ordering exists to remove.
 *
 * Lengths are compared through `Buffer.byteLength`, which measures without
 * allocating; the bytes are materialised only for the ties.
 *
 * A genuine three-way comparator, unlike {@link byCodeUnit} above: `Buffer`
 * comparison has an equality case, and the keys of one object are unique, so it
 * simply never fires.
 */
const byJsonbKeyOrder = (left: string, right: string): number => {
    const byteLengthDifference = Buffer.byteLength(left, 'utf8') - Buffer.byteLength(right, 'utf8');

    if (byteLengthDifference !== 0) {
        return byteLengthDifference;
    }

    return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
};

/**
 * The recursive worker behind {@link canonicalizeResponseBody}.
 *
 * It returns `unknown` because it walks arbitrary JSON data; every branch either
 * returns the value it was handed or a structural copy of it carrying the same
 * members, which is what lets the exported function restate the caller's own
 * type (see there). `ancestors` is the current recursion path, so an object
 * legitimately referenced twice in one body is fine and only a true cycle is
 * refused — the same rule, and the same mechanics, as {@link canonicalize}.
 */
const canonicalizeResponse = (value: unknown, path: string, ancestors: Set<object>): unknown => {
    if (value === null) {
        return null;
    }

    if (typeof value === 'number') {
        if (!Number.isFinite(value)) {
            throw new TypeError(
                `${CANONICALIZE_RESPONSE_ERROR_PREFIX}${path} is ${String(value)}, which JSON has no ` +
                    'representation for. `JSON.stringify` renders it as `null` while the value in memory stays ' +
                    'non-finite, so the first response and its replay would disagree about it. Refusing to ' +
                    'store a body whose bytes cannot be reproduced.',
            );
        }

        // Returned as the number it is, NOT rounded. The two-decimal token
        // above is a FINGERPRINT rule — it exists so `1`, `1.0` and `"1"` hash
        // alike — and applying it to a response would rewrite the values the
        // client is owed. A stored response is reproduced, never renormalised.
        return value;
    }

    if (typeof value === 'boolean' || typeof value === 'string') {
        return value;
    }

    if (value === undefined) {
        // Only the body ITSELF can reach this branch: an object property
        // holding `undefined` is dropped below (as `JSON.stringify` drops it)
        // and an array element holding it becomes `null` (as `JSON.stringify`
        // renders it). An `undefined` body is refused rather than stored,
        // because Prisma treats `undefined` as "leave this column alone": the
        // completion would then fill the status and the revision and leave
        // `response_snapshot` NULL, which is precisely the half-completed row
        // {@link classifyActionCompletion} calls corrupt.
        throw new TypeError(
            `${CANONICALIZE_RESPONSE_ERROR_PREFIX}${path} is undefined, which is not a JSON value and is not a ` +
                'response body. Storing it would leave response_snapshot NULL beside a filled status and ' +
                'revision, which is a corrupt ledger row rather than a replayable one.',
        );
    }

    if (typeof value !== 'object') {
        // `bigint`, `function` and `symbol`. None can survive a JSON round
        // trip: `JSON.stringify` throws on a bigint and silently drops the
        // other two, so a body carrying one could never replay as its own bytes.
        throw new TypeError(
            `${CANONICALIZE_RESPONSE_ERROR_PREFIX}${path} is a ${typeof value}, which has no JSON ` +
                'representation. Convert it at the boundary that produced it.',
        );
    }

    if (ancestors.has(value)) {
        throw new TypeError(
            `${CANONICALIZE_RESPONSE_ERROR_PREFIX}${path} is a circular reference, which cannot be serialised ` +
                'at all.',
        );
    }

    ancestors.add(value);

    try {
        if (Array.isArray(value)) {
            // ARRAY ORDER IS SEMANTIC and is preserved — the plan's seven days
            // are in date order — so only object keys are reordered. Indexed
            // rather than `map`, so a sparse hole is emitted as the `null`
            // `JSON.stringify` renders it instead of staying a hole `map`
            // would skip.
            const elements: unknown[] = [];

            for (let index = 0; index < value.length; index += 1) {
                const element: unknown = value[index];

                elements.push(
                    element === undefined ? null : canonicalizeResponse(element, `${path}[${index}]`, ancestors),
                );
            }

            return elements;
        }

        if (!isPlainObject(value)) {
            // A `Date`, a `Map`, a Prisma `Decimal` or any other class instance.
            // `JSON.stringify` would either call a `toJSON` this module cannot
            // see or write `{}`, and either way the stored text would stop
            // being a function of the value served. The mappers already convert
            // both cases the meal-planning DTOs could produce — `@db.Date`
            // columns become `YYYY-MM-DD` day keys and `NUMERIC` columns become
            // numbers — so reaching here means a mapper stopped doing that.
            throw new TypeError(
                `${CANONICALIZE_RESPONSE_ERROR_PREFIX}${path} is a ${value.constructor?.name ?? 'non-plain'} ` +
                    'instance, not plain JSON data. Serialise it in the mapper that produced the response.',
            );
        }

        // Insertion order IS the serialisation order for a plain object, so
        // writing the keys in `jsonb`'s order is what makes the served text
        // match the stored text. `undefined`-valued keys are dropped exactly as
        // `JSON.stringify` drops them, so the two cannot disagree over whether
        // the key was there.
        const entries = Object.entries(value as Record<string, unknown>)
            .filter(([, nested]) => nested !== undefined)
            .sort(([leftKey], [rightKey]) => byJsonbKeyOrder(leftKey, rightKey));

        // `Object.fromEntries` DEFINES each key as an own data property, which
        // is why the keys are not assigned one by one. `canonical[key] = …`
        // would reach the inherited `Object.prototype.__proto__` setter for a
        // key spelled `__proto__`: the key would silently vanish from the copy
        // and, for an object value, become the copy's prototype instead. That
        // key is ordinary JSON — `JSON.parse` makes it an own property and
        // `jsonb` stores and orders it like any other, by the same byte-length
        // rule — so a body carrying one has to round-trip unchanged rather than
        // come back a key short with a mutated prototype. Defining the keys
        // also keeps this a faithful copy for every other inherited accessor
        // name a future response could legitimately contain.
        return Object.fromEntries(
            entries.map(([key, nested]) => [key, canonicalizeResponse(nested, `${path}.${key}`, ancestors)]),
        );
    } finally {
        ancestors.delete(value);
    }
};

/**
 * A response body as the value `jsonb` will hold — a deep copy whose every
 * plain object carries its keys in the column's own order.
 *
 * This is what makes §0.9.2's "byte-for-byte" replay TRUE rather than
 * approximated. Both attempts serialise a canonically ordered value: the first
 * response is the value {@link shapeStoredResponse} froze, and a replay is that
 * same value read back out of a column whose at-rest reordering is, for this
 * order, the identity. So `JSON.stringify` of the two agrees exactly.
 *
 * The rules, each pinned by `__tests__/mealPlanningAction.logic.test.ts`:
 *
 *  - object keys are ordered recursively by {@link byJsonbKeyOrder} — UTF-8
 *    byte length, then bytes;
 *  - ARRAY ORDER IS PRESERVED, because order is meaning in an array;
 *  - numbers, strings, booleans and `null` are reproduced as they are; no
 *    rounding, no renormalisation (the fingerprint's two-decimal token is a
 *    request rule and has no business rewriting a stored response);
 *  - a key whose value is `undefined` is DROPPED, exactly as `JSON.stringify`
 *    drops it, so the stored text and the served text cannot disagree over it;
 *  - the function is IDEMPOTENT: canonicalising a canonical body returns the
 *    same shape again, which is what lets {@link readStoredResponse} apply it
 *    to a row without caring which build wrote it.
 *
 * Anything with no faithful JSON representation is REFUSED, naming the path
 * (`$.days[0].planned.calories`) so the offending field is found without a
 * debugger: a non-finite number, a `bigint`/`function`/`symbol`, an `undefined`
 * body, a non-plain object such as a `Date`, `Map`, `Set` or Prisma `Decimal`,
 * and a cycle. Refusing is the point — storing any of them would make the
 * byte guarantee false, and a guarantee that silently does not hold is worse
 * than an error the caller can see. Non-enumerable and symbol-keyed properties
 * are ignored, as `JSON.stringify` ignores them.
 *
 * One JavaScript detail rides along and is harmless: an object's array-index
 * keys (`'0'`, `'10'`) are hoisted ahead of its string keys by the language
 * itself, in both this copy and the `JSON.parse` of the column, so the two
 * SERVED texts still agree even though the column's own text would order such a
 * key differently. No meal-planning DTO carries one.
 *
 * The generic restates the caller's type instead of widening to `unknown`: the
 * copy carries the same members as its input, so it inhabits the same type, and
 * a key dropped for holding `undefined` was optional by definition. That keeps
 * {@link StoredActionResponse}'s `responseSnapshot` typed as the action's own
 * response body, and keeps the one cast in this function rather than at every
 * call site. Reading a stored row passes `unknown` in and gets `unknown` back,
 * which is exactly what a `jsonb` column is worth.
 */
export const canonicalizeResponseBody = <TBody>(body: TBody): TBody =>
    canonicalizeResponse(body, '$', new Set<object>()) as TBody;

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
 *                status and revision exactly, and a body that serialises to the
 *                same bytes as the first response.
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
 * they were recorded, and a body that serialises to the same bytes as the first
 * response because both are canonically ordered (see
 * {@link readStoredResponse} and {@link canonicalizeResponseBody}).
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
 *
 * **The body is stored CANONICALISED, and that is what makes §0.9.2's
 * byte-for-byte replay hold.** {@link canonicalizeResponseBody} orders every
 * object's keys the way the `jsonb` column will order them anyway, so the
 * column's at-rest reordering has nothing left to do. The value this returns is
 * also exactly what `runKeyedAction` answers the FIRST attempt with — it returns
 * what was frozen here rather than the caller's own object — so the first
 * response and every replay of it serialise from the same ordered value and
 * therefore to the same bytes. Storing the caller's object as it arrived would
 * make the first response's key order an accident of how a mapper happened to
 * build it, and no later replay could reproduce it.
 *
 * A body that cannot be represented faithfully is refused here rather than
 * written: the transaction rolls back, the reservation disappears with it, and
 * the key is free to be retried once the mapper is fixed. See
 * {@link canonicalizeResponseBody} for the closed list of what that covers.
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
        responseSnapshot: canonicalizeResponseBody(body),
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
 * **The body comes back in canonical key order, so it serialises to the same
 * BYTES as the first response.** `meal_plan_actions.response_snapshot` is a
 * `jsonb` column, and PostgreSQL normalises an object's key order at rest —
 * keys sorted by UTF-8 byte length, then by bytes, at every nesting level.
 * {@link shapeStoredResponse} stores the body in exactly that order, so the
 * column has nothing to reorder and the value read back is ordered identically
 * to the value served the first time. §0.9.2's replay row — "returns the stored
 * 201/200 body byte-for-byte" — therefore holds literally, and a test of it may
 * compare `JSON.stringify` of the two bodies as well as the parsed values.
 *
 * {@link canonicalizeResponseBody} is applied HERE as well, and not out of
 * distrust of the column: it is a no-op for a row this build wrote, and it is
 * what keeps the guarantee true for a row written by an EARLIER build, whose
 * arbitrary insertion order `jsonb` already normalised to this same canonical
 * order at rest. Such a row replays byte-identically to a freshly shaped
 * response rather than "byte-identically to whatever it was stored as". The
 * pass is idempotent, so applying it on both the write and the read path costs
 * one walk of a small object and removes the only case where the two paths
 * could disagree.
 *
 * Key order was never client-visible meaning — a JSON object is unordered and
 * the mobile io-ts decoders read by key — but §0.5.1 requires a response a
 * client "can never distinguish" from the original, and identical bytes is the
 * form of that which cannot be argued with.
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
            body: canonicalizeResponseBody(row.responseSnapshot),
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
