import { describe, expect, it } from 'vitest';
import { weekStartFor } from '../engine';
import { buildWeeklyPlan, BuildWeeklyPlanInput } from '../planBuilder';

const BASE: BuildWeeklyPlanInput = {
    goal: 'lose',
    ratePctBw: 0.5,
    proteinPrefGPerKg: null,
    fatBias: null,
    sex: 'male',
    tdeeKcal: 2800,
    trendWeightKg: 90,
    confidence: 'high',
    previousPlan: null,
};

describe('weekStartFor', () => {
    it('returns the Monday of the containing week', () => {
        expect(weekStartFor('2026-07-06')).toBe('2026-07-06'); // Monday
        expect(weekStartFor('2026-07-09')).toBe('2026-07-06'); // Thursday
        expect(weekStartFor('2026-07-12')).toBe('2026-07-06'); // Sunday
        expect(weekStartFor('2026-07-13')).toBe('2026-07-13'); // next Monday
    });
});

describe('buildWeeklyPlan', () => {
    it('computes a fresh plan with full rationale when confidence is sufficient', () => {
        const plan = buildWeeklyPlan(BASE);
        expect(plan.calories).toBeGreaterThanOrEqual(2275);
        expect(plan.calories).toBeLessThanOrEqual(2325);
        expect(plan.rationale.held).toBe(false);
        expect(plan.rationale.previousTdeeKcal).toBeNull();
        expect(plan.rationale.confidence).toBe('high');
        expect(plan.tdeeKcal).toBe(2800);
    });

    it('holds last week\'s targets while calibrating', () => {
        const plan = buildWeeklyPlan({
            ...BASE,
            confidence: 'calibrating',
            previousPlan: { calories: 2400, proteinG: 200, carbsG: 220, fatG: 70, tdeeKcal: 2750 },
        });
        expect(plan.calories).toBe(2400);
        expect(plan.proteinG).toBe(200);
        expect(plan.rationale.held).toBe(true);
        expect(plan.rationale.guardrails).toContain('data_quality_hold');
        expect(plan.rationale.previousTdeeKcal).toBe(2750);
    });

    it('never holds the very first plan, even while calibrating', () => {
        const plan = buildWeeklyPlan({ ...BASE, confidence: 'calibrating', previousPlan: null });
        expect(plan.rationale.held).toBe(false);
        expect(plan.calories).toBeGreaterThan(0);
    });

    it('applies the swing guardrail against the previous plan', () => {
        const plan = buildWeeklyPlan({
            ...BASE,
            previousPlan: { calories: 2700, proteinG: 200, carbsG: 250, fatG: 75, tdeeKcal: 2900 },
        });
        expect(plan.calories).toBe(2550); // 2700 - 150 max swing
        expect(plan.rationale.guardrails).toContain('max_weekly_swing');
    });

    it('falls back to a population-average weight when there are no weigh-ins', () => {
        const plan = buildWeeklyPlan({ ...BASE, trendWeightKg: null });
        expect(plan.calories).toBeGreaterThan(1500);
        expect(plan.proteinG).toBe(175); // 2.2 g/kg x 80kg male fallback, rounded to 5
        expect(plan.rationale.trendWeightKg).toBeNull();
    });

    it('low/medium confidence still updates targets (only calibrating holds)', () => {
        const plan = buildWeeklyPlan({
            ...BASE,
            confidence: 'low',
            previousPlan: { calories: 2400, proteinG: 200, carbsG: 220, fatG: 70, tdeeKcal: 2750 },
        });
        expect(plan.rationale.held).toBe(false);
    });
});
