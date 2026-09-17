// Unit tests for the pure nutrition-target domain.
//
// Grouped by function, weighted towards edge cases: the values asserted here
// are the product policy, so a test that only restated the code would be worth
// nothing. What each group is actually pinning:
//
//  * the reference derivation, end to end, to the exact kcal and gram;
//  * the SIGN of the goal adjustment in both directions, because inverting it
//    would turn every weight-loss plan into a gain plan;
//  * the floor binding for EVERY goal, because gating it on weight loss would
//    present a 467 kcal target to a maintenance user at the low corner of the
//    supported envelope;
//  * `>` versus `>=` at every bound and threshold, because those decide whether
//    a user-visible caption or warning appears at all;
//  * that a macro of 0 is refused and that nothing is ever rebalanced;
//  * the four ways stored targets stop being attributable to a route;
//  * the complete × source matrix the planner gates generation on, so that gate
//    is readable off the tests without consulting the planner;
//  * that a persisted manual route refuses an estimate even when every
//    measurement is still on the row, because Skip retains the measurements it
//    was answered over and only the route records the user's choice;
//  * staleness as ANCESTRY, which is the whole of the rule: a confirmed
//    estimate is stale exactly when `targets_input_revision` no longer equals
//    the preferences `revision` it was derived from (AAP 0.5.2). `revision` is
//    the all-purpose preferences counter, so EVERY save advances it and any
//    save — a diet or schedule edit as much as an activity one — can make a
//    confirmed estimate stale. That is the contract, not a defect: the user is
//    asked to recalculate, and the figure only changes if they do.
//
// No database, no mocks, no clock: every function under test is pure, and the
// determinism group asserts that directly.

import {
    ACTIVITY_FACTORS,
    applyTargetBounds,
    assessFeasibility,
    buildStoredEstimate,
    CALORIE_CEILING,
    CALORIE_FLOOR_BY_SEX,
    CalculableEstimateInputs,
    calculateBmr,
    calculateGoalAdjustment,
    calculateTdee,
    computeTargetEstimate,
    deriveMacroTargets,
    deriveTargetsResponse,
    ESTIMATED_SAVE_KEYS,
    EstimateAvailabilityRow,
    EstimateInputsRow,
    KCAL_PER_POUND_PER_WEEK_PER_DAY,
    MANUAL_CALORIE_RANGE,
    MANUAL_MACRO_RANGE,
    MANUAL_SAVE_KEYS,
    ParsedSaveTargets,
    parseManualTargets,
    parseOptionalRevision,
    parseRequiredRevision,
    parseSaveTargetsRequest,
    resolveEstimateInputs,
    resolveManualTargetSetupAdvance,
    TARGET_SOURCES,
    TargetsPreferencesRow,
    TargetsUserRow,
} from '../targets.logic';
// The save envelope reports an unrecognised `source` with the code the
// preferences parsers publish for a value outside a closed set, and bounds
// every revision by the one `MAX_REVISION` this layer shares. Both are
// imported from the module that owns them rather than restated here — as is
// `nextSetupState`, which the setup-advance group asserts against rather than
// restating the route order it owns.
import {
    MAX_REVISION,
    PREFERENCE_FIELD_CODES,
    SetupStateSnapshot,
    nextSetupState,
} from '../preferences.logic';
import { ActivityLevel, TargetsResponse } from '../../types/mealPlanning';

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

/**
 * The reference user: female, 34, 177.8 cm, 82.6 kg, lightly active, losing
 * 1 lb a week. Chosen because every step of her derivation is an awkward
 * number — a 1606.25 kcal basal rate and a 2208.59 kcal maintenance rate — so
 * any change to the rounding order moves the result.
 *
 * `target_route: 'estimated'` is part of the fixture, not decoration: a row on
 * the manual route yields no estimate however complete its measurements are,
 * so every "usable preferences" case has to state the route it is usable on.
 */
const REFERENCE_ROW: EstimateAvailabilityRow = {
    target_route: 'estimated',
    goal: 'lose',
    pace_lb_per_week: 1,
    age: 34,
    height_cm: 177.8,
    weight_kg: 82.6,
    sex_for_estimate: 'female',
    activity_level: 'lightly_active',
};

/** The low corner of the supported envelope: a 389 kcal basal rate. */
const LOW_CORNER: EstimateAvailabilityRow = {
    target_route: 'estimated',
    goal: 'maintain',
    pace_lb_per_week: null,
    age: 100,
    height_cm: 120,
    weight_kg: 30,
    sex_for_estimate: 'female',
    activity_level: 'not_very_active',
};

/** The high corner: a 4477.5 kcal basal rate and a 7723.69 kcal maintenance rate. */
const HIGH_CORNER: EstimateAvailabilityRow = {
    target_route: 'estimated',
    goal: 'maintain',
    pace_lb_per_week: null,
    age: 18,
    height_cm: 250,
    weight_kg: 300,
    sex_for_estimate: 'male',
    activity_level: 'very_active',
};

const readyInputs = (row: EstimateAvailabilityRow): CalculableEstimateInputs => {
    const resolved = resolveEstimateInputs(row);

    if (resolved.kind !== 'ready') {
        throw new Error(`fixture is not estimable: ${resolved.reason}`);
    }

    return resolved.inputs;
};

const estimateFrom = (row: EstimateAvailabilityRow, estimateRevision = 0) =>
    computeTargetEstimate(readyInputs(row), estimateRevision);

const CONFIRMED = { calories: 1940, protein: 146, carbs: 194, fat: 65 };

const userRow = (overrides: Partial<TargetsUserRow> = {}): TargetsUserRow => ({
    target_calories: CONFIRMED.calories,
    target_protein_g: CONFIRMED.protein,
    target_carbs_g: CONFIRMED.carbs,
    target_fat_g: CONFIRMED.fat,
    ...overrides,
});

const EMPTY_USER_ROW: TargetsUserRow = {
    target_calories: null,
    target_protein_g: null,
    target_carbs_g: null,
    target_fat_g: null,
};

/**
 * A confirmed estimate, fresh. `targets_input_revision` equals `revision`,
 * which is what "fresh" means (AAP §0.5.2): the figure was confirmed at the
 * preferences revision the row still stands at. Moving either of the two apart
 * is how a case reaches `stale`.
 */
const preferencesRow = (overrides: Partial<TargetsPreferencesRow> = {}): TargetsPreferencesRow => ({
    target_source: 'estimated',
    targets_revision: 3,
    confirmed_targets: { ...CONFIRMED },
    targets_input_revision: 9,
    revision: 9,
    ...overrides,
});

const MANUAL_BODY = { calories: 1940, protein: 146, carbs: 194, fat: 65 };

const manualBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    ...MANUAL_BODY,
    ...overrides,
});

/** The codes reported for a body, keyed by field, for concise assertions. */
const manualErrorCodes = (body: unknown): Record<string, string> => {
    const parsed = parseManualTargets(body);

    if (parsed.kind !== 'error') {
        throw new Error('expected the body to be refused');
    }

    const codes: Record<string, string> = {};
    for (const detail of parsed.details) {
        codes[detail.field] = detail.code;
    }

    return codes;
};

/* ---------------------------------------------------------------------------
 * calculateBmr
 * ------------------------------------------------------------------------- */

describe('calculateBmr', () => {
    it('applies the female Mifflin–St Jeor constant at full precision', () => {
        // 10(82.6) + 6.25(177.8) − 5(34) − 161
        expect(calculateBmr('female', 82.6, 177.8, 34)).toBeCloseTo(1606.25, 10);
    });

    it('applies the male constant, which differs from the female one by 166 kcal', () => {
        expect(calculateBmr('male', 82.6, 177.8, 34)).toBeCloseTo(1772.25, 10);
        expect(calculateBmr('male', 82.6, 177.8, 34) - calculateBmr('female', 82.6, 177.8, 34)).toBeCloseTo(
            166,
            10,
        );
    });

    it('does not round, so the activity factor is applied to the exact rate', () => {
        // The whole reason the reference case lands on 2209 rather than 2208.
        expect(calculateBmr('female', 82.6, 177.8, 34) % 1).not.toBe(0);
    });

    it('decreases with age and increases with mass and height', () => {
        const baseline = calculateBmr('female', 82.6, 177.8, 34);

        expect(calculateBmr('female', 82.6, 177.8, 35)).toBeCloseTo(baseline - 5, 10);
        expect(calculateBmr('female', 83.6, 177.8, 34)).toBeCloseTo(baseline + 10, 10);
        expect(calculateBmr('female', 82.6, 178.8, 34)).toBeCloseTo(baseline + 6.25, 10);
    });

    it('holds at both corners of the supported envelope', () => {
        expect(calculateBmr('female', 30, 120, 100)).toBeCloseTo(389, 10);
        expect(calculateBmr('male', 300, 250, 18)).toBeCloseTo(4477.5, 10);
    });
});

/* ---------------------------------------------------------------------------
 * calculateTdee
 * ------------------------------------------------------------------------- */

describe('calculateTdee', () => {
    describe('the four activity factors', () => {
        it('multiplies by 1.2 for not very active', () => {
            expect(calculateTdee(2000, 'not_very_active')).toBeCloseTo(2400, 10);
        });

        it('multiplies by 1.375 for lightly active', () => {
            expect(calculateTdee(2000, 'lightly_active')).toBeCloseTo(2750, 10);
        });

        it('multiplies by 1.55 for active', () => {
            expect(calculateTdee(2000, 'active')).toBeCloseTo(3100, 10);
        });

        it('multiplies by 1.725 for very active', () => {
            expect(calculateTdee(2000, 'very_active')).toBeCloseTo(3450, 10);
        });
    });

    it('uses the declared product-policy factors', () => {
        expect(ACTIVITY_FACTORS).toEqual({
            not_very_active: 1.2,
            lightly_active: 1.375,
            active: 1.55,
            very_active: 1.725,
        });
    });

    it('applies the factor exactly once, never compounding it', () => {
        // Applying it twice would yield 3781.25 for the reference user.
        expect(calculateTdee(1606.25, 'lightly_active')).toBeCloseTo(2208.59375, 10);
    });

    it('cannot add logged workout or run energy on top, because it takes no such parameter', () => {
        // The activity factor already accounts for the user's usual training,
        // so adding logged sessions would count it twice. The signature is what
        // makes that impossible: a basal rate and a level, and nothing else.
        expect(calculateTdee).toHaveLength(2);
        expect(calculateTdee(2000, 'active')).toBeCloseTo(3100, 10);
    });

    it('yields NaN for an unrecognised level rather than defaulting, which is why the guard upstream matters', () => {
        // The activity column is plain TEXT with no enum, so an unrecognised
        // value has no factor. Silently defaulting to 1.2 would present a
        // plausible-looking target built on a value nobody chose; NaN cannot be
        // mistaken for one, and resolveEstimateInputs refuses the row first.
        expect(calculateTdee(2000, 'extremely_active' as ActivityLevel)).toBeNaN();
        expect(resolveEstimateInputs({ ...REFERENCE_ROW, activity_level: 'extremely_active' })).toEqual({
            kind: 'unavailable',
            reason: 'missing_inputs',
        });
    });

    it('is strictly increasing across the levels', () => {
        const rates = (['not_very_active', 'lightly_active', 'active', 'very_active'] as const).map((level) =>
            calculateTdee(1606.25, level),
        );

        expect(rates[0]).toBeLessThan(rates[1]);
        expect(rates[1]).toBeLessThan(rates[2]);
        expect(rates[2]).toBeLessThan(rates[3]);
    });
});

/* ---------------------------------------------------------------------------
 * calculateGoalAdjustment
 * ------------------------------------------------------------------------- */

describe('calculateGoalAdjustment', () => {
    it('derives 500 kcal a day per pound a week from 3500 kcal a pound', () => {
        expect(KCAL_PER_POUND_PER_WEEK_PER_DAY).toBe(500);
    });

    describe('losing weight', () => {
        it('subtracts 250, 500 and 750 kcal for the three offered paces', () => {
            expect(calculateGoalAdjustment('lose', 0.5)).toBe(-250);
            expect(calculateGoalAdjustment('lose', 1)).toBe(-500);
            expect(calculateGoalAdjustment('lose', 1.5)).toBe(-750);
        });
    });

    describe('gaining weight', () => {
        it('adds the same three magnitudes', () => {
            expect(calculateGoalAdjustment('gain', 0.5)).toBe(250);
            expect(calculateGoalAdjustment('gain', 1)).toBe(500);
            expect(calculateGoalAdjustment('gain', 1.5)).toBe(750);
        });

        it('is the exact negation of the loss adjustment at every pace', () => {
            for (const pace of [0.5, 1, 1.5] as const) {
                expect(calculateGoalAdjustment('gain', pace)).toBe(-calculateGoalAdjustment('lose', pace));
            }
        });
    });

    describe('maintaining weight', () => {
        it('adjusts by nothing', () => {
            expect(calculateGoalAdjustment('maintain', null)).toBe(0);
        });

        it('ignores a pace that should not be there', () => {
            expect(calculateGoalAdjustment('maintain', 1.5)).toBe(0);
        });
    });

    it('treats an absent pace as no adjustment, which resolveEstimateInputs refuses upstream', () => {
        // Reaching this arm with a directional goal would show maintenance
        // calories on a weight-loss plan, so the gate is what is load-bearing.
        expect(calculateGoalAdjustment('lose', null)).toBe(0);
        expect(resolveEstimateInputs({ ...REFERENCE_ROW, pace_lb_per_week: null })).toEqual({
            kind: 'unavailable',
            reason: 'missing_inputs',
        });
    });
});

/* ---------------------------------------------------------------------------
 * applyTargetBounds
 * ------------------------------------------------------------------------- */

describe('applyTargetBounds', () => {
    it('uses the declared product-policy bounds', () => {
        expect(CALORIE_FLOOR_BY_SEX).toEqual({ female: 1200, male: 1500 });
        expect(CALORIE_CEILING).toBe(5000);
    });

    describe('nothing bound', () => {
        it('reports no clamp and no reason', () => {
            expect(applyTargetBounds(1709, 1606.25, 'female')).toEqual({
                calories: 1709,
                clamped: false,
                clampReason: null,
            });
        });

        it('treats a figure exactly at the floor as unclamped', () => {
            // `>` not `>=`: sitting on the bound is not being moved by it.
            expect(applyTargetBounds(1200, 1000, 'female')).toEqual({
                calories: 1200,
                clamped: false,
                clampReason: null,
            });
        });

        it('treats a figure exactly at the basal rate as unclamped', () => {
            expect(applyTargetBounds(1800, 1800, 'male')).toEqual({
                calories: 1800,
                clamped: false,
                clampReason: null,
            });
        });

        it('treats a figure exactly at the ceiling as unclamped', () => {
            expect(applyTargetBounds(5000, 1800, 'male')).toEqual({
                calories: 5000,
                clamped: false,
                clampReason: null,
            });
        });
    });

    describe('the sex floor', () => {
        it('raises a figure one kcal below it and reports floor', () => {
            expect(applyTargetBounds(1199, 1000, 'female')).toEqual({
                calories: 1200,
                clamped: true,
                clampReason: 'floor',
            });
        });

        it('raises a figure a fraction of a kcal below it and reports floor', () => {
            // The bound is applied to the adjusted value and the rounding is
            // the last step, so a 1199.6 kcal result is below the 1200 kcal
            // floor and the floor is what decides the 1200 the user sees —
            // the caption belongs on it. Comparing the rounded figure instead
            // would present the floor's own number as the user's own.
            expect(applyTargetBounds(1199.6, 1000, 'female')).toEqual({
                calories: 1200,
                clamped: true,
                clampReason: 'floor',
            });
        });

        it('applies the higher male floor', () => {
            expect(applyTargetBounds(1400, 1000, 'male')).toEqual({
                calories: 1500,
                clamped: true,
                clampReason: 'floor',
            });
        });

        it('reports floor when the basal rate exactly equals it', () => {
            // Both lower bounds hold; the app's own published minimum is the
            // attribution that always stands.
            expect(applyTargetBounds(690, 1200, 'female')).toEqual({
                calories: 1200,
                clamped: true,
                clampReason: 'floor',
            });
        });

        it('reports floor rather than below_bmr when the floor is the larger of the two lower bounds', () => {
            // The low corner of the supported envelope, where a 389 kcal basal
            // rate sits far below the 1200 kcal floor. Both lower bounds apply
            // and the higher one decides, so the reason names the floor for
            // every goal: maintenance at 466.8 kcal and the fastest permitted
            // loss at −283.2 kcal alike.
            expect(applyTargetBounds(466.8, 389, 'female')).toEqual({
                calories: 1200,
                clamped: true,
                clampReason: 'floor',
            });
            expect(applyTargetBounds(-283.2, 389, 'female')).toEqual({
                calories: 1200,
                clamped: true,
                clampReason: 'floor',
            });
        });
    });

    describe('the basal rate', () => {
        it('raises the figure and reports below_bmr when it exceeds the floor', () => {
            expect(applyTargetBounds(1410, 1800, 'male')).toEqual({
                calories: 1800,
                clamped: true,
                clampReason: 'below_bmr',
            });
        });

        it('rounds the figure the basal bound produced, so the result is always a whole kcal', () => {
            expect(applyTargetBounds(1000, 1799.6, 'male')).toEqual({
                calories: 1800,
                clamped: true,
                clampReason: 'below_bmr',
            });
        });

        it('reports below_bmr for a shortfall of a fraction of a kcal, the same rule the floor gets', () => {
            // The mirror of the 1199.6 floor case: the 1606.25 kcal basal rate
            // decides the 1606 kcal presented, so it is the reported bound. No
            // bound carries a visibility threshold the other two do not.
            expect(applyTargetBounds(1606, 1606.25, 'female')).toEqual({
                calories: 1606,
                clamped: true,
                clampReason: 'below_bmr',
            });
        });
    });

    describe('the ceiling', () => {
        it('caps a figure one kcal above it and reports ceiling', () => {
            expect(applyTargetBounds(5001, 1800, 'male')).toEqual({
                calories: 5000,
                clamped: true,
                clampReason: 'ceiling',
            });
        });

        it('is applied last, so it is the reason even when a lower bound also raised the figure', () => {
            expect(applyTargetBounds(900, 6000, 'female')).toEqual({
                calories: 5000,
                clamped: true,
                clampReason: 'ceiling',
            });
        });
    });

    it('always returns a whole number of kcal', () => {
        for (const value of [1708.59375, 1709.5, 2208.6, -283.2]) {
            expect(applyTargetBounds(value, 1606.25, 'female').calories % 1).toBe(0);
        }
    });
});

/* ---------------------------------------------------------------------------
 * deriveMacroTargets
 * ------------------------------------------------------------------------- */

describe('deriveMacroTargets', () => {
    it('splits the review screen figure into 146 P / 194 C / 65 F', () => {
        expect(deriveMacroTargets(1940)).toEqual({
            calories: 1940,
            protein: 146,
            carbs: 194,
            fat: 65,
        });
    });

    it('splits the reference target into 128 P / 171 C / 57 F', () => {
        expect(deriveMacroTargets(1709)).toEqual({
            calories: 1709,
            protein: 128,
            carbs: 171,
            fat: 57,
        });
    });

    it('splits a floored target into the macros of the floor, not of the raw figure', () => {
        expect(deriveMacroTargets(1200)).toEqual({
            calories: 1200,
            protein: 90,
            carbs: 120,
            fat: 40,
        });
    });

    it('echoes the calorie figure so the four values cannot drift apart', () => {
        expect(deriveMacroTargets(2345).calories).toBe(2345);
    });

    it('returns whole grams', () => {
        for (const calories of [1200, 1709, 1940, 2345, 5000]) {
            const derived = deriveMacroTargets(calories);

            expect(derived.protein % 1).toBe(0);
            expect(derived.carbs % 1).toBe(0);
            expect(derived.fat % 1).toBe(0);
        }
    });

    it('accounts for the calorie figure to within rounding', () => {
        for (const calories of [1200, 1709, 1940, 5000]) {
            const derived = deriveMacroTargets(calories);
            const macroEnergy = derived.protein * 4 + derived.carbs * 4 + derived.fat * 9;

            expect(Math.abs(macroEnergy - calories)).toBeLessThanOrEqual(10);
        }
    });

    describe('rounding direction', () => {
        it('rounds a half gram up', () => {
            // 1940 kcal puts protein on exactly 145.5 g (30 % of 1940 ÷ 4), so
            // the direction is visible rather than incidental: half away from
            // zero, not half to even, which would give 146 here but 144 at a
            // figure whose share landed on 144.5.
            expect((1940 * 0.3) / 4).toBe(145.5);
            expect(deriveMacroTargets(1940).protein).toBe(146);
        });

        it('rounds every macro the same way', () => {
            // 1215 kcal lands carbohydrate on 121.5 g and fat on 40.5 g.
            expect((1215 * 0.4) / 4).toBe(121.5);
            expect((1215 * 0.3) / 9).toBe(40.5);
            expect(deriveMacroTargets(1215)).toEqual({
                calories: 1215,
                protein: 91,
                carbs: 122,
                fat: 41,
            });
        });
    });

    describe('no rebalancing', () => {
        it('leaves the macros\u2019 own energy differing from the calorie figure', () => {
            // 146 P and 194 C at 4 kcal/g and 65 F at 9 kcal/g come to 1945
            // kcal against a 1940 kcal target. The 5 kcal is the cost of whole
            // grams, and it is left alone: the edit screen promises "Macros
            // don't have to add up to your calorie target."
            const derived = deriveMacroTargets(1940);
            const macroEnergy = derived.protein * 4 + derived.carbs * 4 + derived.fat * 9;

            expect(macroEnergy).toBe(1945);
            expect(macroEnergy).not.toBe(derived.calories);
        });

        it('does not correct the calorie figure to match the macros it derived', () => {
            // The reported figure stays the confirmed target, not the 1945
            // kcal its own grams imply.
            expect(deriveMacroTargets(1940).calories).toBe(1940);
        });
    });
});

/* ---------------------------------------------------------------------------
 * resolveEstimateInputs
 * ------------------------------------------------------------------------- */

describe('resolveEstimateInputs', () => {
    describe('usable preferences', () => {
        it('returns the stored inputs unchanged', () => {
            expect(resolveEstimateInputs(REFERENCE_ROW)).toEqual({
                kind: 'ready',
                inputs: {
                    age: 34,
                    heightCm: 177.8,
                    weightKg: 82.6,
                    sexForEstimate: 'female',
                    activityLevel: 'lightly_active',
                    goal: 'lose',
                    paceLbPerWeek: 1,
                },
            });
        });

        it('accepts every activity level', () => {
            for (const level of ['not_very_active', 'lightly_active', 'active', 'very_active'] as const) {
                expect(resolveEstimateInputs({ ...REFERENCE_ROW, activity_level: level }).kind).toBe('ready');
            }
        });

        it('accepts every goal, and every pace for the directional ones', () => {
            for (const goal of ['lose', 'gain'] as const) {
                for (const pace of [0.5, 1, 1.5] as const) {
                    expect(
                        resolveEstimateInputs({ ...REFERENCE_ROW, goal, pace_lb_per_week: pace }).kind,
                    ).toBe('ready');
                }
            }

            expect(resolveEstimateInputs(LOW_CORNER).kind).toBe('ready');
        });

        it('accepts both calculable sexes', () => {
            for (const sex of ['female', 'male'] as const) {
                expect(resolveEstimateInputs({ ...REFERENCE_ROW, sex_for_estimate: sex }).kind).toBe('ready');
            }
        });

        it('accepts the inclusive edges of the supported envelope', () => {
            const edges: Partial<EstimateInputsRow>[] = [
                { age: 18 },
                { age: 100 },
                { height_cm: 120 },
                { height_cm: 250 },
                { weight_kg: 30 },
                { weight_kg: 300 },
            ];

            for (const edge of edges) {
                expect(resolveEstimateInputs({ ...REFERENCE_ROW, ...edge }).kind).toBe('ready');
            }
        });

        it('reports no pace for maintenance, ignoring one left behind by an earlier goal', () => {
            expect(resolveEstimateInputs({ ...REFERENCE_ROW, goal: 'maintain' })).toEqual({
                kind: 'ready',
                inputs: expect.objectContaining({ goal: 'maintain', paceLbPerWeek: null }),
            });
        });
    });

    describe('prefer not to say', () => {
        it('is reported as itself rather than as a missing input', () => {
            expect(resolveEstimateInputs({ ...REFERENCE_ROW, sex_for_estimate: 'prefer_not_to_say' })).toEqual({
                kind: 'unavailable',
                reason: 'prefer_not_to_say',
            });
        });

        it("takes precedence over an unrelated gap, because it is the user's own answer", () => {
            // Masking an intentional answer behind an incidental one would send
            // the same user to the same screen for the wrong stated reason.
            expect(
                resolveEstimateInputs({
                    ...REFERENCE_ROW,
                    sex_for_estimate: 'prefer_not_to_say',
                    height_cm: null,
                    age: null,
                    activity_level: null,
                }),
            ).toEqual({ kind: 'unavailable', reason: 'prefer_not_to_say' });
        });

        it('is still reported as itself once the answer has put the row on the manual route', () => {
            // The body-step save that stores this answer also sets the route
            // (AAP §0.5.2). Reporting the route instead would tell the client
            // "you have not finished the form" about an answer the user gave.
            expect(
                resolveEstimateInputs({
                    ...REFERENCE_ROW,
                    sex_for_estimate: 'prefer_not_to_say',
                    target_route: 'manual',
                }),
            ).toEqual({ kind: 'unavailable', reason: 'prefer_not_to_say' });
        });
    });

    describe('the persisted target route', () => {
        // The Skip branch of the body step: no measurements are sent and the
        // PREVIOUS ones are deliberately retained, so the row still satisfies
        // every measurement check while the user has asked to type their own
        // numbers. Reading the measurements alone is what let the server
        // calculate — and, through PUT /meal-planning/targets, confirm — an
        // estimate the user declined.
        it('refuses a manual route even when every measurement is present', () => {
            expect(resolveEstimateInputs({ ...REFERENCE_ROW, target_route: 'manual' })).toEqual({
                kind: 'unavailable',
                reason: 'missing_inputs',
            });
        });

        it('refuses a manual route for every otherwise-estimable fixture', () => {
            for (const row of [REFERENCE_ROW, LOW_CORNER, HIGH_CORNER]) {
                expect(resolveEstimateInputs({ ...row, target_route: 'manual' }).kind).toBe('unavailable');
                expect(resolveEstimateInputs(row).kind).toBe('ready');
            }
        });

        it('refuses a route column it cannot read, rather than assuming the estimated one', () => {
            // The only writer stores one of the two known routes, so anything
            // else is a corrupt row: we cannot tell which route the user is on,
            // and calculating one for them is the failure to avoid.
            for (const route of ['estimate', 'Manual', 'targets_manual', '']) {
                expect(resolveEstimateInputs({ ...REFERENCE_ROW, target_route: route })).toEqual({
                    kind: 'unavailable',
                    reason: 'missing_inputs',
                });
            }
        });

        it('does not treat an unanswered body step as a refusal in itself', () => {
            // A null route is the body step unanswered. It needs no special
            // refusal, because the measurements it would have written are
            // missing and the checks below refuse those — asserted from both
            // sides so the null case cannot quietly start blocking a row that
            // is genuinely estimable.
            expect(resolveEstimateInputs({ ...REFERENCE_ROW, target_route: null }).kind).toBe('ready');
            expect(
                resolveEstimateInputs({
                    ...REFERENCE_ROW,
                    target_route: null,
                    age: null,
                    height_cm: null,
                    weight_kg: null,
                }),
            ).toEqual({ kind: 'unavailable', reason: 'missing_inputs' });
        });
    });

    describe('missing or unusable inputs', () => {
        const unusable: [string, Partial<EstimateInputsRow>][] = [
            ['no sex', { sex_for_estimate: null }],
            ['an unrecognised sex', { sex_for_estimate: 'other' }],
            ['no activity level', { activity_level: null }],
            ['an unrecognised activity level', { activity_level: 'extremely_active' }],
            ['no goal', { goal: null }],
            ['an unrecognised goal', { goal: 'recomp' }],
            ['no age', { age: null }],
            ['an age below the adult envelope', { age: 17 }],
            ['an age above the envelope', { age: 101 }],
            ['a fractional age', { age: 34.5 }],
            ['no height', { height_cm: null }],
            ['a height below the envelope', { height_cm: 119.9 }],
            ['a height above the envelope', { height_cm: 250.1 }],
            ['no weight', { weight_kg: null }],
            ['a weight below the envelope', { weight_kg: 29.9 }],
            ['a weight above the envelope', { weight_kg: 300.1 }],
            ['no pace on a directional goal', { pace_lb_per_week: null }],
            ['an unsupported pace', { pace_lb_per_week: 2 }],
            ['a zero pace', { pace_lb_per_week: 0 }],
        ];

        it.each(unusable)('refuses %s', (_label, overrides) => {
            expect(resolveEstimateInputs({ ...REFERENCE_ROW, ...overrides })).toEqual({
                kind: 'unavailable',
                reason: 'missing_inputs',
            });
        });

        it('refuses a non-numeric measurement rather than coercing it', () => {
            const rows = [
                { age: 'thirty-four' as unknown as number },
                { height_cm: '177.8' as unknown as number },
                { weight_kg: Number.NaN },
                { height_cm: Number.POSITIVE_INFINITY },
            ];

            for (const overrides of rows) {
                expect(resolveEstimateInputs({ ...REFERENCE_ROW, ...overrides }).kind).toBe('unavailable');
            }
        });

        it('refuses rather than clamping an out-of-envelope value into range', () => {
            // Clamping would present a target the user's own details do not
            // support; the manual route is the honest alternative.
            const resolved = resolveEstimateInputs({ ...REFERENCE_ROW, weight_kg: 500 });

            expect(resolved).toEqual({ kind: 'unavailable', reason: 'missing_inputs' });
        });
    });
});

/* ---------------------------------------------------------------------------
 * computeTargetEstimate
 * ------------------------------------------------------------------------- */

describe('computeTargetEstimate', () => {
    describe('the reference derivation', () => {
        const estimate = estimateFrom(REFERENCE_ROW, 4);

        it('reports a 1606 kcal basal rate', () => {
            expect(estimate.bmr).toBe(1606);
        });

        it('reports a 2209 kcal maintenance rate, which only the full-precision basal rate gives', () => {
            // A basal rate rounded to 1606 before the factor yields 2208.
            expect(estimate.tdee).toBe(2209);
        });

        it('reports a 500 kcal daily deficit', () => {
            expect(estimate.adjustment).toBe(-500);
        });

        it('reports a 1709 kcal target, rounded once after the adjustment', () => {
            expect(estimate.calories).toBe(1709);
        });

        it('reports 128 P / 171 C / 57 F', () => {
            expect(estimate.protein).toBe(128);
            expect(estimate.carbs).toBe(171);
            expect(estimate.fat).toBe(57);
        });

        it('reports no clamp', () => {
            expect(estimate.clamped).toBe(false);
            expect(estimate.clampReason).toBeNull();
        });

        it('labels itself estimated and echoes the input revision it was computed from', () => {
            expect(estimate.source).toBe('estimated');
            expect(estimate.estimateRevision).toBe(4);
        });

        it('echoes the inputs it used', () => {
            expect(estimate.inputs).toEqual({
                age: 34,
                heightCm: 177.8,
                weightKg: 82.6,
                sexForEstimate: 'female',
                activityLevel: 'lightly_active',
                goal: 'lose',
                paceLbPerWeek: 1,
            });
        });

        it('copies the inputs rather than aliasing the caller object', () => {
            const inputs = readyInputs(REFERENCE_ROW);
            const computed = computeTargetEstimate(inputs, 0);

            inputs.age = 99;

            expect(computed.inputs.age).toBe(34);
        });
    });

    describe('bounds across every goal and both envelope corners', () => {
        const cases: [string, EstimateAvailabilityRow, number, string | null][] = [
            // The low corner: a 389 kcal basal rate and a 467 kcal maintenance
            // rate. Maintenance binding the floor is why the clamp is not
            // gated on weight loss.
            ['maintaining at the low corner', LOW_CORNER, 1200, 'floor'],
            [
                'losing slowly at the low corner',
                { ...LOW_CORNER, goal: 'lose', pace_lb_per_week: 0.5 },
                1200,
                'floor',
            ],
            [
                'losing fastest at the low corner',
                { ...LOW_CORNER, goal: 'lose', pace_lb_per_week: 1.5 },
                1200,
                'floor',
            ],
            [
                'gaining slowly at the low corner',
                { ...LOW_CORNER, goal: 'gain', pace_lb_per_week: 0.5 },
                1200,
                'floor',
            ],
            // Gaining fastest clears the floor on its own, so nothing binds.
            [
                'gaining fastest at the low corner',
                { ...LOW_CORNER, goal: 'gain', pace_lb_per_week: 1.5 },
                1217,
                null,
            ],
            // The high corner: a 7724 kcal maintenance rate, so every goal is
            // capped.
            ['maintaining at the high corner', HIGH_CORNER, 5000, 'ceiling'],
            [
                'losing fastest at the high corner',
                { ...HIGH_CORNER, goal: 'lose', pace_lb_per_week: 1.5 },
                5000,
                'ceiling',
            ],
            [
                'gaining fastest at the high corner',
                { ...HIGH_CORNER, goal: 'gain', pace_lb_per_week: 1.5 },
                5000,
                'ceiling',
            ],
            // A basal rate above the sex floor, with a deficit that dips below
            // it: the user's own rate is the bound, not the policy floor.
            [
                'a deficit below the user basal rate',
                {
                    target_route: 'estimated',
                    goal: 'lose',
                    pace_lb_per_week: 1.5,
                    age: 30,
                    height_cm: 180,
                    weight_kg: 82,
                    sex_for_estimate: 'male',
                    activity_level: 'not_very_active',
                },
                1800,
                'below_bmr',
            ],
            // One unclamped interior case per goal.
            [
                'losing in the interior',
                { ...REFERENCE_ROW, activity_level: 'active', pace_lb_per_week: 0.5 },
                2240,
                null,
            ],
            [
                'maintaining in the interior',
                {
                    target_route: 'estimated',
                    goal: 'maintain',
                    pace_lb_per_week: null,
                    age: 30,
                    height_cm: 180,
                    weight_kg: 82,
                    sex_for_estimate: 'male',
                    activity_level: 'active',
                },
                2790,
                null,
            ],
            [
                'gaining in the interior',
                {
                    target_route: 'estimated',
                    goal: 'gain',
                    pace_lb_per_week: 0.5,
                    age: 30,
                    height_cm: 165,
                    weight_kg: 60,
                    sex_for_estimate: 'female',
                    activity_level: 'lightly_active',
                },
                2065,
                null,
            ],
        ];

        it.each(cases)('%s yields %i kcal', (_label, row, calories, clampReason) => {
            const estimate = estimateFrom(row);

            expect(estimate.calories).toBe(calories);
            expect(estimate.clampReason).toBe(clampReason);
            expect(estimate.clamped).toBe(clampReason !== null);
        });

        it('derives the macros of the clamped figure, not of the raw one', () => {
            const estimate = estimateFrom(LOW_CORNER);

            expect(estimate.calories).toBe(1200);
            expect(estimate.protein).toBe(90);
            expect(estimate.carbs).toBe(120);
            expect(estimate.fat).toBe(40);
        });

        it('never presents a target outside the product bounds', () => {
            for (const [, row] of cases) {
                const estimate = estimateFrom(row);

                expect(estimate.calories).toBeGreaterThanOrEqual(
                    CALORIE_FLOOR_BY_SEX[row.sex_for_estimate === 'male' ? 'male' : 'female'],
                );
                expect(estimate.calories).toBeLessThanOrEqual(CALORIE_CEILING);
            }
        });
    });
});

/* ---------------------------------------------------------------------------
 * buildStoredEstimate
 *
 * The record `meal_plan_preferences.estimated_targets` holds — AAP §0.5.1's
 * "last estimate with input revision". These assertions are what make the
 * stored shape a decision rather than an accident: the KEY SET is pinned
 * exactly, so a member added to the estimate response cannot reach the database
 * silently and a member removed from the stored record cannot pass unnoticed;
 * the two deliberate differences from the response (no `source`, and
 * `estimateRevision` stored as `inputRevision`) are asserted as differences;
 * and the record is checked to survive a JSON round trip, because a JSONB
 * column is exactly a JSON round trip and a value that does not survive one is
 * not storable.
 * ------------------------------------------------------------------------- */

describe('buildStoredEstimate', () => {
    /** The keys the stored record has, and the complete list of them. */
    const STORED_KEYS = [
        'inputRevision',
        'inputs',
        'bmr',
        'tdee',
        'adjustment',
        'calories',
        'protein',
        'carbs',
        'fat',
        'clamped',
        'clampReason',
    ];

    describe('the reference derivation, as it is stored', () => {
        const stored = buildStoredEstimate(estimateFrom(REFERENCE_ROW, 4));

        it('keeps the whole derivation, not only the four confirmed values', () => {
            expect(stored).toEqual({
                inputRevision: 4,
                inputs: {
                    age: 34,
                    heightCm: 177.8,
                    weightKg: 82.6,
                    sexForEstimate: 'female',
                    activityLevel: 'lightly_active',
                    goal: 'lose',
                    paceLbPerWeek: 1,
                },
                bmr: 1606,
                tdee: 2209,
                adjustment: -500,
                calories: 1709,
                protein: 128,
                carbs: 171,
                fat: 57,
                clamped: false,
                clampReason: null,
            });
        });

        it('carries exactly the stored key set, so a wire change cannot reach the column unnoticed', () => {
            expect(Object.keys(stored).sort()).toEqual([...STORED_KEYS].sort());
        });

        it('stores the estimate revision as the input revision, which is what the number means at rest', () => {
            const estimate = estimateFrom(REFERENCE_ROW, 4);

            expect(stored.inputRevision).toBe(estimate.estimateRevision);
        });

        it('drops the wire-only source discriminator, because the column name already says the route', () => {
            expect(stored).not.toHaveProperty('source');
            expect(stored).not.toHaveProperty('estimateRevision');
        });
    });

    describe('the input revision it records', () => {
        it.each([0, 1, 9, MAX_REVISION])('is the revision the estimate was computed at (%i)', (revision) => {
            expect(buildStoredEstimate(estimateFrom(REFERENCE_ROW, revision)).inputRevision).toBe(revision);
        });
    });

    describe('the clamp it preserves', () => {
        it('records a floor clamp and its reason, which the four confirmed values cannot express', () => {
            const stored = buildStoredEstimate(estimateFrom(LOW_CORNER, 2));

            expect(stored.calories).toBe(1200);
            expect(stored.clamped).toBe(true);
            expect(stored.clampReason).toBe('floor');
            // The pre-clamp derivation survives beside the clamped figure, so
            // the record shows that a bound moved the number and by how much:
            // the low corner's 467 kcal maintenance rate (AAP §0.7.3) is what
            // the 1,200 kcal floor replaced, and a record holding only the
            // confirmed 1,200 could not say that.
            expect(stored.bmr).toBe(389);
            expect(stored.tdee).toBe(467);
            expect(stored.adjustment).toBe(0);
        });

        it('records a ceiling clamp at the high corner', () => {
            const stored = buildStoredEstimate(estimateFrom(HIGH_CORNER, 2));

            expect(stored.calories).toBe(CALORIE_CEILING);
            expect(stored.clamped).toBe(true);
            expect(stored.clampReason).toBe('ceiling');
        });

        it('records the absence of a clamp as an absence, not as a missing field', () => {
            const stored = buildStoredEstimate(estimateFrom(REFERENCE_ROW, 2));

            expect(stored.clamped).toBe(false);
            expect(stored.clampReason).toBeNull();
        });
    });

    describe('as a JSONB value', () => {
        it('survives a JSON round trip unchanged, for every fixture', () => {
            for (const row of [REFERENCE_ROW, LOW_CORNER, HIGH_CORNER]) {
                const stored = buildStoredEstimate(estimateFrom(row, 3));

                expect(JSON.parse(JSON.stringify(stored))).toEqual(stored);
            }
        });

        it('holds no undefined member, which JSON would silently drop', () => {
            const stored = buildStoredEstimate(estimateFrom(LOW_CORNER, 3));

            for (const key of STORED_KEYS) {
                expect(stored[key as keyof typeof stored]).toBeDefined();
            }
        });

        it("stores a maintain goal's absent pace as null rather than dropping the member", () => {
            const stored = buildStoredEstimate(estimateFrom(LOW_CORNER, 3));

            expect(stored.inputs.paceLbPerWeek).toBeNull();
            expect(JSON.parse(JSON.stringify(stored)).inputs).toHaveProperty('paceLbPerWeek');
        });
    });

    describe('independence from the estimate it was built from', () => {
        it('copies the inputs rather than aliasing them, so a later mutation cannot rewrite the record', () => {
            const estimate = estimateFrom(REFERENCE_ROW, 4);
            const stored = buildStoredEstimate(estimate);

            estimate.inputs.weightKg = 1;
            estimate.inputs.activityLevel = 'very_active';

            expect(stored.inputs.weightKg).toBe(82.6);
            expect(stored.inputs.activityLevel).toBe('lightly_active');
        });

        it('is deterministic: the same estimate always yields the same record', () => {
            expect(buildStoredEstimate(estimateFrom(REFERENCE_ROW, 4))).toEqual(
                buildStoredEstimate(estimateFrom(REFERENCE_ROW, 4)),
            );
        });
    });
});

/* ---------------------------------------------------------------------------
 * parseManualTargets
 * ------------------------------------------------------------------------- */

describe('parseManualTargets', () => {
    it('uses the declared ranges', () => {
        expect(MANUAL_CALORIE_RANGE).toEqual({ min: 800, max: 6000 });
        expect(MANUAL_MACRO_RANGE).toEqual({ min: 1, max: 1000 });
    });

    describe('accepted bodies', () => {
        it('returns the four values exactly as entered', () => {
            expect(parseManualTargets(manualBody())).toEqual({
                kind: 'valid',
                values: { calories: 1940, protein: 146, carbs: 194, fat: 65 },
            });
        });

        it('does not rebalance macros to match the calorie figure', () => {
            // The edit screen promises "We won't adjust them for you", so a
            // set whose energy is nowhere near the calorie target is stored
            // verbatim and merely warned about.
            const parsed = parseManualTargets({ calories: 1200, protein: 300, carbs: 300, fat: 300 });

            expect(parsed).toEqual({
                kind: 'valid',
                values: { calories: 1200, protein: 300, carbs: 300, fat: 300 },
            });
        });

        it('accepts the inclusive edges of every range', () => {
            const edges = [
                { calories: MANUAL_CALORIE_RANGE.min },
                { calories: MANUAL_CALORIE_RANGE.max },
                { protein: MANUAL_MACRO_RANGE.min },
                { protein: MANUAL_MACRO_RANGE.max },
                { carbs: MANUAL_MACRO_RANGE.min },
                { carbs: MANUAL_MACRO_RANGE.max },
                { fat: MANUAL_MACRO_RANGE.min },
                { fat: MANUAL_MACRO_RANGE.max },
            ];

            for (const edge of edges) {
                expect(parseManualTargets(manualBody(edge)).kind).toBe('valid');
            }
        });

        it('ignores keys it does not own', () => {
            const parsed = parseManualTargets(manualBody({ source: 'manual', expectedTargetsRevision: 2 }));

            expect(parsed).toEqual({
                kind: 'valid',
                values: { calories: 1940, protein: 146, carbs: 194, fat: 65 },
            });
        });
    });

    describe('a macro of zero', () => {
        it('is refused, because a target of nothing is not a target', () => {
            // This is the code the edit screen renders as
            // "Enter a carb target above 0 g".
            expect(manualErrorCodes(manualBody({ carbs: 0 }))).toEqual({ carbs: 'below_minimum' });
        });

        it('is refused for every macro', () => {
            expect(manualErrorCodes(manualBody({ protein: 0 }))).toEqual({ protein: 'below_minimum' });
            expect(manualErrorCodes(manualBody({ fat: 0 }))).toEqual({ fat: 'below_minimum' });
        });

        it('is refused even though one gram is accepted', () => {
            expect(parseManualTargets(manualBody({ carbs: 1 })).kind).toBe('valid');
            expect(parseManualTargets(manualBody({ carbs: 0 })).kind).toBe('error');
        });
    });

    describe('range violations', () => {
        const violations: [string, Record<string, unknown>, Record<string, string>][] = [
            ['calories one below the minimum', { calories: 799 }, { calories: 'below_minimum' }],
            ['calories one above the maximum', { calories: 6001 }, { calories: 'above_maximum' }],
            ['protein one above the maximum', { protein: 1001 }, { protein: 'above_maximum' }],
            ['carbs one above the maximum', { carbs: 1001 }, { carbs: 'above_maximum' }],
            ['fat one above the maximum', { fat: 1001 }, { fat: 'above_maximum' }],
            ['a negative macro', { fat: -1 }, { fat: 'below_minimum' }],
        ];

        it.each(violations)('refuses %s', (_label, overrides, expected) => {
            expect(manualErrorCodes(manualBody(overrides))).toEqual(expected);
        });
    });

    describe('non-integer values', () => {
        it('refuses fractional calories and fractional grams', () => {
            expect(manualErrorCodes(manualBody({ calories: 1940.5 }))).toEqual({
                calories: 'not_an_integer',
            });
            expect(manualErrorCodes(manualBody({ protein: 146.2 }))).toEqual({ protein: 'not_an_integer' });
        });

        it('reports a fractional value in range as not an integer rather than out of range', () => {
            expect(manualErrorCodes(manualBody({ carbs: 0.5 }))).toEqual({ carbs: 'not_an_integer' });
        });
    });

    describe('values that are not JSON numbers', () => {
        it('refuses a numeric string rather than coercing it', () => {
            expect(manualErrorCodes(manualBody({ calories: '1940' }))).toEqual({ calories: 'invalid_type' });
        });

        it('refuses booleans, objects, arrays and non-finite numbers', () => {
            expect(manualErrorCodes(manualBody({ calories: true }))).toEqual({ calories: 'invalid_type' });
            expect(manualErrorCodes(manualBody({ protein: {} }))).toEqual({ protein: 'invalid_type' });
            expect(manualErrorCodes(manualBody({ carbs: [194] }))).toEqual({ carbs: 'invalid_type' });
            expect(manualErrorCodes(manualBody({ fat: Number.NaN }))).toEqual({ fat: 'invalid_type' });
            expect(manualErrorCodes(manualBody({ fat: Number.POSITIVE_INFINITY }))).toEqual({
                fat: 'invalid_type',
            });
        });
    });

    describe('absent values', () => {
        it('reports a missing field as required', () => {
            expect(manualErrorCodes(manualBody({ fat: undefined }))).toEqual({ fat: 'required' });
        });

        it('reports an explicit null as required rather than as a bad type', () => {
            expect(manualErrorCodes(manualBody({ protein: null }))).toEqual({ protein: 'required' });
        });
    });

    describe('bodies that are not objects', () => {
        const notObjects: [string, unknown][] = [
            ['null', null],
            ['undefined', undefined],
            ['a string', 'calories=1940'],
            ['a number', 1940],
            ['an array', [1940, 146, 194, 65]],
        ];

        it.each(notObjects)('reports all four fields as required for %s', (_label, body) => {
            expect(manualErrorCodes(body)).toEqual({
                calories: 'required',
                protein: 'required',
                carbs: 'required',
                fat: 'required',
            });
        });
    });

    describe('reporting', () => {
        it('reports every offending field in one verdict, in wire order', () => {
            const parsed = parseManualTargets({ calories: 100, protein: 0, carbs: '5', fat: null });

            if (parsed.kind !== 'error') throw new Error('expected a refusal');

            expect(parsed.details).toEqual([
                { field: 'calories', code: 'below_minimum' },
                { field: 'protein', code: 'below_minimum' },
                { field: 'carbs', code: 'invalid_type' },
                { field: 'fat', code: 'required' },
            ]);
        });

        it('reports only the offending fields', () => {
            const parsed = parseManualTargets(manualBody({ carbs: 0 }));

            if (parsed.kind !== 'error') throw new Error('expected a refusal');

            expect(parsed.details).toHaveLength(1);
            expect(parsed.code).toBe('invalid_request');
        });

        it('names the field and its code in the diagnostic message', () => {
            const parsed = parseManualTargets(manualBody({ carbs: 0 }));

            if (parsed.kind !== 'error') throw new Error('expected a refusal');

            expect(parsed.message).toContain('carbs');
            expect(parsed.message).toContain('below_minimum');
        });

        it('does not mutate the body it was given', () => {
            const body = manualBody({ carbs: 0 });
            const snapshot = { ...body };

            parseManualTargets(body);

            expect(body).toEqual(snapshot);
        });
    });
});

/* ---------------------------------------------------------------------------
 * assessFeasibility
 * ------------------------------------------------------------------------- */

/* ---------------------------------------------------------------------------
 * The save envelope
 *
 * `PUT /meal-planning/targets` carries one of two shapes, and this parser is
 * the only thing that decides which was sent. Tested directly here — not
 * through the service — because it is pure: the stored-revision half of the
 * rule (whether an omitted `expectedTargetsRevision` is legal THIS time) is
 * deliberately not its business and stays under the lock in `saveTargets`.
 * ------------------------------------------------------------------------- */

describe('parseSaveTargetsRequest', () => {
    const estimatedBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        source: 'estimated',
        estimateRevision: 9,
        expectedTargetsRevision: 3,
        ...overrides,
    });

    const manualSaveBody = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        source: 'manual',
        ...MANUAL_BODY,
        expectedTargetsRevision: 3,
        ...overrides,
    });

    /** The accepted request, or a failure naming what the parser refused. */
    const accepted = (parsed: ParsedSaveTargets) => {
        if (parsed.kind !== 'ok') {
            throw new Error(`expected an accepted envelope, got ${JSON.stringify(parsed.details)}`);
        }

        return parsed.request;
    };

    /** The codes reported for a body, keyed by field. */
    const envelopeCodes = (body: unknown): Record<string, string> => {
        const parsed = parseSaveTargetsRequest(body);

        if (parsed.kind !== 'error') {
            throw new Error('expected the envelope to be refused');
        }

        const codes: Record<string, string> = {};
        for (const detail of parsed.details) {
            codes[detail.field] = detail.code;
        }

        return codes;
    };

    it('declares exactly the two sources the DTO union allows', () => {
        expect(Object.keys(TARGET_SOURCES).sort()).toEqual(['estimated', 'manual']);
    });

    describe('the estimated arm', () => {
        it('carries the pinned estimate revision and no values, because the server recomputes them', () => {
            expect(accepted(parseSaveTargetsRequest(estimatedBody()))).toEqual({
                source: 'estimated',
                estimateRevision: 9,
                expectedTargetsRevision: 3,
            });
        });

        it('requires the estimate revision, without which the figure cannot be judged', () => {
            expect(envelopeCodes(estimatedBody({ estimateRevision: undefined }))).toEqual({
                estimateRevision: 'required',
            });
            expect(envelopeCodes(estimatedBody({ estimateRevision: null }))).toEqual({
                estimateRevision: 'required',
            });
        });

        it('refuses manual values sent alongside it, because the estimated shape carries none', () => {
            // The damaging case for a silent drop, and the reason this arm's
            // shape is exact: the server recomputes the figures from stored
            // preferences, so a client whose `calories` was quietly ignored
            // would be told its save succeeded and then read back numbers it
            // never sent.
            expect(envelopeCodes(estimatedBody(MANUAL_BODY))).toEqual({
                calories: 'unknown_field',
                protein: 'unknown_field',
                carbs: 'unknown_field',
                fat: 'unknown_field',
            });
        });
    });

    describe('the manual arm', () => {
        it('carries the four values exactly as entered', () => {
            expect(accepted(parseSaveTargetsRequest(manualSaveBody()))).toEqual({
                source: 'manual',
                values: { calories: 1940, protein: 146, carbs: 194, fat: 65 },
                expectedTargetsRevision: 3,
            });
        });

        it('needs no estimate revision, because nothing was recomputed', () => {
            // Stated by omission rather than by a key set to undefined:
            // `estimateRevision` is not part of this shape at all, so a body
            // that carries one is refused (see "keys outside the declared
            // shape") instead of tolerated.
            expect(Object.prototype.hasOwnProperty.call(manualSaveBody(), 'estimateRevision')).toBe(false);
            expect(parseSaveTargetsRequest(manualSaveBody()).kind).toBe('ok');
        });

        it('delegates the four values to parseManualTargets rather than re-judging them', () => {
            expect(envelopeCodes(manualSaveBody({ carbs: 0 }))).toEqual({ carbs: 'below_minimum' });
            expect(envelopeCodes(manualSaveBody({ calories: '1940' }))).toEqual({
                calories: 'invalid_type',
            });
        });

        it('reports the offending values and the offending revision in one verdict', () => {
            // One round trip: the edit screen shows every inline message at
            // once, and a body with both kinds of problem must not report only
            // the half the parser reached first.
            expect(envelopeCodes(manualSaveBody({ carbs: 0, fat: null, expectedTargetsRevision: -1 }))).toEqual(
                {
                    expectedTargetsRevision: 'below_minimum',
                    carbs: 'below_minimum',
                    fat: 'required',
                },
            );
        });
    });

    describe('keys outside the declared shape', () => {
        // Each arm accepts exactly the keys its wire DTO declares (§0.5.2).
        // Silently dropping the rest would let a client believe a value it sent
        // was honoured — the same reason `parseLogPlannedMealRequest` refuses
        // `mealName` rather than ignoring it.
        it('declares exactly the keys each wire shape carries', () => {
            expect(Object.keys(ESTIMATED_SAVE_KEYS).sort()).toEqual([
                'estimateRevision',
                'expectedTargetsRevision',
                'source',
            ]);
            expect(Object.keys(MANUAL_SAVE_KEYS).sort()).toEqual([
                'calories',
                'carbs',
                'expectedTargetsRevision',
                'fat',
                'protein',
                'source',
            ]);
        });

        it('accepts both minimal bodies, so the accepted sets are not too narrow', () => {
            expect(parseSaveTargetsRequest({ source: 'estimated', estimateRevision: 9 })).toEqual({
                kind: 'ok',
                request: { source: 'estimated', estimateRevision: 9, expectedTargetsRevision: null },
            });
            expect(parseSaveTargetsRequest({ source: 'manual', ...MANUAL_BODY })).toEqual({
                kind: 'ok',
                request: {
                    source: 'manual',
                    values: { calories: 1940, protein: 146, carbs: 194, fat: 65 },
                    expectedTargetsRevision: null,
                },
            });
        });

        it('accepts every declared key of either shape sent together', () => {
            expect(accepted(parseSaveTargetsRequest(estimatedBody()))).toEqual({
                source: 'estimated',
                estimateRevision: 9,
                expectedTargetsRevision: 3,
            });
            expect(accepted(parseSaveTargetsRequest(manualSaveBody()))).toEqual({
                source: 'manual',
                values: { calories: 1940, protein: 146, carbs: 194, fat: 65 },
                expectedTargetsRevision: 3,
            });
        });

        it('refuses an arbitrary extra key on the manual arm', () => {
            expect(envelopeCodes(manualSaveBody({ surprise: true }))).toEqual({
                surprise: 'unknown_field',
            });
        });

        it('refuses an arbitrary extra key on the estimated arm', () => {
            expect(envelopeCodes(estimatedBody({ surprise: true }))).toEqual({
                surprise: 'unknown_field',
            });
        });

        it('refuses a key that is legal only on the manual arm', () => {
            expect(envelopeCodes(estimatedBody({ calories: 9999 }))).toEqual({
                calories: 'unknown_field',
            });
        });

        it('refuses a key that is legal only on the estimated arm', () => {
            expect(envelopeCodes(manualSaveBody({ estimateRevision: 9 }))).toEqual({
                estimateRevision: 'unknown_field',
            });
        });

        it('judges own keys only, so a prototype member is never mistaken for an accepted one', () => {
            expect(envelopeCodes(manualSaveBody({ toString: 'x' }))).toEqual({
                toString: 'unknown_field',
            });
        });

        it('reports the extra key and the offending values in one verdict', () => {
            // One round trip: a body with both kinds of problem must not report
            // only the half the parser reached first.
            expect(
                envelopeCodes(
                    manualSaveBody({ calories: '1940', protein: 0, carbs: 1.5, fat: null, surprise: true }),
                ),
            ).toEqual({
                calories: 'invalid_type',
                protein: 'below_minimum',
                carbs: 'not_an_integer',
                fat: 'required',
                surprise: 'unknown_field',
            });
        });

        it('reports the extra key and an unusable revision in one verdict', () => {
            expect(envelopeCodes(estimatedBody({ expectedTargetsRevision: -1, surprise: true }))).toEqual({
                expectedTargetsRevision: 'below_minimum',
                surprise: 'unknown_field',
            });
            expect(envelopeCodes(manualSaveBody({ expectedTargetsRevision: 1e30, surprise: true }))).toEqual({
                expectedTargetsRevision: 'above_maximum',
                surprise: 'unknown_field',
            });
        });

        it('names the unknown key in the diagnostic message', () => {
            const parsed = parseSaveTargetsRequest(estimatedBody({ surprise: true }));

            expect(parsed.kind).toBe('error');
            if (parsed.kind === 'error') {
                expect(parsed.code).toBe('invalid_request');
                expect(parsed.message).toContain('surprise');
                expect(parsed.message).toContain('unknown_field');
            }
        });
    });

    describe('the source discriminator', () => {
        it('reports an absent source alone, because the two shapes need different fields', () => {
            expect(envelopeCodes({ expectedTargetsRevision: 3 })).toEqual({ source: 'required' });
            expect(envelopeCodes({ source: null })).toEqual({ source: 'required' });
        });

        it.each(['legacy', 'Estimated', 'estimate', '', 'toString'])(
            'reports the unrecognised source %p as an unknown value',
            (source) => {
                expect(envelopeCodes({ source, expectedTargetsRevision: 3 })).toEqual({
                    source: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
                });
            },
        );

        it.each([[42], [true], [{ source: 'manual' }], [['manual']]])(
            'reports the non-string source %p as an unknown value',
            (source) => {
                expect(envelopeCodes({ source })).toEqual({
                    source: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
                });
            },
        );

        it('reports a bad source alone even when the rest of the body is also wrong', () => {
            // Reporting "calories is required" for a body whose source is
            // misspelled would describe a shape the client never meant to send.
            expect(envelopeCodes({ source: 'legacy', expectedTargetsRevision: -1, calories: 0 })).toEqual({
                source: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
            });
        });

        it('reports an unusable source alone even when unknown keys are present', () => {
            // Which keys are legal is the ARM's answer, and an unusable source
            // establishes no arm — so the rest of the body is not judged as
            // unknown keys either, in any of the three ways a source can be
            // unusable.
            expect(envelopeCodes({ surprise: true, calories: 1940 })).toEqual({ source: 'required' });
            expect(envelopeCodes({ source: null, surprise: true })).toEqual({ source: 'required' });
            expect(envelopeCodes({ source: 'Estimated', surprise: true })).toEqual({
                source: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
            });
        });
    });

    describe('bodies that are not objects', () => {
        it.each([
            ['null', null],
            ['undefined', undefined],
            ['a string', 'source=manual'],
            ['a number', 1940],
            ['an array', [{ source: 'manual' }]],
        ])('refuses %s as a body-level type problem', (_label, body) => {
            expect(envelopeCodes(body)).toEqual({ body: 'invalid_type' });
        });
    });

    describe('the pinned targets revision', () => {
        it('resolves an omitted revision to null, which is legal before the first save', () => {
            // A pure parser cannot know the stored revision, so the omission is
            // carried forward as null and `saveTargets` applies the half of the
            // rule that needs the row.
            expect(accepted(parseSaveTargetsRequest(estimatedBody({ expectedTargetsRevision: undefined })))).toEqual(
                { source: 'estimated', estimateRevision: 9, expectedTargetsRevision: null },
            );
            expect(
                accepted(parseSaveTargetsRequest(manualSaveBody({ expectedTargetsRevision: null })))
                    .expectedTargetsRevision,
            ).toBeNull();
        });

        it('accepts a pinned zero, which a user with no preferences row is at', () => {
            expect(
                accepted(parseSaveTargetsRequest(estimatedBody({ expectedTargetsRevision: 0 })))
                    .expectedTargetsRevision,
            ).toBe(0);
        });
    });

    describe('numeric boundaries, on both revision fields', () => {
        // `Number.isInteger(1e30)` is true, so the integer check alone admits
        // whole numbers that no `Int` column can hold and that JavaScript
        // cannot compare exactly — which later fails in fingerprinting or in
        // Prisma as a 500 rather than as this 400.
        const REFUSED: [string, unknown, string][] = [
            ['one above the column maximum', MAX_REVISION + 1, 'above_maximum'],
            ['1e30', 1e30, 'above_maximum'],
            ['two above the safe-integer ceiling', Number.MAX_SAFE_INTEGER + 2, 'above_maximum'],
            ['a negative revision', -1, 'below_minimum'],
            ['a fractional revision', 1.5, 'not_an_integer'],
            ['a numeric string', '3', 'invalid_type'],
            ['NaN', Number.NaN, 'invalid_type'],
            ['Infinity', Number.POSITIVE_INFINITY, 'invalid_type'],
        ];

        it('pins the bound to the integer column revisions live in', () => {
            expect(MAX_REVISION).toBe(2_147_483_647);
        });

        it('accepts the column maximum on both fields', () => {
            expect(
                accepted(
                    parseSaveTargetsRequest(
                        estimatedBody({
                            estimateRevision: MAX_REVISION,
                            expectedTargetsRevision: MAX_REVISION,
                        }),
                    ),
                ),
            ).toEqual({
                source: 'estimated',
                estimateRevision: MAX_REVISION,
                expectedTargetsRevision: MAX_REVISION,
            });
        });

        it.each(REFUSED)('refuses %s as estimateRevision (%s)', (_label, estimateRevision, code) => {
            expect(envelopeCodes(estimatedBody({ estimateRevision }))).toEqual({
                estimateRevision: code,
            });
        });

        it.each(REFUSED)(
            'refuses %s as expectedTargetsRevision (%s)',
            (_label, expectedTargetsRevision, code) => {
                expect(envelopeCodes(estimatedBody({ expectedTargetsRevision }))).toEqual({
                    expectedTargetsRevision: code,
                });
            },
        );

        it('reports both offending revisions in one verdict', () => {
            expect(
                envelopeCodes(
                    estimatedBody({ estimateRevision: 1e30, expectedTargetsRevision: MAX_REVISION + 1 }),
                ),
            ).toEqual({
                estimateRevision: 'above_maximum',
                expectedTargetsRevision: 'above_maximum',
            });
        });
    });

    it('names every offending field in the diagnostic message', () => {
        const parsed = parseSaveTargetsRequest(manualSaveBody({ carbs: 0, expectedTargetsRevision: -1 }));

        expect(parsed.kind).toBe('error');
        if (parsed.kind === 'error') {
            expect(parsed.code).toBe('invalid_request');
            expect(parsed.message).toContain('expectedTargetsRevision');
            expect(parsed.message).toContain('carbs');
        }
    });

    it('returns its verdict rather than throwing, and names no status code', () => {
        for (const body of [estimatedBody(), manualSaveBody(), null, 42, { source: 'legacy' }]) {
            expect(() => parseSaveTargetsRequest(body)).not.toThrow();
        }
    });
});

describe('parseOptionalRevision and parseRequiredRevision', () => {
    it('reads an absent optional revision as null rather than as a failure', () => {
        expect(parseOptionalRevision(undefined, 'expectedTargetsRevision')).toEqual({ revision: null });
        expect(parseOptionalRevision(null, 'expectedTargetsRevision')).toEqual({ revision: null });
    });

    it('accepts every magnitude a revision column can hold', () => {
        expect(parseOptionalRevision(0, 'expectedTargetsRevision')).toEqual({ revision: 0 });
        expect(parseOptionalRevision(MAX_REVISION, 'expectedTargetsRevision')).toEqual({
            revision: MAX_REVISION,
        });
    });

    it('refuses an absent required revision, which the optional form allows', () => {
        expect(parseRequiredRevision(undefined, 'estimateRevision')).toEqual({
            field: 'estimateRevision',
            code: 'required',
        });
        expect(parseRequiredRevision(null, 'estimateRevision')).toEqual({
            field: 'estimateRevision',
            code: 'required',
        });
    });

    it('returns the number itself when the required form is satisfied', () => {
        expect(parseRequiredRevision(9, 'estimateRevision')).toBe(9);
        expect(parseRequiredRevision(MAX_REVISION, 'estimateRevision')).toBe(MAX_REVISION);
    });

    it('names the field it was asked about in every refusal', () => {
        expect(parseOptionalRevision(1e30, 'expectedTargetsRevision')).toEqual({
            field: 'expectedTargetsRevision',
            code: 'above_maximum',
        });
        expect(parseRequiredRevision(1e30, 'estimateRevision')).toEqual({
            field: 'estimateRevision',
            code: 'above_maximum',
        });
    });
});

describe('assessFeasibility', () => {
    it('reports nothing for a coherent set', () => {
        expect(assessFeasibility({ calories: 1940, protein: 146, carbs: 194, fat: 65 })).toEqual({
            ok: true,
            warnings: [],
        });
    });

    describe('macro energy mismatch', () => {
        it('is silent just inside the threshold', () => {
            // 4(150) + 4(249) + 9(100) = 2496: a 496 kcal gap against a 500
            // kcal tolerance.
            expect(assessFeasibility({ calories: 2000, protein: 150, carbs: 249, fat: 100 })).toEqual({
                ok: true,
                warnings: [],
            });
        });

        it('is silent at exactly a quarter of the calorie figure', () => {
            // 4(150) + 4(250) + 9(100) = 2500, exactly 500 over 2000.
            expect(assessFeasibility({ calories: 2000, protein: 150, carbs: 250, fat: 100 })).toEqual({
                ok: true,
                warnings: [],
            });
        });

        it('warns once the gap exceeds a quarter', () => {
            // One more gram of carbohydrate takes the gap to 504.
            expect(assessFeasibility({ calories: 2000, protein: 150, carbs: 251, fat: 100 })).toEqual({
                ok: false,
                warnings: ['macro_energy_mismatch'],
            });
        });

        it('warns when the macros fall as far short as they may overshoot', () => {
            // 1493 kcal of macros against a 2000 kcal target: a 507 kcal gap
            // on the low side, which the absolute difference must catch too.
            expect(assessFeasibility({ calories: 2000, protein: 100, carbs: 100, fat: 77 })).toEqual({
                ok: false,
                warnings: ['macro_energy_mismatch'],
            });
        });
    });

    describe('the catalog calorie range', () => {
        it('is silent at exactly the lower bound', () => {
            expect(assessFeasibility(deriveMacroTargets(1000)).warnings).not.toContain('below_catalog_min');
        });

        it('warns one kcal below it', () => {
            expect(assessFeasibility(deriveMacroTargets(999)).warnings).toContain('below_catalog_min');
        });

        it('is silent at exactly the upper bound', () => {
            expect(assessFeasibility(deriveMacroTargets(4500)).warnings).not.toContain('above_catalog_max');
        });

        it('warns one kcal above it', () => {
            expect(assessFeasibility(deriveMacroTargets(4501)).warnings).toContain('above_catalog_max');
        });
    });

    it('reports several warnings together, in a fixed order', () => {
        expect(assessFeasibility({ calories: 999, protein: 1, carbs: 1, fat: 1 })).toEqual({
            ok: false,
            warnings: ['macro_energy_mismatch', 'below_catalog_min'],
        });
    });

    it('never rejects, so ok:false still describes a saved target', () => {
        const assessment = assessFeasibility({ calories: 6000, protein: 1, carbs: 1, fat: 1 });

        expect(assessment.ok).toBe(false);
        expect(assessment.warnings).toEqual(['macro_energy_mismatch', 'above_catalog_max']);
    });

    it('never throws, however implausible the numbers it is handed', () => {
        // The save succeeds and carries the warnings, so a throw here would
        // turn an advisory note into a failed save.
        const implausible = [
            { calories: 800, protein: 1000, carbs: 1000, fat: 1000 },
            { calories: 6000, protein: 1, carbs: 1, fat: 1 },
            { calories: 1000, protein: 1, carbs: 1, fat: 1 },
            { calories: 4500, protein: 500, carbs: 500, fat: 200 },
        ];

        for (const values of implausible) {
            expect(() => assessFeasibility(values)).not.toThrow();
            expect(assessFeasibility(values).warnings).toEqual(expect.any(Array));
        }
    });
});

/* ---------------------------------------------------------------------------
 * resolveManualTargetSetupAdvance
 *
 * The manual route's target screen is the one wizard stop that saves through
 * `PUT /meal-planning/targets` rather than as a setup step (AAP §0.7.4), so
 * this is the only thing that can move the resume marker off `targets_manual`.
 * Both directions matter: a manual confirmation standing on that stop must
 * advance, and every other way the save route is reached must write nothing —
 * an Account-only target edit, an edit-mode re-save from plan settings and a
 * completed user all arrive at the same function.
 * ------------------------------------------------------------------------- */

describe('resolveManualTargetSetupAdvance', () => {
    /**
     * A user standing on the manual route's target stop: goal and body
     * answered (which is how the marker got there), diet onwards not.
     */
    const onTargetStop = (overrides: Partial<SetupStateSnapshot> = {}): SetupStateSnapshot => ({
        setupStatus: 'in_progress',
        setupStep: 'targets_manual',
        targetRoute: 'manual',
        answers: {
            goal: 'lose',
            activityLevel: null,
            diet: null,
            mealSchedule: null,
            cookingTimeLimitMin: null,
        },
        ...overrides,
    });

    describe('the one save that earns the advance', () => {
        it('moves the marker to the next stop of the manual route', () => {
            expect(resolveManualTargetSetupAdvance(onTargetStop(), 'manual')).toEqual({
                setup_step: 'diet',
                setup_status: 'in_progress',
            });
        });

        it('takes both columns from the state machine rather than naming them itself', () => {
            // The assertion that keeps the decision in one place: `diet` above
            // is what `nextSetupState` says the stop after `targets_manual` is,
            // so reordering MANUAL_ROUTE_ORDER moves this helper with it. A
            // literal here would have to be found and changed by hand.
            const snapshot = onTargetStop();
            const transition = nextSetupState(snapshot, 'targets_manual', 'manual');

            expect(resolveManualTargetSetupAdvance(snapshot, 'manual')).toEqual({
                setup_step: transition.setupStep,
                setup_status: transition.setupStatus,
            });
        });

        it('does not promote the user to ready_for_review, because six stops remain', () => {
            expect(resolveManualTargetSetupAdvance(onTargetStop(), 'manual')?.setup_status).toBe(
                'in_progress',
            );
        });
    });

    describe('the saves that write nothing', () => {
        it('writes nothing for an estimated confirmation', () => {
            // The estimated route has no target stop at all — its figure is
            // confirmed on Review as the first step of generating — so an
            // estimated save answers no wizard screen.
            expect(resolveManualTargetSetupAdvance(onTargetStop(), 'estimated')).toBeNull();
        });

        it('writes nothing when there is no preferences row', () => {
            // The Account-only target edit: the row this save creates is
            // `not_started` with no marker, and advancing it would invent
            // onboarding progress the user never made.
            expect(resolveManualTargetSetupAdvance(null, 'manual')).toBeNull();
        });

        it('writes nothing for a not_started row', () => {
            expect(
                resolveManualTargetSetupAdvance(
                    onTargetStop({ setupStatus: 'not_started', setupStep: null, targetRoute: null }),
                    'manual',
                ),
            ).toBeNull();
        });

        it('writes nothing for a ready_for_review row', () => {
            // The wizard is finished and the user is on Review; a target edit
            // there is not progress through the wizard.
            expect(
                resolveManualTargetSetupAdvance(
                    onTargetStop({ setupStatus: 'ready_for_review', setupStep: 'review' }),
                    'manual',
                ),
            ).toBeNull();
        });

        it('writes nothing for a completed row', () => {
            // The plan-settings target editor. A completed user has a
            // published week, and putting them back into onboarding is the
            // regression the monotonic status rule exists to prevent.
            expect(
                resolveManualTargetSetupAdvance(
                    onTargetStop({ setupStatus: 'completed', setupStep: 'review' }),
                    'manual',
                ),
            ).toBeNull();
        });

        it('writes nothing when the row is on the estimated route', () => {
            // A marker left behind by a route change: the estimated route's
            // stops are not this one's.
            expect(
                resolveManualTargetSetupAdvance(onTargetStop({ targetRoute: 'estimated' }), 'manual'),
            ).toBeNull();
        });

        it.each(['goal', 'body', 'diet', 'dislikes', 'schedule', 'cooking', 'review'] as const)(
            'writes nothing when the marker reads %s rather than targets_manual',
            (marker) => {
                // Before the stop it is a jump ahead; after it the stop has
                // already been answered and progress is not earned twice.
                expect(
                    resolveManualTargetSetupAdvance(onTargetStop({ setupStep: marker }), 'manual'),
                ).toBeNull();
            },
        );

        it('writes nothing when the row carries no marker at all', () => {
            expect(resolveManualTargetSetupAdvance(onTargetStop({ setupStep: null }), 'manual')).toBeNull();
        });
    });
});

/* ---------------------------------------------------------------------------
 * deriveTargetsResponse
 * ------------------------------------------------------------------------- */

describe('deriveTargetsResponse', () => {
    describe('a user who never set targets', () => {
        it('reports no targets, no source and revision 0', () => {
            expect(deriveTargetsResponse(EMPTY_USER_ROW, null)).toEqual({
                targets: null,
                complete: false,
                source: null,
                stale: false,
                revision: 0,
            });
        });

        it('still reports the record revision when a preferences row exists', () => {
            // Editing preferences without confirming targets creates the row
            // without setting any target, and the counter is still the truth.
            expect(deriveTargetsResponse(EMPTY_USER_ROW, preferencesRow({ targets_revision: 7 }))).toEqual({
                targets: null,
                complete: false,
                source: null,
                stale: false,
                revision: 7,
            });
        });
    });

    describe('per-field nullability', () => {
        it('reports a calories-only account field by field, never coercing a missing value to zero', () => {
            expect(
                deriveTargetsResponse(
                    {
                        target_calories: 1900,
                        target_protein_g: null,
                        target_carbs_g: null,
                        target_fat_g: null,
                    },
                    null,
                ),
            ).toEqual({
                targets: { calories: 1900, protein: null, carbs: null, fat: null },
                complete: false,
                source: 'legacy',
                stale: false,
                revision: 0,
            });
        });

        it('treats any single set value as targets being present', () => {
            for (const field of [
                'target_calories',
                'target_protein_g',
                'target_carbs_g',
                'target_fat_g',
            ] as const) {
                const response = deriveTargetsResponse({ ...EMPTY_USER_ROW, [field]: 1 }, null);

                expect(response.targets).not.toBeNull();
                expect(response.complete).toBe(false);
            }
        });

        it('is complete only with all four set', () => {
            expect(deriveTargetsResponse(userRow(), preferencesRow()).complete).toBe(true);
            expect(deriveTargetsResponse(userRow({ target_fat_g: null }), preferencesRow()).complete).toBe(
                false,
            );
        });
    });

    describe('a confirmed estimate', () => {
        it('is attributed to the estimated route', () => {
            expect(deriveTargetsResponse(userRow(), preferencesRow())).toEqual({
                targets: { ...CONFIRMED },
                complete: true,
                source: 'estimated',
                stale: false,
                revision: 3,
            });
        });

        it('is not stale while the preferences revision it was confirmed at still stands', () => {
            expect(
                deriveTargetsResponse(userRow(), preferencesRow({ targets_input_revision: 9, revision: 9 }))
                    .stale,
            ).toBe(false);
        });

        it('becomes stale once the preferences revision moves on, without being recalculated', () => {
            const response = deriveTargetsResponse(
                userRow(),
                preferencesRow({ targets_input_revision: 8, revision: 9 }),
            );

            // The stored numbers are untouched: staleness is a flag the review
            // screen acts on, never a silent recalculation.
            expect(response.stale).toBe(true);
            expect(response.targets).toEqual({ ...CONFIRMED });
        });

        it('is stale when the inputs it came from were never recorded', () => {
            expect(
                deriveTargetsResponse(userRow(), preferencesRow({ targets_input_revision: null })).stale,
            ).toBe(true);
        });
    });

    describe('confirmed manual targets', () => {
        it('are attributed to the manual route', () => {
            expect(deriveTargetsResponse(userRow(), preferencesRow({ target_source: 'manual' }))).toEqual({
                targets: { ...CONFIRMED },
                complete: true,
                source: 'manual',
                stale: false,
                revision: 3,
            });
        });

        it('never go stale, because a change of inputs says nothing about typed numbers', () => {
            expect(
                deriveTargetsResponse(
                    userRow(),
                    preferencesRow({ target_source: 'manual', targets_input_revision: 1, revision: 9 }),
                ).stale,
            ).toBe(false);
        });
    });

    describe('values that cannot be attributed to a route', () => {
        it('reports legacy when there is no preferences row at all', () => {
            const response = deriveTargetsResponse(userRow(), null);

            expect(response.source).toBe('legacy');
            expect(response.revision).toBe(0);
        });

        it('reports legacy when a value no longer matches the confirmed snapshot', () => {
            // The untouched PUT /api/user/targets leaves no other trace, so
            // this comparison is the only way the read stays truthful.
            expect(deriveTargetsResponse(userRow({ target_calories: 2100 }), preferencesRow()).source).toBe(
                'legacy',
            );
        });

        it('detects drift in any one of the four values', () => {
            const drifts: Partial<TargetsUserRow>[] = [
                { target_calories: 1941 },
                { target_protein_g: 147 },
                { target_carbs_g: 195 },
                { target_fat_g: 66 },
            ];

            for (const drift of drifts) {
                expect(deriveTargetsResponse(userRow(drift), preferencesRow()).source).toBe('legacy');
            }
        });

        it('reports legacy when the route column names nothing known', () => {
            for (const route of [null, 'legacy', 'imported', '']) {
                expect(deriveTargetsResponse(userRow(), preferencesRow({ target_source: route })).source).toBe(
                    'legacy',
                );
            }
        });

        it('reports legacy for a snapshot that is absent or malformed', () => {
            const snapshots: unknown[] = [
                null,
                undefined,
                'estimated',
                1940,
                [1940, 146, 194, 65],
                {},
                { calories: 1940, protein: 146, carbs: 194 },
                { calories: 1940, protein: 146, carbs: 194, fat: '65' },
                { calories: 1940, protein: 146, carbs: 194, fat: null },
                { calories: 1940, protein: 146, carbs: 194, fat: Number.NaN },
            ];

            for (const confirmed_targets of snapshots) {
                expect(deriveTargetsResponse(userRow(), preferencesRow({ confirmed_targets })).source).toBe(
                    'legacy',
                );
            }
        });

        it('never reports stale, because those surfaces already ask for a review', () => {
            expect(
                deriveTargetsResponse(
                    userRow({ target_calories: 2100 }),
                    preferencesRow({ targets_input_revision: 1, revision: 9 }),
                ).stale,
            ).toBe(false);
        });

        it('cannot be reached by a partially set account, whatever the snapshot says', () => {
            // The canonical writer only ever confirms all four at once, so an
            // incomplete account was written by something else.
            expect(
                deriveTargetsResponse(userRow({ target_fat_g: null }), preferencesRow()).source,
            ).toBe('legacy');
        });
    });

    describe('snapshot comparison', () => {
        it('ignores keys beyond the four it compares', () => {
            expect(
                deriveTargetsResponse(
                    userRow(),
                    preferencesRow({ confirmed_targets: { ...CONFIRMED, fiber: 30, note: 'confirmed' } }),
                ).source,
            ).toBe('estimated');
        });

        it('requires an exact match, not a close one', () => {
            expect(
                deriveTargetsResponse(
                    userRow(),
                    preferencesRow({ confirmed_targets: { ...CONFIRMED, calories: 1940.5 } }),
                ).source,
            ).toBe('legacy');
        });
    });

    describe('the planner gate', () => {
        // The planner generates only for `complete && source !== 'legacy'`,
        // reporting `targets_missing` for the first failure and
        // `targets_unconfirmed` for the second. One case per reachable
        // combination, so the gate is readable off the tests alone.
        const plannerAccepts = (response: TargetsResponse): boolean =>
            response.complete && response.source !== 'legacy';

        it('admits a complete confirmed estimate', () => {
            const response = deriveTargetsResponse(userRow(), preferencesRow());

            expect([response.complete, response.source]).toEqual([true, 'estimated']);
            expect(plannerAccepts(response)).toBe(true);
        });

        it('admits complete manual targets', () => {
            const response = deriveTargetsResponse(userRow(), preferencesRow({ target_source: 'manual' }));

            expect([response.complete, response.source]).toEqual([true, 'manual']);
            expect(plannerAccepts(response)).toBe(true);
        });

        it('admits a stale estimate, which generation uses as confirmed until the user recalculates', () => {
            const response = deriveTargetsResponse(
                userRow(),
                preferencesRow({ targets_input_revision: 8, revision: 9 }),
            );

            expect([response.complete, response.source, response.stale]).toEqual([true, 'estimated', true]);
            expect(plannerAccepts(response)).toBe(true);
        });

        it('refuses complete values that cannot be attributed to a route', () => {
            const response = deriveTargetsResponse(userRow(), null);

            expect([response.complete, response.source]).toEqual([true, 'legacy']);
            expect(plannerAccepts(response)).toBe(false);
        });

        it('refuses a partially set account', () => {
            const response = deriveTargetsResponse(userRow({ target_fat_g: null }), preferencesRow());

            expect([response.complete, response.source]).toEqual([false, 'legacy']);
            expect(plannerAccepts(response)).toBe(false);
        });

        it('refuses a user who never set targets', () => {
            const response = deriveTargetsResponse(EMPTY_USER_ROW, null);

            expect([response.targets, response.complete, response.source]).toEqual([null, false, null]);
            expect(plannerAccepts(response)).toBe(false);
        });

        it('never reports an incomplete account as a named route, so the two conditions cannot disagree', () => {
            const partials: Partial<TargetsUserRow>[] = [
                { target_calories: null },
                { target_protein_g: null },
                { target_carbs_g: null },
                { target_fat_g: null },
            ];

            for (const partial of partials) {
                for (const route of ['estimated', 'manual']) {
                    const response = deriveTargetsResponse(
                        userRow(partial),
                        preferencesRow({ target_source: route }),
                    );

                    expect(response.complete).toBe(false);
                    expect(response.source).toBe('legacy');
                }
            }
        });
    });

    it('reports the targets revision rather than the preferences revision', () => {
        const response = deriveTargetsResponse(
            userRow(),
            preferencesRow({ targets_revision: 2, revision: 11, targets_input_revision: 11 }),
        );

        expect(response.revision).toBe(2);
    });

    it('does not mutate the rows it was given', () => {
        const user = userRow();
        const preferences = preferencesRow();
        const userSnapshot = { ...user };
        const preferencesSnapshot = { ...preferences };

        deriveTargetsResponse(user, preferences);

        expect(user).toEqual(userSnapshot);
        expect(preferences).toEqual(preferencesSnapshot);
    });
});

/* ---------------------------------------------------------------------------
 * The staleness rule, composed with the saves that drive it
 *
 * `deriveTargetsResponse` compares two revisions; `preferences.service.ts`
 * advances one of them and `targets.service.ts` records the other. Neither half
 * proves the user-visible claim on its own, so this group evolves a stored row
 * exactly as those two writers evolve it — every preference save advances
 * `revision`, and confirming an estimate records the `revision` it was
 * confirmed at — and then reads the verdict off the result.
 * ------------------------------------------------------------------------- */

describe('a confirmed estimate through a sequence of preference saves', () => {
    /** The stored row, as the writers and the read together see it. */
    type StoredRow = EstimateInputsRow & TargetsPreferencesRow;

    /**
     * A freshly confirmed estimate: `targets_input_revision` equals `revision`,
     * which is exactly what "the figure still describes the answers on file"
     * means.
     */
    const confirmedRow = (): StoredRow => ({
        ...REFERENCE_ROW,
        target_source: 'estimated',
        targets_revision: 4,
        confirmed_targets: { ...CONFIRMED },
        targets_input_revision: 12,
        revision: 12,
    });

    /**
     * One preference save, applying exactly what `preferences.service.ts`
     * applies: `revision` ALWAYS advances — that is what a client pins to
     * detect a lost update, so every save has to move it — and nothing else
     * about the confirmed estimate is touched.
     */
    const save = (row: StoredRow, writes: Partial<EstimateInputsRow>): StoredRow => ({
        ...row,
        ...writes,
        revision: row.revision + 1,
    });

    /**
     * Re-confirming the estimate, as `targets.service.ts::saveTargets` does:
     * the ancestry becomes the revision the row is at now, and the targets
     * counter advances because the record was written.
     */
    const reconfirm = (row: StoredRow): StoredRow => ({
        ...row,
        targets_input_revision: row.revision,
        targets_revision: row.targets_revision + 1,
    });

    const staleAfter = (...writes: Partial<EstimateInputsRow>[]): boolean =>
        deriveTargetsResponse(userRow(), writes.reduce(save, confirmedRow())).stale;

    it('starts fresh', () => {
        expect(deriveTargetsResponse(userRow(), confirmedRow())).toEqual({
            targets: { ...CONFIRMED },
            complete: true,
            source: 'estimated',
            stale: false,
            revision: 4,
        });
    });

    it('goes stale on a goal, pace, body or activity change', () => {
        expect(staleAfter({ goal: 'maintain' })).toBe(true);
        expect(staleAfter({ pace_lb_per_week: 0.5 })).toBe(true);
        expect(staleAfter({ weight_kg: 80 })).toBe(true);
        expect(staleAfter({ age: 35 })).toBe(true);
        expect(staleAfter({ height_cm: 175 })).toBe(true);
        expect(staleAfter({ sex_for_estimate: 'male' })).toBe(true);
        expect(staleAfter({ activity_level: 'active' })).toBe(true);
    });

    it('goes stale on any other preference save too, because every save advances the revision', () => {
        // AAP §0.5.2 states the rule as `targets_input_revision !==
        // preferences.revision`, and every preference save advances
        // `revision`. So a diet or schedule edit also puts the confirmed figure
        // behind the answers on file, and the review and settings screens offer
        // "Recalculate". That is the specified behaviour, not an accident of
        // the counter: what the flag claims is "this figure was derived from an
        // earlier state of your answers", which is true here.
        expect(staleAfter({ diet: 'vegan' } as Partial<EstimateInputsRow>)).toBe(true);
        expect(staleAfter({ meal_schedule: 'three_plus_snack' } as Partial<EstimateInputsRow>)).toBe(true);
        expect(staleAfter({ cooking_time_limit_min: 15 } as Partial<EstimateInputsRow>)).toBe(true);
    });

    it('advances the revision once per save, whatever the save edited', () => {
        const afterUnrelated = [
            { diet: 'vegan' } as Partial<EstimateInputsRow>,
            { allergens: ['milk'] } as Partial<EstimateInputsRow>,
            { meal_schedule: 'three_plus_snack' } as Partial<EstimateInputsRow>,
            { budget_amount: 90 } as Partial<EstimateInputsRow>,
            { goal_weight_kg: 70 } as Partial<EstimateInputsRow>,
        ].reduce(save, confirmedRow());
        const afterAnInput = save(confirmedRow(), { activity_level: 'active' });

        // Five saves, five revisions — none of them an answer the equation
        // reads, and the counter advances all the same.
        expect(afterUnrelated.revision).toBe(17);
        expect(afterAnInput.revision).toBe(13);

        // Both are stale, because both are figures confirmed at revision 12
        // against rows that have moved past it.
        expect(deriveTargetsResponse(userRow(), afterUnrelated).stale).toBe(true);
        expect(deriveTargetsResponse(userRow(), afterAnInput).stale).toBe(true);
    });

    it('goes stale on a body step re-saved with the same measurements, which is still a save', () => {
        const row = confirmedRow();
        const rewritten = save(row, {
            age: row.age,
            height_cm: row.height_cm,
            weight_kg: row.weight_kg,
            sex_for_estimate: row.sex_for_estimate,
        });

        // Nothing the equation reads moved, and the revision still advanced,
        // so the ancestry no longer matches.
        expect(rewritten.revision).toBe(13);
        expect(deriveTargetsResponse(userRow(), rewritten).stale).toBe(true);
    });

    it('stays stale once it is stale, whatever is edited afterwards', () => {
        expect(
            staleAfter({ activity_level: 'active' }, { diet: 'vegan' } as Partial<EstimateInputsRow>),
        ).toBe(true);
    });

    it('is fresh again once the user reconfirms, and only then', () => {
        // The recalculation the review screen offers is the ONLY thing that
        // clears the flag: nothing recomputes on its own.
        const edited = save(confirmedRow(), { activity_level: 'active' });
        const reconfirmed = reconfirm(edited);

        expect(deriveTargetsResponse(userRow(), edited).stale).toBe(true);
        expect(deriveTargetsResponse(userRow(), reconfirmed).stale).toBe(false);
        expect(deriveTargetsResponse(userRow(), reconfirmed).revision).toBe(5);

        // And one more unrelated save puts it behind again.
        expect(
            deriveTargetsResponse(userRow(), save(reconfirmed, { diet: 'vegan' } as Partial<EstimateInputsRow>))
                .stale,
        ).toBe(true);
    });

    it('never goes stale on the manual route, however many saves follow', () => {
        const manual: StoredRow = { ...confirmedRow(), target_source: 'manual', targets_input_revision: null };
        const edited = [
            { activity_level: 'active' },
            { weight_kg: 80 },
            { diet: 'vegan' } as Partial<EstimateInputsRow>,
        ].reduce(save, manual);

        expect(deriveTargetsResponse(userRow(), edited).stale).toBe(false);
        expect(deriveTargetsResponse(userRow(), edited).source).toBe('manual');
    });

    it('keeps the confirmed numbers and the targets revision throughout', () => {
        // Staleness is a flag the review screen acts on. Nothing here recomputes
        // a target or bumps the counter a client pins for its own saves.
        const edited = [
            { diet: 'vegan' } as Partial<EstimateInputsRow>,
            { activity_level: 'active' },
        ].reduce(save, confirmedRow());
        const response = deriveTargetsResponse(userRow(), edited);

        expect(response.targets).toEqual({ ...CONFIRMED });
        expect(response.revision).toBe(4);
        expect(edited.revision).toBe(14);
        expect(response.stale).toBe(true);
    });
});

/* ---------------------------------------------------------------------------
 * Determinism
 * ------------------------------------------------------------------------- */

describe('determinism', () => {
    afterEach(() => {
        jest.useRealTimers();
    });

    it('produces identical output for identical input', () => {
        expect(estimateFrom(REFERENCE_ROW, 4)).toEqual(estimateFrom(REFERENCE_ROW, 4));
        expect(parseManualTargets(manualBody())).toEqual(parseManualTargets(manualBody()));
        expect(deriveTargetsResponse(userRow(), preferencesRow())).toEqual(
            deriveTargetsResponse(userRow(), preferencesRow()),
        );
    });

    it('does not depend on the clock', () => {
        jest.useFakeTimers();

        jest.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
        const firstEstimate = estimateFrom(REFERENCE_ROW, 4);
        const firstResponse = deriveTargetsResponse(userRow(), preferencesRow());

        jest.setSystemTime(new Date('2031-07-04T23:59:59.000Z'));

        expect(estimateFrom(REFERENCE_ROW, 4)).toEqual(firstEstimate);
        expect(deriveTargetsResponse(userRow(), preferencesRow())).toEqual(firstResponse);
    });
});
