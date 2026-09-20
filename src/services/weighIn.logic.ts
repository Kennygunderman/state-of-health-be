/* ---------------------------------------------------------------------------
 * The weigh-in write contract
 *
 * `POST /api/weigh-in` is a legacy route and `weighIn.service.ts` is straight
 * CRUD, which is why it carried no `*.logic.ts` until now (Rule
 * backend-architecture §7.1 — a module earns its existence with a rule worth
 * pinning). It has one now: `body_weight_entries.weight` is `double precision`
 * and the handler asked only that the value be finite and positive, so
 * `{"weight": 1e308}` was accepted and STORED. §0.5.2 requires a bounded
 * numeric with `400 invalid_request` and a field code for a violation, and an
 * unbounded stored weight is the same class of defect as the unbounded diary
 * numerics `nutrition.logic.ts` now refuses: the value is echoed by
 * `GET /api/weigh-ins` and charted by the app's progress surfaces, where a
 * single 1e308 row flattens every real reading to zero on the same axis.
 *
 * The rule is a MAGNITUDE cap and it is deliberately unit-agnostic. The column
 * records whatever unit the user's client is set to — the app stores kilograms
 * or pounds and converts for display — so the cap has to admit the largest
 * plausible reading in the largest unit: 300 kg is 661 lb is 47 st, all of
 * which are far inside 2,000. Nothing a person can weigh, in any unit this app
 * offers, is refused by it.
 *
 * WHAT IS PRESERVED. The existing refusal — a non-numeric, zero or negative
 * weight, or an unparsable `loggedAt` — keeps its frozen message-only 400 body
 * verbatim: that sentence is what every shipped client has been shown for those
 * bodies, and this module reports the same one rather than replacing it with a
 * machine code (§0.5.2 changes existing contracts additively only). The new
 * out-of-range refusal is the only new response, and it is the `400
 * invalid_request` envelope with `details: [{field, code}]` that §0.5.2
 * specifies — the same split `nutrition.logic.ts` makes between its frozen
 * legacy guard and its bounds.
 * ------------------------------------------------------------------------- */

/**
 * One element of the `400 invalid_request` body's `details` array. Same shape
 * as `nutrition.logic.ts`'s `LogEntryFieldError` and the wire's
 * `InvalidRequestDetail`, declared locally because this module has no imports —
 * it is pure arithmetic over a request.
 */
export interface WeighInFieldError {
    field: string;
    code: string;
}

/**
 * The wire vocabulary for a weigh-in `details[].code`:
 * - `required` — `weight` or `loggedAt` is absent, or present and unusable.
 *   Reported for logs and tests; the refusal it belongs to is rendered as the
 *   frozen message and carries no `details` on the wire (see
 *   {@link WEIGH_IN_REQUIRED_MESSAGE}).
 * - `out_of_range` — a well-formed weight past {@link MAX_WEIGH_IN_MAGNITUDE}.
 *   Spelled as `mealPlan.logic.ts` and `nutrition.logic.ts` spell the same
 *   condition, so the client maps one vocabulary.
 * - `invalid_id` — the `:id` path segment is not a UUID. Same spelling as
 *   `nutrition.logic.ts` and `food.logic.ts` use for the same refusal, because
 *   §0.5.2 gives one vocabulary for path ids across every route family.
 */
export const WEIGH_IN_FIELD_CODES = {
    REQUIRED: 'required',
    OUT_OF_RANGE: 'out_of_range',
    INVALID_ID: 'invalid_id',
} as const;

export const WEIGHT_FIELD = 'weight';
export const LOGGED_AT_FIELD = 'loggedAt';

/** The `:id` path segment of the delete route. */
export const WEIGH_IN_ID_FIELD = 'id';

/**
 * The shape PostgreSQL will accept for a `uuid` column.
 *
 * Deliberately re-asked here rather than imported from another domain's logic
 * module: Rule backend-architecture §4 puts the predicate with the input it
 * validates, and a weigh-in id is this module's input. The pattern is the same
 * canonical 8-4-4-4-12 hex form `nutrition.logic.ts` and `food.logic.ts` ask
 * for, case-insensitively, so the three families refuse and accept exactly the
 * same strings.
 */
const WEIGH_IN_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The largest weight this endpoint stores, in whatever unit the caller records.
 *
 * See the unit reasoning in the module note above: 2,000 admits every real
 * reading in kilograms, pounds or stone while keeping the stored value inside
 * the range the progress chart can scale, and it is twelve orders of magnitude
 * inside `double precision` so no arithmetic over stored rows can overflow.
 */
export const MAX_WEIGH_IN_MAGNITUDE = 2000;

/**
 * The exact text this endpoint has always returned for a weight it cannot use
 * or a date it cannot parse. Frozen: shipped clients render it verbatim.
 */
export const WEIGH_IN_REQUIRED_MESSAGE = 'weight must be a positive number and loggedAt a valid date';

/** The sentence the new bound is reported with. */
export const WEIGH_IN_RANGE_MESSAGE = `weight must be at most ${MAX_WEIGH_IN_MAGNITUDE}`;

/**
 * Which 400 the caller earned.
 *
 * - `weigh_in_fields_required` — the shipped guard refused the body. Answered
 *   with the frozen message-only body. **Not a wire value**: nothing serializes
 *   this name.
 * - `invalid_request` — a well-formed weight outside the contract. Rendered as
 *   `{error: 'invalid_request', details}`, the §0.5.2 envelope.
 */
export type WeighInErrorCode = 'weigh_in_fields_required' | 'invalid_request';

/**
 * The verdict of {@link parseWeighInBody}. Total: every input — including
 * `null`, an array or a primitive — returns a verdict rather than throwing, and
 * the error variant never picks a status code (both are 400s, and mapping to
 * HTTP belongs to the controller — Rule backend-architecture §8).
 *
 * `loggedAt` comes back as the parsed `Date` rather than the caller's value, so
 * the timestamp the row stores is the one this parser validated: the handler
 * cannot re-parse a different value, and a client that sends an epoch number
 * instead of an ISO string is still accepted exactly as it is today.
 */
export type ParsedWeighInBody =
    | { kind: 'ok'; weight: number; loggedAt: Date }
    | { kind: 'error'; code: WeighInErrorCode; message: string; details: WeighInFieldError[] };

const asRecord = (body: unknown): Record<string, unknown> | null =>
    typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

/**
 * The shipped guard's own question about the weight, kept verbatim: `Number()`
 * coercion, finite, strictly positive. A numeric string has always been
 * accepted here and must go on being accepted.
 */
const isUsableWeight = (value: number): boolean => Number.isFinite(value) && value > 0;

/**
 * Validates the whole `POST /api/weigh-in` body.
 *
 * The order is the compatibility rule: the frozen guard answers first, so every
 * body the endpoint already refuses keeps the message it has always been given,
 * and the bound below can only ever replace a `201` that stored an unusable
 * value — never an existing 400.
 */
export const parseWeighInBody = (body: unknown): ParsedWeighInBody => {
    const record = asRecord(body) ?? {};
    const weight = Number(record[WEIGHT_FIELD]);
    const loggedAt = new Date(record[LOGGED_AT_FIELD] as string | number | Date);
    const details: WeighInFieldError[] = [];

    if (!isUsableWeight(weight)) {
        details.push({ field: WEIGHT_FIELD, code: WEIGH_IN_FIELD_CODES.REQUIRED });
    }
    if (Number.isNaN(loggedAt.getTime())) {
        details.push({ field: LOGGED_AT_FIELD, code: WEIGH_IN_FIELD_CODES.REQUIRED });
    }

    if (details.length > 0) {
        return {
            kind: 'error',
            code: 'weigh_in_fields_required',
            message: WEIGH_IN_REQUIRED_MESSAGE,
            details,
        };
    }

    if (weight > MAX_WEIGH_IN_MAGNITUDE) {
        return {
            kind: 'error',
            code: 'invalid_request',
            message: WEIGH_IN_RANGE_MESSAGE,
            details: [{ field: WEIGHT_FIELD, code: WEIGH_IN_FIELD_CODES.OUT_OF_RANGE }],
        };
    }

    return { kind: 'ok', weight, loggedAt };
};

/**
 * The verdict of {@link parseWeighInPath}. Total, like the body parser: every
 * input returns a verdict rather than throwing, and neither variant picks a
 * status code.
 */
export type ParsedWeighInPath =
    | { kind: 'ok'; id: string }
    | { kind: 'error'; code: 'invalid_request'; details: WeighInFieldError[] };

/**
 * Refuses a `:id` path segment the database cannot parse as a UUID.
 *
 * This closes a measured 500. `DELETE /api/weigh-in/not-a-uuid` reached
 * `prisma.body_weight_entries.deleteMany()` with the raw segment and the
 * connector threw `P2023` — "Error creating UUID, invalid character" — which
 * the handler answered as `500 {"error":"Failed to delete weigh-in"}`. AAP
 * §0.5.2 requires `400 invalid_request` with a field code for a malformed path
 * id, and the diary's own entry routes and (as of this release) the food routes
 * already answer exactly that for the identical input. A malformed id is a
 * refusal the client earned, not a fault the server suffered, and answering it
 * as a 500 also fed the raw connector error to the log.
 *
 * Judged BEFORE the service call, so no query is issued for an id that cannot
 * match a row, and the 404 for a well-formed id that is not the caller's is
 * unchanged — existence and ownership stay indistinguishable.
 */
export const parseWeighInPath = (id: unknown): ParsedWeighInPath => {
    if (typeof id !== 'string' || !WEIGH_IN_ID_PATTERN.test(id)) {
        return {
            kind: 'error',
            code: 'invalid_request',
            details: [{ field: WEIGH_IN_ID_FIELD, code: WEIGH_IN_FIELD_CODES.INVALID_ID }],
        };
    }

    return { kind: 'ok', id };
};
