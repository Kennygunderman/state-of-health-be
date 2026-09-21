/**
 * Unit tests for the pure preference domain (Rule backend-architecture §11,
 * whose conventions come from the mobile repo: colocated `__tests__`, the
 * `.test.ts` suffix, `describe` blocks grouped by function and scenario, and
 * edge cases over happy paths).
 *
 * The bugs these are written to catch are the ones with real consequences: a
 * 'none' answer that quietly DROPS a declared allergy; a state transition that
 * strands a user who already has a plan back at question one; a pound read as a
 * kilogram, which is a 2.2x wrong calorie target; a meal-time check that
 * insists the times ascend and so rejects the schedule screen's own defaults; a
 * server-owned field accepted from a client; a concurrent edit where both
 * writers appear to win; and a flag vocabulary that drifted from the one
 * `recipe.logic.ts` emits.
 */

import { isDayKey as mealPlanIsDayKey } from '../mealPlan.logic';
import { isCalendarDayKey as plannedMealLogIsCalendarDayKey } from '../plannedMealLog.logic';
import {
    ALLERGEN_NONE,
    ALLERGEN_VALUES,
    BODY_INPUT_RANGES,
    BodyAnswerFacts,
    BUDGET_AMOUNT_RANGE,
    BUDGET_CURRENCY,
    BUDGET_PER_MEAL_THRESHOLDS,
    DAY_KEY_PATTERN,
    deriveBudgetTier,
    deriveDislikedFoodGroups,
    evaluateMealAgainstPreferences,
    feetAndInchesToCentimeters,
    FOOD_GROUP_VALUES,
    INCHES_TO_CENTIMETERS,
    isBodyAnswerComplete,
    isCalendarDayKey,
    isClockTime,
    isKnownFoodGroup,
    isNoAllergenSelection,
    isPayloadBearingSetupStep,
    MAX_DISLIKED_FOOD_IDS,
    MAX_FOOD_GROUP_LENGTH,
    MAX_REVISION,
    mealsPerDayForSchedule,
    NAMED_ALLERGENS,
    nextSetupState,
    NO_PREFERENCES_REVISION,
    normalizeTimeZone,
    normalizeToMetric,
    ParsedSetupStep,
    parseAllergens,
    parseBudgetAnswer,
    parseDislikedFoodIds,
    parsePreferencesUpdate,
    parsePreferencesUpdateRequest,
    parseSetupStep,
    parseSetupStepRequest,
    readOnlyFieldRefusal,
    PlannedMealForFlagging,
    POUNDS_TO_KILOGRAMS,
    PREFERENCE_FIELD_CODES,
    PreferenceErrorVerdict,
    PreferencesUpdateContext,
    poundsToKilograms,
    reconcileSetupStateForRoute,
    requiredSetupSteps,
    resolveFoodGroup,
    resolveTargetRouteForBodyStep,
    resolveTargetRouteForUpdate,
    routeStepOrder,
    SETUP_STATUSES,
    SETUP_STEPS,
    SetupAnswerFacts,
    SetupStateRow,
    setupStateOf,
    SetupStateSnapshot,
    SetupStepContext,
    TARGET_ROUTES,
    slotsForSchedule,
    STONE_TO_KILOGRAMS,
    stoneToKilograms,
    validateMealTimes,
} from '../preferences.logic';
import {
    PlanningPreferences,
    PlanningRecipeVersion,
    PREFERENCE_FLAG_CODES,
    RecipeIngredientIdentity,
} from '../recipe.logic';
import { InvalidRequestDetail, MealFlagCode, SetupStatus, SetupStep } from '../../types/mealPlanning';
import coveragePlan from '../../../data/meal-planning/coverage-plan.v1.json';

/* ---------------------------------------------------------------------------
 * Helpers
 * ------------------------------------------------------------------------- */

const ZONE = 'America/New_York';

const UUIDS = [
    '3f1c7f8e-6c6b-4f9d-9a2f-8e1d4b5c6a70',
    '7a2d9b31-52f4-4e7a-8b1c-9d0e2f3a4b51',
    'b41d5c62-8e3a-4d1b-9f28-6c7d8e9f0a12',
    'c5e0a713-9f4b-4a2c-8d36-1e2f3a4b5c63',
] as const;

const uuidAt = (index: number): string =>
    `${index.toString(16).padStart(8, '0')}-1111-4222-8333-444444444444`;

/**
 * The shipped controlled `food_group` vocabulary, read from the committed
 * coverage plan through the shape these tests need.
 *
 * The literal fixtures below name four groups; this is the real 123, so the
 * blast-radius rule is checked against the vocabulary the catalog is actually
 * loaded with rather than against a convenient sample of it.
 */
interface CoverageFoodGroup {
    foodGroup: string;
    category: string;
    isCommonDislikeGroup: boolean;
}

const SHIPPED_FOOD_GROUPS: readonly CoverageFoodGroup[] = coveragePlan.foodGroups;

const SHIPPED_GROUP_NAMES: readonly string[] = SHIPPED_FOOD_GROUPS.map((entry) => entry.foodGroup);

/** Every refusal carries details; this is the shorthand the assertions read through. */
interface MaybeRefusal {
    kind: string;
    details?: InvalidRequestDetail[];
}

const detailsOf = (verdict: MaybeRefusal): InvalidRequestDetail[] => verdict.details ?? [];

const codesFor = (verdict: MaybeRefusal, field: string): string[] =>
    detailsOf(verdict)
        .filter((entry) => entry.field === field)
        .map((entry) => entry.code);

const fieldsOf = (verdict: MaybeRefusal): string[] =>
    detailsOf(verdict).map((entry) => entry.field);

const stepContext = (overrides: Partial<SetupStepContext> = {}): SetupStepContext => ({
    currentRevision: null,
    ...overrides,
});

const updateContext = (overrides: Partial<PreferencesUpdateContext> = {}): PreferencesUpdateContext => ({
    currentRevision: 4,
    ...overrides,
});

const okPayload = <T>(verdict: ParsedSetupStep): T => {
    if (verdict.kind !== 'ok') {
        throw new Error(`expected an accepted step, received ${JSON.stringify(verdict)}`);
    }

    return verdict.payload as T;
};

/** A row with nothing answered — what `PROVABLE_STEP_ANSWERS` reads before any save. */
const noAnswers = (overrides: Partial<SetupAnswerFacts> = {}): SetupAnswerFacts => ({
    goal: null,
    activityLevel: null,
    diet: null,
    mealSchedule: null,
    cookingTimeLimitMin: null,
    ...overrides,
});

/** Every provable answer present — a row whose required steps are all on record. */
const allAnswers = (overrides: Partial<SetupAnswerFacts> = {}): SetupAnswerFacts => ({
    goal: 'lose',
    activityLevel: 'lightly_active',
    diet: 'none',
    mealSchedule: 'three',
    cookingTimeLimitMin: 30,
    ...overrides,
});

const snapshot = (overrides: Partial<SetupStateSnapshot> = {}): SetupStateSnapshot => ({
    setupStatus: 'not_started',
    setupStep: null,
    targetRoute: null,
    answers: noAnswers(),
    ...overrides,
});

/**
 * The columns a step's save writes, as the readiness check reads them — the
 * service's write, modelled. `body` is proved by the resolved `targetRoute`
 * rather than by a column here, and `dislikes` is provable by nothing, so
 * neither appears.
 */
const answersAfter = (step: SetupStep, answers: SetupAnswerFacts): SetupAnswerFacts => {
    switch (step) {
        case 'goal':
            return { ...answers, goal: 'lose' };
        case 'activity':
            return { ...answers, activityLevel: 'lightly_active' };
        case 'diet':
            return { ...answers, diet: 'none' };
        case 'schedule':
            return { ...answers, mealSchedule: 'three' };
        case 'cooking':
            return { ...answers, cookingTimeLimitMin: 30 };
        default:
            return answers;
    }
};

/**
 * The answers a row sitting on a marker must already hold: every required step
 * of the route that comes before it, answered. `body` is proved by the route
 * rather than by a column, and `dislikes` by nothing, so neither contributes.
 *
 * A marker the route does not contain is stale — an `activity` marker left
 * behind by a switch to the manual route — and is treated as past every stop,
 * because the alternative would leave the readiness check pulling the marker
 * somewhere the assertion is not about.
 */
const answersReaching = (
    setupStep: SetupStep,
    route: 'estimated' | 'manual' | null,
): SetupAnswerFacts => {
    const order = routeStepOrder(route);
    const markerIndex = order.indexOf(setupStep);
    const limit = markerIndex < 0 ? order.length : markerIndex;

    return requiredSetupSteps(route)
        .filter((step) => order.indexOf(step) < limit)
        .reduce<SetupAnswerFacts>((answers, step) => answersAfter(step, answers), noAnswers());
};

/**
 * A row that legitimately REACHED a screen: the marker, the route, and the
 * answers such a row must hold.
 *
 * A late marker over an all-null row describes a state no sequence of saves can
 * produce, and the readiness check rightly pulls that marker back to the first
 * missing answer — so a fixture meaning "this user is on the schedule screen"
 * has to say what they have already answered to get there.
 */
const reached = (
    setupStatus: SetupStatus,
    setupStep: SetupStep,
    route: 'estimated' | 'manual' | null,
    overrides: Partial<SetupStateSnapshot> = {},
): SetupStateSnapshot => ({
    setupStatus,
    setupStep,
    targetRoute: route,
    answers: answersReaching(setupStep, route),
    ...overrides,
});

/** One Continue press: the transition, plus the answer the save just stored. */
const saveStepState = (
    state: SetupStateSnapshot,
    step: SetupStep,
    route: 'estimated' | 'manual' | null,
): SetupStateSnapshot => {
    const next = nextSetupState(state, step, route);

    return {
        setupStatus: next.setupStatus,
        setupStep: next.setupStep,
        targetRoute: next.targetRoute,
        answers: answersAfter(step, state.answers),
    };
};

/**
 * Walks a whole route through `nextSetupState`, as the wizard's Continue presses
 * would. A resolved route is passed only for the body step, which is the only
 * save that resolves one in production; every other save carries null and the
 * stored route stands.
 */
const walkRoute = (
    steps: readonly SetupStep[],
    route: 'estimated' | 'manual' | null,
    from: SetupStateSnapshot = snapshot(),
): SetupStateSnapshot =>
    steps.reduce<SetupStateSnapshot>(
        (state, step) => saveStepState(state, step, step === 'body' ? route : null),
        from,
    );

const ingredient = (overrides: Partial<RecipeIngredientIdentity> = {}): RecipeIngredientIdentity => ({
    catalog_food_id: UUIDS[0],
    snapshot_name: 'Brown rice, cooked',
    snapshot_provenance: 'source_backed',
    snapshot_allergen_tags: [],
    snapshot_diet_tags: ['vegan', 'vegetarian'],
    is_optional: false,
    food_group: 'grain',
    allergen_status: 'known',
    ...overrides,
});

const plannableRecipe = (overrides: Partial<PlanningRecipeVersion> = {}): PlanningRecipeVersion => ({
    status: 'current',
    nutrition_provenance: 'source_backed',
    allergen_status: 'known',
    total_minutes: 20,
    meal_slots: ['lunch', 'dinner'],
    ingredients: [ingredient()],
    ...overrides,
});

const planningPreferences = (overrides: Partial<PlanningPreferences> = {}): PlanningPreferences => ({
    diet: null,
    allergens: [],
    disliked_food_ids: [],
    disliked_food_groups: [],
    cooking_time_limit_min: null,
    ...overrides,
});

const plannedMeal = (recipe: PlanningRecipeVersion): PlannedMealForFlagging => ({
    slot: 'lunch',
    recipe,
});

const flagCodes = (flags: { code: MealFlagCode }[]): MealFlagCode[] => flags.map((flag) => flag.code);

/* ---------------------------------------------------------------------------
 * Calendar and clock primitives
 * ------------------------------------------------------------------------- */

/**
 * Day keys that name a day the calendar contains, with the reason each one is
 * here. Every entry must be accepted.
 */
const REAL_DAYS: readonly string[] = [
    '0000-01-01', // year zero exists in the proleptic Gregorian calendar this rule writes out
    '0001-01-01',
    '0004-02-29', // a leap year by the rule, and the input a Date round trip reads as 1904
    '0050-06-15',
    '0099-12-31', // the last day before the band a round-trip implementation could reach
    '0100-01-01', // the first day it could reach: the two answers meet here and nowhere below
    '0999-12-31',
    '1000-01-01',
    '1970-01-01', // the epoch, which is not special to a calendar rule and must not be
    '2000-02-29', // a century divisible by 400
    '2024-02-29',
    '2026-07-11',
    '2026-12-31',
    '9999-12-31',
];

/** Well-shaped keys naming a day that does not exist. Every entry must be refused. */
const IMPOSSIBLE_DAYS: readonly string[] = [
    '1900-02-29', // a century NOT divisible by 400, so not a leap year
    '2023-02-29',
    '2026-02-30',
    '2026-04-31',
    '2026-06-31',
    '2026-09-31',
    '2026-11-31',
    '2026-13-01', // month above the year
    '2026-00-10', // month below it
    '2026-01-00', // day below the month
    '2026-01-32',
    '2026-12-32',
];

/** Strings that are not the day-key shape at all. Every entry must be refused. */
const MALFORMED_SHAPES: readonly string[] = [
    '2026-7-11', // unpadded month
    '2026-07-1', // unpadded day
    '26-07-11', // two-digit year
    '2026/07/11',
    '2026-07-11 ', // trailing space
    ' 2026-07-11', // leading space
    '2026-07-11T00:00:00Z', // an instant, not a day
    '2026-07-111',
    '20260711',
    '11-07-2026', // day first
    '+2026-07-11',
    '-0001-01-01', // the expanded ISO form for a year before zero
    '2026-ab-11',
    '2026-07-1a',
    'today',
    '',
];

/** Values that are not strings. Every entry must be refused rather than coerced. */
const NON_STRINGS: readonly unknown[] = [null, undefined, 20260711, Number.NaN, {}, [], true, new Date()];

describe('DAY_KEY_PATTERN', () => {
    it('matches the day-key shape and nothing around it', () => {
        expect(DAY_KEY_PATTERN.test('2026-07-11')).toBe(true);
        expect(DAY_KEY_PATTERN.test('2026-07-11T00:00:00Z')).toBe(false);
        expect(DAY_KEY_PATTERN.test(' 2026-07-11')).toBe(false);
    });

    it('is anchored at both ends, so it cannot match a fragment of a longer string', () => {
        expect(DAY_KEY_PATTERN.source.startsWith('^')).toBe(true);
        expect(DAY_KEY_PATTERN.source.endsWith('$')).toBe(true);
    });

    it('carries no global flag, so repeated tests cannot depend on lastIndex', () => {
        // A shared exported regex with /g would answer differently on its second
        // call for the same input, which is the kind of fault a single shared
        // declaration is supposed to remove rather than introduce.
        expect(DAY_KEY_PATTERN.global).toBe(false);
        expect(DAY_KEY_PATTERN.test('2026-07-11')).toBe(true);
        expect(DAY_KEY_PATTERN.test('2026-07-11')).toBe(true);
    });

    it('accepts a shape whose day the calendar does not contain', () => {
        // The reason every caller asks the predicate instead: shape and calendar
        // are two different questions.
        expect(DAY_KEY_PATTERN.test('2026-02-30')).toBe(true);
        expect(isCalendarDayKey('2026-02-30')).toBe(false);
    });
});

describe('isCalendarDayKey', () => {
    describe('days the calendar contains', () => {
        it.each(REAL_DAYS)('accepts %s', (value) => {
            expect(isCalendarDayKey(value)).toBe(true);
        });

        it('accepts the last day of every month of a common year', () => {
            const lastDays = [
                '2026-01-31',
                '2026-02-28',
                '2026-03-31',
                '2026-04-30',
                '2026-05-31',
                '2026-06-30',
                '2026-07-31',
                '2026-08-31',
                '2026-09-30',
                '2026-10-31',
                '2026-11-30',
                '2026-12-31',
            ];

            expect(lastDays.filter((day) => !isCalendarDayKey(day))).toEqual([]);
        });
    });

    describe('the leap rule, written out rather than asked of a Date', () => {
        it('accepts 29 February in a year divisible by 4 but not 100', () => {
            expect(isCalendarDayKey('2024-02-29')).toBe(true);
        });

        it('refuses 29 February in a year not divisible by 4', () => {
            expect(isCalendarDayKey('2023-02-29')).toBe(false);
        });

        it('refuses 29 February in a century not divisible by 400', () => {
            expect(isCalendarDayKey('1900-02-29')).toBe(false);
            expect(isCalendarDayKey('2100-02-29')).toBe(false);
        });

        it('accepts 29 February in a century divisible by 400', () => {
            expect(isCalendarDayKey('2000-02-29')).toBe(true);
            expect(isCalendarDayKey('1600-02-29')).toBe(true);
        });

        it('applies the same rule below year 100, where a Date-based check cannot', () => {
            // Date.UTC(4, 1, 29) means 1904, not year 4 — the legacy two-digit-year
            // mapping that makes a round trip refuse this whole band, and the reason
            // the rule is written out here. The rule itself has no such special
            // case: year 4 is divisible by 4 and not by 100, exactly like 2024.
            // The band matters because a `startDate` of `0004-02-29` must be the
            // same day to the review step and to the log route.
            expect(isCalendarDayKey('0004-02-29')).toBe(true);
            expect(isCalendarDayKey('0003-02-29')).toBe(false);
            expect(isCalendarDayKey('0100-02-29')).toBe(false);
            expect(isCalendarDayKey('0000-02-29')).toBe(true);
        });
    });

    describe('days the calendar does not contain', () => {
        it.each(IMPOSSIBLE_DAYS)('refuses %s', (value) => {
            expect(isCalendarDayKey(value)).toBe(false);
        });

        it('refuses a day that a Date would roll forward instead of rejecting', () => {
            // new Date('2026-02-30') is 2 March. A rolled-over date is the failure
            // mode this predicate exists to prevent: it is well shaped, it sorts
            // inside a late-February plan week, and nothing downstream would notice.
            expect(new Date('2026-02-30').toISOString().startsWith('2026-03')).toBe(true);
            expect(isCalendarDayKey('2026-02-30')).toBe(false);
        });
    });

    describe('values that are not day keys', () => {
        it.each(MALFORMED_SHAPES)('refuses the malformed shape %p', (value) => {
            expect(isCalendarDayKey(value)).toBe(false);
        });

        it.each(NON_STRINGS)('refuses the non-string %p', (value) => {
            expect(isCalendarDayKey(value)).toBe(false);
        });

        it('refuses a Date, rather than reading a day key out of it', () => {
            // A caller holding a Date wants localDayKey, which needs a zone. Coercing
            // one here would silently answer in whatever zone the runtime is in.
            expect(isCalendarDayKey(new Date('2026-07-11T00:00:00.000Z'))).toBe(false);
        });
    });

    describe('narrowing', () => {
        it('narrows unknown to string for the caller', () => {
            const value: unknown = '2026-07-11';

            if (!isCalendarDayKey(value)) {
                throw new Error('expected the fixture to be a day key');
            }

            // Reached only if the guard narrowed: .slice is not available on unknown.
            expect(value.slice(0, 4)).toBe('2026');
        });
    });
});

/**
 * `mealPlan.logic.ts::isDayKey` and `plannedMealLog.logic.ts::isCalendarDayKey`
 * ARE `preferences.logic.ts::isCalendarDayKey` — the binding this suite imports
 * at the top.
 *
 * Asserted by IDENTITY rather than by comparing answers over a matrix, because
 * identity is the only form that cannot drift: an edit that gives either name
 * its own body again fails here immediately, which is the whole point of one
 * declaration. The matrix is still run once below, on the band where a local
 * `Date` round trip would answer differently from the rule.
 */
describe('the services share this predicate', () => {
    it('mealPlan.logic.isDayKey IS this predicate', () => {
        expect(mealPlanIsDayKey).toBe(isCalendarDayKey);
    });

    it('plannedMealLog.logic.isCalendarDayKey IS this predicate', () => {
        expect(plannedMealLogIsCalendarDayKey).toBe(isCalendarDayKey);
    });

    it.each(['0000-01-01', '0001-01-01', '0004-02-29', '0050-06-15', '0099-12-31'])(
        'answers %s identically everywhere, where a Date round trip would not',
        (value) => {
            const answers = [
                isCalendarDayKey(value),
                mealPlanIsDayKey(value),
                plannedMealLogIsCalendarDayKey(value),
            ];

            expect(new Set(answers).size).toBe(1);
            expect(answers[0]).toBe(true);
        },
    );
});

describe('isClockTime', () => {
    it.each(['00:00', '08:00', '12:30', '15:30', '18:30', '23:59'])('accepts %s', (value) => {
        expect(isClockTime(value)).toBe(true);
    });

    it.each([
        ['24:00', 'midnight spelled as the 24th hour is not a time of day'],
        ['23:60', 'minute 60'],
        ['08:60', 'minute 60 again, because the bound is 59 at every hour and not only at 23'],
        ['9:05', 'the contract declares HH:mm, so the short form is a second spelling'],
        ['8:00', 'the schedule screen\u2019s own default hour, unpadded'],
        ['8:00 AM', 'the 12-hour spelling the screen renders, which is display and not storage'],
        ['08:0', 'an unpadded minute'],
        ['8am', 'a label rather than a time'],
        ['', 'the empty string'],
        ['08:00:00', 'seconds'],
    ])('refuses %s (%s)', (value) => {
        expect(isClockTime(value)).toBe(false);
    });

    it.each([undefined, null, 800])('refuses the non-string %p', (value) => {
        expect(isClockTime(value)).toBe(false);
    });
});

/* ---------------------------------------------------------------------------
 * Time zone
 * ------------------------------------------------------------------------- */

describe('normalizeTimeZone', () => {
    it('accepts an IANA zone name and returns it canonically', () => {
        expect(normalizeTimeZone('Pacific/Auckland')).toBe('Pacific/Auckland');
        expect(normalizeTimeZone(ZONE)).toBe(ZONE);
    });

    it('collapses the aliases a device may report, so an unmoved user does not look moved', () => {
        const utc = normalizeTimeZone('UTC');

        expect(normalizeTimeZone('Etc/UTC')).toBe(utc);
        expect(normalizeTimeZone('etc/utc')).toBe(utc);
        expect(normalizeTimeZone('GMT')).toBe(utc);
    });

    it('trims surrounding whitespace before resolving', () => {
        expect(normalizeTimeZone('  Europe/Berlin  ')).toBe('Europe/Berlin');
    });

    it.each(['Not/AZone', 'America/Atlantis', 'America/Nowhere', 'Mars/Olympus'])(
        'refuses the unknown zone %s through the RangeError rather than a maintained list',
        (name) => {
            // The verdict asserted is the module's own null, not the RangeError:
            // the throw is the detection mechanism, and callers read the null.
            expect(normalizeTimeZone(name)).toBeNull();
        },
    );

    it('returns the same answer for the same name however often it is asked', () => {
        expect(normalizeTimeZone('Pacific/Auckland')).toBe(normalizeTimeZone('Pacific/Auckland'));
        expect(normalizeTimeZone('Mars/Olympus')).toBe(normalizeTimeZone('Mars/Olympus'));
    });

    it.each([undefined, null, 0, {}, '', '   '])('refuses %p', (value) => {
        expect(normalizeTimeZone(value)).toBeNull();
    });

    it('rethrows an engine fault instead of reporting it as an invalid zone', () => {
        // Only a RangeError means "unknown zone". Anything else is a fault in the
        // runtime, and swallowing it as null would tell the user their own valid
        // zone was rejected while hiding the real failure. Simplifying the catch
        // to `return null` would pass every test above and break exactly this.
        const realDateTimeFormat = Intl.DateTimeFormat;

        try {
            (Intl as { DateTimeFormat: unknown }).DateTimeFormat = () => {
                throw new TypeError('ICU data unavailable');
            };

            expect(() => normalizeTimeZone('Europe/Berlin')).toThrow(TypeError);
        } finally {
            (Intl as { DateTimeFormat: unknown }).DateTimeFormat = realDateTimeFormat;
        }

        expect(normalizeTimeZone('Europe/Berlin')).toBe('Europe/Berlin');
    });
});

/* ---------------------------------------------------------------------------
 * Measurements
 * ------------------------------------------------------------------------- */

describe('unit conversion', () => {
    it('uses the exact international factors', () => {
        expect(POUNDS_TO_KILOGRAMS).toBe(0.45359237);
        expect(INCHES_TO_CENTIMETERS).toBe(2.54);
        expect(STONE_TO_KILOGRAMS).toBe(6.35029318);
    });

    it('converts 182.2 lb to kilograms and back within tolerance', () => {
        const kilograms = poundsToKilograms(182.2);

        expect(kilograms).toBeCloseTo(82.6445, 4);
        expect(kilograms / POUNDS_TO_KILOGRAMS).toBeCloseTo(182.2, 10);
    });

    it('converts 5 ft 10 in to 177.8 cm', () => {
        expect(feetAndInchesToCentimeters(5, 10)).toBeCloseTo(177.8, 10);
    });

    it('converts stone to kilograms', () => {
        expect(stoneToKilograms(12)).toBeCloseTo(76.2035, 4);
        expect(stoneToKilograms(1)).toBeCloseTo(6.35029318, 8);
    });

    it('does not round: a converted weight keeps its precision for the estimate to round once', () => {
        expect(poundsToKilograms(182.2)).not.toBe(82.6);
        expect(Number.isInteger(poundsToKilograms(182.2))).toBe(false);
    });
});

describe('normalizeToMetric', () => {
    const measured = (overrides: Partial<{ age: unknown; heightCm: unknown; weightKg: unknown }> = {}) =>
        normalizeToMetric({
            age: 'age' in overrides ? overrides.age : 34,
            height: { unit: 'cm', centimeters: 'heightCm' in overrides ? overrides.heightCm : 177.8 },
            weight: { unit: 'kg', kilograms: 'weightKg' in overrides ? overrides.weightKg : 82.6 },
        });

    it('accepts metric values inside the envelope', () => {
        const verdict = measured();

        expect(verdict).toEqual({ kind: 'ok', measurements: { age: 34, heightCm: 177.8, weightKg: 82.6 } });
    });

    it('converts a foot-and-inch height through the same envelope', () => {
        const verdict = normalizeToMetric({
            age: 34,
            height: { unit: 'ft_in', feet: 5, inches: 10 },
            weight: { unit: 'lb', pounds: 182.2 },
        });

        expect(verdict.kind).toBe('ok');

        if (verdict.kind === 'ok') {
            expect(verdict.measurements.heightCm).toBeCloseTo(177.8, 10);
            expect(verdict.measurements.weightKg).toBeCloseTo(82.6445, 4);
        }
    });

    it('accepts a stone weight, which exists only to read a stone display preference', () => {
        const verdict = normalizeToMetric({
            age: 40,
            height: { unit: 'cm', centimeters: 170 },
            weight: { unit: 'st', stone: 12 },
        });

        expect(verdict.kind).toBe('ok');

        if (verdict.kind === 'ok') {
            expect(verdict.measurements.weightKg).toBeCloseTo(76.2035, 4);
        }
    });

    describe('age boundaries', () => {
        it.each([
            [17, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
            [101, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
        ])('refuses %s', (age, code) => {
            expect(codesFor(measured({ age }), 'age')).toEqual([code]);
        });

        it.each([18, 100])('accepts %s', (age) => {
            expect(measured({ age }).kind).toBe('ok');
        });

        it('refuses a fractional age', () => {
            expect(codesFor(measured({ age: 34.5 }), 'age')).toEqual([
                PREFERENCE_FIELD_CODES.NOT_AN_INTEGER,
            ]);
        });

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            [null, PREFERENCE_FIELD_CODES.REQUIRED],
            ['34', PREFERENCE_FIELD_CODES.INVALID_TYPE],
            [Number.NaN, PREFERENCE_FIELD_CODES.INVALID_TYPE],
        ])('reports %p as %s', (age, code) => {
            expect(codesFor(measured({ age }), 'age')).toEqual([code]);
        });
    });

    describe('height boundaries', () => {
        it.each([
            [119, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
            [251, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
        ])('refuses %s cm', (heightCm, code) => {
            expect(codesFor(measured({ heightCm }), 'heightCm')).toEqual([code]);
        });

        it.each([120, 250])('accepts %s cm', (heightCm) => {
            expect(measured({ heightCm }).kind).toBe('ok');
        });

        it('reports a missing height as required and a non-numeric one as the wrong type', () => {
            expect(codesFor(measured({ heightCm: undefined }), 'heightCm')).toEqual([
                PREFERENCE_FIELD_CODES.REQUIRED,
            ]);
            expect(codesFor(measured({ heightCm: "5'10" }), 'heightCm')).toEqual([
                PREFERENCE_FIELD_CODES.INVALID_TYPE,
            ]);
        });

        it('refuses an unusable foot-and-inch pair', () => {
            const verdict = normalizeToMetric({
                age: 34,
                height: { unit: 'ft_in', feet: 'five', inches: 10 },
                weight: { unit: 'kg', kilograms: 82.6 },
            });

            expect(codesFor(verdict, 'height')).toEqual([PREFERENCE_FIELD_CODES.INVALID_TYPE]);
        });

        it('refuses twelve inches or more, which is arithmetic rather than a height entered', () => {
            const verdict = normalizeToMetric({
                age: 34,
                height: { unit: 'ft_in', feet: 5, inches: 14 },
                weight: { unit: 'kg', kilograms: 82.6 },
            });

            expect(codesFor(verdict, 'height')).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
        });

        it('refuses a converted height that lands outside the envelope', () => {
            const verdict = normalizeToMetric({
                age: 34,
                height: { unit: 'ft_in', feet: 9, inches: 0 },
                weight: { unit: 'kg', kilograms: 82.6 },
            });

            expect(codesFor(verdict, 'heightCm')).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
        });
    });

    describe('weight boundaries', () => {
        it.each([
            [29, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
            [301, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
        ])('refuses %s kg', (weightKg, code) => {
            expect(codesFor(measured({ weightKg }), 'weightKg')).toEqual([code]);
        });

        it.each([30, 300])('accepts %s kg', (weightKg) => {
            expect(measured({ weightKg }).kind).toBe('ok');
        });

        it('refuses a pound figure that only leaves the envelope after conversion', () => {
            const verdict = normalizeToMetric({
                age: 34,
                height: { unit: 'cm', centimeters: 170 },
                weight: { unit: 'lb', pounds: 60 },
            });

            expect(codesFor(verdict, 'weightKg')).toEqual([PREFERENCE_FIELD_CODES.BELOW_MINIMUM]);
        });

        it('reports a missing weight as required and a non-numeric one as the wrong type', () => {
            expect(codesFor(measured({ weightKg: null }), 'weightKg')).toEqual([
                PREFERENCE_FIELD_CODES.REQUIRED,
            ]);
            expect(codesFor(measured({ weightKg: '182.2' }), 'weightKg')).toEqual([
                PREFERENCE_FIELD_CODES.INVALID_TYPE,
            ]);
        });
    });

    it('collects every failure at once, so the screen shows all of its inline messages', () => {
        const verdict = measured({ age: 12, heightCm: 400, weightKg: 5 });

        expect(fieldsOf(verdict).sort()).toEqual(['age', 'heightCm', 'weightKg']);
    });

    it('holds the mandated adult envelope, the same one an estimate refuses to work outside of', () => {
        // The bounds are asserted as literals rather than against another
        // module's constant, so a drift shows up here instead of two modules
        // drifting together and staying equal.
        expect(BODY_INPUT_RANGES).toEqual({
            age: { min: 18, max: 100 },
            heightCm: { min: 120, max: 250 },
            weightKg: { min: 30, max: 300 },
        });
    });
});

/* ---------------------------------------------------------------------------
 * Allergens — the safety rule
 * ------------------------------------------------------------------------- */

describe('parseAllergens', () => {
    it('declares the nine named allergens the diet screen offers, plus none', () => {
        expect(NAMED_ALLERGENS).toEqual([
            'milk',
            'eggs',
            'peanuts',
            'tree_nuts',
            'soy',
            'wheat',
            'fish',
            'shellfish',
            'sesame',
        ]);
        expect(ALLERGEN_VALUES).toEqual([...NAMED_ALLERGENS, ALLERGEN_NONE]);
    });

    it('accepts none on its own', () => {
        expect(parseAllergens(['none'])).toEqual({ kind: 'ok', allergens: ['none'] });
    });

    it('accepts all nine named allergens together', () => {
        const verdict = parseAllergens([...NAMED_ALLERGENS]);

        expect(verdict).toEqual({ kind: 'ok', allergens: [...NAMED_ALLERGENS] });
    });

    it('REFUSES none alongside a named allergen, rather than resolving it', () => {
        const verdict = parseAllergens(['none', 'milk']);

        expect(verdict.kind).toBe('error');
        expect(codesFor(verdict, 'allergens')).toEqual([PREFERENCE_FIELD_CODES.MUTUALLY_EXCLUSIVE]);
    });

    it('refuses the same contradiction in the other order, so neither half can win by position', () => {
        expect(codesFor(parseAllergens(['Milk', 'None']), 'allergens')).toEqual([
            PREFERENCE_FIELD_CODES.MUTUALLY_EXCLUSIVE,
        ]);
    });

    it('normalises spelling so a label still matches the catalog tag', () => {
        expect(parseAllergens(['Tree nuts'])).toEqual({ kind: 'ok', allergens: ['tree_nuts'] });
        expect(parseAllergens(['tree-nuts'])).toEqual({ kind: 'ok', allergens: ['tree_nuts'] });
        expect(parseAllergens(['  SESAME  '])).toEqual({ kind: 'ok', allergens: ['sesame'] });
    });

    it('de-duplicates rather than refusing, because one intent is not in doubt', () => {
        expect(parseAllergens(['Milk', 'milk', 'tree_nuts'])).toEqual({
            kind: 'ok',
            allergens: ['milk', 'tree_nuts'],
        });
    });

    it('stores one selection in one order, whatever order it was chosen in', () => {
        expect(parseAllergens(['sesame', 'milk', 'fish'])).toEqual({
            kind: 'ok',
            allergens: ['milk', 'fish', 'sesame'],
        });
    });

    it('refuses an unknown value instead of skipping it, which would shorten the list silently', () => {
        expect(codesFor(parseAllergens(['milk', 'gluten']), 'allergens[1]')).toEqual([
            PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
        ]);
    });

    it('refuses a non-string member', () => {
        expect(codesFor(parseAllergens(['milk', 7]), 'allergens[1]')).toEqual([
            PREFERENCE_FIELD_CODES.INVALID_TYPE,
        ]);
    });

    it('refuses an empty array: "no allergies" is spelled ["none"], and [] is only a read state', () => {
        expect(codesFor(parseAllergens([]), 'allergens')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
    });

    it.each([undefined, null])('refuses %p as unanswered', (value) => {
        expect(codesFor(parseAllergens(value), 'allergens')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
    });

    it('refuses a non-array', () => {
        expect(codesFor(parseAllergens('milk'), 'allergens')).toEqual([
            PREFERENCE_FIELD_CODES.INVALID_TYPE,
        ]);
    });

    it('bounds the detail array rather than walking a pathological body', () => {
        const verdict = parseAllergens(new Array(500).fill('milk'));

        expect(codesFor(verdict, 'allergens')).toEqual([PREFERENCE_FIELD_CODES.TOO_MANY]);
        expect(detailsOf(verdict)).toHaveLength(1);
    });

    it('reports the field name the caller gives it', () => {
        expect(fieldsOf(parseAllergens([], 'preferences.allergens'))).toEqual(['preferences.allergens']);
    });
});

describe('isNoAllergenSelection', () => {
    it.each([[['none'], true], [['None'], true], [['milk'], false], [[], false], [['none', 'milk'], false]])(
        'reads %p as %p',
        (allergens, expected) => {
            expect(isNoAllergenSelection(allergens as string[])).toBe(expected);
        },
    );
});

/* ---------------------------------------------------------------------------
 * Meal schedule and times
 * ------------------------------------------------------------------------- */

describe('slotsForSchedule', () => {
    it('lists the slots in wire order', () => {
        expect(slotsForSchedule('three')).toEqual(['breakfast', 'lunch', 'dinner']);
        expect(slotsForSchedule('three_plus_snack')).toEqual(['breakfast', 'lunch', 'dinner', 'snack']);
    });
});

describe('validateMealTimes', () => {
    const threeTimes = [
        { slot: 'breakfast', time: '08:00' },
        { slot: 'lunch', time: '12:30' },
        { slot: 'dinner', time: '18:30' },
    ];

    it('accepts one time per slot of a three-meal schedule', () => {
        expect(validateMealTimes('three', threeTimes)).toEqual({ kind: 'ok', mealTimes: threeTimes });
    });

    it('accepts four times for a schedule with a snack', () => {
        const withSnack = [...threeTimes, { slot: 'snack', time: '15:30' }];

        expect(validateMealTimes('three_plus_snack', withSnack)).toEqual({
            kind: 'ok',
            mealTimes: withSnack,
        });
    });

    // Storage does not require sorted times: the plan day sorts its meals by time
    // at render, so the snack's 15:30 default lands between lunch and dinner on
    // screen while the payload keeps the wire order breakfast, lunch, dinner,
    // snack. A check that insisted the times ascend would reject the schedule
    // screen's own defaults.
    it('ACCEPTS a snack at 15:30 sitting between lunch and dinner — the screen\u2019s own default', () => {
        const verdict = validateMealTimes('three_plus_snack', [
            { slot: 'breakfast', time: '08:00' },
            { slot: 'lunch', time: '12:30' },
            { slot: 'dinner', time: '18:30' },
            { slot: 'snack', time: '15:30' },
        ]);

        expect(verdict.kind).toBe('ok');
    });

    it('imposes no ordering at all: an entirely descending set is still valid', () => {
        const verdict = validateMealTimes('three', [
            { slot: 'breakfast', time: '20:00' },
            { slot: 'lunch', time: '11:00' },
            { slot: 'dinner', time: '06:00' },
        ]);

        expect(verdict.kind).toBe('ok');
    });

    it('refuses three times for a four-slot schedule', () => {
        expect(codesFor(validateMealTimes('three_plus_snack', threeTimes), 'mealTimes')).toEqual([
            PREFERENCE_FIELD_CODES.SLOT_MISMATCH,
        ]);
    });

    it('refuses four times for a three-slot schedule', () => {
        const verdict = validateMealTimes('three', [...threeTimes, { slot: 'snack', time: '15:30' }]);

        expect(codesFor(verdict, 'mealTimes')).toEqual([PREFERENCE_FIELD_CODES.SLOT_MISMATCH]);
    });

    it('refuses a repeated slot, which would leave one meal of the day with no time', () => {
        const verdict = validateMealTimes('three', [
            { slot: 'breakfast', time: '08:00' },
            { slot: 'breakfast', time: '09:00' },
            { slot: 'dinner', time: '18:30' },
        ]);

        expect(codesFor(verdict, 'mealTimes[1].slot')).toEqual([PREFERENCE_FIELD_CODES.SLOT_MISMATCH]);
        expect(fieldsOf(verdict)).toEqual(['mealTimes[1].slot']);
    });

    it('refuses a missing slot even when the count is right', () => {
        const verdict = validateMealTimes('three', [
            { slot: 'breakfast', time: '08:00' },
            { slot: 'snack', time: '15:30' },
            { slot: 'dinner', time: '18:30' },
        ]);

        expect(codesFor(verdict, 'mealTimes[1].slot')).toEqual([PREFERENCE_FIELD_CODES.SLOT_MISMATCH]);
    });

    it('refuses entries that are out of wire order', () => {
        const verdict = validateMealTimes('three', [
            { slot: 'lunch', time: '12:30' },
            { slot: 'breakfast', time: '08:00' },
            { slot: 'dinner', time: '18:30' },
        ]);

        expect(fieldsOf(verdict)).toEqual(['mealTimes[0].slot', 'mealTimes[1].slot']);
    });

    it.each(['24:00', '9:05', '', 'noon'])('refuses the malformed time %p', (time) => {
        const verdict = validateMealTimes('three', [
            { slot: 'breakfast', time },
            { slot: 'lunch', time: '12:30' },
            { slot: 'dinner', time: '18:30' },
        ]);

        expect(codesFor(verdict, 'mealTimes[0].time')).toEqual([PREFERENCE_FIELD_CODES.INVALID_TIME]);
    });

    it('refuses an entry that is not an object', () => {
        const verdict = validateMealTimes('three', ['08:00', threeTimes[1], threeTimes[2]]);

        expect(codesFor(verdict, 'mealTimes[0]')).toEqual([PREFERENCE_FIELD_CODES.INVALID_TYPE]);
    });

    it.each([
        [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
        [null, PREFERENCE_FIELD_CODES.REQUIRED],
        ['08:00', PREFERENCE_FIELD_CODES.INVALID_TYPE],
    ])('reports %p as %s', (times, code) => {
        expect(codesFor(validateMealTimes('three', times), 'mealTimes')).toEqual([code]);
    });
});

/* ---------------------------------------------------------------------------
 * Budget
 * ------------------------------------------------------------------------- */

describe('mealsPerDayForSchedule', () => {
    it('counts the snack, because it is shopped for', () => {
        expect(mealsPerDayForSchedule('three')).toBe(3);
        expect(mealsPerDayForSchedule('three_plus_snack')).toBe(4);
    });
});

describe('deriveBudgetTier', () => {
    it('puts a per-meal budget under the first threshold in tier 1', () => {
        expect(deriveBudgetTier(62, 3)).toBe(1);
        expect(deriveBudgetTier(21, 3)).toBe(1);
    });

    it('treats a per-meal budget of exactly 3 as tier 2, not tier 1', () => {
        const amount = BUDGET_PER_MEAL_THRESHOLDS.tier1Below * 3 * 7;

        expect(amount).toBe(63);
        expect(deriveBudgetTier(amount, 3)).toBe(2);
    });

    it('treats a per-meal budget of exactly 6 as tier 2, not tier 3', () => {
        const amount = BUDGET_PER_MEAL_THRESHOLDS.tier2Max * 3 * 7;

        expect(amount).toBe(126);
        expect(deriveBudgetTier(amount, 3)).toBe(2);
    });

    it('puts anything above the second threshold in tier 3', () => {
        expect(deriveBudgetTier(127, 3)).toBe(3);
        expect(deriveBudgetTier(1000, 3)).toBe(3);
    });

    it('divides by the schedule it is given, snack included', () => {
        expect(deriveBudgetTier(84, 4)).toBe(2);
        expect(deriveBudgetTier(83, 4)).toBe(1);
    });

    it('applies BOTH thresholds through the four-meal divisor, not only the first', () => {
        // 28 meals a week rather than 21, so the same tier boundaries land on
        // different weekly amounts: hard-coding 21 meals would put a 168-dollar
        // four-meal week in tier 3 and penalise a budget that is in fact ample.
        expect(deriveBudgetTier(BUDGET_PER_MEAL_THRESHOLDS.tier2Max * 4 * 7, 4)).toBe(2);
        expect(deriveBudgetTier(BUDGET_PER_MEAL_THRESHOLDS.tier2Max * 4 * 7 + 1, 4)).toBe(3);
    });

    it('answers tier 3 — no penalty — for "no budget preference"', () => {
        expect(deriveBudgetTier(null, 3)).toBe(3);
        expect(deriveBudgetTier(null, 4)).toBe(3);
    });

    it.each([0, -3, Number.NaN, Number.POSITIVE_INFINITY])(
        'answers tier 3 rather than penalising a week from the uncomputable mealsPerDay %p',
        (mealsPerDay) => {
            expect(deriveBudgetTier(63, mealsPerDay)).toBe(3);
        },
    );

    it('answers tier 3 for a non-finite amount', () => {
        expect(deriveBudgetTier(Number.NaN, 3)).toBe(3);
    });
});

describe('parseBudgetAnswer', () => {
    const usd = (amount: number) => ({ amount, currency: 'USD' });

    it('accepts an amount when no preference is not claimed', () => {
        expect(parseBudgetAnswer(usd(120), false)).toEqual({
            kind: 'ok',
            answer: { budget: { amount: 120, currency: BUDGET_CURRENCY }, noBudgetPreference: false },
        });
    });

    it('accepts "no budget preference" with no amount', () => {
        expect(parseBudgetAnswer(undefined, true)).toEqual({
            kind: 'ok',
            answer: { budget: null, noBudgetPreference: true },
        });
        expect(parseBudgetAnswer(null, true)).toEqual({
            kind: 'ok',
            answer: { budget: null, noBudgetPreference: true },
        });
    });

    it('refuses "no budget preference" WITH an amount, which the screen cannot produce', () => {
        expect(codesFor(parseBudgetAnswer(usd(120), true), 'budget')).toEqual([
            PREFERENCE_FIELD_CODES.NOT_ALLOWED,
        ]);
    });

    it('refuses neither half being answered', () => {
        expect(codesFor(parseBudgetAnswer(undefined, false), 'budget')).toEqual([
            PREFERENCE_FIELD_CODES.REQUIRED,
        ]);
    });

    it.each([
        [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
        [null, PREFERENCE_FIELD_CODES.REQUIRED],
        ['false', PREFERENCE_FIELD_CODES.INVALID_TYPE],
        [0, PREFERENCE_FIELD_CODES.INVALID_TYPE],
    ])('reports noBudgetPreference %p as %s', (value, code) => {
        expect(codesFor(parseBudgetAnswer(usd(120), value), 'noBudgetPreference')).toEqual([code]);
    });

    describe('amount boundaries', () => {
        it('pins the mandated whole-dollar range, so the constants cannot drift', () => {
            // The bound is the contract's, not the implementation's: asserting
            // it only through BUDGET_AMOUNT_RANGE would let a widened constant
            // keep every boundary case below green.
            expect(BUDGET_AMOUNT_RANGE).toEqual({ min: 1, max: 10_000 });
        });

        it.each([
            [0, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
            [BUDGET_AMOUNT_RANGE.max + 1, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
            [10_001, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
            [50.5, PREFERENCE_FIELD_CODES.NOT_AN_INTEGER],
            ['120', PREFERENCE_FIELD_CODES.INVALID_TYPE],
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
        ])('reports the amount %p as %s', (amount, code) => {
            expect(codesFor(parseBudgetAnswer({ amount, currency: 'USD' }, false), 'budget.amount')).toEqual(
                [code],
            );
        });

        it.each([1, 10_000, BUDGET_AMOUNT_RANGE.max])('accepts the amount %s', (amount) => {
            expect(parseBudgetAnswer(usd(amount), false).kind).toBe('ok');
        });
    });

    describe('currency', () => {
        it('pins the only accepted spelling, which the wire contract declares exactly', () => {
            expect(BUDGET_CURRENCY).toBe('USD');
        });

        it('accepts the supported currency and stores it unchanged', () => {
            const verdict = parseBudgetAnswer({ amount: 120, currency: 'USD' }, false);

            expect(verdict.kind).toBe('ok');

            if (verdict.kind === 'ok') {
                expect(verdict.answer.budget?.currency).toBe(BUDGET_CURRENCY);
            }
        });

        it('refuses a currency this version does not support rather than converting it', () => {
            expect(
                codesFor(parseBudgetAnswer({ amount: 120, currency: 'EUR' }, false), 'budget.currency'),
            ).toEqual([PREFERENCE_FIELD_CODES.UNSUPPORTED_CURRENCY]);
        });

        it.each([' usd ', 'usd', 'Usd', 'USD ', ' USD'])(
            'refuses %p rather than normalising it, because the contract declares one spelling',
            (currency) => {
                expect(codesFor(parseBudgetAnswer({ amount: 120, currency }, false), 'budget.currency')).toEqual(
                    [PREFERENCE_FIELD_CODES.UNSUPPORTED_CURRENCY],
                );
            },
        );

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            [7, PREFERENCE_FIELD_CODES.INVALID_TYPE],
        ])('reports the currency %p as %s', (currency, code) => {
            expect(codesFor(parseBudgetAnswer({ amount: 120, currency }, false), 'budget.currency')).toEqual([
                code,
            ]);
        });
    });

    it('refuses a budget that is not an object', () => {
        expect(codesFor(parseBudgetAnswer(120, false), 'budget')).toEqual([
            PREFERENCE_FIELD_CODES.INVALID_TYPE,
        ]);
    });

    it('reports both halves of a doubly invalid budget at once', () => {
        const verdict = parseBudgetAnswer({ amount: 0, currency: 'EUR' }, false);

        expect(fieldsOf(verdict)).toEqual(['budget.amount', 'budget.currency']);
    });
});

/* ---------------------------------------------------------------------------
 * Disliked foods
 * ------------------------------------------------------------------------- */

describe('parseDislikedFoodIds', () => {
    it('pins the mandated ceiling, so the constant cannot drift under the cases below', () => {
        expect(MAX_DISLIKED_FOOD_IDS).toBe(100);
    });

    it('accepts an empty selection: the food preferences screen is optional', () => {
        expect(parseDislikedFoodIds([])).toEqual({ kind: 'ok', dislikedFoodIds: [] });
    });

    it('accepts exactly 100 distinct ids and refuses 101, at the literal bound', () => {
        const hundred = Array.from({ length: 100 }, (_, index) => uuidAt(index));

        expect(parseDislikedFoodIds(hundred).kind).toBe('ok');
        expect(codesFor(parseDislikedFoodIds([...hundred, uuidAt(100)]), 'dislikedFoodIds')).toEqual([
            PREFERENCE_FIELD_CODES.TOO_MANY,
        ]);
    });

    it(`accepts ${MAX_DISLIKED_FOOD_IDS} distinct ids`, () => {
        const ids = Array.from({ length: MAX_DISLIKED_FOOD_IDS }, (_, index) => uuidAt(index));

        expect(parseDislikedFoodIds(ids)).toEqual({ kind: 'ok', dislikedFoodIds: ids });
    });

    it(`refuses ${MAX_DISLIKED_FOOD_IDS + 1} distinct ids with one bounded detail`, () => {
        const ids = Array.from({ length: MAX_DISLIKED_FOOD_IDS + 1 }, (_, index) => uuidAt(index));
        const verdict = parseDislikedFoodIds(ids);

        expect(codesFor(verdict, 'dislikedFoodIds')).toEqual([PREFERENCE_FIELD_CODES.TOO_MANY]);
        expect(detailsOf(verdict)).toHaveLength(1);
    });

    it('counts the limit after de-duplication, because it bounds the exclusion set', () => {
        const ids = Array.from({ length: MAX_DISLIKED_FOOD_IDS }, (_, index) => uuidAt(index));
        const verdict = parseDislikedFoodIds([...ids, ids[0], ids[1]]);

        expect(verdict).toEqual({ kind: 'ok', dislikedFoodIds: ids });
    });

    it('keeps selection order when de-duplicating', () => {
        expect(parseDislikedFoodIds([UUIDS[1], UUIDS[0], UUIDS[1]])).toEqual({
            kind: 'ok',
            dislikedFoodIds: [UUIDS[1], UUIDS[0]],
        });
    });

    it('refuses a value that is not a v4 UUID', () => {
        expect(codesFor(parseDislikedFoodIds([UUIDS[0], 'mushrooms']), 'dislikedFoodIds[1]')).toEqual([
            PREFERENCE_FIELD_CODES.INVALID_ID,
        ]);
    });

    it.each([
        [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
        [null, PREFERENCE_FIELD_CODES.REQUIRED],
        ['mushrooms', PREFERENCE_FIELD_CODES.INVALID_TYPE],
    ])('reports %p as %s', (value, code) => {
        expect(codesFor(parseDislikedFoodIds(value), 'dislikedFoodIds')).toEqual([code]);
    });
});

describe('deriveDislikedFoodGroups', () => {
    const taxonomyFoods = [
        { id: UUIDS[0], food_group: 'mushroom' },
        { id: UUIDS[1], food_group: 'mushroom' },
        { id: UUIDS[2], food_group: 'olive' },
        { id: UUIDS[3], food_group: null },
    ];

    const knownFoodGroups = ['mushroom', 'olive', 'onion', 'tomato'];

    it('stores the food ids AND the groups they belong to', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0], UUIDS[2]], { foods: taxonomyFoods });

        expect(derivation.foodIds).toEqual([UUIDS[0], UUIDS[2]]);
        expect(derivation.foodGroups).toEqual(['mushroom', 'olive']);
    });

    it('excludes the whole group from one selection, and nothing outside it', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0]], {
            foods: taxonomyFoods,
            knownFoodGroups,
        });

        expect(derivation.foodGroups).toEqual(['mushroom']);
        expect(derivation.foodGroups).not.toContain('olive');
        expect(derivation.foodGroups).not.toContain('onion');
        expect(derivation.foodGroups).not.toContain('tomato');
        expect(derivation.unrecognizedFoodGroups).toEqual([]);
    });

    it('reports one group once when two selected foods share it', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0], UUIDS[1]], { foods: taxonomyFoods });

        expect(derivation.foodIds).toEqual([UUIDS[0], UUIDS[1]]);
        expect(derivation.foodGroups).toEqual(['mushroom']);
    });

    it('de-duplicates the selection', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0], UUIDS[0]], { foods: taxonomyFoods });

        expect(derivation.foodIds).toEqual([UUIDS[0]]);
    });

    it('names a selected id the catalog did not resolve instead of ignoring it', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0], uuidAt(999)], { foods: taxonomyFoods });

        expect(derivation.foodIds).toEqual([UUIDS[0]]);
        expect(derivation.unknownFoodIds).toEqual([uuidAt(999)]);
    });

    it('keeps a food whose row carries no group, excluding the food alone', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[3]], { foods: taxonomyFoods });

        expect(derivation.foodIds).toEqual([UUIDS[3]]);
        expect(derivation.ungroupedFoodIds).toEqual([UUIDS[3]]);
        expect(derivation.foodGroups).toEqual([]);
    });

    it('treats a blank group as no group', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0]], {
            foods: [{ id: UUIDS[0], food_group: '   ' }],
        });

        expect(derivation.ungroupedFoodIds).toEqual([UUIDS[0]]);
        expect(derivation.foodGroups).toEqual([]);
    });

    it('treats a missing food_group property as no group', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0]], { foods: [{ id: UUIDS[0] }] });

        expect(derivation.ungroupedFoodIds).toEqual([UUIDS[0]]);
    });

    it('KEEPS a group outside the vocabulary and reports the drift, rather than under-excluding', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0]], {
            foods: [{ id: UUIDS[0], food_group: 'sea_vegetable' }],
            knownFoodGroups,
        });

        expect(derivation.foodGroups).toEqual(['sea_vegetable']);
        expect(derivation.unrecognizedFoodGroups).toEqual(['sea_vegetable']);
    });

    it('skips the drift check when no vocabulary is supplied', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0]], {
            foods: [{ id: UUIDS[0], food_group: 'sea_vegetable' }],
        });

        expect(derivation.foodGroups).toEqual(['sea_vegetable']);
        expect(derivation.unrecognizedFoodGroups).toEqual([]);
    });

    it('compares group spellings the way the recipe rules do', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0], UUIDS[1]], {
            foods: [
                { id: UUIDS[0], food_group: 'Bell Pepper' },
                { id: UUIDS[1], food_group: 'bell_pepper' },
            ],
            knownFoodGroups: ['bell_pepper'],
        });

        expect(derivation.foodGroups).toHaveLength(1);
        expect(derivation.unrecognizedFoodGroups).toEqual([]);
    });

    it('takes the first assignment when the taxonomy repeats an id', () => {
        const derivation = deriveDislikedFoodGroups([UUIDS[0]], {
            foods: [
                { id: UUIDS[0], food_group: 'mushroom' },
                { id: UUIDS[0], food_group: 'olive' },
            ],
        });

        expect(derivation.foodGroups).toEqual(['mushroom']);
    });

    it('orders the groups so one selection stores one representation', () => {
        const forward = deriveDislikedFoodGroups([UUIDS[0], UUIDS[2]], { foods: taxonomyFoods });
        const reversed = deriveDislikedFoodGroups([UUIDS[2], UUIDS[0]], { foods: taxonomyFoods });

        expect(forward.foodGroups).toEqual(reversed.foodGroups);
    });

    it('returns empty results for an empty selection', () => {
        expect(deriveDislikedFoodGroups([], { foods: taxonomyFoods })).toEqual({
            foodIds: [],
            foodGroups: [],
            unknownFoodIds: [],
            ungroupedFoodIds: [],
            unrecognizedFoodGroups: [],
        });
    });

    describe('against the shipped food-group vocabulary', () => {
        const [COMMON_DISLIKE_GROUP] = SHIPPED_FOOD_GROUPS.filter(
            (entry) => entry.isCommonDislikeGroup,
        );

        it('keeps every declared group distinct under the spelling rule the derivation applies', () => {
            // Asserted THROUGH the function, because the folding it compares by
            // is module-private: one food per declared group must produce one
            // group per food. Two names that folded together — 'tree_nuts' and
            // 'Tree nuts' say — would collapse into a single entry here, and a
            // dislike of one would silently exclude the other.
            const oneFoodPerGroup = SHIPPED_FOOD_GROUPS.map((entry, index) => ({
                id: uuidAt(index),
                food_group: entry.foodGroup,
            }));

            const derivation = deriveDislikedFoodGroups(
                oneFoodPerGroup.map((food) => food.id),
                { foods: oneFoodPerGroup, knownFoodGroups: SHIPPED_GROUP_NAMES },
            );

            expect(SHIPPED_GROUP_NAMES).toHaveLength(coveragePlan.foodGroupCount);
            expect(derivation.foodGroups).toHaveLength(coveragePlan.foodGroupCount);
            expect(derivation.unrecognizedFoodGroups).toEqual([]);
        });

        it('excludes one suggested group and leaves the other 122 untouched', () => {
            const derivation = deriveDislikedFoodGroups([UUIDS[0]], {
                foods: [{ id: UUIDS[0], food_group: COMMON_DISLIKE_GROUP.foodGroup }],
                knownFoodGroups: SHIPPED_GROUP_NAMES,
            });

            expect(SHIPPED_GROUP_NAMES).toContain(COMMON_DISLIKE_GROUP.foodGroup);
            expect(derivation.foodGroups).toEqual([COMMON_DISLIKE_GROUP.foodGroup]);
            expect(derivation.unrecognizedFoodGroups).toEqual([]);
        });

        it('reports a catalog group the shipped plan never declared', () => {
            const derivation = deriveDislikedFoodGroups([UUIDS[0]], {
                foods: [{ id: UUIDS[0], food_group: 'sea_vegetable' }],
                knownFoodGroups: SHIPPED_GROUP_NAMES,
            });

            expect(SHIPPED_GROUP_NAMES).not.toContain('sea_vegetable');
            expect(derivation.foodGroups).toEqual(['sea_vegetable']);
            expect(derivation.unrecognizedFoodGroups).toEqual(['sea_vegetable']);
        });
    });
});

/* ---------------------------------------------------------------------------
 * The food-group vocabulary
 * ------------------------------------------------------------------------- */

describe('FOOD_GROUP_VALUES', () => {
    /**
     * THE PIN. `FOOD_GROUP_VALUES` is a copy, in `src/`, of a vocabulary
     * authored in `data/`, because no runtime module may read `data/`
     * (`rootDir: "./src"`, and the image excludes it). A copy that drifts is
     * worse than no copy: the catalog would load foods carrying a group this
     * endpoint refuses, so a user could not exclude the very group their
     * suggestions offered them. This test is what makes extending the taxonomy
     * a reviewed change to BOTH files.
     *
     * Order is asserted as well as membership, so the two lists stay readable
     * side by side and a reviewer diffing them sees one block move rather than
     * 123 scattered lines.
     */
    it('is the shipped coverage plan, exactly — same terms, same order, same count', () => {
        expect(FOOD_GROUP_VALUES).toEqual(SHIPPED_GROUP_NAMES);
        expect(FOOD_GROUP_VALUES).toHaveLength(coveragePlan.foodGroupCount);
        expect(new Set(FOOD_GROUP_VALUES).size).toBe(coveragePlan.foodGroupCount);
    });

    it('holds no term longer than the per-entry bound, so the bound cannot refuse a real group', () => {
        // The two constants are independent, and the bound is the useless kind
        // of strict if it refuses something the catalog legitimately carries.
        const longest = [...FOOD_GROUP_VALUES].sort((left, right) => right.length - left.length)[0];

        expect(longest.length).toBeLessThanOrEqual(MAX_FOOD_GROUP_LENGTH);
    });
});

describe('isKnownFoodGroup', () => {
    it.each(['mushroom', 'olive', 'blue_cheese', 'nutritional_supplement'])(
        'accepts the shipped term %p',
        (group) => {
            expect(SHIPPED_GROUP_NAMES).toContain(group);
            expect(isKnownFoodGroup(group)).toBe(true);
            expect(resolveFoodGroup(group)).toBe(group);
        },
    );

    it.each([
        ['Blue cheese', 'blue_cheese'],
        ['blue-cheese', 'blue_cheese'],
        ['  Mushroom  ', 'mushroom'],
    ])('reads %p as the catalog term %p, so a display label round-trips', (sent, canonical) => {
        expect(resolveFoodGroup(sent)).toBe(canonical);
        expect(isKnownFoodGroup(sent)).toBe(true);
    });

    it.each([
        'bogus_group_not_in_taxonomy',
        'sea_vegetable',
        'herb',
        '<script>alert(1)</script>',
        "' OR 1=1 --",
        '',
        '   ',
    ])('refuses %p', (group) => {
        expect(isKnownFoodGroup(group)).toBe(false);
        expect(resolveFoodGroup(group)).toBeNull();
    });

    it.each(['mush', 'mushroom_soup', 'olives_and_more', 'pre_olive'])(
        'matches whole terms only, refusing %p',
        (group) => {
            // A prefix or substring match here would let one request exclude a
            // group the user never chose — or, read the other way, let 'mush'
            // silently exclude every mushroom.
            expect(isKnownFoodGroup(group)).toBe(false);
        },
    );
});

/* ---------------------------------------------------------------------------
 * The step parsers
 * ------------------------------------------------------------------------- */

describe('isPayloadBearingSetupStep', () => {
    it.each(['goal', 'body', 'activity', 'diet', 'dislikes', 'schedule', 'cooking', 'review'])(
        'accepts %s',
        (step) => {
            expect(isPayloadBearingSetupStep(step)).toBe(true);
        },
    );

    it('refuses targets_manual, which is a stored resume marker and not a path segment', () => {
        expect(isPayloadBearingSetupStep('targets_manual')).toBe(false);
    });

    it.each(['', 'review ', 'Goal', undefined, null, 7])('refuses %p', (step) => {
        expect(isPayloadBearingSetupStep(step)).toBe(false);
    });
});

describe('parseSetupStep', () => {
    const goalBody = (overrides: Record<string, unknown> = {}) => ({
        timeZone: ZONE,
        goal: 'lose',
        paceLbPerWeek: 1,
        ...overrides,
    });

    /** The revision the row carries once the first `goal` save has created it. */
    const SAVED_REVISION = 3;

    /**
     * A save made after the row exists, which is every step but the first.
     *
     * Only the first `goal` save may arrive with no row and no pinned revision
     * (see the envelope block), so every other block saves through this: the
     * revision is present and exact, which is the real state those steps are
     * saved in and the one their field rules have to hold under.
     */
    const savedContext = (overrides: Partial<SetupStepContext> = {}): SetupStepContext =>
        stepContext({ currentRevision: SAVED_REVISION, ...overrides });

    const saveStep = (
        step: string,
        body: Record<string, unknown>,
        context: SetupStepContext = savedContext(),
    ): ParsedSetupStep => parseSetupStep(step, { expectedRevision: SAVED_REVISION, ...body }, context);

    /** What every payload accepted through {@link saveStep} carries. */
    const savedEnvelope = { timeZone: ZONE, expectedRevision: SAVED_REVISION };

    describe('the step segment and the envelope', () => {
        it('refuses an unknown step', () => {
            expect(codesFor(parseSetupStep('goals', goalBody(), stepContext()), 'step')).toEqual([
                PREFERENCE_FIELD_CODES.UNKNOWN_STEP,
            ]);
        });

        it('refuses targets_manual as a step, so a resume marker cannot be claimed', () => {
            expect(codesFor(parseSetupStep('targets_manual', { timeZone: ZONE }, stepContext()), 'step')).toEqual(
                [PREFERENCE_FIELD_CODES.UNKNOWN_STEP],
            );
        });

        it.each([undefined, null, 'goal', [1]])('refuses the body %p', (body) => {
            expect(codesFor(parseSetupStep('goal', body, stepContext()), 'body')).toEqual([
                PREFERENCE_FIELD_CODES.INVALID_TYPE,
            ]);
        });

        it('requires a time zone, the only basis for the user\u2019s calendar day', () => {
            const verdict = parseSetupStep('goal', goalBody({ timeZone: undefined }), stepContext());

            expect(codesFor(verdict, 'timeZone')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('refuses an unknown time zone', () => {
            const verdict = parseSetupStep('goal', goalBody({ timeZone: 'Not/AZone' }), stepContext());

            expect(codesFor(verdict, 'timeZone')).toEqual([PREFERENCE_FIELD_CODES.INVALID_TIME_ZONE]);
        });

        it('stores the canonical zone rather than the alias the device reported', () => {
            const verdict = parseSetupStep('goal', goalBody({ timeZone: 'Etc/UTC' }), stepContext());

            expect(okPayload<{ timeZone: string }>(verdict).timeZone).toBe(normalizeTimeZone('UTC'));
        });

        it.each(['setupStatus', 'setupStep', 'revision', 'budgetTier', 'hasActivePlan', 'targetRoute'])(
            'refuses the server-owned key %s rather than ignoring it',
            (key) => {
                const verdict = parseSetupStep('goal', goalBody({ [key]: 'completed' }), stepContext());

                expect(codesFor(verdict, key)).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
            },
        );

        it('refuses an unknown key, which is how a misspelled answer is caught', () => {
            // Ignoring it would drop the answer while the save still succeeded,
            // and the screen would read its own saved value back as unanswered.
            const verdict = parseSetupStep(
                'activity',
                { timeZone: ZONE, activityLevl: 'active', expectedRevision: 3 },
                stepContext({ currentRevision: 3 }),
            );

            expect(codesFor(verdict, 'activityLevl')).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
        });

        it('refuses a key that belongs to a DIFFERENT step, so each step is closed to its own', () => {
            const verdict = saveStep('activity', {
                timeZone: ZONE,
                activityLevel: 'active',
                cookingTimeLimitMin: 30,
            });

            expect(codesFor(verdict, 'cookingTimeLimitMin')).toEqual([
                PREFERENCE_FIELD_CODES.READ_ONLY_FIELD,
            ]);
        });

        it.each([
            ['goal', { goal: 'lose', paceLbPerWeek: 1, goalWeightKg: 77 }],
            ['body', { skipped: true }],
            [
                'body',
                {
                    age: 34,
                    heightCm: 177.8,
                    weightKg: 82.6,
                    sexForEstimate: 'female',
                    heightUnitPref: 'cm',
                    weightUnitPref: 'kg',
                },
            ],
            ['activity', { activityLevel: 'active' }],
            ['diet', { diet: 'none', allergens: ['none'] }],
            ['dislikes', { dislikedFoodIds: [] }],
            [
                'schedule',
                {
                    mealSchedule: 'three',
                    mealTimes: [
                        { slot: 'breakfast', time: '08:00' },
                        { slot: 'lunch', time: '12:30' },
                        { slot: 'dinner', time: '18:30' },
                    ],
                },
            ],
            ['cooking', { cookingTimeLimitMin: 30, budget: null, noBudgetPreference: true }],
            ['review', { startDate: '2026-07-05' }],
        ])('accepts every key %s declares, so the closed set is not too narrow', (step, body) => {
            expect(saveStep(step, { timeZone: ZONE, ...body }).kind).toBe('ok');
        });

        it('names every offending key at once, beside the field problems', () => {
            const verdict = parseSetupStep(
                'goal',
                goalBody({ revision: 9, nickname: 'x', goal: 'shrink' }),
                stepContext(),
            );

            expect(fieldsOf(verdict).sort()).toEqual(['goal', 'nickname', 'revision']);
        });

        it('reports every offending field in one refusal', () => {
            const verdict = parseSetupStep(
                'goal',
                { timeZone: 'Not/AZone', goal: 'shrink', paceLbPerWeek: 3 },
                stepContext(),
            );

            expect(fieldsOf(verdict).sort()).toEqual(['goal', 'paceLbPerWeek', 'timeZone']);
        });
    });

    describe('the first write creates the row, and only the goal step may make it', () => {
        it.each(['body', 'activity', 'diet', 'dislikes', 'schedule', 'cooking', 'review'])(
            'refuses %s as the first save, so setup cannot be created from the middle of the flow',
            (step) => {
                const verdict = parseSetupStep(
                    step,
                    { timeZone: ZONE, expectedRevision: NO_PREFERENCES_REVISION },
                    stepContext({ currentRevision: null }),
                );

                expect(codesFor(verdict, 'step')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
            },
        );

        it('refuses a first non-goal save even when its own fields are valid', () => {
            const verdict = parseSetupStep(
                'activity',
                { timeZone: ZONE, activityLevel: 'active', expectedRevision: 0 },
                stepContext({ currentRevision: null }),
            );

            expect(verdict.kind).toBe('error');
            expect(fieldsOf(verdict)).toEqual(['step']);
        });

        it('accepts the goal step as the first save', () => {
            expect(parseSetupStep('goal', goalBody(), stepContext({ currentRevision: null })).kind).toBe(
                'ok',
            );
        });

        it('accepts every other step once the row exists', () => {
            expect(saveStep('activity', { timeZone: ZONE, activityLevel: 'active' }).kind).toBe('ok');
        });

        it('requires a pinned revision from a non-goal step, never treating it as optional', () => {
            // The row exists here, so the omission is a lost race rather than a
            // creation: exactly one of two concurrent editors may win.
            const verdict = parseSetupStep(
                'activity',
                { timeZone: ZONE, activityLevel: 'active' },
                stepContext({ currentRevision: 3 }),
            );

            expect(verdict).toMatchObject({ kind: 'stale_revision', currentRevision: 3 });
        });
    });

    describe('expectedRevision', () => {
        it('accepts its absence for the very first save, when there is no revision to pin', () => {
            const verdict = parseSetupStep('goal', goalBody(), stepContext({ currentRevision: null }));

            expect(verdict.kind).toBe('ok');
            expect(okPayload<Record<string, unknown>>(verdict).expectedRevision).toBeUndefined();
        });

        it('refuses its absence once a row exists, so a client cannot overwrite blind', () => {
            const verdict = parseSetupStep('goal', goalBody(), stepContext({ currentRevision: 3 }));

            expect(verdict).toMatchObject({ kind: 'stale_revision', currentRevision: 3 });
        });

        it('refuses a mismatch, so exactly one of two concurrent editors wins', () => {
            const verdict = parseSetupStep(
                'goal',
                goalBody({ expectedRevision: 2 }),
                stepContext({ currentRevision: 3 }),
            );

            expect(verdict).toMatchObject({ kind: 'stale_revision', currentRevision: 3 });
        });

        it('accepts an exact match', () => {
            const verdict = parseSetupStep(
                'goal',
                goalBody({ expectedRevision: 3 }),
                stepContext({ currentRevision: 3 }),
            );

            expect(okPayload<{ expectedRevision: number }>(verdict).expectedRevision).toBe(3);
        });

        it('treats an absent row and an expected 0 as the same comparison', () => {
            const verdict = parseSetupStep(
                'goal',
                goalBody({ expectedRevision: NO_PREFERENCES_REVISION }),
                stepContext({ currentRevision: null }),
            );

            expect(verdict.kind).toBe('ok');
        });

        it('refuses a non-zero revision pinned against no row', () => {
            const verdict = parseSetupStep(
                'goal',
                goalBody({ expectedRevision: 5 }),
                stepContext({ currentRevision: null }),
            );

            expect(verdict).toMatchObject({ kind: 'stale_revision', currentRevision: 0 });
        });

        it.each([
            ['3', PREFERENCE_FIELD_CODES.INVALID_TYPE],
            [Number.NaN, PREFERENCE_FIELD_CODES.INVALID_TYPE],
            [Number.POSITIVE_INFINITY, PREFERENCE_FIELD_CODES.INVALID_TYPE],
            [3.5, PREFERENCE_FIELD_CODES.NOT_AN_INTEGER],
            [-1, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
            // Whole numbers that no revision column can hold, and that
            // JavaScript cannot compare exactly. Classifying them as stale
            // would send the client away to re-read and retry a value that can
            // never match anything.
            [1e30, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
            [Number.MAX_SAFE_INTEGER, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
            [Number.MAX_SAFE_INTEGER + 2, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
            [MAX_REVISION + 1, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
        ])('reports the malformed revision %p as a field detail (%s)', (expectedRevision, code) => {
            const verdict = parseSetupStep(
                'goal',
                goalBody({ expectedRevision }),
                stepContext({ currentRevision: 3 }),
            );

            expect(codesFor(verdict, 'expectedRevision')).toEqual([code]);
        });

        it('bounds a revision token by the integer column that stores it', () => {
            expect(MAX_REVISION).toBe(2_147_483_647);
            expect(Number.isSafeInteger(MAX_REVISION)).toBe(true);
        });

        it('still compares a token at the column bound rather than refusing it outright', () => {
            expect(
                parseSetupStep(
                    'goal',
                    goalBody({ expectedRevision: MAX_REVISION }),
                    stepContext({ currentRevision: MAX_REVISION }),
                ).kind,
            ).toBe('ok');
            expect(
                parseSetupStep(
                    'goal',
                    goalBody({ expectedRevision: MAX_REVISION }),
                    stepContext({ currentRevision: 3 }),
                ),
            ).toMatchObject({ kind: 'stale_revision', currentRevision: 3 });
        });

        it('reports field problems before the race, because a malformed body\u2019s revision is moot', () => {
            const verdict = parseSetupStep(
                'goal',
                goalBody({ goal: 'shrink', expectedRevision: 1 }),
                stepContext({ currentRevision: 3 }),
            );

            expect(verdict.kind).toBe('error');
            expect(codesFor(verdict, 'goal')).toEqual([PREFERENCE_FIELD_CODES.UNKNOWN_VALUE]);
        });
    });

    describe('goal', () => {
        it('accepts a direction with its pace', () => {
            const verdict = parseSetupStep('goal', goalBody(), stepContext());

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                timeZone: ZONE,
                goal: 'lose',
                paceLbPerWeek: 1,
                goalWeightKg: null,
            });
        });

        it.each([0.5, 1, 1.5])('accepts the pace %p', (paceLbPerWeek) => {
            expect(parseSetupStep('goal', goalBody({ paceLbPerWeek }), stepContext()).kind).toBe('ok');
        });

        // 0.75 and 1.25 fall BETWEEN the accepted paces, which is what proves the
        // three are a closed set rather than a range with a step this loose.
        it.each([0.75, 1.25, 2, 0, '1'])('refuses the pace %p', (paceLbPerWeek) => {
            expect(codesFor(parseSetupStep('goal', goalBody({ paceLbPerWeek }), stepContext()), 'paceLbPerWeek')).toEqual(
                [PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            );
        });

        it('requires a pace for a direction, so a loss plan cannot be read as maintenance', () => {
            const verdict = parseSetupStep(
                'goal',
                goalBody({ paceLbPerWeek: undefined }),
                stepContext(),
            );

            expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('accepts maintenance with neither a pace nor a goal weight', () => {
            const verdict = parseSetupStep(
                'goal',
                { timeZone: ZONE, goal: 'maintain' },
                stepContext(),
            );

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                timeZone: ZONE,
                goal: 'maintain',
                paceLbPerWeek: null,
                goalWeightKg: null,
            });
        });

        it('refuses a pace on maintenance', () => {
            const verdict = parseSetupStep(
                'goal',
                { timeZone: ZONE, goal: 'maintain', paceLbPerWeek: 1 },
                stepContext(),
            );

            expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it('refuses a goal weight on maintenance', () => {
            const verdict = parseSetupStep(
                'goal',
                { timeZone: ZONE, goal: 'maintain', goalWeightKg: 77 },
                stepContext(),
            );

            expect(codesFor(verdict, 'goalWeightKg')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            [null, PREFERENCE_FIELD_CODES.REQUIRED],
            ['shrink', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            [1, PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
        ])('reports the goal %p as %s', (goal, code) => {
            expect(codesFor(parseSetupStep('goal', goalBody({ goal }), stepContext()), 'goal')).toEqual([code]);
        });

        describe('the goal weight sits on the goal\u2019s side of the current weight', () => {
            const withWeight = stepContext({ currentWeightKg: 82.6 });

            it('accepts a lower target while losing', () => {
                const verdict = parseSetupStep('goal', goalBody({ goalWeightKg: 77 }), withWeight);

                expect(okPayload<{ goalWeightKg: number }>(verdict).goalWeightKg).toBe(77);
            });

            it.each([90, 82.6])('refuses the target %p while losing', (goalWeightKg) => {
                const verdict = parseSetupStep('goal', goalBody({ goalWeightKg }), withWeight);

                expect(codesFor(verdict, 'goalWeightKg')).toEqual([
                    PREFERENCE_FIELD_CODES.NOT_BELOW_CURRENT_WEIGHT,
                ]);
            });

            it('accepts a higher target while gaining', () => {
                const verdict = parseSetupStep(
                    'goal',
                    goalBody({ goal: 'gain', goalWeightKg: 90 }),
                    withWeight,
                );

                expect(verdict.kind).toBe('ok');
            });

            it.each([77, 82.6])('refuses the target %p while gaining', (goalWeightKg) => {
                const verdict = parseSetupStep(
                    'goal',
                    goalBody({ goal: 'gain', goalWeightKg }),
                    withWeight,
                );

                expect(codesFor(verdict, 'goalWeightKg')).toEqual([
                    PREFERENCE_FIELD_CODES.NOT_ABOVE_CURRENT_WEIGHT,
                ]);
            });

            it('skips the comparison when no current weight is known, which is the first entry', () => {
                const verdict = parseSetupStep('goal', goalBody({ goalWeightKg: 90 }), stepContext());

                expect(verdict.kind).toBe('ok');
            });

            it('skips the comparison for an unusable stored weight', () => {
                const verdict = parseSetupStep(
                    'goal',
                    goalBody({ goalWeightKg: 90 }),
                    stepContext({ currentWeightKg: null }),
                );

                expect(verdict.kind).toBe('ok');
            });

            it('holds the goal weight to the body envelope', () => {
                expect(
                    codesFor(parseSetupStep('goal', goalBody({ goalWeightKg: 400 }), stepContext()), 'goalWeightKg'),
                ).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
            });

            it('reports only the goal when the goal itself is unknown, never a side check', () => {
                // There is no direction to judge a target against, so the one
                // mistake produces the one detail that can be acted on.
                const verdict = parseSetupStep(
                    'goal',
                    goalBody({ goal: 'shrink', goalWeightKg: 90 }),
                    withWeight,
                );

                expect(fieldsOf(verdict)).toEqual(['goal']);
            });

            it('reads an explicit null goal weight as no target', () => {
                const verdict = parseSetupStep('goal', goalBody({ goalWeightKg: null }), withWeight);

                expect(okPayload<{ goalWeightKg: number | null }>(verdict).goalWeightKg).toBeNull();
            });
        });
    });

    describe('body', () => {
        const bodyPayload = (overrides: Record<string, unknown> = {}) => ({
            timeZone: ZONE,
            age: 34,
            heightCm: 177.8,
            weightKg: 82.6,
            sexForEstimate: 'female',
            heightUnitPref: 'ft_in',
            weightUnitPref: 'lb',
            ...overrides,
        });

        it('accepts the measured answer', () => {
            const verdict = saveStep('body', bodyPayload());

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                ...savedEnvelope,
                skipped: false,
                age: 34,
                heightCm: 177.8,
                weightKg: 82.6,
                sexForEstimate: 'female',
                heightUnitPref: 'ft_in',
                weightUnitPref: 'lb',
            });
        });

        it('accepts Skip, which carries no measurements at all', () => {
            const verdict = saveStep('body', { timeZone: ZONE, skipped: true });

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({ ...savedEnvelope, skipped: true });
        });

        it('accepts an explicit skipped: false alongside measurements', () => {
            expect(saveStep('body', bodyPayload({ skipped: false })).kind).toBe('ok');
        });

        it.each(['yes', 1, {}])('refuses the non-boolean skipped %p', (skipped) => {
            expect(codesFor(saveStep('body', bodyPayload({ skipped })), 'skipped')).toEqual([
                PREFERENCE_FIELD_CODES.INVALID_TYPE,
            ]);
        });

        describe('Skip is its own closed key set, and not the measured one', () => {
            // The body step is the only step whose payload is a discriminated
            // union, so "the step's own keys" is not one set but two. Skip
            // declares the discriminant and nothing else, and the parser returns
            // the moment it sees it — so measurements sent alongside Skip would
            // be accepted and then dropped, which is a client that filled the
            // form, tapped Skip, and read its own values back as unanswered.
            const MEASURED_KEYS = [
                'age',
                'heightCm',
                'weightKg',
                'sexForEstimate',
                'heightUnitPref',
                'weightUnitPref',
            ] as const;

            it('refuses every measurement sent alongside skipped: true', () => {
                const verdict = saveStep('body', bodyPayload({ skipped: true }));

                expect(verdict.kind).toBe('error');
                expect(fieldsOf(verdict).sort()).toEqual([...MEASURED_KEYS].sort());
                for (const key of MEASURED_KEYS) {
                    expect(codesFor(verdict, key)).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
                }
            });

            it.each(MEASURED_KEYS)('refuses %s on its own alongside skipped: true', (key) => {
                const verdict = saveStep('body', {
                    timeZone: ZONE,
                    skipped: true,
                    [key]: key === 'age' ? 34 : 'whatever',
                });

                expect(codesFor(verdict, key)).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
            });

            it('never silently drops a supplied value: the refusal replaces the acceptance', () => {
                // The precise failure this closes — the verdict used to be
                // accepted and carry only the envelope and the discriminant.
                const verdict = saveStep('body', bodyPayload({ skipped: true }));

                expect(verdict.kind).not.toBe('ok');
            });

            it('still accepts Skip on its own', () => {
                expect(saveStep('body', { timeZone: ZONE, skipped: true }).kind).toBe('ok');
            });

            it.each(MEASURED_KEYS)('still accepts %s under the measured branch', (key) => {
                expect(saveStep('body', bodyPayload()).kind).toBe('ok');
                expect(Object.keys(bodyPayload())).toContain(key);
            });

            it('still accepts the measured branch under an explicit skipped: false', () => {
                expect(saveStep('body', bodyPayload({ skipped: false })).kind).toBe('ok');
            });

            it('reports a malformed discriminant as a type problem, not as an unacceptable key', () => {
                // Only `skipped: true` selects Skip. Anything else selects the
                // measured branch, whose parser owns the discriminant's type.
                const verdict = saveStep('body', bodyPayload({ skipped: 'true' }));

                expect(codesFor(verdict, 'skipped')).toEqual([PREFERENCE_FIELD_CODES.INVALID_TYPE]);
                expect(codesFor(verdict, 'age')).toEqual([]);
            });

            it('keeps refusing server-owned keys under Skip', () => {
                const verdict = saveStep('body', { timeZone: ZONE, skipped: true, setupStatus: 'completed' });

                expect(codesFor(verdict, 'setupStatus')).toEqual([
                    PREFERENCE_FIELD_CODES.READ_ONLY_FIELD,
                ]);
            });
        });

        it('accepts "prefer not to say", which is an answer rather than a gap', () => {
            expect(
                saveStep('body', bodyPayload({ sexForEstimate: 'prefer_not_to_say' })).kind,
            ).toBe('ok');
        });

        it.each([
            ['sexForEstimate', undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['sexForEstimate', 'other', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['heightUnitPref', undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['heightUnitPref', 'inches', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['weightUnitPref', undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['weightUnitPref', 'st', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
        ])('reports %s of %p as %s', (field, value, code) => {
            const verdict = saveStep('body', bodyPayload({ [field]: value }));

            expect(codesFor(verdict, field)).toEqual([code]);
        });

        it('holds the measurements to the envelope', () => {
            const verdict = saveStep('body', bodyPayload({ age: 17, weightKg: 400 }));

            expect(codesFor(verdict, 'age')).toEqual([PREFERENCE_FIELD_CODES.BELOW_MINIMUM]);
            expect(codesFor(verdict, 'weightKg')).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
        });

        it('reports a measurement gap and a missing selection together', () => {
            const verdict = saveStep('body', bodyPayload({ age: undefined, sexForEstimate: undefined }));

            expect(fieldsOf(verdict).sort()).toEqual(['age', 'sexForEstimate']);
        });

        describe('the stored goal weight becomes judgeable here for the first time', () => {
            // The goal screen comes first and may be answered with no current
            // weight to compare against. This step supplies it, so a target
            // accepted there must be re-judged now — otherwise "lose weight,
            // target 77 kg" plus "I weigh 70 kg" is stored as a coherent answer
            // and then drives a plan.
            it('accepts a weight above a losing target', () => {
                const verdict = saveStep(
                    'body',
                    bodyPayload({ weightKg: 82.6 }),
                    savedContext({ currentGoal: 'lose', currentGoalWeightKg: 77 }),
                );

                expect(verdict.kind).toBe('ok');
            });

            it.each([77, 70])('refuses the weight %p against a losing target of 77', (weightKg) => {
                const verdict = saveStep(
                    'body',
                    bodyPayload({ weightKg }),
                    savedContext({ currentGoal: 'lose', currentGoalWeightKg: 77 }),
                );

                expect(codesFor(verdict, 'goalWeightKg')).toEqual([
                    PREFERENCE_FIELD_CODES.NOT_BELOW_CURRENT_WEIGHT,
                ]);
            });

            it('accepts a weight below a gaining target', () => {
                const verdict = saveStep(
                    'body',
                    bodyPayload({ weightKg: 82.6 }),
                    savedContext({ currentGoal: 'gain', currentGoalWeightKg: 90 }),
                );

                expect(verdict.kind).toBe('ok');
            });

            it.each([90, 95])('refuses the weight %p against a gaining target of 90', (weightKg) => {
                const verdict = saveStep(
                    'body',
                    bodyPayload({ weightKg }),
                    savedContext({ currentGoal: 'gain', currentGoalWeightKg: 90 }),
                );

                expect(codesFor(verdict, 'goalWeightKg')).toEqual([
                    PREFERENCE_FIELD_CODES.NOT_ABOVE_CURRENT_WEIGHT,
                ]);
            });

            it('leaves maintenance alone, which has no target to contradict', () => {
                const verdict = saveStep(
                    'body',
                    bodyPayload({ weightKg: 70 }),
                    savedContext({ currentGoal: 'maintain', currentGoalWeightKg: null }),
                );

                expect(verdict.kind).toBe('ok');
            });

            it('judges nothing when the goal step has not been answered yet', () => {
                const verdict = saveStep(
                    'body',
                    bodyPayload({ weightKg: 70 }),
                    savedContext({ currentGoal: null, currentGoalWeightKg: 77 }),
                );

                expect(verdict.kind).toBe('ok');
            });

            it('judges nothing when no target was ever set', () => {
                const verdict = saveStep(
                    'body',
                    bodyPayload({ weightKg: 70 }),
                    savedContext({ currentGoal: 'lose', currentGoalWeightKg: null }),
                );

                expect(verdict.kind).toBe('ok');
            });

            it('re-judges nothing for Skip, which carries no weight at all', () => {
                // Skip takes the manual-target route and supplies no
                // measurements, so nothing became comparable.
                const verdict = saveStep(
                    'body',
                    { timeZone: ZONE, skipped: true },
                    savedContext({ currentGoal: 'lose', currentGoalWeightKg: 77 }),
                );

                expect(verdict.kind).toBe('ok');
            });

            it('reports the conflict beside the step\u2019s own field problems in one refusal', () => {
                const verdict = saveStep(
                    'body',
                    bodyPayload({ weightKg: 70, sexForEstimate: undefined }),
                    savedContext({ currentGoal: 'lose', currentGoalWeightKg: 77 }),
                );

                expect(fieldsOf(verdict).sort()).toEqual(['goalWeightKg', 'sexForEstimate']);
            });

            it('does not re-judge a weight the envelope already refused', () => {
                const verdict = saveStep(
                    'body',
                    bodyPayload({ weightKg: 400 }),
                    savedContext({ currentGoal: 'lose', currentGoalWeightKg: 77 }),
                );

                expect(fieldsOf(verdict)).toEqual(['weightKg']);
            });
        });
    });

    describe('activity', () => {
        it.each(['not_very_active', 'lightly_active', 'active', 'very_active'])(
            'accepts %s',
            (activityLevel) => {
                const verdict = saveStep('activity', { timeZone: ZONE, activityLevel });

                expect(okPayload<Record<string, unknown>>(verdict)).toEqual({ ...savedEnvelope, activityLevel });
            },
        );

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['athlete', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            [3, PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
        ])('reports %p as %s', (activityLevel, code) => {
            const verdict = saveStep('activity', { timeZone: ZONE, activityLevel });

            expect(codesFor(verdict, 'activityLevel')).toEqual([code]);
        });
    });

    describe('diet', () => {
        it.each(['none', 'vegetarian', 'vegan', 'pescatarian'])('accepts the diet %s', (diet) => {
            const verdict = saveStep('diet', { timeZone: ZONE, diet, allergens: ['none'] });

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                ...savedEnvelope,
                diet,
                allergens: ['none'],
            });
        });

        it('carries the normalised allergen selection through', () => {
            const verdict = saveStep('diet', { timeZone: ZONE, diet: 'none', allergens: ['Tree nuts', 'Milk'] });

            expect(okPayload<{ allergens: string[] }>(verdict).allergens).toEqual(['milk', 'tree_nuts']);
        });

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['keto', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
        ])('reports the diet %p as %s', (diet, code) => {
            const verdict = saveStep('diet', { timeZone: ZONE, diet, allergens: ['none'] });

            expect(codesFor(verdict, 'diet')).toEqual([code]);
        });

        it('reports the diet and the allergens together', () => {
            const verdict = saveStep('diet', { timeZone: ZONE, diet: 'keto', allergens: ['none', 'milk'] });

            expect(fieldsOf(verdict).sort()).toEqual(['allergens', 'diet']);
        });
    });

    describe('dislikes', () => {
        it('accepts an empty selection', () => {
            const verdict = saveStep('dislikes', { timeZone: ZONE, dislikedFoodIds: [] });

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                ...savedEnvelope,
                dislikedFoodIds: [],
            });
        });

        it('refuses a malformed id', () => {
            const verdict = saveStep('dislikes', { timeZone: ZONE, dislikedFoodIds: ['mushrooms'] });

            expect(codesFor(verdict, 'dislikedFoodIds[0]')).toEqual([PREFERENCE_FIELD_CODES.INVALID_ID]);
        });
    });

    describe('schedule', () => {
        const times = [
            { slot: 'breakfast', time: '08:00' },
            { slot: 'lunch', time: '12:30' },
            { slot: 'dinner', time: '18:30' },
        ];

        it('accepts three meals with three times', () => {
            const verdict = saveStep('schedule', { timeZone: ZONE, mealSchedule: 'three', mealTimes: times });

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                ...savedEnvelope,
                mealSchedule: 'three',
                mealTimes: times,
            });
        });

        it('accepts a snack schedule with the snack between lunch and dinner', () => {
            const verdict = saveStep(
                'schedule',
                {
                    timeZone: ZONE,
                    mealSchedule: 'three_plus_snack',
                    mealTimes: [...times, { slot: 'snack', time: '15:30' }],
                },
            );

            expect(verdict.kind).toBe('ok');
        });

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['four', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
        ])('reports the schedule %p as %s', (mealSchedule, code) => {
            const verdict = saveStep('schedule', { timeZone: ZONE, mealSchedule, mealTimes: times });

            expect(codesFor(verdict, 'mealSchedule')).toEqual([code]);
        });

        it('refuses a count that does not match the schedule', () => {
            const verdict = saveStep('schedule', { timeZone: ZONE, mealSchedule: 'three_plus_snack', mealTimes: times });

            expect(codesFor(verdict, 'mealTimes')).toEqual([PREFERENCE_FIELD_CODES.SLOT_MISMATCH]);
        });
    });

    describe('cooking', () => {
        it.each([15, 30, 45, 60])('accepts the cooking limit %s', (cookingTimeLimitMin) => {
            const verdict = saveStep('cooking', { timeZone: ZONE, cookingTimeLimitMin, budget: null, noBudgetPreference: true });

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                ...savedEnvelope,
                cookingTimeLimitMin,
                budget: null,
                noBudgetPreference: true,
            });
        });

        it('accepts a weekly amount', () => {
            const verdict = saveStep(
                'cooking',
                {
                    timeZone: ZONE,
                    cookingTimeLimitMin: 30,
                    budget: { amount: 140, currency: 'USD' },
                    noBudgetPreference: false,
                },
            );

            expect(okPayload<{ budget: { amount: number } | null }>(verdict).budget).toEqual({
                amount: 140,
                currency: BUDGET_CURRENCY,
            });
        });

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            [20, PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['30', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
        ])('reports the cooking limit %p as %s', (cookingTimeLimitMin, code) => {
            const verdict = saveStep('cooking', { timeZone: ZONE, cookingTimeLimitMin, budget: null, noBudgetPreference: true });

            expect(codesFor(verdict, 'cookingTimeLimitMin')).toEqual([code]);
        });

        it('reports the cooking limit and the budget together', () => {
            const verdict = saveStep(
                'cooking',
                { timeZone: ZONE, cookingTimeLimitMin: 20, budget: null, noBudgetPreference: false },
            );

            expect(fieldsOf(verdict).sort()).toEqual(['budget', 'cookingTimeLimitMin']);
        });
    });

    describe('review', () => {
        it('accepts a real calendar day', () => {
            const verdict = saveStep('review', { timeZone: ZONE, startDate: '2026-07-05' });

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                ...savedEnvelope,
                startDate: '2026-07-05',
            });
        });

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['2026-02-30', PREFERENCE_FIELD_CODES.INVALID_DATE],
            ['05/07/2026', PREFERENCE_FIELD_CODES.INVALID_DATE],
        ])('reports the start date %p as %s', (startDate, code) => {
            const verdict = saveStep('review', { timeZone: ZONE, startDate });

            expect(codesFor(verdict, 'startDate')).toEqual([code]);
        });

        it.each([
            ['a day long past', '2020-01-01'],
            ['a day years ahead', '2099-12-31'],
        ])('accepts %p, because the WINDOW is not this layer\u2019s question', (_label, startDate) => {
            // The layer boundary, asserted rather than assumed. Whether a real
            // calendar day falls inside `[today, max(today + 30, plan end + 1)]`
            // needs today's date in the user's stored zone AND the user's active
            // plans — a clock reading and a database read, neither of which a
            // pure parser may make. `preferences.service.ts::resolveReviewStartDate`
            // is where those refusals (`below_minimum` / `above_maximum`) come
            // from, and `api/preferences.test.ts` exercises the window end to
            // end. A parser that started guessing at it would be judging against
            // the server's own clock and zone, which is exactly the bug the
            // service is arranged to avoid.
            expect(saveStep('review', { timeZone: ZONE, startDate }).kind).toBe('ok');
        });
    });

    it('labels each accepted payload with its own step', () => {
        const verdict = saveStep('activity', { timeZone: ZONE, activityLevel: 'active' });

        expect(verdict.kind === 'ok' && verdict.step).toBe('activity');
    });
});

/* ---------------------------------------------------------------------------
 * The full save
 * ------------------------------------------------------------------------- */

describe('parsePreferencesUpdate', () => {
    /**
     * The parser with the REQUIRED envelope zone supplied, so each case below
     * states only the keys it is about.
     *
     * `timeZone` is part of a full save's envelope rather than one of its
     * edits, and the endpoint refuses a body without one — the zone's own rules
     * are asserted in `the envelope zone` below, and a case that needs to omit
     * or corrupt it calls `parsePreferencesUpdate` directly. A non-object body
     * is passed through untouched, because there is nothing to spread into.
     */
    const parseUpdate = (
        body: unknown,
        context: PreferencesUpdateContext,
    ): ReturnType<typeof parsePreferencesUpdate> =>
        parsePreferencesUpdate(
            typeof body === 'object' && body !== null && !Array.isArray(body)
                ? { timeZone: ZONE, ...body }
                : body,
            context,
        );

    /**
     * The accepted payload MINUS the envelope zone, which every accepted full
     * save carries and which is asserted here rather than repeated in each
     * case's expected object.
     */
    const payloadOf = (
        verdict: ReturnType<typeof parsePreferencesUpdate>,
        expectedTimeZone: string | null = ZONE,
    ): Record<string, unknown> => {
        if (verdict.kind !== 'ok') {
            throw new Error(`expected an accepted update, received ${JSON.stringify(verdict)}`);
        }

        const { timeZone, ...rest } = verdict.payload as unknown as Record<string, unknown>;

        expect(timeZone).toBe(expectedTimeZone);

        return rest;
    };

    it('accepts a valid partial and echoes the pinned revision', () => {
        const verdict = parseUpdate({ diet: 'vegan', expectedRevision: 4 }, updateContext());

        expect(payloadOf(verdict)).toEqual({ diet: 'vegan', expectedRevision: 4 });
    });

    it.each([undefined, null, 'diet', [1]])('refuses the body %p', (body) => {
        expect(codesFor(parseUpdate(body, updateContext()), 'body')).toEqual([
            PREFERENCE_FIELD_CODES.INVALID_TYPE,
        ]);
    });

    describe('the key set is closed', () => {
        it.each(['setupStatus', 'setupStep', 'revision', 'budgetTier', 'hasActivePlan', 'targetRoute'])(
            'refuses the server-owned key %s rather than ignoring it',
            (key) => {
                const verdict = parseUpdate(
                    { [key]: 'completed', expectedRevision: 4 },
                    updateContext(),
                );

                expect(codesFor(verdict, key)).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
            },
        );

        // 'allergen' and 'activityLevell' are near misses of real keys: the set is
        // CLOSED, so a mistyped key is refused rather than filtered out, and the
        // client learns its edit did not land instead of reading the old value back.
        it.each(['nickname', 'userId', 'allergen', 'activityLevell'])(
            'refuses the unknown key %s',
            (key) => {
                const verdict = parseUpdate(
                    { [key]: 'x', expectedRevision: 4 },
                    updateContext(),
                );

                expect(codesFor(verdict, key)).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
            },
        );

        it('names every offending key at once', () => {
            const verdict = parseUpdate(
                { setupStatus: 'completed', revision: 9, nickname: 'x', expectedRevision: 4 },
                updateContext(),
            );

            expect(fieldsOf(verdict).sort()).toEqual(['nickname', 'revision', 'setupStatus']);
        });

        it('refuses a save that edits nothing, which would bump the revision for no change', () => {
            // `parseUpdate` supplies the required zone, and this context supplies
            // no stored one — so nothing here can be established as a change.
            expect(codesFor(parseUpdate({ expectedRevision: 4 }, updateContext()), 'body')).toEqual([
                PREFERENCE_FIELD_CODES.REQUIRED,
            ]);
        });
    });

    describe('the envelope zone', () => {
        // The zone is REQUIRED on this endpoint (AAP §0.5.1, §0.5.2): the client
        // sends the device's zone on every full save, and the server resolves
        // the "today" its plan-ended, start-date-bound and flag rules read from
        // the value THIS request carried. Accepting an omission as "keep the
        // stored zone" left `today` computed from a zone the user may have left.
        it('refuses a full save that carries no zone at all', () => {
            const verdict = parsePreferencesUpdate({ diet: 'vegan', expectedRevision: 4 }, updateContext());

            expect(codesFor(verdict, 'timeZone')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('refuses an explicit null zone as required rather than as an unknown name', () => {
            const verdict = parsePreferencesUpdate(
                { diet: 'vegan', timeZone: null, expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'timeZone')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('refuses a name this runtime does not know', () => {
            const verdict = parsePreferencesUpdate(
                { diet: 'vegan', timeZone: 'Mars/Phobos', expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'timeZone')).toEqual([PREFERENCE_FIELD_CODES.INVALID_TIME_ZONE]);
        });

        it('canonicalises the accepted zone, so an alias is stored under one name', () => {
            const verdict = parsePreferencesUpdate(
                { diet: 'vegan', timeZone: 'Etc/UTC', expectedRevision: 4 },
                updateContext(),
            );

            expect(payloadOf(verdict, normalizeTimeZone('UTC'))).toEqual({
                diet: 'vegan',
                expectedRevision: 4,
            });
        });

        // WHETHER A ZONE-ONLY BODY EDITS ANYTHING IS THE STORED ZONE'S ANSWER.
        // The zone is a column like any other, and re-sending it on a full save
        // is the only channel the contract gives a client for reconciling a
        // device that has moved (AAP 0.5.2;
        // `mobile/src/screens/PlanSettings/index.util.ts::reconcilePreferencesTimeZone`
        // is the caller). Reading the key as pure envelope refused that save as
        // empty, so the stored calendar could never be refreshed and every date
        // the server derived stayed in a zone the user had left.
        it('accepts a zone-only body whose zone differs from the stored one', () => {
            const verdict = parsePreferencesUpdate(
                { timeZone: 'Europe/Lisbon', expectedRevision: 4 },
                updateContext({ currentTimeZone: ZONE }),
            );

            expect(payloadOf(verdict, normalizeTimeZone('Europe/Lisbon'))).toEqual({
                expectedRevision: 4,
            });
        });

        it('accepts a zone-only body when the row holds no zone at all', () => {
            // A column that predates the contract's requirement: null is the row
            // being empty, which any usable zone changes.
            const verdict = parsePreferencesUpdate(
                { timeZone: ZONE, expectedRevision: 4 },
                updateContext({ currentTimeZone: null }),
            );

            expect(payloadOf(verdict)).toEqual({ expectedRevision: 4 });
        });

        it('refuses a zone-only body whose zone the row already holds', () => {
            // The invariant the acceptance above must not cost: a body that
            // changes nothing would still bump the revision and invalidate every
            // other client's pinned value for no change at all.
            const verdict = parsePreferencesUpdate(
                { timeZone: ZONE, expectedRevision: 4 },
                updateContext({ currentTimeZone: ZONE }),
            );

            expect(codesFor(verdict, 'body')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('compares the CANONICAL zone, so an alias of the stored zone is not an edit', () => {
            // `Etc/UTC` and `UTC` are one calendar under two names. Comparing the
            // raw strings would read the alias as a change and store a revision
            // bump for a zone the row already held.
            const verdict = parsePreferencesUpdate(
                { timeZone: 'Etc/UTC', expectedRevision: 4 },
                updateContext({ currentTimeZone: normalizeTimeZone('UTC') }),
            );

            expect(codesFor(verdict, 'body')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('refuses a zone-only body with no zone as both empty and missing its zone', () => {
            // Nothing to compare and nothing to store: the two refusals travel
            // together, and `body` leads — the order this endpoint has always
            // produced, which a client's field-to-control mapping depends on.
            const verdict = parsePreferencesUpdate({ expectedRevision: 4 }, updateContext({ currentTimeZone: ZONE }));

            expect(fieldsOf(verdict)).toEqual(['body', 'timeZone']);
        });

        it('keeps `body` first when a malformed revision travels with it', () => {
            const verdict = parsePreferencesUpdate(
                { timeZone: ZONE, expectedRevision: '4' },
                updateContext({ currentTimeZone: ZONE }),
            );

            expect(fieldsOf(verdict)).toEqual(['body', 'expectedRevision']);
        });

        it('leaves a zone-only body that names a server-owned key refused for that key alone', () => {
            // The body plainly was not empty, so `body: required` on top of the
            // `read_only_field` detail would be noise about a different problem.
            const verdict = parsePreferencesUpdate(
                { setupStatus: 'completed', timeZone: ZONE, expectedRevision: 4 },
                updateContext({ currentTimeZone: ZONE }),
            );

            expect(fieldsOf(verdict)).toEqual(['setupStatus']);
        });

        it('judges a body that answers something on its answers, whatever the zone does', () => {
            // The zone rule is scoped to bodies that answer NOTHING: an edit of a
            // real preference is an edit whether or not the zone also moved.
            expect(
                payloadOf(
                    parsePreferencesUpdate(
                        { diet: 'vegan', timeZone: ZONE, expectedRevision: 4 },
                        updateContext({ currentTimeZone: ZONE }),
                    ),
                ),
            ).toEqual({ diet: 'vegan', expectedRevision: 4 });
        });

        it('reports a missing zone together with a field problem, in one refusal', () => {
            const verdict = parsePreferencesUpdate({ diet: 'keto', expectedRevision: 4 }, updateContext());

            expect(fieldsOf(verdict).sort()).toEqual(['diet', 'timeZone']);
        });
    });

    describe('expectedRevision', () => {
        it('refuses a mismatch', () => {
            expect(
                parseUpdate({ diet: 'vegan', expectedRevision: 3 }, updateContext()),
            ).toMatchObject({ kind: 'stale_revision', currentRevision: 4 });
        });

        it('refuses its absence, because a full save only ever edits an existing row', () => {
            expect(parseUpdate({ diet: 'vegan' }, updateContext())).toMatchObject({
                kind: 'stale_revision',
                currentRevision: 4,
            });
        });

        it('reports a malformed revision as a field detail, not as a lost race', () => {
            const verdict = parseUpdate({ diet: 'vegan', expectedRevision: '4' }, updateContext());

            expect(codesFor(verdict, 'expectedRevision')).toEqual([PREFERENCE_FIELD_CODES.INVALID_TYPE]);
        });

        it.each([
            ['a token equal to the absent row\u2019s read-back value', NO_PREFERENCES_REVISION],
            ['a pinned non-zero revision', 2],
        ])('refuses a full save against no row at all, given %s', (_label, expectedRevision) => {
            // This endpoint edits; creation belongs to the first `goal` step. A
            // zero here compares equal to what an absent row reads back, so
            // without this rule a full save could materialise setup state that
            // the wizard never produced.
            const verdict = parseUpdate(
                { diet: 'vegan', expectedRevision },
                updateContext({ currentRevision: null }),
            );

            expect(verdict).toMatchObject({
                kind: 'stale_revision',
                currentRevision: NO_PREFERENCES_REVISION,
            });
        });

        it('refuses a full save against no row even with no revision pinned at all', () => {
            expect(
                parseUpdate({ diet: 'vegan' }, updateContext({ currentRevision: null })),
            ).toMatchObject({ kind: 'stale_revision', currentRevision: NO_PREFERENCES_REVISION });
        });

        it('still reports field problems before the missing row, because a field error is fixable', () => {
            const verdict = parseUpdate(
                { diet: 'keto', expectedRevision: NO_PREFERENCES_REVISION },
                updateContext({ currentRevision: null }),
            );

            expect(verdict.kind).toBe('error');
            expect(codesFor(verdict, 'diet')).toEqual([PREFERENCE_FIELD_CODES.UNKNOWN_VALUE]);
        });

        it('reports an unsafe-integer revision as malformed rather than as a lost race', () => {
            const verdict = parseUpdate({ diet: 'vegan', expectedRevision: 1e30 }, updateContext());

            expect(codesFor(verdict, 'expectedRevision')).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
        });
    });

    describe('omitted is not null', () => {
        it('clears a goal weight on an explicit null', () => {
            const verdict = parseUpdate(
                { goalWeightKg: null, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose' }),
            );

            expect(payloadOf(verdict)).toEqual({ goalWeightKg: null, expectedRevision: 4 });
        });

        it('clears a pace on an explicit null once the goal no longer needs one', () => {
            const verdict = parseUpdate(
                { paceLbPerWeek: null, expectedRevision: 4 },
                updateContext({ currentGoal: 'maintain' }),
            );

            expect(payloadOf(verdict)).toEqual({ paceLbPerWeek: null, expectedRevision: 4 });
        });

        it('refuses to clear the pace of a goal that still has a direction', () => {
            // An explicit null is a real edit, so it is judged as one: 'lose'
            // with no pace cannot be estimated from at all.
            const verdict = parseUpdate(
                { paceLbPerWeek: null, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentPaceLbPerWeek: 1 }),
            );

            expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('leaves an omitted key out of the payload entirely', () => {
            const verdict = parseUpdate({ diet: 'vegan', expectedRevision: 4 }, updateContext());

            expect(Object.keys(payloadOf(verdict)).sort()).toEqual(['diet', 'expectedRevision']);
        });
    });

    describe('switching to maintenance', () => {
        it('normalises the pace and goal weight away, so no row holds a maintained pace', () => {
            const verdict = parseUpdate(
                { goal: 'maintain', expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentWeightKg: 82.6 }),
            );

            expect(payloadOf(verdict)).toEqual({
                goal: 'maintain',
                goalWeightKg: null,
                paceLbPerWeek: null,
                expectedRevision: 4,
            });
        });

        it('refuses maintenance sent WITH a pace, a contradiction inside one request', () => {
            const verdict = parseUpdate(
                { goal: 'maintain', paceLbPerWeek: 1, expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it('refuses maintenance sent WITH a goal weight', () => {
            const verdict = parseUpdate(
                { goal: 'maintain', goalWeightKg: 77, expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'goalWeightKg')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it('refuses a pace edited while the STORED goal is maintenance', () => {
            const verdict = parseUpdate(
                { paceLbPerWeek: 1, expectedRevision: 4 },
                updateContext({ currentGoal: 'maintain' }),
            );

            expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it('accepts a pace once the same body moves the goal off maintenance', () => {
            const verdict = parseUpdate(
                { goal: 'lose', paceLbPerWeek: 1.5, expectedRevision: 4 },
                updateContext({ currentGoal: 'maintain' }),
            );

            expect(payloadOf(verdict)).toEqual({ goal: 'lose', paceLbPerWeek: 1.5, expectedRevision: 4 });
        });
    });

    describe('the goal weight is judged against whichever weight ends up in force', () => {
        it('uses the stored weight when the body changes only the target', () => {
            const verdict = parseUpdate(
                { goalWeightKg: 90, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentWeightKg: 82.6 }),
            );

            expect(codesFor(verdict, 'goalWeightKg')).toEqual([
                PREFERENCE_FIELD_CODES.NOT_BELOW_CURRENT_WEIGHT,
            ]);
        });

        it('uses the weight in the same body when it changes too', () => {
            const verdict = parseUpdate(
                { goalWeightKg: 90, weightKg: 95, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentWeightKg: 82.6 }),
            );

            expect(payloadOf(verdict)).toEqual({
                goalWeightKg: 90,
                weightKg: 95,
                expectedRevision: 4,
            });
        });

        it('uses the goal in the same body when it changes too', () => {
            const verdict = parseUpdate(
                { goal: 'gain', goalWeightKg: 90, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentWeightKg: 82.6, currentPaceLbPerWeek: 1 }),
            );

            expect(verdict.kind).toBe('ok');
        });

        it('refuses a target on the wrong side while gaining', () => {
            const verdict = parseUpdate(
                { goalWeightKg: 70, expectedRevision: 4 },
                updateContext({ currentGoal: 'gain', currentWeightKg: 82.6 }),
            );

            expect(codesFor(verdict, 'goalWeightKg')).toEqual([
                PREFERENCE_FIELD_CODES.NOT_ABOVE_CURRENT_WEIGHT,
            ]);
        });

        it('accepts a target it has no weight to judge against rather than inventing one', () => {
            // A user who skipped the body step has no current weight anywhere. The
            // side check has nothing to compare with, so the value is stored as
            // given; refusing it would block an answer the screen allows, and
            // guessing a weight would refuse a legitimate target.
            const verdict = parseUpdate(
                { goalWeightKg: 90, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentWeightKg: null }),
            );

            expect(payloadOf(verdict)).toEqual({ goalWeightKg: 90, expectedRevision: 4 });
        });

        describe('and is re-judged whenever any member of the tuple changes', () => {
            const losing = (overrides: Partial<PreferencesUpdateContext> = {}): PreferencesUpdateContext =>
                updateContext({
                    currentGoal: 'lose',
                    currentPaceLbPerWeek: 1,
                    currentWeightKg: 82.6,
                    currentGoalWeightKg: 77,
                    ...overrides,
                });

            it('refuses a new current weight that the STORED target no longer sits below', () => {
                // The body never mentions the target, which is exactly why this
                // has to be checked here: 77 kg was a valid losing target at
                // 82.6 kg and is not one at 70 kg.
                const verdict = parseUpdate({ weightKg: 70, expectedRevision: 4 }, losing());

                expect(codesFor(verdict, 'goalWeightKg')).toEqual([
                    PREFERENCE_FIELD_CODES.NOT_BELOW_CURRENT_WEIGHT,
                ]);
            });

            it('accepts a new current weight the stored target still sits below', () => {
                const verdict = parseUpdate({ weightKg: 95, expectedRevision: 4 }, losing());

                expect(payloadOf(verdict)).toEqual({ weightKg: 95, expectedRevision: 4 });
            });

            it('refuses a change of direction that leaves the stored target on the wrong side', () => {
                const verdict = parseUpdate(
                    { goal: 'gain', paceLbPerWeek: 1, expectedRevision: 4 },
                    losing(),
                );

                expect(codesFor(verdict, 'goalWeightKg')).toEqual([
                    PREFERENCE_FIELD_CODES.NOT_ABOVE_CURRENT_WEIGHT,
                ]);
            });

            it('accepts a change of direction that sends the same body a fresh target', () => {
                const verdict = parseUpdate(
                    { goal: 'gain', paceLbPerWeek: 1, goalWeightKg: 90, expectedRevision: 4 },
                    losing(),
                );

                expect(verdict.kind).toBe('ok');
            });

            it('accepts a change of direction that clears the target outright', () => {
                const verdict = parseUpdate(
                    { goal: 'gain', paceLbPerWeek: 1, goalWeightKg: null, expectedRevision: 4 },
                    losing(),
                );

                expect(payloadOf(verdict)).toEqual({
                    goal: 'gain',
                    paceLbPerWeek: 1,
                    goalWeightKg: null,
                    expectedRevision: 4,
                });
            });

            it('leaves an incoherent stored row alone when the body touches no member of it', () => {
                // A row written before this rule existed must not block an
                // unrelated edit: a diet answer has nothing to do with the
                // target, and refusing it would leave every other answer on the
                // row unsavable until the stored tuple was repaired.
                const verdict = parseUpdate(
                    { diet: 'vegan', expectedRevision: 4 },
                    losing({ currentWeightKg: 70 }),
                );

                expect(payloadOf(verdict)).toEqual({ diet: 'vegan', expectedRevision: 4 });
            });

            it('reports one detail for one mistake, not two', () => {
                const verdict = parseUpdate({ weightKg: 70, expectedRevision: 4 }, losing());

                expect(detailsOf(verdict)).toHaveLength(1);
            });

            it('does not re-judge a weight the envelope already refused', () => {
                const verdict = parseUpdate({ weightKg: 10, expectedRevision: 4 }, losing());

                expect(fieldsOf(verdict)).toEqual(['weightKg']);
            });

            it('does not re-judge a target the envelope already refused', () => {
                const verdict = parseUpdate({ goalWeightKg: 400, expectedRevision: 4 }, losing());

                expect(codesFor(verdict, 'goalWeightKg')).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
            });

            it('leaves maintenance alone, whose target is cleared rather than compared', () => {
                const verdict = parseUpdate({ goal: 'maintain', expectedRevision: 4 }, losing());

                expect(payloadOf(verdict)).toEqual({
                    goal: 'maintain',
                    goalWeightKg: null,
                    paceLbPerWeek: null,
                    expectedRevision: 4,
                });
            });
        });
    });

    describe('a direction needs a pace, whichever half of the pair the body carries', () => {
        it('refuses a switch to a direction that leaves no pace behind it', () => {
            // 'maintain' never had a pace, so switching to 'lose' without
            // sending one stores a goal no estimate can be computed from — which
            // surfaces later as an unexplained estimate_unavailable on the
            // review screen rather than as a rejected save.
            const verdict = parseUpdate(
                { goal: 'lose', expectedRevision: 4 },
                updateContext({ currentGoal: 'maintain', currentPaceLbPerWeek: null }),
            );

            expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it.each([0.5, 1, 1.5] as const)('accepts a switch that supplies the pace %p', (paceLbPerWeek) => {
            const verdict = parseUpdate(
                { goal: 'gain', paceLbPerWeek, expectedRevision: 4 },
                updateContext({ currentGoal: 'maintain', currentPaceLbPerWeek: null }),
            );

            expect(payloadOf(verdict)).toEqual({ goal: 'gain', paceLbPerWeek, expectedRevision: 4 });
        });

        it('accepts a switch that keeps a pace already stored', () => {
            const verdict = parseUpdate(
                { goal: 'gain', expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentPaceLbPerWeek: 1.5 }),
            );

            expect(payloadOf(verdict)).toEqual({ goal: 'gain', expectedRevision: 4 });
        });

        it('accepts a pace edit on its own, which changes the pair\u2019s other half not at all', () => {
            const verdict = parseUpdate(
                { paceLbPerWeek: 0.5, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentPaceLbPerWeek: 1 }),
            );

            expect(payloadOf(verdict)).toEqual({ paceLbPerWeek: 0.5, expectedRevision: 4 });
        });

        it('leaves a pace-less directional row alone when the body changes neither half', () => {
            const verdict = parseUpdate(
                { diet: 'vegan', expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentPaceLbPerWeek: null }),
            );

            expect(payloadOf(verdict)).toEqual({ diet: 'vegan', expectedRevision: 4 });
        });

        it('reports one detail for a pace that is present but unknown, not two', () => {
            const verdict = parseUpdate(
                { goal: 'lose', paceLbPerWeek: 2, expectedRevision: 4 },
                updateContext({ currentGoal: 'maintain', currentPaceLbPerWeek: null }),
            );

            expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.UNKNOWN_VALUE]);
        });

        it('says nothing about the pace when the goal itself was refused', () => {
            const verdict = parseUpdate(
                { goal: 'shrink', expectedRevision: 4 },
                updateContext({ currentGoal: 'maintain', currentPaceLbPerWeek: null }),
            );

            expect(fieldsOf(verdict)).toEqual(['goal']);
        });

        it('accepts maintenance with no pace, which is the one goal that needs none', () => {
            const verdict = parseUpdate(
                { goal: 'maintain', expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentPaceLbPerWeek: 1 }),
            );

            expect(payloadOf(verdict)).toEqual({
                goal: 'maintain',
                goalWeightKg: null,
                paceLbPerWeek: null,
                expectedRevision: 4,
            });
        });
    });

    describe('meal times and the schedule that sizes them', () => {
        const times = [
            { slot: 'breakfast', time: '08:00' },
            { slot: 'lunch', time: '12:30' },
            { slot: 'dinner', time: '18:30' },
        ];

        it('judges times against the stored schedule when the body omits one', () => {
            const verdict = parseUpdate(
                { mealTimes: times, expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(payloadOf(verdict)).toEqual({ mealTimes: times, expectedRevision: 4 });
        });

        it('refuses times when no schedule is known either way', () => {
            const verdict = parseUpdate(
                { mealTimes: times, expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'mealSchedule')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('judges times against the schedule in the same body', () => {
            const verdict = parseUpdate(
                { mealSchedule: 'three_plus_snack', mealTimes: times, expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(codesFor(verdict, 'mealTimes')).toEqual([PREFERENCE_FIELD_CODES.SLOT_MISMATCH]);
        });

        it('requires new times when the schedule CHANGES, since the stored set is the wrong size', () => {
            const verdict = parseUpdate(
                { mealSchedule: 'three_plus_snack', expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(codesFor(verdict, 'mealTimes')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('accepts a schedule re-sent unchanged without times', () => {
            const verdict = parseUpdate(
                { mealSchedule: 'three', expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(payloadOf(verdict)).toEqual({ mealSchedule: 'three', expectedRevision: 4 });
        });

        it('refuses an unknown schedule', () => {
            const verdict = parseUpdate(
                { mealSchedule: 'five', expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'mealSchedule')).toEqual([PREFERENCE_FIELD_CODES.UNKNOWN_VALUE]);
        });

        it('reports a cleared schedule as required, not as an unknown value', () => {
            const verdict = parseUpdate(
                { mealSchedule: null, expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(codesFor(verdict, 'mealSchedule')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('requires times on a first schedule save, when there is no stored set to keep', () => {
            const verdict = parseUpdate(
                { mealSchedule: 'three', expectedRevision: 4 },
                updateContext({ currentMealSchedule: null }),
            );

            expect(codesFor(verdict, 'mealTimes')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });
    });

    describe('the budget pair', () => {
        it('clears a stored amount when no preference becomes the answer', () => {
            const verdict = parseUpdate(
                { noBudgetPreference: true, expectedRevision: 4 },
                updateContext({ currentBudget: { amount: 120, currency: 'USD' } }),
            );

            expect(payloadOf(verdict)).toEqual({
                noBudgetPreference: true,
                budget: null,
                expectedRevision: 4,
            });
        });

        it('requires an amount when no preference is switched off with nothing stored', () => {
            const verdict = parseUpdate(
                { noBudgetPreference: false, expectedRevision: 4 },
                updateContext({ currentBudget: null, currentNoBudgetPreference: true }),
            );

            expect(codesFor(verdict, 'budget')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('lets a stored amount stand in when no preference is switched off without one', () => {
            // The other half of the rule above: unchecking the box is an answer of
            // "an amount", and the amount the row already holds is that answer —
            // so a partial body need not re-send a figure the user never edited.
            const verdict = parseUpdate(
                { noBudgetPreference: false, expectedRevision: 4 },
                updateContext({
                    currentBudget: { amount: 120, currency: 'USD' },
                    currentNoBudgetPreference: true,
                }),
            );

            expect(payloadOf(verdict)).toEqual({
                budget: { amount: 120, currency: BUDGET_CURRENCY },
                noBudgetPreference: false,
                expectedRevision: 4,
            });
        });

        it('accepts an amount against a stored "no preference" of false', () => {
            const verdict = parseUpdate(
                { budget: { amount: 150, currency: 'USD' }, expectedRevision: 4 },
                updateContext({ currentNoBudgetPreference: false }),
            );

            expect(payloadOf(verdict)).toEqual({
                budget: { amount: 150, currency: BUDGET_CURRENCY },
                noBudgetPreference: false,
                expectedRevision: 4,
            });
        });

        it('refuses an amount while the stored answer is "no preference"', () => {
            const verdict = parseUpdate(
                { budget: { amount: 150, currency: 'USD' }, expectedRevision: 4 },
                updateContext({ currentNoBudgetPreference: true }),
            );

            expect(codesFor(verdict, 'budget')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it('accepts both halves changing together', () => {
            const verdict = parseUpdate(
                { budget: { amount: 210, currency: 'USD' }, noBudgetPreference: false, expectedRevision: 4 },
                updateContext({ currentNoBudgetPreference: true }),
            );

            expect(verdict.kind).toBe('ok');
        });
    });

    describe('the remaining editable keys', () => {
        it('accepts every measurement, selection and preference at once', () => {
            const verdict = parseUpdate(
                {
                    age: 34,
                    heightCm: 177.8,
                    weightKg: 82.6,
                    sexForEstimate: 'male',
                    heightUnitPref: 'cm',
                    weightUnitPref: 'kg',
                    activityLevel: 'active',
                    allergens: ['Milk'],
                    dislikedFoodIds: [UUIDS[0]],
                    dislikedFoodGroups: ['Mushroom', 'mushroom', 'olive'],
                    cookingTimeLimitMin: 45,
                    timeZone: 'Etc/UTC',
                    expectedRevision: 4,
                },
                updateContext(),
            );

            // The body's own 'Etc/UTC' overrides the helper's zone and comes back
            // canonicalised, which is what the second argument asserts.
            expect(payloadOf(verdict, normalizeTimeZone('UTC'))).toEqual({
                age: 34,
                heightCm: 177.8,
                weightKg: 82.6,
                sexForEstimate: 'male',
                heightUnitPref: 'cm',
                weightUnitPref: 'kg',
                activityLevel: 'active',
                allergens: ['milk'],
                dislikedFoodIds: [UUIDS[0]],
                dislikedFoodGroups: ['Mushroom', 'olive'],
                cookingTimeLimitMin: 45,
                expectedRevision: 4,
            });
        });

        it.each([
            ['age', 17, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
            ['heightCm', 400, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
            ['weightKg', 10, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
            ['sexForEstimate', 'other', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['sexForEstimate', null, PREFERENCE_FIELD_CODES.REQUIRED],
            ['heightUnitPref', 'inches', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['weightUnitPref', 'stone', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['activityLevel', 'athlete', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['activityLevel', null, PREFERENCE_FIELD_CODES.REQUIRED],
            ['diet', 'keto', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['diet', null, PREFERENCE_FIELD_CODES.REQUIRED],
            ['cookingTimeLimitMin', 20, PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['cookingTimeLimitMin', null, PREFERENCE_FIELD_CODES.REQUIRED],
            ['goal', 'shrink', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['goal', null, PREFERENCE_FIELD_CODES.REQUIRED],
            ['timeZone', 'Not/AZone', PREFERENCE_FIELD_CODES.INVALID_TIME_ZONE],
            ['timeZone', null, PREFERENCE_FIELD_CODES.REQUIRED],
            ['paceLbPerWeek', 2, PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            ['goalWeightKg', 400, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
        ])('reports %s of %p as %s', (field, value, code) => {
            const verdict = parseUpdate(
                { [field]: value, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose' }),
            );

            expect(codesFor(verdict, field)).toEqual([code]);
        });

        it('carries an allergen contradiction through from the shared rule', () => {
            const verdict = parseUpdate(
                { allergens: ['none', 'milk'], expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'allergens')).toEqual([PREFERENCE_FIELD_CODES.MUTUALLY_EXCLUSIVE]);
        });

        it('carries a malformed dislike id through from the shared rule', () => {
            const verdict = parseUpdate(
                { dislikedFoodIds: ['mushrooms'], expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'dislikedFoodIds[0]')).toEqual([PREFERENCE_FIELD_CODES.INVALID_ID]);
        });

        it.each([
            ['not-an-array', PREFERENCE_FIELD_CODES.INVALID_TYPE],
            [[7], PREFERENCE_FIELD_CODES.INVALID_TYPE],
            [['  '], PREFERENCE_FIELD_CODES.INVALID_TYPE],
        ])('reports the food-group list %p', (dislikedFoodGroups, code) => {
            const verdict = parseUpdate(
                { dislikedFoodGroups, expectedRevision: 4 },
                updateContext(),
            );

            expect(detailsOf(verdict)[0].code).toBe(code);
        });

        describe('the per-entry length bound on food groups', () => {
            /**
             * Unbounded entries are the harm: a hundred of them at the
             * `express.json()` limit stores ~100 KB of text in one array column,
             * and every one of those characters is normalised by the spelling
             * rule before it can even be judged. The bound is therefore checked
             * BEFORE normalisation, and asserted at its literal edge in both
             * directions so neither an off-by-one nor a silently widened
             * constant survives.
             */
            const entry = (length: number): string => 'x'.repeat(length);

            it('accepts an entry at the bound, refusing one character more', () => {
                // At the bound it clears the LENGTH gate; it is still not a term
                // of the vocabulary, which is the service's refusal and not this
                // parser's — so the shape verdict here is 'ok'.
                expect(
                    parseUpdate(
                        { dislikedFoodGroups: [entry(MAX_FOOD_GROUP_LENGTH)], expectedRevision: 4 },
                        updateContext(),
                    ).kind,
                ).toBe('ok');

                expect(
                    codesFor(
                        parseUpdate(
                            {
                                dislikedFoodGroups: [entry(MAX_FOOD_GROUP_LENGTH + 1)],
                                expectedRevision: 4,
                            },
                            updateContext(),
                        ),
                        'dislikedFoodGroups[0]',
                    ),
                ).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
            });

            it('refuses the 90,000-character entry the audit submitted, naming its index', () => {
                expect(
                    codesFor(
                        parseUpdate(
                            { dislikedFoodGroups: ['olive', entry(90_000)], expectedRevision: 4 },
                            updateContext(),
                        ),
                        'dislikedFoodGroups[1]',
                    ),
                ).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
            });

            it('refuses every offending entry at once, so one save reports the whole list', () => {
                const verdict = parseUpdate(
                    {
                        dislikedFoodGroups: [entry(200), 'olive', 7, entry(70)],
                        expectedRevision: 4,
                    },
                    updateContext(),
                );

                expect(detailsOf(verdict)).toEqual([
                    { field: 'dislikedFoodGroups[0]', code: PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM },
                    { field: 'dislikedFoodGroups[2]', code: PREFERENCE_FIELD_CODES.INVALID_TYPE },
                    { field: 'dislikedFoodGroups[3]', code: PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM },
                ]);
            });
        });

        it('returns the food-group survivors in the order they were sent', () => {
            // Load-bearing, not cosmetic: `resolveDislikeWrites` refuses an
            // unselectable group by its index in THIS list, so a reordering here
            // would name the wrong element of the client's array. Storage order
            // is the service's own sort and is unaffected.
            const verdict = parseUpdate(
                {
                    dislikedFoodGroups: ['olive', 'Mushroom', 'mushroom', 'avocado'],
                    expectedRevision: 4,
                },
                updateContext(),
            );

            expect(payloadOf(verdict, ZONE).dislikedFoodGroups).toEqual([
                'olive',
                'Mushroom',
                'avocado',
            ]);
        });

        it('bounds the food-group list', () => {
            const verdict = parseUpdate(
                {
                    dislikedFoodGroups: Array.from({ length: MAX_DISLIKED_FOOD_IDS + 1 }, (_, i) => `g${i}`),
                    expectedRevision: 4,
                },
                updateContext(),
            );

            expect(codesFor(verdict, 'dislikedFoodGroups')).toEqual([PREFERENCE_FIELD_CODES.TOO_MANY]);
        });

        it('bounds the food-group list at the literal 100, accepting 100 and refusing 101', () => {
            const groups = (count: number): string[] =>
                Array.from({ length: count }, (_, index) => `group-${index}`);

            expect(
                parseUpdate(
                    { dislikedFoodGroups: groups(100), expectedRevision: 4 },
                    updateContext(),
                ).kind,
            ).toBe('ok');
            expect(
                codesFor(
                    parseUpdate(
                        { dislikedFoodGroups: groups(101), expectedRevision: 4 },
                        updateContext(),
                    ),
                    'dislikedFoodGroups',
                ),
            ).toEqual([PREFERENCE_FIELD_CODES.TOO_MANY]);
        });

        it('reports a read-only key and a field error in the same refusal', () => {
            const verdict = parseUpdate(
                { revision: 9, diet: 'keto', expectedRevision: 4 },
                updateContext(),
            );

            expect(fieldsOf(verdict).sort()).toEqual(['diet', 'revision']);
        });
    });
});

/* ---------------------------------------------------------------------------
 * The setup state machine
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * The context-free envelope
 *
 * These two parsers exist so a service can refuse a structurally malformed
 * request BEFORE it reads the stored row (AAP §0.5.2, "validation applied
 * before any Prisma or planning work"). What makes them worth their own tests
 * is the pair of properties they must hold at once: they must catch everything
 * that needs no context, and they must judge nothing that does — an envelope
 * that "helpfully" reported a stale revision or an incoherent goal weight would
 * be answering a question it cannot see the data for.
 * ------------------------------------------------------------------------- */

describe('readOnlyFieldRefusal', () => {
    const verdictOf = (details: InvalidRequestDetail[]): PreferenceErrorVerdict => ({
        kind: 'error',
        code: 'invalid_request',
        message: 'test verdict',
        details,
    });
    const readOnly = (field: string): InvalidRequestDetail => ({
        field,
        code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD,
    });

    // The predicate both layers ask: the service raises `ReadOnlyFieldError`
    // from the request stage, and the controller raises it at the HTTP boundary
    // from the same verdict. One owner, so the two cannot classify a body
    // differently and answer it as a class on one path and a verdict on the
    // other.
    it('answers the whole detail list when every detail is a read-only key', () => {
        const details = [readOnly('setupStatus'), readOnly('revision')];

        expect(readOnlyFieldRefusal(verdictOf(details))).toEqual(details);
    });

    it('answers null when any detail says something else as well', () => {
        // A mixed body must stay one 400 naming every offending control at
        // once (AAP §0.7.4), which a single-condition class cannot carry.
        const details = [
            readOnly('setupStatus'),
            { field: 'diet', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE },
        ];

        expect(readOnlyFieldRefusal(verdictOf(details))).toBeNull();
    });

    it('answers null for a refusal carrying no details at all', () => {
        // `every` is true of an empty list, so without the emptiness guard this
        // would be reported as a read-only refusal naming nothing.
        expect(readOnlyFieldRefusal(verdictOf([]))).toBeNull();
    });

    it('classifies what the request-stage parsers actually produce', () => {
        const stepVerdict = parseSetupStepRequest('goal', {
            goal: 'lose',
            paceLbPerWeek: 1,
            timeZone: ZONE,
            expectedRevision: 4,
            setupStatus: 'completed',
            revision: 9,
        });
        const updateVerdict = parsePreferencesUpdateRequest({
            diet: 'vegan',
            timeZone: ZONE,
            expectedRevision: 4,
            setupStep: 'review',
        });

        expect(stepVerdict.kind).toBe('error');
        expect(updateVerdict.kind).toBe('error');
        expect(
            readOnlyFieldRefusal(stepVerdict as PreferenceErrorVerdict)?.map((detail) => detail.field),
        ).toEqual(['setupStatus', 'revision']);
        expect(
            readOnlyFieldRefusal(updateVerdict as PreferenceErrorVerdict)?.map((detail) => detail.field),
        ).toEqual(['setupStep']);
    });
});

describe('parseSetupStepRequest', () => {
    const goalEnvelopeBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        goal: 'lose',
        paceLbPerWeek: 1,
        timeZone: ZONE,
        expectedRevision: 4,
        ...overrides,
    });

    it('accepts a well-formed body', () => {
        expect(parseSetupStepRequest('goal', goalEnvelopeBody())).toEqual({ kind: 'ok' });
    });

    it('accepts a first save that pins no revision, which only the row can judge', () => {
        expect(
            parseSetupStepRequest('goal', goalEnvelopeBody({ expectedRevision: undefined })),
        ).toEqual({ kind: 'ok' });
    });

    it('refuses a step segment that names no payload-bearing step', () => {
        expect(codesFor(parseSetupStepRequest('goals', goalEnvelopeBody()), 'step')).toEqual([
            PREFERENCE_FIELD_CODES.UNKNOWN_STEP,
        ]);
    });

    it('refuses the resume-marker-only step, which saves through the targets endpoint', () => {
        expect(codesFor(parseSetupStepRequest('targets_manual', { timeZone: ZONE }), 'step')).toEqual([
            PREFERENCE_FIELD_CODES.UNKNOWN_STEP,
        ]);
    });

    it.each([undefined, null, 'goal', [1], 7])('refuses the body %p', (body) => {
        expect(codesFor(parseSetupStepRequest('goal', body), 'body')).toEqual([
            PREFERENCE_FIELD_CODES.INVALID_TYPE,
        ]);
    });

    it('refuses a server-owned key', () => {
        expect(
            codesFor(parseSetupStepRequest('goal', goalEnvelopeBody({ setupStatus: 'completed' })), 'setupStatus'),
        ).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
    });

    it('refuses a key that belongs to another step', () => {
        expect(
            codesFor(parseSetupStepRequest('goal', goalEnvelopeBody({ activityLevel: 'active' })), 'activityLevel'),
        ).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
    });

    it('refuses a missing zone', () => {
        expect(
            codesFor(parseSetupStepRequest('goal', goalEnvelopeBody({ timeZone: undefined })), 'timeZone'),
        ).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
    });

    it('refuses an unknown zone', () => {
        expect(
            codesFor(parseSetupStepRequest('goal', goalEnvelopeBody({ timeZone: 'Mars/Phobos' })), 'timeZone'),
        ).toEqual([PREFERENCE_FIELD_CODES.INVALID_TIME_ZONE]);
    });

    it.each([
        ['4', PREFERENCE_FIELD_CODES.INVALID_TYPE],
        [Number.NaN, PREFERENCE_FIELD_CODES.INVALID_TYPE],
        [4.5, PREFERENCE_FIELD_CODES.NOT_AN_INTEGER],
        [-1, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
        [MAX_REVISION + 1, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
        [1e30, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
    ])('refuses the revision token %p as %s', (expectedRevision, code) => {
        expect(
            codesFor(parseSetupStepRequest('goal', goalEnvelopeBody({ expectedRevision })), 'expectedRevision'),
        ).toEqual([code]);
    });

    it('names every envelope problem at once, in the order this endpoint has always used', () => {
        const verdict = parseSetupStepRequest(
            'goal',
            goalEnvelopeBody({ setupStatus: 'completed', timeZone: 'Mars/Phobos', expectedRevision: 4.5 }),
        );

        expect(fieldsOf(verdict).sort()).toEqual(['expectedRevision', 'setupStatus', 'timeZone']);
        // Unsorted, because this refusal is the one a client reads for a
        // malformed envelope: the service answers with it before the row is
        // read, so the authoritative parse never gets to reply. Lifting these
        // checks out of that parse moved them; it must not have resequenced
        // them.
        expect(fieldsOf(verdict)).toEqual(['setupStatus', 'timeZone', 'expectedRevision']);
    });

    it('judges nothing that needs the stored row: a stale revision passes the envelope', () => {
        // The comparison against the stored counter is a 409 the row decides, and
        // the envelope has no row. Reporting it here would turn a lost race into
        // a malformed request.
        expect(parseSetupStepRequest('goal', goalEnvelopeBody({ expectedRevision: 99 }))).toEqual({
            kind: 'ok',
        });
    });

    it('judges the field rules too, which need no row at all', () => {
        // AAP 0.5.2 puts field validation before any Prisma work, so an unknown
        // goal and an out-of-range pace are answered here — and together, which
        // is what lets the screen show both controls at once (AAP 0.7.4).
        const verdict = parseSetupStepRequest('goal', goalEnvelopeBody({ goal: 'shrink', paceLbPerWeek: 9 }));

        expect(verdict).toEqual(
            parseSetupStep(
                'goal',
                goalEnvelopeBody({ goal: 'shrink', paceLbPerWeek: 9 }),
                stepContext({ currentRevision: 4 }),
            ),
        );
        expect(codesFor(verdict, 'goal')).toEqual([PREFERENCE_FIELD_CODES.UNKNOWN_VALUE]);
        expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.UNKNOWN_VALUE]);
    });

    it.each([
        ['activity', { activityLevel: 'sprinting' }, 'activityLevel'],
        ['diet', { diet: 'carnivore', allergens: [] }, 'diet'],
        ['diet', { diet: 'none', allergens: ['none', 'milk'] }, 'allergens'],
        ['schedule', { mealSchedule: 'three', mealTimes: [{ slot: 'breakfast', time: '25:00' }] }, 'mealTimes'],
        ['cooking', { cookingTimeLimitMin: 37, noBudgetPreference: true }, 'cookingTimeLimitMin'],
        ['dislikes', { dislikedFoodIds: ['not-a-uuid'] }, 'dislikedFoodIds[0]'],
    ])('refuses the %s step field %s without a row', (step, body, field) => {
        expect(
            codesFor(parseSetupStepRequest(step, { ...body, timeZone: ZONE, expectedRevision: 4 }), field),
        ).not.toEqual([]);
    });

    it('names an envelope problem and a field problem in the same complete 400', () => {
        // The mixed case: without this the extraction would have answered with
        // the zone alone and left the screen to discover the diet on a second
        // round trip.
        const body = { activityLevel: 'sprinting', setupStatus: 'completed', expectedRevision: 4 };

        expect(fieldsOf(parseSetupStepRequest('activity', body))).toEqual([
            'setupStatus',
            'timeZone',
            'activityLevel',
        ]);
        // And it is exactly what the row-backed parse would have said.
        expect(parseSetupStepRequest('activity', body)).toEqual(
            parseSetupStep('activity', body, stepContext({ currentRevision: 4 })),
        );
    });

    it('defers a known-bad body to the row where a coherence rule is also applicable', () => {
        // The defect this pins: the stage used to RETURN its own refusal here,
        // naming the pace, the server-owned key and the zone — but not the
        // target weight, which is judged against the STORED current weight and
        // which this stage cannot see. The client marked the three it was told
        // about, left its target untouched because nothing said otherwise, and
        // was refused again. AAP 0.7.4 requires validate-on-press to mark every
        // offending control at once, so a body a stored value still has a
        // verdict on is carried to the row however malformed it already is.
        const body = goalEnvelopeBody({
            goal: 'lose',
            paceLbPerWeek: 9,
            goalWeightKg: 70,
            setupStatus: 'completed',
            timeZone: 'Mars/Phobos',
        });

        expect(parseSetupStepRequest('goal', body)).toEqual({ kind: 'needs_context' });

        // What the client receives instead: the request-only list AND the
        // coherence detail, in one 400, in this endpoint's order. A stored
        // weight of 60 kg makes a 70 kg target incoherent for `lose`.
        expect(
            fieldsOf(parseSetupStep('goal', body, stepContext({ currentRevision: 4, currentWeightKg: 60 }))),
        ).toEqual(['setupStatus', 'timeZone', 'paceLbPerWeek', 'goalWeightKg']);
    });

    it('answers with the request-only list alone once no coherence rule is applicable', () => {
        // The contrast that keeps the deferral narrow: the same malformed body
        // WITHOUT a target weight has no stored half to wait for, so it is
        // refused for free — AAP 0.5.2 puts validation before any Prisma work,
        // and an authenticated caller must not be able to make the server read a
        // row per malformed attempt.
        const body = goalEnvelopeBody({
            goal: 'lose',
            paceLbPerWeek: 9,
            setupStatus: 'completed',
            timeZone: 'Mars/Phobos',
        });

        // The WHOLE request-only list, envelope and field alike, in this
        // endpoint's order — an early refusal is not a shortened one.
        expect(fieldsOf(parseSetupStepRequest('goal', body))).toEqual([
            'setupStatus',
            'timeZone',
            'paceLbPerWeek',
        ]);
        // And detail for detail the verdict the service used to reach by
        // reading the row first: the row-backed parse is untouched by this
        // change, so where the stored half adds nothing, the 400 the client
        // receives is byte-identical to the one it received before. The
        // refusal moved earlier; it did not move.
        expect(parseSetupStepRequest('goal', body)).toEqual(
            parseSetupStep('goal', body, stepContext({ currentRevision: 4 })),
        );
    });

    it('names a request-only error and a coherence error in ONE 400 rather than across two attempts', () => {
        // The case the AAP names, at its smallest: an invalid pace the request
        // alone refuses, beside a target weight that only the stored current
        // weight can refuse. This stage answered `['paceLbPerWeek']` and left
        // the user to discover `goalWeightKg` on the next round trip; now it
        // defers, and the single 400 the client renders marks both controls.
        const body = goalEnvelopeBody({ goal: 'lose', paceLbPerWeek: 9, goalWeightKg: 70 });

        expect(parseSetupStepRequest('goal', body)).toEqual({ kind: 'needs_context' });
        expect(
            fieldsOf(parseSetupStep('goal', body, stepContext({ currentRevision: 4, currentWeightKg: 60 }))),
        ).toEqual(['paceLbPerWeek', 'goalWeightKg']);
    });

    it('does not defer for the row-only `step` detail, which names no control', () => {
        // `step: not_allowed` — a non-`goal` step as the first write a user ever
        // makes — is the row-backed parse's own detail, and it is deliberately
        // outside the deferral predicate. No screen can mark it and no answer
        // the user changes clears it: the wizard cannot reach a non-goal step
        // first and a resume always re-enters at the stored marker. Deferring
        // for it would spend a read on every malformed save of every step but
        // one, to add a detail the screen cannot act on.
        const body = { activityLevel: 'sprinting', timeZone: ZONE, expectedRevision: 4 };

        expect(fieldsOf(parseSetupStepRequest('activity', body))).toEqual(['activityLevel']);
        expect(fieldsOf(parseSetupStep('activity', body, stepContext({ currentRevision: null })))).toEqual(
            ['step', 'activityLevel'],
        );
    });

    it.each([
        ['goal', goalEnvelopeBody({ goalWeightKg: 70 })],
        [
            'body',
            {
                age: 34,
                heightCm: 178,
                weightKg: 79,
                sexForEstimate: 'female',
                heightUnitPref: 'ft_in',
                weightUnitPref: 'lb',
                timeZone: ZONE,
                expectedRevision: 4,
            },
        ],
    ])('answers needs_context for a clean %s body a stored value still has a verdict on', (step, body) => {
        // Not `ok`: the goal step's target weight and the body step's current
        // weight are each half of the coherence tuple whose other half is
        // stored, so the answer is not final until the row is read.
        expect(parseSetupStepRequest(step, body)).toEqual({ kind: 'needs_context' });
    });

    it('answers ok for a clean body no stored value bears on', () => {
        // The third arm, and the contrast that makes `needs_context` mean
        // something: this body carries no goal weight, so every rule that can
        // judge it has been judged.
        expect(parseSetupStepRequest('goal', goalEnvelopeBody())).toEqual({ kind: 'ok' });
        expect(
            parseSetupStepRequest('activity', {
                activityLevel: 'active',
                timeZone: ZONE,
                expectedRevision: 4,
            }),
        ).toEqual({ kind: 'ok' });
    });
});

describe('parsePreferencesUpdateRequest', () => {
    it('accepts a well-formed partial', () => {
        expect(
            parsePreferencesUpdateRequest({ diet: 'vegan', timeZone: ZONE, expectedRevision: 4 }),
        ).toEqual({ kind: 'ok' });
    });

    it.each([undefined, null, 'diet', [1]])('refuses the body %p', (body) => {
        expect(codesFor(parsePreferencesUpdateRequest(body), 'body')).toEqual([
            PREFERENCE_FIELD_CODES.INVALID_TYPE,
        ]);
    });

    it.each(['setupStatus', 'setupStep', 'revision', 'budgetTier', 'hasActivePlan', 'targetRoute'])(
        'refuses the server-owned key %s',
        (key) => {
            expect(
                codesFor(
                    parsePreferencesUpdateRequest({ [key]: 'x', timeZone: ZONE, expectedRevision: 4 }),
                    key,
                ),
            ).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
        },
    );

    it('defers a body that edits nothing but the envelope, because only the row knows the zone', () => {
        // Whether this body edits anything is not a property of the body: a zone
        // that differs from the stored one IS an edit of `time_zone`, and it is
        // the contract's only channel for reconciling a device that has moved
        // (AAP 0.5.2). Answering `body: required` here refused that save
        // outright, so the stored calendar could never be refreshed.
        expect(parsePreferencesUpdateRequest({ timeZone: ZONE, expectedRevision: 4 })).toEqual({
            kind: 'needs_context',
        });
    });

    // The envelope-only bodies whose verdict NO row can change, with the fields
    // each earns. The zone is the only thing that can make such a body an edit,
    // so one that is absent or not a name this runtime knows edits nothing
    // whatever the row holds.
    const UNUSABLE_ZONE_ENVELOPES: [Record<string, unknown>, string[]][] = [
        [{ expectedRevision: 4 }, ['body', 'timeZone']],
        [{}, ['body', 'timeZone']],
        [{ timeZone: 'Mars/Phobos', expectedRevision: 4 }, ['body', 'timeZone']],
        [{ expectedRevision: 'four' }, ['body', 'expectedRevision', 'timeZone']],
    ];

    it.each(UNUSABLE_ZONE_ENVELOPES)(
        'refuses the envelope-only body %p here, with no row read at all',
        (body, fields) => {
            // The BOUND on the deferral above, and the reason it costs one read
            // rather than one per malformed attempt. Deferring these would buy
            // an authenticated read to arrive at a 400 this stage already holds
            // in full, which is exactly what AAP 0.5.2's "validation before any
            // Prisma work" exists to prevent. `needs_context` is the answer for
            // a USABLE zone only, because that is the only case the stored value
            // can settle either way.
            expect(fieldsOf(parsePreferencesUpdateRequest(body))).toEqual(fields);
        },
    );

    it.each(UNUSABLE_ZONE_ENVELOPES)(
        'answers the envelope-only body %p exactly as the row-backed parse would',
        (body) => {
            // What makes answering here SAFE rather than merely cheap: both
            // stages produce the same details, so the client reads the same 400
            // whichever one decided it. A divergence would mean a control the
            // screen learns about only on a later attempt — the defect the
            // merged-400 rule exists to remove.
            expect(fieldsOf(parsePreferencesUpdateRequest(body))).toEqual(
                fieldsOf(parsePreferencesUpdate(body, updateContext({ currentTimeZone: ZONE }))),
            );
        },
    );

    it('defers a pace sent without a goal, whose verdict the stored goal decides', () => {
        // The other orientation of the goal/pace pair. `effectiveGoal` falls
        // back to the stored goal, so a numeric pace against a stored `maintain`
        // is `not_allowed` — and only the row knows that. Answering the diet
        // alone here would mark one control and leave the pace to a second
        // refusal the user was never warned about (AAP 0.7.4).
        const body = { paceLbPerWeek: 1, diet: 'carnivore', timeZone: ZONE, expectedRevision: 4 };

        expect(parsePreferencesUpdateRequest(body)).toEqual({ kind: 'needs_context' });
        expect(
            fieldsOf(parsePreferencesUpdate(body, updateContext({ currentGoal: 'maintain' }))),
        ).toEqual(['paceLbPerWeek', 'diet']);
        expect(
            codesFor(
                parsePreferencesUpdate(body, updateContext({ currentGoal: 'maintain' })),
                'paceLbPerWeek',
            ),
        ).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
    });

    it('defers a pace cleared without a goal, which a stored direction makes required', () => {
        // The same orientation with the opposite outcome: clearing the pace
        // while the stored goal is directional leaves a goal no estimate can be
        // computed from, so the row-backed parse reports it `required`. Both
        // cases are why the pair is applicable whenever EITHER half arrives
        // alone, not only when the goal does.
        const body = { paceLbPerWeek: null, diet: 'carnivore', timeZone: ZONE, expectedRevision: 4 };

        expect(parsePreferencesUpdateRequest(body)).toEqual({ kind: 'needs_context' });
        expect(codesFor(parsePreferencesUpdate(body, updateContext({ currentGoal: 'lose' })), 'paceLbPerWeek')).toEqual([
            PREFERENCE_FIELD_CODES.REQUIRED,
        ]);
    });

    it('judges a body carrying both halves of every stored pair itself', () => {
        // The boundary the two cases above sit against: with the goal, the pace,
        // the current weight and the target weight all present, no rule here
        // reads the row, so the diet is answered for free and the read is not
        // bought.
        expect(
            fieldsOf(
                parsePreferencesUpdateRequest({
                    goal: 'lose',
                    paceLbPerWeek: 1,
                    weightKg: 80,
                    goalWeightKg: 70,
                    diet: 'carnivore',
                    timeZone: ZONE,
                    expectedRevision: 4,
                }),
            ),
        ).toEqual(['diet']);
    });

    it('refuses a missing zone', () => {
        expect(
            codesFor(parsePreferencesUpdateRequest({ diet: 'vegan', expectedRevision: 4 }), 'timeZone'),
        ).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
    });

    it('refuses an unknown zone', () => {
        expect(
            codesFor(
                parsePreferencesUpdateRequest({ diet: 'vegan', timeZone: 'Mars/Phobos', expectedRevision: 4 }),
                'timeZone',
            ),
        ).toEqual([PREFERENCE_FIELD_CODES.INVALID_TIME_ZONE]);
    });

    it('refuses a revision token no integer column could hold', () => {
        expect(
            codesFor(
                parsePreferencesUpdateRequest({ diet: 'vegan', timeZone: ZONE, expectedRevision: 1e30 }),
                'expectedRevision',
            ),
        ).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
    });

    it('reports every envelope problem together, in the order this endpoint has always used', () => {
        // Pinned for the same reason as the step envelope's: this refusal is
        // what a client reads for a malformed envelope, because the service
        // answers with it before reading the row. Note the sequence differs
        // from the step endpoint's (revision before zone here, after it there)
        // — each endpoint keeps the order it already had rather than being
        // harmonised, which would change an answer no finding asked about.
        expect(
            fieldsOf(
                parsePreferencesUpdateRequest({
                    nickname: 'x',
                    expectedRevision: 'four',
                    timeZone: 'Mars/Phobos',
                }),
            ),
        ).toEqual(['nickname', 'expectedRevision', 'timeZone']);
    });

    it('judges nothing that needs the stored row', () => {
        // Both of these are refusals the row decides — a revision that lost the
        // race, and a target weight on the wrong side of a stored current weight
        // — so this stage must let them through. The second says
        // `needs_context` rather than `ok` because the tuple's other halves are
        // stored, which is exactly the verdict that is still outstanding.
        expect(
            parsePreferencesUpdateRequest({ diet: 'vegan', timeZone: ZONE, expectedRevision: 99 }),
        ).toEqual({ kind: 'ok' });
        expect(
            parsePreferencesUpdateRequest({ goalWeightKg: 200, timeZone: ZONE, expectedRevision: 4 }),
        ).toEqual({ kind: 'needs_context' });
    });

    it('names every envelope problem at once', () => {
        const verdict = parsePreferencesUpdateRequest({ nickname: 'x', expectedRevision: 4.5 });

        expect(fieldsOf(verdict).sort()).toEqual(['expectedRevision', 'nickname', 'timeZone']);
    });

    it.each([
        [{ diet: 'carnivore' }, 'diet'],
        [{ age: 7 }, 'age'],
        [{ activityLevel: 'sprinting' }, 'activityLevel'],
        [{ allergens: ['none', 'milk'] }, 'allergens'],
        [{ cookingTimeLimitMin: 37 }, 'cookingTimeLimitMin'],
        [{ weightKg: 500, goal: 'lose', goalWeightKg: 400, paceLbPerWeek: 1 }, 'weightKg'],
        [{ heightCm: 400 }, 'heightCm'],
        [{ sexForEstimate: 'other' }, 'sexForEstimate'],
        [{ dislikedFoodIds: ['not-a-uuid'] }, 'dislikedFoodIds[0]'],
        [{ mealSchedule: 'four', mealTimes: [] }, 'mealSchedule'],
    ])('refuses %p on the field itself, with no row (AAP 0.5.2)', (edit, field) => {
        expect(
            codesFor(parsePreferencesUpdateRequest({ ...edit, timeZone: ZONE, expectedRevision: 4 }), field),
        ).not.toEqual([]);
    });

    it('names an envelope problem and a field problem in the same complete 400', () => {
        // The case the extraction had narrowed: a missing zone AND an invalid
        // diet came back as the zone alone, leaving the screen to discover the
        // diet on a second round trip.
        const body = { diet: 'carnivore', expectedRevision: 4 };
        const verdict = parsePreferencesUpdateRequest(body);

        expect(fieldsOf(verdict)).toEqual(['diet', 'timeZone']);
        // Identical to what the row-backed parse answers, detail for detail and
        // in the same order — this stage narrows nothing.
        expect(verdict).toEqual(parsePreferencesUpdate(body, { currentRevision: 4 }));
    });

    const PAIR_RULE_EDITS: readonly [string, Record<string, unknown>][] = [
        ['the goal without its pace', { goal: 'lose' }],
        ['a target weight without the current one', { goalWeightKg: 70 }],
        ['meal times without the schedule', { mealTimes: [] }],
        ['a budget amount without the checkbox', { budget: { amount: 0, currency: 'USD' } }],
    ];

    it.each(PAIR_RULE_EDITS)(
        'defers a request-only error beside %s, whose other half the row holds',
        (_label, edit) => {
            // Each of these bodies ALSO carries an invalid diet, and the stage
            // used to RETURN the diet alone — a 400 the screen could act on only
            // partly, since the pair rule's own control was left unmarked and
            // the next attempt was refused again. AAP 0.7.4 requires one 400 to
            // mark every offending control, so a partial a stored half still
            // bears on is carried to the row however malformed it already is.
            expect(
                parsePreferencesUpdateRequest({
                    ...edit,
                    diet: 'carnivore',
                    timeZone: ZONE,
                    expectedRevision: 4,
                }),
            ).toEqual({ kind: 'needs_context' });
        },
    );

    it('names a request-only error and a pair-rule error in ONE 400, once the row is read', () => {
        // What the deferral above buys, stated on the wire. A stored goal of
        // `lose` against a stored weight of 60 kg makes a 70 kg target
        // incoherent, and the diet is `carnivore`: both controls are named
        // together, which is the answer the client renders. The order is this
        // parse's own — the goal/weight/target tuple is judged before the diet —
        // and is pinned rather than sorted, because it is what reaches the wire.
        const body = { goalWeightKg: 70, diet: 'carnivore', timeZone: ZONE, expectedRevision: 4 };

        expect(parsePreferencesUpdateRequest(body)).toEqual({ kind: 'needs_context' });
        expect(
            fieldsOf(
                parsePreferencesUpdate(
                    body,
                    updateContext({
                        currentGoal: 'lose',
                        currentWeightKg: 60,
                        currentPaceLbPerWeek: 1,
                        currentTimeZone: ZONE,
                    }),
                ),
            ),
        ).toEqual(['goalWeightKg', 'diet']);
    });

    it('leaves a body no stored value bears on answered here, with no read at all', () => {
        // The contrast that keeps the deferral narrow (AAP 0.5.2, validation
        // before any Prisma work): an invalid diet on its own has no stored half
        // to wait for, so the refusal is final and identical to what the
        // row-backed parse would say, detail for detail.
        const body = { diet: 'carnivore', timeZone: ZONE, expectedRevision: 4 };

        expect(parsePreferencesUpdateRequest(body)).toEqual(
            parsePreferencesUpdate(body, updateContext({ currentTimeZone: ZONE })),
        );
        expect(fieldsOf(parsePreferencesUpdateRequest(body))).toEqual(['diet']);
    });

    it.each(PAIR_RULE_EDITS)(
        'answers needs_context for a partial whose only outstanding rule is %s',
        (_label, edit) => {
            // The other half of the same four rules: with nothing the request
            // alone decides left wrong, the stage says the row still has a
            // verdict to give rather than claiming the partial is fully judged.
            expect(
                parsePreferencesUpdateRequest({ ...edit, timeZone: ZONE, expectedRevision: 4 }),
            ).toEqual({ kind: 'needs_context' });
        },
    );

    it('does not invent a refusal the stored half would have cleared', () => {
        // The regression this staging must not cause: a user whose stored pace
        // is 1 lb/week switching to `lose` sends no pace, and that is correct —
        // so the stage defers to the row instead of refusing.
        expect(
            parsePreferencesUpdateRequest({ goal: 'lose', timeZone: ZONE, expectedRevision: 4 }),
        ).toEqual({ kind: 'needs_context' });
        expect(
            parsePreferencesUpdateRequest({ budget: null, timeZone: ZONE, expectedRevision: 4 }),
        ).toEqual({ kind: 'needs_context' });
        expect(
            parsePreferencesUpdateRequest({ mealTimes: [], timeZone: ZONE, expectedRevision: 4 }),
        ).toEqual({ kind: 'needs_context' });
    });

    it('answers ok for a clean partial none of the four pair rules applies to', () => {
        // The third arm: a diet edit touches no pair, so every rule that can
        // judge this body has been judged and only the revision comparison is
        // outstanding.
        expect(
            parsePreferencesUpdateRequest({ diet: 'vegan', timeZone: ZONE, expectedRevision: 4 }),
        ).toEqual({ kind: 'ok' });
    });
});

/* ---------------------------------------------------------------------------
 * The target route a full save leaves behind
 *
 * `target_route` is server-owned, and before this rule existed only a body-STEP
 * save could resolve it — yet the four answers it is derived from are all
 * members of the full save's editable DTO, so a partial that moved one of them
 * could leave the column contradicting the row's own answers: the estimated
 * route for a user who now declines to state a sex (whose targets would then be
 * calculated from an assumed one), or the manual route for a user whose
 * measurements are now complete.
 * ------------------------------------------------------------------------- */

describe('isBodyAnswerComplete', () => {
    const complete: BodyAnswerFacts = { age: 34, heightCm: 177.8, weightKg: 82.6, sexForEstimate: 'male' };

    it('accepts the four measurements the measured body step stores', () => {
        expect(isBodyAnswerComplete(complete)).toBe(true);
    });

    it.each(['age', 'heightCm', 'weightKg', 'sexForEstimate'] as const)(
        'refuses an answer missing %s',
        (key) => {
            expect(isBodyAnswerComplete({ ...complete, [key]: null })).toBe(false);
        },
    );

    it('counts "prefer not to say" as an answer, because it is one', () => {
        expect(isBodyAnswerComplete({ ...complete, sexForEstimate: 'prefer_not_to_say' })).toBe(true);
    });
});

describe('resolveTargetRouteForUpdate', () => {
    const measured: BodyAnswerFacts = { age: 34, heightCm: 177.8, weightKg: 82.6, sexForEstimate: 'male' };

    it('moves an estimated user to manual when they decline to state a sex', () => {
        expect(
            resolveTargetRouteForUpdate('estimated', { ...measured, sexForEstimate: 'prefer_not_to_say' }),
        ).toBe('manual');
    });

    it('moves a manual user to estimated once a measured answer is complete', () => {
        expect(resolveTargetRouteForUpdate('manual', measured)).toBe('estimated');
    });

    it.each(['female', 'male'] as const)('reads %s as calculable', (sexForEstimate) => {
        expect(resolveTargetRouteForUpdate('manual', { ...measured, sexForEstimate })).toBe('estimated');
    });

    it('writes nothing when the body answer is not mentioned at all', () => {
        expect(resolveTargetRouteForUpdate('estimated', { ...measured, sexForEstimate: null })).toBeUndefined();
    });

    it('writes nothing when the derived route is the stored one', () => {
        expect(resolveTargetRouteForUpdate('estimated', measured)).toBeUndefined();
        expect(
            resolveTargetRouteForUpdate('manual', { ...measured, sexForEstimate: 'prefer_not_to_say' }),
        ).toBeUndefined();
    });

    it('keeps a manual route while a measured answer is still incomplete', () => {
        // Skip stores no measurements, so a settings edit that supplies a sex
        // alone has not made the estimate calculable and must not claim it has.
        expect(resolveTargetRouteForUpdate('manual', { ...measured, weightKg: null })).toBeUndefined();
    });

    it('never writes a route for a user whose body step is unanswered', () => {
        // The route doubles as the server's proof THAT the body step was
        // answered, so writing one from a partial settings edit would fabricate
        // onboarding progress for measurements never given.
        expect(
            resolveTargetRouteForUpdate(null, { age: null, heightCm: null, weightKg: null, sexForEstimate: 'male' }),
        ).toBeUndefined();
        expect(
            resolveTargetRouteForUpdate(null, {
                age: null,
                heightCm: null,
                weightKg: null,
                sexForEstimate: 'prefer_not_to_say',
            }),
        ).toBeUndefined();
    });

    it('resolves the route for an unanswered body step once the whole answer arrives', () => {
        expect(resolveTargetRouteForUpdate(null, measured)).toBe('estimated');
        expect(
            resolveTargetRouteForUpdate(null, { ...measured, sexForEstimate: 'prefer_not_to_say' }),
        ).toBe('manual');
    });

    it('agrees with the body step on the same answer', () => {
        // One model of which answers are calculable, reachable through two
        // endpoints: a disagreement here is a user whose targets change meaning
        // depending on which screen they edited.
        expect(resolveTargetRouteForUpdate(null, measured)).toBe(
            resolveTargetRouteForBodyStep({
                timeZone: ZONE,
                age: measured.age as number,
                heightCm: measured.heightCm as number,
                weightKg: measured.weightKg as number,
                sexForEstimate: 'male',
                heightUnitPref: 'cm',
                weightUnitPref: 'kg',
            }),
        );
    });
});

describe('reconcileSetupStateForRoute', () => {
    it('pulls a ready-for-review user back to an answer their new route requires', () => {
        // The manual route never asks for an activity level, so a manual user who
        // supplies a measured sex through the full save becomes an estimated user
        // who is missing a required answer — and `ready_for_review` would
        // otherwise promise a plan could be generated from it.
        expect(
            reconcileSetupStateForRoute(
                snapshot({
                    setupStatus: 'ready_for_review',
                    setupStep: 'review',
                    targetRoute: 'manual',
                    answers: allAnswers({ activityLevel: null }),
                }),
                'estimated',
            ),
        ).toEqual({ setupStatus: 'in_progress', setupStep: 'activity' });
    });

    it('never touches a completed user, who already has a plan', () => {
        expect(
            reconcileSetupStateForRoute(
                snapshot({
                    setupStatus: 'completed',
                    setupStep: 'review',
                    targetRoute: 'manual',
                    answers: allAnswers({ activityLevel: null }),
                }),
                'estimated',
            ),
        ).toBeUndefined();
    });

    it('never touches a not-started row, which records no progress to reconcile', () => {
        // That row exists for the legacy user whose first meal-planning write was
        // a target save; it holds targets, not onboarding progress.
        expect(
            reconcileSetupStateForRoute(
                snapshot({ setupStatus: 'not_started', answers: noAnswers() }),
                'estimated',
            ),
        ).toBeUndefined();
    });

    it('leaves a user alone when every required answer of the new route is on record', () => {
        expect(
            reconcileSetupStateForRoute(
                snapshot({
                    setupStatus: 'ready_for_review',
                    setupStep: 'review',
                    targetRoute: 'estimated',
                    answers: allAnswers(),
                }),
                'manual',
            ),
        ).toBeUndefined();
    });

    it('leaves a user alone when the marker already sits at or before the missing answer', () => {
        expect(
            reconcileSetupStateForRoute(
                snapshot({
                    setupStatus: 'in_progress',
                    setupStep: 'activity',
                    targetRoute: 'manual',
                    answers: allAnswers({ activityLevel: null }),
                }),
                'estimated',
            ),
        ).toBeUndefined();
        expect(
            reconcileSetupStateForRoute(
                snapshot({
                    setupStatus: 'in_progress',
                    setupStep: 'body',
                    targetRoute: 'manual',
                    answers: allAnswers({ activityLevel: null }),
                }),
                'estimated',
            ),
        ).toBeUndefined();
    });

    it('reconciles a marker the new route does not contain at all', () => {
        // `targets_manual` is a stop of the manual route only, so an estimated
        // route leaves it as a marker nothing can answer.
        expect(
            reconcileSetupStateForRoute(
                snapshot({
                    setupStatus: 'in_progress',
                    setupStep: 'targets_manual',
                    targetRoute: 'manual',
                    answers: allAnswers({ activityLevel: null }),
                }),
                'estimated',
            ),
        ).toEqual({ setupStatus: 'in_progress', setupStep: 'activity' });
    });

    it('names the FIRST missing answer of the new route', () => {
        expect(
            reconcileSetupStateForRoute(
                snapshot({
                    setupStatus: 'ready_for_review',
                    setupStep: 'review',
                    targetRoute: 'manual',
                    answers: allAnswers({ goal: null, activityLevel: null }),
                }),
                'estimated',
            ),
        ).toEqual({ setupStatus: 'in_progress', setupStep: 'goal' });
    });
});

describe('routeStepOrder and requiredSetupSteps', () => {
    it('walks the estimated route through all seven counted steps', () => {
        expect(requiredSetupSteps('estimated')).toEqual([
            'goal',
            'body',
            'activity',
            'diet',
            'dislikes',
            'schedule',
            'cooking',
        ]);
        expect(requiredSetupSteps('estimated')).toHaveLength(7);
    });

    it('walks the manual route through six, SKIPPING the calculation-only activity step', () => {
        expect(requiredSetupSteps('manual')).toEqual([
            'goal',
            'body',
            'diet',
            'dislikes',
            'schedule',
            'cooking',
        ]);
        expect(requiredSetupSteps('manual')).toHaveLength(6);
        expect(requiredSetupSteps('manual')).not.toContain('activity');
    });

    it('treats an unresolved route as the estimated one', () => {
        expect(routeStepOrder(null)).toEqual(routeStepOrder('estimated'));
    });

    it('puts the manual target screen between the body step and the diet step', () => {
        expect(routeStepOrder('manual')).toEqual([
            'goal',
            'body',
            'targets_manual',
            'diet',
            'dislikes',
            'schedule',
            'cooking',
            'review',
        ]);
    });
});

describe('resolveTargetRouteForBodyStep', () => {
    it('routes Skip to manual targets', () => {
        expect(resolveTargetRouteForBodyStep({ timeZone: ZONE, skipped: true })).toBe('manual');
    });

    it('routes "prefer not to say" to manual targets, though it carries every measurement', () => {
        expect(
            resolveTargetRouteForBodyStep({
                timeZone: ZONE,
                skipped: false,
                age: 34,
                heightCm: 177.8,
                weightKg: 82.6,
                sexForEstimate: 'prefer_not_to_say',
                heightUnitPref: 'cm',
                weightUnitPref: 'kg',
            }),
        ).toBe('manual');
    });

    it.each(['female', 'male'] as const)('routes %s to the calculated estimate', (sexForEstimate) => {
        expect(
            resolveTargetRouteForBodyStep({
                timeZone: ZONE,
                age: 34,
                heightCm: 177.8,
                weightKg: 82.6,
                sexForEstimate,
                heightUnitPref: 'cm',
                weightUnitPref: 'kg',
            }),
        ).toBe('estimated');
    });
});

/* ---------------------------------------------------------------------------
 * setupStateOf — the stored row as the state machine reads it
 *
 * A pure projection with no I/O, so it belongs in this module rather than in
 * `preferences.service.ts`, where it used to sit and be imported ACROSS service
 * boundaries by `targets.service.ts` (Rule backend-architecture §5, §7). Two
 * endpoints can advance the resume marker — a step save, and the manual target
 * confirmation that AAP §0.7.4 routes through `PUT /meal-planning/targets` — and
 * both must read the row through the same closed vocabularies. It had no test at
 * all while it lived in the service; every branch of it is pinned here.
 * ------------------------------------------------------------------------- */

describe('setupStateOf', () => {
    /** Every column answered, so a case can name only what it is about. */
    const row = (overrides: Partial<SetupStateRow> = {}): SetupStateRow => ({
        setup_status: 'in_progress',
        setup_step: 'diet',
        target_route: 'estimated',
        goal: 'lose',
        activity_level: 'lightly_active',
        diet: 'none',
        meal_schedule: 'three',
        cooking_time_limit_min: 30,
        ...overrides,
    });

    it('reads a fully answered row column for column', () => {
        expect(setupStateOf(row())).toEqual({
            setupStatus: 'in_progress',
            setupStep: 'diet',
            targetRoute: 'estimated',
            answers: {
                goal: 'lose',
                activityLevel: 'lightly_active',
                diet: 'none',
                mealSchedule: 'three',
                cookingTimeLimitMin: 30,
            },
        });
    });

    it('reads a missing row as a user who has answered nothing', () => {
        // Not `in_progress`: there is no row to be in progress on, and
        // `nextSetupState` creates the first state from this snapshot.
        expect(setupStateOf(null)).toEqual({
            setupStatus: 'not_started',
            setupStep: null,
            targetRoute: null,
            answers: noAnswers(),
        });
    });

    it.each([...Object.keys(SETUP_STATUSES)] as SetupStatus[])(
        'reads the stored status %s as itself',
        (setup_status) => {
            expect(setupStateOf(row({ setup_status })).setupStatus).toBe(setup_status);
        },
    );

    it.each([...Object.keys(SETUP_STEPS)] as SetupStep[])(
        'reads the stored resume marker %s as itself',
        (setup_step) => {
            expect(setupStateOf(row({ setup_step })).setupStep).toBe(setup_step);
        },
    );

    it.each([null, '', 'completd', 'COMPLETED', 'archived'])(
        'reads the unreadable status %p as in progress, the cautious reading',
        (setup_status) => {
            // A row EXISTS, so the user has answered something; reading it as
            // `not_started` would restart a setup that is under way, and
            // `nextSetupState` is monotonic so it can only move forward from
            // here. Case matters: the column is compared exactly.
            expect(setupStateOf(row({ setup_status })).setupStatus).toBe('in_progress');
        },
    );

    it.each([null, '', 'targets', 'Diet', 'weigh_in'])(
        'reads the unreadable resume marker %p as no marker',
        (setup_step) => {
            expect(setupStateOf(row({ setup_step })).setupStep).toBeNull();
        },
    );

    it.each([null, '', 'estimate', 'Manual', 'assumed'])(
        'reads the unreadable route %p as no route',
        (target_route) => {
            // The route doubles as the record THAT the body step was answered
            // (`PROVABLE_STEP_ANSWERS` proves it by `route !== null`), so an
            // unrecognised value must read as unanswered rather than as a route.
            expect(setupStateOf(row({ target_route })).targetRoute).toBeNull();
        },
    );

    it.each([...Object.keys(TARGET_ROUTES)] as ('estimated' | 'manual')[])(
        'reads the stored route %s as itself',
        (target_route) => {
            expect(setupStateOf(row({ target_route })).targetRoute).toBe(target_route);
        },
    );

    it.each([
        ['goal', 'shrink', 'goal'],
        ['activity_level', 'sprinting', 'activityLevel'],
        ['diet', 'carnivore', 'diet'],
        ['meal_schedule', 'four', 'mealSchedule'],
    ] as const)('reads the retired %s value %p as unanswered', (column, value, answer) => {
        // The columns are plain TEXT with no enum and no CHECK constraint, so a
        // value the vocabulary no longer contains is reachable. Reading it as
        // unanswered RE-ASKS the step; carrying it forward would plan from a
        // string nothing downstream understands.
        expect(setupStateOf(row({ [column]: value })).answers[answer]).toBeNull();
    });

    it.each([0, 37, 29.9, 61, -30, Number.NaN, Number.POSITIVE_INFINITY])(
        'reads the cooking limit %p, which the chips never offered, as unanswered',
        (cooking_time_limit_min) => {
            expect(setupStateOf(row({ cooking_time_limit_min })).answers.cookingTimeLimitMin).toBeNull();
        },
    );

    it.each([15, 30, 45, 60])('reads the offered cooking limit %p as itself', (cooking_time_limit_min) => {
        expect(setupStateOf(row({ cooking_time_limit_min })).answers.cookingTimeLimitMin).toBe(
            cooking_time_limit_min,
        );
    });

    it('reads a row whose answers are all null as answered-nothing but still in progress', () => {
        // The shape a first `goal` save leaves an instant before its columns
        // land, and the shape a route change reads when it newly requires a step
        // the user was never asked.
        expect(
            setupStateOf(
                row({
                    setup_step: null,
                    target_route: null,
                    goal: null,
                    activity_level: null,
                    diet: null,
                    meal_schedule: null,
                    cooking_time_limit_min: null,
                }),
            ),
        ).toEqual({
            setupStatus: 'in_progress',
            setupStep: null,
            targetRoute: null,
            answers: noAnswers(),
        });
    });

    it('feeds nextSetupState directly, which is the only reason it exists', () => {
        // The contract between the two: whatever this projection says, the
        // transition is computed from it and nothing else, so a snapshot of a
        // row mid-route resumes at the next required step of that route.
        expect(nextSetupState(setupStateOf(row({ setup_step: 'diet' })), 'diet', null)).toEqual({
            setupStatus: 'in_progress',
            setupStep: 'dislikes',
            targetRoute: 'estimated',
        });
    });
});

describe('nextSetupState', () => {
    it('creates the row as in progress on the first step and resumes at the next one', () => {
        expect(nextSetupState(snapshot(), 'goal', null)).toEqual({
            setupStatus: 'in_progress',
            setupStep: 'body',
            targetRoute: null,
        });
    });

    it('reaches ready for review after the estimated route\u2019s seven steps', () => {
        const state = walkRoute(requiredSetupSteps('estimated'), 'estimated');

        expect(state.setupStatus).toBe('ready_for_review');
        expect(state.setupStep).toBe('review');
        expect(state.targetRoute).toBe('estimated');
    });

    it('reaches ready for review on the manual route WITHOUT the activity step', () => {
        const state = walkRoute(['goal', 'body', 'targets_manual', 'diet', 'dislikes', 'schedule', 'cooking'], 'manual');

        expect(state.setupStatus).toBe('ready_for_review');
        expect(state.setupStep).toBe('review');
        expect(state.targetRoute).toBe('manual');
    });

    it('records the manual target screen as the resume point after Skip', () => {
        const afterGoal = saveStepState(snapshot(), 'goal', null);
        const afterBody = nextSetupState(afterGoal, 'body', 'manual');

        expect(afterBody).toEqual({
            setupStatus: 'in_progress',
            setupStep: 'targets_manual',
            targetRoute: 'manual',
        });
    });

    it('is not ready for review before the route\u2019s last step', () => {
        const state = walkRoute(['goal', 'body', 'activity', 'diet', 'dislikes', 'schedule'], 'estimated');

        expect(state.setupStatus).toBe('in_progress');
        expect(state.setupStep).toBe('cooking');
    });

    it('does NOT send a completed user back into onboarding when a settings row is re-saved', () => {
        const state = nextSetupState(
            reached('completed', 'review', 'estimated'),
            'diet',
            null,
        );

        expect(state).toEqual({
            setupStatus: 'completed',
            setupStep: 'review',
            targetRoute: 'estimated',
        });
    });

    it.each(['goal', 'body', 'activity', 'dislikes', 'schedule', 'cooking'] as const)(
        'holds a completed user at completed when %s is edited',
        (step) => {
            const state = nextSetupState(
                reached('completed', 'review', 'estimated'),
                step,
                null,
            );

            expect(state.setupStatus).toBe('completed');
            expect(state.setupStep).toBe('review');
        },
    );

    it('holds a ready-for-review user where they are', () => {
        const state = nextSetupState(
            reached('ready_for_review', 'review', 'estimated'),
            'dislikes',
            null,
        );

        expect(state).toEqual({
            setupStatus: 'ready_for_review',
            setupStep: 'review',
            targetRoute: 'estimated',
        });
    });

    it('keeps the resume marker where the user reached when they step back to change an answer', () => {
        const state = nextSetupState(
            reached('in_progress', 'schedule', 'estimated'),
            'goal',
            null,
        );

        expect(state.setupStep).toBe('schedule');
        expect(state.setupStatus).toBe('in_progress');
    });

    it('never promotes on a review save, which only persists a start date', () => {
        const state = nextSetupState(
            reached('in_progress', 'diet', 'estimated'),
            'review',
            null,
        );

        expect(state).toEqual({
            setupStatus: 'in_progress',
            setupStep: 'diet',
            targetRoute: 'estimated',
        });
    });

    it('answers a review save from a user with no marker without claiming progress', () => {
        const state = nextSetupState(snapshot(), 'review', null);

        expect(state).toEqual({
            setupStatus: 'in_progress',
            setupStep: 'goal',
            targetRoute: null,
        });
    });

    it('holds a ready-for-review user through a review save', () => {
        const state = nextSetupState(
            reached('ready_for_review', 'review', 'manual'),
            'review',
            null,
        );

        expect(state.setupStatus).toBe('ready_for_review');
        expect(state.setupStep).toBe('review');
    });

    it('moves nothing when a step the active route does not include is saved', () => {
        const state = nextSetupState(
            reached('in_progress', 'diet', 'manual'),
            'activity',
            null,
        );

        expect(state.setupStep).toBe('diet');
    });

    it('keeps the stored route when the save names none', () => {
        const state = nextSetupState(
            reached('in_progress', 'body', 'manual'),
            'diet',
            null,
        );

        expect(state.targetRoute).toBe('manual');
    });

    it('switches the route when the save names a new one', () => {
        const state = nextSetupState(
            reached('in_progress', 'activity', 'estimated'),
            'body',
            'manual',
        );

        expect(state.targetRoute).toBe('manual');
        expect(state.setupStep).toBe('targets_manual');
    });

    it('advances from the last step to the review screen and no further', () => {
        const state = nextSetupState(
            reached('in_progress', 'cooking', 'estimated'),
            'cooking',
            null,
        );

        expect(state.setupStep).toBe('review');
        expect(state.setupStatus).toBe('ready_for_review');
    });

    describe('progress is sequential, so readiness cannot be claimed by jumping ahead', () => {
        it.each(['body', 'activity', 'diet', 'dislikes', 'schedule', 'cooking'] as const)(
            'earns no progress from %s as the first save, leaving the user at question one',
            (step) => {
                // The parser refuses these outright (only `goal` may create the
                // row), and the state machine must not reward them either: the
                // row could exist already because manual targets were saved
                // from Account before any onboarding.
                const state = nextSetupState(snapshot(), step, null);

                expect(state).toEqual({
                    setupStatus: 'in_progress',
                    setupStep: 'goal',
                    targetRoute: null,
                });
            },
        );

        it('does NOT reach ready for review from a single cooking save', () => {
            const state = nextSetupState(snapshot(), 'cooking', null);

            expect(state.setupStatus).not.toBe('ready_for_review');
            expect(state.setupStep).not.toBe('review');
        });

        it.each([
            ['activity', 'body'],
            ['dislikes', 'body'],
            ['cooking', 'body'],
            ['schedule', 'activity'],
        ] as const)(
            'earns no progress from %s while the user is still on %s',
            (step, marker) => {
                const state = nextSetupState(
                    reached('in_progress', marker, 'estimated'),
                    step,
                    null,
                );

                expect(state.setupStep).toBe(marker);
                expect(state.setupStatus).toBe('in_progress');
            },
        );

        it('earns no progress from the last step while earlier ones are unanswered', () => {
            const state = nextSetupState(
                reached('in_progress', 'diet', 'estimated'),
                'cooking',
                null,
            );

            expect(state).toEqual({
                setupStatus: 'in_progress',
                setupStep: 'diet',
                targetRoute: 'estimated',
            });
        });

        it('earns no progress from the last step on the manual route either', () => {
            const state = nextSetupState(
                reached('in_progress', 'targets_manual', 'manual'),
                'cooking',
                'manual',
            );

            expect(state).toEqual({
                setupStatus: 'in_progress',
                setupStep: 'targets_manual',
                targetRoute: 'manual',
            });
        });

        it('advances only one stop per answered step, however often the jump is retried', () => {
            const first = saveStepState(snapshot(), 'cooking', null);
            const second = saveStepState(first, 'cooking', null);
            const third = saveStepState(second, 'cooking', null);

            expect(third.setupStep).toBe('goal');
            expect(third.setupStatus).toBe('in_progress');
        });

        it('reaches review only by answering every stop in order', () => {
            const jumped = (['cooking', 'schedule', 'dislikes'] as readonly SetupStep[]).reduce(
                (state, step) => saveStepState(state, step, null),
                snapshot(),
            );

            expect(jumped.setupStatus).toBe('in_progress');

            const walked = walkRoute(requiredSetupSteps('estimated'), 'estimated');

            expect(walked.setupStatus).toBe('ready_for_review');
        });

        it('lets the manual route past its target screen once the targets are saved', () => {
            // `targets_manual` is a stop of the route but saves through the
            // targets endpoint, so the save itself is what moves the marker off
            // it — otherwise the manual route would stall there for good.
            const state = nextSetupState(
                reached('in_progress', 'targets_manual', 'manual'),
                'targets_manual',
                'manual',
            );

            expect(state.setupStep).toBe('diet');
        });

        it('also lets the next step past it, since the target screen is not a step save', () => {
            const state = nextSetupState(
                reached('in_progress', 'targets_manual', 'manual'),
                'diet',
                'manual',
            );

            expect(state.setupStep).toBe('dislikes');
        });

        it('moves nothing when the saved step is not a stop of the active route at all', () => {
            // The activity screen is skipped on the manual route, so an edit
            // that re-sends it has no stop to advance from and none to advance
            // to. The marker stays exactly where the user is.
            const state = nextSetupState(
                reached('in_progress', 'activity', 'manual'),
                'activity',
                'manual',
            );

            expect(state).toEqual({
                setupStatus: 'in_progress',
                setupStep: 'activity',
                targetRoute: 'manual',
            });
        });

        it('keeps an edit from a completed user at completed, wherever the edit lands', () => {
            const state = nextSetupState(
                reached('completed', 'review', 'estimated'),
                'cooking',
                null,
            );

            expect(state).toEqual({
                setupStatus: 'completed',
                setupStep: 'review',
                targetRoute: 'estimated',
            });
        });
    });

    describe('a route change reconciles the answers the new route newly requires', () => {
        // The estimated route requires `activity`; the manual route never asks
        // for it. So re-answering the body step with a measured sex moves a
        // manual-route user onto the estimated route and newly requires a step
        // they were never asked. Sequential progress alone cannot see it: the
        // marker sits on a stop both routes share, the body save reads as an
        // edit of an earlier answer, and the walk would carry on to `review`
        // with no activity level ever written — a plan built from a row whose
        // answers were never given.
        const manualAt = (marker: SetupStep) => reached('in_progress', marker, 'manual');

        it.each(['diet', 'dislikes', 'schedule', 'cooking'] as const)(
            'pulls the marker back to activity when a manual row on %s switches to the estimated route',
            (marker) => {
                const state = nextSetupState(manualAt(marker), 'body', 'estimated');

                expect(state.targetRoute).toBe('estimated');
                expect(state.setupStep).toBe('activity');
                expect(state.setupStatus).toBe('in_progress');
            },
        );

        it('never reaches review after the switch, however far the walk continues', () => {
            // The exact sequence the review reproduced: a manual row on `diet`
            // switches route, then walks diet, dislikes, schedule, cooking.
            const switched = saveStepState(manualAt('diet'), 'body', 'estimated');
            const walked = walkRoute(['diet', 'dislikes', 'schedule', 'cooking'], null, switched);

            expect(walked.setupStatus).toBe('in_progress');
            expect(walked.setupStep).toBe('activity');
            expect(walked.answers.activityLevel).toBeNull();
        });

        it('releases the marker as soon as the activity answer is given', () => {
            const switched = saveStepState(manualAt('diet'), 'body', 'estimated');
            const answered = saveStepState(switched, 'activity', null);

            expect(answered.setupStep).toBe('diet');
            expect(answered.setupStatus).toBe('in_progress');
        });

        it('reaches ready for review once the whole estimated route is answered', () => {
            const switched = saveStepState(manualAt('diet'), 'body', 'estimated');
            const walked = walkRoute(
                ['activity', 'diet', 'dislikes', 'schedule', 'cooking'],
                null,
                switched,
            );

            expect(walked.setupStatus).toBe('ready_for_review');
            expect(walked.setupStep).toBe('review');
        });

        it('does not pull back when the activity answer is already on record', () => {
            // Answered on the estimated route, took the manual route, and has
            // now switched back: nothing provable is missing, so nothing moves.
            const state = nextSetupState(
                reached('in_progress', 'schedule', 'manual', {
                    answers: allAnswers({ mealSchedule: null, cookingTimeLimitMin: null }),
                }),
                'body',
                'estimated',
            );

            expect(state.setupStep).toBe('schedule');
            expect(state.setupStatus).toBe('in_progress');
        });

        it('un-readies a manual row that had already reached review', () => {
            const state = nextSetupState(
                reached('ready_for_review', 'review', 'manual'),
                'body',
                'estimated',
            );

            expect(state.setupStatus).toBe('in_progress');
            expect(state.setupStep).toBe('activity');
        });

        it('leaves a completed user completed, who has a plan and edits from settings', () => {
            const state = nextSetupState(reached('completed', 'review', 'manual'), 'body', 'estimated');

            expect(state.setupStatus).toBe('completed');
        });

        it('does not stall the other direction, where the switch requires nothing new', () => {
            // estimated → manual DROPS the activity stop and puts the manual
            // target screen in its place, so nothing is newly missing.
            const state = nextSetupState(reached('in_progress', 'activity', 'estimated'), 'body', 'manual');

            expect(state.targetRoute).toBe('manual');
            expect(state.setupStep).toBe('targets_manual');
        });

        it('reaches ready for review on the manual route after switching back to it', () => {
            const switched = saveStepState(reached('in_progress', 'activity', 'estimated'), 'body', 'manual');
            const walked = walkRoute(
                ['targets_manual', 'diet', 'dislikes', 'schedule', 'cooking'],
                null,
                switched,
            );

            expect(walked.setupStatus).toBe('ready_for_review');
            expect(walked.setupStep).toBe('review');
        });

        it('reconciles a stale marker the active route does not contain at all', () => {
            // A `review` save is the one path that neither advances the marker
            // nor replaces it, so an `activity` marker left behind by a switch
            // to the manual route would survive as a stop nothing can answer.
            // Treating an off-route marker as past everything reconciles it to
            // the first answer actually missing.
            const state = nextSetupState(
                {
                    setupStatus: 'in_progress',
                    setupStep: 'activity',
                    targetRoute: 'manual',
                    answers: allAnswers({ activityLevel: null, diet: null }),
                },
                'review',
                null,
            );

            expect(state.setupStep).toBe('diet');
            expect(state.setupStatus).toBe('in_progress');
        });

        it.each([
            ['goal', 'goal'],
            ['activityLevel', 'activity'],
            ['diet', 'diet'],
            ['mealSchedule', 'schedule'],
            ['cookingTimeLimitMin', 'cooking'],
        ] as const)(
            'never claims readiness while %s is missing, whatever step is saved',
            (answerKey, owningStep) => {
                for (const route of ['estimated', 'manual'] as const) {
                    const requiredHere = requiredSetupSteps(route).includes(owningStep);

                    for (const step of routeStepOrder(route)) {
                        const state = nextSetupState(
                            reached('ready_for_review', 'review', route, {
                                answers: { ...answersReaching('review', route), [answerKey]: null },
                            }),
                            step,
                            null,
                        );

                        // The save itself answers the missing step where they
                        // are the same step, and the manual route does not
                        // require an activity level at all.
                        expect(state.setupStatus).toBe(
                            !requiredHere || step === owningStep ? 'ready_for_review' : 'in_progress',
                        );
                    }
                }
            },
        );
    });

    it('never awards completed itself, which only a published plan earns', () => {
        // `completed` is set where the plan is published, in `mealPlan.service.ts`;
        // this module can only carry a status that is already there. A step save
        // that promoted it would mark setup finished for a user who has no plan.
        for (const route of ['estimated', 'manual'] as const) {
            for (const step of routeStepOrder(route)) {
                for (const setupStatus of ['not_started', 'in_progress', 'ready_for_review'] as const) {
                    const state = reached(setupStatus, 'review', route, { answers: allAnswers() });

                    expect(nextSetupState(state, step, null).setupStatus).not.toBe('completed');
                }
            }
        }
    });

    it('never regresses the status for any route and step combination', () => {
        const statuses: SetupStatus[] = ['not_started', 'in_progress', 'ready_for_review', 'completed'];
        const rank: Record<SetupStatus, number> = {
            not_started: 0,
            in_progress: 1,
            ready_for_review: 2,
            completed: 3,
        };

        for (const setupStatus of statuses) {
            for (const step of routeStepOrder('manual')) {
                const next = nextSetupState(reached(setupStatus, 'review', 'manual'), step, null);

                expect(rank[next.setupStatus]).toBeGreaterThanOrEqual(rank[setupStatus]);
            }
        }
    });
});

/* ---------------------------------------------------------------------------
 * Incompatibility flags
 * ------------------------------------------------------------------------- */

describe('evaluateMealAgainstPreferences', () => {
    it('returns nothing for a meal that still matches every saved answer', () => {
        expect(evaluateMealAgainstPreferences(plannedMeal(plannableRecipe()), planningPreferences())).toEqual(
            [],
        );
    });

    it('flags an allergen the meal carries, naming it in the user\u2019s own spelling', () => {
        const recipe = plannableRecipe({
            ingredients: [ingredient({ snapshot_allergen_tags: ['milk'], snapshot_name: 'Greek yogurt' })],
        });

        const flags = evaluateMealAgainstPreferences(
            plannedMeal(recipe),
            planningPreferences({ allergens: ['milk'] }),
        );

        expect(flags).toEqual([{ code: 'allergen', detail: ['milk'] }]);
    });

    it('flags an allergen carried only by an OPTIONAL ingredient', () => {
        const recipe = plannableRecipe({
            ingredients: [
                ingredient(),
                ingredient({
                    catalog_food_id: UUIDS[1],
                    snapshot_name: 'Feta',
                    snapshot_allergen_tags: ['milk'],
                    is_optional: true,
                }),
            ],
        });

        expect(
            flagCodes(
                evaluateMealAgainstPreferences(
                    plannedMeal(recipe),
                    planningPreferences({ allergens: ['milk'] }),
                ),
            ),
        ).toEqual(['allergen']);
    });

    it('does not flag an allergen the user did not select', () => {
        const recipe = plannableRecipe({
            ingredients: [ingredient({ snapshot_allergen_tags: ['sesame'] })],
        });

        expect(
            evaluateMealAgainstPreferences(plannedMeal(recipe), planningPreferences({ allergens: ['milk'] })),
        ).toEqual([]);
    });

    it('does not read the mutually exclusive "none" answer as an allergen to match', () => {
        const recipe = plannableRecipe({
            ingredients: [ingredient({ snapshot_allergen_tags: [] })],
        });

        expect(
            evaluateMealAgainstPreferences(plannedMeal(recipe), planningPreferences({ allergens: ['none'] })),
        ).toEqual([]);
    });

    it('flags a diet the meal no longer satisfies', () => {
        const recipe = plannableRecipe({
            ingredients: [
                ingredient(),
                ingredient({
                    catalog_food_id: UUIDS[1],
                    snapshot_name: 'Chicken breast',
                    snapshot_diet_tags: [],
                    food_group: 'poultry',
                }),
            ],
        });

        expect(
            evaluateMealAgainstPreferences(plannedMeal(recipe), planningPreferences({ diet: 'vegan' })),
        ).toEqual([{ code: 'diet', detail: ['vegan'] }]);
    });

    it('flags a meal that outgrew the cooking-time limit', () => {
        const flags = evaluateMealAgainstPreferences(
            plannedMeal(plannableRecipe({ total_minutes: 45 })),
            planningPreferences({ cooking_time_limit_min: 30 }),
        );

        expect(flags).toEqual([{ code: 'cooking_time', detail: ['45'] }]);
    });

    it('flags a disliked ingredient by its group, not only by its id', () => {
        const recipe = plannableRecipe({
            ingredients: [
                ingredient({ snapshot_name: 'Mushrooms, white', food_group: 'mushroom' }),
            ],
        });

        expect(
            evaluateMealAgainstPreferences(
                plannedMeal(recipe),
                planningPreferences({ disliked_food_groups: ['mushroom'] }),
            ),
        ).toEqual([{ code: 'dislike', detail: ['Mushrooms, white'] }]);
    });

    it('flags a disliked ingredient by its id', () => {
        expect(
            flagCodes(
                evaluateMealAgainstPreferences(
                    plannedMeal(plannableRecipe()),
                    planningPreferences({ disliked_food_ids: [UUIDS[0]] }),
                ),
            ),
        ).toEqual(['dislike']);
    });

    it('keeps several details under one code, so no offending ingredient is lost', () => {
        const recipe = plannableRecipe({
            ingredients: [
                ingredient({ snapshot_name: 'Greek yogurt', snapshot_allergen_tags: ['milk'] }),
                ingredient({
                    catalog_food_id: UUIDS[1],
                    snapshot_name: 'Tahini',
                    snapshot_allergen_tags: ['sesame'],
                }),
            ],
        });

        const flags = evaluateMealAgainstPreferences(
            plannedMeal(recipe),
            planningPreferences({ allergens: ['milk', 'sesame'] }),
        );

        expect(flags).toHaveLength(1);
        expect(flags[0].code).toBe('allergen');
        // Unsorted: the details come back deterministically ordered too, and
        // sorting the actual value here would hide it if they stopped.
        expect(flags[0].detail).toEqual(['milk', 'sesame']);
    });

    describe('reports every preference conflict a meal has at once, in one stable order', () => {
        // The settings screen renders these in sequence, so the order is part
        // of the contract: asserting a sorted copy would let a nondeterministic
        // or row-order-dependent implementation reshuffle a user's warnings
        // between two reads of an unchanged plan and still pass.
        const CONTRACT_ORDER: MealFlagCode[] = ['allergen', 'diet', 'dislike', 'cooking_time'];

        const conflicted = (reversed = false): PlannedMealForFlagging => {
            const ingredients = [
                ingredient({
                    snapshot_name: 'Feta',
                    snapshot_allergen_tags: ['milk'],
                    snapshot_diet_tags: ['vegetarian'],
                    food_group: 'cheese',
                }),
                ingredient({
                    catalog_food_id: UUIDS[1],
                    snapshot_name: 'Brown rice, cooked',
                    food_group: 'grain',
                }),
            ];

            return plannedMeal(
                plannableRecipe({
                    total_minutes: 60,
                    ingredients: reversed ? [...ingredients].reverse() : ingredients,
                }),
            );
        };

        const allConflicting = planningPreferences({
            diet: 'vegan',
            allergens: ['milk'],
            disliked_food_groups: ['cheese'],
            cooking_time_limit_min: 30,
        });

        it('emits the four codes in the order the eligibility rule declares them', () => {
            expect(flagCodes(evaluateMealAgainstPreferences(conflicted(), allConflicting))).toEqual(
                CONTRACT_ORDER,
            );
        });

        it('emits the same order for identical inputs, call after call', () => {
            const first = flagCodes(evaluateMealAgainstPreferences(conflicted(), allConflicting));
            const second = flagCodes(evaluateMealAgainstPreferences(conflicted(), allConflicting));

            expect(second).toEqual(first);
            expect(second).toEqual(CONTRACT_ORDER);
        });

        it('emits the same order when the ingredients arrive in the opposite order', () => {
            expect(flagCodes(evaluateMealAgainstPreferences(conflicted(true), allConflicting))).toEqual(
                CONTRACT_ORDER,
            );
        });

        it('keeps that relative order for any subset of the four', () => {
            const flags = evaluateMealAgainstPreferences(
                conflicted(),
                planningPreferences({ allergens: ['milk'], cooking_time_limit_min: 30 }),
            );

            expect(flagCodes(flags)).toEqual(['allergen', 'cooking_time']);
        });
    });

    it('drops the structural refusals, which describe a recipe nobody may be served', () => {
        const recipe = plannableRecipe({
            status: 'retired',
            nutrition_provenance: 'ai_estimated',
            allergen_status: 'unknown',
            meal_slots: ['breakfast'],
            ingredients: [
                ingredient({ snapshot_provenance: 'ai_estimated', allergen_status: 'unknown' }),
            ],
        });

        expect(evaluateMealAgainstPreferences(plannedMeal(recipe), planningPreferences())).toEqual([]);
    });

    it('emits only codes the wire contract declares as meal flags', () => {
        const recipe = plannableRecipe({
            status: 'retired',
            total_minutes: 90,
            ingredients: [ingredient({ snapshot_allergen_tags: ['milk'], snapshot_diet_tags: [] })],
        });

        const flags = evaluateMealAgainstPreferences(
            plannedMeal(recipe),
            planningPreferences({ diet: 'vegan', allergens: ['milk'], cooking_time_limit_min: 15 }),
        );

        for (const flag of flags) {
            expect(PREFERENCE_FLAG_CODES).toContain(flag.code);
        }
    });

    it('agrees with the preference-flag vocabulary recipe.logic.ts publishes', () => {
        const declared: MealFlagCode[] = ['diet', 'allergen', 'dislike', 'cooking_time'];

        expect([...PREFERENCE_FLAG_CODES].sort()).toEqual([...declared].sort());
    });

    it('copies the detail arrays, so a caller cannot mutate the verdict it came from', () => {
        const recipe = plannableRecipe({
            ingredients: [ingredient({ snapshot_allergen_tags: ['milk'] })],
        });
        const preferences = planningPreferences({ allergens: ['milk'] });

        const first = evaluateMealAgainstPreferences(plannedMeal(recipe), preferences);
        first[0].detail.push('tampered');

        expect(evaluateMealAgainstPreferences(plannedMeal(recipe), preferences)).toEqual([
            { code: 'allergen', detail: ['milk'] },
        ]);
    });

    it('judges the slot the meal actually holds', () => {
        const recipe = plannableRecipe({ meal_slots: ['breakfast'] });

        // A slot mismatch is structural, so it produces no preference flag — but
        // it must not mask the flags that do apply.
        const flags = evaluateMealAgainstPreferences(
            { slot: 'dinner', recipe },
            planningPreferences({ cooking_time_limit_min: 15 }),
        );

        expect(flagCodes(flags)).toEqual(['cooking_time']);
    });
});
