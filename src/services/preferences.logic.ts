// The pure preference domain: what a saved answer IS, which answers may be
// saved together, where a half-finished setup resumes, and which planned meals
// a change of mind just made incompatible.
//
// Everything here is deterministic and synchronous — no Prisma, no network, no
// filesystem, no `process.env`, no clock (Rule backend-architecture §7).
// "Today" is never computed in this module: a bare date plus a Firebase
// identity cannot establish the user's calendar day, so the caller passes the
// user's IANA zone (normalised here) and any already-resolved date bound it
// wants judged. `preferences.service.ts` owns every await, the row → DTO
// mapping (a private const there, not a mapper file — §6 promotes one only once
// two services need it), and the transaction that recomputes plan flags.
//
// Five conventions carry the rest of the file, and each is pinned by a test:
//
//  * VERDICTS ARE RETURNED, NEVER THROWN. Every parser answers with either the
//    accepted value or an error variant carrying one `{field, code}` detail per
//    offending field (§8). That is what lets the controller report a whole
//    screenful of inline messages in one 400, which is exactly what the body
//    step's own note requires: "errors inline; values stay; Continue stays
//    enabled and re-validates". A THIRD variant exists for a stale revision,
//    because that is a 409 rather than a 400 and the client's recovery for it
//    is different — it re-reads, compares with its draft, and resolves silently
//    when they already agree.
//
//  * AN ALLERGY IS NEVER SILENTLY ALTERED. A payload naming both 'none' and a
//    named allergen is REFUSED rather than resolved: either resolution is a
//    guess, and the wrong guess DROPS a real allergy — the one failure here
//    with a health consequence. Nothing in this module removes an allergen for
//    any reason other than an explicit user save, and no relaxation path is
//    offered for one anywhere (which is why the planner's
//    `no_matching_meals` body carries `allergiesKept: true` as a literal).
//
//  * PROGRESS ONLY EVER MOVES FORWARD. `nextSetupState` is monotonic in both
//    the status and the resume marker, so re-saving the diet step from the plan
//    settings screen cannot send a user who already has a plan back into
//    onboarding, and stepping back in the wizard to change a goal cannot make a
//    force-quit resume at an earlier screen than the user reached. The single
//    exception is a required answer the row PROVES is missing, which only a
//    route change can create — the manual route never asks for an activity
//    level and the estimated route requires one — and which pulls the marker
//    back to that answer and withholds `ready_for_review` until it is given.
//    Readiness that survived a change in what is required would be a plan built
//    from a row whose answers were never given.
//
//  * METRIC IS WHAT IS STORED. Heights and weights are normalised through the
//    exact conversion factors below and range-checked here, so an
//    out-of-envelope figure is a 400 at write time rather than a target
//    computed from it later. The unit preferences are DISPLAY state and nothing
//    else. Nothing is rounded: `targets.logic.ts` rounds once, where the number
//    is presented, and a round here would move every figure downstream of it.
//
//  * ONE SAFETY RULE, ONE IMPLEMENTATION. Incompatibility flags come from
//    `recipe.logic.ts::evaluatePlanningEligibility` — the same call plan
//    generation and swap candidacy make — filtered to the four preference
//    codes. A second implementation of "does this meal match this user" is how
//    one of the two copies starts serving milk to a milk-allergic user.
//
// Not this module's job: the weigh-in prefill (composed on mobile from the
// existing weigh-ins query, because `body_weight_entries` carries no unit
// column and converting a stored number could misread a value typed under an
// earlier unit), the activity multipliers and every calorie and macro figure
// (`targets.logic.ts`), the plan start-date bounds, which need today's date in
// the user's zone (`mealPlan.logic.ts` and the service), the food-group
// taxonomy itself (data in `data/meal-planning/coverage-plan.v1.json`, which
// this module receives as a PARAMETER and never reads — `tsconfig.json` sets
// `rootDir: "./src"` and the image excludes `data/`), and any HTTP status code.

import {
    ActivityLevel,
    ActivityStepPayload,
    BodyMeasuredStepPayload,
    BodySkippedStepPayload,
    BodyStepPayload,
    BudgetPreference,
    BudgetTier,
    CookingStepPayload,
    CookingTimeLimitMin,
    Diet,
    DietStepPayload,
    DislikesStepPayload,
    Goal,
    GoalStepPayload,
    HeightUnitPref,
    InvalidRequestDetail,
    MealFlag,
    MealFlagCode,
    MealSchedule,
    MealTimeEntry,
    PaceLbPerWeek,
    PreferencesUpdatePayload,
    ReviewStepPayload,
    ScheduleStepPayload,
    SetupStatus,
    SetupStep,
    SetupStepEnvelope,
    SexForEstimate,
    TargetRoute,
    WeightUnitPref,
} from '../types/mealPlanning';
import { evaluatePlanningEligibility, PlanningPreferences, PlanningRecipeVersion } from './recipe.logic';

/* ---------------------------------------------------------------------------
 * Closed vocabularies
 *
 * The backing columns are plain TEXT and SMALLINT with no enum and no CHECK
 * constraint, so these tables plus the parsers below are the only place a
 * misspelling is caught. Each is declared as a `Record<Union, true>` rather
 * than an array of literals: the compiler then rejects a member that is not in
 * the union AND a union member that was forgotten, which an array cannot do.
 * ------------------------------------------------------------------------- */

const GOALS: Readonly<Record<Goal, true>> = { lose: true, maintain: true, gain: true };

const SEXES_FOR_ESTIMATE: Readonly<Record<SexForEstimate, true>> = {
    female: true,
    male: true,
    prefer_not_to_say: true,
};

const HEIGHT_UNIT_PREFS: Readonly<Record<HeightUnitPref, true>> = { ft_in: true, cm: true };

const WEIGHT_UNIT_PREFS: Readonly<Record<WeightUnitPref, true>> = { lb: true, kg: true };

const ACTIVITY_LEVELS: Readonly<Record<ActivityLevel, true>> = {
    not_very_active: true,
    lightly_active: true,
    active: true,
    very_active: true,
};

const DIETS: Readonly<Record<Diet, true>> = {
    none: true,
    vegetarian: true,
    vegan: true,
    pescatarian: true,
};

const MEAL_SCHEDULES: Readonly<Record<MealSchedule, true>> = { three: true, three_plus_snack: true };

/** The three loss paces, which are also the three gain paces. 'maintain' has none. */
const PACES: Readonly<Record<PaceLbPerWeek, true>> = { 0.5: true, 1: true, 1.5: true };

/** Total prep plus cooking minutes, as the cooking step offers them. */
const COOKING_TIME_LIMITS: Readonly<Record<CookingTimeLimitMin, true>> = {
    15: true,
    30: true,
    45: true,
    60: true,
};

/**
 * The four `meal_plan_meals.flags` codes.
 *
 * Declared here as well as in `recipe.logic.ts::PREFERENCE_FLAG_CODES` because
 * only an exhaustive `Record<MealFlagCode, true>` can NARROW an eligibility
 * reason's code to `MealFlagCode`; the two lists are asserted to coincide in
 * `__tests__/preferences.logic.test.ts`, so a divergence fails the suite rather
 * than emitting a flag the wire contract does not declare.
 */
const MEAL_FLAG_CODES: Readonly<Record<MealFlagCode, true>> = {
    diet: true,
    allergen: true,
    dislike: true,
    cooking_time: true,
};

/* ---------------------------------------------------------------------------
 * Allergens — the nine named values plus the mutually exclusive 'none'
 * ------------------------------------------------------------------------- */

/** The answer meaning "no allergies", mutually exclusive with every named allergen. */
export const ALLERGEN_NONE = 'none';

/**
 * The nine named allergens the diet step offers, in the order the screen lists
 * them (Milk, Eggs, Peanuts, Tree nuts, Soy, Wheat, Fish, Shellfish, Sesame).
 *
 * Stored in the lowercase snake_case spelling the catalog's own allergen tags
 * use, so a user's selection and a food's tag compare equal through
 * `recipe.logic.ts`'s normalisation. The client owns the display copy; these
 * are codes.
 */
export const NAMED_ALLERGENS: readonly string[] = [
    'milk',
    'eggs',
    'peanuts',
    'tree_nuts',
    'soy',
    'wheat',
    'fish',
    'shellfish',
    'sesame',
];

/** Every accepted allergen answer: the nine named values and 'none'. */
export const ALLERGEN_VALUES: readonly string[] = [...NAMED_ALLERGENS, ALLERGEN_NONE];

/* ---------------------------------------------------------------------------
 * Unit conversion — exact factors, no rounding
 * ------------------------------------------------------------------------- */

/** 1 lb in kilograms, exactly (international avoirdupois pound). */
export const POUNDS_TO_KILOGRAMS = 0.45359237;

/** 1 in in centimetres, exactly. */
export const INCHES_TO_CENTIMETERS = 2.54;

/**
 * 1 st in kilograms, exactly (14 lb).
 *
 * Present only to interpret a stone DISPLAY preference the rest of the app
 * still offers: the body step's own toggle is lb/kg, so a stone user is shown
 * kg there and no weight is ever stored in stone.
 */
export const STONE_TO_KILOGRAMS = 6.35029318;

const INCHES_PER_FOOT = 12;

/* ---------------------------------------------------------------------------
 * Supported envelopes
 * ------------------------------------------------------------------------- */

/**
 * The adult envelope every stored measurement must fall in.
 *
 * Validated HERE, at write time, which is what makes a stored value outside it
 * a corrupt row rather than user input — `targets.logic.ts` relies on exactly
 * that and refuses to estimate from such a row instead of clamping it into
 * range. The same numbers are declared there as `ESTIMATE_INPUT_RANGES`;
 * importing them is not open to this module (its dependencies are the wire
 * contract and the recipe rules), so the pair is asserted to agree in the
 * targets and preferences suites instead.
 */
export const BODY_INPUT_RANGES = {
    age: { min: 18, max: 100 },
    heightCm: { min: 120, max: 250 },
    weightKg: { min: 30, max: 300 },
} as const;

/**
 * Whole dollars a weekly grocery budget may name.
 *
 * A minimum of 1 rather than 0: "no budget" is an answer with its own
 * expression (`noBudgetPreference`), so a 0 amount is a contradiction rather
 * than a frugal week.
 */
export const BUDGET_AMOUNT_RANGE = { min: 1, max: 10_000 } as const;

/** The only currency this version accepts; the budget screen is dollar-denominated. */
export const BUDGET_CURRENCY = 'USD';

/** At most this many disliked foods may be stored, counted after de-duplication. */
export const MAX_DISLIKED_FOOD_IDS = 100;

/* ---------------------------------------------------------------------------
 * Patterns
 * ------------------------------------------------------------------------- */

const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const DAY_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * A 24-hour wall-clock time, zero-padded.
 *
 * Deliberately strict on both ends: `24:00` is not a time of day, and `9:05`
 * is not the `HH:mm` the contract declares. Accepting the short form would mean
 * two spellings of one meal time reaching the day view's sort.
 */
const CLOCK_TIME_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

const COMBINING_MARKS_PATTERN = /[\u0300-\u036f]/g;
const NON_ALPHANUMERIC_PATTERN = /[^a-z0-9]+/g;
const WHITESPACE_RUN_PATTERN = /\s+/g;

/* ---------------------------------------------------------------------------
 * The wire vocabulary for a `details[].code`
 *
 * Machine-readable throughout: the client maps each code to its own copy, which
 * is why no display prose appears here or anywhere else in this module.
 * ------------------------------------------------------------------------- */

export const PREFERENCE_FIELD_CODES = {
    /** Absent or null where an answer is required. */
    REQUIRED: 'required',
    /** Present but not the JSON type the contract declares. */
    INVALID_TYPE: 'invalid_type',
    /** A finite number where a whole one is required. */
    NOT_AN_INTEGER: 'not_an_integer',
    BELOW_MINIMUM: 'below_minimum',
    ABOVE_MAXIMUM: 'above_maximum',
    /** Not a v4 UUID. */
    INVALID_ID: 'invalid_id',
    /** Not a real `YYYY-MM-DD` calendar day. */
    INVALID_DATE: 'invalid_date',
    /** Not a zero-padded 24-hour `HH:mm` time. */
    INVALID_TIME: 'invalid_time',
    /** Not an IANA zone name this runtime recognises. */
    INVALID_TIME_ZONE: 'invalid_time_zone',
    /** Outside the closed set the contract declares for the field. */
    UNKNOWN_VALUE: 'unknown_value',
    /** The `:step` segment names no payload-bearing setup step. */
    UNKNOWN_STEP: 'unknown_step',
    /** A server-owned or unrecognised key appeared in a preferences body. */
    READ_ONLY_FIELD: 'read_only_field',
    /** A legitimate value for the field, but not alongside the other answers given. */
    NOT_ALLOWED: 'not_allowed',
    /** More values than the field accepts. */
    TOO_MANY: 'too_many',
    /** 'none' was selected together with a named allergen. */
    MUTUALLY_EXCLUSIVE: 'mutually_exclusive',
    /** A currency this version does not support. */
    UNSUPPORTED_CURRENCY: 'unsupported_currency',
    /** The meal times do not match the chosen schedule's slots. */
    SLOT_MISMATCH: 'slot_mismatch',
    /** A goal weight at or above the current weight while losing. */
    NOT_BELOW_CURRENT_WEIGHT: 'not_below_current_weight',
    /** A goal weight at or below the current weight while gaining. */
    NOT_ABOVE_CURRENT_WEIGHT: 'not_above_current_weight',
} as const;

export type PreferenceFieldCode = (typeof PREFERENCE_FIELD_CODES)[keyof typeof PREFERENCE_FIELD_CODES];

/* ---------------------------------------------------------------------------
 * Verdicts
 *
 * Three variants rather than two, because a stale revision is not a malformed
 * request: it is a 409 whose recovery is "re-read, compare with the draft, and
 * resolve silently when they agree", while a 400 is "fix these fields". One
 * variant for both would force the controller to guess the status from a code
 * string.
 * ------------------------------------------------------------------------- */

export interface PreferenceErrorVerdict {
    kind: 'error';
    code: 'invalid_request';
    /** A server-side diagnostic naming every offending field. The client renders `details`. */
    message: string;
    details: InvalidRequestDetail[];
}

export interface StaleRevisionVerdict {
    kind: 'stale_revision';
    code: 'stale_revision';
    message: string;
    /** The authoritative revision, so the client can re-read and compare. */
    currentRevision: number;
}

/** Either refusal a preferences parser can answer with. */
export type PreferenceRefusal = PreferenceErrorVerdict | StaleRevisionVerdict;

const invalidRequest = (details: InvalidRequestDetail[]): PreferenceErrorVerdict => ({
    kind: 'error',
    code: 'invalid_request',
    message: `invalid preferences request: ${details
        .map((detail) => `${detail.field} (${detail.code})`)
        .join(', ')}`,
    details,
});

const staleRevision = (currentRevision: number): StaleRevisionVerdict => ({
    kind: 'stale_revision',
    code: 'stale_revision',
    message: `preferences revision ${currentRevision} is authoritative`,
    currentRevision,
});

const detail = (field: string, code: PreferenceFieldCode): InvalidRequestDetail => ({ field, code });

/* ---------------------------------------------------------------------------
 * Primitives
 * ------------------------------------------------------------------------- */

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

/** Absent and explicitly null are the same "no value given" for a step answer. */
const isAbsent = (value: unknown): boolean => value === undefined || value === null;

const isMemberOf = <T extends string>(table: Readonly<Record<T, true>>, value: unknown): value is T =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(table, value);

/**
 * Membership for a numeric closed set.
 *
 * Keyed through `String(value)` because a `Record<0.5 | 1 | 1.5, true>` carries
 * the keys `'0.5'`, `'1'` and `'1.5'` at runtime — which is also why `1.0`
 * matches `1` and a near miss such as `1.25` does not.
 */
const isNumericMemberOf = <T extends number>(
    table: Readonly<Record<T, true>>,
    value: unknown,
): value is T =>
    typeof value === 'number' &&
    Number.isFinite(value) &&
    Object.prototype.hasOwnProperty.call(table, String(value));

const isUuidV4 = (value: unknown): value is string =>
    typeof value === 'string' && UUID_V4_PATTERN.test(value);

/**
 * The comparison key for an allergen or food-group value.
 *
 * Byte-for-byte the normalisation `catalog.logic.ts::normalizeCanonicalName`
 * performs and `recipe.logic.ts` compares tags through, restated here because
 * this module's dependencies are the wire contract and the recipe rules. That
 * agreement is what makes a user's selected `tree_nuts` match a catalog food's
 * `Tree nuts`; comparing raw strings instead is how an allergen reaches a
 * plate. It is idempotent: the output is lowercase ASCII alphanumerics
 * separated by single spaces, trimmed.
 */
const comparisonKey = (value: string): string =>
    value
        .normalize('NFKD')
        .replace(COMBINING_MARKS_PATTERN, '')
        .toLowerCase()
        .replace(NON_ALPHANUMERIC_PATTERN, ' ')
        .replace(WHITESPACE_RUN_PATTERN, ' ')
        .trim();

const DAYS_IN_MONTH: readonly number[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

const isLeapYear = (year: number): boolean =>
    (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;

/**
 * Whether a value is a real `YYYY-MM-DD` calendar day.
 *
 * The month length is computed from the proleptic Gregorian rules rather than
 * from a `Date`, so `2026-02-30` is refused, `2024-02-29` is accepted, and no
 * clock, zone or locale is consulted (Rule 7 §7). Whether such a day is IN
 * RANGE for a plan is a different question, and not this module's: it needs
 * today's date in the user's zone, which only the caller can establish.
 */
export const isCalendarDayKey = (value: unknown): value is string => {
    if (typeof value !== 'string' || !DAY_KEY_PATTERN.test(value)) {
        return false;
    }

    const [year, month, day] = value.split('-').map(Number);

    if (month < 1 || month > 12 || day < 1) {
        return false;
    }

    const lastDay = month === 2 && isLeapYear(year) ? 29 : DAYS_IN_MONTH[month - 1];

    return day <= lastDay;
};

/** Whether a value is a zero-padded 24-hour `HH:mm` wall-clock time. */
export const isClockTime = (value: unknown): value is string =>
    typeof value === 'string' && CLOCK_TIME_PATTERN.test(value);

/** The accepted number, or the code describing why it was refused. */
const parseBoundedNumber = (
    value: unknown,
    range: { min: number; max: number },
    options: { integer: boolean },
): number | PreferenceFieldCode => {
    if (isAbsent(value)) {
        return PREFERENCE_FIELD_CODES.REQUIRED;
    }

    // A numeric string is refused rather than coerced: the contract declares
    // JSON numbers, and silently accepting "182.2" invites a locale-formatted
    // "182,2" that would coerce to NaN.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return PREFERENCE_FIELD_CODES.INVALID_TYPE;
    }

    if (options.integer && !Number.isInteger(value)) {
        return PREFERENCE_FIELD_CODES.NOT_AN_INTEGER;
    }

    if (value < range.min) {
        return PREFERENCE_FIELD_CODES.BELOW_MINIMUM;
    }

    if (value > range.max) {
        return PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM;
    }

    return value;
};

/* ---------------------------------------------------------------------------
 * Time zone — the only basis for the user's calendar day
 * ------------------------------------------------------------------------- */

/**
 * The canonical IANA name for a zone, or null when this runtime does not
 * recognise it.
 *
 * Validation is the construction itself: `Intl.DateTimeFormat` throws a
 * `RangeError` for an unknown zone on Node and on every React Native JS
 * engine, so there is no list to keep current. `resolvedOptions().timeZone`
 * then yields the canonical spelling, which is what collapses the aliases a
 * device may report — `Etc/UTC` and `Etc/GMT` both resolve to `UTC` — so a user
 * who has not moved does not look like one who has on every save.
 *
 * Any error that is NOT a `RangeError` propagates: that is a runtime built
 * without full time-zone data, which is an environment fault rather than a
 * field the user can correct (Rule 7 §8).
 */
export const normalizeTimeZone = (name: unknown): string | null => {
    if (typeof name !== 'string') {
        return null;
    }

    const candidate = name.trim();

    if (candidate.length === 0) {
        return null;
    }

    try {
        return new Intl.DateTimeFormat('en-US', { timeZone: candidate }).resolvedOptions().timeZone;
    } catch (error) {
        if (error instanceof RangeError) {
            return null;
        }

        throw error;
    }
};

/* ---------------------------------------------------------------------------
 * Measurements — metric is what is stored
 * ------------------------------------------------------------------------- */

/**
 * A height as the user entered it, in either unit the app offers.
 *
 * The magnitudes are `unknown` because this is a PARSER's input: the caller has
 * decided which unit the figure is in, and everything else about it is judged
 * here, so the "absent" and "not a number" cases stay distinguishable in the
 * verdict instead of collapsing into a `NaN` at the call site.
 */
export type HeightMeasurementInput =
    | { unit: 'cm'; centimeters: unknown }
    | { unit: 'ft_in'; feet: unknown; inches: unknown };

/**
 * A weight as the user entered it. `st` is accepted because the app's weight
 * unit preference still offers stone elsewhere; no weight is ever STORED in it.
 */
export type WeightMeasurementInput =
    | { unit: 'kg'; kilograms: unknown }
    | { unit: 'lb'; pounds: unknown }
    | { unit: 'st'; stone: unknown };

export interface BodyMeasurementsInput {
    age: unknown;
    height: HeightMeasurementInput;
    weight: WeightMeasurementInput;
}

export interface NormalizedBodyMeasurements {
    age: number;
    heightCm: number;
    weightKg: number;
}

export type ParsedBodyMeasurements =
    | { kind: 'ok'; measurements: NormalizedBodyMeasurements }
    | PreferenceErrorVerdict;

/** Pounds to kilograms at full precision. */
export const poundsToKilograms = (pounds: number): number => pounds * POUNDS_TO_KILOGRAMS;

/** Stone to kilograms at full precision. */
export const stoneToKilograms = (stone: number): number => stone * STONE_TO_KILOGRAMS;

/** Feet and inches to centimetres at full precision. */
export const feetAndInchesToCentimeters = (feet: number, inches: number): number =>
    (feet * INCHES_PER_FOOT + inches) * INCHES_TO_CENTIMETERS;

/** Kilograms for a magnitude already known to be a finite number. */
const toKilograms = (weight: WeightMeasurementInput, magnitude: number): number => {
    switch (weight.unit) {
        case 'kg':
            return magnitude;
        case 'lb':
            return poundsToKilograms(magnitude);
        default:
            return stoneToKilograms(magnitude);
    }
};

const weightMagnitudeOf = (weight: WeightMeasurementInput): unknown => {
    switch (weight.unit) {
        case 'kg':
            return weight.kilograms;
        case 'lb':
            return weight.pounds;
        default:
            return weight.stone;
    }
};

const isUsableComponent = (value: unknown): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0;

/**
 * The measurements in the units they are stored in, or every reason they could
 * not be.
 *
 * ONE range check for the whole application: the body step hands its already
 * metric wire values through here so that a value arriving as centimetres and a
 * value converted from feet and inches are held to the same envelope, and
 * neither can reach a stored row outside it. Nothing is rounded — 182.2 lb is
 * 82.6480…kg here and stays that way, because `targets.logic.ts` rounds once,
 * where a number is shown, and an early round would move every figure after it.
 *
 * Every failure is collected, not short-circuited, so the body screen can show
 * all of its inline messages at once.
 */
export const normalizeToMetric = (input: BodyMeasurementsInput): ParsedBodyMeasurements => {
    const details: InvalidRequestDetail[] = [];

    const age = parseBoundedNumber(input.age, BODY_INPUT_RANGES.age, { integer: true });

    if (typeof age !== 'number') {
        details.push(detail('age', age));
    }

    let heightCm: number | null = null;

    if (input.height.unit === 'ft_in') {
        const { feet, inches } = input.height;

        if (!isUsableComponent(feet) || !isUsableComponent(inches)) {
            details.push(detail('height', PREFERENCE_FIELD_CODES.INVALID_TYPE));
        } else if (inches >= INCHES_PER_FOOT) {
            // 5'14" is arithmetic, not a height anyone entered: the inches
            // field of a foot-and-inch pair carries 0 to 11.
            details.push(detail('height', PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM));
        } else {
            heightCm = feetAndInchesToCentimeters(feet, inches);
        }
    } else if (!isUsableComponent(input.height.centimeters)) {
        details.push(
            detail(
                'heightCm',
                isAbsent(input.height.centimeters)
                    ? PREFERENCE_FIELD_CODES.REQUIRED
                    : PREFERENCE_FIELD_CODES.INVALID_TYPE,
            ),
        );
    } else {
        heightCm = input.height.centimeters;
    }

    if (heightCm !== null) {
        const bounded = parseBoundedNumber(heightCm, BODY_INPUT_RANGES.heightCm, { integer: false });

        if (typeof bounded !== 'number') {
            details.push(detail('heightCm', bounded));
            heightCm = null;
        }
    }

    const magnitude = weightMagnitudeOf(input.weight);
    let weightKg: number | null = null;

    if (typeof magnitude !== 'number' || !Number.isFinite(magnitude)) {
        details.push(
            detail(
                'weightKg',
                isAbsent(magnitude) ? PREFERENCE_FIELD_CODES.REQUIRED : PREFERENCE_FIELD_CODES.INVALID_TYPE,
            ),
        );
    } else {
        const bounded = parseBoundedNumber(
            toKilograms(input.weight, magnitude),
            BODY_INPUT_RANGES.weightKg,
            { integer: false },
        );

        if (typeof bounded !== 'number') {
            details.push(detail('weightKg', bounded));
        } else {
            weightKg = bounded;
        }
    }

    if (typeof age !== 'number' || heightCm === null || weightKg === null) {
        return invalidRequest(details);
    }

    return { kind: 'ok', measurements: { age, heightCm, weightKg } };
};

/* ---------------------------------------------------------------------------
 * Allergens — the safety rule
 * ------------------------------------------------------------------------- */

const ALLERGEN_BY_KEY: ReadonlyMap<string, string> = new Map(
    ALLERGEN_VALUES.map((allergen) => [comparisonKey(allergen), allergen]),
);

const NONE_KEY = comparisonKey(ALLERGEN_NONE);

export type ParsedAllergens = { kind: 'ok'; allergens: string[] } | PreferenceErrorVerdict;

/**
 * The allergen selection as it will be stored, or why it cannot be.
 *
 * Four rules, and the first two are the safety ones:
 *
 *  * 'none' AND a named allergen together is REFUSED, both ways round. Not
 *    resolved in favour of either: preferring the named set would ignore an
 *    explicit "no allergies", and preferring 'none' would DROP a declared
 *    allergy. A client cannot send this pair through its own UI — the chip
 *    cloud clears one when the other is picked — so the pair means the request
 *    is not what the user did, and guessing which half to keep is not a risk
 *    worth taking for a request nobody meant to send.
 *  * An unrecognised value is refused rather than skipped. Dropping it would
 *    silently store a shorter allergy list than the user chose.
 *  * Spelling is normalised, not required: `Tree nuts`, `tree-nuts` and
 *    `tree_nuts` all store as the catalog's `tree_nuts`, so a client that sends
 *    a label still gets the exclusion, and the stored value still matches a
 *    food's tag.
 *  * Duplicates are DE-DUPLICATED rather than refused (the documented choice
 *    of the two the plan allows): `['Milk', 'milk']` states one unambiguous
 *    intent, and refusing it would fail a request whose meaning is not in
 *    doubt. Contradiction is the only thing refused here.
 *
 * The result is ordered as {@link ALLERGEN_VALUES} declares, never as the client
 * clicked, so one selection has one stored representation.
 *
 * An EMPTY array is refused: "no allergies" has its own expression, `['none']`,
 * and the diet screen requires one or the other before Continue. An empty list
 * is only ever a READ state — the allergens of a user who has no preferences
 * row yet — and accepting it as an answer would make "not asked yet" and
 * "asked, and none" indistinguishable in storage.
 */
export const parseAllergens = (value: unknown, field = 'allergens'): ParsedAllergens => {
    if (isAbsent(value)) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.REQUIRED)]);
    }

    if (!Array.isArray(value)) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.INVALID_TYPE)]);
    }

    if (value.length === 0) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.REQUIRED)]);
    }

    // Bounded before the per-element walk so a pathological body cannot produce
    // a detail array longer than the vocabulary itself.
    if (value.length > ALLERGEN_VALUES.length) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.TOO_MANY)]);
    }

    const details: InvalidRequestDetail[] = [];
    const selected = new Set<string>();

    value.forEach((entry, index) => {
        if (typeof entry !== 'string') {
            details.push(detail(`${field}[${index}]`, PREFERENCE_FIELD_CODES.INVALID_TYPE));
            return;
        }

        const canonical = ALLERGEN_BY_KEY.get(comparisonKey(entry));

        if (canonical === undefined) {
            details.push(detail(`${field}[${index}]`, PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
            return;
        }

        selected.add(canonical);
    });

    if (details.length > 0) {
        return invalidRequest(details);
    }

    if (selected.has(ALLERGEN_NONE) && selected.size > 1) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.MUTUALLY_EXCLUSIVE)]);
    }

    return { kind: 'ok', allergens: ALLERGEN_VALUES.filter((allergen) => selected.has(allergen)) };
};

/** Whether a stored selection is the mutually exclusive "no allergies" answer. */
export const isNoAllergenSelection = (allergens: readonly string[]): boolean =>
    allergens.length === 1 && comparisonKey(allergens[0]) === NONE_KEY;

/* ---------------------------------------------------------------------------
 * Meal schedule and times
 * ------------------------------------------------------------------------- */

/** The slot type the wire contract carries on a meal time. */
export type MealTimeSlot = MealTimeEntry['slot'];

/**
 * The slots each schedule carries, in WIRE order.
 *
 * Wire order is breakfast, lunch, dinner and then snack — which is the order of
 * the MEALS, not of the clock. The day view sorts by time for display, and a
 * snack at 15:30 sits between lunch and dinner there; the stored array does not
 * reorder itself to match.
 */
const SCHEDULE_SLOTS: Readonly<Record<MealSchedule, readonly MealTimeSlot[]>> = {
    three: ['breakfast', 'lunch', 'dinner'],
    three_plus_snack: ['breakfast', 'lunch', 'dinner', 'snack'],
};

/** The slots a schedule declares, in wire order. */
export const slotsForSchedule = (schedule: MealSchedule): readonly MealTimeSlot[] =>
    SCHEDULE_SLOTS[schedule];

export type ParsedMealTimes = { kind: 'ok'; mealTimes: MealTimeEntry[] } | PreferenceErrorVerdict;

/**
 * The meal times for a schedule, or every reason they are not usable.
 *
 * Three rules, and the third is the one an "obvious" implementation gets wrong:
 *
 *  * Exactly one entry per slot of the chosen schedule — three, or four with a
 *    snack. A count that does not match the schedule is refused rather than
 *    padded or truncated, because either repair invents a meal time.
 *  * The entries appear in the schedule's wire order, so a stored array is
 *    positionally readable and one schedule has one representation.
 *  * The TIMES THEMSELVES ARE NOT ORDERED. A snack at 15:30 between lunch at
 *    12:30 and dinner at 18:30 is exactly what the schedule screen's own
 *    defaults produce, so an ascending check — the natural thing to write here
 *    — would reject the designed answer. Nothing in this module compares one
 *    meal time with another.
 */
export const validateMealTimes = (
    schedule: MealSchedule,
    times: unknown,
    field = 'mealTimes',
): ParsedMealTimes => {
    const expectedSlots = slotsForSchedule(schedule);

    if (isAbsent(times)) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.REQUIRED)]);
    }

    if (!Array.isArray(times)) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.INVALID_TYPE)]);
    }

    if (times.length !== expectedSlots.length) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.SLOT_MISMATCH)]);
    }

    const details: InvalidRequestDetail[] = [];
    const mealTimes: MealTimeEntry[] = [];

    expectedSlots.forEach((slot, index) => {
        const entry = asRecord(times[index]);

        if (entry === null) {
            details.push(detail(`${field}[${index}]`, PREFERENCE_FIELD_CODES.INVALID_TYPE));
            return;
        }

        if (entry.slot !== slot) {
            details.push(detail(`${field}[${index}].slot`, PREFERENCE_FIELD_CODES.SLOT_MISMATCH));
            return;
        }

        if (!isClockTime(entry.time)) {
            details.push(detail(`${field}[${index}].time`, PREFERENCE_FIELD_CODES.INVALID_TIME));
            return;
        }

        mealTimes.push({ slot, time: entry.time });
    });

    if (details.length > 0) {
        return invalidRequest(details);
    }

    return { kind: 'ok', mealTimes };
};

/* ---------------------------------------------------------------------------
 * Budget
 * ------------------------------------------------------------------------- */

const DAYS_PER_WEEK = 7;

/**
 * The per-meal boundaries between the three budget tiers, in whole units of
 * currency.
 *
 * Tier 1 is under `tier1Below`, tier 2 runs from there up to and INCLUDING
 * `tier2Max`, and tier 3 is anything above. Calibrated to US dollars, the only
 * currency this version accepts, which is why the thresholds may be compared
 * with a stored amount directly.
 */
export const BUDGET_PER_MEAL_THRESHOLDS = { tier1Below: 3, tier2Max: 6 } as const;

/** How many meals a day a schedule plans; a snack counts, because it is shopped for. */
export const mealsPerDayForSchedule = (schedule: MealSchedule): number =>
    slotsForSchedule(schedule).length;

/**
 * The relative cost band a weekly amount implies.
 *
 * A null amount is "no budget preference", which is tier 3 — the band that
 * applies NO penalty to any recipe. That is the same answer given for a
 * `mealsPerDay` that cannot be divided by: a tier is a restriction, and
 * restricting a user's week on the strength of a number we could not compute is
 * the one outcome worth ruling out. Both cases are deliberate, not defensive
 * padding.
 */
export const deriveBudgetTier = (amount: number | null, mealsPerDay: number): BudgetTier => {
    if (amount === null || !Number.isFinite(amount) || !Number.isFinite(mealsPerDay) || mealsPerDay <= 0) {
        return 3;
    }

    const perMeal = amount / (mealsPerDay * DAYS_PER_WEEK);

    if (perMeal < BUDGET_PER_MEAL_THRESHOLDS.tier1Below) {
        return 1;
    }

    return perMeal <= BUDGET_PER_MEAL_THRESHOLDS.tier2Max ? 2 : 3;
};

/** The coherent pair the cooking step and the full save both write. */
export interface BudgetAnswer {
    budget: BudgetPreference | null;
    noBudgetPreference: boolean;
}

export type ParsedBudgetAnswer = { kind: 'ok'; answer: BudgetAnswer } | PreferenceErrorVerdict;

/**
 * The budget answer as a coherent pair, or why the two halves contradict.
 *
 * `noBudgetPreference` and an amount are two spellings of the same question, so
 * they are validated together and neither is allowed to silently win:
 *
 *  * "No budget preference" WITH an amount is refused. The screen disables the
 *    amount field while the box is checked, so the pair cannot be what the user
 *    did, and storing either half would misreport their answer.
 *  * Neither of them is refused too: the screen requires the user to check the
 *    box or type an amount, so an empty pair is an unanswered step rather than
 *    a permissive one.
 *  * The currency must be EXACTLY {@link BUDGET_CURRENCY}. The wire contract
 *    declares one spelling, so `' usd '` is a malformed request rather than a
 *    near miss to be tidied up: normalising it here would accept a body no
 *    client of this contract sends and leave the one real currency check
 *    weaker than the contract it enforces. A second currency is a product
 *    decision, so anything else is refused rather than converted at an
 *    invented rate.
 */
export const parseBudgetAnswer = (budget: unknown, noBudgetPreference: unknown): ParsedBudgetAnswer => {
    if (isAbsent(noBudgetPreference)) {
        return invalidRequest([detail('noBudgetPreference', PREFERENCE_FIELD_CODES.REQUIRED)]);
    }

    if (typeof noBudgetPreference !== 'boolean') {
        return invalidRequest([detail('noBudgetPreference', PREFERENCE_FIELD_CODES.INVALID_TYPE)]);
    }

    if (noBudgetPreference) {
        return isAbsent(budget)
            ? { kind: 'ok', answer: { budget: null, noBudgetPreference: true } }
            : invalidRequest([detail('budget', PREFERENCE_FIELD_CODES.NOT_ALLOWED)]);
    }

    if (isAbsent(budget)) {
        return invalidRequest([detail('budget', PREFERENCE_FIELD_CODES.REQUIRED)]);
    }

    const record = asRecord(budget);

    if (record === null) {
        return invalidRequest([detail('budget', PREFERENCE_FIELD_CODES.INVALID_TYPE)]);
    }

    const details: InvalidRequestDetail[] = [];
    const amount = parseBoundedNumber(record.amount, BUDGET_AMOUNT_RANGE, { integer: true });

    if (typeof amount !== 'number') {
        details.push(detail('budget.amount', amount));
    }

    if (isAbsent(record.currency)) {
        details.push(detail('budget.currency', PREFERENCE_FIELD_CODES.REQUIRED));
    } else if (typeof record.currency !== 'string') {
        details.push(detail('budget.currency', PREFERENCE_FIELD_CODES.INVALID_TYPE));
    } else if (record.currency !== BUDGET_CURRENCY) {
        details.push(detail('budget.currency', PREFERENCE_FIELD_CODES.UNSUPPORTED_CURRENCY));
    }

    if (typeof amount !== 'number' || details.length > 0) {
        return invalidRequest(details);
    }

    return {
        kind: 'ok',
        answer: { budget: { amount, currency: BUDGET_CURRENCY }, noBudgetPreference: false },
    };
};

/* ---------------------------------------------------------------------------
 * Disliked foods and their groups
 * ------------------------------------------------------------------------- */

/** A resolved `catalog_foods` row, snake_case as Prisma returns it. */
export interface CatalogFoodGroupAssignment {
    id: string;
    /** One term of the controlled taxonomy; absent or null where the row carries none. */
    food_group?: string | null;
}

/**
 * What a dislike derivation needs, supplied as DATA.
 *
 * Both halves come from outside this module because neither may be read here:
 * `foods` are the `catalog_foods` rows the service resolved for the ids the user
 * selected, and `knownFoodGroups` is the ~120-term controlled vocabulary that
 * lives in `data/meal-planning/coverage-plan.v1.json` — a file this module
 * cannot import, since the production build's `rootDir` is `./src` and the image
 * excludes `data/`. Omitting `knownFoodGroups` skips the drift check; it never
 * changes which groups are excluded.
 */
export interface DislikedFoodTaxonomy {
    foods: readonly CatalogFoodGroupAssignment[];
    knownFoodGroups?: readonly string[];
}

export interface DislikedFoodGroupsDerivation {
    /** The recognised ids, de-duplicated, in the order they were selected. */
    foodIds: string[];
    /** The groups to exclude, de-duplicated and ordered so storage is stable. */
    foodGroups: string[];
    /** Selected ids with no resolved catalog row — the caller's 404 or 400. */
    unknownFoodIds: string[];
    /** Resolved ids whose row carries no group, so only the food itself is excluded. */
    ungroupedFoodIds: string[];
    /** Groups outside the supplied vocabulary: reported as drift, still excluded. */
    unrecognizedFoodGroups: string[];
}

/**
 * The pair a dislike stores: the food ids themselves AND the groups they belong
 * to.
 *
 * Both halves are the rule. Storing only the id would leave "Mushrooms, white"
 * excluding one catalog row while every other mushroom kept appearing; storing
 * only the group would lose a food whose row carries no group at all. The group
 * half is also why the exclusion must be exact: `mushroom` removes mushrooms and
 * nothing else, and an unrelated group is never touched — which is a property
 * worth asserting rather than assuming, because a substring or prefix match
 * here would quietly strip half the catalog.
 *
 * A group outside the supplied vocabulary is KEPT and reported. Dropping it
 * would be the one outcome the user notices: the ingredient they excluded
 * appearing in their week. Drift between the catalog and the coverage plan is an
 * operator's problem, not a reason to under-exclude.
 */
export const deriveDislikedFoodGroups = (
    foodIds: readonly string[],
    taxonomy: DislikedFoodTaxonomy,
): DislikedFoodGroupsDerivation => {
    const groupById = new Map<string, string | null>();

    for (const food of taxonomy.foods) {
        if (!groupById.has(food.id)) {
            groupById.set(food.id, food.food_group ?? null);
        }
    }

    const knownGroupKeys = new Set(
        (taxonomy.knownFoodGroups ?? []).map(comparisonKey).filter((key) => key.length > 0),
    );

    const seenIds = new Set<string>();
    const accepted: string[] = [];
    const unknownFoodIds: string[] = [];
    const ungroupedFoodIds: string[] = [];
    const groupsByKey = new Map<string, string>();

    for (const id of foodIds) {
        if (seenIds.has(id)) {
            continue;
        }
        seenIds.add(id);

        if (!groupById.has(id)) {
            unknownFoodIds.push(id);
            continue;
        }

        accepted.push(id);

        const group = groupById.get(id) ?? null;
        const key = group === null ? '' : comparisonKey(group);

        if (group === null || key.length === 0) {
            ungroupedFoodIds.push(id);
            continue;
        }

        if (!groupsByKey.has(key)) {
            groupsByKey.set(key, group);
        }
    }

    const orderedKeys = [...groupsByKey.keys()].sort();

    return {
        foodIds: accepted,
        foodGroups: orderedKeys.map((key) => groupsByKey.get(key) as string),
        unknownFoodIds,
        ungroupedFoodIds,
        unrecognizedFoodGroups:
            knownGroupKeys.size === 0
                ? []
                : orderedKeys
                      .filter((key) => !knownGroupKeys.has(key))
                      .map((key) => groupsByKey.get(key) as string),
    };
};

/* ---------------------------------------------------------------------------
 * Optimistic concurrency
 * ------------------------------------------------------------------------- */

/** `PreferencesResponse.revision` for a user who has no preferences row at all. */
export const NO_PREFERENCES_REVISION = 0;

/**
 * The largest revision a pinned token may name: the maximum value of the
 * PostgreSQL `integer` column the counters live in.
 *
 * A token above it — or any value outside JavaScript's exact-integer range,
 * such as `1e30` — cannot denote a stored revision at all, so it is a
 * MALFORMED request rather than a lost race. Classifying it as stale would
 * tell the client to re-read and retry a value that can never match, and would
 * hand the service a number it cannot compare against the column.
 */
export const MAX_REVISION = 2_147_483_647;

type ResolvedRevision =
    | { kind: 'ok'; expectedRevision: number | null }
    | { kind: 'invalid'; detail: InvalidRequestDetail }
    | { kind: 'stale'; currentRevision: number };

/**
 * The expected-revision rule, whose asymmetry is deliberate.
 *
 * `expectedRevision` is optional ONLY while no preferences row exists AND the
 * caller is the very first `goal` save, which has no revision to pin (the
 * caller passes that as `optionalBeforeCreation`; see
 * {@link parseSetupStep}). It is required and exact from then on. A missing
 * value after creation is therefore a stale revision rather than a malformed
 * body: a client that does not pin one cannot be allowed to overwrite whatever
 * another device just wrote, and treating the omission as "no opinion" is
 * precisely how two clients editing at once would both appear to succeed while
 * one update vanished. Exactly one of them loses, and it is told so.
 *
 * A row that exists reads back revision 0 nowhere, and a user with no row reads
 * back {@link NO_PREFERENCES_REVISION} — which is why an absent row and an
 * expected 0 are the same comparison.
 *
 * A token that cannot denote a stored revision at all is a 400 before any
 * comparison is attempted: not a number, not finite, not a whole number,
 * negative, or outside the exact range the {@link MAX_REVISION} column holds.
 */
const resolveExpectedRevision = (
    value: unknown,
    currentRevision: number | null,
    options: { optionalBeforeCreation: boolean },
): ResolvedRevision => {
    const effectiveCurrent = currentRevision ?? NO_PREFERENCES_REVISION;

    if (isAbsent(value)) {
        return currentRevision === null && options.optionalBeforeCreation
            ? { kind: 'ok', expectedRevision: null }
            : { kind: 'stale', currentRevision: effectiveCurrent };
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { kind: 'invalid', detail: detail('expectedRevision', PREFERENCE_FIELD_CODES.INVALID_TYPE) };
    }

    if (!Number.isInteger(value)) {
        return {
            kind: 'invalid',
            detail: detail('expectedRevision', PREFERENCE_FIELD_CODES.NOT_AN_INTEGER),
        };
    }

    if (value < NO_PREFERENCES_REVISION) {
        return {
            kind: 'invalid',
            detail: detail('expectedRevision', PREFERENCE_FIELD_CODES.BELOW_MINIMUM),
        };
    }

    // `Number.isInteger(1e30)` is true, so the integer check above lets through
    // values that are whole but not exactly representable and cannot be a
    // stored revision. Both halves are one bound: above `MAX_REVISION` the
    // column cannot hold it, and above `Number.MAX_SAFE_INTEGER` the comparison
    // itself would be unsound.
    if (!Number.isSafeInteger(value) || value > MAX_REVISION) {
        return {
            kind: 'invalid',
            detail: detail('expectedRevision', PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM),
        };
    }

    return value === effectiveCurrent
        ? { kind: 'ok', expectedRevision: value }
        : { kind: 'stale', currentRevision: effectiveCurrent };
};

/* ---------------------------------------------------------------------------
 * Goal coherence — one rule, one implementation
 *
 * Three answers form one tuple: the goal's DIRECTION, the current weight, and
 * the target weight. Each is edited on a different screen and through a
 * different endpoint, so the tuple can be broken by a request that never
 * mentions the member it invalidates — which is why the check below is shared
 * by the goal step, the body step and the full save rather than written once
 * beside the goal field.
 * ------------------------------------------------------------------------- */

/**
 * Why a target weight does not sit on the goal's side of the current weight, or
 * null when the three answers are coherent (or not yet comparable).
 *
 * Returns null rather than a refusal when either weight is unknown: the goal is
 * answered BEFORE the body step on first entry, so there is genuinely nothing
 * to compare against yet, and inventing a weight would refuse a target the
 * screen allows. The comparison becomes possible later, and every write that
 * touches a member of the tuple re-runs it — that is what stops a target
 * accepted at question two from surviving a current weight entered at question
 * three that contradicts it.
 *
 * Never silently clears the target: a goal weight is the user's own answer, and
 * dropping it to make a row coherent would be the same class of mistake as
 * resolving a contradictory allergy selection by guessing.
 */
const goalWeightConflict = (
    goal: Goal | null,
    currentWeightKg: number | null | undefined,
    goalWeightKg: number | null | undefined,
): PreferenceFieldCode | null => {
    if (
        typeof currentWeightKg !== 'number' ||
        !Number.isFinite(currentWeightKg) ||
        typeof goalWeightKg !== 'number' ||
        !Number.isFinite(goalWeightKg)
    ) {
        return null;
    }

    if (goal === 'lose' && goalWeightKg >= currentWeightKg) {
        return PREFERENCE_FIELD_CODES.NOT_BELOW_CURRENT_WEIGHT;
    }

    if (goal === 'gain' && goalWeightKg <= currentWeightKg) {
        return PREFERENCE_FIELD_CODES.NOT_ABOVE_CURRENT_WEIGHT;
    }

    return null;
};

/* ---------------------------------------------------------------------------
 * The step parsers
 * ------------------------------------------------------------------------- */

/**
 * The eight steps that accept a payload — every `SetupStep` except
 * `targets_manual`, which is a stored resume marker for the manual-target route
 * and never a `:step` path segment (that route saves through
 * `PUT /meal-planning/targets`). Sending it as a step is refused rather than
 * quietly accepted, because accepting it would let a client mark a resume point
 * it never reached.
 */
export type PayloadBearingSetupStep = Exclude<SetupStep, 'targets_manual'>;

const PAYLOAD_BEARING_STEPS: Readonly<Record<PayloadBearingSetupStep, true>> = {
    goal: true,
    body: true,
    activity: true,
    diet: true,
    dislikes: true,
    schedule: true,
    cooking: true,
    review: true,
};

export const isPayloadBearingSetupStep = (value: unknown): value is PayloadBearingSetupStep =>
    isMemberOf(PAYLOAD_BEARING_STEPS, value);

/** The payload type each `:step` path segment declares. */
interface StepPayloadByStep {
    goal: GoalStepPayload;
    // Both variants, because the step accepts either the measured answer or Skip.
    body: BodyMeasuredStepPayload | BodySkippedStepPayload;
    activity: ActivityStepPayload;
    diet: DietStepPayload;
    dislikes: DislikesStepPayload;
    schedule: ScheduleStepPayload;
    cooking: CookingStepPayload;
    review: ReviewStepPayload;
}

/**
 * A payload's own keys — everything it declares beyond the shared envelope.
 *
 * DISTRIBUTIVE on purpose: `keyof (A | B)` is the INTERSECTION of the two key
 * sets, which for the body step would silently reduce to `skipped` alone and
 * leave every measurement refused as an unknown key. Distributing over the
 * union yields the union of their keys, which is what the step accepts.
 */
type OwnPayloadKeys<T> = T extends unknown ? Exclude<keyof T, keyof SetupStepEnvelope> : never;

/** The two keys every per-step body carries whatever the step is. */
const ENVELOPE_KEYS: Readonly<Record<keyof SetupStepEnvelope, true>> = {
    timeZone: true,
    expectedRevision: true,
};

/**
 * Every key each step's body may carry, beside {@link ENVELOPE_KEYS}.
 *
 * Typed against the payload interfaces themselves — `Record<OwnPayloadKeys<…>,
 * true>` per step — so the compiler rejects both halves of the drift this table
 * exists to prevent: a key listed here that the step's payload does not
 * declare, and a key added to a payload that nobody taught this table about.
 * The six server-owned members of `PreferencesResponse` (`setupStatus`,
 * `setupStep`, `revision`, `budgetTier`, `hasActivePlan`, `targetRoute`) appear
 * in no entry, which is what makes them refusals rather than silent no-ops.
 */
const STEP_PAYLOAD_KEYS: {
    readonly [S in PayloadBearingSetupStep]: Readonly<
        Record<OwnPayloadKeys<StepPayloadByStep[S]>, true>
    >;
} = {
    goal: { goal: true, goalWeightKg: true, paceLbPerWeek: true },
    body: {
        skipped: true,
        age: true,
        heightCm: true,
        weightKg: true,
        sexForEstimate: true,
        heightUnitPref: true,
        weightUnitPref: true,
    },
    activity: { activityLevel: true },
    diet: { diet: true, allergens: true },
    dislikes: { dislikedFoodIds: true },
    schedule: { mealSchedule: true, mealTimes: true },
    cooking: { cookingTimeLimitMin: true, budget: true, noBudgetPreference: true },
    review: { startDate: true },
};

/**
 * Skip's own keys — the discriminant and nothing else.
 *
 * The body step is the one step whose payload is a DISCRIMINATED UNION, so the
 * single entry above cannot be its closed key set: it holds the union of both
 * branches' keys, which is right for the measured answer and far too wide for
 * Skip. Skip declares no measurements at all, and `parseBodyStep` returns the
 * moment it sees `skipped: true`, so measurements sent alongside it would be
 * accepted under a 200 and then dropped on the floor — a client that filled the
 * form, tapped Skip, and read its own values back as unanswered. Selecting the
 * key set by the discriminant refuses them instead, with the same
 * `read_only_field` code every other unaccepted own key gets.
 *
 * Typed against `BodySkippedStepPayload` for the same reason the table above is
 * typed against the payload interfaces: neither half of the drift is possible.
 */
const BODY_SKIPPED_KEYS: Readonly<Record<OwnPayloadKeys<BodySkippedStepPayload>, true>> = {
    skipped: true,
};

/**
 * The closed key set a body carries, which for the body step depends on the
 * branch of the union the body selected.
 *
 * `skipped: true` selects Skip. Anything else — absent, `false`, or a value
 * that is not a boolean at all — selects the measured branch, whose own parser
 * then refuses a malformed discriminant on `skipped` rather than here, so a
 * caller sending `skipped: 'yes'` is told its type is wrong instead of being
 * told the field is unacceptable.
 */
const acceptedStepKeys = (
    step: PayloadBearingSetupStep,
    record: Record<string, unknown>,
): Readonly<Record<string, true>> =>
    step === 'body' && record.skipped === true ? BODY_SKIPPED_KEYS : STEP_PAYLOAD_KEYS[step];

/** Every own key of a step body that the step does not accept, in body order. */
const unacceptedStepKeys = (
    step: PayloadBearingSetupStep,
    record: Record<string, unknown>,
): string[] => {
    const accepted = acceptedStepKeys(step, record);

    return Object.keys(record).filter(
        (key) =>
            !Object.prototype.hasOwnProperty.call(accepted, key) &&
            !Object.prototype.hasOwnProperty.call(ENVELOPE_KEYS, key),
    );
};

/** What the parser must know about the stored row to judge a step payload. */
export interface SetupStepContext {
    /** The row's revision, or null when the user has no preferences row yet. */
    currentRevision: number | null;
    /**
     * The stored current body weight in kilograms, for judging a goal weight.
     * Absent or null means unknown — which the goal step treats as "no opinion"
     * rather than as a failure, since the goal is answered before the body step
     * on first entry and there is genuinely nothing to compare against yet.
     */
    currentWeightKg?: number | null;
    /**
     * The stored goal, for judging the body step's new current weight against a
     * target weight saved earlier. Absent or null means the goal step has not
     * been answered yet, so there is no direction to judge.
     */
    currentGoal?: Goal | null;
    /**
     * The stored target weight, for the same check. A target accepted at the
     * goal step while no current weight was known is revalidated the moment the
     * body step supplies one (see {@link goalWeightConflict}).
     */
    currentGoalWeightKg?: number | null;
}

/** The payload each step accepts, discriminated by the step it belongs to. */
export type ParsedSetupStepPayload =
    | { step: 'goal'; payload: GoalStepPayload }
    | { step: 'body'; payload: BodyStepPayload }
    | { step: 'activity'; payload: ActivityStepPayload }
    | { step: 'diet'; payload: DietStepPayload }
    | { step: 'dislikes'; payload: DislikesStepPayload }
    | { step: 'schedule'; payload: ScheduleStepPayload }
    | { step: 'cooking'; payload: CookingStepPayload }
    | { step: 'review'; payload: ReviewStepPayload };

export type ParsedSetupStep = ({ kind: 'ok' } & ParsedSetupStepPayload) | PreferenceRefusal;

interface StepEnvelope {
    timeZone: string;
    expectedRevision?: number;
}

const isRefusal = (value: object): value is PreferenceErrorVerdict => 'kind' in value;

const parseGoalStep = (
    record: Record<string, unknown>,
    envelope: StepEnvelope,
    context: SetupStepContext,
): GoalStepPayload | PreferenceErrorVerdict => {
    const details: InvalidRequestDetail[] = [];
    const goal: unknown = record.goal;
    const knownGoal = isMemberOf(GOALS, goal);

    if (isAbsent(goal)) {
        details.push(detail('goal', PREFERENCE_FIELD_CODES.REQUIRED));
    } else if (!knownGoal) {
        details.push(detail('goal', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
    }

    const maintains = goal === 'maintain';
    let paceLbPerWeek: PaceLbPerWeek | null = null;

    if (isAbsent(record.paceLbPerWeek)) {
        // Required for a direction, absent for maintenance. The pace cards are
        // the screen's second question and appear as soon as a direction is
        // chosen, so a directional goal with no pace is an unanswered screen —
        // and reading it as maintenance would put a maintenance target on a
        // weight-loss plan.
        if (knownGoal && !maintains) {
            details.push(detail('paceLbPerWeek', PREFERENCE_FIELD_CODES.REQUIRED));
        }
    } else if (maintains) {
        details.push(detail('paceLbPerWeek', PREFERENCE_FIELD_CODES.NOT_ALLOWED));
    } else if (!isNumericMemberOf(PACES, record.paceLbPerWeek)) {
        details.push(detail('paceLbPerWeek', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
    } else {
        paceLbPerWeek = record.paceLbPerWeek;
    }

    let goalWeightKg: number | null = null;

    if (!isAbsent(record.goalWeightKg)) {
        if (maintains) {
            details.push(detail('goalWeightKg', PREFERENCE_FIELD_CODES.NOT_ALLOWED));
        } else {
            const bounded = parseBoundedNumber(record.goalWeightKg, BODY_INPUT_RANGES.weightKg, {
                integer: false,
            });

            if (typeof bounded !== 'number') {
                details.push(detail('goalWeightKg', bounded));
            } else {
                const conflict = goalWeightConflict(
                    knownGoal ? (goal as Goal) : null,
                    context.currentWeightKg,
                    bounded,
                );

                if (conflict !== null) {
                    details.push(detail('goalWeightKg', conflict));
                } else {
                    goalWeightKg = bounded;
                }
            }
        }
    }

    if (details.length > 0) {
        return invalidRequest(details);
    }

    return { ...envelope, goal: goal as Goal, goalWeightKg, paceLbPerWeek };
};

/**
 * The body step, which is also where a target weight saved earlier becomes
 * judgeable for the first time.
 *
 * The goal screen comes first and may be answered before any current weight is
 * known, so its side check is skipped there. This step supplies that weight,
 * and re-runs the check against the stored target: without it, "lose weight,
 * target 77 kg" followed by "I currently weigh 70 kg" would be stored as a
 * coherent answer and then drive a plan. The refusal names `goalWeightKg`
 * because that is the answer that has to change (or be cleared) — the same
 * field and the same codes the goal screen itself reports, so the client maps
 * one message for both.
 *
 * Skip revalidates nothing: it carries no weight, so nothing became comparable.
 */
const parseBodyStep = (
    record: Record<string, unknown>,
    envelope: StepEnvelope,
    context: SetupStepContext,
): BodyStepPayload | PreferenceErrorVerdict => {
    if (record.skipped === true) {
        // Skip carries no measurements by design: it is the answer that routes
        // the user to manual targets rather than a partially filled form.
        return { ...envelope, skipped: true };
    }

    if (!isAbsent(record.skipped) && record.skipped !== false) {
        return invalidRequest([detail('skipped', PREFERENCE_FIELD_CODES.INVALID_TYPE)]);
    }

    const details: InvalidRequestDetail[] = [];
    const measurements = normalizeToMetric({
        age: record.age,
        height: { unit: 'cm', centimeters: record.heightCm },
        weight: { unit: 'kg', kilograms: record.weightKg },
    });

    if (measurements.kind !== 'ok') {
        details.push(...measurements.details);
    }

    if (isAbsent(record.sexForEstimate)) {
        details.push(detail('sexForEstimate', PREFERENCE_FIELD_CODES.REQUIRED));
    } else if (!isMemberOf(SEXES_FOR_ESTIMATE, record.sexForEstimate)) {
        details.push(detail('sexForEstimate', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
    }

    if (isAbsent(record.heightUnitPref)) {
        details.push(detail('heightUnitPref', PREFERENCE_FIELD_CODES.REQUIRED));
    } else if (!isMemberOf(HEIGHT_UNIT_PREFS, record.heightUnitPref)) {
        details.push(detail('heightUnitPref', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
    }

    if (isAbsent(record.weightUnitPref)) {
        details.push(detail('weightUnitPref', PREFERENCE_FIELD_CODES.REQUIRED));
    } else if (!isMemberOf(WEIGHT_UNIT_PREFS, record.weightUnitPref)) {
        details.push(detail('weightUnitPref', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
    }

    if (measurements.kind === 'ok') {
        const conflict = goalWeightConflict(
            context.currentGoal ?? null,
            measurements.measurements.weightKg,
            context.currentGoalWeightKg,
        );

        if (conflict !== null) {
            details.push(detail('goalWeightKg', conflict));
        }
    }

    if (details.length > 0 || measurements.kind !== 'ok') {
        return invalidRequest(details);
    }

    return {
        ...envelope,
        skipped: false,
        age: measurements.measurements.age,
        heightCm: measurements.measurements.heightCm,
        weightKg: measurements.measurements.weightKg,
        sexForEstimate: record.sexForEstimate as SexForEstimate,
        heightUnitPref: record.heightUnitPref as HeightUnitPref,
        weightUnitPref: record.weightUnitPref as WeightUnitPref,
    };
};

const parseActivityStep = (
    record: Record<string, unknown>,
    envelope: StepEnvelope,
): ActivityStepPayload | PreferenceErrorVerdict => {
    if (isAbsent(record.activityLevel)) {
        return invalidRequest([detail('activityLevel', PREFERENCE_FIELD_CODES.REQUIRED)]);
    }

    if (!isMemberOf(ACTIVITY_LEVELS, record.activityLevel)) {
        return invalidRequest([detail('activityLevel', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE)]);
    }

    return { ...envelope, activityLevel: record.activityLevel };
};

const parseDietStep = (
    record: Record<string, unknown>,
    envelope: StepEnvelope,
): DietStepPayload | PreferenceErrorVerdict => {
    const details: InvalidRequestDetail[] = [];

    if (isAbsent(record.diet)) {
        details.push(detail('diet', PREFERENCE_FIELD_CODES.REQUIRED));
    } else if (!isMemberOf(DIETS, record.diet)) {
        details.push(detail('diet', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
    }

    const allergens = parseAllergens(record.allergens);

    if (allergens.kind !== 'ok') {
        details.push(...allergens.details);
    }

    if (details.length > 0 || allergens.kind !== 'ok') {
        return invalidRequest(details);
    }

    return { ...envelope, diet: record.diet as Diet, allergens: allergens.allergens };
};

export type ParsedDislikedFoodIds = { kind: 'ok'; dislikedFoodIds: string[] } | PreferenceErrorVerdict;

/**
 * The disliked food ids as they will be stored: de-duplicated, in selection
 * order, every one a v4 UUID, and at most {@link MAX_DISLIKED_FOOD_IDS} of them.
 *
 * The count is judged AFTER de-duplication, because the limit exists to bound
 * the exclusion set rather than the request, and it is judged BEFORE the
 * per-id walk so a pathological body cannot produce an unbounded detail array.
 * Whether each id names a published food is the service's question — this module
 * has no catalog to consult.
 */
export const parseDislikedFoodIds = (
    value: unknown,
    field = 'dislikedFoodIds',
): ParsedDislikedFoodIds => {
    if (isAbsent(value)) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.REQUIRED)]);
    }

    if (!Array.isArray(value)) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.INVALID_TYPE)]);
    }

    const seen = new Set<unknown>();
    const distinct: unknown[] = [];

    for (const entry of value) {
        if (!seen.has(entry)) {
            seen.add(entry);
            distinct.push(entry);
        }
    }

    if (distinct.length > MAX_DISLIKED_FOOD_IDS) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.TOO_MANY)]);
    }

    const details: InvalidRequestDetail[] = [];
    const dislikedFoodIds: string[] = [];

    distinct.forEach((entry, index) => {
        if (!isUuidV4(entry)) {
            details.push(detail(`${field}[${index}]`, PREFERENCE_FIELD_CODES.INVALID_ID));
            return;
        }

        dislikedFoodIds.push(entry);
    });

    return details.length > 0 ? invalidRequest(details) : { kind: 'ok', dislikedFoodIds };
};

const parseDislikesStep = (
    record: Record<string, unknown>,
    envelope: StepEnvelope,
): DislikesStepPayload | PreferenceErrorVerdict => {
    const parsed = parseDislikedFoodIds(record.dislikedFoodIds);

    return parsed.kind === 'ok' ? { ...envelope, dislikedFoodIds: parsed.dislikedFoodIds } : parsed;
};

const parseScheduleStep = (
    record: Record<string, unknown>,
    envelope: StepEnvelope,
): ScheduleStepPayload | PreferenceErrorVerdict => {
    if (isAbsent(record.mealSchedule)) {
        return invalidRequest([detail('mealSchedule', PREFERENCE_FIELD_CODES.REQUIRED)]);
    }

    if (!isMemberOf(MEAL_SCHEDULES, record.mealSchedule)) {
        return invalidRequest([detail('mealSchedule', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE)]);
    }

    const mealTimes = validateMealTimes(record.mealSchedule, record.mealTimes);

    return mealTimes.kind === 'ok'
        ? { ...envelope, mealSchedule: record.mealSchedule, mealTimes: mealTimes.mealTimes }
        : mealTimes;
};

const parseCookingStep = (
    record: Record<string, unknown>,
    envelope: StepEnvelope,
): CookingStepPayload | PreferenceErrorVerdict => {
    const details: InvalidRequestDetail[] = [];

    if (isAbsent(record.cookingTimeLimitMin)) {
        details.push(detail('cookingTimeLimitMin', PREFERENCE_FIELD_CODES.REQUIRED));
    } else if (!isNumericMemberOf(COOKING_TIME_LIMITS, record.cookingTimeLimitMin)) {
        details.push(detail('cookingTimeLimitMin', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
    }

    const budget = parseBudgetAnswer(record.budget, record.noBudgetPreference);

    if (budget.kind !== 'ok') {
        details.push(...budget.details);
    }

    if (details.length > 0 || budget.kind !== 'ok') {
        return invalidRequest(details);
    }

    return {
        ...envelope,
        cookingTimeLimitMin: record.cookingTimeLimitMin as CookingTimeLimitMin,
        budget: budget.answer.budget,
        noBudgetPreference: budget.answer.noBudgetPreference,
    };
};

const parseReviewStep = (
    record: Record<string, unknown>,
    envelope: StepEnvelope,
): ReviewStepPayload | PreferenceErrorVerdict => {
    if (isAbsent(record.startDate)) {
        return invalidRequest([detail('startDate', PREFERENCE_FIELD_CODES.REQUIRED)]);
    }

    // Format and calendar validity only. Whether the day is within the plan's
    // permitted window needs today's date in the user's zone, which no pure
    // function can know: the service holds that bound.
    if (!isCalendarDayKey(record.startDate)) {
        return invalidRequest([detail('startDate', PREFERENCE_FIELD_CODES.INVALID_DATE)]);
    }

    return { ...envelope, startDate: record.startDate };
};

/**
 * Validates one per-step save and returns the answer it stores.
 *
 * Order of judgement is deliberate: an unknown step, then a body that is not an
 * object, then every field-level problem in ONE 400, and only then the revision
 * race. A malformed request is a 400 whatever its revision claims — its
 * revision is moot until the body is well formed — while the 409 is reserved
 * for a well-formed request that simply lost the race, which is the only case
 * the client's re-read-and-compare recovery can resolve.
 *
 * THE KEY SET IS CLOSED, exactly as it is for the full save: each step declares
 * one typed payload, and an own key outside it plus the envelope is refused
 * with `read_only_field` rather than ignored. Ignoring it hides two different
 * client bugs behind a 200 — an attempt to write a server-owned value such as
 * `setupStatus`, which would leave the caller believing it had fabricated
 * onboarding progress, and a misspelled answer (`activityLevl`), which would be
 * silently dropped and read back as unanswered by a screen that thinks it saved.
 *
 * THE FIRST WRITE MUST BE THE `goal` STEP. That save is the one that creates
 * the row, and it is therefore also the only one that may omit
 * `expectedRevision` — there is no revision to pin yet. Every other step
 * against a user who has no row is out of order: the wizard cannot reach it, a
 * resume always re-enters at the stored marker, and accepting it would create
 * setup state from the middle of the flow (with or without a pinned zero
 * revision), leaving earlier answers permanently absent while the row claims
 * progress.
 */
export const parseSetupStep = (
    step: unknown,
    body: unknown,
    context: SetupStepContext,
): ParsedSetupStep => {
    if (!isPayloadBearingSetupStep(step)) {
        return invalidRequest([detail('step', PREFERENCE_FIELD_CODES.UNKNOWN_STEP)]);
    }

    const record = asRecord(body);

    if (record === null) {
        return invalidRequest([detail('body', PREFERENCE_FIELD_CODES.INVALID_TYPE)]);
    }

    const details: InvalidRequestDetail[] = [];

    for (const key of unacceptedStepKeys(step, record)) {
        details.push(detail(key, PREFERENCE_FIELD_CODES.READ_ONLY_FIELD));
    }

    const timeZone = normalizeTimeZone(record.timeZone);

    if (timeZone === null) {
        details.push(
            detail(
                'timeZone',
                isAbsent(record.timeZone)
                    ? PREFERENCE_FIELD_CODES.REQUIRED
                    : PREFERENCE_FIELD_CODES.INVALID_TIME_ZONE,
            ),
        );
    }

    // A legitimate step, but not as the first write this user makes: `goal`
    // creates the row. Reported as a 400 on `step` rather than as a stale
    // revision, because no revision the client could have pinned would make it
    // acceptable.
    if (context.currentRevision === null && step !== 'goal') {
        details.push(detail('step', PREFERENCE_FIELD_CODES.NOT_ALLOWED));
    }

    const revision = resolveExpectedRevision(record.expectedRevision, context.currentRevision, {
        optionalBeforeCreation: step === 'goal',
    });

    if (revision.kind === 'invalid') {
        details.push(revision.detail);
    }

    // The placeholder zone is unreachable by a caller: a null zone has already
    // added its detail above, and a non-empty `details` returns the 400 before
    // any payload is handed back. It exists so the step parsers below can run
    // and contribute THEIR field problems to the same 400, rather than the
    // screen having to fix one field per round trip.
    const envelope: StepEnvelope =
        revision.kind === 'ok' && revision.expectedRevision !== null
            ? { timeZone: timeZone ?? '', expectedRevision: revision.expectedRevision }
            : { timeZone: timeZone ?? '' };

    const parsed =
        step === 'goal'
            ? parseGoalStep(record, envelope, context)
            : step === 'body'
              ? parseBodyStep(record, envelope, context)
              : step === 'activity'
                ? parseActivityStep(record, envelope)
                : step === 'diet'
                  ? parseDietStep(record, envelope)
                  : step === 'dislikes'
                    ? parseDislikesStep(record, envelope)
                    : step === 'schedule'
                      ? parseScheduleStep(record, envelope)
                      : step === 'cooking'
                        ? parseCookingStep(record, envelope)
                        : parseReviewStep(record, envelope);

    if (isRefusal(parsed)) {
        details.push(...parsed.details);
    }

    if (details.length > 0) {
        return invalidRequest(details);
    }

    if (revision.kind === 'stale') {
        return staleRevision(revision.currentRevision);
    }

    switch (step) {
        case 'goal':
            return { kind: 'ok', step, payload: parsed as GoalStepPayload };
        case 'body':
            return { kind: 'ok', step, payload: parsed as BodyStepPayload };
        case 'activity':
            return { kind: 'ok', step, payload: parsed as ActivityStepPayload };
        case 'diet':
            return { kind: 'ok', step, payload: parsed as DietStepPayload };
        case 'dislikes':
            return { kind: 'ok', step, payload: parsed as DislikesStepPayload };
        case 'schedule':
            return { kind: 'ok', step, payload: parsed as ScheduleStepPayload };
        case 'cooking':
            return { kind: 'ok', step, payload: parsed as CookingStepPayload };
        default:
            return { kind: 'ok', step, payload: parsed as ReviewStepPayload };
    }
};

/* ---------------------------------------------------------------------------
 * The full save — a closed set of keys, enforced by the compiler
 * ------------------------------------------------------------------------- */

/**
 * Every key `PUT /meal-planning/preferences` accepts.
 *
 * Typed as `Record<keyof PreferencesUpdatePayload, true>` on purpose: the
 * compiler now rejects both halves of the drift the contract warns about — a key
 * listed here that the DTO does not declare, and a key added to the DTO that
 * nobody taught this parser about. The six server-owned members of
 * `PreferencesResponse` (`setupStatus`, `setupStep`, `revision`, `budgetTier`,
 * `hasActivePlan`, `targetRoute`) are absent from the DTO and therefore from
 * this table, which is what makes them refusals rather than silent no-ops.
 */
const ACCEPTED_UPDATE_KEYS: Readonly<Record<keyof PreferencesUpdatePayload, true>> = {
    goal: true,
    goalWeightKg: true,
    paceLbPerWeek: true,
    age: true,
    heightCm: true,
    weightKg: true,
    sexForEstimate: true,
    heightUnitPref: true,
    weightUnitPref: true,
    activityLevel: true,
    diet: true,
    allergens: true,
    dislikedFoodIds: true,
    dislikedFoodGroups: true,
    mealSchedule: true,
    mealTimes: true,
    cookingTimeLimitMin: true,
    budget: true,
    noBudgetPreference: true,
    timeZone: true,
    expectedRevision: true,
};

/** What the parser must know about the stored row to judge a PARTIAL body. */
export interface PreferencesUpdateContext {
    currentRevision: number | null;
    /** For the goal-weight side check when the body changes only the goal. */
    currentWeightKg?: number | null;
    /** For the goal-weight side check when the body changes only the weight. */
    currentGoal?: Goal | null;
    /**
     * The stored target weight, for the side check when the body changes only
     * the goal or only the current weight — either of which can invalidate a
     * target the request never mentions.
     */
    currentGoalWeightKg?: number | null;
    /**
     * The stored pace, for the goal/pace pair check when the body changes only
     * the goal. A direction with no pace cannot be estimated from at all
     * (`targets.logic.ts::resolveEstimateInputs` answers `missing_inputs`), so
     * a partial that creates that pair is refused here rather than stored.
     */
    currentPaceLbPerWeek?: PaceLbPerWeek | null;
    /** For judging meal times when the body changes only the times. */
    currentMealSchedule?: MealSchedule | null;
    /** For judging the budget pair when the body changes only one half of it. */
    currentBudget?: BudgetPreference | null;
    currentNoBudgetPreference?: boolean;
}

export type ParsedPreferencesUpdate =
    | { kind: 'ok'; payload: PreferencesUpdatePayload }
    | PreferenceRefusal;

const MAX_DISLIKED_FOOD_GROUPS = MAX_DISLIKED_FOOD_IDS;

const parseFoodGroupList = (value: unknown, field: string): string[] | PreferenceErrorVerdict => {
    if (!Array.isArray(value)) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.INVALID_TYPE)]);
    }

    if (value.length > MAX_DISLIKED_FOOD_GROUPS) {
        return invalidRequest([detail(field, PREFERENCE_FIELD_CODES.TOO_MANY)]);
    }

    const details: InvalidRequestDetail[] = [];
    const byKey = new Map<string, string>();

    value.forEach((entry, index) => {
        if (typeof entry !== 'string' || comparisonKey(entry).length === 0) {
            details.push(detail(`${field}[${index}]`, PREFERENCE_FIELD_CODES.INVALID_TYPE));
            return;
        }

        const key = comparisonKey(entry);

        if (!byKey.has(key)) {
            byKey.set(key, entry);
        }
    });

    if (details.length > 0) {
        return invalidRequest(details);
    }

    return [...byKey.keys()].sort().map((key) => byKey.get(key) as string);
};

/**
 * Validates the full preferences save.
 *
 * THE KEY SET IS CLOSED, and a key outside it is REFUSED rather than ignored —
 * the same contract the per-step saves enforce through
 * {@link STEP_PAYLOAD_KEYS}. Silently dropping an attempt to set `setupStatus`
 * would hide a client bug and leave a caller believing it had fabricated
 * onboarding progress; one `read_only_field` detail per offending key says
 * otherwise. Unknown names get the same code, because "this key is not yours to
 * write" is the same answer whether the key exists on the response or nowhere
 * at all.
 *
 * Three things separate this from a per-step save:
 *
 *  * IT REQUIRES AN EXISTING ROW. Creation belongs to the first `goal` step, so
 *    `expectedRevision` is mandatory here and a user with no row is refused
 *    however they pin it (see the end of this function).
 *  * THE BODY IS A PARTIAL, so omitted and null are not the same thing. An
 *    omitted key leaves the stored value alone; an explicit null CLEARS it,
 *    which is how switching to the 'maintain' goal drops a target weight and a
 *    pace.
 *  * COHERENCE IS JUDGED AGAINST THE STORED ROW supplied in `context`, not
 *    against the body alone, because a partial can break an answer it never
 *    mentions. Four rules read it: meal times must match whichever schedule
 *    ends up in force; a budget amount must exist unless "no budget preference"
 *    is the answer; a directional goal must have a pace; and the target weight
 *    must sit on the goal's side of the current weight. The last two are
 *    re-judged whenever ANY member of their tuple changes — which is the
 *    difference between storing a coherent row and storing one that only looked
 *    coherent to the request that wrote it.
 *
 * Setting the 'maintain' goal NORMALISES the pair away — the returned payload
 * carries explicit nulls for the goal weight and the pace — so no stored row can
 * hold a maintenance goal with a weight-change pace attached. Sending
 * 'maintain' WITH a non-null pace or goal weight is a contradiction inside one
 * request and is refused instead.
 */
export const parsePreferencesUpdate = (
    body: unknown,
    context: PreferencesUpdateContext,
): ParsedPreferencesUpdate => {
    const record = asRecord(body);

    if (record === null) {
        return invalidRequest([detail('body', PREFERENCE_FIELD_CODES.INVALID_TYPE)]);
    }

    const details: InvalidRequestDetail[] = [];
    const rejectedKeys = Object.keys(record).filter(
        (key) => !Object.prototype.hasOwnProperty.call(ACCEPTED_UPDATE_KEYS, key),
    );

    for (const key of rejectedKeys) {
        details.push(detail(key, PREFERENCE_FIELD_CODES.READ_ONLY_FIELD));
    }

    const has = (key: keyof PreferencesUpdatePayload): boolean =>
        Object.prototype.hasOwnProperty.call(record, key);

    const editedKeys = (Object.keys(ACCEPTED_UPDATE_KEYS) as (keyof PreferencesUpdatePayload)[]).filter(
        (key) => key !== 'expectedRevision' && has(key),
    );

    if (rejectedKeys.length === 0 && editedKeys.length === 0) {
        // A save with nothing in it would still bump the revision and invalidate
        // every other client's pinned value for no change at all.
        details.push(detail('body', PREFERENCE_FIELD_CODES.REQUIRED));
    }

    const revision = resolveExpectedRevision(record.expectedRevision, context.currentRevision, {
        optionalBeforeCreation: false,
    });

    if (revision.kind === 'invalid') {
        details.push(revision.detail);
    }

    const payload: Record<string, unknown> = {};

    if (has('goal')) {
        if (isAbsent(record.goal)) {
            details.push(detail('goal', PREFERENCE_FIELD_CODES.REQUIRED));
        } else if (!isMemberOf(GOALS, record.goal)) {
            details.push(detail('goal', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
        } else {
            payload.goal = record.goal;
        }
    }

    const goalRejected = has('goal') && payload.goal === undefined;
    const effectiveGoal: Goal | null =
        (payload.goal as Goal | undefined) ?? context.currentGoal ?? null;
    const maintains = effectiveGoal === 'maintain';

    let paceRejected = false;

    if (has('paceLbPerWeek')) {
        if (isAbsent(record.paceLbPerWeek)) {
            payload.paceLbPerWeek = null;
        } else if (maintains) {
            details.push(detail('paceLbPerWeek', PREFERENCE_FIELD_CODES.NOT_ALLOWED));
            paceRejected = true;
        } else if (!isNumericMemberOf(PACES, record.paceLbPerWeek)) {
            details.push(detail('paceLbPerWeek', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
            paceRejected = true;
        } else {
            payload.paceLbPerWeek = record.paceLbPerWeek;
        }
    } else if (maintains && has('goal')) {
        payload.paceLbPerWeek = null;
    }

    // A direction needs a pace, and either half of that pair may arrive without
    // the other: switching `maintain` -> `lose` while the stored pace is null
    // (maintenance never has one) would otherwise store a goal no estimate can
    // be computed from, which surfaces later as an unexplained
    // `estimate_unavailable` on the review screen rather than as a rejected
    // save. Judged on the EFFECTIVE pair, and only while both halves are
    // well-formed — a pace already refused above does not also get reported as
    // missing.
    const effectivePace: PaceLbPerWeek | null = has('paceLbPerWeek')
        ? ((payload.paceLbPerWeek as PaceLbPerWeek | null | undefined) ?? null)
        : (context.currentPaceLbPerWeek ?? null);

    if (
        !goalRejected &&
        !paceRejected &&
        (has('goal') || has('paceLbPerWeek')) &&
        effectiveGoal !== null &&
        !maintains &&
        effectivePace === null
    ) {
        details.push(detail('paceLbPerWeek', PREFERENCE_FIELD_CODES.REQUIRED));
    }

    let weightRejected = false;

    if (has('weightKg')) {
        const bounded = parseBoundedNumber(record.weightKg, BODY_INPUT_RANGES.weightKg, {
            integer: false,
        });

        if (typeof bounded !== 'number') {
            details.push(detail('weightKg', bounded));
            weightRejected = true;
        } else {
            payload.weightKg = bounded;
        }
    }

    let goalWeightRejected = false;

    if (has('goalWeightKg')) {
        if (isAbsent(record.goalWeightKg)) {
            payload.goalWeightKg = null;
        } else if (maintains) {
            details.push(detail('goalWeightKg', PREFERENCE_FIELD_CODES.NOT_ALLOWED));
            goalWeightRejected = true;
        } else {
            const bounded = parseBoundedNumber(record.goalWeightKg, BODY_INPUT_RANGES.weightKg, {
                integer: false,
            });

            if (typeof bounded !== 'number') {
                details.push(detail('goalWeightKg', bounded));
                goalWeightRejected = true;
            } else {
                payload.goalWeightKg = bounded;
            }
        }
    } else if (maintains && has('goal')) {
        payload.goalWeightKg = null;
    }

    // The goal/weight/target tuple, judged ONCE against whichever values end up
    // in force. It is re-judged whenever this body changes any member — not
    // only when it carries the target — because changing the direction
    // (`lose` -> `gain`) or the current weight is exactly how a target accepted
    // earlier stops sitting on the goal's side of it. A body that touches no
    // member is left alone, so an incoherent legacy row does not block an
    // unrelated edit; and a member this request already refused is not
    // compared, so one mistake produces one detail.
    if (
        !goalRejected &&
        !weightRejected &&
        !goalWeightRejected &&
        (has('goal') || has('weightKg') || has('goalWeightKg'))
    ) {
        const effectiveWeight =
            (payload.weightKg as number | undefined) ?? context.currentWeightKg ?? null;
        const effectiveGoalWeight = has('goalWeightKg')
            ? ((payload.goalWeightKg as number | null | undefined) ?? null)
            : (context.currentGoalWeightKg ?? null);
        const conflict = goalWeightConflict(effectiveGoal, effectiveWeight, effectiveGoalWeight);

        if (conflict !== null) {
            details.push(detail('goalWeightKg', conflict));
        }
    }

    if (has('age')) {
        const bounded = parseBoundedNumber(record.age, BODY_INPUT_RANGES.age, { integer: true });

        if (typeof bounded !== 'number') {
            details.push(detail('age', bounded));
        } else {
            payload.age = bounded;
        }
    }

    if (has('heightCm')) {
        const bounded = parseBoundedNumber(record.heightCm, BODY_INPUT_RANGES.heightCm, {
            integer: false,
        });

        if (typeof bounded !== 'number') {
            details.push(detail('heightCm', bounded));
        } else {
            payload.heightCm = bounded;
        }
    }

    if (has('sexForEstimate')) {
        if (!isMemberOf(SEXES_FOR_ESTIMATE, record.sexForEstimate)) {
            details.push(
                detail(
                    'sexForEstimate',
                    isAbsent(record.sexForEstimate)
                        ? PREFERENCE_FIELD_CODES.REQUIRED
                        : PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
                ),
            );
        } else {
            payload.sexForEstimate = record.sexForEstimate;
        }
    }

    if (has('heightUnitPref')) {
        if (!isMemberOf(HEIGHT_UNIT_PREFS, record.heightUnitPref)) {
            details.push(detail('heightUnitPref', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
        } else {
            payload.heightUnitPref = record.heightUnitPref;
        }
    }

    if (has('weightUnitPref')) {
        if (!isMemberOf(WEIGHT_UNIT_PREFS, record.weightUnitPref)) {
            details.push(detail('weightUnitPref', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE));
        } else {
            payload.weightUnitPref = record.weightUnitPref;
        }
    }

    if (has('activityLevel')) {
        if (!isMemberOf(ACTIVITY_LEVELS, record.activityLevel)) {
            details.push(
                detail(
                    'activityLevel',
                    isAbsent(record.activityLevel)
                        ? PREFERENCE_FIELD_CODES.REQUIRED
                        : PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
                ),
            );
        } else {
            payload.activityLevel = record.activityLevel;
        }
    }

    if (has('diet')) {
        if (!isMemberOf(DIETS, record.diet)) {
            details.push(
                detail(
                    'diet',
                    isAbsent(record.diet)
                        ? PREFERENCE_FIELD_CODES.REQUIRED
                        : PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
                ),
            );
        } else {
            payload.diet = record.diet;
        }
    }

    if (has('allergens')) {
        const allergens = parseAllergens(record.allergens);

        if (allergens.kind !== 'ok') {
            details.push(...allergens.details);
        } else {
            payload.allergens = allergens.allergens;
        }
    }

    if (has('dislikedFoodIds')) {
        const parsed = parseDislikedFoodIds(record.dislikedFoodIds);

        if (parsed.kind !== 'ok') {
            details.push(...parsed.details);
        } else {
            payload.dislikedFoodIds = parsed.dislikedFoodIds;
        }
    }

    if (has('dislikedFoodGroups')) {
        const groups = parseFoodGroupList(record.dislikedFoodGroups, 'dislikedFoodGroups');

        if (Array.isArray(groups)) {
            payload.dislikedFoodGroups = groups;
        } else {
            details.push(...groups.details);
        }
    }

    if (has('mealSchedule')) {
        if (!isMemberOf(MEAL_SCHEDULES, record.mealSchedule)) {
            details.push(
                detail(
                    'mealSchedule',
                    isAbsent(record.mealSchedule)
                        ? PREFERENCE_FIELD_CODES.REQUIRED
                        : PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
                ),
            );
        } else {
            payload.mealSchedule = record.mealSchedule;
        }
    }

    const effectiveSchedule: MealSchedule | null =
        (payload.mealSchedule as MealSchedule | undefined) ?? context.currentMealSchedule ?? null;

    if (has('mealTimes')) {
        if (effectiveSchedule === null) {
            // The times cannot be judged without the schedule that says how many
            // there should be, and guessing the count is how a four-slot week
            // ends up with three times.
            details.push(detail('mealSchedule', PREFERENCE_FIELD_CODES.REQUIRED));
        } else {
            const mealTimes = validateMealTimes(effectiveSchedule, record.mealTimes);

            if (mealTimes.kind !== 'ok') {
                details.push(...mealTimes.details);
            } else {
                payload.mealTimes = mealTimes.mealTimes;
            }
        }
    } else if (
        payload.mealSchedule !== undefined &&
        payload.mealSchedule !== (context.currentMealSchedule ?? null)
    ) {
        // Changing the schedule changes how many meal times there must be, so
        // the stored set cannot survive the change unexamined.
        details.push(detail('mealTimes', PREFERENCE_FIELD_CODES.REQUIRED));
    }

    if (has('cookingTimeLimitMin')) {
        if (!isNumericMemberOf(COOKING_TIME_LIMITS, record.cookingTimeLimitMin)) {
            details.push(
                detail(
                    'cookingTimeLimitMin',
                    isAbsent(record.cookingTimeLimitMin)
                        ? PREFERENCE_FIELD_CODES.REQUIRED
                        : PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
                ),
            );
        } else {
            payload.cookingTimeLimitMin = record.cookingTimeLimitMin;
        }
    }

    if (has('budget') || has('noBudgetPreference')) {
        const noPreference = has('noBudgetPreference')
            ? record.noBudgetPreference
            : (context.currentNoBudgetPreference ?? false);
        // The stored amount stands in for an omitted one only while an amount is
        // still the answer. Checking "No budget preference" CLEARS whatever was
        // stored -- substituting it here would read the user's old amount back as
        // though this request had sent it, and `parseBudgetAnswer` would then
        // refuse the pair as a contradiction, leaving the checkbox unusable for
        // anyone who had ever typed a figure. Only an amount in THIS body
        // contradicts the box, which is the same rule the goal/pace pair follows.
        const amount =
            noPreference === true
                ? (has('budget') ? record.budget : undefined)
                : (has('budget') ? record.budget : (context.currentBudget ?? null));
        const budget = parseBudgetAnswer(amount, noPreference);

        if (budget.kind !== 'ok') {
            details.push(...budget.details);
        } else {
            payload.budget = budget.answer.budget;
            payload.noBudgetPreference = budget.answer.noBudgetPreference;
        }
    }

    if (has('timeZone')) {
        const timeZone = normalizeTimeZone(record.timeZone);

        if (timeZone === null) {
            details.push(
                detail(
                    'timeZone',
                    isAbsent(record.timeZone)
                        ? PREFERENCE_FIELD_CODES.REQUIRED
                        : PREFERENCE_FIELD_CODES.INVALID_TIME_ZONE,
                ),
            );
        } else {
            payload.timeZone = timeZone;
        }
    }

    if (details.length > 0) {
        return invalidRequest(details);
    }

    // This endpoint EDITS; it never creates. A user with no row has answered
    // nothing, so there is no partial to apply to anything, and the pinned
    // revision is beside the point: `expectedRevision: 0` compares equal to the
    // absent row's read-back value and would otherwise let a full save
    // materialise setup state that belongs to the first `goal` step. The client
    // recovery is the same one it already has for a lost race — re-read, see
    // `revision: 0` and `setupStatus: 'not_started'`, and go through setup.
    if (context.currentRevision === null || revision.kind === 'stale') {
        return staleRevision(
            revision.kind === 'stale' ? revision.currentRevision : NO_PREFERENCES_REVISION,
        );
    }

    return {
        kind: 'ok',
        payload: {
            ...payload,
            expectedRevision: revision.kind === 'ok' ? (revision.expectedRevision as number) : 0,
        } as PreferencesUpdatePayload,
    };
};

/* ---------------------------------------------------------------------------
 * The setup state machine
 * ------------------------------------------------------------------------- */

const STATUS_RANK: Readonly<Record<SetupStatus, number>> = {
    not_started: 0,
    in_progress: 1,
    ready_for_review: 2,
    completed: 3,
};

/**
 * The estimated route's stops, in wizard order — the seven counted steps plus
 * the review screen itself.
 */
const ESTIMATED_ROUTE_ORDER: readonly SetupStep[] = [
    'goal',
    'body',
    'activity',
    'diet',
    'dislikes',
    'schedule',
    'cooking',
    'review',
];

/**
 * The manual route's stops. `activity` is ABSENT — it exists only to compute a
 * target, and this route's targets are typed in by hand — and `targets_manual`
 * takes its place so a force-quit on the manual target screen resumes there.
 * Six counted steps, which is why the progress readout on this route reads
 * "n of 6".
 */
const MANUAL_ROUTE_ORDER: readonly SetupStep[] = [
    'goal',
    'body',
    'targets_manual',
    'diet',
    'dislikes',
    'schedule',
    'cooking',
    'review',
];

/** The stops a route walks, in order. An unresolved route is treated as estimated. */
export const routeStepOrder = (route: TargetRoute | null): readonly SetupStep[] =>
    route === 'manual' ? MANUAL_ROUTE_ORDER : ESTIMATED_ROUTE_ORDER;

/**
 * The steps that must be answered before a route is ready for review: its stops
 * minus the review screen and minus the manual target screen, which saves
 * through the targets endpoint rather than as a step.
 *
 * Seven on the estimated route, six on the manual one — the counts the progress
 * readout shows.
 */
export const requiredSetupSteps = (route: TargetRoute | null): readonly SetupStep[] =>
    routeStepOrder(route).filter((step) => step !== 'review' && step !== 'targets_manual');

/**
 * Which target route a body-step answer puts the user on.
 *
 * Both entrances to the manual route are here, and the second is easy to miss:
 * Skip sends no measurements at all, while "Prefer not to say" sends a complete
 * set of them and still cannot be estimated from, because the energy equation
 * has a coefficient for exactly two answers. Reading the second as estimable is
 * how a user who declined to say would be shown a number derived from an
 * assumed sex.
 */
export const resolveTargetRouteForBodyStep = (payload: BodyStepPayload): TargetRoute => {
    if (payload.skipped === true) {
        return 'manual';
    }

    return payload.sexForEstimate === 'prefer_not_to_say' ? 'manual' : 'estimated';
};

/**
 * The stored answers that PROVE a required step was answered, read straight off
 * the preferences row.
 *
 * Only the columns whose emptiness is unambiguous are here, and that is the
 * whole design: a column may stand in for "this step was answered" only where
 * there is no legitimate answer that leaves it null. `goal`, `activity_level`,
 * `diet`, `meal_schedule` and `cooking_time_limit_min` each qualify — every one
 * is required by its own step parser and none of them has an "answered as
 * nothing" case. The body step is proved by `targetRoute` instead of by the
 * measurements, because `target_route` is server-owned, absent from the update
 * DTO, and written by exactly one thing: a body-step save resolving it (Skip,
 * "prefer not to say", or a measured answer). So a non-null route means the body
 * step was answered whichever branch it took, including Skip, which stores no
 * measurements at all. `PreferencesResponse.targetRoute` carries the same proof
 * on the wire, so a client resuming setup reads it rather than re-deriving the
 * step from the measurements — which would call a saved Skip unanswered.
 *
 * `dislikes` is DELIBERATELY ABSENT and cannot be added: an empty
 * `disliked_food_ids` is a legitimate answer — the food-preferences screen's
 * Continue is enabled with nothing selected — so no column distinguishes "I
 * dislike nothing" from "never asked". Sequential progress
 * ({@link nextSetupState}) is what covers it, which is why readiness needs both
 * rules and neither alone.
 *
 * The service fills this from the row it already loaded; the members are
 * REQUIRED rather than optional so a caller cannot leave readiness to chance by
 * forgetting one.
 */
export interface SetupAnswerFacts {
    goal: Goal | null;
    activityLevel: ActivityLevel | null;
    diet: Diet | null;
    mealSchedule: MealSchedule | null;
    cookingTimeLimitMin: CookingTimeLimitMin | null;
}

export interface SetupStateSnapshot {
    setupStatus: SetupStatus;
    /** The stored resume marker, or null before the first save. */
    setupStep: SetupStep | null;
    targetRoute: TargetRoute | null;
    /** The row's answers, for the readiness check in {@link nextSetupState}. */
    answers: SetupAnswerFacts;
}

/**
 * Which stored column proves each required step was answered.
 *
 * A step absent from this table is one no column can prove — `dislikes`, for
 * the reason {@link SetupAnswerFacts} gives — and is therefore left to
 * sequential progress rather than checked here. Partial by design, so adding a
 * route stop does not silently acquire a bogus proof.
 */
const PROVABLE_STEP_ANSWERS: Readonly<
    Partial<Record<SetupStep, (answers: SetupAnswerFacts, route: TargetRoute | null) => boolean>>
> = {
    goal: (answers) => answers.goal !== null,
    body: (_answers, route) => route !== null,
    activity: (answers) => answers.activityLevel !== null,
    diet: (answers) => answers.diet !== null,
    schedule: (answers) => answers.mealSchedule !== null,
    cooking: (answers) => answers.cookingTimeLimitMin !== null,
};

/**
 * The first required step of a route that the stored row proves is UNANSWERED,
 * or null when nothing provable is missing.
 *
 * `answeredNow` is the step being saved, counted as answered because it is: the
 * snapshot is the row as it stands BEFORE this write, so checking the incoming
 * step against it would find its own column still null and pin the marker to
 * the screen the user just completed — the activity save would answer activity
 * and then be told to go answer activity.
 *
 * This is what makes a ROUTE CHANGE safe. The two routes require different
 * steps — `activity` belongs to the estimated route and not to the manual one —
 * so re-answering the body step with a measured sex moves a manual-route user
 * onto the estimated route and newly requires a step they were never asked.
 * Sequential progress alone cannot see that: the marker sits on a stop both
 * routes share (`diet`), the body save reads as an edit of an earlier answer,
 * and the marker walks on to `review` with `activity_level` never written.
 * Asking the row directly does see it.
 */
const outstandingRequiredStep = (
    route: TargetRoute | null,
    answers: SetupAnswerFacts,
    answeredNow: SetupStep,
): SetupStep | null => {
    for (const step of requiredSetupSteps(route)) {
        const proves = PROVABLE_STEP_ANSWERS[step];

        if (step !== answeredNow && proves !== undefined && !proves(answers, route)) {
            return step;
        }
    }

    return null;
};

export interface SetupStateTransition {
    setupStatus: SetupStatus;
    setupStep: SetupStep;
    targetRoute: TargetRoute | null;
}

const stepAfter = (
    step: SetupStep,
    order: readonly SetupStep[],
    fallback: SetupStep | null,
): SetupStep => {
    const index = order.indexOf(step);

    if (index < 0) {
        // A step this route does not include — an activity answer saved after the
        // user switched to the manual route. It is not a stop here, so it moves
        // nothing.
        return fallback ?? order[0];
    }

    return index + 1 < order.length ? order[index + 1] : order[order.length - 1];
};

/**
 * Whether a saved step is the stop the user is actually on, and may therefore
 * move the resume marker forward.
 *
 * The stop they are on is the stored marker, or — when the marker names a stop
 * no step save can answer — the first one after it that can. `targets_manual`
 * is exactly that case: it is a stop of the manual route but saves through
 * `PUT /meal-planning/targets` rather than as a step, so both the targets save
 * itself and the following `diet` save count as progress from it. Without that,
 * the manual route would stall at the target screen forever.
 *
 * A marker the active route does not contain answers true: that is a route
 * switch (a user who reached `activity` on the estimated route and then
 * answered the body step with Skip), where the marker no longer means anything
 * and the step just answered is by construction one the new route includes.
 *
 * Everything else answers false — an edit of an earlier answer, and a jump
 * ahead to a later screen — which is what keeps progress sequential.
 */
const isCurrentStop = (
    marker: SetupStep | null,
    step: SetupStep,
    order: readonly SetupStep[],
): boolean => {
    if (marker === null) {
        return step === order[0];
    }

    const index = order.indexOf(marker);

    if (index < 0 || step === marker) {
        return true;
    }

    // The first stop from the marker onwards that a step save can answer. Every
    // route order ends with `review`, which is one, so the scan finds a stop
    // whenever the marker is in the order at all — and comparing against
    // `undefined` would answer false anyway, which is the right answer for a
    // marker nothing can advance from.
    return step === order.slice(index).find(isPayloadBearingSetupStep);
};

const laterStep = (
    current: SetupStep | null,
    candidate: SetupStep,
    order: readonly SetupStep[],
): SetupStep => {
    if (current === null) {
        return candidate;
    }

    const currentIndex = order.indexOf(current);
    const candidateIndex = order.indexOf(candidate);

    if (currentIndex < 0 || candidateIndex < 0) {
        return candidate;
    }

    return currentIndex > candidateIndex ? current : candidate;
};

/**
 * Where setup stands after a step was saved.
 *
 * MONOTONIC in both outputs, which is half the rule:
 *
 *  * The STATUS never moves backwards. Re-saving the diet step from the plan
 *    settings screen must not send a user who already has a plan back into
 *    onboarding — the transition most likely to be got wrong, and the one whose
 *    consequence is a user with a working week being asked to answer seven
 *    questions again. `completed` is reached by publishing a plan and is
 *    preserved here; nothing in this function awards it.
 *  * The RESUME MARKER never moves backwards either, with ONE exception, below.
 *    Stepping back in the wizard to change a goal leaves the marker where the
 *    user actually reached, so a force-quit resumes at the furthest point
 *    rather than replaying answered screens.
 *
 * PROGRESS IS SEQUENTIAL, which is the other half, and it is what makes
 * `ready_for_review` mean something. The marker advances by exactly one stop,
 * and only when the saved step IS the stop the user is on
 * ({@link isCurrentStop}); any other save — an edit of an earlier answer, or a
 * jump ahead to a later screen — is accepted and STORED but moves the marker
 * nowhere. So the marker can only reach `review` by every stop before it having
 * been saved in order, and promotion can stay the simple "the marker reached
 * the review screen" it reads as below.
 *
 * Without that, one request naming the last step would be enough: a client
 * posting `cooking` first would advance the marker straight to `review` and be
 * declared ready for review with no goal, no body details and no diet on
 * record — a plan generated from a row whose answers were never given. A
 * forward jump is not refused, because the answer it carries is genuine and
 * this module does not discard user values; it simply earns no progress.
 *
 * Promotion follows the route's own step list, so the manual route gets there
 * without ever answering `activity`. A `review` save NEVER promotes — it only
 * persists a start date chosen ON the review screen, so treating it as progress
 * would let an out-of-order request declare setup finished.
 *
 * A PROVABLY MISSING ANSWER OVERRIDES BOTH, and is the one exception to the two
 * monotonic rules above. Sequential progress is a statement about the order
 * screens were answered in, and it is only equivalent to "every required answer
 * is on record" while the set of required answers holds still. A route change
 * moves that set under the user: answering the body step with a measured sex
 * takes a manual-route user onto the estimated route, which requires `activity`
 * — a step the manual route never asks. The marker is then sitting on a stop
 * both routes share, the body save reads as an edit of an earlier answer, and
 * the walk continues to `review` with no activity level ever written. So the
 * row is asked directly ({@link outstandingRequiredStep}): where it proves a
 * required step is unanswered, the marker is pulled BACK to that step and the
 * status cannot be `ready_for_review`. Two consequences worth stating:
 *
 *  * A `completed` user is never regressed by this. They have a plan, their
 *    edits arrive from the plan settings screen rather than the wizard, and
 *    sending them back into onboarding is the failure the status rule exists to
 *    prevent; a `ready_for_review` user, who has no plan yet, is un-readied.
 *  * Where a route switch happens LATE, the pull-back costs the user a walk
 *    back over screens they had already answered, because one marker cannot
 *    record both where they reached and which stops they answered. Every one of
 *    those screens re-opens filled in from the stored row, so it is a
 *    re-confirmation after changing a route-defining answer and not lost work.
 *    The alternative — promoting with a required answer absent — produces a
 *    plan built from a row whose answers were never given.
 */
export const nextSetupState = (
    current: SetupStateSnapshot,
    step: SetupStep,
    targetRoute: TargetRoute | null,
): SetupStateTransition => {
    const route = targetRoute ?? current.targetRoute;
    const order = routeStepOrder(route);
    const advances = isCurrentStop(current.setupStep, step, order);

    const reached =
        step === 'review' || !advances
            ? (current.setupStep ?? order[0])
            : laterStep(current.setupStep, stepAfter(step, order, current.setupStep), order);

    // A marker the route does not contain (index -1) is treated as past
    // everything, so a stale off-route marker left by a route switch is
    // reconciled too rather than surviving as a stop nobody can answer.
    const outstanding = outstandingRequiredStep(route, current.answers, step);
    const reachedIndex = order.indexOf(reached);
    const setupStep =
        outstanding !== null && (reachedIndex < 0 || order.indexOf(outstanding) < reachedIndex)
            ? outstanding
            : reached;

    const candidateStatus: SetupStatus = setupStep === 'review' ? 'ready_for_review' : 'in_progress';
    const setupStatus =
        current.setupStatus === 'completed'
            ? 'completed'
            : outstanding !== null
              ? 'in_progress'
              : STATUS_RANK[candidateStatus] > STATUS_RANK[current.setupStatus]
                ? candidateStatus
                : current.setupStatus;

    return { setupStatus, setupStep, targetRoute: route };
};

/* ---------------------------------------------------------------------------
 * Incompatibility flags
 * ------------------------------------------------------------------------- */

/** A planned meal, reduced to what an incompatibility check reads. */
export interface PlannedMealForFlagging {
    slot: MealTimeSlot;
    recipe: PlanningRecipeVersion;
}

/**
 * Why a planned meal no longer matches the user's saved preferences.
 *
 * The rule itself is NOT implemented here: this delegates to
 * `recipe.logic.ts::evaluatePlanningEligibility` — the same call plan generation
 * and swap candidacy make — and keeps the four reasons that describe a
 * preference conflict, dropping the structural ones (a retired version,
 * estimated nutrition, unreviewed allergen metadata, a slot the recipe does not
 * declare) because those describe a recipe nobody may be served rather than one
 * this user has gone off. Two implementations of "does this meal suit this
 * user" is how one of them starts serving milk to a milk-allergic user, so there
 * is one, and this is a projection of it.
 *
 * Several details may share a code — two milk-bearing ingredients both report
 * under `allergen` — and the detail arrays are copied so a caller cannot mutate
 * the verdict they came from. An empty result means the meal still matches
 * everything the user has saved, and the settings banner and its "Review
 * affected meals" action stay up while ANY meal returns a non-empty one, so
 * resolving one meal never hides the rest.
 *
 * THE ORDER IS STABLE and is the projection's contract, not an accident of the
 * loop: `evaluatePlanningEligibility` reports its reasons in
 * `PlanningEligibilityCode` declaration order, so the four preference codes
 * always come back as `allergen`, `diet`, `dislike`, `cooking_time` —
 * independent of ingredient order, of how many details a code carries, and of
 * the order a row's arrays happen to arrive in. The settings screen renders
 * these in sequence, so an unstable order would reshuffle a user's warnings
 * between two reads of an unchanged plan.
 */
export const evaluateMealAgainstPreferences = (
    meal: PlannedMealForFlagging,
    preferences: PlanningPreferences,
): MealFlag[] => {
    const verdict = evaluatePlanningEligibility(meal.recipe, preferences, meal.slot);
    const flags: MealFlag[] = [];

    for (const reason of verdict.reasons) {
        if (isMemberOf(MEAL_FLAG_CODES, reason.code)) {
            flags.push({ code: reason.code, detail: [...reason.detail] });
        }
    }

    return flags;
};
