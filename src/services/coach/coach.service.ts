import { prisma } from '../../prisma/client';
import {
    computeSnapshots,
    addDays,
    toKg,
    weekStartFor,
    CoachGoal,
    Confidence,
    DailyIntake,
    DailyWeight,
    Sex,
    Snapshot,
    WeightUnit,
} from './engine';
import { buildWeeklyPlan, WeeklyPlanRationale } from './planBuilder';
import {
    CoachPlanResponse,
    CoachStateResponse,
    EnrollCoachRequest,
    ExpenditurePoint,
    UpdateCoachSettingsRequest,
} from '../../types/coach';

/** Recompute window. 90 days is enough history for the EMA/blend to converge
 *  and cheap enough to recompute wholesale on every read (plan §3.2). */
const RECOMPUTE_WINDOW_DAYS = 90;
/** How many snapshot days the state response carries for the chart. */
const SERIES_DAYS = 30;

/**
 * 'YYYY-MM-DD' for "now" in the user's timezone. en-CA locale formats as
 * ISO-style YYYY-MM-DD. Falls back to UTC when the tz is missing/invalid —
 * clients sync their IANA tz on login (PUT /user/profile).
 */
export const localDayKey = (timezone: string | null, at: Date = new Date()): string => {
    try {
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: timezone ?? 'UTC',
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
        }).format(at);
    } catch {
        return at.toISOString().slice(0, 10);
    }
};

const toDayKeyString = (dbDate: Date): string => dbDate.toISOString().slice(0, 10);

/** Per-local-day intake totals from meal entries (calories are per-serving
 *  snapshots; totals multiply by servings — see meal_entries schema comment). */
const loadDailyIntakes = async (userId: string, fromDay: string): Promise<DailyIntake[]> => {
    const rows = await prisma.$queryRaw<Array<{ day: Date; kcal: number }>>`
        SELECT date AS day, SUM(calories * servings)::float AS kcal
        FROM meal_entries
        WHERE user_id = ${userId}
          AND deleted_at IS NULL
          AND date >= ${new Date(`${fromDay}T00:00:00Z`)}
        GROUP BY date
        ORDER BY date ASC
    `;
    return rows
        .filter((r) => r.kcal > 0)
        .map((r) => ({ day: toDayKeyString(r.day), kcal: Math.round(r.kcal) }));
};

/** Per-local-day average weight in kg. Rows with a null unit are legacy
 *  entries interpreted in the user's current unit (plan §8.2). Weigh-in
 *  timestamps are bucketed into local days using the user's timezone. */
const loadDailyWeights = async (
    userId: string,
    fromDay: string,
    timezone: string | null,
    currentUnit: WeightUnit,
): Promise<DailyWeight[]> => {
    const entries = await prisma.body_weight_entries.findMany({
        where: {
            user_id: userId,
            // Pad by 2 days so tz bucketing at the window edge never drops entries.
            logged_at: { gte: new Date(`${addDays(fromDay, -2)}T00:00:00Z`) },
        },
        orderBy: { logged_at: 'asc' },
        select: { weight: true, unit: true, logged_at: true },
    });

    const byDay = new Map<string, number[]>();
    for (const entry of entries) {
        const unit = (entry.unit as WeightUnit | null) ?? currentUnit;
        const kg = toKg(entry.weight, unit);
        const day = localDayKey(timezone, entry.logged_at);
        const bucket = byDay.get(day);
        if (bucket) bucket.push(kg);
        else byDay.set(day, [kg]);
    }

    return [...byDay.entries()]
        .map(([day, kgs]) => ({ day, weightKg: kgs.reduce((a, b) => a + b, 0) / kgs.length }))
        .sort((a, b) => a.day.localeCompare(b.day));
};

const persistSnapshots = async (userId: string, snapshots: Snapshot[]): Promise<void> => {
    if (snapshots.length === 0) return;
    // Wholesale replace of the recompute window: simpler and faster than 90
    // individual upserts, and safe because the engine is deterministic.
    const fromDate = new Date(`${snapshots[0].day}T00:00:00Z`);
    await prisma.$transaction([
        prisma.expenditure_snapshots.deleteMany({
            where: { user_id: userId, day: { gte: fromDate } },
        }),
        prisma.expenditure_snapshots.createMany({
            data: snapshots.map((s) => ({
                user_id: userId,
                day: new Date(`${s.day}T00:00:00Z`),
                trend_weight_kg: s.trendWeightKg,
                tdee_kcal: s.tdeeKcal,
                confidence: s.confidence,
            })),
        }),
    ]);
};

type CoachProfileRow = {
    user_id: string;
    mode: string;
    goal: string;
    rate_pct_bw: number;
    protein_pref: number | null;
    fat_bias: string | null;
};

type PlanRow = {
    id: string;
    week_start: Date;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    tdee_kcal: number;
    rationale: unknown;
    acknowledged_at: Date | null;
};

const mapPlan = (row: PlanRow): CoachPlanResponse => {
    const rationale = (row.rationale ?? {}) as Partial<WeeklyPlanRationale>;
    return {
        id: row.id,
        weekStart: toDayKeyString(row.week_start),
        calories: row.calories,
        proteinG: row.protein_g,
        carbsG: row.carbs_g,
        fatG: row.fat_g,
        tdeeKcal: row.tdee_kcal,
        previousTdeeKcal: rationale.previousTdeeKcal ?? null,
        held: rationale.held ?? false,
        guardrails: rationale.guardrails ?? [],
        acknowledgedAt: row.acknowledged_at ? row.acknowledged_at.toISOString() : null,
    };
};

const writeTargets = async (userId: string, plan: { calories: number; proteinG: number; carbsG: number; fatG: number }) => {
    await prisma.users.update({
        where: { id: userId },
        data: {
            target_calories: plan.calories,
            target_protein_g: plan.proteinG,
            target_carbs_g: plan.carbsG,
            target_fat_g: plan.fatG,
        },
    });
};

/**
 * Guarantees a plan row exists for the local week containing `today` and that
 * users.target_* reflects it. Idempotent: the (user_id, week_start) unique
 * constraint absorbs races between concurrent state reads.
 */
const ensureCurrentWeekPlan = async (
    userId: string,
    profile: CoachProfileRow,
    latest: Snapshot,
    today: string,
): Promise<PlanRow> => {
    const weekStart = weekStartFor(today);
    const weekStartDate = new Date(`${weekStart}T00:00:00Z`);

    const existing = await prisma.coach_weekly_plans.findUnique({
        where: { user_id_week_start: { user_id: userId, week_start: weekStartDate } },
    });
    if (existing) return existing;

    const previousRow = await prisma.coach_weekly_plans.findFirst({
        where: { user_id: userId, week_start: { lt: weekStartDate } },
        orderBy: { week_start: 'desc' },
    });

    const user = await prisma.users.findUnique({ where: { id: userId }, select: { sex: true } });
    const plan = buildWeeklyPlan({
        goal: profile.goal as CoachGoal,
        ratePctBw: profile.rate_pct_bw,
        proteinPrefGPerKg: profile.protein_pref,
        fatBias: (profile.fat_bias as 'low' | 'balanced' | 'high' | null) ?? null,
        sex: (user?.sex as Sex | null) ?? null,
        tdeeKcal: latest.tdeeKcal,
        trendWeightKg: latest.trendWeightKg,
        confidence: latest.confidence as Confidence,
        previousPlan: previousRow
            ? {
                  calories: previousRow.calories,
                  proteinG: previousRow.protein_g,
                  carbsG: previousRow.carbs_g,
                  fatG: previousRow.fat_g,
                  tdeeKcal: previousRow.tdee_kcal,
              }
            : null,
    });

    try {
        const created = await prisma.coach_weekly_plans.create({
            data: {
                user_id: userId,
                week_start: weekStartDate,
                calories: plan.calories,
                protein_g: plan.proteinG,
                carbs_g: plan.carbsG,
                fat_g: plan.fatG,
                tdee_kcal: plan.tdeeKcal,
                rationale: plan.rationale as object,
            },
        });
        await writeTargets(userId, plan);
        return created;
    } catch (error) {
        // P2002: another request created this week's plan first — use theirs.
        if ((error as { code?: string }).code === 'P2002') {
            const raced = await prisma.coach_weekly_plans.findUnique({
                where: { user_id_week_start: { user_id: userId, week_start: weekStartDate } },
            });
            if (raced) return raced;
        }
        throw error;
    }
};

/**
 * The Coach state read: recomputes expenditure snapshots through yesterday
 * (today's intake is still partial), persists them, and returns the current
 * estimate + a chart series. Works for every user — enrollment (coached mode)
 * only changes targets, not expenditure tracking. For coached users this is
 * also where the current week's plan is lazily generated (no cron in Phase 2).
 */
export const getCoachState = async (userId: string): Promise<CoachStateResponse | null> => {
    const user = await prisma.users.findUnique({
        where: { id: userId },
        select: {
            sex: true,
            birth_date: true,
            height_cm: true,
            weight_unit: true,
            timezone: true,
            coach_profiles: true,
        },
    });
    if (!user) return null;

    const today = localDayKey(user.timezone);
    const toDay = addDays(today, -1);
    const fromDay = addDays(toDay, -(RECOMPUTE_WINDOW_DAYS - 1));
    const currentUnit: WeightUnit =
        user.weight_unit === 'kg' || user.weight_unit === 'st' ? user.weight_unit : 'lbs';

    const [intakes, weights] = await Promise.all([
        loadDailyIntakes(userId, fromDay),
        loadDailyWeights(userId, fromDay, user.timezone, currentUnit),
    ]);

    const snapshots = computeSnapshots({
        profile: {
            sex: (user.sex as 'male' | 'female' | 'unspecified' | null) ?? null,
            birthDate: user.birth_date ? toDayKeyString(user.birth_date) : null,
            heightCm: user.height_cm,
        },
        weights,
        intakes,
        fromDay,
        toDay,
    });
    await persistSnapshots(userId, snapshots);

    const latest = snapshots[snapshots.length - 1] ?? null;
    const series: ExpenditurePoint[] = snapshots.slice(-SERIES_DAYS).map((s) => ({
        day: s.day,
        tdeeKcal: s.tdeeKcal,
        trendWeightKg: s.trendWeightKg,
    }));

    const profile = user.coach_profiles;

    let activePlan: CoachPlanResponse | null = null;
    if (profile && profile.mode === 'coached' && latest) {
        const planRow = await ensureCurrentWeekPlan(userId, profile, latest, today);
        activePlan = mapPlan(planRow);
    } else if (profile) {
        const weekStartDate = new Date(`${weekStartFor(today)}T00:00:00Z`);
        const planRow = await prisma.coach_weekly_plans.findUnique({
            where: { user_id_week_start: { user_id: userId, week_start: weekStartDate } },
        });
        activePlan = planRow ? mapPlan(planRow) : null;
    }

    return {
        mode: profile ? (profile.mode as 'coached' | 'paused') : 'manual',
        goal: profile ? (profile.goal as 'lose' | 'maintain' | 'gain') : null,
        ratePctBw: profile?.rate_pct_bw ?? null,
        proteinPref: profile?.protein_pref ?? null,
        fatBias: (profile?.fat_bias as 'low' | 'balanced' | 'high' | null) ?? null,
        tdeeKcal: latest?.tdeeKcal ?? null,
        trendWeightKg: latest?.trendWeightKg ?? null,
        confidence: latest?.confidence ?? 'calibrating',
        weightUnit: currentUnit,
        expenditureSeries: series,
        activePlan,
        pendingCheckIn: activePlan && activePlan.acknowledgedAt === null ? activePlan : null,
    };
};

/**
 * Enrolls (or re-enrolls) a user in coached mode. Profile fields are optional
 * refinements for the cold-start formula. The first plan is generated
 * immediately and pre-acknowledged — the wizard's reveal step IS the first
 * check-in; the Monday ritual starts next week.
 */
export const enrollCoach = async (
    userId: string,
    payload: EnrollCoachRequest,
): Promise<CoachStateResponse | null> => {
    const profileData: Record<string, unknown> = {};
    if (payload.sex !== undefined) profileData.sex = payload.sex;
    if (payload.birthDate !== undefined) {
        profileData.birth_date = payload.birthDate ? new Date(`${payload.birthDate}T00:00:00Z`) : null;
    }
    if (payload.heightCm !== undefined) profileData.height_cm = payload.heightCm;

    try {
        await prisma.users.update({ where: { id: userId }, data: profileData });
    } catch (error) {
        if ((error as { code?: string }).code === 'P2025') return null;
        throw error;
    }

    await prisma.coach_profiles.upsert({
        where: { user_id: userId },
        create: { user_id: userId, mode: 'coached', goal: payload.goal, rate_pct_bw: payload.ratePctBw },
        update: { mode: 'coached', goal: payload.goal, rate_pct_bw: payload.ratePctBw },
    });

    // Enrollment is a fresh start: regenerate this week's plan even if one
    // exists from a previous enrollment or from before a goal change.
    const userRow = await prisma.users.findUnique({ where: { id: userId }, select: { timezone: true } });
    const weekStart = weekStartFor(localDayKey(userRow?.timezone ?? null));
    await prisma.coach_weekly_plans.deleteMany({
        where: { user_id: userId, week_start: new Date(`${weekStart}T00:00:00Z`) },
    });

    // getCoachState generates this week's plan; immediately ack it (the
    // wizard's reveal step already played the check-in role) and patch the
    // state in memory instead of paying for a second recompute.
    const state = await getCoachState(userId);
    if (state?.pendingCheckIn) {
        await acknowledgeCheckIn(userId, state.pendingCheckIn.id);
        state.activePlan = { ...state.pendingCheckIn, acknowledgedAt: new Date().toISOString() };
        state.pendingCheckIn = null;
    }
    return state;
};

/**
 * Updates coach settings. A goal or rate change regenerates the current
 * week's plan from scratch (the ±150 kcal swing guardrail deliberately does
 * not apply to an explicit user decision — plan §1.4).
 */
export const updateCoachSettings = async (
    userId: string,
    updates: UpdateCoachSettingsRequest,
): Promise<CoachStateResponse | null> => {
    const existing = await prisma.coach_profiles.findUnique({ where: { user_id: userId } });
    if (!existing) return null;

    const data: Record<string, unknown> = {};
    if (updates.goal !== undefined) data.goal = updates.goal;
    if (updates.ratePctBw !== undefined) data.rate_pct_bw = updates.ratePctBw;
    if (updates.proteinPref !== undefined) data.protein_pref = updates.proteinPref;
    if (updates.fatBias !== undefined) data.fat_bias = updates.fatBias;
    if (updates.mode !== undefined) data.mode = updates.mode;
    await prisma.coach_profiles.update({ where: { user_id: userId }, data });

    const goalOrRateChanged =
        (updates.goal !== undefined && updates.goal !== existing.goal) ||
        (updates.ratePctBw !== undefined && updates.ratePctBw !== existing.rate_pct_bw);
    if (goalOrRateChanged) {
        const user = await prisma.users.findUnique({ where: { id: userId }, select: { timezone: true } });
        const weekStart = weekStartFor(localDayKey(user?.timezone ?? null));
        await prisma.coach_weekly_plans.deleteMany({
            where: { user_id: userId, week_start: new Date(`${weekStart}T00:00:00Z`) },
        });
    }

    return getCoachState(userId);
};

/** Back to manual mode. Targets keep their last coached values (user-editable again). */
export const deleteCoach = async (userId: string): Promise<boolean> => {
    const { count } = await prisma.coach_profiles.deleteMany({ where: { user_id: userId } });
    return count > 0;
};

export const acknowledgeCheckIn = async (userId: string, planId: string): Promise<boolean> => {
    const { count } = await prisma.coach_weekly_plans.updateMany({
        where: { id: planId, user_id: userId, acknowledged_at: null },
        data: { acknowledged_at: new Date() },
    });
    return count > 0;
};
