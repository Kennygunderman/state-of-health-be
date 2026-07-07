// Coach engine — pure adaptive-TDEE math. No DB access, no clock access:
// everything comes in as arguments and the same inputs always produce the
// same outputs, which is what makes recompute-on-read safe (coach.service
// recomputes a rolling window on every read instead of tracking deltas).
// Design + constants rationale: tdee-coach-plan.md §2.

export type Sex = 'male' | 'female' | 'unspecified';
export type Confidence = 'calibrating' | 'low' | 'medium' | 'high';
export type CoachGoal = 'lose' | 'maintain' | 'gain';

export interface EngineProfile {
    sex: Sex | null;
    /** 'YYYY-MM-DD' */
    birthDate: string | null;
    heightCm: number | null;
}

/** One local day's total logged intake. Days with zero logs must be omitted. */
export interface DailyIntake {
    day: string; // 'YYYY-MM-DD', user-local
    kcal: number;
}

/** Average of a local day's weigh-ins, already converted to kg. */
export interface DailyWeight {
    day: string; // 'YYYY-MM-DD', user-local
    weightKg: number;
}

export interface Snapshot {
    day: string;
    trendWeightKg: number | null;
    tdeeKcal: number;
    confidence: Confidence;
}

export interface PlanInput {
    goal: CoachGoal;
    ratePctBw: number; // %BW per week, positive; direction comes from goal
    tdeeKcal: number;
    trendWeightKg: number;
    sex: Sex | null;
    proteinPrefGPerKg: number | null;
    fatBias: 'low' | 'balanced' | 'high' | null;
    /** Last week's plan calories, for the ±MAX_WEEKLY_SWING guardrail. */
    previousCalories: number | null;
}

export interface PlanResult {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    guardrails: string[]; // machine-readable list of guardrails that fired
}

// --- Constants (plan §2) ---

/** Daily EMA smoothing factor for trend weight. */
const TREND_ALPHA = 0.1;
/** Smoothing factor for the TDEE update from each qualifying day. */
const TDEE_BETA = 0.06;
/** kcal stored per kg of body-weight change (mixed-tissue approximation). */
const KCAL_PER_KG = 7700;
/** Single-day implied-TDEE clamp before smoothing (outlier protection). */
const IMPLIED_TDEE_MIN = 1000;
const IMPLIED_TDEE_MAX = 6000;
/** Formula→measured blend: weight of the formula hits 0 after this many qualifying days. */
const BLEND_DAYS = 21;
/** A day's intake qualifies if >= max(this, 50% of trailing median). */
const QUALIFYING_KCAL_FLOOR = 800;
/** Days after a logging gap of >= GAP_DAYS whose first day is excluded. */
const GAP_DAYS = 3;
/** Trailing window for confidence counts. */
const CONFIDENCE_WINDOW_DAYS = 14;
/** Activity factor applied to Mifflin-St Jeor BMR for the cold-start estimate.
 *  Phase 1 uses a fixed "lightly active" default; steps/workouts refine later. */
const DEFAULT_ACTIVITY_FACTOR = 1.4;

/** Plan guardrails (plan §1.4). */
const CALORIE_FLOOR_FEMALE = 1200;
const CALORIE_FLOOR_MALE = 1500;
const MAX_WEEKLY_SWING_KCAL = 150;
const KCAL_PER_G_PROTEIN = 4;
const KCAL_PER_G_CARB = 4;
const KCAL_PER_G_FAT = 9;

// --- Day-key arithmetic ('YYYY-MM-DD', no timezones inside the engine) ---

const dayToUtcMs = (day: string): number => Date.parse(`${day}T00:00:00Z`);

const MS_PER_DAY = 24 * 60 * 60 * 1000;

export const addDays = (day: string, days: number): string =>
    new Date(dayToUtcMs(day) + days * MS_PER_DAY).toISOString().slice(0, 10);

export const daysBetween = (fromDay: string, toDay: string): number =>
    Math.round((dayToUtcMs(toDay) - dayToUtcMs(fromDay)) / MS_PER_DAY);

/** Monday of the week containing the given day (weeks are user-local Monday-start). */
export const weekStartFor = (day: string): string => {
    const dayOfWeek = new Date(dayToUtcMs(day)).getUTCDay(); // 0 Sun .. 6 Sat
    return addDays(day, -((dayOfWeek + 6) % 7));
};

// --- Cold start (Mifflin-St Jeor) ---

const FALLBACKS: Record<Sex, { weightKg: number; heightCm: number }> = {
    male: { weightKg: 80, heightCm: 175 },
    female: { weightKg: 70, heightCm: 162 },
    unspecified: { weightKg: 75, heightCm: 168 },
};

/** Population-average weight used when a user has never weighed in. */
export const fallbackWeightKg = (sex: Sex | null): number => FALLBACKS[sex ?? 'unspecified'].weightKg;
const FALLBACK_AGE_YEARS = 30;

const ageFromBirthDate = (birthDate: string | null, onDay: string): number => {
    if (!birthDate) return FALLBACK_AGE_YEARS;
    const years = daysBetween(birthDate, onDay) / 365.25;
    return years > 0 && years < 120 ? years : FALLBACK_AGE_YEARS;
};

export const formulaTdee = (profile: EngineProfile, weightKg: number | null, onDay: string): number => {
    const sex: Sex = profile.sex ?? 'unspecified';
    const w = weightKg ?? FALLBACKS[sex].weightKg;
    const h = profile.heightCm ?? FALLBACKS[sex].heightCm;
    const age = ageFromBirthDate(profile.birthDate, onDay);
    const base = 10 * w + 6.25 * h - 5 * age;
    // Mifflin-St Jeor constants: +5 male, -161 female; midpoint for unspecified.
    const sexTerm = sex === 'male' ? 5 : sex === 'female' ? -161 : -78;
    return Math.round((base + sexTerm) * DEFAULT_ACTIVITY_FACTOR);
};

// --- Trend weight ---

/**
 * Daily trend-weight series across [fromDay, toDay]. Weigh-ins are linearly
 * interpolated to a daily series first (flat-extended at the edges), then
 * EMA-smoothed. Days before the first weigh-in have a null trend.
 */
export const computeTrendSeries = (
    weights: DailyWeight[],
    fromDay: string,
    toDay: string,
): Array<{ day: string; trendKg: number | null }> => {
    const sorted = [...weights].sort((a, b) => a.day.localeCompare(b.day));
    const result: Array<{ day: string; trendKg: number | null }> = [];
    if (sorted.length === 0) {
        for (let d = fromDay; d <= toDay; d = addDays(d, 1)) result.push({ day: d, trendKg: null });
        return result;
    }

    const first = sorted[0];
    const last = sorted[sorted.length - 1];
    const interpolated = (day: string): number => {
        if (day <= first.day) return first.weightKg;
        if (day >= last.day) return last.weightKg;
        let lo = first;
        let hi = last;
        for (const w of sorted) {
            if (w.day <= day && w.day > lo.day) lo = w;
            if (w.day >= day && w.day < hi.day) hi = w;
        }
        if (lo.day === hi.day) return lo.weightKg;
        const t = daysBetween(lo.day, day) / daysBetween(lo.day, hi.day);
        return lo.weightKg + t * (hi.weightKg - lo.weightKg);
    };

    // Seed the EMA at the first weigh-in so early trend isn't dragged by the seed.
    let ema = first.weightKg;
    // Warm the EMA through any history before the requested window so the
    // window's first day is consistent regardless of fromDay (idempotency).
    for (let d = first.day; d < fromDay; d = addDays(d, 1)) {
        ema = ema + TREND_ALPHA * (interpolated(d) - ema);
    }
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
        if (d < first.day) {
            result.push({ day: d, trendKg: null });
            continue;
        }
        ema = ema + TREND_ALPHA * (interpolated(d) - ema);
        result.push({ day: d, trendKg: ema });
    }
    return result;
};

// --- Qualifying-day gates (plan §2.4) ---

const median = (values: number[]): number => {
    if (values.length === 0) return 0;
    const s = [...values].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 === 0 ? (s[mid - 1] + s[mid]) / 2 : s[mid];
};

/**
 * A day's intake qualifies for the TDEE update if it clears the kcal floor
 * (absolute + relative to the user's own trailing median) and isn't the first
 * logged day right after a gap (returning-from-vacation days are unreliable).
 */
export const qualifyingIntakeDays = (intakes: DailyIntake[]): Set<string> => {
    const sorted = [...intakes].sort((a, b) => a.day.localeCompare(b.day));
    const qualifying = new Set<string>();
    sorted.forEach((intake, i) => {
        const trailing = sorted.slice(Math.max(0, i - 14), i).map((x) => x.kcal);
        const floor = Math.max(QUALIFYING_KCAL_FLOOR, trailing.length >= 5 ? median(trailing) * 0.5 : 0);
        if (intake.kcal < floor) return;
        if (i > 0 && daysBetween(sorted[i - 1].day, intake.day) >= GAP_DAYS) return;
        qualifying.add(intake.day);
    });
    return qualifying;
};

const confidenceFor = (
    day: string,
    qualifying: Set<string>,
    weighDays: Set<string>,
): Confidence => {
    let intakeCount = 0;
    let weighCount = 0;
    for (let d = addDays(day, -(CONFIDENCE_WINDOW_DAYS - 1)); d <= day; d = addDays(d, 1)) {
        if (qualifying.has(d)) intakeCount += 1;
        if (weighDays.has(d)) weighCount += 1;
    }
    if (intakeCount >= 10 && weighCount >= 5) return 'high';
    if (intakeCount >= 8 && weighCount >= 4) return 'medium';
    if (intakeCount >= 5 && weighCount >= 2) return 'low';
    return 'calibrating';
};

// --- Main: daily snapshots ---

export interface ComputeSnapshotsInput {
    profile: EngineProfile;
    weights: DailyWeight[];
    intakes: DailyIntake[];
    /** Inclusive window, 'YYYY-MM-DD'. Callers pass ~90 days ending yesterday. */
    fromDay: string;
    toDay: string;
}

/**
 * Recomputes the full snapshot series for [fromDay, toDay]. The measured TDEE
 * walks forward from the formula estimate, absorbing each qualifying day's
 * implied TDEE (intake minus energy stored in trend-weight change), and is
 * blended with the formula while data is scarce.
 */
export const computeSnapshots = (input: ComputeSnapshotsInput): Snapshot[] => {
    const { profile, weights, intakes, fromDay, toDay } = input;
    if (fromDay > toDay) return [];

    const trendSeries = computeTrendSeries(weights, fromDay, toDay);
    const trendByDay = new Map(trendSeries.map((t) => [t.day, t.trendKg]));
    const intakeByDay = new Map(intakes.map((i) => [i.day, i.kcal]));
    const qualifying = qualifyingIntakeDays(intakes);
    const weighDays = new Set(weights.map((w) => w.day));

    const firstTrend = trendSeries.find((t) => t.trendKg !== null)?.trendKg ?? null;
    let measured = formulaTdee(profile, firstTrend, fromDay);
    let qualifyingSeen = 0;
    let prevTrend: number | null = null;

    const snapshots: Snapshot[] = [];
    for (let d = fromDay; d <= toDay; d = addDays(d, 1)) {
        const trend = trendByDay.get(d) ?? null;
        const intake = intakeByDay.get(d);

        if (intake !== undefined && qualifying.has(d) && trend !== null && prevTrend !== null) {
            const deltaKg = trend - prevTrend;
            const implied = Math.min(
                IMPLIED_TDEE_MAX,
                Math.max(IMPLIED_TDEE_MIN, intake - deltaKg * KCAL_PER_KG),
            );
            measured = measured + TDEE_BETA * (implied - measured);
            qualifyingSeen += 1;
        }

        const formulaWeight = Math.max(0, 1 - qualifyingSeen / BLEND_DAYS);
        const blended = Math.round(
            formulaWeight * formulaTdee(profile, trend, d) + (1 - formulaWeight) * measured,
        );

        snapshots.push({
            day: d,
            trendWeightKg: trend === null ? null : Math.round(trend * 100) / 100,
            tdeeKcal: blended,
            confidence: confidenceFor(d, qualifying, weighDays),
        });
        if (trend !== null) prevTrend = trend;
    }
    return snapshots;
};

// --- Weekly plan math (used by Phase 2's generator; pure and tested now) ---

const round5 = (n: number): number => Math.round(n / 5) * 5;
const round25 = (n: number): number => Math.round(n / 25) * 25;

const defaultProteinGPerKg = (goal: CoachGoal): number =>
    goal === 'gain' ? 2.0 : goal === 'lose' ? 2.2 : 1.8;

export const computePlan = (input: PlanInput): PlanResult => {
    const guardrails: string[] = [];
    const direction = input.goal === 'lose' ? -1 : input.goal === 'gain' ? 1 : 0;
    const weeklyDeltaKcal = direction * (input.ratePctBw / 100) * input.trendWeightKg * KCAL_PER_KG;
    let calories = round25(input.tdeeKcal + weeklyDeltaKcal / 7);

    const floor = input.sex === 'male' ? CALORIE_FLOOR_MALE : CALORIE_FLOOR_FEMALE;
    if (calories < floor) {
        calories = floor;
        guardrails.push('calorie_floor');
    }
    if (input.previousCalories !== null) {
        const swing = calories - input.previousCalories;
        if (Math.abs(swing) > MAX_WEEKLY_SWING_KCAL) {
            calories = input.previousCalories + Math.sign(swing) * MAX_WEEKLY_SWING_KCAL;
            guardrails.push('max_weekly_swing');
        }
    }

    const proteinGPerKg = input.proteinPrefGPerKg ?? defaultProteinGPerKg(input.goal);
    const proteinG = round5(Math.min(proteinGPerKg, 3) * input.trendWeightKg);

    const fatShare = input.fatBias === 'low' ? 0.2 : input.fatBias === 'high' ? 0.35 : 0.25;
    const fatFloorG = 0.6 * input.trendWeightKg;
    let fatG = round5(Math.max(fatFloorG, (calories * fatShare) / KCAL_PER_G_FAT));

    let carbsKcal = calories - proteinG * KCAL_PER_G_PROTEIN - fatG * KCAL_PER_G_FAT;
    if (carbsKcal < 0) {
        // Very low calories + high protein preference: give carbs the floor and
        // let fat absorb the remainder above its own floor.
        carbsKcal = 0;
        fatG = round5(Math.max(fatFloorG, (calories - proteinG * KCAL_PER_G_PROTEIN) / KCAL_PER_G_FAT));
        guardrails.push('macro_squeeze');
    }
    const carbsG = round5(carbsKcal / KCAL_PER_G_CARB);

    return { calories, proteinG, carbsG, fatG, guardrails };
};

export const LBS_PER_KG = 2.2046226218;
export const lbsToKg = (lbs: number): number => lbs / LBS_PER_KG;
export const kgToLbs = (kg: number): number => kg * LBS_PER_KG;

export type WeightUnit = 'lbs' | 'kg' | 'st';
const KG_PER_STONE = 6.35029318;

export const toKg = (weight: number, unit: WeightUnit): number => {
    if (unit === 'kg') return weight;
    if (unit === 'st') return weight * KG_PER_STONE;
    return lbsToKg(weight);
};
