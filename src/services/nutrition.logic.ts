import { LogCatalogMealEntryPayload, LogMealEntryPayload } from '../types/nutrition';

/**
 * One element of the `400 invalid_request` body's `details` array: the field the
 * caller must fix, plus a stable machine code the client maps to copy.
 */
export interface LogEntryFieldError {
    field: string;
    code: string;
}

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
          code: 'invalid_request' | 'invalid_payload';
          message: string;
          details: LogEntryFieldError[];
      };

type LogEntryRoute = 'legacy' | 'catalog' | 'conflict' | 'unrecognized';

/**
 * The wire vocabulary for `details[].code`:
 * - `required` — a legacy field is absent or unusable (blank/non-string name, a
 *   macro that does not coerce to a finite number). The shipped 400 message
 *   calls all five "required", and these details enrich that message per field.
 * - `invalid_id` — `catalogFoodId` was sent but is not a v4 UUID. An absent one
 *   is never this code: its presence is what selects the catalog shape at all.
 * - `invalid_servings` — `servings` is absent or outside the servings contract.
 * - `invalid_type` — `servingText` was sent as something other than a string.
 * - `conflicting_food_reference` — the body names both a personal food and a
 *   catalog food, so no shape can be chosen for it.
 * - `unrecognized_payload` — the body names neither shape.
 */
const FIELD_ERROR_CODES = {
    REQUIRED: 'required',
    INVALID_ID: 'invalid_id',
    INVALID_SERVINGS: 'invalid_servings',
    INVALID_TYPE: 'invalid_type',
    CONFLICTING_FOOD_REFERENCE: 'conflicting_food_reference',
    UNRECOGNIZED_PAYLOAD: 'unrecognized_payload',
} as const;

const LEGACY_MACRO_FIELDS = ['calories', 'protein', 'carbs', 'fat'] as const;

// Fields only a legacy body carries. `servings` and `servingText` are absent by
// design: both shapes use them, so neither may act as a shape signal.
const LEGACY_INTENT_FIELDS: readonly string[] = ['foodId', 'name', 'rawInput', ...LEGACY_MACRO_FIELDS];

// The exact text this endpoint has always returned for a malformed legacy body.
const LEGACY_REQUIRED_MESSAGE = 'name, calories, protein, carbs, and fat are required';
const CONFLICTING_REFERENCE_MESSAGE = 'foodId and catalogFoodId cannot both be provided';
const UNRECOGNIZED_MESSAGE = 'either catalogFoodId or name, calories, protein, carbs, and fat are required';

const MIN_SERVINGS = 0.25;
const MAX_SERVINGS = 10;
const SERVINGS_DECIMALS = 2;
const SERVINGS_SCALE = 10 ** SERVINGS_DECIMALS;
const SERVINGS_SCALE_TOLERANCE = 1e-9;

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// logCatalogMealEntry stamps the input method server-side whatever the body
// says, so the parser normalizes to it rather than carrying forward a client
// value that will not be honoured.
const CATALOG_INPUT_METHOD = 'search';

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

const invalidRequest = (message: string, details: LogEntryFieldError[]): ParsedLogEntryBody => ({
    kind: 'error',
    code: 'invalid_request',
    message,
    details,
});

const invalidPayload = (message: string, details: LogEntryFieldError[]): ParsedLogEntryBody => ({
    kind: 'error',
    code: 'invalid_payload',
    message,
    details,
});

const unrecognizedPayload = (): ParsedLogEntryBody =>
    invalidPayload(UNRECOGNIZED_MESSAGE, [{ field: 'body', code: FIELD_ERROR_CODES.UNRECOGNIZED_PAYLOAD }]);

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
    if (errors.length > 0) return invalidRequest(LEGACY_REQUIRED_MESSAGE, errors);

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
