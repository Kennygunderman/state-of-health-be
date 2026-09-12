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

import {
    ALLERGEN_NONE,
    ALLERGEN_VALUES,
    BODY_INPUT_RANGES,
    BUDGET_AMOUNT_RANGE,
    BUDGET_CURRENCY,
    BUDGET_PER_MEAL_THRESHOLDS,
    deriveBudgetTier,
    deriveDislikedFoodGroups,
    evaluateMealAgainstPreferences,
    feetAndInchesToCentimeters,
    INCHES_TO_CENTIMETERS,
    isCalendarDayKey,
    isClockTime,
    isNoAllergenSelection,
    isPayloadBearingSetupStep,
    MAX_DISLIKED_FOOD_IDS,
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
    parseSetupStep,
    PlannedMealForFlagging,
    POUNDS_TO_KILOGRAMS,
    PREFERENCE_FIELD_CODES,
    PreferencesUpdateContext,
    poundsToKilograms,
    requiredSetupSteps,
    resolveTargetRouteForBodyStep,
    routeStepOrder,
    SetupStateSnapshot,
    SetupStepContext,
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
import { ESTIMATE_INPUT_RANGES } from '../targets.logic';
import { InvalidRequestDetail, MealFlagCode, SetupStatus, SetupStep } from '../../types/mealPlanning';

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

const snapshot = (overrides: Partial<SetupStateSnapshot> = {}): SetupStateSnapshot => ({
    setupStatus: 'not_started',
    setupStep: null,
    targetRoute: null,
    ...overrides,
});

/** Walks a whole route through `nextSetupState`, as the wizard's Continue presses would. */
const walkRoute = (
    steps: readonly SetupStep[],
    route: 'estimated' | 'manual' | null,
): SetupStateSnapshot =>
    steps.reduce<SetupStateSnapshot>((state, step) => {
        const next = nextSetupState(state, step, route);

        return { setupStatus: next.setupStatus, setupStep: next.setupStep, targetRoute: next.targetRoute };
    }, snapshot());

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

describe('isCalendarDayKey', () => {
    it.each([
        ['2026-07-05', true],
        ['2024-02-29', true],
        ['2000-02-29', true],
        ['2026-01-31', true],
        ['2026-12-31', true],
    ])('accepts the real day %s', (value, expected) => {
        expect(isCalendarDayKey(value)).toBe(expected);
    });

    it.each([
        ['2026-02-30', 'a February day that does not exist'],
        ['2023-02-29', 'February 29 of a common year'],
        ['1900-02-29', 'February 29 of a century that is not a leap year'],
        ['2026-04-31', 'a 31st in a 30-day month'],
        ['2026-13-01', 'month 13'],
        ['2026-00-10', 'month 0'],
        ['2026-07-00', 'day 0'],
        ['2026-7-05', 'an unpadded month'],
        ['26-07-05', 'a two-digit year'],
        ['2026-07-05T00:00:00Z', 'a timestamp'],
    ])('refuses %s (%s)', (value) => {
        expect(isCalendarDayKey(value)).toBe(false);
    });

    it.each([undefined, null, 20260705, {}, ['2026-07-05']])('refuses the non-string %p', (value) => {
        expect(isCalendarDayKey(value)).toBe(false);
    });
});

describe('isClockTime', () => {
    it.each(['00:00', '08:00', '12:30', '15:30', '18:30', '23:59'])('accepts %s', (value) => {
        expect(isClockTime(value)).toBe(true);
    });

    it.each([
        ['24:00', 'midnight spelled as the 24th hour is not a time of day'],
        ['23:60', 'minute 60'],
        ['9:05', 'the contract declares HH:mm, so the short form is a second spelling'],
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

    it('refuses an unknown zone through the RangeError rather than a maintained list', () => {
        expect(normalizeTimeZone('Not/AZone')).toBeNull();
        expect(normalizeTimeZone('America/Atlantis')).toBeNull();
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

    it('agrees with the envelope targets.logic refuses to estimate outside of', () => {
        expect(BODY_INPUT_RANGES).toEqual(ESTIMATE_INPUT_RANGES);
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
        it.each([
            [0, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
            [BUDGET_AMOUNT_RANGE.max + 1, PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM],
            [12.5, PREFERENCE_FIELD_CODES.NOT_AN_INTEGER],
            ['120', PREFERENCE_FIELD_CODES.INVALID_TYPE],
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
        ])('reports the amount %p as %s', (amount, code) => {
            expect(codesFor(parseBudgetAnswer({ amount, currency: 'USD' }, false), 'budget.amount')).toEqual(
                [code],
            );
        });

        it.each([1, BUDGET_AMOUNT_RANGE.max])('accepts the amount %s', (amount) => {
            expect(parseBudgetAnswer(usd(amount), false).kind).toBe('ok');
        });
    });

    describe('currency', () => {
        it('accepts the supported currency case-insensitively and stores it canonically', () => {
            const verdict = parseBudgetAnswer({ amount: 120, currency: ' usd ' }, false);

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
    it('accepts an empty selection: the food preferences screen is optional', () => {
        expect(parseDislikedFoodIds([])).toEqual({ kind: 'ok', dislikedFoodIds: [] });
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

        it('ignores an extra key: the closed-key contract belongs to the full save', () => {
            const verdict = parseSetupStep('goal', goalBody({ setupStatus: 'completed' }), stepContext());

            expect(verdict.kind).toBe('ok');
            expect(okPayload<Record<string, unknown>>(verdict).setupStatus).toBeUndefined();
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
            [3.5, PREFERENCE_FIELD_CODES.NOT_AN_INTEGER],
            [-1, PREFERENCE_FIELD_CODES.BELOW_MINIMUM],
        ])('reports the malformed revision %p as a 400 detail (%s)', (expectedRevision, code) => {
            const verdict = parseSetupStep(
                'goal',
                goalBody({ expectedRevision }),
                stepContext({ currentRevision: 3 }),
            );

            expect(codesFor(verdict, 'expectedRevision')).toEqual([code]);
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

        it.each([2, 0, 1.25, '1'])('refuses the pace %p', (paceLbPerWeek) => {
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
            const verdict = parseSetupStep('body', bodyPayload(), stepContext());

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                timeZone: ZONE,
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
            const verdict = parseSetupStep('body', { timeZone: ZONE, skipped: true }, stepContext());

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({ timeZone: ZONE, skipped: true });
        });

        it('accepts an explicit skipped: false alongside measurements', () => {
            expect(parseSetupStep('body', bodyPayload({ skipped: false }), stepContext()).kind).toBe('ok');
        });

        it.each(['yes', 1, {}])('refuses the non-boolean skipped %p', (skipped) => {
            expect(codesFor(parseSetupStep('body', bodyPayload({ skipped }), stepContext()), 'skipped')).toEqual([
                PREFERENCE_FIELD_CODES.INVALID_TYPE,
            ]);
        });

        it('accepts "prefer not to say", which is an answer rather than a gap', () => {
            expect(
                parseSetupStep('body', bodyPayload({ sexForEstimate: 'prefer_not_to_say' }), stepContext()).kind,
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
            const verdict = parseSetupStep('body', bodyPayload({ [field]: value }), stepContext());

            expect(codesFor(verdict, field)).toEqual([code]);
        });

        it('holds the measurements to the envelope', () => {
            const verdict = parseSetupStep('body', bodyPayload({ age: 17, weightKg: 400 }), stepContext());

            expect(codesFor(verdict, 'age')).toEqual([PREFERENCE_FIELD_CODES.BELOW_MINIMUM]);
            expect(codesFor(verdict, 'weightKg')).toEqual([PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM]);
        });

        it('reports a measurement gap and a missing selection together', () => {
            const verdict = parseSetupStep(
                'body',
                bodyPayload({ age: undefined, sexForEstimate: undefined }),
                stepContext(),
            );

            expect(fieldsOf(verdict).sort()).toEqual(['age', 'sexForEstimate']);
        });
    });

    describe('activity', () => {
        it.each(['not_very_active', 'lightly_active', 'active', 'very_active'])(
            'accepts %s',
            (activityLevel) => {
                const verdict = parseSetupStep('activity', { timeZone: ZONE, activityLevel }, stepContext());

                expect(okPayload<Record<string, unknown>>(verdict)).toEqual({ timeZone: ZONE, activityLevel });
            },
        );

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['athlete', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
            [3, PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
        ])('reports %p as %s', (activityLevel, code) => {
            const verdict = parseSetupStep('activity', { timeZone: ZONE, activityLevel }, stepContext());

            expect(codesFor(verdict, 'activityLevel')).toEqual([code]);
        });
    });

    describe('diet', () => {
        it.each(['none', 'vegetarian', 'vegan', 'pescatarian'])('accepts the diet %s', (diet) => {
            const verdict = parseSetupStep(
                'diet',
                { timeZone: ZONE, diet, allergens: ['none'] },
                stepContext(),
            );

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                timeZone: ZONE,
                diet,
                allergens: ['none'],
            });
        });

        it('carries the normalised allergen selection through', () => {
            const verdict = parseSetupStep(
                'diet',
                { timeZone: ZONE, diet: 'none', allergens: ['Tree nuts', 'Milk'] },
                stepContext(),
            );

            expect(okPayload<{ allergens: string[] }>(verdict).allergens).toEqual(['milk', 'tree_nuts']);
        });

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['keto', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
        ])('reports the diet %p as %s', (diet, code) => {
            const verdict = parseSetupStep(
                'diet',
                { timeZone: ZONE, diet, allergens: ['none'] },
                stepContext(),
            );

            expect(codesFor(verdict, 'diet')).toEqual([code]);
        });

        it('reports the diet and the allergens together', () => {
            const verdict = parseSetupStep(
                'diet',
                { timeZone: ZONE, diet: 'keto', allergens: ['none', 'milk'] },
                stepContext(),
            );

            expect(fieldsOf(verdict).sort()).toEqual(['allergens', 'diet']);
        });
    });

    describe('dislikes', () => {
        it('accepts an empty selection', () => {
            const verdict = parseSetupStep(
                'dislikes',
                { timeZone: ZONE, dislikedFoodIds: [] },
                stepContext(),
            );

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                timeZone: ZONE,
                dislikedFoodIds: [],
            });
        });

        it('refuses a malformed id', () => {
            const verdict = parseSetupStep(
                'dislikes',
                { timeZone: ZONE, dislikedFoodIds: ['mushrooms'] },
                stepContext(),
            );

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
            const verdict = parseSetupStep(
                'schedule',
                { timeZone: ZONE, mealSchedule: 'three', mealTimes: times },
                stepContext(),
            );

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                timeZone: ZONE,
                mealSchedule: 'three',
                mealTimes: times,
            });
        });

        it('accepts a snack schedule with the snack between lunch and dinner', () => {
            const verdict = parseSetupStep(
                'schedule',
                {
                    timeZone: ZONE,
                    mealSchedule: 'three_plus_snack',
                    mealTimes: [...times, { slot: 'snack', time: '15:30' }],
                },
                stepContext(),
            );

            expect(verdict.kind).toBe('ok');
        });

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['four', PREFERENCE_FIELD_CODES.UNKNOWN_VALUE],
        ])('reports the schedule %p as %s', (mealSchedule, code) => {
            const verdict = parseSetupStep(
                'schedule',
                { timeZone: ZONE, mealSchedule, mealTimes: times },
                stepContext(),
            );

            expect(codesFor(verdict, 'mealSchedule')).toEqual([code]);
        });

        it('refuses a count that does not match the schedule', () => {
            const verdict = parseSetupStep(
                'schedule',
                { timeZone: ZONE, mealSchedule: 'three_plus_snack', mealTimes: times },
                stepContext(),
            );

            expect(codesFor(verdict, 'mealTimes')).toEqual([PREFERENCE_FIELD_CODES.SLOT_MISMATCH]);
        });
    });

    describe('cooking', () => {
        it.each([15, 30, 45, 60])('accepts the cooking limit %s', (cookingTimeLimitMin) => {
            const verdict = parseSetupStep(
                'cooking',
                { timeZone: ZONE, cookingTimeLimitMin, budget: null, noBudgetPreference: true },
                stepContext(),
            );

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                timeZone: ZONE,
                cookingTimeLimitMin,
                budget: null,
                noBudgetPreference: true,
            });
        });

        it('accepts a weekly amount', () => {
            const verdict = parseSetupStep(
                'cooking',
                {
                    timeZone: ZONE,
                    cookingTimeLimitMin: 30,
                    budget: { amount: 140, currency: 'USD' },
                    noBudgetPreference: false,
                },
                stepContext(),
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
            const verdict = parseSetupStep(
                'cooking',
                { timeZone: ZONE, cookingTimeLimitMin, budget: null, noBudgetPreference: true },
                stepContext(),
            );

            expect(codesFor(verdict, 'cookingTimeLimitMin')).toEqual([code]);
        });

        it('reports the cooking limit and the budget together', () => {
            const verdict = parseSetupStep(
                'cooking',
                { timeZone: ZONE, cookingTimeLimitMin: 20, budget: null, noBudgetPreference: false },
                stepContext(),
            );

            expect(fieldsOf(verdict).sort()).toEqual(['budget', 'cookingTimeLimitMin']);
        });
    });

    describe('review', () => {
        it('accepts a real calendar day', () => {
            const verdict = parseSetupStep(
                'review',
                { timeZone: ZONE, startDate: '2026-07-05' },
                stepContext(),
            );

            expect(okPayload<Record<string, unknown>>(verdict)).toEqual({
                timeZone: ZONE,
                startDate: '2026-07-05',
            });
        });

        it.each([
            [undefined, PREFERENCE_FIELD_CODES.REQUIRED],
            ['2026-02-30', PREFERENCE_FIELD_CODES.INVALID_DATE],
            ['05/07/2026', PREFERENCE_FIELD_CODES.INVALID_DATE],
        ])('reports the start date %p as %s', (startDate, code) => {
            const verdict = parseSetupStep('review', { timeZone: ZONE, startDate }, stepContext());

            expect(codesFor(verdict, 'startDate')).toEqual([code]);
        });
    });

    it('labels each accepted payload with its own step', () => {
        const verdict = parseSetupStep('activity', { timeZone: ZONE, activityLevel: 'active' }, stepContext());

        expect(verdict.kind === 'ok' && verdict.step).toBe('activity');
    });
});

/* ---------------------------------------------------------------------------
 * The full save
 * ------------------------------------------------------------------------- */

describe('parsePreferencesUpdate', () => {
    const payloadOf = (verdict: ReturnType<typeof parsePreferencesUpdate>): Record<string, unknown> => {
        if (verdict.kind !== 'ok') {
            throw new Error(`expected an accepted update, received ${JSON.stringify(verdict)}`);
        }

        return verdict.payload as unknown as Record<string, unknown>;
    };

    it('accepts a valid partial and echoes the pinned revision', () => {
        const verdict = parsePreferencesUpdate({ diet: 'vegan', expectedRevision: 4 }, updateContext());

        expect(payloadOf(verdict)).toEqual({ diet: 'vegan', expectedRevision: 4 });
    });

    it.each([undefined, null, 'diet', [1]])('refuses the body %p', (body) => {
        expect(codesFor(parsePreferencesUpdate(body, updateContext()), 'body')).toEqual([
            PREFERENCE_FIELD_CODES.INVALID_TYPE,
        ]);
    });

    describe('the key set is closed', () => {
        it.each(['setupStatus', 'setupStep', 'revision', 'budgetTier', 'hasActivePlan', 'targetRoute'])(
            'refuses the server-owned key %s rather than ignoring it',
            (key) => {
                const verdict = parsePreferencesUpdate(
                    { [key]: 'completed', expectedRevision: 4 },
                    updateContext(),
                );

                expect(codesFor(verdict, key)).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
            },
        );

        it.each(['nickname', 'userId', 'allergen'])('refuses the unknown key %s', (key) => {
            const verdict = parsePreferencesUpdate({ [key]: 'x', expectedRevision: 4 }, updateContext());

            expect(codesFor(verdict, key)).toEqual([PREFERENCE_FIELD_CODES.READ_ONLY_FIELD]);
        });

        it('names every offending key at once', () => {
            const verdict = parsePreferencesUpdate(
                { setupStatus: 'completed', revision: 9, nickname: 'x', expectedRevision: 4 },
                updateContext(),
            );

            expect(fieldsOf(verdict).sort()).toEqual(['nickname', 'revision', 'setupStatus']);
        });

        it('refuses a save that edits nothing, which would bump the revision for no change', () => {
            expect(codesFor(parsePreferencesUpdate({ expectedRevision: 4 }, updateContext()), 'body')).toEqual([
                PREFERENCE_FIELD_CODES.REQUIRED,
            ]);
        });
    });

    describe('expectedRevision', () => {
        it('refuses a mismatch', () => {
            expect(
                parsePreferencesUpdate({ diet: 'vegan', expectedRevision: 3 }, updateContext()),
            ).toMatchObject({ kind: 'stale_revision', currentRevision: 4 });
        });

        it('refuses its absence, because a full save only ever edits an existing row', () => {
            expect(parsePreferencesUpdate({ diet: 'vegan' }, updateContext())).toMatchObject({
                kind: 'stale_revision',
                currentRevision: 4,
            });
        });

        it('reports a malformed revision as a 400', () => {
            const verdict = parsePreferencesUpdate({ diet: 'vegan', expectedRevision: '4' }, updateContext());

            expect(codesFor(verdict, 'expectedRevision')).toEqual([PREFERENCE_FIELD_CODES.INVALID_TYPE]);
        });
    });

    describe('omitted is not null', () => {
        it('clears a goal weight on an explicit null', () => {
            const verdict = parsePreferencesUpdate(
                { goalWeightKg: null, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose' }),
            );

            expect(payloadOf(verdict)).toEqual({ goalWeightKg: null, expectedRevision: 4 });
        });

        it('clears a pace on an explicit null', () => {
            const verdict = parsePreferencesUpdate(
                { paceLbPerWeek: null, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose' }),
            );

            expect(payloadOf(verdict)).toEqual({ paceLbPerWeek: null, expectedRevision: 4 });
        });

        it('leaves an omitted key out of the payload entirely', () => {
            const verdict = parsePreferencesUpdate({ diet: 'vegan', expectedRevision: 4 }, updateContext());

            expect(Object.keys(payloadOf(verdict)).sort()).toEqual(['diet', 'expectedRevision']);
        });
    });

    describe('switching to maintenance', () => {
        it('normalises the pace and goal weight away, so no row holds a maintained pace', () => {
            const verdict = parsePreferencesUpdate(
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
            const verdict = parsePreferencesUpdate(
                { goal: 'maintain', paceLbPerWeek: 1, expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it('refuses maintenance sent WITH a goal weight', () => {
            const verdict = parsePreferencesUpdate(
                { goal: 'maintain', goalWeightKg: 77, expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'goalWeightKg')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it('refuses a pace edited while the STORED goal is maintenance', () => {
            const verdict = parsePreferencesUpdate(
                { paceLbPerWeek: 1, expectedRevision: 4 },
                updateContext({ currentGoal: 'maintain' }),
            );

            expect(codesFor(verdict, 'paceLbPerWeek')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it('accepts a pace once the same body moves the goal off maintenance', () => {
            const verdict = parsePreferencesUpdate(
                { goal: 'lose', paceLbPerWeek: 1.5, expectedRevision: 4 },
                updateContext({ currentGoal: 'maintain' }),
            );

            expect(payloadOf(verdict)).toEqual({ goal: 'lose', paceLbPerWeek: 1.5, expectedRevision: 4 });
        });
    });

    describe('the goal weight is judged against whichever weight ends up in force', () => {
        it('uses the stored weight when the body changes only the target', () => {
            const verdict = parsePreferencesUpdate(
                { goalWeightKg: 90, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentWeightKg: 82.6 }),
            );

            expect(codesFor(verdict, 'goalWeightKg')).toEqual([
                PREFERENCE_FIELD_CODES.NOT_BELOW_CURRENT_WEIGHT,
            ]);
        });

        it('uses the weight in the same body when it changes too', () => {
            const verdict = parsePreferencesUpdate(
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
            const verdict = parsePreferencesUpdate(
                { goal: 'gain', goalWeightKg: 90, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentWeightKg: 82.6 }),
            );

            expect(verdict.kind).toBe('ok');
        });

        it('refuses a target on the wrong side while gaining', () => {
            const verdict = parsePreferencesUpdate(
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
            const verdict = parsePreferencesUpdate(
                { goalWeightKg: 90, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose', currentWeightKg: null }),
            );

            expect(payloadOf(verdict)).toEqual({ goalWeightKg: 90, expectedRevision: 4 });
        });
    });

    describe('meal times and the schedule that sizes them', () => {
        const times = [
            { slot: 'breakfast', time: '08:00' },
            { slot: 'lunch', time: '12:30' },
            { slot: 'dinner', time: '18:30' },
        ];

        it('judges times against the stored schedule when the body omits one', () => {
            const verdict = parsePreferencesUpdate(
                { mealTimes: times, expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(payloadOf(verdict)).toEqual({ mealTimes: times, expectedRevision: 4 });
        });

        it('refuses times when no schedule is known either way', () => {
            const verdict = parsePreferencesUpdate(
                { mealTimes: times, expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'mealSchedule')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('judges times against the schedule in the same body', () => {
            const verdict = parsePreferencesUpdate(
                { mealSchedule: 'three_plus_snack', mealTimes: times, expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(codesFor(verdict, 'mealTimes')).toEqual([PREFERENCE_FIELD_CODES.SLOT_MISMATCH]);
        });

        it('requires new times when the schedule CHANGES, since the stored set is the wrong size', () => {
            const verdict = parsePreferencesUpdate(
                { mealSchedule: 'three_plus_snack', expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(codesFor(verdict, 'mealTimes')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('accepts a schedule re-sent unchanged without times', () => {
            const verdict = parsePreferencesUpdate(
                { mealSchedule: 'three', expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(payloadOf(verdict)).toEqual({ mealSchedule: 'three', expectedRevision: 4 });
        });

        it('refuses an unknown schedule', () => {
            const verdict = parsePreferencesUpdate(
                { mealSchedule: 'five', expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'mealSchedule')).toEqual([PREFERENCE_FIELD_CODES.UNKNOWN_VALUE]);
        });

        it('reports a cleared schedule as required, not as an unknown value', () => {
            const verdict = parsePreferencesUpdate(
                { mealSchedule: null, expectedRevision: 4 },
                updateContext({ currentMealSchedule: 'three' }),
            );

            expect(codesFor(verdict, 'mealSchedule')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('requires times on a first schedule save, when there is no stored set to keep', () => {
            const verdict = parsePreferencesUpdate(
                { mealSchedule: 'three', expectedRevision: 4 },
                updateContext({ currentMealSchedule: null }),
            );

            expect(codesFor(verdict, 'mealTimes')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });
    });

    describe('the budget pair', () => {
        it('clears a stored amount when no preference becomes the answer', () => {
            const verdict = parsePreferencesUpdate(
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
            const verdict = parsePreferencesUpdate(
                { noBudgetPreference: false, expectedRevision: 4 },
                updateContext({ currentBudget: null, currentNoBudgetPreference: true }),
            );

            expect(codesFor(verdict, 'budget')).toEqual([PREFERENCE_FIELD_CODES.REQUIRED]);
        });

        it('accepts an amount against a stored "no preference" of false', () => {
            const verdict = parsePreferencesUpdate(
                { budget: { amount: 150, currency: 'usd' }, expectedRevision: 4 },
                updateContext({ currentNoBudgetPreference: false }),
            );

            expect(payloadOf(verdict)).toEqual({
                budget: { amount: 150, currency: BUDGET_CURRENCY },
                noBudgetPreference: false,
                expectedRevision: 4,
            });
        });

        it('refuses an amount while the stored answer is "no preference"', () => {
            const verdict = parsePreferencesUpdate(
                { budget: { amount: 150, currency: 'USD' }, expectedRevision: 4 },
                updateContext({ currentNoBudgetPreference: true }),
            );

            expect(codesFor(verdict, 'budget')).toEqual([PREFERENCE_FIELD_CODES.NOT_ALLOWED]);
        });

        it('accepts both halves changing together', () => {
            const verdict = parsePreferencesUpdate(
                { budget: { amount: 210, currency: 'USD' }, noBudgetPreference: false, expectedRevision: 4 },
                updateContext({ currentNoBudgetPreference: true }),
            );

            expect(verdict.kind).toBe('ok');
        });
    });

    describe('the remaining editable keys', () => {
        it('accepts every measurement, selection and preference at once', () => {
            const verdict = parsePreferencesUpdate(
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

            expect(payloadOf(verdict)).toEqual({
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
                timeZone: normalizeTimeZone('UTC'),
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
            const verdict = parsePreferencesUpdate(
                { [field]: value, expectedRevision: 4 },
                updateContext({ currentGoal: 'lose' }),
            );

            expect(codesFor(verdict, field)).toEqual([code]);
        });

        it('carries an allergen contradiction through from the shared rule', () => {
            const verdict = parsePreferencesUpdate(
                { allergens: ['none', 'milk'], expectedRevision: 4 },
                updateContext(),
            );

            expect(codesFor(verdict, 'allergens')).toEqual([PREFERENCE_FIELD_CODES.MUTUALLY_EXCLUSIVE]);
        });

        it('carries a malformed dislike id through from the shared rule', () => {
            const verdict = parsePreferencesUpdate(
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
            const verdict = parsePreferencesUpdate(
                { dislikedFoodGroups, expectedRevision: 4 },
                updateContext(),
            );

            expect(detailsOf(verdict)[0].code).toBe(code);
        });

        it('bounds the food-group list', () => {
            const verdict = parsePreferencesUpdate(
                {
                    dislikedFoodGroups: Array.from({ length: MAX_DISLIKED_FOOD_IDS + 1 }, (_, i) => `g${i}`),
                    expectedRevision: 4,
                },
                updateContext(),
            );

            expect(codesFor(verdict, 'dislikedFoodGroups')).toEqual([PREFERENCE_FIELD_CODES.TOO_MANY]);
        });

        it('reports a read-only key and a field error in the same refusal', () => {
            const verdict = parsePreferencesUpdate(
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

        expect(state).toEqual({
            setupStatus: 'ready_for_review',
            setupStep: 'review',
            targetRoute: 'estimated',
        });
    });

    it('reaches ready for review on the manual route WITHOUT the activity step', () => {
        const state = walkRoute(['goal', 'body', 'targets_manual', 'diet', 'dislikes', 'schedule', 'cooking'], 'manual');

        expect(state).toEqual({
            setupStatus: 'ready_for_review',
            setupStep: 'review',
            targetRoute: 'manual',
        });
    });

    it('records the manual target screen as the resume point after Skip', () => {
        const afterGoal = nextSetupState(snapshot(), 'goal', null);
        const afterBody = nextSetupState(
            { ...afterGoal, setupStep: afterGoal.setupStep },
            'body',
            'manual',
        );

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
            snapshot({ setupStatus: 'completed', setupStep: 'review', targetRoute: 'estimated' }),
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
                snapshot({ setupStatus: 'completed', setupStep: 'review', targetRoute: 'estimated' }),
                step,
                null,
            );

            expect(state.setupStatus).toBe('completed');
            expect(state.setupStep).toBe('review');
        },
    );

    it('holds a ready-for-review user where they are', () => {
        const state = nextSetupState(
            snapshot({ setupStatus: 'ready_for_review', setupStep: 'review', targetRoute: 'estimated' }),
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
            snapshot({ setupStatus: 'in_progress', setupStep: 'schedule', targetRoute: 'estimated' }),
            'goal',
            null,
        );

        expect(state.setupStep).toBe('schedule');
        expect(state.setupStatus).toBe('in_progress');
    });

    it('never promotes on a review save, which only persists a start date', () => {
        const state = nextSetupState(
            snapshot({ setupStatus: 'in_progress', setupStep: 'diet', targetRoute: 'estimated' }),
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
            snapshot({ setupStatus: 'ready_for_review', setupStep: 'review', targetRoute: 'manual' }),
            'review',
            null,
        );

        expect(state.setupStatus).toBe('ready_for_review');
        expect(state.setupStep).toBe('review');
    });

    it('moves nothing when a step the active route does not include is saved', () => {
        const state = nextSetupState(
            snapshot({ setupStatus: 'in_progress', setupStep: 'diet', targetRoute: 'manual' }),
            'activity',
            null,
        );

        expect(state.setupStep).toBe('diet');
    });

    it('keeps the stored route when the save names none', () => {
        const state = nextSetupState(
            snapshot({ setupStatus: 'in_progress', setupStep: 'body', targetRoute: 'manual' }),
            'diet',
            null,
        );

        expect(state.targetRoute).toBe('manual');
    });

    it('switches the route when the save names a new one', () => {
        const state = nextSetupState(
            snapshot({ setupStatus: 'in_progress', setupStep: 'activity', targetRoute: 'estimated' }),
            'body',
            'manual',
        );

        expect(state.targetRoute).toBe('manual');
        expect(state.setupStep).toBe('targets_manual');
    });

    it('advances from the last step to the review screen and no further', () => {
        const state = nextSetupState(
            snapshot({ setupStatus: 'in_progress', setupStep: 'cooking', targetRoute: 'estimated' }),
            'cooking',
            null,
        );

        expect(state.setupStep).toBe('review');
        expect(state.setupStatus).toBe('ready_for_review');
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
                const next = nextSetupState(
                    snapshot({ setupStatus, setupStep: 'review', targetRoute: 'manual' }),
                    step,
                    null,
                );

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
        expect(flags[0].detail.sort()).toEqual(['milk', 'sesame']);
    });

    it('reports every preference conflict a meal has at once', () => {
        const recipe = plannableRecipe({
            total_minutes: 60,
            ingredients: [
                ingredient({
                    snapshot_name: 'Feta',
                    snapshot_allergen_tags: ['milk'],
                    snapshot_diet_tags: ['vegetarian'],
                    food_group: 'cheese',
                }),
            ],
        });

        const flags = evaluateMealAgainstPreferences(
            plannedMeal(recipe),
            planningPreferences({
                diet: 'vegan',
                allergens: ['milk'],
                disliked_food_groups: ['cheese'],
                cooking_time_limit_min: 30,
            }),
        );

        expect(flagCodes(flags).sort()).toEqual(['allergen', 'cooking_time', 'diet', 'dislike']);
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
