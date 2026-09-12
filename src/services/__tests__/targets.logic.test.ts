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
//  * the four ways stored targets stop being attributable to a route.
//
// No database, no mocks, no clock: every function under test is pure, and the
// determinism group asserts that directly.

import {
    ACTIVITY_FACTORS,
    applyTargetBounds,
    assessFeasibility,
    CALORIE_CEILING,
    CALORIE_FLOOR_BY_SEX,
    CalculableEstimateInputs,
    calculateBmr,
    calculateGoalAdjustment,
    calculateTdee,
    computeTargetEstimate,
    deriveMacroTargets,
    deriveTargetsResponse,
    EstimateInputsRow,
    KCAL_PER_POUND_PER_WEEK_PER_DAY,
    MANUAL_CALORIE_RANGE,
    MANUAL_MACRO_RANGE,
    parseManualTargets,
    resolveEstimateInputs,
    TargetsPreferencesRow,
    TargetsUserRow,
} from '../targets.logic';

/* ---------------------------------------------------------------------------
 * Fixtures
 * ------------------------------------------------------------------------- */

/**
 * The reference user: female, 34, 177.8 cm, 82.6 kg, lightly active, losing
 * 1 lb a week. Chosen because every step of her derivation is an awkward
 * number — a 1606.25 kcal basal rate and a 2208.59 kcal maintenance rate — so
 * any change to the rounding order moves the result.
 */
const REFERENCE_ROW: EstimateInputsRow = {
    goal: 'lose',
    pace_lb_per_week: 1,
    age: 34,
    height_cm: 177.8,
    weight_kg: 82.6,
    sex_for_estimate: 'female',
    activity_level: 'lightly_active',
};

/** The low corner of the supported envelope: a 389 kcal basal rate. */
const LOW_CORNER: EstimateInputsRow = {
    goal: 'maintain',
    pace_lb_per_week: null,
    age: 100,
    height_cm: 120,
    weight_kg: 30,
    sex_for_estimate: 'female',
    activity_level: 'not_very_active',
};

/** The high corner: a 4477.5 kcal basal rate and a 7723.69 kcal maintenance rate. */
const HIGH_CORNER: EstimateInputsRow = {
    goal: 'maintain',
    pace_lb_per_week: null,
    age: 18,
    height_cm: 250,
    weight_kg: 300,
    sex_for_estimate: 'male',
    activity_level: 'very_active',
};

const readyInputs = (row: EstimateInputsRow): CalculableEstimateInputs => {
    const resolved = resolveEstimateInputs(row);

    if (resolved.kind !== 'ready') {
        throw new Error(`fixture is not estimable: ${resolved.reason}`);
    }

    return resolved.inputs;
};

const estimateFrom = (row: EstimateInputsRow, estimateRevision = 0) =>
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
    it('multiplies the basal rate by the factor for each of the four levels', () => {
        expect(calculateTdee(2000, 'not_very_active')).toBeCloseTo(2400, 10);
        expect(calculateTdee(2000, 'lightly_active')).toBeCloseTo(2750, 10);
        expect(calculateTdee(2000, 'active')).toBeCloseTo(3100, 10);
        expect(calculateTdee(2000, 'very_active')).toBeCloseTo(3450, 10);
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

        it('does not report a clamp for a difference too small to be visible', () => {
            // Rounds to 1200, which is the floor: the presented number is not
            // visibly adjusted, so the caption must not appear.
            expect(applyTargetBounds(1199.6, 1000, 'female')).toEqual({
                calories: 1200,
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
    });

    describe('the basal rate', () => {
        it('raises the figure and reports below_bmr when it exceeds the floor', () => {
            expect(applyTargetBounds(1410, 1800, 'male')).toEqual({
                calories: 1800,
                clamped: true,
                clampReason: 'below_bmr',
            });
        });

        it('rounds the basal bound so the result is always a whole kcal', () => {
            expect(applyTargetBounds(1000, 1799.6, 'male')).toEqual({
                calories: 1800,
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
        const cases: [string, EstimateInputsRow, number, string | null][] = [
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

describe('assessFeasibility', () => {
    it('reports nothing for a coherent set', () => {
        expect(assessFeasibility({ calories: 1940, protein: 146, carbs: 194, fat: 65 })).toEqual({
            ok: true,
            warnings: [],
        });
    });

    describe('macro energy mismatch', () => {
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

        it('is not stale while the inputs it came from are unchanged', () => {
            expect(
                deriveTargetsResponse(
                    userRow(),
                    preferencesRow({ targets_input_revision: 9, revision: 9 }),
                ).stale,
            ).toBe(false);
        });

        it('becomes stale once the inputs move on, without being recalculated', () => {
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
