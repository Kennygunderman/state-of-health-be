import { describe, expect, it } from 'vitest';
import {
    addDays,
    computePlan,
    computeSnapshots,
    computeTrendSeries,
    daysBetween,
    formulaTdee,
    lbsToKg,
    qualifyingIntakeDays,
    DailyIntake,
    DailyWeight,
    EngineProfile,
} from '../engine';

const PROFILE: EngineProfile = { sex: 'male', birthDate: '1996-01-15', heightCm: 180 };
const START = '2026-04-01';

/**
 * Simulates a user with a fixed true TDEE eating a fixed intake and losing
 * (or gaining) weight at exactly the energy-balance rate, weighing in daily
 * with deterministic scale noise. Returns engine inputs.
 */
const simulateUser = (opts: {
    trueTdee: number;
    intake: number;
    startWeightKg: number;
    days: number;
    weighEvery?: number; // weigh-in every N days (default 1)
    logEvery?: number; // intake logged every N days (default 1)
    noiseKg?: number; // deterministic alternating scale noise amplitude
}): { weights: DailyWeight[]; intakes: DailyIntake[]; endDay: string } => {
    const { trueTdee, intake, startWeightKg, days } = opts;
    const weighEvery = opts.weighEvery ?? 1;
    const logEvery = opts.logEvery ?? 1;
    const noiseKg = opts.noiseKg ?? 0;
    const dailyDeltaKg = (intake - trueTdee) / 7700;

    const weights: DailyWeight[] = [];
    const intakes: DailyIntake[] = [];
    for (let i = 0; i < days; i += 1) {
        const day = addDays(START, i);
        const weight = startWeightKg + dailyDeltaKg * i;
        if (i % weighEvery === 0) {
            // Deterministic pseudo-noise: alternates sign, varies by index.
            const noise = noiseKg * Math.sin(i * 2.399);
            weights.push({ day, weightKg: weight + noise });
        }
        if (i % logEvery === 0) {
            intakes.push({ day, kcal: intake });
        }
    }
    return { weights, intakes, endDay: addDays(START, days - 1) };
};

describe('day-key arithmetic', () => {
    it('adds and diffs day keys across month boundaries', () => {
        expect(addDays('2026-04-30', 1)).toBe('2026-05-01');
        expect(addDays('2026-05-01', -1)).toBe('2026-04-30');
        expect(daysBetween('2026-04-01', '2026-05-01')).toBe(30);
    });
});

describe('formulaTdee (cold start)', () => {
    it('computes Mifflin-St Jeor x activity for a known case', () => {
        // 30yo male, 80kg, 180cm: BMR = 800 + 1125 - 150 + 5 = 1780; x1.4 = 2492
        const profile: EngineProfile = { sex: 'male', birthDate: '1996-04-01', heightCm: 180 };
        expect(formulaTdee(profile, 80, '2026-04-01')).toBe(2492);
    });

    it('falls back to population averages when profile is empty', () => {
        const tdee = formulaTdee({ sex: null, birthDate: null, heightCm: null }, null, START);
        expect(tdee).toBeGreaterThan(1800);
        expect(tdee).toBeLessThan(2600);
    });
});

describe('computeTrendSeries', () => {
    it('returns nulls when there are no weigh-ins', () => {
        const series = computeTrendSeries([], START, addDays(START, 4));
        expect(series).toHaveLength(5);
        expect(series.every((s) => s.trendKg === null)).toBe(true);
    });

    it('smooths daily noise: trend stays near the true line', () => {
        const { weights } = simulateUser({
            trueTdee: 2800, intake: 2300, startWeightKg: 90, days: 60, noiseKg: 1.2,
        });
        const series = computeTrendSeries(weights, START, addDays(START, 59));
        const last = series[series.length - 1];
        const trueEnd = 90 + ((2300 - 2800) / 7700) * 59;
        expect(last.trendKg).not.toBeNull();
        // EMA lags a falling line slightly; allow a small band.
        expect(Math.abs((last.trendKg as number) - trueEnd)).toBeLessThan(0.8);
    });

    it('is idempotent across different window starts (warm-up)', () => {
        const { weights } = simulateUser({
            trueTdee: 2800, intake: 2300, startWeightKg: 90, days: 60,
        });
        const full = computeTrendSeries(weights, START, addDays(START, 59));
        const windowed = computeTrendSeries(weights, addDays(START, 30), addDays(START, 59));
        const fullLast = full[full.length - 1].trendKg as number;
        const windowedLast = windowed[windowed.length - 1].trendKg as number;
        expect(Math.abs(fullLast - windowedLast)).toBeLessThan(1e-9);
    });
});

describe('qualifyingIntakeDays', () => {
    it('excludes days under the absolute kcal floor', () => {
        const intakes: DailyIntake[] = [
            { day: START, kcal: 2200 },
            { day: addDays(START, 1), kcal: 300 }, // forgot to log most meals
            { day: addDays(START, 2), kcal: 2100 },
        ];
        const qualifying = qualifyingIntakeDays(intakes);
        expect(qualifying.has(START)).toBe(true);
        expect(qualifying.has(addDays(START, 1))).toBe(false);
        expect(qualifying.has(addDays(START, 2))).toBe(true);
    });

    it('excludes days far below the user\'s own median (partial logging)', () => {
        const intakes: DailyIntake[] = [];
        for (let i = 0; i < 10; i += 1) intakes.push({ day: addDays(START, i), kcal: 3000 });
        intakes.push({ day: addDays(START, 10), kcal: 1200 }); // < 50% of median 3000
        const qualifying = qualifyingIntakeDays(intakes);
        expect(qualifying.has(addDays(START, 10))).toBe(false);
    });

    it('excludes the first day back after a logging gap', () => {
        const intakes: DailyIntake[] = [
            { day: START, kcal: 2200 },
            { day: addDays(START, 5), kcal: 2200 }, // 5-day gap
            { day: addDays(START, 6), kcal: 2200 },
        ];
        const qualifying = qualifyingIntakeDays(intakes);
        expect(qualifying.has(addDays(START, 5))).toBe(false);
        expect(qualifying.has(addDays(START, 6))).toBe(true);
    });
});

describe('computeSnapshots — convergence', () => {
    it('converges to the true TDEE within ±100 kcal for a steady loser', () => {
        const { weights, intakes, endDay } = simulateUser({
            trueTdee: 2800, intake: 2300, startWeightKg: 90, days: 60,
        });
        const snapshots = computeSnapshots({ profile: PROFILE, weights, intakes, fromDay: START, toDay: endDay });
        const last = snapshots[snapshots.length - 1];
        expect(Math.abs(last.tdeeKcal - 2800)).toBeLessThanOrEqual(100);
        expect(last.confidence).toBe('high');
    });

    it('converges for a gainer', () => {
        const { weights, intakes, endDay } = simulateUser({
            trueTdee: 2600, intake: 3000, startWeightKg: 70, days: 60,
        });
        const snapshots = computeSnapshots({ profile: PROFILE, weights, intakes, fromDay: START, toDay: endDay });
        const last = snapshots[snapshots.length - 1];
        expect(Math.abs(last.tdeeKcal - 2600)).toBeLessThanOrEqual(100);
    });

    it('converges (more loosely) with noisy scale data and every-other-day weigh-ins', () => {
        const { weights, intakes, endDay } = simulateUser({
            trueTdee: 2800, intake: 2300, startWeightKg: 90, days: 60, noiseKg: 1.0, weighEvery: 2,
        });
        const snapshots = computeSnapshots({ profile: PROFILE, weights, intakes, fromDay: START, toDay: endDay });
        const last = snapshots[snapshots.length - 1];
        expect(Math.abs(last.tdeeKcal - 2800)).toBeLessThanOrEqual(150);
    });

    it('starts at the formula estimate and reports calibrating with no data', () => {
        const snapshots = computeSnapshots({
            profile: PROFILE, weights: [], intakes: [], fromDay: START, toDay: addDays(START, 9),
        });
        expect(snapshots).toHaveLength(10);
        const last = snapshots[snapshots.length - 1];
        expect(last.confidence).toBe('calibrating');
        expect(last.trendWeightKg).toBeNull();
        expect(last.tdeeKcal).toBe(formulaTdee(PROFILE, null, last.day));
    });

    it('never produces NaN or out-of-band values on degenerate input', () => {
        const weights: DailyWeight[] = [{ day: START, weightKg: 90 }, { day: addDays(START, 1), weightKg: 30 }];
        const intakes: DailyIntake[] = [
            { day: START, kcal: 12000 },
            { day: addDays(START, 1), kcal: 900 },
        ];
        const snapshots = computeSnapshots({
            profile: PROFILE, weights, intakes, fromDay: START, toDay: addDays(START, 5),
        });
        for (const s of snapshots) {
            expect(Number.isFinite(s.tdeeKcal)).toBe(true);
            expect(s.tdeeKcal).toBeGreaterThan(500);
            expect(s.tdeeKcal).toBeLessThan(7000);
        }
    });

    it('is idempotent: recomputing the same window yields identical output', () => {
        const { weights, intakes, endDay } = simulateUser({
            trueTdee: 2800, intake: 2300, startWeightKg: 90, days: 45, noiseKg: 0.8,
        });
        const a = computeSnapshots({ profile: PROFILE, weights, intakes, fromDay: START, toDay: endDay });
        const b = computeSnapshots({ profile: PROFILE, weights, intakes, fromDay: START, toDay: endDay });
        expect(a).toEqual(b);
    });

    it('sparse loggers stay at low/calibrating confidence', () => {
        const { weights, intakes, endDay } = simulateUser({
            trueTdee: 2800, intake: 2300, startWeightKg: 90, days: 30, logEvery: 4, weighEvery: 7,
        });
        const snapshots = computeSnapshots({ profile: PROFILE, weights, intakes, fromDay: START, toDay: endDay });
        const last = snapshots[snapshots.length - 1];
        expect(['calibrating', 'low']).toContain(last.confidence);
    });
});

describe('computePlan — guardrails', () => {
    const base = {
        goal: 'lose' as const,
        ratePctBw: 0.5,
        tdeeKcal: 2800,
        trendWeightKg: 90,
        sex: 'male' as const,
        proteinPrefGPerKg: null,
        fatBias: null,
        previousCalories: null,
    };

    it('computes a sane cut for a 90kg male at 0.5%BW/week', () => {
        const plan = computePlan(base);
        // deficit: 0.5% x 90kg x 7700 / 7 ≈ 495/day → ~2300 target
        expect(plan.calories).toBeGreaterThanOrEqual(2275);
        expect(plan.calories).toBeLessThanOrEqual(2325);
        expect(plan.proteinG).toBe(200); // 2.2 g/kg x 90, rounded to 5
        const kcalFromMacros = plan.proteinG * 4 + plan.carbsG * 4 + plan.fatG * 9;
        expect(Math.abs(kcalFromMacros - plan.calories)).toBeLessThanOrEqual(60);
        expect(plan.guardrails).toEqual([]);
    });

    it('clamps to the calorie floor', () => {
        const plan = computePlan({ ...base, tdeeKcal: 1600, trendWeightKg: 55, sex: 'female', ratePctBw: 1.0 });
        expect(plan.calories).toBe(1200);
        expect(plan.guardrails).toContain('calorie_floor');
    });

    it('limits week-over-week swing to 150 kcal', () => {
        const plan = computePlan({ ...base, previousCalories: 2700 });
        expect(plan.calories).toBe(2550);
        expect(plan.guardrails).toContain('max_weekly_swing');
    });

    it('maintain goal targets TDEE itself', () => {
        const plan = computePlan({ ...base, goal: 'maintain' });
        expect(Math.abs(plan.calories - 2800)).toBeLessThanOrEqual(25);
    });
});

describe('unit conversion', () => {
    it('round-trips lbs to kg', () => {
        expect(lbsToKg(220.46226218)).toBeCloseTo(100, 6);
    });
});
