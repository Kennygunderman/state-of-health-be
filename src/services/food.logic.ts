import { CreateFoodPayload } from '../types/nutrition';

/* ---------------------------------------------------------------------------
 * The personal-food write contract
 *
 * `POST /api/foods` and `PUT /api/foods/:id` write the `foods` table, whose
 * four macro columns are `int4` and whose `serving_amount` is
 * `double precision`. Neither route bounded a number:
 *
 *  * `POST` asked only `Number.isFinite(Number(value))` for the four macros
 *    (`food.controller.ts::isValidFoodPayload`), so `{"calories": 1e308}` was
 *    rounded by `food.service.ts::createFood` and handed to PostgreSQL, which
 *    refused it — and the route answered 500 where §0.5.2 requires
 *    `400 invalid_request` with a field code.
 *  * `PUT` validated NOTHING. It called `payload.name.trim()` on an
 *    unvalidated body, so `{"name": 123}` was a `TypeError` inside the service
 *    and a 500 at the edge, and every numeric had the same overflow as `POST`.
 *
 * This module is the predicate both routes now call, and it exists as a
 * `*.logic.ts` rather than as a guard inside the controller for the reason
 * Rule backend-architecture §4 gives: a payload-shape check is pure logic the
 * controller delegates to, and §7's coverage gate holds every
 * `src/services/*.logic.ts` to 80 % branch coverage — which is how a bound
 * stays pinned. It is NOT in `src/utils/`: a shared pure rule belongs to the
 * parser that owns the input it validates, and `jest.config.ts`'s
 * `COVERED_UTIL_MODULES` is a closed four-entry list.
 *
 * WHAT IS PRESERVED, BYTE FOR BYTE.
 *
 *  * The create route's existing refusal keeps its frozen sentence. Every
 *    client that has sent a nameless or non-numeric create body has been shown
 *    `name, calories, protein, carbs, and fat are required`, and
 *    {@link FOOD_REQUIRED_MESSAGE} is that string. It carries no machine code,
 *    because the shipped response has none.
 *  * The numeric-string coercion. `Number(value)` and not `typeof value ===
 *    'number'`: a client sending `"220"` has always been accepted here and
 *    `createFood` rounds it identically.
 *  * The update route's partial semantics. An absent key is a column the
 *    request does not mention and the update leaves alone, so every field is
 *    judged only when the body names it.
 *  * `PUT` on a food the caller does not own is still the service's 404 — this
 *    parser never reads an id, so nothing about ownership moves to the edge and
 *    "missing" stays indistinguishable from "not yours".
 * ------------------------------------------------------------------------- */

/**
 * One element of the `400 invalid_request` body's `details` array. Same shape
 * as `nutrition.logic.ts`'s `LogEntryFieldError` and the wire's
 * `InvalidRequestDetail`.
 */
export interface FoodFieldError {
    field: string;
    code: string;
}

/**
 * The wire vocabulary for a food `details[].code`. Machine-readable only — the
 * client maps each code to its own copy:
 * - `required` — a create field is absent or unusable. Reported for logs and
 *   tests; the refusal it belongs to is answered with the frozen sentence and
 *   carries no `details` on the wire.
 * - `invalid_type` — present, but not the type the column holds: a `name` that
 *   is not a string, or a number that does not coerce.
 * - `out_of_range` — a well-formed number outside the column's range.
 * - `invalid_length` — a stored string longer than its cap.
 *
 * The spellings match `nutrition.logic.ts`, `mealPlan.logic.ts` and
 * `catalog.logic.ts`, so the client maps one vocabulary and not four.
 */
export const FOOD_FIELD_CODES = {
    REQUIRED: 'required',
    INVALID_TYPE: 'invalid_type',
    OUT_OF_RANGE: 'out_of_range',
    INVALID_LENGTH: 'invalid_length',
    INVALID_ID: 'invalid_id',
} as const;

/** The `details[].field` the path-id refusal reports, matching the route segment. */
export const FOOD_ID_FIELD = 'id';

/** The four macro fields, in the order the frozen message lists them. */
export const FOOD_MACRO_FIELDS = ['calories', 'protein', 'carbs', 'fat'] as const;

export const FOOD_NAME_FIELD = 'name';
export const FOOD_SERVING_AMOUNT_FIELD = 'servingAmount';

/**
 * The largest magnitude a food's macro may carry, per serving.
 *
 * The same bound `nutrition.logic.ts` applies to a diary entry's macros, and
 * for the same reason: these numbers become a diary entry's snapshot when the
 * food is logged, so a value this table accepts is a value the diary's
 * aggregates have to sum. 100,000 kcal/g per serving is far past any real food
 * and four orders of magnitude inside `int4`.
 */
export const MAX_FOOD_MACRO_MAGNITUDE = 100_000;

/**
 * The largest `serving_amount` a food may carry.
 *
 * `serving_amount` is a `double precision` count of `serving_unit`s ("4 oz",
 * "2 tbsp"), so an unbounded value stored 1e308 and multiplied into nothing
 * useful. 100,000 units of anything is already absurd, and the bound keeps the
 * column's product with a macro inside the range the diary can sum.
 */
export const MAX_SERVING_AMOUNT = 100_000;

/**
 * The longest `name` a food may store, measured after the trim `createFood`
 * applies.
 *
 * The same 300 characters `nutrition.logic.ts` caps a diary entry's name at,
 * because a branded food logged through `GET /macros/search-branded-foods`
 * carries a USDA description into this column and the diary's own name column
 * receives it from here.
 */
export const MAX_FOOD_NAME_LENGTH = 300;

/**
 * The exact text `POST /api/foods` has always returned for a body it cannot
 * store. Frozen: shipped clients render it verbatim.
 */
export const FOOD_REQUIRED_MESSAGE = 'name, calories, protein, carbs, and fat are required';

/**
 * Which 400 the caller earned.
 *
 * - `food_fields_required` — the shipped create guard refused the body.
 *   Answered with the frozen message-only body. **Not a wire value**: nothing
 *   serializes this name.
 * - `invalid_request` — a well-formed field outside its contract. Rendered as
 *   `{error: 'invalid_request', details}`, the §0.5.2 envelope.
 */
export type FoodErrorCode = 'food_fields_required' | 'invalid_request';

export type FoodErrorVerdict = {
    kind: 'error';
    code: FoodErrorCode;
    message: string;
    details: FoodFieldError[];
};

/** The verdict of {@link parseCreateFoodBody}: the body to hand the writer, or a 400. */
export type ParsedCreateFood = { kind: 'ok'; payload: CreateFoodPayload } | FoodErrorVerdict;

/** The verdict of {@link parseUpdateFoodBody}, whose payload is partial by design. */
export type ParsedUpdateFood = { kind: 'ok'; payload: Partial<CreateFoodPayload> } | FoodErrorVerdict;

const asRecord = (body: unknown): Record<string, unknown> | null =>
    typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

/** The shipped create guard's own question about a number, kept verbatim. */
const coercesToFiniteNumber = (value: unknown): boolean => Number.isFinite(Number(value));

const exceedsMagnitude = (value: unknown, bound: number): boolean => {
    const numeric = Number(value);

    return Number.isFinite(numeric) && Math.abs(numeric) > bound;
};

const isUsableName = (value: unknown): boolean => typeof value === 'string' && value.trim().length > 0;

const exceedsNameLength = (value: unknown): boolean =>
    typeof value === 'string' && value.trim().length > MAX_FOOD_NAME_LENGTH;

/**
 * The sentence one bound failure is reported with, derived from its code so the
 * message and the machine code cannot describe different rules.
 */
const boundMessage = ({ field, code }: FoodFieldError): string => {
    switch (code) {
        case FOOD_FIELD_CODES.INVALID_LENGTH:
            return `${field} must be at most ${MAX_FOOD_NAME_LENGTH} characters`;
        case FOOD_FIELD_CODES.INVALID_TYPE:
            return field === FOOD_NAME_FIELD ? `${field} must be a string` : `${field} must be a number`;
        case FOOD_FIELD_CODES.INVALID_ID:
            // Stated explicitly rather than falling through: the default below
            // describes a numeric range, which would misdescribe a path id.
            return `${field} must be a UUID`;
        default:
            return field === FOOD_SERVING_AMOUNT_FIELD
                ? `${field} must be between -${MAX_SERVING_AMOUNT} and ${MAX_SERVING_AMOUNT}`
                : `${field} must be between -${MAX_FOOD_MACRO_MAGNITUDE} and ${MAX_FOOD_MACRO_MAGNITUDE}`;
    }
};

const invalidRequest = (errors: FoodFieldError[]): FoodErrorVerdict => ({
    kind: 'error',
    code: 'invalid_request',
    message: errors.map(boundMessage).join('; '),
    details: errors,
});

/**
 * The types and bounds every stored field is judged by, for whichever of them
 * the body carries.
 *
 * SHARED BY BOTH ROUTES, deliberately: the `foods` row is the same row either
 * way, so a value the create route refuses must not be writable by an update
 * instead — and a create body's `servingAmount` was never judged at all, which
 * is its own 500.
 *
 * One pass per field, type before bound, so a field that is not a number has
 * one thing wrong with it rather than two. Reports every offending field of one
 * body at once, in the order the columns are written, so one round trip tells
 * the caller everything it has to fix — the same reporting rule
 * `nutrition.logic.ts` follows.
 */
const storedFieldErrors = (record: Record<string, unknown>): FoodFieldError[] => {
    const errors: FoodFieldError[] = [];
    const name = record[FOOD_NAME_FIELD];
    const servingAmount = record[FOOD_SERVING_AMOUNT_FIELD];

    if (name !== undefined && typeof name !== 'string') {
        errors.push({ field: FOOD_NAME_FIELD, code: FOOD_FIELD_CODES.INVALID_TYPE });
    } else if (exceedsNameLength(name)) {
        errors.push({ field: FOOD_NAME_FIELD, code: FOOD_FIELD_CODES.INVALID_LENGTH });
    }

    FOOD_MACRO_FIELDS.forEach((field) => {
        const value = record[field];

        if (value === undefined) return;

        if (!coercesToFiniteNumber(value)) {
            errors.push({ field, code: FOOD_FIELD_CODES.INVALID_TYPE });
        } else if (exceedsMagnitude(value, MAX_FOOD_MACRO_MAGNITUDE)) {
            errors.push({ field, code: FOOD_FIELD_CODES.OUT_OF_RANGE });
        }
    });

    // `servingAmount` is optional on both routes and `createFood` defaults an
    // absent or null one to 1, so neither is a failure — but a value that is
    // present and unusable reached `serving_amount` and came back as a 500.
    if (servingAmount !== undefined && servingAmount !== null) {
        if (!coercesToFiniteNumber(servingAmount)) {
            errors.push({ field: FOOD_SERVING_AMOUNT_FIELD, code: FOOD_FIELD_CODES.INVALID_TYPE });
        } else if (exceedsMagnitude(servingAmount, MAX_SERVING_AMOUNT)) {
            errors.push({ field: FOOD_SERVING_AMOUNT_FIELD, code: FOOD_FIELD_CODES.OUT_OF_RANGE });
        }
    }

    return errors;
};

/**
 * Validates a `POST /api/foods` body.
 *
 * The frozen guard answers first — a body missing a name or a macro keeps the
 * sentence it has always been shown — so the checks below can only replace the
 * 500 the column used to produce.
 */
export const parseCreateFoodBody = (body: unknown): ParsedCreateFood => {
    const record = asRecord(body) ?? {};
    const required: FoodFieldError[] = [];

    if (!isUsableName(record[FOOD_NAME_FIELD])) {
        required.push({ field: FOOD_NAME_FIELD, code: FOOD_FIELD_CODES.REQUIRED });
    }

    FOOD_MACRO_FIELDS.forEach((field) => {
        if (!coercesToFiniteNumber(record[field])) {
            required.push({ field, code: FOOD_FIELD_CODES.REQUIRED });
        }
    });

    if (required.length > 0) {
        return { kind: 'error', code: 'food_fields_required', message: FOOD_REQUIRED_MESSAGE, details: required };
    }

    const errors = storedFieldErrors(record);

    if (errors.length > 0) return invalidRequest(errors);

    // Handed on unchanged, exactly as the controller has always handed
    // `req.body` to `createFood`: the writer reads `servingUnit`, `brand` and
    // `source` itself and applies its own defaults and whitelist, and a
    // numeric-string macro must reach `Math.round` untouched.
    return { kind: 'ok', payload: body as CreateFoodPayload };
};

/**
 * Validates a `PUT /api/foods/:id` body.
 *
 * Every field is judged only when the body names it, which is the update's
 * partial contract. `name` is type-checked here rather than left to the
 * service's `payload.name.trim()`, which threw a `TypeError` on a non-string
 * and answered 500 for a request only the caller could fix.
 *
 * Two behaviours are preserved: a body naming no writable field writes no
 * column and answers 200 with the row as it stands, and a body that is not an
 * object at all is the same no-op rather than a new refusal. Ownership is
 * untouched — this parser never reads an id, so a food that is not the
 * caller's is still the service's 404 and "missing" stays indistinguishable
 * from "not yours".
 */
export const parseUpdateFoodBody = (body: unknown): ParsedUpdateFood => {
    const record = asRecord(body);

    if (record === null) return { kind: 'ok', payload: {} };

    // The one field the two routes judge differently, and the difference is the
    // writer's: `createFood` reads `payload.servingAmount ?? 1`, so a `null`
    // there means "use the default", while `updateFood` writes the value
    // through and `foods.serving_amount` is NOT NULL — so a `null` reached the
    // column and answered 500. It is reported last because it is the last
    // column written.
    const clearsServingAmount = record[FOOD_SERVING_AMOUNT_FIELD] === null;
    const errors = [
        ...storedFieldErrors(record),
        ...(clearsServingAmount
            ? [{ field: FOOD_SERVING_AMOUNT_FIELD, code: FOOD_FIELD_CODES.INVALID_TYPE }]
            : []),
    ];

    if (errors.length > 0) return invalidRequest(errors);

    return { kind: 'ok', payload: body as Partial<CreateFoodPayload> };
};

/**
 * The `:id` segment of `PUT /api/foods/:id` and `DELETE /api/foods/:id`.
 *
 * Both handlers passed `req.params.id` straight to Prisma, so a value the ORM's
 * uuid parser refuses — `not-a-uuid` — surfaced as `PrismaClientKnownRequestError`
 * P2023 and a `500`, while the diary's own routes answered the identical input
 * with `400 invalid_request {field:'id', code:'invalid_id'}` through
 * `nutrition.logic.ts::parseEntryPath`. AAP §0.5.2 requires the typed refusal
 * for every path id, so the two route families now give the same answer to the
 * same question; an unparsable id is a syntax error the caller can fix, not a
 * fault, and not a missing row.
 *
 * The grammar is deliberately `nutrition.logic.ts::isDatabaseParsableUuid`'s,
 * re-asked here rather than imported: `backend-architecture` §4 puts a rule in
 * the `*.logic.ts` that owns the input it validates, and the food routes own
 * their own path. Judged before the ownership read, like the body parsers above,
 * so a malformed id reveals nothing about whether a food exists.
 */
const FOOD_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** The verdict of {@link parseFoodPath}: the id to hand the writer, or a 400. */
export type ParsedFoodPath = { kind: 'ok'; id: string } | FoodErrorVerdict;

export const parseFoodPath = (id: unknown): ParsedFoodPath => {
    if (typeof id !== 'string' || !FOOD_ID_PATTERN.test(id)) {
        return invalidRequest([{ field: FOOD_ID_FIELD, code: FOOD_FIELD_CODES.INVALID_ID }]);
    }

    return { kind: 'ok', id };
};
