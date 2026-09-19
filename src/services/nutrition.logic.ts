import { CatalogNutritionBasis, CatalogNutritionProvenance } from '../types/catalog';
import {
    ClientInputMethod,
    EntryInputMethod,
    LogCatalogMealEntryPayload,
    LogMealEntryPayload,
    MacroTotals,
    NutritionProvenance,
    UpdateMealEntryPayload,
} from '../types/nutrition';
import {
    isCatalogNutritionBasis,
    isCatalogNutritionProvenance,
    normalizeToPer100g,
} from './catalog.logic';

/**
 * One element of the `400 invalid_request` body's `details` array: the field the
 * caller must fix, plus a stable machine code the client maps to copy. Same
 * shape as the wire's `InvalidRequestDetail`, declared locally because this
 * module's only import is its own domain's DTOs.
 */
export interface LogEntryFieldError {
    field: string;
    code: string;
}

/**
 * Which 400 the caller earned. Two of these are the wire code itself; the other
 * two are compatibility verdicts that no response ever spells as `error`.
 *
 * - `legacy_fields_required` — the shipped `isValidMacroPayload` guard refused a
 *   legacy body. The controller answers it with the historical message-only
 *   body, because every client that has ever sent a malformed legacy body has
 *   been shown that exact string. **Not a wire value**: nothing serializes this
 *   name, and a response must never carry it as `error`.
 * - `invalid_request` — a catalog body's own fields are unusable. Rendered as
 *   `{error: 'invalid_request', details}`: the machine code plus the per-field
 *   codes, which is the contract the catalog shape shipped with and which the
 *   app's ApiErrorUtility already maps.
 * - `invalid_payload` — the body named BOTH a personal and a catalog food, so no
 *   shape could be chosen. Rendered as `{error: 'invalid_payload', details}`.
 *   §0.3.1 names this refusal and this code; it is also a body no shipped client
 *   can produce, since `catalogFoodId` is new in this release, so there is no
 *   historical `error` string to preserve for it — and the frozen sentence would
 *   be false here, because such a body routinely carries all five legacy fields.
 * - `unrecognized_payload` — the body named NEITHER shape. Also §0.3.1's
 *   `invalid_payload`, but rendered `{error: <the frozen legacy sentence>, code:
 *   'invalid_payload', details}`: this is the one refusal a shipped client can
 *   still reach (an empty or unrecognised body is a client bug, not a new
 *   feature), and it has always been answered with the frozen sentence. Carrying
 *   the sentence as `error` and the code beside it satisfies §0.3.1's
 *   machine-readable code and §0.5.2's additive-only rule at once — a client
 *   rendering `error` verbatim no longer shows a user the literal string
 *   `invalid_payload`. **Not a wire value** as `error`.
 *
 * The distinction exists because the bodies are not interchangeable: the legacy
 * sentence is a frozen string kept for compatibility, and reusing it for a
 * catalog failure loses the code and field details the client needs to say which
 * field to fix — while dropping it from the one refusal that predates the
 * catalog shape changes a response shipped clients read.
 */
export type LogEntryErrorCode =
    | 'legacy_fields_required'
    | 'invalid_request'
    | 'invalid_payload'
    | 'unrecognized_payload';

/**
 * The verdict of {@link parseLogEntryBody}. `legacy` and `catalog` name which
 * writer the controller must call — the two are mutually exclusive, so the
 * legacy `food_id` dedupe path can never be entered for a catalog food. The
 * error variant reports; it never throws and never picks a status code (every
 * one of them is a 400), because mapping to HTTP belongs to the controller.
 */
export type ParsedLogEntryBody =
    | { kind: 'legacy'; payload: LogMealEntryPayload }
    | { kind: 'catalog'; payload: LogCatalogMealEntryPayload }
    | {
          kind: 'error';
          code: LogEntryErrorCode;
          message: string;
          details: LogEntryFieldError[];
      };

/**
 * The error verdict on its own, so the controller can map verdict to response
 * body in one exhaustive function instead of re-deriving the distinction from
 * the request it already handed over.
 */
export type LogEntryErrorVerdict = Extract<ParsedLogEntryBody, { kind: 'error' }>;

type LogEntryRoute = 'legacy' | 'catalog' | 'conflict' | 'unrecognized';

/**
 * The wire vocabulary for `details[].code`:
 * - `required` — a legacy field is absent or unusable (blank/non-string name, a
 *   macro that does not coerce to a finite number). The shipped 400 message
 *   calls all five "required", and these details enrich that message per field.
 * - `invalid_id` — an id that is not a v4 UUID: `catalogFoodId`, or a path id
 *   (`mealId`, `id`). An absent `catalogFoodId` is never this code: its
 *   presence is what selects the catalog shape at all.
 * - `invalid_servings` — `servings` is absent or outside the servings contract.
 * - `invalid_type` — `servingText` was sent as something other than a string.
 * - `invalid_characters` — a string the request asks the server to STORE holds
 *   a character the column cannot represent. Only U+0000 qualifies; see
 *   {@link containsNulCharacter}.
 * - `conflicting_food_reference` — the body names both a personal food and a
 *   catalog food, so no shape can be chosen for it.
 * - `unrecognized_payload` — the body names neither shape.
 *
 * The spellings match `grocery.logic.ts`, `plannedMealLog.logic.ts` and
 * `targets.logic.ts`, so the client maps one vocabulary and not four.
 */
const FIELD_ERROR_CODES = {
    REQUIRED: 'required',
    INVALID_ID: 'invalid_id',
    INVALID_SERVINGS: 'invalid_servings',
    INVALID_TYPE: 'invalid_type',
    INVALID_CHARACTERS: 'invalid_characters',
    CONFLICTING_FOOD_REFERENCE: 'conflicting_food_reference',
    UNRECOGNIZED_PAYLOAD: 'unrecognized_payload',
} as const;

const LEGACY_MACRO_FIELDS = ['calories', 'protein', 'carbs', 'fat'] as const;

// The field names a `details[]` entry reports. The two path names are the route
// parameters as `nutrition.routes.ts` spells them — `:mealId` on
// `POST /macros/meal/:mealId/entries` and `:id` on `/macros/entry/:id` — so the
// detail names the segment the caller has to fix rather than a name only this
// module uses.
const MEAL_ID_PATH_FIELD = 'mealId';
const ENTRY_ID_PATH_FIELD = 'id';

// Fields only a legacy body carries. `servings` and `servingText` are absent by
// design: both shapes use them, so neither may act as a shape signal.
const LEGACY_INTENT_FIELDS: readonly string[] = ['foodId', 'name', 'rawInput', ...LEGACY_MACRO_FIELDS];

/**
 * The exact text this endpoint has always returned for a body it cannot log,
 * and the `error` value of TWO verdicts rather than one: the legacy guard's
 * refusal, and the body that names no shape at all.
 *
 * The second is why this constant is worth a comment. A body with no
 * recognisable field ( `{}`, `[1,2,3]`, `{"somethingElse":1}` ) has earned this
 * sentence since long before the catalog shape existed, because the shipped
 * `isValidMacroPayload` guard refused everything that was not a legacy body. It
 * is also the only one of this parser's refusals a SHIPPED client can still
 * reach — nothing that predates this release sends `catalogFoodId` — so
 * replacing the sentence with a machine code would change a live response for
 * the one caller that cannot have been updated, and a client that renders
 * `error` verbatim would show a user the literal word `invalid_payload`. The
 * code travels alongside it instead (§0.3.1 + §0.5.2).
 *
 * A more precise sentence for that case ("either catalogFoodId or name,
 * calories, …") was deliberately dropped: it named the new shape to a caller
 * that cannot send it, and the machine code plus `details` is what a
 * catalog-aware client reads.
 */
const LEGACY_REQUIRED_MESSAGE = 'name, calories, protein, carbs, and fat are required';
const CONFLICTING_REFERENCE_MESSAGE = 'foodId and catalogFoodId cannot both be provided';

const MIN_SERVINGS = 0.25;
const MAX_SERVINGS = 10;
const SERVINGS_DECIMALS = 2;
const SERVINGS_SCALE = 10 ** SERVINGS_DECIMALS;
const SERVINGS_SCALE_TOLERANCE = 1e-9;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/* ---------------------------------------------------------------------------
 * The ids the database layer can parse
 *
 * `isUuidV4` above is the validation contract for ids this release INTRODUCES
 * (§0.5.2: "every path id is a UUID v4 (`invalid_id`)"), and it is deliberately
 * narrower than what the data layer accepts. The legacy diary-entry routes need
 * the wider grammar, and the difference is a compatibility rule rather than a
 * preference — see {@link isDatabaseParsableUuid}.
 * ------------------------------------------------------------------------- */

/**
 * The 8-4-4-4-12 body, with NO version or variant constraint. Shared by three of
 * the four accepted forms below so the grammar is written once.
 */
const HYPHENATED_UUID_SOURCE = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';

/**
 * Exactly the four textual forms the ORM's UUID parameter parser accepts, in the
 * order its own parser tries them:
 *
 *  1. simple      — 32 hex digits, no separators
 *  2. hyphenated  — 8-4-4-4-12, any version and variant nibble (a v1 id included)
 *  3. braced      — `{` + the HYPHENATED form + `}` (braces around the simple
 *                   form are rejected, because the parser dispatches on length)
 *  4. urn         — `urn:uuid:` + the HYPHENATED form, lower-case prefix only
 *                   (`URN:UUID:` and `urn:uuid:` + the simple form are rejected)
 *
 * Hex digits are case-insensitive in every form; the literal braces and the URN
 * prefix are not. Anything outside this union raises Prisma P2023 before the
 * statement runs, which is the class the routes below answer `400`.
 */
const DATABASE_PARSABLE_UUID_PATTERNS: readonly RegExp[] = [
    /^[0-9a-fA-F]{32}$/,
    new RegExp(`^${HYPHENATED_UUID_SOURCE}$`),
    new RegExp(`^\\{${HYPHENATED_UUID_SOURCE}\\}$`),
    new RegExp(`^urn:uuid:${HYPHENATED_UUID_SOURCE}$`),
];

/**
 * Whether the data layer can turn this value into a `uuid` parameter at all.
 *
 * The predicate the LEGACY diary-entry path ids are judged by, and the reason it
 * is not {@link isUuidV4}. An id in any of the four forms above reaches the
 * query, matches no row and earns the `404` those routes have always answered —
 * so refusing it with a `400` would change a branch shipped clients act on ("the
 * entry is gone, drop it from the cache" becomes a generic error), which §0.5.2
 * forbids: existing contracts change additively only, and §0.5.1 grants
 * `updateMealEntry` its owner-bearing predicate "with unchanged HTTP semantics".
 * A v1 id, a 32-hex id, a braced id and a `urn:uuid:` id are all well-formed to
 * the parser and were all `404`s before this release.
 *
 * Everything else is the case the routes used to answer `500` for — an
 * unparsable id is a syntax error, not a missing row — and turning that into a
 * typed `400 invalid_request` is the improvement this release keeps.
 *
 * Deciding it here, over the request, rather than translating Prisma's P2023 at
 * the controller is the same reasoning {@link containsNulCharacter} rests on:
 * `backend-architecture` §9 forbids branching on a vendor's error shape, and a
 * pure predicate is testable without a database (§11).
 *
 * Narrower than PostgreSQL's own `uuid_in`, deliberately: `uuid_in` also accepts
 * hyphens after any group of four digits (`A0EEBC99-9C0B4EF8-BB6D6BB9-BD380A11`),
 * but the ORM's parser refuses those before the value ever reaches the server,
 * and the routes never hand these ids to raw SQL. The grammar that governs is
 * the one the code path actually uses.
 */
export const isDatabaseParsableUuid = (value: unknown): value is string =>
    typeof value === 'string' && DATABASE_PARSABLE_UUID_PATTERNS.some((pattern) => pattern.test(value));

/**
 * The method a catalog entry stores. `logCatalogMealEntry` stamps it
 * server-side whatever the body says, so the parser normalizes to it rather
 * than carrying forward a client value that will not be honoured; both the
 * parser and that writer read it from here, so the two cannot drift. Typed from
 * the payload so the DTO stays the one place the accepted value is declared.
 */
export const CATALOG_INPUT_METHOD: LogCatalogMealEntryPayload['inputMethod'] = 'search';

const CATALOG_FIELD_MESSAGES: Record<string, string> = {
    catalogFoodId: 'catalogFoodId must be a v4 UUID',
    servings: `servings must be a number between ${MIN_SERVINGS} and ${MAX_SERVINGS} with at most ${SERVINGS_DECIMALS} decimal places`,
    servingText: 'servingText must be a string',
};

const asRecord = (body: unknown): Record<string, unknown> | null =>
    typeof body === 'object' && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>) : null;

const isPresent = (value: unknown): boolean => value !== undefined && value !== null;

const isUuidV4 = (value: unknown): value is string => typeof value === 'string' && UUID_V4_PATTERN.test(value);

const isServingsInContract = (value: unknown): value is number => {
    if (typeof value !== 'number' || !Number.isFinite(value)) return false;
    if (value < MIN_SERVINGS || value > MAX_SERVINGS) return false;

    // Two decimals, compared with a tolerance instead of Number.isInteger:
    // 0.33 * 100 is 33.000000000000004 in IEEE-754, and 0.33 / 0.66 are the
    // fraction values the mobile serving chips store and must keep sending. A
    // third decimal still fails — 1.005 * 100 is 100.49999999999999.
    const scaled = value * SERVINGS_SCALE;
    return Math.abs(scaled - Math.round(scaled)) < SERVINGS_SCALE_TOLERANCE;
};

// The three factories return the error verdict itself rather than the wider
// union, so a path parser can reuse them and still promise its caller a verdict
// the controller's one error-body renderer handles exhaustively.
const invalidRequest = (message: string, details: LogEntryFieldError[]): LogEntryErrorVerdict => ({
    kind: 'error',
    code: 'invalid_request',
    message,
    details,
});

// The legacy guard's own verdict. Its details are reported for logs and tests
// but never serialized: the controller owes this case the historical body, and
// adding a `details` key to it would change a response shipped clients read.
const legacyFieldsRequired = (details: LogEntryFieldError[]): LogEntryErrorVerdict => ({
    kind: 'error',
    code: 'legacy_fields_required',
    message: LEGACY_REQUIRED_MESSAGE,
    details,
});

const invalidPayload = (message: string, details: LogEntryFieldError[]): LogEntryErrorVerdict => ({
    kind: 'error',
    code: 'invalid_payload',
    message,
    details,
});

// Its own verdict code, not `invalid_payload`, because the two are rendered
// differently: this one keeps the frozen sentence as the response's `error` and
// carries the machine code beside it (see LEGACY_REQUIRED_MESSAGE), while the
// conflicting-reference refusal — a body no shipped client can send — spells the
// code as `error`. The controller's renderer is exhaustive over these codes, so
// the distinction cannot be lost there.
const unrecognizedPayload = (): LogEntryErrorVerdict => ({
    kind: 'error',
    code: 'unrecognized_payload',
    message: LEGACY_REQUIRED_MESSAGE,
    details: [{ field: 'body', code: FIELD_ERROR_CODES.UNRECOGNIZED_PAYLOAD }],
});

/* ---------------------------------------------------------------------------
 * Storable text
 *
 * The rule: a string the request asks the server to STORE may not contain
 * U+0000. PostgreSQL `text` cannot represent it — the server answers
 * `22021 invalid byte sequence for encoding "UTF8": 0x00` — so a body carrying
 * one is a request only the caller can fix, and left unchecked it reaches the
 * writer and comes back as this endpoint's 500. That is the same reasoning the
 * path parsers below already apply to an unparsable `@db.Uuid` id, and the same
 * `400 invalid_request` verdict, so nothing new reaches the wire: the code is a
 * new member of the vocabulary above, not a new response shape.
 *
 * Deciding it here rather than translating the driver's failure at the
 * controller is not a preference. Prisma raises this as a
 * `PrismaClientUnknownRequestError` whose only record of the `22021` is free
 * text inside the connector's message, so a controller branch would have to
 * pattern-match a vendor string — which `backend-architecture` §9 forbids and
 * which changes shape on a driver upgrade. A pure predicate over the request is
 * the one reading that is both testable without a database (§11) and stable.
 *
 * U+0000 alone, and deliberately so: every other control character stores and
 * round-trips intact (BEL and ESC are covered in the tests), so widening this
 * to a general "unsafe characters" filter would start refusing values the
 * endpoint accepts today and stores correctly.
 * ------------------------------------------------------------------------- */

const NUL_CHARACTER = '\u0000';

/**
 * Whether a value is a string PostgreSQL `text` cannot hold. A non-string is
 * never this failure: whether it is storable at all is the column's own
 * question, and the two legacy paths answer it exactly as they always have.
 */
export const containsNulCharacter = (value: unknown): boolean =>
    typeof value === 'string' && value.includes(NUL_CHARACTER);

/**
 * The client-supplied strings the legacy writer persists, in the order a
 * failure reports them: `name` → `name`, `servingText` → `serving_text`,
 * `rawInput` → `raw_input` (`nutrition.service.ts::logMealEntry`).
 *
 * `servingText` is on the list even though the writer trims it, because
 * `String.prototype.trim` removes WhiteSpace and LineTerminator and U+0000 is
 * neither — `'\u0000'.trim()` is still `'\u0000'`, still truthy, and still
 * stored.
 */
const LEGACY_STORED_TEXT_FIELDS: readonly string[] = ['name', 'servingText', 'rawInput'];

/** The one client-supplied string an entry edit persists (`meal_entries.name`). */
const EDIT_STORED_TEXT_FIELDS: readonly string[] = ['name'];

const unstorableTextMessage = (field: string): string =>
    `${field} must not contain a NUL character (U+0000)`;

/**
 * The verdict for a body whose stored strings cannot be written, or `null` when
 * every one of them can. Reports every offending field at once and joins their
 * messages, the same way `parseCatalogBody` reports its field failures, so one
 * round trip tells the caller everything it has to fix.
 */
const unstorableText = (
    record: Record<string, unknown>,
    fields: readonly string[],
): LogEntryErrorVerdict | null => {
    const errors: LogEntryFieldError[] = fields
        .filter((field) => containsNulCharacter(record[field]))
        .map((field) => ({ field, code: FIELD_ERROR_CODES.INVALID_CHARACTERS }));

    if (errors.length === 0) return null;

    return invalidRequest(errors.map((error) => unstorableTextMessage(error.field)).join('; '), errors);
};

/**
 * The shape decision, taken once. A body that names both a personal food and a
 * catalog food is never resolved by preferring one: doing so would log
 * client-supplied macros against a catalog food (or a catalog snapshot under the
 * legacy dedupe path), presenting unverified numbers as source-backed nutrition.
 */
const routeFor = (record: Record<string, unknown>): LogEntryRoute => {
    const namesCatalogFood = isPresent(record.catalogFoodId);
    const namesPersonalFood = isPresent(record.foodId);
    const claimsLegacyEntry = LEGACY_INTENT_FIELDS.some((field) => isPresent(record[field]));

    if (namesCatalogFood && namesPersonalFood) return 'conflict';
    if (namesCatalogFood) return 'catalog';
    return claimsLegacyEntry ? 'legacy' : 'unrecognized';
};

/**
 * The predicate that shipped as `isValidMacroPayload` in
 * nutrition.controller.ts, split per field so the 400 can name what is wrong.
 * The `Number()` coercion is kept deliberately: a macro sent as a numeric string
 * has always been accepted here and nutrition.service.ts rounds it identically,
 * so tightening it would reject requests live clients may still be sending.
 */
const legacyFieldErrors = (record: Record<string, unknown>): LogEntryFieldError[] => {
    const errors: LogEntryFieldError[] = [];
    const name = record.name;

    if (typeof name !== 'string' || name.trim().length === 0) {
        errors.push({ field: 'name', code: FIELD_ERROR_CODES.REQUIRED });
    }

    LEGACY_MACRO_FIELDS.forEach((field) => {
        if (!Number.isFinite(Number(record[field]))) {
            errors.push({ field, code: FIELD_ERROR_CODES.REQUIRED });
        }
    });

    return errors;
};

const parseLegacyBody = (body: unknown, record: Record<string, unknown>): ParsedLogEntryBody => {
    const errors = legacyFieldErrors(record);
    if (errors.length > 0) return legacyFieldsRequired(errors);

    // Judged AFTER the guard above, so every body the guard already refuses
    // keeps the frozen message byte for byte and this verdict can only ever
    // replace a 500 — never an existing 400. A blank name is "required"; a name
    // PostgreSQL cannot store is a different failure and names itself, which is
    // what lets a NUL in `servingText` or `rawInput` report the field the caller
    // has to fix instead of the five the frozen message lists.
    const unstorable = unstorableText(record, LEGACY_STORED_TEXT_FIELDS);
    if (unstorable !== null) return unstorable;

    // The legacy body's own `foodId` is deliberately NOT judged here. It reaches
    // `meal_entries.food_id` — a `@db.Uuid` column — and the dedupe lookup that
    // precedes the insert filters on it, so a malformed one still surfaces as
    // the 500 it always has. Refusing it would be a new verdict on a shape whose
    // guard §0.3.1 freezes, and it is the path ids that the validation contract
    // covers; the body's id is recorded as an open observation instead of
    // changed here.

    // `record` is this same object, narrowed for reading; the body itself is
    // handed on unchanged, exactly as the controller has always handed req.body
    // to logMealEntry: the service reads foodId, servingText, servings,
    // inputMethod and rawInput itself and applies its own defaults and
    // whitelists, and a numeric-string macro must reach Math.round untouched.
    return { kind: 'legacy', payload: body as LogMealEntryPayload };
};

const parseCatalogBody = (record: Record<string, unknown>): ParsedLogEntryBody => {
    const catalogFoodId = isUuidV4(record.catalogFoodId) ? record.catalogFoodId : null;
    const servings = isServingsInContract(record.servings) ? record.servings : null;
    const servingText = record.servingText;
    const errors: LogEntryFieldError[] = [];

    if (catalogFoodId === null) {
        errors.push({ field: 'catalogFoodId', code: FIELD_ERROR_CODES.INVALID_ID });
    }
    if (servings === null) {
        errors.push({ field: 'servings', code: FIELD_ERROR_CODES.INVALID_SERVINGS });
    }
    // Type only. Whether the text names one of that food's stored portion
    // descriptions needs the catalog row, so logCatalogMealEntry owns that check.
    if (isPresent(servingText) && typeof servingText !== 'string') {
        errors.push({ field: 'servingText', code: FIELD_ERROR_CODES.INVALID_TYPE });
    }

    // The two null checks are redundant with errors.length at runtime and are
    // what narrows both values below, so the payload needs no type assertion.
    if (catalogFoodId === null || servings === null || errors.length > 0) {
        return invalidRequest(
            errors.map((error) => CATALOG_FIELD_MESSAGES[error.field]).join('; '),
            errors,
        );
    }

    const payload: LogCatalogMealEntryPayload = {
        catalogFoodId,
        servings,
        inputMethod: CATALOG_INPUT_METHOD,
    };
    if (typeof servingText === 'string') {
        payload.servingText = servingText;
    }

    // Any macro values the body carried are dropped here: logCatalogMealEntry
    // derives every number from the published catalog_foods row.
    return { kind: 'catalog', payload };
};

/**
 * Decides which of this endpoint's two body shapes the caller sent, and reports
 * a 400 verdict for anything else. Total: every input — including `null`,
 * `undefined`, an array or a primitive — returns a verdict rather than throwing.
 */
export const parseLogEntryBody = (body: unknown): ParsedLogEntryBody => {
    const record = asRecord(body);
    if (record === null) return unrecognizedPayload();

    switch (routeFor(record)) {
        case 'conflict':
            return invalidPayload(CONFLICTING_REFERENCE_MESSAGE, [
                { field: 'foodId', code: FIELD_ERROR_CODES.CONFLICTING_FOOD_REFERENCE },
                { field: 'catalogFoodId', code: FIELD_ERROR_CODES.CONFLICTING_FOOD_REFERENCE },
            ]);
        case 'catalog':
            return parseCatalogBody(record);
        case 'legacy':
            return parseLegacyBody(body, record);
        default:
            return unrecognizedPayload();
    }
};

/* ---------------------------------------------------------------------------
 * Path parsing
 *
 * Both diary-entry routes address a row by a `@db.Uuid` primary key, so an
 * unparsable id is a PostgreSQL syntax error and not a missing row: left
 * unchecked it surfaces as a 500 for a request the caller could fix, which is
 * neither the `404` this endpoint owes a well-formed id it does not own nor the
 * `400 invalid_request` the validation contract promises (§0.5.2).
 *
 * The line between the two answers is {@link isDatabaseParsableUuid} and NOT
 * `isUuidV4`, and that is the whole compatibility rule of these two parsers.
 * `meals.id` and `meal_entries.id` are `gen_random_uuid()` columns, so an id
 * outside v4 can only ever have been a 404 — but it EARNED that 404 by reaching
 * the query, and a shipped client reads it as "the row is gone". Narrowing these
 * routes to v4 turned four well-formed forms (a v1 id, an unhyphenated id, a
 * braced id, a `urn:uuid:` id) from 404 into 400, which §0.5.2 does not sanction
 * on an existing contract. So the predicate accepts everything the data layer
 * can parse and refuses only what it cannot — precisely the inputs that used to
 * answer 500.
 *
 * The new meal-planning routes keep the strict v4 rule §0.5.2 states for them;
 * their parsers live in their own modules and are not affected by this one.
 *
 * The verdicts are the same `LogEntryErrorVerdict` a body failure returns, so
 * the controller renders both through one exhaustive function.
 * ------------------------------------------------------------------------- */

export type ParsedMealEntryPath = { kind: 'ok'; mealId: string } | LogEntryErrorVerdict;

export type ParsedEntryPath = { kind: 'ok'; entryId: string } | LogEntryErrorVerdict;

/** Validates `:mealId` on `POST /macros/meal/:mealId/entries`, for both body shapes. */
export const parseMealEntryPath = (params: { mealId?: unknown }): ParsedMealEntryPath => {
    if (!isDatabaseParsableUuid(params.mealId)) {
        return invalidRequest(`${MEAL_ID_PATH_FIELD} must be a UUID`, [
            { field: MEAL_ID_PATH_FIELD, code: FIELD_ERROR_CODES.INVALID_ID },
        ]);
    }

    return { kind: 'ok', mealId: params.mealId };
};

/** Validates `:id` on `PUT` and `DELETE /macros/entry/:id`. */
export const parseEntryPath = (params: { id?: unknown }): ParsedEntryPath => {
    if (!isDatabaseParsableUuid(params.id)) {
        return invalidRequest(`${ENTRY_ID_PATH_FIELD} must be a UUID`, [
            { field: ENTRY_ID_PATH_FIELD, code: FIELD_ERROR_CODES.INVALID_ID },
        ]);
    }

    return { kind: 'ok', entryId: params.id };
};

/**
 * The value `insertPlannedMealEntry` stamps, and the one no request may ask for.
 * It is the diary's origin label ("From meal plan") and the plan card's LOGGED
 * signal, both of which assert a link this module cannot see, so it is named
 * here only to be excluded from what a body may choose.
 */
export const PLANNED_INPUT_METHOD: EntryInputMethod = 'meal_plan';

/**
 * Every value `meal_entries.input_method` may hold (Agent Action Plan §0.5.1).
 * The column's vocabulary, not a request's: see {@link CLIENT_INPUT_METHODS}.
 */
export const ENTRY_INPUT_METHODS: readonly EntryInputMethod[] = [
    'library',
    'search',
    'ai_text',
    'ai_photo',
    PLANNED_INPUT_METHOD,
];

/**
 * What the column falls back to. Already the schema default and the value the
 * legacy writer has always stored for an unrecognised method, so resolving to
 * it introduces no new wire value and an older client decodes it unchanged.
 */
export const DEFAULT_INPUT_METHOD: ClientInputMethod = 'library';

/**
 * The methods a request body may ask for: the stored vocabulary minus the ones
 * only the server writes. Derived rather than written out a second time, so a
 * method added to {@link ENTRY_INPUT_METHODS} cannot be accepted from a body by
 * omission — it has to be excluded deliberately to stay out.
 */
export const CLIENT_INPUT_METHODS: readonly ClientInputMethod[] = ENTRY_INPUT_METHODS.filter(
    (method): method is ClientInputMethod => method !== PLANNED_INPUT_METHOD,
);

/**
 * Resolves the `inputMethod` a legacy body asked for into the value the entry
 * stores. Unknown, absent and non-string values all become
 * {@link DEFAULT_INPUT_METHOD}, exactly as the whitelist this replaces did —
 * nothing is rejected here, because no request that the endpoint accepts today
 * may start failing.
 *
 * The rule it pins, and why it is a rule rather than a formality: **a body may
 * never choose a method the server writes on its own authority.** `'meal_plan'`
 * was reachable from here while one list served as both the column's vocabulary
 * and this accept-list, and the app captions a row "From meal plan" from this
 * field alone — so a request could claim a planned origin for numbers it
 * supplied itself, with no plan, no recipe version and `user_entered`
 * nutrition. §0.1.4(i) and §0.7.3 reserve that claim for the server. Deciding
 * it here rather than inside the writer's `create` call is what makes it
 * testable without a database (`backend-architecture` §11), and is the pinnable
 * rule that earns this module its second export.
 *
 * Matching is exact, and what comes back is the vocabulary's own member rather
 * than the caller's string narrowed by an assertion, so the value reaching the
 * column can only ever be a method this module names.
 */
export const resolveLegacyInputMethod = (value: unknown): ClientInputMethod =>
    CLIENT_INPUT_METHODS.find((method) => method === value) ?? DEFAULT_INPUT_METHOD;

/* ---------------------------------------------------------------------------
 * Stored nutrition provenance
 *
 * `meal_entries.nutrition_provenance` is an unrestricted TEXT column — the
 * schema carries no enum and no CHECK constraint (§0.5.1) — so every reading
 * and every writing of it is a decision this module owns rather than one the
 * database enforces.
 * ------------------------------------------------------------------------- */

/**
 * The union's members as a `Record` keyed by the union itself, so adding a
 * provenance class to `types/nutrition.ts` without listing it here is a COMPILE
 * error rather than a guard that quietly rejects the new value. Same
 * construction as `catalog.logic.ts`'s closed sets, for the same reason.
 */
const ENTRY_PROVENANCE_MEMBERS: Readonly<Record<NutritionProvenance, true>> = {
    source_backed: true,
    ingredient_derived: true,
    ai_estimated: true,
    user_entered: true,
};

/** Every class `meal_entries.nutrition_provenance` may hold. */
export const ENTRY_NUTRITION_PROVENANCES: readonly NutritionProvenance[] = Object.keys(
    ENTRY_PROVENANCE_MEMBERS,
) as NutritionProvenance[];

/**
 * `hasOwnProperty` rather than `in`: `'toString' in members` is true of every
 * object literal, which would admit `toString` as a provenance class.
 */
export const isEntryNutritionProvenance = (value: unknown): value is NutritionProvenance =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(ENTRY_PROVENANCE_MEMBERS, value);

/**
 * How a client-supplied snapshot is classified. The legacy entries path accepts
 * the four macros from the request, so however the caller obtained them the
 * server cannot vouch for them — §0.1.4(i) puts those numbers in the same
 * "unknown / user-entered" class as a row written before the column existed,
 * and neither class earns a source label in the diary.
 */
export const CLIENT_SNAPSHOT_PROVENANCE: NutritionProvenance = 'user_entered';

/**
 * How a planned-meal snapshot is classified. Planning admits only source-backed
 * ingredients (§0.7.3), so a planned meal is never an estimate; the value is
 * named here, with the rest of the vocabulary, rather than spelt at the one
 * `create` call that writes it.
 */
export const PLANNED_SNAPSHOT_PROVENANCE: NutritionProvenance = 'source_backed';

/**
 * Reads the stored column into the union the DTO promises.
 *
 * A value outside the known set — and a NULL, which is a row written before the
 * column existed — is reported as `null`: the "unknown / user-entered" class,
 * which renders no provenance label at all. That is the only safe reading, because
 * an unrecognised string cannot be shown to a client as verified provenance;
 * `resolveCatalogEntrySnapshot` below is what keeps such a string from ever
 * being WRITTEN, so this fallback stays what it was meant to be — a reading of
 * history, not a way to lose a label a new entry should have carried.
 */
export const toNutritionProvenance = (value: string | null): NutritionProvenance | null =>
    isEntryNutritionProvenance(value) ? value : null;

/* ---------------------------------------------------------------------------
 * The catalog-entry snapshot
 *
 * Everything a diary entry stores about a published catalog food: which portion
 * it was logged against, that portion's per-serving macros, and the class those
 * macros belong to. All of it is derived from the catalog row and none of it
 * from the request, so all of it is a rule and belongs here rather than beside
 * the `create` call that persists it (`backend-architecture` §11).
 * ------------------------------------------------------------------------- */

/**
 * A portion is named in the request as free text, and the text is what the saved
 * macros CLAIM to describe. Labelling one portion's numbers with another
 * portion's name — or storing a description the catalog never measured — is the
 * unverifiable claim this refusal exists to prevent, so a `servingText` that
 * names no stored portion of this food is a 400 (`invalid_serving`) and not a
 * silent fallback to the default portion.
 *
 * Declared here rather than in `mealPlanning.errors.ts` for the reason that file
 * states: a failure belongs to the module that raises it, the way
 * `estimate.service.ts` owns `EstimateFailedError`. Nothing here knows it
 * becomes a 400 — the controller decides that (§8).
 */
export class InvalidServingError extends Error {
    constructor(public readonly servingText: string) {
        super('servingText does not name a stored portion of this food');
        this.name = 'InvalidServingError';
    }
}

/**
 * Published catalog data that cannot produce a truthful diary snapshot: a
 * missing or unusable nutrient, basis, density, portion or gram weight, or a
 * provenance class this release does not recognise.
 *
 * None of these is anything a client did — validation quarantines a candidate
 * that lacks any of them, so a PUBLISHED row carrying one is a seed, release or
 * manual-SQL fault — and every one of them fails CLOSED: nothing is written, so
 * the alternative outcomes are all worse than an error. Inventing a gram weight
 * or reading a NULL nutrient as zero would log numbers nobody measured under a
 * source-backed label, and accepting an unrecognised provenance would store a
 * value `toNutritionProvenance` later reads as `null`, silently stripping the
 * estimate label §0.1.4(i) requires an AI-estimated or ingredient-derived food
 * to carry in the diary.
 *
 * The contrast with `recipe.service.ts` is deliberate: reading an unrecognised
 * provenance there DOWNGRADES the recipe to the unverifiable class, because
 * that can only make a recipe ineligible for planning — a direction a fallback
 * may fail in. Here there is no ineligible outcome, only a row that exists or
 * does not, so the safe direction is to refuse to write one.
 *
 * A local class following `catalog.logic.ts`'s `CatalogPolicyError` and
 * `grocery.logic.ts`'s `GroceryDataError`: the controller has no branch for it,
 * so it surfaces as the endpoint's 500 with the food id and the failing fact in
 * the log, which is what an operator needs to repair the row.
 */
export class CatalogSnapshotError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'CatalogSnapshotError';
    }
}

/**
 * One `catalog_food_portions` row, as the stored columns spell it. Structural
 * and snake_case so a Prisma row satisfies it without this module importing
 * Prisma — the convention `grocery.logic.ts` and `targets.logic.ts` set.
 */
export interface CatalogEntryPortion {
    description: string;
    gram_weight: number;
    is_default: boolean;
}

/** The `catalog_foods` columns a diary snapshot is derived from, with its portions. */
export interface CatalogEntryFood {
    id: string;
    /** Unrestricted TEXT, narrowed here — never trusted as one of the three bases. */
    nutrition_basis: string;
    /**
     * How much of the food the stated values describe, in the basis's own unit:
     * grams, millilitres, or SERVINGS of the default portion.
     */
    basis_amount: number;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    density_g_per_ml: number | null;
    /** Unrestricted TEXT, narrowed here — never copied into an entry as given. */
    nutrition_provenance: string;
    catalog_food_portions: readonly CatalogEntryPortion[];
}

/** What the entry stores: the portion's own description, its macros, and their class. */
export interface CatalogEntrySnapshot {
    /** The chosen portion's `description`, which is what the macros below describe. */
    servingText: string;
    /** Integers, because `meal_entries` stores per-serving macros as `Int`. */
    perServing: MacroTotals;
    nutritionProvenance: CatalogNutritionProvenance;
}

const requirePositiveFinite = (value: number | null, foodId: string, what: string): number => {
    if (value === null || !Number.isFinite(value) || value <= 0) {
        throw new CatalogSnapshotError(
            `Published catalog food ${foodId} has no usable ${what} (received ${String(value)})`,
        );
    }

    return value;
};

/**
 * A nutrient must be present and real. Zero is accepted — a food with no fat
 * has 0 g of it, and rejecting that would quarantine water — while a negative
 * value is refused: it is physically impossible, `catalog.logic.ts` gives it the
 * `reject` tier so it cannot be published, and a negative macro would subtract
 * from the day's totals.
 */
const requireNutrient = (value: number | null, foodId: string, nutrient: string): number => {
    if (value === null || !Number.isFinite(value) || value < 0) {
        throw new CatalogSnapshotError(
            `Published catalog food ${foodId} has no usable ${nutrient} value (received ${String(value)})`,
        );
    }

    return value;
};

const requireNutritionBasis = (food: CatalogEntryFood): CatalogNutritionBasis => {
    if (!isCatalogNutritionBasis(food.nutrition_basis)) {
        throw new CatalogSnapshotError(
            `Published catalog food ${food.id} has an unsupported nutrition basis ${JSON.stringify(
                food.nutrition_basis,
            )}`,
        );
    }

    return food.nutrition_basis;
};

/**
 * The provenance class the entry will carry, or a refusal.
 *
 * `isCatalogNutritionProvenance` is the closed set — built in the logic layer
 * from the wire type itself — and it excludes `user_entered` by construction,
 * which is right here too: the server derives every number in this snapshot, so
 * a catalog row claiming the client-supplied class is as corrupt as one claiming
 * a class that does not exist.
 */
const requireCatalogProvenance = (food: CatalogEntryFood): CatalogNutritionProvenance => {
    if (!isCatalogNutritionProvenance(food.nutrition_provenance)) {
        throw new CatalogSnapshotError(
            `Published catalog food ${food.id} has an unsupported nutrition provenance ${JSON.stringify(
                food.nutrition_provenance,
            )}`,
        );
    }

    return food.nutrition_provenance;
};

/**
 * The mass the food's stated nutrient values describe, so one per-gram rate can
 * be scaled to any stored portion.
 *
 * The basis rule itself is NOT restated here: `catalog.logic.ts`'s
 * `normalizeToPer100g` already owns it — grams as stated, millilitres through
 * the food's own density, and servings times the default portion's gram weight,
 * with the overflow cases that arithmetic can reach — and it is tested there.
 * This boundary only supplies the default portion's weight and turns the
 * verdict it returns into this module's refusal, so the two can never disagree
 * about what a basis means.
 */
const basisGrams = (
    food: CatalogEntryFood,
    basis: CatalogNutritionBasis,
    defaultPortion: CatalogEntryPortion,
): number => {
    const conversion = normalizeToPer100g({
        nutrition_basis: basis,
        basis_amount: food.basis_amount,
        calories: food.calories,
        protein_g: food.protein_g,
        carbs_g: food.carbs_g,
        fat_g: food.fat_g,
        density_g_per_ml: food.density_g_per_ml,
        serving_gram_weight: defaultPortion.gram_weight,
    });

    if (conversion.kind === 'error') {
        const { name, observed, bound } = conversion.check;

        throw new CatalogSnapshotError(
            `Published catalog food ${food.id} fails ${name}: observed ${JSON.stringify(
                observed,
            )}, expected ${JSON.stringify(bound)}`,
        );
    }

    return conversion.normalized.basisGrams;
};

/**
 * Resolves the portion the entry is logged against, and derives that portion's
 * per-serving macros and provenance from the catalog row.
 *
 * The portion drives the stored label AND the stored numbers together: an
 * omitted `servingText` takes the default portion, and a named one must match a
 * portion this food actually stores (see {@link InvalidServingError}).
 *
 * Scaling is `statedValue × portionGrams / basisGrams` and the result is
 * rounded ONCE, here — `meal_entries` stores per-serving macros as `Int` and the
 * read path multiplies this snapshot by `servings`, so rounding the scaled value
 * a second time anywhere else is what makes the app's "This adds" card and the
 * server's day totals disagree (§0.7.3).
 *
 * The order of the refusals is deliberate. The row is judged before the request:
 * a basis or provenance this release cannot read means the food cannot be logged
 * by anyone, so it is reported as the data fault it is rather than as a 400
 * blaming the caller's `servingText` — which is what a request carrying both
 * would otherwise be told. Within the row, a missing default portion is reported
 * before an unmatched `servingText`, as the shipped writer reported it: every
 * published food has one, so its absence is the more serious fault.
 */
export const resolveCatalogEntrySnapshot = (
    food: CatalogEntryFood,
    servingText: string | undefined,
): CatalogEntrySnapshot => {
    const basis = requireNutritionBasis(food);
    const nutritionProvenance = requireCatalogProvenance(food);

    const defaultPortion = food.catalog_food_portions.find((portion) => portion.is_default);
    if (defaultPortion === undefined) {
        throw new CatalogSnapshotError(`Published catalog food ${food.id} has no default portion`);
    }

    let portion = defaultPortion;
    if (servingText !== undefined) {
        const named = food.catalog_food_portions.find((candidate) => candidate.description === servingText);
        if (named === undefined) {
            throw new InvalidServingError(servingText);
        }

        portion = named;
    }

    const scale =
        requirePositiveFinite(portion.gram_weight, food.id, 'portion weight') /
        basisGrams(food, basis, defaultPortion);

    return {
        servingText: portion.description,
        perServing: {
            calories: Math.round(requireNutrient(food.calories, food.id, 'calories') * scale),
            protein: Math.round(requireNutrient(food.protein_g, food.id, 'protein') * scale),
            carbs: Math.round(requireNutrient(food.carbs_g, food.id, 'carbs') * scale),
            fat: Math.round(requireNutrient(food.fat_g, food.id, 'fat') * scale),
        },
        nutritionProvenance,
    };
};

/* ---------------------------------------------------------------------------
 * Editing an entry
 *
 * `PUT /macros/entry/:id` can edit how much was eaten, or it can rewrite what
 * the entry claims the food IS. The first keeps every link; the second must
 * clear them, because the plan and the catalog cannot go on vouching for
 * numbers they did not produce (§0.5.1).
 * ------------------------------------------------------------------------- */

export type ParsedMealEntryEdit =
    | { kind: 'ok'; payload: UpdateMealEntryPayload }
    | LogEntryErrorVerdict;

/**
 * Judges an edit body for the one failure the writer cannot answer: a `name`
 * carrying U+0000, which reaches `meal_entries.name` and comes back as a 500
 * for a request only the caller can fix.
 *
 * Narrow on purpose. This route has never validated its body, and everything
 * else it accepts today it must go on accepting: a `name` or macro of another
 * type is still passed through and still refused at the column, a body that
 * mentions no editable field is still the no-op 200 it has always been, and a
 * body that is not an object at all still reaches the writer unchanged — this
 * parser reports on the fields it can read and invents no other verdict. So the
 * only response it changes is the one that was a 500, which is exactly what the
 * shape decision on the log route above does.
 *
 * `payload` is the body handed on, not a rebuilt object, for the same reason
 * `parseLegacyBody` hands its body on unchanged: `planMealEntryEdit` reads each
 * member itself and normalizes it the way the column stores it.
 */
export const parseMealEntryEditBody = (body: unknown): ParsedMealEntryEdit => {
    const record = asRecord(body);
    const unstorable = record === null ? null : unstorableText(record, EDIT_STORED_TEXT_FIELDS);

    if (unstorable !== null) return unstorable;

    return { kind: 'ok', payload: body as UpdateMealEntryPayload };
};

/** The stored row the edit is judged against, in the columns' own spelling. */
export interface StoredMealEntrySnapshot {
    name: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    meal_plan_meal_id: string | null;
    catalog_food_id: string | null;
    recipe_version_id: string | null;
}

/**
 * The normalized column values the update writes. An absent key is a column the
 * request did not mention and the update leaves alone.
 */
export interface MealEntryEditFields {
    servings?: number;
    name?: string;
    calories?: number;
    protein_g?: number;
    carbs_g?: number;
    fat_g?: number;
}

export interface MealEntryEditPlan {
    fields: MealEntryEditFields;
    /**
     * True only when this edit replaces what the entry claims the food is AND
     * the entry still carries a link that would be vouching for it.
     */
    detachesFromSource: boolean;
}

/** The columns a detached entry keeps, and the classes it falls back to. */
export interface DetachedEntrySnapshot {
    meal_plan_meal_id: null;
    catalog_food_id: null;
    recipe_version_id: null;
    input_method: ClientInputMethod;
    nutrition_provenance: NutritionProvenance;
}

/**
 * What an entry keeps once its numbers are no longer the plan's or the
 * catalog's: every link is cleared, so the plan card returns to unlogged and
 * both captions — "From meal plan" and any source label — go with them.
 *
 * `library` is this column's own schema default and the value the legacy writer
 * already falls back to for an unrecognised method, so no new input method
 * enters the wire and an older client decodes a detached entry unchanged.
 */
export const DETACHED_ENTRY_SNAPSHOT: DetachedEntrySnapshot = {
    meal_plan_meal_id: null,
    catalog_food_id: null,
    recipe_version_id: null,
    input_method: DEFAULT_INPUT_METHOD,
    nutrition_provenance: CLIENT_SNAPSHOT_PROVENANCE,
};

/** Which payload field writes which macro column. */
const MACRO_EDIT_COLUMNS: readonly {
    field: 'calories' | 'protein' | 'carbs' | 'fat';
    column: 'calories' | 'protein_g' | 'carbs_g' | 'fat_g';
}[] = [
    { field: 'calories', column: 'calories' },
    { field: 'protein', column: 'protein_g' },
    { field: 'carbs', column: 'carbs_g' },
    { field: 'fat', column: 'fat_g' },
];

/**
 * The name as the column would hold it.
 *
 * A non-string is passed through unchanged, deliberately. The shipped endpoint
 * calls `payload.name.trim()` on an unvalidated body, so a numeric `name` has
 * always been answered with a 500; coercing it to `'42'` would store a name the
 * caller never sent, and ignoring it would turn a broken request into a silent
 * success. Passed through, Prisma refuses it at the `String` column and the
 * endpoint keeps answering exactly as it does today.
 */
const editedName = (value: string): string => (typeof value === 'string' ? value.trim() : value);

/**
 * Whether a normalized value actually replaces what the column holds.
 *
 * A value that is not a real number (a `name` sent as an object, a macro sent as
 * `'abc'`) cannot be compared, so it counts as a change: it is a rewrite
 * attempt, and the write it belongs to fails at the column, which means nothing
 * is detached either way.
 */
const macroDiffers = (normalized: number, stored: number): boolean =>
    !Number.isFinite(normalized) || normalized !== stored;

/**
 * Plans an edit: the normalized values to write, and whether writing them
 * detaches the entry from the plan, recipe version or catalog food it was
 * logged from.
 *
 * **Detachment turns on an effective value change, never on field presence.**
 * A client that re-submits the whole entry — the form it already has, a retry
 * of a request whose response was lost, or a servings edit sent alongside the
 * unchanged name and macros — changes nothing about what the food IS, so
 * `meal_plan_meal_id`, `catalog_food_id`, `recipe_version_id`,
 * `input_method` and `nutrition_provenance` all stand: the planned meal stays
 * LOGGED, "From meal plan" stays under the row, and the source label survives.
 * Detaching on presence made every such resubmission destroy that linkage
 * without a single number moving, which §0.5.1 spells the other way round — an
 * edit that CHANGES the name or a macro is what detaches.
 *
 * Normalization is the writer's own: the name is trimmed and macros are rounded
 * before they are compared, so `' Greek yogurt '` and `220.4` match the stored
 * `'Greek yogurt'` and `220` instead of reading as edits. Comparing the raw
 * request values would detach for every client that pads a field.
 *
 * `servings` is never a rewrite: it says how much was eaten, which the linked
 * plan meal or catalog food still describes.
 */
export const planMealEntryEdit = (
    existing: StoredMealEntrySnapshot,
    payload: UpdateMealEntryPayload,
): MealEntryEditPlan => {
    const fields: MealEntryEditFields = {};
    let rewritesSnapshot = false;

    if (payload.servings !== undefined) {
        fields.servings = payload.servings;
    }

    if (payload.name !== undefined) {
        const name = editedName(payload.name);

        fields.name = name;
        rewritesSnapshot = rewritesSnapshot || name !== existing.name;
    }

    MACRO_EDIT_COLUMNS.forEach(({ field, column }) => {
        const provided = payload[field];
        if (provided === undefined) return;

        const rounded = Math.round(provided);

        fields[column] = rounded;
        rewritesSnapshot = rewritesSnapshot || macroDiffers(rounded, existing[column]);
    });

    const isLinked =
        existing.meal_plan_meal_id !== null ||
        existing.catalog_food_id !== null ||
        existing.recipe_version_id !== null;

    return { fields, detachesFromSource: isLinked && rewritesSnapshot };
};
