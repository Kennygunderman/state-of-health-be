// Weekly plan construction — pure, like the engine. coach.service feeds it the
// latest snapshot + profile + last week's plan and persists whatever comes back.

import { CoachGoal, Confidence, Sex, computePlan, fallbackWeightKg } from './engine';

export interface PreviousPlan {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    tdeeKcal: number;
}

export interface BuildWeeklyPlanInput {
    goal: CoachGoal;
    ratePctBw: number;
    proteinPrefGPerKg: number | null;
    fatBias: 'low' | 'balanced' | 'high' | null;
    sex: Sex | null;
    tdeeKcal: number;
    trendWeightKg: number | null;
    confidence: Confidence;
    previousPlan: PreviousPlan | null;
}

export interface WeeklyPlanRationale {
    tdeeKcal: number;
    previousTdeeKcal: number | null;
    trendWeightKg: number | null;
    confidence: Confidence;
    goal: CoachGoal;
    ratePctBw: number;
    guardrails: string[];
    /** True when data quality was too low to move targets, so last week's held. */
    held: boolean;
}

export interface WeeklyPlan {
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    tdeeKcal: number;
    rationale: WeeklyPlanRationale;
}

/**
 * Builds the coming week's targets. While the engine is still calibrating we
 * hold last week's targets rather than chase a noisy estimate (plan §2.4);
 * the very first plan has nothing to hold, so it always computes fresh from
 * the (formula-blended) estimate.
 */
export const buildWeeklyPlan = (input: BuildWeeklyPlanInput): WeeklyPlan => {
    const held = input.confidence === 'calibrating' && input.previousPlan !== null;

    if (held && input.previousPlan) {
        return {
            calories: input.previousPlan.calories,
            proteinG: input.previousPlan.proteinG,
            carbsG: input.previousPlan.carbsG,
            fatG: input.previousPlan.fatG,
            tdeeKcal: input.tdeeKcal,
            rationale: {
                tdeeKcal: input.tdeeKcal,
                previousTdeeKcal: input.previousPlan.tdeeKcal,
                trendWeightKg: input.trendWeightKg,
                confidence: input.confidence,
                goal: input.goal,
                ratePctBw: input.ratePctBw,
                guardrails: ['data_quality_hold'],
                held: true,
            },
        };
    }

    const weightKg = input.trendWeightKg ?? fallbackWeightKg(input.sex);
    const plan = computePlan({
        goal: input.goal,
        ratePctBw: input.ratePctBw,
        tdeeKcal: input.tdeeKcal,
        trendWeightKg: weightKg,
        sex: input.sex,
        proteinPrefGPerKg: input.proteinPrefGPerKg,
        fatBias: input.fatBias,
        previousCalories: input.previousPlan?.calories ?? null,
    });

    return {
        calories: plan.calories,
        proteinG: plan.proteinG,
        carbsG: plan.carbsG,
        fatG: plan.fatG,
        tdeeKcal: input.tdeeKcal,
        rationale: {
            tdeeKcal: input.tdeeKcal,
            previousTdeeKcal: input.previousPlan?.tdeeKcal ?? null,
            trendWeightKg: input.trendWeightKg,
            confidence: input.confidence,
            goal: input.goal,
            ratePctBw: input.ratePctBw,
            guardrails: plan.guardrails,
            held: false,
        },
    };
};
