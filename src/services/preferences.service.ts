// The meal-planning preferences service: the read and write side of
// `meal_plan_preferences` — the one row per user that carries every setup
// answer, the resume point of an interrupted setup, and the IANA time zone every
// other meal-planning rule resolves "today" against.
//
// Orchestration only (Rule backend-architecture §5). Every decision lives in
// `preferences.logic.ts`: the per-step parsers, the setup state machine, the
// allergen exclusivity rule, unit normalisation to metric, budget tiering, the
// disliked-food-group derivation, and the per-meal incompatibility evaluation.
// This file loads rows, hands them to those rules, writes what they return, and
// maps rows to the wire DTOs in `types/mealPlanning.ts`.
//
// WHY THE CALENDAR HELPERS LIVE HERE. `meal_plan_preferences.time_zone` is the
// only record of the user's own calendar, and nearly every meal-planning rule
// needs a day key in it: `mealPlan.logic.ts::isPlanEnded`,
// `requireWritablePlan`, `resolveCurrentAndUpcoming`,
// `requireNonConflictingWeek`, `grocery.logic.ts::requireGroceryWritablePlan`
// and `plannedMealLog.logic.ts::isDateInPlanWeek` all take `today` as a
// parameter, deliberately, so that no rule reads a clock and every rule is
// testable. Something has to produce that value from the stored zone, and the
// module that owns the zone is the honest place for it — one definition, so a
// second, subtly different spelling of "the user's today" cannot make a plan
// writable in one code path and ended in another.
import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    ActivityLevel,
    BudgetPreference,
    BudgetTier,
    CookingTimeLimitMin,
    Diet,
    DislikedFoodSummary,
    Goal,
    HeightUnitPref,
    InvalidRequestDetail,
    MealFlag,
    MealFlagCode,
    MealSchedule,
    MealTimeEntry,
    PaceLbPerWeek,
    PlanStatus,
    PreferencesResponse,
    PreferencesSaveResponse,
    PreferencesUpdatePayload,
    SexForEstimate,
    WeightUnitPref,
} from '../types/mealPlanning';
import { ReadOnlyFieldError, StaleRevisionError } from './mealPlanning.errors';
import {
    MealPlanningTransactionClient,
    withMealPlanningTransaction,
    withUserLock,
} from './mealPlanningAction.service';
import {
    BUDGET_CURRENCY,
    NO_PREFERENCES_REVISION,
    ParsedSetupStepPayload,
    PreferenceRequestVerdict,
    PreferenceErrorVerdict,
    PreferenceRefusal,
    PREFERENCE_FIELD_CODES,
    deriveBudgetTier,
    deriveDislikedFoodGroups,
    evaluateMealAgainstPreferences,
    isClockTime,
    mealsPerDayForSchedule,
    nextSetupState,
    parsePreferencesUpdate,
    parsePreferencesUpdateRequest,
    parseSetupStep,
    parseSetupStepRequest,
    readOnlyFieldRefusal,
    reconcileSetupStateForRoute,
    resolveTargetRouteForBodyStep,
    resolveTargetRouteForUpdate,
    SETUP_STATUSES,
    SETUP_STEPS,
    setupStateOf,
    SetupStepContext,
    TARGET_ROUTES,
    PreferencesUpdateContext,
} from './preferences.logic';
import { startDateWindow } from './mealPlan.logic';
import { PlanningPreferences, PREFERENCE_FLAG_CODES, isMealSlot } from './recipe.logic';
import { getPlanningRecipeVersionsByIds } from './recipe.service';

/**
 * The IANA zone assumed when a user has no preferences row yet, or has one that
 * predates the column.
 *
 * UTC rather than the server's zone: the server's zone is an accident of
 * deployment, so a plan boundary that moved when the host moved would be a bug
 * nobody could reproduce. Every client sends its zone on the first setup step,
 * so this fallback applies only before any answer exists — where no plan, and
 * therefore no boundary, exists either.
 */
export const FALLBACK_TIME_ZONE = 'UTC';

/**
 * `now` as a `YYYY-MM-DD` day key in the given IANA zone.
 *
 * `en-CA` is the locale trick that matters: its short date format IS ISO
 * (`2026-09-13`), so the parts need no reassembly and no month-name table.
 * `Intl.DateTimeFormat` is also the validator — an unknown zone name throws
 * `RangeError` on Node and on every React Native JS engine, which is exactly how
 * `preferences.logic.ts::normalizeTimeZone` validates the value on the way in.
 * A zone that has since become invalid (a stored row from an older ICU) falls
 * back rather than failing the request: reporting "today" in UTC is wrong by at
 * most a day, while a 500 on every plan read is wrong for good.
 */
export const dayKeyInTimeZone = (now: Date, timeZone: string | null): string => {
    const zone = timeZone === null || timeZone.trim().length === 0 ? FALLBACK_TIME_ZONE : timeZone;

    try {
        return new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(now);
    } catch (error) {
        if (error instanceof RangeError) {
            return new Intl.DateTimeFormat('en-CA', { timeZone: FALLBACK_TIME_ZONE }).format(now);
        }

        throw error;
    }
};

/**
 * The user's current calendar day, read from their stored zone.
 *
 * `db` accepts an open transaction so a caller that has already taken the
 * per-user advisory lock resolves "today" against the same snapshot it is about
 * to write in, and defaults to the global client for plain reads. `now` is a
 * parameter so a test fixes the clock instead of waiting for one.
 */
export const resolveUserToday = async (
    userId: string,
    now: Date = new Date(),
    db: Prisma.TransactionClient = prisma,
): Promise<string> => {
    const row = await db.meal_plan_preferences.findUnique({
        where: { user_id: userId },
        select: { time_zone: true },
    });

    return dayKeyInTimeZone(now, row?.time_zone ?? null);
};

/* ---------------------------------------------------------------------------
 * The stored row
 * ------------------------------------------------------------------------- */

/**
 * The `meal_plan_preferences` row this module reads and writes, snake_case
 * exactly as stored.
 *
 * Declared structurally rather than as Prisma's generated model for the reason
 * `catalog.mapper.ts` and `targets.logic.ts` give for their row types: it is the
 * shape the pure layer accepts unmapped, so a row can be handed straight to
 * `deriveTargetsResponse`, `resolveEstimateInputs` and the eligibility rules
 * without a second declaration. A wider row satisfies it — the generated model
 * does — so nothing is lost by narrowing it here.
 *
 * Every enumerated column is `string | null` because the backing columns are
 * plain TEXT with no enum and no CHECK constraint (the schema has neither, by
 * design, so the `*.logic.ts` parsers are the single enforcement point). They
 * are narrowed on the way out to the DTO, below.
 *
 * The two JSONB columns are `unknown`: they are data to inspect defensively,
 * never a shape to assume.
 */
export interface PreferencesRow {
    user_id: string;
    time_zone: string | null;
    setup_status: string;
    setup_step: string | null;
    review_start_date: Date | null;
    target_route: string | null;
    goal: string | null;
    goal_weight_kg: number | null;
    pace_lb_per_week: number | null;
    age: number | null;
    height_cm: number | null;
    weight_kg: number | null;
    sex_for_estimate: string | null;
    height_unit_pref: string | null;
    weight_unit_pref: string | null;
    activity_level: string | null;
    diet: string | null;
    allergens: string[];
    disliked_food_ids: string[];
    disliked_food_groups: string[];
    meal_schedule: string | null;
    meal_times: unknown;
    cooking_time_limit_min: number | null;
    budget_amount: number | null;
    budget_currency: string | null;
    no_budget_preference: boolean;
    budget_tier: number | null;
    target_source: string | null;
    targets_revision: number;
    confirmed_targets: unknown;
    targets_input_revision: number | null;
    /**
     * THE SINGLE INPUT-ANCESTRY COUNTER, advanced by every preference save of
     * any kind — diet, allergens, dislikes, schedule, budget, review date, unit
     * preferences and time zone included — and doing two jobs at once: a client
     * pins it to detect a lost update, and comparing it with
     * `targets_input_revision` is what `TargetsResponse.stale` means (AAP
     * §0.5.2: stale when `source === 'estimated'` and
     * `targets_input_revision ≠ revision`). One counter for both is what makes
     * "confirmed against revision N" and "derived from revision N" the same
     * statement, so EVERY saved edit makes a confirmed estimate stale, whatever
     * it touched.
     */
    revision: number;
}

/**
 * The one row a user has, or `null` when they have never saved a preference.
 *
 * `null` is a real state with a defined reading throughout this feature —
 * `setupStatus: 'not_started'`, `revision: 0`, `targets_revision: 0` — and never
 * an error: reading preferences is side-effect free and creates nothing.
 *
 * The row is read WHOLE rather than projected. Every column is consumed by one
 * of the three services that read it (this one builds the DTO from nearly all of
 * them, `targets.service.ts` needs the estimate inputs and the four targets
 * columns, `mealPlan.service.ts` the schedule, budget and eligibility columns),
 * so a projection would be a list of every column with an extra way to get it
 * wrong. It is one narrow row per user, fetched by a unique index.
 *
 * `db` accepts an open transaction so a caller holding the per-user advisory
 * lock reads the same snapshot it is about to write in.
 */
export const loadPreferencesRow = async (
    userId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<PreferencesRow | null> =>
    db.meal_plan_preferences.findUnique({ where: { user_id: userId } });

/* ---------------------------------------------------------------------------
 * Reading a stored column into the type the contract promises
 *
 * The DTO mapper lives at the top of this service rather than in a
 * `preferences.mapper.ts`, which is what Rule backend-architecture §6 prescribes
 * while exactly one service needs the shape ("a private const at the top of the
 * service while there's one, promoted once two services need it").
 *
 * Each closed set below is keyed off the DTO's own union
 * (`Readonly<Record<Goal, true>>` and friends), so it is exhaustive by
 * construction: widening a union in `types/mealPlanning.ts` stops the literal
 * compiling until the new value is handled here. That is the same construction
 * `recipe.mapper.ts` uses, and for the same stated reason — a hand-listed array
 * of the same strings would silently fall behind the contract.
 *
 * THE THREE SERVER-OWNED VOCABULARIES ARE NOT AMONG THEM. `setup_status`,
 * `setup_step` and `target_route` are read here for the response and in
 * `preferences.logic.ts::setupStateOf` for the state machine, so their tables
 * live with the projection and are imported (`SETUP_STATUSES`, `SETUP_STEPS`,
 * `TARGET_ROUTES`): two readers of one column must not hold two lists of what
 * that column may say.
 * ------------------------------------------------------------------------- */

const GOALS: Readonly<Record<Goal, true>> = { lose: true, maintain: true, gain: true };

const SEXES_FOR_ESTIMATE: Readonly<Record<SexForEstimate, true>> = {
    female: true,
    male: true,
    prefer_not_to_say: true,
};

const HEIGHT_UNIT_PREFS: Readonly<Record<HeightUnitPref, true>> = { ft_in: true, cm: true };

const WEIGHT_UNIT_PREFS: Readonly<Record<WeightUnitPref, true>> = { lb: true, kg: true };

const ACTIVITY_LEVELS: Readonly<Record<ActivityLevel, true>> = {
    not_very_active: true,
    lightly_active: true,
    active: true,
    very_active: true,
};

const DIETS: Readonly<Record<Diet, true>> = {
    none: true,
    vegetarian: true,
    vegan: true,
    pescatarian: true,
};

const MEAL_SCHEDULES: Readonly<Record<MealSchedule, true>> = { three: true, three_plus_snack: true };

const MEAL_FLAG_CODES: Readonly<Record<MealFlagCode, true>> = {
    diet: true,
    allergen: true,
    dislike: true,
    cooking_time: true,
};

/** The numeric closed sets, which cannot be keyed objects because their members are numbers. */
const PACES: readonly PaceLbPerWeek[] = [0.5, 1, 1.5];
const COOKING_TIME_LIMITS: readonly CookingTimeLimitMin[] = [15, 30, 45, 60];
const BUDGET_TIERS: readonly BudgetTier[] = [1, 2, 3];

/**
 * A stored string as a member of its closed set, or `null` when it is not one.
 *
 * `null` — "not answered" — is the reading for an unrecognised value throughout
 * this file, and it is the same one `nutrition.service.ts` applies to an
 * unrecognised provenance ("A stored value outside the known set is reported as
 * null"). Every column narrowed this way is nullable on the wire, so reporting
 * an unreadable value as unanswered states less rather than stating something
 * false — and it can only ever make the server MORE cautious: an unreadable
 * diet, allergen set or cooking limit never relaxes a planning rule.
 */
const asMember = <T extends string>(set: Readonly<Record<T, true>>, value: unknown): T | null =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(set, value) ? (value as T) : null;

/** The same reading for the three numeric closed sets. */
const asNumericMember = <T extends number>(members: readonly T[], value: unknown): T | null =>
    typeof value === 'number' && members.includes(value as T) ? (value as T) : null;

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

/**
 * A stored value as a JSON column value.
 *
 * The cast is unavoidable and is the same one `mealPlanningAction.service.ts`
 * makes for its response snapshots: Prisma's `InputJsonValue` is a recursive
 * structural type that a declared interface does not satisfy nominally, even
 * when every member of it is JSON-representable. Confined to this one helper so
 * no call site carries a cast of its own.
 */
const asJsonValue = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

/**
 * A `YYYY-MM-DD` day key as the value a `@db.Date` column takes.
 *
 * `new Date('2026-09-13')` parses as UTC midnight, which is exactly how the
 * diary already stores and compares its own day keys
 * (`nutrition.service.ts`), so a plan date and a diary date remain comparable.
 * A zone offset here would shift a stored calendar day by one.
 */
const toStoredDate = (dayKey: string): Date => new Date(`${dayKey}T00:00:00.000Z`);

/** The inverse, matching `nutrition.service.ts::toDayKey` exactly. */
const toDayKey = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * The stored meal times as the DTO carries them.
 *
 * Read defensively and per entry: a malformed entry is DROPPED rather than
 * failing the whole read, because the alternative is a preferences screen that
 * cannot load — and therefore cannot be used to fix the times. The slot
 * membership decision stays in the logic layer (`recipe.logic.ts::isMealSlot`)
 * and the clock format in `preferences.logic.ts::isClockTime`; nothing about the
 * shape is re-decided here.
 *
 * The array order is the stored order, which the parsers guarantee is wire order
 * (breakfast, lunch, dinner, then snack). The TIMES are deliberately unordered —
 * a snack may fall between lunch and dinner — so nothing sorts them.
 */
const readMealTimes = (stored: unknown): MealTimeEntry[] => {
    if (!Array.isArray(stored)) {
        return [];
    }

    const entries: MealTimeEntry[] = [];

    for (const candidate of stored) {
        const record = asRecord(candidate);

        if (record === null) {
            continue;
        }

        const slot = record.slot;
        const time = record.time;

        if (isMealSlot(slot) && isClockTime(time)) {
            entries.push({ slot, time });
        }
    }

    return entries;
};

/**
 * The budget answer as one object, or `null` when the user expressed no amount.
 *
 * A stored amount with no currency reads back as `BUDGET_CURRENCY`: the column
 * pair is written together by `parseBudgetAnswer`, which accepts one currency,
 * so the fallback describes the only currency an amount can have been entered in
 * rather than inventing one. `null` is a real answer here — "no budget
 * preference" — not a missing value.
 */
const readBudget = (row: PreferencesRow): BudgetPreference | null =>
    row.budget_amount === null
        ? null
        : { amount: row.budget_amount, currency: row.budget_currency ?? BUDGET_CURRENCY };

/* ---------------------------------------------------------------------------
 * GET /meal-planning/preferences
 * ------------------------------------------------------------------------- */

/** Only an `active` plan can make `hasActivePlan` true; a superseded one never does. */
const ACTIVE_PLAN_STATUS: PlanStatus = 'active';

/**
 * The status a catalog food must carry to be offered as a dislike.
 *
 * Applied when a dislike is SAVED, never when one is read back: a food that was
 * published when the user declined it and has since been retired is still a
 * dislike they expressed, and dropping it from the response would show them a
 * preference screen missing an answer they gave.
 */
const PUBLISHED_CATALOG_STATUS = 'published';

/**
 * The disliked foods hydrated for display.
 *
 * The response returns objects while the request accepts bare ids, so the chips
 * on the food-preferences screen render without a second round trip — the
 * asymmetry `DislikedFoodSummary` documents.
 *
 * SELECTION ORDER IS PRESERVED: the stored array is the order the user chose,
 * and the ids are re-projected through it rather than through the order
 * PostgreSQL returned, so the chips do not reshuffle between reads. An id with
 * no catalog row is omitted — the food was deleted outright rather than retired
 * — because a chip with no name is worse than one fewer chip.
 *
 * No tenant predicate: `catalog_foods` is shared reference data with no
 * `user_id`, the exception `catalog.service.ts` documents. The USER-scoped half
 * of this read is the id list, which came from that user's own row.
 */
const resolveDislikedFoods = async (
    foodIds: readonly string[],
    db: Prisma.TransactionClient,
): Promise<DislikedFoodSummary[]> => {
    if (foodIds.length === 0) {
        return [];
    }

    const foods = await db.catalog_foods.findMany({
        where: { id: { in: [...foodIds] } },
        select: { id: true, display_name: true, food_group: true },
    });

    const byId = new Map(foods.map((food) => [food.id, food]));

    return foodIds.flatMap((id) => {
        const food = byId.get(id);

        return food === undefined
            ? []
            : [{ id: food.id, name: food.display_name, foodGroup: food.food_group }];
    });
};

/**
 * Whether the user has a plan that is active AND has not ended.
 *
 * `end_date >= today` is the load-bearing half: a plan whose last day has passed
 * keeps `status = 'active'` in storage but is ENDED for every rule — excluded
 * from current/upcoming resolution, from overlap checks and from flag
 * recomputation (AAP §0.5.1). Reporting it as an active plan would send the
 * client to a week that is over instead of offering to plan a new one.
 *
 * `today` is the caller's day key in the user's own stored zone, never a server
 * day: a bare date plus a Firebase identity cannot otherwise establish the
 * user's calendar day.
 */
const hasActivePlanOn = async (
    userId: string,
    today: string,
    db: Prisma.TransactionClient,
): Promise<boolean> => {
    const plan = await db.meal_plans.findFirst({
        where: { user_id: userId, status: ACTIVE_PLAN_STATUS, end_date: { gte: toStoredDate(today) } },
        select: { id: true },
    });

    return plan !== null;
};

/**
 * What a user with no stored row reads back.
 *
 * Every member is `null`, empty or false — INCLUDING `heightUnitPref` and
 * `weightUnitPref`, which is a contract decision rather than an omission: the
 * server owns no unit defaults, so the client derives its first-entry toggles
 * from the user's existing weight unit. A server-side default here would
 * silently overrule a preference the user has already expressed elsewhere in
 * the app.
 *
 * `hasActivePlan` is false without a query. A plan cannot exist without the
 * preferences row it was generated from — `meal_plans.preferences_revision`
 * comes from that row and generation requires setup to have reached
 * `ready_for_review` — so there is nothing a query could find, and the
 * cold-start read that every client makes first costs one statement instead of
 * two.
 */
const NOT_STARTED_PREFERENCES: PreferencesResponse = {
    setupStatus: 'not_started',
    setupStep: null,
    reviewStartDate: null,
    timeZone: null,
    targetRoute: null,
    revision: 0,
    goal: null,
    goalWeightKg: null,
    paceLbPerWeek: null,
    age: null,
    heightCm: null,
    weightKg: null,
    sexForEstimate: null,
    heightUnitPref: null,
    weightUnitPref: null,
    activityLevel: null,
    diet: null,
    allergens: [],
    dislikedFoods: [],
    dislikedFoodGroups: [],
    mealSchedule: null,
    mealTimes: [],
    cookingTimeLimitMin: null,
    budget: null,
    noBudgetPreference: false,
    budgetTier: null,
    hasActivePlan: false,
};

/**
 * One row as `PreferencesResponse`.
 *
 * `setupStatus` is the one narrowed column with a non-null fallback, and
 * `in_progress` is it: a row exists, so setup has started, but a status we
 * cannot read must not be reported as `ready_for_review` or `completed` —
 * generation requires one of those, so the cautious reading is also the one that
 * cannot let a week be built on an unreadable row. It never reports
 * `not_started` either, which would contradict the row's own existence.
 *
 * `dislikedFoods` and `hasActivePlan` are passed in rather than read here: this
 * function is pure, and both need I/O the caller has already done.
 *
 * `targetRoute` is narrowed the same cautious way, and it carries more than the
 * route: it is the response's record that the body step was answered (the
 * contract states it on `PreferencesResponse`, and `PROVABLE_STEP_ANSWERS`
 * reads the column for the same purpose). A value the vocabulary no longer
 * contains therefore reports null, which re-asks that step rather than
 * resuming past it on an answer nobody can read.
 */
const mapPreferences = (
    row: PreferencesRow,
    dislikedFoods: DislikedFoodSummary[],
    hasActivePlan: boolean,
): PreferencesResponse => ({
    setupStatus: asMember(SETUP_STATUSES, row.setup_status) ?? 'in_progress',
    setupStep: asMember(SETUP_STEPS, row.setup_step),
    reviewStartDate: row.review_start_date === null ? null : toDayKey(row.review_start_date),
    timeZone: row.time_zone,
    targetRoute: asMember(TARGET_ROUTES, row.target_route),
    revision: row.revision,
    goal: asMember(GOALS, row.goal),
    goalWeightKg: row.goal_weight_kg,
    paceLbPerWeek: asNumericMember(PACES, row.pace_lb_per_week),
    age: row.age,
    heightCm: row.height_cm,
    weightKg: row.weight_kg,
    sexForEstimate: asMember(SEXES_FOR_ESTIMATE, row.sex_for_estimate),
    heightUnitPref: asMember(HEIGHT_UNIT_PREFS, row.height_unit_pref),
    weightUnitPref: asMember(WEIGHT_UNIT_PREFS, row.weight_unit_pref),
    activityLevel: asMember(ACTIVITY_LEVELS, row.activity_level),
    diet: asMember(DIETS, row.diet),
    allergens: row.allergens,
    dislikedFoods,
    dislikedFoodGroups: row.disliked_food_groups,
    mealSchedule: asMember(MEAL_SCHEDULES, row.meal_schedule),
    mealTimes: readMealTimes(row.meal_times),
    cookingTimeLimitMin: asNumericMember(COOKING_TIME_LIMITS, row.cooking_time_limit_min),
    budget: readBudget(row),
    noBudgetPreference: row.no_budget_preference,
    budgetTier: asNumericMember(BUDGET_TIERS, row.budget_tier),
    hasActivePlan,
});

/**
 * The response for a row that has already been loaded — the shared tail of the
 * read and of both writes, so the three cannot disagree about what a saved
 * preference reads back as.
 *
 * `now` is a parameter rather than a clock read so that a write resolves "today"
 * against the same instant it wrote with.
 */
const buildPreferencesResponse = async (
    userId: string,
    row: PreferencesRow,
    now: Date,
    db: Prisma.TransactionClient,
): Promise<PreferencesResponse> => {
    const today = dayKeyInTimeZone(now, row.time_zone);
    // Sequential rather than concurrent: `db` may be an interactive transaction
    // client, which is one connection, and the two reads are indexed lookups on
    // a handful of rows.
    const dislikedFoods = await resolveDislikedFoods(row.disliked_food_ids, db);
    const hasActivePlan = await hasActivePlanOn(userId, today, db);

    return mapPreferences(row, dislikedFoods, hasActivePlan);
};

/**
 * `GET /api/meal-planning/preferences` — every stored setup answer, or the
 * not-started shape.
 *
 * SIDE-EFFECT FREE, and that is a contract rather than an implementation
 * detail: reading NEVER creates a row. The client calls this before onboarding
 * to decide between starting setup and opening a plan, so a read that created a
 * row would report `in_progress` to a user who has answered nothing and would
 * make the first step save a stale-revision conflict against a row the client
 * never knew existed.
 */
export const getPreferences = async (
    userId: string,
    db: Prisma.TransactionClient = prisma,
): Promise<PreferencesResponse> => {
    const row = await loadPreferencesRow(userId, db);

    if (row === null) {
        return NOT_STARTED_PREFERENCES;
    }

    return buildPreferencesResponse(userId, row, new Date(), db);
};

/* ---------------------------------------------------------------------------
 * Incompatibility flags on an active plan
 * ------------------------------------------------------------------------- */

/** The eligibility preferences a flag recomputation reads, from the row it has. */
const planningPreferencesFrom = (row: PreferencesRow | null): PlanningPreferences => ({
    diet: row === null ? null : asMember(DIETS, row.diet),
    allergens: row?.allergens ?? [],
    disliked_food_ids: row?.disliked_food_ids ?? [],
    disliked_food_groups: row?.disliked_food_groups ?? [],
    cooking_time_limit_min: row?.cooking_time_limit_min ?? null,
});

/**
 * The stored `meal_plan_meals.flags` column as flags.
 *
 * Defensive per entry, like the meal times: a malformed entry is dropped. That
 * makes an unreadable column compare UNEQUAL to the freshly computed flags and
 * therefore get rewritten — the recomputation repairs it instead of preserving
 * it, which is the behaviour that matters for a column the banner reads.
 */
const readStoredFlags = (stored: unknown): MealFlag[] => {
    if (!Array.isArray(stored)) {
        return [];
    }

    const flags: MealFlag[] = [];

    for (const candidate of stored) {
        const record = asRecord(candidate);

        if (record === null) {
            continue;
        }

        const code = asMember(MEAL_FLAG_CODES, record.code);

        if (code === null) {
            continue;
        }

        const detail = Array.isArray(record.detail)
            ? record.detail.filter((entry): entry is string => typeof entry === 'string')
            : [];

        flags.push({ code, detail });
    }

    return flags;
};

/**
 * Whether two flag lists say the same thing, compared element-wise including
 * each code's details.
 *
 * Order-sensitive on purpose: `evaluateMealAgainstPreferences` emits codes in
 * one declared order with each detail list sorted and de-duplicated, so two
 * equal verdicts are always element-wise equal, and treating a reordering as a
 * change would rewrite every meal on every save. The details are part of the
 * comparison because they are part of what the client renders — a dislike that
 * now names a second ingredient is a real change.
 */
const sameFlags = (left: readonly MealFlag[], right: readonly MealFlag[]): boolean =>
    left.length === right.length &&
    left.every((flag, index) => {
        const other = right[index];

        return (
            flag.code === other.code &&
            flag.detail.length === other.detail.length &&
            flag.detail.every((entry, position) => entry === other.detail[position])
        );
    });

/**
 * The codes present across a plan's flagged meals, in the ONE declared order.
 *
 * The order comes from `recipe.logic.ts::PREFERENCE_FLAG_CODES` rather than from
 * a second list here, so the audit record and the eligibility verdict cannot
 * disagree about it; the local closed set is used only to narrow that array's
 * wider element type to the four flag codes.
 */
const orderedFlagCodes = (present: ReadonlySet<MealFlagCode>): MealFlagCode[] =>
    PREFERENCE_FLAG_CODES.flatMap((code) => {
        const flagCode = asMember(MEAL_FLAG_CODES, code);

        return flagCode !== null && present.has(flagCode) ? [flagCode] : [];
    });

/** One plan's flag recomputation outcome: how many meals are flagged, and whether anything moved. */
interface PlanFlagRecomputation {
    flaggedMealCount: number;
    changed: boolean;
}

/** One meal whose recomputed verdict differs from the one stored on it. */
interface MealFlagWrite {
    id: string;
    flags: readonly MealFlag[];
}

/**
 * Writes every changed verdict of ONE plan in ONE statement.
 *
 * `UPDATE … FROM (VALUES …)` rather than a statement per meal: a preference
 * save recomputes the current and upcoming weeks under the per-user advisory
 * lock, so the per-meal form cost up to 56 sequential round trips while every
 * other write of that user waited behind them. The set is known before the
 * first write — `recomputePlanFlags` computes all the verdicts in memory — so
 * there is nothing to learn from doing them one at a time.
 *
 * NOTHING IS INTERPOLATED. Each id and each flag document is a bound parameter
 * carried by `Prisma.sql`, which matters beyond hygiene here: a flag's details
 * include catalog display names that reached the row through the user's own
 * dislike selection, so this statement handles user-influenced text.
 *
 * THE OWNER AND PARENT PREDICATES STAY IN THE STATEMENT (Rule
 * backend-architecture §5.1, AAP §0.5.1). The ids come from a read that was
 * already scoped to `{meal_plan_id, user_id}`, and that is precisely why they
 * are repeated: a write predicated on ids alone would be correct only for as
 * long as the read above it stays correct, which is the coupling the rule
 * exists to forbid.
 *
 * THE AFFECTED COUNT IS VERIFIED. `$executeRaw` reports how many rows the
 * predicate matched; anything but one per change means a meal the read
 * returned was excluded by the owner or parent column, which would leave the
 * plan half-recomputed and its audit record describing meals that were never
 * written. That is a broken invariant rather than a recoverable condition, so
 * it throws and takes the whole transaction — the preference write included —
 * down with it.
 */
const writeMealFlags = async (
    tx: MealPlanningTransactionClient,
    userId: string,
    planId: string,
    writes: readonly MealFlagWrite[],
): Promise<void> => {
    if (writes.length === 0) {
        // The caller owns the "did anything move" decision. An empty set would
        // emit `VALUES ()`, which is a syntax error rather than a no-op, so the
        // rule is stated here instead of being left to the SQL.
        throw new Error('flag recomputation was asked to write an empty change set');
    }

    const rows = writes.map(
        (write) => Prisma.sql`(${write.id}::uuid, ${JSON.stringify(write.flags)}::jsonb)`,
    );

    const affected = await tx.$executeRaw(Prisma.sql`
        UPDATE meal_plan_meals AS m
        SET flags = v.flags
        FROM (VALUES ${Prisma.join(rows)}) AS v(id, flags)
        WHERE m.id = v.id
            AND m.user_id = ${userId}
            AND m.meal_plan_id = ${planId}::uuid
    `);

    if (affected !== writes.length) {
        throw new Error(
            `flag recomputation matched ${affected} of ${writes.length} changed meals on plan ${planId}`,
        );
    }
};

/**
 * Recomputes one active plan's meal flags.
 *
 * Every predicate carries `user_id` AND the parent id — `{meal_plan_id,
 * user_id}` for the read, and `m.id = v.id AND m.user_id = … AND
 * m.meal_plan_id = …` for the write (Rule §5.1, AAP §0.5.1). There is no
 * id-only write here and no ownership read standing in for one: the owner and
 * parent columns are part of the same statement that changes the rows.
 *
 * THE CHANGED MEALS ARE WRITTEN IN ONE STATEMENT PER PLAN, not one per meal.
 * A save recomputes the current and the upcoming week — up to 56 four-slot
 * meals — while holding the per-user advisory lock, so a statement per changed
 * meal meant up to 56 sequential round trips inside the lock, serialising every
 * other write of that user behind the network time of all of them. The verdicts
 * are computed in memory first and applied as a single
 * `UPDATE … FROM (VALUES …)`, which is one round trip whatever the plan's size.
 *
 * It is built with `Prisma.sql`/`Prisma.join`, so every id and every flag
 * document travels as a BOUND PARAMETER — nothing is interpolated into SQL
 * text, including the values that originate in the user's own preference
 * answers (a dislike detail carries a catalog food's display name).
 * `$executeRaw` returns the affected row count, which must equal the number of
 * changed meals: a smaller count means the owner or parent predicate excluded a
 * row the read had returned, which would leave a plan half-recomputed, so it
 * fails the transaction rather than commits it.
 *
 * The recipe versions come from `recipe.service.ts` — the single owner of recipe
 * reads — as the eligibility input, so the snapshot rule and the closed-set
 * narrowing exist once. Retired versions are included deliberately: a meal
 * planned before a catalog refresh may point at one.
 *
 * A meal whose `slot` column is unreadable is LEFT ALONE rather than guessed at:
 * the verdict is per slot, and rewriting flags computed for a slot the meal may
 * not be in would replace a true statement with an invented one. The column is
 * written by generation from a closed set, so this is unreachable in practice.
 */
const recomputePlanFlags = async (
    tx: MealPlanningTransactionClient,
    userId: string,
    planId: string,
    preferences: PlanningPreferences,
    recomputedAt: Date,
): Promise<PlanFlagRecomputation> => {
    const meals = await tx.meal_plan_meals.findMany({
        where: { meal_plan_id: planId, user_id: userId },
        select: { id: true, slot: true, flags: true, recipe_version_id: true },
        // Day date then slot order, so `flaggedMealIds` reads in plan order and
        // two recomputations of the same plan produce the same audit record.
        orderBy: [{ meal_plan_days: { date: 'asc' } }, { sort_order: 'asc' }],
    });

    const versions = await getPlanningRecipeVersionsByIds(
        meals.map((meal) => meal.recipe_version_id),
        tx,
    );

    const flaggedMealIds: string[] = [];
    const codes = new Set<MealFlagCode>();
    const movedFlags: MealFlagWrite[] = [];

    for (const meal of meals) {
        const recipe = versions.get(meal.recipe_version_id);

        if (recipe === undefined || !isMealSlot(meal.slot)) {
            continue;
        }

        const flags = evaluateMealAgainstPreferences({ slot: meal.slot, recipe }, preferences);

        if (!sameFlags(readStoredFlags(meal.flags), flags)) {
            // Collected rather than written here: one statement for the whole
            // plan, below. The meals' own `revision` is deliberately untouched
            // — flags are derived state, not a change to what was planned.
            movedFlags.push({ id: meal.id, flags });
        }

        if (flags.length > 0) {
            flaggedMealIds.push(meal.id);

            for (const flag of flags) {
                codes.add(flag.code);
            }
        }
    }

    const changed = movedFlags.length > 0;

    if (changed) {
        await writeMealFlags(tx, userId, planId, movedFlags);

        // `meal_plans.incompatibility_flags` IS AN AUDIT RECORD AND NEVER THE
        // SOURCE OF TRUTH. `MealPlanResponse.hasIncompatibilities` is derived
        // from the MEALS' flags, and the affected-meals response lists the meals
        // themselves, so a consumer must never read compatibility from this
        // column: it records what the last recomputation changed, for an
        // operator reading a plan row directly. Two sources for one fact is how
        // a banner outlives the meal that caused it.
        await tx.meal_plans.updateMany({
            where: { id: planId, user_id: userId },
            data: {
                revision: { increment: 1 },
                incompatibility_flags: asJsonValue({
                    flaggedMealIds,
                    codes: orderedFlagCodes(codes),
                    recomputedAt: recomputedAt.toISOString(),
                }),
            },
        });
    }

    return { flaggedMealCount: flaggedMealIds.length, changed };
};

/**
 * Recomputes the incompatibility flags of every active, non-ended plan the user
 * has, and returns how many planned meals are flagged in total — the
 * `affectedMealCount` both save responses carry.
 *
 * THIS IS THE ONE WRITE TO AN ACTIVE PLAN THAT CARRIES NO IDEMPOTENCY KEY (AAP
 * §0.5.1), and it is safe to repeat because it is idempotent by construction:
 * it recomputes each meal's verdict from the saved preferences and writes only
 * where the value CHANGED. Running it twice on unchanged preferences writes
 * nothing the second time and does not bump a revision — which is why a
 * preference edit that affects nothing cannot invalidate every other client's
 * pinned plan revision.
 *
 * `tx` is REQUIRED, not defaulted, and is the BRANDED
 * {@link MealPlanningTransactionClient} rather than Prisma's own
 * `TransactionClient`: the recomputation is several writes that must commit with
 * the preference write that caused it, under the per-user advisory lock the
 * caller already took. `Prisma.TransactionClient` is structurally WIDER than
 * `PrismaClient`, so the global autocommit client satisfies it — and on that
 * client each of these statements would commit alone, with the lock already
 * released, which is exactly the misuse the branded type makes a compile error.
 * `withMealPlanningTransaction` is the sanctioned source of such a client.
 *
 * MODULE-PRIVATE for the same reason. Its only callers are the two saves below,
 * which take the lock first; there is no lock-safe way for another module to
 * call it, so exporting it would publish an API whose contract cannot be
 * expressed in its signature. A future caller gets a lock-taking orchestration
 * boundary here rather than this function.
 *
 * `today` is the user's own calendar day, so an ended plan is excluded exactly
 * as every other rule excludes it. The meal's own `revision` is deliberately not
 * bumped: flags are derived state recomputed from preferences rather than a
 * change to what was planned, and the revision clients pin for a write is the
 * plan's.
 */
const recomputeActivePlanFlags = async (
    tx: MealPlanningTransactionClient,
    userId: string,
    today: string,
): Promise<number> => {
    const preferences = planningPreferencesFrom(await loadPreferencesRow(userId, tx));

    const plans = await tx.meal_plans.findMany({
        where: { user_id: userId, status: ACTIVE_PLAN_STATUS, end_date: { gte: toStoredDate(today) } },
        select: { id: true },
        orderBy: { start_date: 'asc' },
    });

    // The audit timestamp is read once, so every plan touched by one save
    // records the same recomputation rather than a spread of instants.
    const recomputedAt = new Date();
    let flaggedMealCount = 0;

    for (const plan of plans) {
        const outcome = await recomputePlanFlags(tx, userId, plan.id, preferences, recomputedAt);

        flaggedMealCount += outcome.flaggedMealCount;
    }

    return flaggedMealCount;
};

/* ---------------------------------------------------------------------------
 * The write side — one transaction, lock first
 *
 * A REFUSAL LEAVES THIS FILE IN ONE OF THREE WAYS, and the split is the
 * difference between "fix these fields", "these keys are not yours to write"
 * and "you are writing against a row that has moved". None of them picks a
 * status code: each carries the data the client acts on and the controller maps
 * it (Rule backend-architecture §8).
 *
 *  * A FIELD-LEVEL REFUSAL IS RETURNED, carrying every offending field.
 *    `parseSetupStep` and `parsePreferencesUpdate` accumulate one
 *    `InvalidRequestDetail` per problem — including one `read_only_field` entry
 *    per server-owned or unknown key — and answer with the whole list, which is
 *    precisely the `400 invalid_request` body with `details: [{field, code}]`
 *    the contract declares and the wizard needs in order to mark every bad
 *    input at once. A mixed body therefore keeps travelling as a value: the
 *    read-only key and the out-of-range age come back together.
 *  * A BODY WHOSE ONLY PROBLEM IS SERVER-OWNED OR UNKNOWN KEYS IS THROWN as
 *    `ReadOnlyFieldError` by {@link refuse}, which is the raise path the AAP's
 *    error inventory pairs with the controller's existing `read_only_field`
 *    mapping. The class carries the whole detail list, so the body on the wire
 *    is the same one the returned verdict produces — nothing is narrowed by
 *    throwing, which is what makes the class usable here at all. It is raised
 *    from WHICHEVER stage judged the body, because which stage that is depends
 *    on the other keys the body carried (see {@link refuse}).
 *  * A STALE REVISION IS THROWN as `StaleRevisionError`, in the one-counter
 *    form the preference routes own (`StaleRevisionCounterErrorData`); the
 *    two-counter form belongs to the plan routes, which pin two inputs at once.
 *    It is not a malformed request but a lost race, and its recovery is a
 *    different one — re-read, compare with the draft, resolve silently when
 *    they already agree. The sibling revisioned save throws for exactly this
 *    condition (`targets.service.ts`, `StaleTargetsError`), and throwing
 *    additionally aborts the transaction it is raised in, which releases the
 *    advisory lock at once and makes "nothing was written" a property of the
 *    mechanism rather than of this code.
 * ------------------------------------------------------------------------- */

/**
 * The outcome of either save: the response, or the field-level refusal verbatim.
 *
 * The two thrown refusals above — a stale revision, and a body whose only
 * problem is keys the client may not write — are deliberately absent from this
 * union, so a caller holding an `ok` or an `error` has already been told
 * everything a 200 or a 400 needs.
 */
export type SavePreferencesResult =
    | { kind: 'ok'; response: PreferencesSaveResponse }
    | PreferenceErrorVerdict;

/**
 * The pure layer's refusal, delivered the way its kind demands.
 *
 * ONE HELPER FOR ALL SIX REFUSAL SITES — the request-stage preflight, the
 * row-backed preflight, and the authoritative parse inside the lock, in both
 * saves — so no two of them can drift on which refusal throws and which
 * returns. That matters more than it reads: which STAGE answers a given body is
 * not a fixed property of the body. A partial that a row-dependent rule is
 * applicable to is carried to the row even when the request alone already has a
 * verdict, precisely so the client gets one merged 400 naming every offending
 * control (AAP §0.7.4) — so the same refusal can arrive here from either stage
 * depending on which other keys the body happened to carry, and a classification
 * that lived on only one of them would change an error's CLASS for a reason the
 * client cannot see.
 *
 * A STALE REVISION is thrown as `StaleRevisionError`: it is a lost race rather
 * than a malformed request, and throwing additionally aborts the transaction it
 * is raised in, which releases the advisory lock at once and makes "nothing was
 * written" a property of the mechanism rather than of this code.
 *
 * A VERDICT WHOSE DETAILS ARE EXCLUSIVELY `read_only_field` is precisely the
 * condition {@link ReadOnlyFieldError} names — a body that tried to write
 * server-owned or unknown keys (AAP §0.5.2) — so it leaves as that class rather
 * than as a value. That is what gives the class a raise path to match the status
 * mapping the controller already holds; before this, nothing constructed it. The
 * class carries the WHOLE list, so the wire body is identical to the returned
 * verdict's: a client sending three server-owned keys still learns about three
 * in one round trip.
 *
 * A MIXED verdict is RETURNED — a read-only key beside an out-of-range age stays
 * one 400 naming both (AAP §0.7.4). Throwing for the read-only half would either
 * drop the field details or need a second class for "read-only and other
 * things", and the returned verdict already answers exactly what the screen must
 * show at once.
 *
 * Which refusals qualify is `readOnlyFieldRefusal`'s call, in the pure layer,
 * because the HTTP boundary asks the same question of the same verdict before
 * this service is reached: one predicate, so the route and every other caller of
 * these saves cannot classify the same body differently.
 */
const refuse = (refusal: PreferenceRefusal): PreferenceErrorVerdict => {
    if (refusal.kind === 'stale_revision') {
        throw new StaleRevisionError({ currentRevision: refusal.currentRevision });
    }

    const readOnlyDetails = readOnlyFieldRefusal(refusal);

    if (readOnlyDetails !== null) {
        throw new ReadOnlyFieldError(readOnlyDetails);
    }

    return refusal;
};

/** The revision a freshly created row carries, so the client's next write can pin it. */
const FIRST_REVISION = 1;

/**
 * The columns one save writes, as a partial of the row.
 *
 * Optional throughout so it spreads into both a `create` and an `update` and
 * touches nothing it does not name — which is what makes a step save leave every
 * other step's answers alone, and a partial full save leave every omitted key
 * alone.
 */
interface PreferenceColumnWrites {
    goal?: string | null;
    goal_weight_kg?: number | null;
    pace_lb_per_week?: number | null;
    age?: number | null;
    height_cm?: number | null;
    weight_kg?: number | null;
    sex_for_estimate?: string | null;
    height_unit_pref?: string | null;
    weight_unit_pref?: string | null;
    activity_level?: string | null;
    diet?: string | null;
    allergens?: string[];
    disliked_food_ids?: string[];
    disliked_food_groups?: string[];
    meal_schedule?: string | null;
    meal_times?: Prisma.InputJsonValue;
    cooking_time_limit_min?: number | null;
    budget_amount?: number | null;
    budget_currency?: string | null;
    no_budget_preference?: boolean;
    budget_tier?: number | null;
    review_start_date?: Date | null;
}

/** Either the columns to write, or why the request was refused. */
type ColumnWritesResult = { kind: 'ok'; writes: PreferenceColumnWrites } | PreferenceErrorVerdict;

const invalidRequest = (details: InvalidRequestDetail[]): PreferenceErrorVerdict => ({
    kind: 'error',
    code: 'invalid_request',
    // A server-side diagnostic naming every offending field, in the same shape
    // `preferences.logic.ts` produces, so the controller cannot tell a
    // service-side refusal from a parser-side one. The client renders `details`.
    message: `invalid preferences request: ${details
        .map((detail) => `${detail.field} (${detail.code})`)
        .join(', ')}`,
    details,
});

/**
 * The budget tier the stored answer implies, recomputed from the values that
 * will be in force after this write.
 *
 * Recomputed on every write that can move either input — the amount, the
 * no-preference flag, or the SCHEDULE, because the tier is a per-MEAL figure and
 * three meals a day divide a weekly amount differently from four. A tier left
 * stale after a schedule change would penalise recipes by a budget the user no
 * longer has.
 *
 * The rule itself is `preferences.logic.ts::deriveBudgetTier`; an unanswered
 * schedule passes 0 meals a day, which that function documents as the
 * no-restriction case (tier 3) rather than an error.
 */
const budgetTierFor = (amount: number | null, schedule: MealSchedule | null): BudgetTier =>
    deriveBudgetTier(amount, schedule === null ? 0 : mealsPerDayForSchedule(schedule));

/**
 * What one save says about the dislike pair, stated per KEY rather than per
 * value.
 *
 * `null` means the request did not mention that half at all, which is a
 * different instruction from an empty array ("clear it"). The `dislikes` step
 * carries ids and never groups; a full save may carry either half, both, or
 * neither.
 */
interface DislikeSelection {
    foodIds: readonly string[] | null;
    foodGroups: readonly string[] | null;
}

/**
 * The dislike pair this save leaves behind: the selected food ids, and the
 * groups that exclude every food like them.
 *
 * `disliked_food_groups` HOLDS THE UNION OF TWO THINGS (AAP §0.7.3): the groups
 * DERIVED from the selected ids — which is what makes "Mushrooms, white"
 * exclude every `mushroom` food without touching an unrelated group — and the
 * groups the user excluded EXPLICITLY without naming a food in them. So the
 * effective pair is computed TOGETHER, from the state that will be in force
 * after the write, and never one key at a time: a body carrying only groups
 * (valid under §0.5.2's editable DTO) would otherwise overwrite the `mushroom`
 * group behind a mushroom the user still dislikes, leaving them holding the
 * dislike while every other mushroom re-entered their plans, and a body
 * carrying only ids would discard a group they had excluded independently of
 * any food.
 *
 * THE EXPLICIT HALF HAS NO PROVENANCE COLUMN, so when a request omits the
 * groups they are reconstructed as the stored groups MINUS the groups the
 * stored ids derive: that subtraction is the only way this schema can tell a
 * group the user chose from one a food implied. It compares exact stored
 * spellings, so a group the catalog has since re-spelled reads as explicit and
 * is KEPT — over-excluding rather than under-excluding, the direction
 * `deriveDislikedFoodGroups` chooses for the same reason.
 *
 * VALIDATION IS DELIBERATELY ASYMMETRIC, because the two id sets answer
 * different questions:
 *
 *  * A NEWLY SELECTED id that no PUBLISHED food resolves is REFUSED, not
 *    dropped. The contract admits "≤ 100 distinct published ids", and storing
 *    an id the catalog cannot resolve would store a dislike that excludes
 *    nothing — the user would have declined an ingredient and still be served
 *    it, which is the failure they notice. The refusal names every offending
 *    id's position, so the client can correct all of them at once.
 *  * AN ID ALREADY ON THIS ROW IS ACCEPTED WHATEVER ITS STATUS NOW IS, which is
 *    the whole of what "newly selected" adds above. It is not a relaxation of
 *    the published rule but the other half of the read: this endpoint HYDRATES a
 *    retired dislike into `dislikedFoods` on purpose ("a food that was published
 *    when the user declined it is still an answer they gave"), so the client
 *    holds it, shows it as a chip, and sends it back with every subsequent save
 *    of that step — the request body IS the whole list, not a delta. Validating
 *    it as a new selection made the preferences screen unsavable the moment a
 *    release retired anything the user disliked: removing the chip was the only
 *    accepted edit, and every other answer on the screen was held hostage to it.
 *    Re-sending a stored id is not a new selection at all, so it is judged as
 *    what it is — the user leaving an answer they already gave alone.
 *  * An id read FROM STORAGE never refuses, whatever its row now says: a
 *    release that retired a food the user disliked months ago must not block an
 *    unrelated schedule or budget edit. Its group is therefore derived from the
 *    row regardless of publication status — the asymmetry
 *    {@link PUBLISHED_CATALOG_STATUS} states — and the id itself stays stored,
 *    whether this save omitted the ids key or re-sent it unchanged. A stored id
 *    whose row has been DELETED outright contributes no group: there is nothing
 *    left to derive one from, and the food itself remains excluded by id while
 *    the ids key is omitted. Re-sending THAT id is refused, and correctly — it
 *    resolves to nothing, so it could only store an exclusion that excludes
 *    nothing, and the read already drops it from the list the client holds.
 *
 * `knownFoodGroups` is deliberately not supplied: the controlled taxonomy lives
 * in `data/meal-planning/coverage-plan.v1.json`, which this module cannot import
 * (the production build's `rootDir` is `./src` and the image excludes `data/`),
 * and omitting it skips only the drift report — never which groups are
 * excluded.
 */
const resolveDislikeWrites = async (
    selection: DislikeSelection,
    current: PreferencesRow | null,
    tx: Prisma.TransactionClient,
): Promise<ColumnWritesResult> => {
    const requestedFoodIds = selection.foodIds;
    const requestedFoodGroups = selection.foodGroups;

    // Neither half named: nothing to write, and no read to make. A caller that
    // reaches here without a dislike key must not clear the pair by omission.
    if (requestedFoodIds === null && requestedFoodGroups === null) {
        return { kind: 'ok', writes: {} };
    }

    const storedFoodIds = current?.disliked_food_ids ?? [];
    const storedFoodGroups = current?.disliked_food_groups ?? [];
    // ONE read serves both derivations: the request's ids must resolve to be
    // validated, and the stored ids must resolve both to supply the groups of
    // an ids-silent save and to reconstruct the explicit half. The two sets
    // overlap almost entirely on a real edit.
    const unionFoodIds = [...new Set([...(requestedFoodIds ?? []), ...storedFoodIds])];
    const foods =
        unionFoodIds.length === 0
            ? []
            : await tx.catalog_foods.findMany({
                  where: { id: { in: unionFoodIds } },
                  // The status is SELECTED rather than filtered on, because it
                  // decides only whether a REQUESTED id is acceptable;
                  // filtering it here would silently drop the group of a stored
                  // food the catalog has since retired.
                  select: { id: true, food_group: true, publication_status: true },
              });

    // Derived unconditionally: it is both the groups half of an ids-silent save
    // and the subtrahend the explicit half is reconstructed with. It is pure and
    // bounded by the 100-id contract, so computing it always is cheaper than a
    // second way of being wrong about when it is needed. Its `unknownFoodIds`
    // are ignored by design — see the asymmetry above.
    const storedDerivation = deriveDislikedFoodGroups(storedFoodIds, { foods });

    const writes: PreferenceColumnWrites = {};
    let derivedGroups: readonly string[] = storedDerivation.foodGroups;

    if (requestedFoodIds !== null) {
        // Selectable = published, OR already on this row. The second half is
        // what lets the list this endpoint handed the client round-trip: a
        // dislike the catalog has since retired is still hydrated into
        // `dislikedFoods`, so the client sends it back with every save of the
        // step, and judging it as a new selection would refuse the user's own
        // unchanged answer. Anything NEITHER published NOR already stored is a
        // new selection of an unselectable food and is still refused below.
        const retainedFoodIds = new Set(storedFoodIds);
        const requested = deriveDislikedFoodGroups(requestedFoodIds, {
            foods: foods.filter(
                (food) =>
                    food.publication_status === PUBLISHED_CATALOG_STATUS ||
                    retainedFoodIds.has(food.id),
            ),
        });

        if (requested.unknownFoodIds.length > 0) {
            return invalidRequest(
                requested.unknownFoodIds.map((id) => ({
                    field: `dislikedFoodIds[${requestedFoodIds.indexOf(id)}]`,
                    code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE,
                })),
            );
        }

        writes.disliked_food_ids = requested.foodIds;
        derivedGroups = requested.foodGroups;
    }

    const derivedFromStored = new Set(storedDerivation.foodGroups);
    const explicitGroups =
        requestedFoodGroups ?? storedFoodGroups.filter((group) => !derivedFromStored.has(group));

    // Written whenever either half was named, sorted and de-duplicated so
    // storage is stable across saves.
    writes.disliked_food_groups = [...new Set([...derivedGroups, ...explicitGroups])].sort();

    return { kind: 'ok', writes };
};

/**
 * The latest day any active plan of this user still covers, or `null` when they
 * have none.
 *
 * The upper bound of the start-date window is taken from the LATEST active plan
 * rather than the current one, because a user may hold a current plan and an
 * upcoming one and "Plan another week" continues from the last of them.
 */
const latestActivePlanEndDate = async (
    userId: string,
    today: string,
    tx: Prisma.TransactionClient,
): Promise<string | null> => {
    const plan = await tx.meal_plans.findFirst({
        where: { user_id: userId, status: ACTIVE_PLAN_STATUS, end_date: { gte: toStoredDate(today) } },
        select: { end_date: true },
        orderBy: { end_date: 'desc' },
    });

    return plan === null ? null : toDayKey(plan.end_date);
};

/**
 * The review step's start date, bounded.
 *
 * `preferences.logic.ts::parseReviewStep` validates the FORMAT and the calendar
 * validity and says in so many words that the window "needs today's date in the
 * user's zone, which no pure function can know: the service holds that bound".
 * This is that bound, and it is applied through
 * `mealPlan.logic.ts::startDateWindow` — the same function
 * `parseGeneratePlanRequest` uses — rather than a second arithmetic here, so a
 * date this save accepts is a date generation will accept. Two spellings of the
 * window is how a user gets to persist a start date that the generate call then
 * refuses.
 */
const resolveReviewStartDate = async (
    userId: string,
    startDate: string,
    today: string,
    tx: Prisma.TransactionClient,
): Promise<ColumnWritesResult> => {
    const window = startDateWindow(today, await latestActivePlanEndDate(userId, today, tx));

    // Day keys are zero-padded, so a lexicographic comparison is a
    // chronological one — the same comparison `startDateWindow` documents.
    if (startDate < window.earliest) {
        return invalidRequest([{ field: 'startDate', code: PREFERENCE_FIELD_CODES.BELOW_MINIMUM }]);
    }

    if (startDate > window.latest) {
        return invalidRequest([{ field: 'startDate', code: PREFERENCE_FIELD_CODES.ABOVE_MAXIMUM }]);
    }

    return { kind: 'ok', writes: { review_start_date: toStoredDate(startDate) } };
};

/**
 * The columns one setup step owns.
 *
 * Every value has already been validated, normalised to metric, checked for
 * allergen exclusivity and matched to its schedule by
 * `preferences.logic.ts::parseSetupStep`; this function only decides which
 * COLUMNS each step's answer lands in, and asks the pure layer for the two
 * derived values a step implies (the budget tier and the disliked food groups).
 *
 * A SKIPPED BODY STEP CLEARS NOTHING. Skip is the answer that routes the user to
 * manual targets, not an instruction to delete measurements they may have
 * entered on an earlier pass; the route change is what the step records, and
 * `resolveTargetRouteForBodyStep` is where that decision lives.
 */
const stepColumnWrites = async (
    userId: string,
    parsed: ParsedSetupStepPayload,
    current: PreferencesRow | null,
    today: string,
    tx: Prisma.TransactionClient,
): Promise<ColumnWritesResult> => {
    switch (parsed.step) {
        case 'goal':
            return {
                kind: 'ok',
                writes: {
                    goal: parsed.payload.goal,
                    // A step save replaces its whole answer, so an omitted goal
                    // weight or pace CLEARS the stored one: that is how moving
                    // to the 'maintain' goal drops both.
                    goal_weight_kg: parsed.payload.goalWeightKg ?? null,
                    pace_lb_per_week: parsed.payload.paceLbPerWeek ?? null,
                },
            };
        case 'body':
            return parsed.payload.skipped === true
                ? { kind: 'ok', writes: {} }
                : {
                      kind: 'ok',
                      writes: {
                          age: parsed.payload.age,
                          height_cm: parsed.payload.heightCm,
                          weight_kg: parsed.payload.weightKg,
                          sex_for_estimate: parsed.payload.sexForEstimate,
                          height_unit_pref: parsed.payload.heightUnitPref,
                          weight_unit_pref: parsed.payload.weightUnitPref,
                      },
                  };
        case 'activity':
            return { kind: 'ok', writes: { activity_level: parsed.payload.activityLevel } };
        case 'diet':
            return {
                kind: 'ok',
                writes: { diet: parsed.payload.diet, allergens: parsed.payload.allergens },
            };
        case 'dislikes':
            // Ids only, and the pair is resolved exactly as the full save
            // resolves it: the step names no groups, so a group the user
            // excluded explicitly is carried across this save rather than
            // dropped by it.
            return resolveDislikeWrites(
                { foodIds: parsed.payload.dislikedFoodIds, foodGroups: null },
                current,
                tx,
            );
        case 'schedule':
            return {
                kind: 'ok',
                writes: {
                    meal_schedule: parsed.payload.mealSchedule,
                    meal_times: asJsonValue(parsed.payload.mealTimes),
                    // The schedule is half of the per-meal budget, so the tier
                    // is re-derived from the amount already stored.
                    budget_tier: budgetTierFor(
                        current?.budget_amount ?? null,
                        parsed.payload.mealSchedule,
                    ),
                },
            };
        case 'cooking':
            return {
                kind: 'ok',
                writes: {
                    cooking_time_limit_min: parsed.payload.cookingTimeLimitMin,
                    budget_amount: parsed.payload.budget?.amount ?? null,
                    budget_currency: parsed.payload.budget?.currency ?? null,
                    no_budget_preference: parsed.payload.noBudgetPreference,
                    budget_tier: budgetTierFor(
                        parsed.payload.budget?.amount ?? null,
                        asMember(MEAL_SCHEDULES, current?.meal_schedule ?? null),
                    ),
                },
            };
        default:
            return resolveReviewStartDate(userId, parsed.payload.startDate, today, tx);
    }
};

/** What `parseSetupStep` and `parsePreferencesUpdate` need to know about the stored row. */
const stepContext = (row: PreferencesRow | null): SetupStepContext => ({
    currentRevision: row === null ? null : row.revision,
    currentWeightKg: row?.weight_kg ?? null,
    // The stored goal and target weight are what make `goalWeightConflict`
    // effective: a target accepted while no current weight was known is
    // re-judged the moment the body step supplies one, and a goal saved earlier
    // gives the direction to judge it in.
    currentGoal: row === null ? null : asMember(GOALS, row.goal),
    currentGoalWeightKg: row?.goal_weight_kg ?? null,
});



/**
 * The freshly stored revision, read for the one purpose of telling a client
 * which revision is authoritative after its own pinned one turned out not to be.
 *
 * Read inside the transaction that is about to abort, and therefore before the
 * throw: the read is valid while the transaction is still live, and the throw is
 * what rolls it back and releases the lock. A row that has vanished reports
 * {@link NO_PREFERENCES_REVISION}, which is what the client reads back from a
 * user with no row.
 */
const staleRevisionAfterLostWrite = async (
    userId: string,
    tx: MealPlanningTransactionClient,
): Promise<never> => {
    const fresh = await loadPreferencesRow(userId, tx);

    throw new StaleRevisionError({ currentRevision: fresh?.revision ?? NO_PREFERENCES_REVISION });
};

/**
 * `PUT /api/meal-planning/preferences/steps/:step` — one setup answer.
 *
 * VALIDATION HAPPENS IN THREE STAGES, and the order is the contract's, not a
 * convenience:
 *
 *  1. THE REQUEST ALONE, WITH NO DATABASE WORK AT ALL. `parseSetupStepRequest`
 *     is the first statement, and the row read that used to sit inside the
 *     parse's own argument list now happens after it. It runs the real parse
 *     against a "row not read" context, so an unknown `:step`, a non-object
 *     body, a server-owned or misspelled key, a missing or unknown IANA zone, a
 *     pinned revision no `integer` column could hold AND every field rule of
 *     the step's own payload — an unknown goal, an out-of-range age, a
 *     malformed meal time — are answered as one `400 invalid_request` before
 *     Prisma is touched, which is what AAP §0.5.2's "validation applied before
 *     any Prisma or planning work" requires. Previously all of it reached the
 *     database first. A REFUSAL HERE ENDS THE REQUEST ONLY WHEN NO ROW-DEPENDENT
 *     RULE WAS ALSO APPLICABLE, which is the whole of what this stage decides:
 *     for such a body `loadPreferencesRow` never runs, so a client sending
 *     nonsense cannot make the server read a row per malformed attempt. When a
 *     rule whose other half lives in the stored row IS applicable, this stage
 *     answers `needs_context` even holding a refusal of its own, the row is
 *     read, and the authoritative parse below returns ONE 400 naming both its
 *     details and that rule's — AAP §0.7.4 requires validate-on-press to mark
 *     every offending control at once, and a body whose pace is unknown AND
 *     whose target weight contradicts the stored current weight has two of them
 *     of which this stage can see only one. Nothing is carried forward across
 *     the two stages: the authoritative parse re-derives every detail from the
 *     same body plus strictly more information — see `parseSetupStepRequest`
 *     and `parsePreferencesUpdateRequest` for the exact applicability rules.
 *  2. THE UNLOCKED PARSE, against the row as it stands. This is what keeps a
 *     client sending nonsense from taking the user's advisory lock and
 *     serialising their real writes behind it, and it reports every field-level
 *     problem in one 400.
 *  3. THE AUTHORITATIVE PARSE, INSIDE THE LOCK, against the row as it then is.
 *     The revision check is only meaningful against a row nobody can change
 *     underneath it, and a save that parsed against a pre-lock snapshot would
 *     let two concurrent clients both appear to succeed while one update
 *     vanished. `parseSetupStep` is pure and does no I/O, so running it again
 *     costs nothing but correctness.
 *
 * The transaction does, in order (AAP §0.5.1): take the per-user lock, re-read
 * the row, parse, create the row as the state machine's first state or update
 * it, bump the revision, and recompute the incompatibility flags of every active
 * plan. All of it commits together — a preference the flags were never
 * recomputed against would leave a plan describing itself as compatible with
 * answers it no longer matches.
 *
 * EDIT MODE CANNOT MOVE SETUP BACKWARDS, and this file does not implement that:
 * `nextSetupState` is monotonic in both the status and the resume marker, so
 * re-saving the diet step from plan settings leaves a completed setup completed.
 * Relying on it is the point — a second rule here could disagree with it.
 *
 * `now` is a parameter so the day key the flag recomputation and the response
 * are resolved against is fixed for the whole write, and so a test can fix the
 * clock rather than wait for one.
 */
export const saveSetupStep = async (
    userId: string,
    step: unknown,
    body: unknown,
    now: Date = new Date(),
): Promise<SavePreferencesResult> => {
    const requestOnly: PreferenceRequestVerdict = parseSetupStepRequest(step, body);

    if (requestOnly.kind === 'error') {
        return refuse(requestOnly);
    }

    // `ok` and `needs_context` both continue: the revision comparison needs the
    // row in either case, and `needs_context` only adds that a coherence rule
    // has a verdict to contribute once it is read.
    const preflight = parseSetupStep(step, body, stepContext(await loadPreferencesRow(userId)));

    if (preflight.kind !== 'ok') {
        return refuse(preflight);
    }

    return withMealPlanningTransaction((tx) =>
        withUserLock(tx, userId, async (locked) => {
            const current = await loadPreferencesRow(userId, locked);
            const verdict = parseSetupStep(step, body, stepContext(current));

            if (verdict.kind !== 'ok') {
                return refuse(verdict);
            }

            // Re-typed as the payload union so the switch in `stepColumnWrites`
            // narrows on `step`; the verdict's own `kind` member is not part of
            // that discrimination.
            const parsed: ParsedSetupStepPayload = verdict;
            const timeZone = parsed.payload.timeZone;
            const today = dayKeyInTimeZone(now, timeZone);
            const columns = await stepColumnWrites(userId, parsed, current, today, locked);

            if (columns.kind !== 'ok') {
                return columns;
            }

            const transition = nextSetupState(
                setupStateOf(current),
                parsed.step,
                // Only the body step decides the route: Skip and "Prefer not to
                // say" both take the manual one, and which is which is
                // `resolveTargetRouteForBodyStep`'s call. Every other step
                // passes null, which keeps the stored route.
                parsed.step === 'body' ? resolveTargetRouteForBodyStep(parsed.payload) : null,
            );

            if (current === null) {
                await locked.meal_plan_preferences.create({
                    data: {
                        user_id: userId,
                        time_zone: timeZone,
                        // The first transition of a payload-bearing step is never
                        // 'not_started', so the row is created 'in_progress' by
                        // the state machine rather than by a literal here.
                        setup_status: transition.setupStatus,
                        setup_step: transition.setupStep,
                        target_route: transition.targetRoute,
                        revision: FIRST_REVISION,
                        ...columns.writes,
                    },
                });
            } else {
                // OWNER AND EXPECTED REVISION ARE BOTH IN THE PREDICATE (AAP
                // §0.5.1, Rule §5.1): `user_id` is the owner key and the unique
                // index, and `revision` is the value this request pinned, so the
                // optimistic check is enforced by the MUTATION rather than only
                // by the comparison the parser made a few statements earlier.
                // `updateMany` is what allows a predicate wider than the unique
                // key — `update` would take `user_id` alone and become the
                // id-only write §5.1 forbids — and its row count is the answer:
                // one row means the revision still held, none means it moved
                // under us and nothing was written.
                const written = await locked.meal_plan_preferences.updateMany({
                    where: { user_id: userId, revision: current.revision },
                    data: {
                        // Refreshed on every step save, by contract: a user who
                        // has moved sees plan days in the zone of their most
                        // recent edit.
                        time_zone: timeZone,
                        setup_status: transition.setupStatus,
                        setup_step: transition.setupStep,
                        target_route: transition.targetRoute,
                        revision: current.revision + 1,
                        ...columns.writes,
                    },
                });

                if (written.count !== 1) {
                    // Unreachable while the advisory lock holds — every writer of
                    // this row takes it first — which is precisely why it is a
                    // guard rather than a branch with behaviour of its own: it
                    // reports the lost race the same way the parser does, so a
                    // future writer that forgets the lock cannot silently
                    // overwrite a revision it never pinned.
                    await staleRevisionAfterLostWrite(userId, locked);
                }
            }

            const affectedMealCount = await recomputeActivePlanFlags(locked, userId, today);
            const saved = await loadPreferencesRow(userId, locked);

            if (saved === null) {
                // Unreachable: the row was just written inside this transaction.
                // Throwing rather than fabricating a response keeps the failure
                // loud if it ever becomes reachable.
                throw new Error('preferences row disappeared inside its own transaction');
            }

            return {
                kind: 'ok',
                response: {
                    preferences: await buildPreferencesResponse(userId, saved, now, locked),
                    affectedMealCount,
                },
            };
        }),
    );
};

/**
 * The columns a full save writes, one per key present in the parsed partial.
 *
 * OMITTED AND NULL ARE DIFFERENT HERE, which is the whole difference from a step
 * save: a key the body did not mention is absent from the returned writes and
 * leaves the stored value alone, while an explicit null clears it. The parser
 * has already normalised the pairs that must agree (a 'maintain' goal arrives
 * with explicit nulls for the pace and the goal weight; the budget pair arrives
 * coherent), so nothing is re-decided here.
 *
 * Two groups of keys resolve TOGETHER rather than one per key, because each
 * writes a column no single key owns: the budget tier follows any of its three
 * inputs, and the two dislike keys write one stored pair (AAP §0.7.3). Both are
 * computed from the state that will be in force after this write, never from
 * the body alone.
 */
const updateColumnWrites = async (
    payload: PreferencesUpdatePayload,
    current: PreferencesRow | null,
    tx: Prisma.TransactionClient,
): Promise<ColumnWritesResult> => {
    const writes: PreferenceColumnWrites = {};
    const has = (key: keyof PreferencesUpdatePayload): boolean =>
        Object.prototype.hasOwnProperty.call(payload, key);

    if (has('goal')) writes.goal = payload.goal;
    if (has('goalWeightKg')) writes.goal_weight_kg = payload.goalWeightKg ?? null;
    if (has('paceLbPerWeek')) writes.pace_lb_per_week = payload.paceLbPerWeek ?? null;
    if (has('age')) writes.age = payload.age;
    if (has('heightCm')) writes.height_cm = payload.heightCm;
    if (has('weightKg')) writes.weight_kg = payload.weightKg;
    if (has('sexForEstimate')) writes.sex_for_estimate = payload.sexForEstimate;
    if (has('heightUnitPref')) writes.height_unit_pref = payload.heightUnitPref;
    if (has('weightUnitPref')) writes.weight_unit_pref = payload.weightUnitPref;
    if (has('activityLevel')) writes.activity_level = payload.activityLevel;
    if (has('diet')) writes.diet = payload.diet;
    if (has('allergens')) writes.allergens = payload.allergens;
    if (has('mealSchedule')) writes.meal_schedule = payload.mealSchedule;
    if (has('mealTimes')) writes.meal_times = asJsonValue(payload.mealTimes);
    if (has('cookingTimeLimitMin')) writes.cooking_time_limit_min = payload.cookingTimeLimitMin;
    if (has('noBudgetPreference')) writes.no_budget_preference = payload.noBudgetPreference;

    if (has('budget')) {
        writes.budget_amount = payload.budget?.amount ?? null;
        writes.budget_currency = payload.budget?.currency ?? null;
    }

    // THE TWO DISLIKE KEYS ARE ONE WRITE, resolved together against the stored
    // pair. Both halves are exclusions the user asked for — the groups the ids
    // derive and the groups they named themselves — so neither key can be
    // applied on its own without overwriting the other half on a partial body.
    // `resolveDislikeWrites` holds that rule, including which id set validates.
    if (has('dislikedFoodIds') || has('dislikedFoodGroups')) {
        const resolved = await resolveDislikeWrites(
            {
                foodIds: has('dislikedFoodIds') ? (payload.dislikedFoodIds ?? []) : null,
                foodGroups: has('dislikedFoodGroups') ? (payload.dislikedFoodGroups ?? []) : null,
            },
            current,
            tx,
        );

        if (resolved.kind !== 'ok') {
            return resolved;
        }

        Object.assign(writes, resolved.writes);
    }

    // The tier follows whichever of its three inputs this body moved, read from
    // the values that will be in force after the write.
    if (has('budget') || has('noBudgetPreference') || has('mealSchedule')) {
        const amount = has('budget') ? (payload.budget?.amount ?? null) : (current?.budget_amount ?? null);
        const schedule = has('mealSchedule')
            ? (payload.mealSchedule ?? null)
            : asMember(MEAL_SCHEDULES, current?.meal_schedule ?? null);

        writes.budget_tier = budgetTierFor(amount, schedule);
    }

    return { kind: 'ok', writes };
};

/** The context `parsePreferencesUpdate` judges a PARTIAL body against. */
const updateContext = (row: PreferencesRow | null): PreferencesUpdateContext => ({
    currentRevision: row === null ? null : row.revision,
    currentWeightKg: row?.weight_kg ?? null,
    currentGoal: row === null ? null : asMember(GOALS, row.goal),
    // A partial body that moves only the goal, or only the current weight, can
    // invalidate a target weight it never mentions and can leave a direction
    // with no pace to estimate from; both side checks are inert unless the
    // stored values reach the parser.
    currentGoalWeightKg: row?.goal_weight_kg ?? null,
    currentPaceLbPerWeek: row === null ? null : asNumericMember(PACES, row.pace_lb_per_week),
    currentMealSchedule: row === null ? null : asMember(MEAL_SCHEDULES, row.meal_schedule),
    currentBudget: row === null ? null : readBudget(row),
    currentNoBudgetPreference: row?.no_budget_preference ?? false,
    // A body carrying only the envelope edits this column or nothing at all, so
    // the stored zone is what decides whether it is a save or a no-op. It is
    // the contract's channel for reconciling a device that has moved (AAP
    // §0.5.2), and the parser cannot tell a real zone change from a repeat of
    // the stored one without it.
    currentTimeZone: row?.time_zone ?? null,
});

/**
 * `PUT /api/meal-planning/preferences` — a partial edit of the twenty editable
 * keys.
 *
 * The shape is {@link saveSetupStep}'s exactly: the request-only parse with no
 * database work, the unlocked parse against the stored row, then
 * lock, re-read, authoritative parse, write under the owner-and-revision
 * predicate, bump the revision, recompute every active plan's flags, and answer
 * with the freshly re-read preferences. One flag lifecycle for both saves is
 * the requirement (AAP §0.5.2, "recomputes incompatibility flags in the same
 * transaction exactly as the full save does"), so the two share every step that
 * decides anything.
 *
 * TWO SERVER-OWNED COLUMNS ARE DERIVED HERE, both from the row as it will be
 * once this save lands rather than from the body alone. `target_route` follows
 * the body answer ({@link resolveTargetRouteForUpdate}), because the four
 * answers that decide whether an estimate can be calculated are all editable
 * through this endpoint while the DTO has no key for the route itself; and the
 * setup state is reconciled ({@link reconcileSetupStateForRoute}) when — and
 * only when — that route changed, because the two routes require different
 * steps.
 *
 * SERVER-OWNED KEYS LEAVE AS `ReadOnlyFieldError`, thrown by {@link refuse} from
 * whichever stage judged the body. A partial no row-dependent rule applies to is
 * refused before any Prisma work; one such rule IS applicable to is carried to
 * the row so the 400 can name every offending control at once (AAP §0.7.4), and
 * the same class is raised there. The class carries the whole `read_only_field`
 * detail list, so throwing narrows nothing: the controller maps it to the same
 * `400 {error: 'invalid_request', details}` the returned verdict produces, and a
 * client sending three offending keys learns about three at once. A body that
 * gets a read-only key AND a field rule wrong keeps travelling as the verdict,
 * because that single 400 must name every offending control.
 *
 * THE SETUP STATE MACHINE IS NEVER ADVANCED, AND NO ROW IS CREATED. A full save
 * is a settings edit rather than a wizard step: it never moves `setupStep`
 * forward and never promotes `setupStatus`, so generation keeps refusing with
 * `preferences_incomplete` until the wizard actually runs. The one way it
 * touches either column is the reconciliation above, which can only pull a
 * not-yet-completed user BACK to an answer their new route requires and the row
 * proves is missing — never forward, and never for a `completed` user. It also
 * never
 * creates — `parsePreferencesUpdate` refuses a user who has no row at all ("this
 * endpoint EDITS; it never creates"), because a partial has nothing to apply to
 * and creating here would materialise the setup state the first `goal` step
 * owns. The client recovery is the one it already has for a lost race: re-read,
 * see `revision: 0` and `setupStatus: 'not_started'`, and go through setup. The
 * one route that upserts the row for a user who never onboarded is
 * `PUT /meal-planning/targets`, whose write is a confirmed target rather than a
 * preference (AAP §0.5.2).
 */
export const savePreferences = async (
    userId: string,
    body: unknown,
    now: Date = new Date(),
): Promise<SavePreferencesResult> => {
    const requestOnly: PreferenceRequestVerdict = parsePreferencesUpdateRequest(body);

    if (requestOnly.kind === 'error') {
        return refuse(requestOnly);
    }

    // As in `saveSetupStep`: the row read sits BELOW the refusal, so a partial
    // already known to be unstorable costs no query, while `needs_context` —
    // one of the four pair rules is applicable — proceeds exactly as `ok` does.
    const preflight = parsePreferencesUpdate(body, updateContext(await loadPreferencesRow(userId)));

    if (preflight.kind !== 'ok') {
        return refuse(preflight);
    }

    return withMealPlanningTransaction((tx) =>
        withUserLock(tx, userId, async (locked) => {
            const current = await loadPreferencesRow(userId, locked);
            const verdict = parsePreferencesUpdate(body, updateContext(current));

            if (verdict.kind !== 'ok') {
                return refuse(verdict);
            }

            if (current === null) {
                // Unreachable: the parse above refuses a body from a user with
                // no row, and that refusal has already returned. A loud failure
                // rather than a create branch, which would be a second, silent
                // answer to a question the pure layer has already decided.
                throw new Error('preferences update parsed against a missing row');
            }

            // THE ZONE THIS REQUEST CARRIED, not the stored one. It is a
            // required envelope field (AAP §0.5.2), canonicalised by the parser,
            // and resolved BEFORE the dislike pair's catalog reads below so that
            // every date this save derives — the start-date window, the ended-plan
            // boundary the flag recomputation applies, and the `hasActivePlan`
            // the response carries — comes from the calendar the user is in now.
            const timeZone = verdict.payload.timeZone;
            const today = dayKeyInTimeZone(now, timeZone);
            const columns = await updateColumnWrites(verdict.payload, current, locked);

            if (columns.kind !== 'ok') {
                return columns;
            }

            // The row as it will be once this save lands, which is what both
            // server-owned derivations below are judged against: a body that
            // supplies an activity level in the same request counts, and one
            // that supplies only a sex answer is read together with the
            // measurements already stored.
            const afterWrites: PreferencesRow = { ...current, ...columns.writes };
            // `target_route` is server-owned — the editable DTO has no such key
            // — so a full save that moves the body answer must derive it here or
            // leave the row claiming a route the answers contradict (the
            // estimated route for a user who now declines to state a sex, or the
            // manual route for one whose measurements are now complete).
            const targetRoute = resolveTargetRouteForUpdate(
                asMember(TARGET_ROUTES, current.target_route),
                {
                    age: afterWrites.age,
                    heightCm: afterWrites.height_cm,
                    weightKg: afterWrites.weight_kg,
                    sexForEstimate: asMember(SEXES_FOR_ESTIMATE, afterWrites.sex_for_estimate),
                },
            );
            // A route change moves which steps the route requires, so a
            // not-yet-completed user whose new route needs an answer the row
            // does not hold is pulled back to it. Nothing is reconciled when the
            // route stands still, and a `completed` user is never touched.
            const reconciliation =
                targetRoute === undefined
                    ? undefined
                    : reconcileSetupStateForRoute(setupStateOf(afterWrites), targetRoute);

            const written = await locked.meal_plan_preferences.updateMany({
                // Owner key AND pinned revision, for the reason the step save
                // states: the optimistic check belongs in the mutation, not only
                // in the comparison a few statements earlier (AAP §0.5.1).
                where: { user_id: userId, revision: current.revision },
                data: {
                    time_zone: timeZone,
                    // What flips `TargetsResponse.stale` for a confirmed
                    // estimate is this `revision` bump, which the save carries
                    // whatever it edited (AAP §0.5.2 compares
                    // `targets_input_revision` against it).
                    revision: current.revision + 1,
                    ...(targetRoute === undefined ? {} : { target_route: targetRoute }),
                    ...(reconciliation === undefined
                        ? {}
                        : {
                              setup_status: reconciliation.setupStatus,
                              setup_step: reconciliation.setupStep,
                          }),
                    ...columns.writes,
                },
            });

            if (written.count !== 1) {
                await staleRevisionAfterLostWrite(userId, locked);
            }

            const affectedMealCount = await recomputeActivePlanFlags(locked, userId, today);
            const saved = await loadPreferencesRow(userId, locked);

            if (saved === null) {
                throw new Error('preferences row disappeared inside its own transaction');
            }

            return {
                kind: 'ok',
                response: {
                    preferences: await buildPreferencesResponse(userId, saved, now, locked),
                    affectedMealCount,
                },
            };
        }),
    );
};
