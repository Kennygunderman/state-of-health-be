export interface ExpenditurePoint {
    day: string; // 'YYYY-MM-DD', user-local
    tdeeKcal: number;
    trendWeightKg: number | null;
}

export interface CoachPlanResponse {
    id: string;
    weekStart: string; // 'YYYY-MM-DD', user-local Monday
    calories: number;
    proteinG: number;
    carbsG: number;
    fatG: number;
    tdeeKcal: number;
    previousTdeeKcal: number | null;
    held: boolean;
    guardrails: string[];
    acknowledgedAt: string | null;
}

export interface CoachStateResponse {
    /** 'manual' = no coach_profiles row; targets are user-owned. */
    mode: 'manual' | 'coached' | 'paused';
    goal: 'lose' | 'maintain' | 'gain' | null;
    ratePctBw: number | null;
    proteinPref: number | null;
    fatBias: 'low' | 'balanced' | 'high' | null;
    tdeeKcal: number | null;
    trendWeightKg: number | null;
    confidence: 'calibrating' | 'low' | 'medium' | 'high';
    weightUnit: 'lbs' | 'kg' | 'st';
    expenditureSeries: ExpenditurePoint[];
    /** The current week's plan (coached/paused users only). */
    activePlan: CoachPlanResponse | null;
    /** activePlan when it hasn't been acknowledged — drives the check-in sheet. */
    pendingCheckIn: CoachPlanResponse | null;
}

export interface EnrollCoachRequest {
    goal: 'lose' | 'maintain' | 'gain';
    ratePctBw: number;
    sex?: 'male' | 'female' | 'unspecified' | null;
    birthDate?: string | null;
    heightCm?: number | null;
}

export interface UpdateCoachSettingsRequest {
    goal?: 'lose' | 'maintain' | 'gain';
    ratePctBw?: number;
    proteinPref?: number | null;
    fatBias?: 'low' | 'balanced' | 'high' | null;
    mode?: 'coached' | 'paused';
}

export interface UpdateProfileRequest {
    sex?: 'male' | 'female' | 'unspecified' | null;
    birthDate?: string | null; // 'YYYY-MM-DD'
    heightCm?: number | null;
    weightUnit?: 'lbs' | 'kg' | 'st';
    timezone?: string;
}

export interface ProfileResponse {
    sex: string | null;
    birthDate: string | null;
    heightCm: number | null;
    weightUnit: string | null;
    timezone: string | null;
}
