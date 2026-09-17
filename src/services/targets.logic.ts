// The pure nutrition-target domain: the deterministic calorie/macro estimate,
// the bounds that move it, the request parsers for the save route — the
// hand-entered values and the envelope around them — and the truth rules that
// tell every surface — review, plan settings, Account, Progress and the diary —
// whether the numbers on screen are a confirmed estimate, a manual entry, a
// legacy write, or a stale estimate.
//
// Everything here is deterministic and synchronous: no Prisma, no network, no
// `process.env`, and no clock. The database rows this module reads are declared
// below as structural snake_case interfaces rather than imported Prisma types,
// so the rules stay unit-testable with plain object literals and the module
// never pulls a framework into the dependency graph. `targets.service.ts` owns
// every await, the transaction, and the call to `updateTargets`.
//
// Two conventions are worth stating once, because they are easy to get subtly
// wrong and both are pinned by tests:
//
//  * ROUNDING ORDER. The basal rate and the activity-adjusted rate are carried
//    at FULL precision through the whole derivation, and the calorie figure is
//    rounded exactly once — after the goal adjustment. Macro grams are then
//    derived from that single rounded, bounded integer, so the four values the
//    user sees always describe one consistent target. Rounding earlier changes
//    the answer: the reference case's 1606.25 kcal basal rate yields a 2209
//    kcal maintenance rate, where a pre-rounded 1606 would yield 2208.
//
//  * BOUNDS ARE NOT A GOAL-SPECIFIC RULE. The floor applies to every goal, not
//    just weight loss. See `applyTargetBounds`.

import {
    MAX_REVISION,
    PREFERENCE_FIELD_CODES,
    SetupStateSnapshot,
    nextSetupState,
} from './preferences.logic';
import {
    ActivityLevel,
    ClampReason,
    EstimateUnavailableErrorData,
    FeasibilityWarning,
    Goal,
    InvalidRequestDetail,
    MealPlanMacroTotals,
    NutritionTargetValues,
    PaceLbPerWeek,
    SaveEstimatedTargetsPayload,
    SaveManualTargetsPayload,
    SetupStatus,
    SetupStep,
    SexForEstimate,
    StoredEstimateSnapshot,
    TargetEstimateInputs,
    TargetEstimateResponse,
    TargetRoute,
    TargetSource,
    TargetsFeasibility,
    TargetsResponse,
} from '../types/mealPlanning';

/* ---------------------------------------------------------------------------
 * Energy model — every constant with its provenance
 * ------------------------------------------------------------------------- */

/**
 * Mifflin–St Jeor resting-energy coefficients (Mifflin MD, St Jeor ST, Hill LA,
 * Scott BJ, Daugherty SA, Koh YO, "A new predictive equation for resting energy
 * expenditure in healthy individuals", Am J Clin Nutr 1990;51(2):241–247):
 *
 *   male   = 10·weight(kg) + 6.25·height(cm) − 5·age(y) + 5
 *   female = 10·weight(kg) + 6.25·height(cm) − 5·age(y) − 161
 */
const BMR_WEIGHT_COEFFICIENT = 10;
const BMR_HEIGHT_COEFFICIENT = 6.25;
const BMR_AGE_COEFFICIENT = 5;
const BMR_SEX_CONSTANT: Readonly<Record<CalculableSex, number>> = {
    male: 5,
    female: -161,
};

/**
 * The factor the basal rate is multiplied by to reach a daily expenditure.
 *
 * PRODUCT POLICY, not a published table. FAO/WHO/UNU's 2001 human-energy-
 * requirements report is the source of the physical-activity-level *concept*
 * (expenditure as a multiple of the resting rate) and it publishes activity
 * RANGES per lifestyle category — it does not publish these four numbers. The
 * values below are the Harris–Benedict-era multipliers reproduced by common
 * dietetic calculators, adopted here as product policy so the four on-screen
 * options map to four stable factors. Do not "correct" them against
 * FAO/WHO/UNU: that report does not contain them.
 *
 * The level describes the user's habitual overall activity INCLUDING their
 * usual training, which is what the on-screen option sub-copy anchors ("1–2",
 * "3–5", "6+ workouts a week") describe. It multiplies the basal rate exactly
 * once and workouts and runs logged in the app are never added on top, so
 * training is never counted twice.
 */
export const ACTIVITY_FACTORS: Readonly<Record<ActivityLevel, number>> = {
    not_very_active: 1.2,
    lightly_active: 1.375,
    active: 1.55,
    very_active: 1.725,
};

/**
 * Energy equivalent of a pound of body mass (Wishnofsky M, "Caloric equivalents
 * of gained or lost weight", Am J Clin Nutr 1958;6(5):542–546). Treated as an
 * approximation rather than a law — see Hall KD, "What is the required energy
 * deficit per unit weight loss?", Int J Obes 2008;32(3):573–576 — which is why
 * the estimate is presented as a starting point the user can edit.
 */
const KCAL_PER_POUND = 3500;
const DAYS_PER_WEEK = 7;

/**
 * Daily kcal per pound-per-week of intended weight change: 3500 ÷ 7 = 500.
 * Applied as −500·pace for loss and +500·pace for gain, so the three offered
 * paces (0.5, 1 and 1.5 lb/week) become ∓250, ∓500 and ∓750 kcal/day.
 */
export const KCAL_PER_POUND_PER_WEEK_PER_DAY = KCAL_PER_POUND / DAYS_PER_WEEK;

/** 'maintain' has no pace and therefore no adjustment. */
const NO_GOAL_ADJUSTMENT = 0;

/**
 * The macro split applied to the confirmed calorie figure: 30 % of energy from
 * protein, 40 % from carbohydrate, 30 % from fat. Product policy — a
 * conventional balanced split, not a clinical prescription.
 */
export const MACRO_ENERGY_SHARES = {
    protein: 0.3,
    carbs: 0.4,
    fat: 0.3,
} as const;

/** Atwater energy factors used to convert an energy share into grams. */
export const KCAL_PER_GRAM = {
    protein: 4,
    carbs: 4,
    fat: 9,
} as const;

/* ---------------------------------------------------------------------------
 * Bounds and supported ranges
 *
 * PRODUCT POLICY FOR GENERAL-WELLNESS USE — NOT CLINICAL GUIDANCE. The floors,
 * the ceiling and the adult input envelope below are widely cited
 * general-wellness guardrails adopted as this product's policy; no clinical
 * source is claimed for any of them, and `docs/meal-planning/planning-policy.md`
 * says so in the same terms. They exist to stop the arithmetic producing a
 * number the app should never show, not to advise anyone.
 * ------------------------------------------------------------------------- */

/** Lowest calorie target the app will present, by the sex used for the estimate. */
export const CALORIE_FLOOR_BY_SEX: Readonly<Record<CalculableSex, number>> = {
    female: 1200,
    male: 1500,
};

/** Highest calorie target the app will present, for every goal. */
export const CALORIE_CEILING = 5000;

/**
 * The adult envelope the estimate is supported over. `preferences.logic.ts`
 * rejects anything outside it with a 400 at write time, so a stored value
 * outside these ranges is a corrupt row rather than user input; this module
 * refuses to estimate from one instead of clamping it into range (see
 * `resolveEstimateInputs`).
 */
export const ESTIMATE_INPUT_RANGES = {
    age: { min: 18, max: 100 },
    heightCm: { min: 120, max: 250 },
    weightKg: { min: 30, max: 300 },
} as const;

/** The range a hand-entered calorie target must fall in, as a whole kcal. */
export const MANUAL_CALORIE_RANGE = { min: 800, max: 6000 } as const;

/**
 * The range each hand-entered macro target must fall in, as whole grams.
 *
 * The minimum is 1, not 0: the edit screen's own error copy is "Enter a carb
 * target above 0 g", so a zero must fail validation rather than save as a real
 * target of nothing.
 */
export const MANUAL_MACRO_RANGE = { min: 1, max: 1000 } as const;

/**
 * Advisory thresholds. Tripping one of these never blocks a save — the user's
 * own numbers are stored exactly as entered and returned with a 200 and a
 * warning, because the edit screen promises "Macros don't have to add up to
 * your calorie target. We won't adjust them for you."
 */
export const FEASIBILITY_THRESHOLDS = {
    /** Relative gap between the macros' energy and the calorie target. */
    macroEnergyMismatchRatio: 0.25,
    /** Calorie range the recipe catalog can realistically build a week within. */
    calorieMin: 1000,
    calorieMax: 4500,
} as const;

/** The four target fields, in wire order. Iteration order is part of the contract. */
const TARGET_FIELDS: readonly (keyof NutritionTargetValues)[] = ['calories', 'protein', 'carbs', 'fat'];

/** `TargetsResponse.revision` for a user who has no preferences row at all. */
const NO_PREFERENCES_REVISION = 0;

/* ---------------------------------------------------------------------------
 * Types
 * ------------------------------------------------------------------------- */

/**
 * The two answers the energy equation has a coefficient for.
 *
 * 'prefer_not_to_say' is a legitimate answer to the question and is deliberately
 * absent here: it produces no estimate at all rather than a guessed sex or an
 * average of the two equations. Narrowing it out at the type level means
 * `computeTargetEstimate` cannot be handed it, so the only way to reach the
 * estimate is through `resolveEstimateInputs`, which reports it as a reason.
 */
export type CalculableSex = Exclude<SexForEstimate, 'prefer_not_to_say'>;

/** Estimate inputs whose sex the equation can actually be evaluated for. */
export type CalculableEstimateInputs = Omit<TargetEstimateInputs, 'sexForEstimate'> & {
    sexForEstimate: CalculableSex;
};

/** Why no estimate could be produced, as the wire reports it. */
export type EstimateUnavailableReason = EstimateUnavailableErrorData['reason'];

/**
 * The verdict of {@link resolveEstimateInputs}. It reports rather than throws:
 * picking the status code (409 estimate_unavailable) and constructing the typed
 * error belong to the service and the controller.
 */
export type ResolvedEstimateInputs =
    | { kind: 'ready'; inputs: CalculableEstimateInputs }
    | { kind: 'unavailable'; reason: EstimateUnavailableReason };

/** What a bound did to a calculated calorie figure. */
export interface BoundedCalories {
    /** The figure to present, as a whole kcal, after every bound. */
    calories: number;
    /** True exactly when `clampReason` is non-null. */
    clamped: boolean;
    /**
     * Which bound decided the figure, or null when the user's own details
     * decided it. Non-null is what drives the user-visible "adjusted for your
     * details" caption. Every bound is judged at full precision, so a
     * shortfall of a fraction of a kcal against a bound is still that bound
     * deciding the number — see `applyTargetBounds`.
     */
    clampReason: ClampReason | null;
}

/**
 * The `meal_plan_preferences` columns the estimate reads, as stored — the seven
 * stored answers the energy equation evaluates, and the complete set of them:
 * a change to any one moves the figure {@link computeTargetEstimate} produces,
 * and a change to anything outside this shape cannot.
 *
 * Declared structurally so a Prisma row satisfies it without this module
 * importing Prisma. Every enumerated column is `string | null` because the
 * backing columns are plain TEXT with no enum and no CHECK constraint: an
 * unrecognised value is possible in principle and is treated as unusable rather
 * than coerced to a default.
 *
 * `goal_weight_kg` IS DELIBERATELY ABSENT, and it is not an oversight. It is a
 * destination the user typed, not a term in the equation — `calculateBmr` reads
 * weight, height, age and sex, `calculateTdee` the activity level, and
 * `calculateGoalAdjustment` the goal and the pace; nothing reads the goal
 * weight, so changing "I'd like to reach 170 lb" moves no target.
 */
export interface EstimateInputsRow {
    goal: string | null;
    pace_lb_per_week: number | null;
    age: number | null;
    height_cm: number | null;
    weight_kg: number | null;
    sex_for_estimate: string | null;
    activity_level: string | null;
}

/**
 * Everything {@link resolveEstimateInputs} needs to decide whether an estimate
 * may be produced AT ALL: the seven measurements above, plus the route the user
 * is actually on.
 *
 * THE ROUTE IS NOT OPTIONAL, and that is the point of the separate interface.
 * `target_route` is server-owned and written by exactly one thing — a body-step
 * save resolving it (AAP §0.5.2) — and it has two entrances to `'manual'`:
 * "Prefer not to say", which sends a COMPLETE set of measurements, and Skip,
 * which sends none and DELIBERATELY LEAVES THE PREVIOUS ONES IN PLACE. So a
 * row on the manual route can satisfy every measurement check while the user
 * has explicitly asked to type their own numbers, and an availability rule that
 * reads only the measurements will calculate — and then confirm — an estimate
 * they never asked for. Requiring the column here means that rule cannot be
 * evaluated without it.
 *
 * It is deliberately NOT a member of {@link EstimateInputsRow}: that interface
 * holds the answers that move the EQUATION. The route moves no term in the
 * equation; it decides whether the equation is asked at all.
 */
export interface EstimateAvailabilityRow extends EstimateInputsRow {
    target_route: string | null;
}

/** The four `users` columns that hold the confirmed targets. */
export interface TargetsUserRow {
    target_calories: number | null;
    target_protein_g: number | null;
    target_carbs_g: number | null;
    target_fat_g: number | null;
}

/**
 * The `meal_plan_preferences` columns that describe the targets record.
 *
 * `confirmed_targets` is `unknown` because the column is `Json?`: it is data
 * this module must inspect defensively, never a shape it may assume.
 *
 * TWO REVISIONS ARE HERE AND THEY ARE NOT INTERCHANGEABLE. `targets_revision`
 * is the optimistic-concurrency token for the targets RECORD — what a client
 * pins on `PUT /meal-planning/targets` and what `TargetsResponse.revision`
 * reports. `revision` is the PREFERENCES counter, which advances on every
 * preference save, and it is the one staleness is judged against: AAP §0.5.2
 * defines `stale` as `targets_input_revision ≠ preferences.revision`, and
 * §0.5.1 defines `targets_input_revision` as "the `revision` whose
 * goal/body/activity/pace produced the confirmed estimate". So the pair is a
 * single ancestry check — the preferences revision the confirmed figure was
 * computed at, against the preferences revision the row is at now — and both
 * halves must read the same counter or a confirmed estimate can claim an
 * ancestry it does not have. `estimateRevision` on the save envelope pins the
 * same `revision`, which is why the number recorded here and the number the
 * wire check compares are one and the same.
 */
export interface TargetsPreferencesRow {
    target_source: string | null;
    targets_revision: number;
    confirmed_targets: unknown;
    /** The preferences `revision` the confirmed estimate was computed at. */
    targets_input_revision: number | null;
    /** The preferences counter, advanced by every preference save. */
    revision: number;
}

/**
 * The wire vocabulary for a manual-target `details[].code`. The client maps each
 * code to its own copy, which is why no prose appears here:
 *  - `required` — the field is absent or null.
 *  - `invalid_type` — present but not a finite JSON number.
 *  - `not_an_integer` — a finite number with a fractional part.
 *  - `below_minimum` — under the field's minimum. A macro of 0 is this code,
 *    and it is what the edit screen renders as "Enter a carb target above 0 g".
 *  - `above_maximum` — over the field's maximum.
 *  - `unknown_field` — a key the save envelope does not accept for the `source`
 *    it declared, which includes a key that is only legal on the OTHER arm (see
 *    {@link parseSaveTargetsRequest}). Spelt as `plannedMealLog.logic.ts` and
 *    `swap.logic.ts` spell the same condition, and deliberately not
 *    `preferences.logic.ts`'s `read_only_field`, which names a server-owned
 *    field rather than an unrecognised one.
 */
export const MANUAL_TARGET_FIELD_CODES = {
    REQUIRED: 'required',
    INVALID_TYPE: 'invalid_type',
    NOT_AN_INTEGER: 'not_an_integer',
    BELOW_MINIMUM: 'below_minimum',
    ABOVE_MAXIMUM: 'above_maximum',
    UNKNOWN_FIELD: 'unknown_field',
} as const;

type ManualTargetFieldCode = (typeof MANUAL_TARGET_FIELD_CODES)[keyof typeof MANUAL_TARGET_FIELD_CODES];

/**
 * The verdict of {@link parseManualTargets}. The error variant carries one
 * detail per offending field so the edit screen can show every inline message
 * at once, which is what its validate-on-press behaviour requires. It is a
 * returned value rather than a thrown error for the same reason: a field-level
 * message is data the client renders, not an exception.
 */
export type ParsedManualTargets =
    | { kind: 'valid'; values: MealPlanMacroTotals }
    | { kind: 'error'; code: 'invalid_request'; message: string; details: InvalidRequestDetail[] };

/* ---------------------------------------------------------------------------
 * The estimate
 * ------------------------------------------------------------------------- */

/**
 * Resting energy expenditure in kcal/day, at full precision.
 *
 * The result is deliberately NOT rounded: it feeds the activity factor, and
 * rounding here moves the final target (see the rounding note at the top of the
 * file). Round it only where it is presented.
 */
export const calculateBmr = (
    sexForEstimate: CalculableSex,
    weightKg: number,
    heightCm: number,
    age: number,
): number =>
    BMR_WEIGHT_COEFFICIENT * weightKg +
    BMR_HEIGHT_COEFFICIENT * heightCm -
    BMR_AGE_COEFFICIENT * age +
    BMR_SEX_CONSTANT[sexForEstimate];

/**
 * Total daily energy expenditure: the basal rate times the activity factor,
 * applied exactly once. Logged workouts and runs are never added on top of the
 * result — the factor already accounts for the user's usual training.
 */
export const calculateTdee = (bmr: number, activityLevel: ActivityLevel): number =>
    bmr * ACTIVITY_FACTORS[activityLevel];

/**
 * The daily kcal offset that turns maintenance into the user's goal: negative
 * for loss, positive for gain, zero for maintenance.
 *
 * The sign is the whole point of the function — inverting it would quietly turn
 * every weight-loss plan into a gain plan and vice versa — so both directions
 * are pinned by tests at all three paces.
 *
 * A null pace yields no adjustment. That arm exists for 'maintain', which
 * carries no pace by contract; a 'lose' or 'gain' row with no stored pace never
 * reaches it, because {@link resolveEstimateInputs} refuses such a row with
 * `missing_inputs` rather than letting it read as maintenance.
 */
export const calculateGoalAdjustment = (goal: Goal, paceLbPerWeek: PaceLbPerWeek | null): number => {
    if (goal === 'maintain' || paceLbPerWeek === null) {
        return NO_GOAL_ADJUSTMENT;
    }

    const magnitude = KCAL_PER_POUND_PER_WEEK_PER_DAY * paceLbPerWeek;

    return goal === 'lose' ? -magnitude : magnitude;
};

/**
 * Applies the product's calorie bounds and reports which one moved the figure.
 *
 * THE FLOOR APPLIES TO EVERY GOAL. It is tempting to gate it on weight loss,
 * because that is where it usually binds, but maintenance binds it too at the
 * low corner of the supported envelope: a 30 kg, 120 cm, 100-year-old female
 * has a 389 kcal basal rate and a 467 kcal maintenance rate, and a loss-only
 * floor would present 467 kcal as her daily target. The clamp is therefore
 * unconditional.
 *
 * Both lower bounds are applied, the higher of the two winning, and the reason
 * names whichever it was: the user's own basal rate when that exceeds the sex
 * floor (`below_bmr`), otherwise the floor (`floor`). When the two are exactly
 * equal the reason is `floor`, because the sex floor is the app's own published
 * minimum and attributing the clamp to policy rather than to the user's
 * physiology is the claim that always holds.
 *
 * The ceiling is applied last, as an absolute cap: if it moves the figure the
 * reason is `ceiling` whatever raised it, so the reported reason is always the
 * bound that actually decided the presented number. Within the supported
 * envelope the highest possible basal rate is 4477.5 kcal, so the ceiling and
 * the lower bounds cannot both bind; applying it last keeps the function total
 * if that ever changes.
 *
 * EVERY BOUND IS COMPARED AT FULL PRECISION and the rounding is the last step:
 * the bounds are `max(adjusted, sex floor, basal rate)` capped by the ceiling,
 * taken against the unrounded adjusted value and the unrounded basal rate, and
 * only the surviving figure is rounded to the whole kcal the app presents. A
 * pre-rounded comparison would let a 1199.6 kcal result read as satisfying a
 * 1200 kcal floor it does not satisfy.
 *
 * The rule is uniform across the three bounds — a shortfall of a fraction of a
 * kcal is still a bound deciding the presented number rather than the user's
 * details, so 1199.6 against the female floor reports `floor` at 1200 kcal and
 * 1606 against a 1606.25 kcal basal rate reports `below_bmr` at 1606 kcal. That
 * is what `clamped` claims: a bound, not your details, decided this number,
 * which is exactly what the "adjusted for your details" caption says. It has
 * never claimed the difference is large enough to see, and no bound gets a
 * visibility threshold the other two do not.
 */
export const applyTargetBounds = (
    adjustedCalories: number,
    bmr: number,
    sexForEstimate: CalculableSex,
): BoundedCalories => {
    const sexFloor = CALORIE_FLOOR_BY_SEX[sexForEstimate];

    const raised = Math.max(adjustedCalories, sexFloor, bmr);
    const bounded = Math.min(raised, CALORIE_CEILING);

    const clampReason = resolveClampReason(adjustedCalories, raised, bounded, sexFloor, bmr);

    return { calories: Math.round(bounded), clamped: clampReason !== null, clampReason };
};

const resolveClampReason = (
    adjustedCalories: number,
    raised: number,
    bounded: number,
    sexFloor: number,
    bmr: number,
): ClampReason | null => {
    if (bounded < raised) {
        return 'ceiling';
    }

    if (raised > adjustedCalories) {
        return bmr > sexFloor ? 'below_bmr' : 'floor';
    }

    return null;
};

/**
 * Splits a confirmed calorie figure into macro grams, echoing the calorie value
 * back so the four numbers a caller renders always come from one derivation and
 * cannot drift apart.
 *
 * Grams are derived from the FINAL, bounded figure: a target clamped up to
 * 1200 kcal must produce 1200 kcal worth of macros (90 g / 120 g / 40 g), not
 * the macros of the number the arithmetic first produced.
 */
export const deriveMacroTargets = (calories: number): MealPlanMacroTotals => ({
    calories,
    protein: Math.round((calories * MACRO_ENERGY_SHARES.protein) / KCAL_PER_GRAM.protein),
    carbs: Math.round((calories * MACRO_ENERGY_SHARES.carbs) / KCAL_PER_GRAM.carbs),
    fat: Math.round((calories * MACRO_ENERGY_SHARES.fat) / KCAL_PER_GRAM.fat),
});

/* ---------------------------------------------------------------------------
 * Stored-value guards
 *
 * Every enumerated preference column is plain TEXT, so these guards are the
 * only thing standing between a misspelled or unrecognised stored value and a
 * silently defaulted factor. They are exhaustive over the closed vocabularies
 * in src/types/mealPlanning.ts.
 * ------------------------------------------------------------------------- */

const isCalculableSex = (value: unknown): value is CalculableSex => value === 'female' || value === 'male';

const isGoal = (value: unknown): value is Goal =>
    value === 'lose' || value === 'maintain' || value === 'gain';

const isActivityLevel = (value: unknown): value is ActivityLevel =>
    value === 'not_very_active' || value === 'lightly_active' || value === 'active' || value === 'very_active';

const isPaceLbPerWeek = (value: unknown): value is PaceLbPerWeek =>
    value === 0.5 || value === 1 || value === 1.5;

const isTargetRoute = (value: unknown): value is Extract<TargetSource, 'estimated' | 'manual'> =>
    value === 'estimated' || value === 'manual';

const isInRange = (value: unknown, range: { min: number; max: number }): value is number =>
    typeof value === 'number' && Number.isFinite(value) && value >= range.min && value <= range.max;

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : null;

/**
 * Decides whether the stored preferences support an estimate, and reports why
 * not when they do not.
 *
 * 'prefer_not_to_say' is checked first and reported as itself. It is an
 * intentional answer that routes the user to manual entry, so it must not be
 * masked by an unrelated gap such as a missing height — or by the manual route
 * that same answer put the user on — because the two reasons lead to the same
 * screen but only one of them is the user's own choice.
 *
 * THE PERSISTED ROUTE IS THEN DECISIVE, whatever the measurements say. A
 * `target_route` of 'manual' is the user having chosen to type their own
 * numbers, and the row can still carry a complete set of measurements when they
 * chose it: Skip sends no measurements and leaves the previous ones in place
 * (AAP §0.5.2's `{skipped: true}` body payload), so "the columns are all
 * populated" says nothing about whether an estimate was asked for. Reading the
 * measurements alone is how a user who pressed Skip would be shown — and, on
 * `PUT /meal-planning/targets`, have CONFIRMED — a calculated figure they
 * declined. The reason is `missing_inputs` rather than a route-specific code,
 * because the wire vocabulary has exactly two reasons (§0.5.2) and both send
 * the client to the same manual-entry screen; `prefer_not_to_say` is reserved
 * for the answer itself, which the check above has already reported.
 *
 * A route column that is neither 'manual' nor 'estimated' and not null is a
 * corrupt row — the only writer sets one of the two — and is refused for the
 * same reason an out-of-envelope measurement is: we cannot tell which route the
 * user is on, so we must not calculate one for them. A NULL route is the body
 * step being unanswered, which is not a refusal in itself; the measurement
 * checks below then decide, and they refuse an unanswered body step anyway.
 *
 * An input outside the supported envelope is reported as unusable rather than
 * clamped into range: `preferences.logic.ts` rejects such a value with a 400 at
 * write time, so encountering one here means the row is corrupt, and clamping
 * would present a number the user's own details do not support. A non-integer
 * age is treated the same way for the same reason.
 *
 * A 'lose' or 'gain' row with no usable pace is likewise unusable. Reading it as
 * maintenance would show a maintenance target on a weight-loss plan, which is
 * the one failure this check exists to prevent.
 */
export const resolveEstimateInputs = (row: EstimateAvailabilityRow): ResolvedEstimateInputs => {
    if (row.sex_for_estimate === 'prefer_not_to_say') {
        return { kind: 'unavailable', reason: 'prefer_not_to_say' };
    }

    if (row.target_route !== null && row.target_route !== 'estimated') {
        return { kind: 'unavailable', reason: 'missing_inputs' };
    }

    if (!isCalculableSex(row.sex_for_estimate) || !isActivityLevel(row.activity_level) || !isGoal(row.goal)) {
        return { kind: 'unavailable', reason: 'missing_inputs' };
    }

    if (
        !isInRange(row.age, ESTIMATE_INPUT_RANGES.age) ||
        !Number.isInteger(row.age) ||
        !isInRange(row.height_cm, ESTIMATE_INPUT_RANGES.heightCm) ||
        !isInRange(row.weight_kg, ESTIMATE_INPUT_RANGES.weightKg)
    ) {
        return { kind: 'unavailable', reason: 'missing_inputs' };
    }

    const paceLbPerWeek = resolvePace(row.goal, row.pace_lb_per_week);
    if (paceLbPerWeek === 'unusable') {
        return { kind: 'unavailable', reason: 'missing_inputs' };
    }

    return {
        kind: 'ready',
        inputs: {
            age: row.age,
            heightCm: row.height_cm,
            weightKg: row.weight_kg,
            sexForEstimate: row.sex_for_estimate,
            activityLevel: row.activity_level,
            goal: row.goal,
            paceLbPerWeek,
        },
    };
};

/**
 * 'maintain' carries no pace, so a stored one is ignored rather than treated as
 * a contradiction — the goal alone determines that the adjustment is zero.
 */
const resolvePace = (goal: Goal, storedPace: number | null): PaceLbPerWeek | null | 'unusable' => {
    if (goal === 'maintain') {
        return null;
    }

    return isPaceLbPerWeek(storedPace) ? storedPace : 'unusable';
};

/**
 * The full calculated estimate, recomputed from stored preferences on every
 * read and never persisted by reading.
 *
 * `estimateRevision` is the preferences revision the inputs came from, echoed
 * so the save can refuse an estimate computed from inputs that have since
 * changed. The basal and maintenance rates are rounded here, where they are
 * presented, having been carried at full precision through the derivation.
 *
 * The inputs are copied into the response rather than aliased, so a later
 * mutation of the caller's object cannot change what the response says it was
 * computed from.
 */
export const computeTargetEstimate = (
    inputs: CalculableEstimateInputs,
    estimateRevision: number,
): TargetEstimateResponse => {
    const bmr = calculateBmr(inputs.sexForEstimate, inputs.weightKg, inputs.heightCm, inputs.age);
    const tdee = calculateTdee(bmr, inputs.activityLevel);
    const adjustment = calculateGoalAdjustment(inputs.goal, inputs.paceLbPerWeek);
    const bounded = applyTargetBounds(tdee + adjustment, bmr, inputs.sexForEstimate);
    const targets = deriveMacroTargets(bounded.calories);

    return {
        source: 'estimated',
        estimateRevision,
        inputs: {
            age: inputs.age,
            heightCm: inputs.heightCm,
            weightKg: inputs.weightKg,
            sexForEstimate: inputs.sexForEstimate,
            activityLevel: inputs.activityLevel,
            goal: inputs.goal,
            paceLbPerWeek: inputs.paceLbPerWeek,
        },
        bmr: Math.round(bmr),
        tdee: Math.round(tdee),
        adjustment,
        calories: targets.calories,
        protein: targets.protein,
        carbs: targets.carbs,
        fat: targets.fat,
        clamped: bounded.clamped,
        clampReason: bounded.clampReason,
    };
};

/**
 * The same estimate as the record `meal_plan_preferences.estimated_targets`
 * keeps — AAP §0.5.1's "last estimate with input revision".
 *
 * WHY THE STORED SHAPE IS BUILT HERE AND NOT ASSIGNED FROM THE RESPONSE. A
 * stored row outlives every response shape around it, so writing the estimate
 * response straight into the column would let a later change to that response
 * — a member added, renamed or dropped — silently change what new rows contain
 * while the rows already written stay as they were. This function is the one
 * place the stored shape is decided, so a wire change that should not reach
 * storage stops compiling here instead of arriving unnoticed in the database.
 * It is also what makes the stored record testable without a database, which is
 * the only way to assert the exact JSON a confirmation leaves behind.
 *
 * TWO FIELDS DIFFER FROM THE RESPONSE, both deliberately. `source` is dropped:
 * the column name is the discriminator, and a stored literal with one possible
 * value records nothing. And `estimateRevision` is stored as `inputRevision`,
 * which is what the number means once it is at rest — the preferences revision
 * whose goal, body, activity and pace produced this figure. It is the same
 * number `targets_input_revision` records as the confirmed figure's ancestry
 * (see {@link deriveTargetsResponse}), so a later reader can compare the stored
 * estimate with the current `revision` and see whether it still describes the
 * answers on file.
 *
 * THE CLAMP TRAVELS WITH IT. `clamped` and `clampReason` are part of the
 * estimate rather than presentation: a figure that a floor or the ceiling moved
 * is a different fact about the user's details from one nothing bound, and this
 * record is the only place that fact survives the confirmation — the four
 * confirmed values alone cannot say whether a bound produced them.
 *
 * Pure, total and branchless: every member is copied, nothing is recomputed,
 * and the inputs are copied rather than aliased so a later mutation of the
 * caller's estimate cannot change what was stored.
 */
export const buildStoredEstimate = (estimate: TargetEstimateResponse): StoredEstimateSnapshot => ({
    inputRevision: estimate.estimateRevision,
    inputs: {
        age: estimate.inputs.age,
        heightCm: estimate.inputs.heightCm,
        weightKg: estimate.inputs.weightKg,
        sexForEstimate: estimate.inputs.sexForEstimate,
        activityLevel: estimate.inputs.activityLevel,
        goal: estimate.inputs.goal,
        paceLbPerWeek: estimate.inputs.paceLbPerWeek,
    },
    bmr: estimate.bmr,
    tdee: estimate.tdee,
    adjustment: estimate.adjustment,
    calories: estimate.calories,
    protein: estimate.protein,
    carbs: estimate.carbs,
    fat: estimate.fat,
    clamped: estimate.clamped,
    clampReason: estimate.clampReason,
});

/* ---------------------------------------------------------------------------
 * Manual targets
 * ------------------------------------------------------------------------- */

const manualTargetsError = (details: InvalidRequestDetail[]): ParsedManualTargets => ({
    kind: 'error',
    code: 'invalid_request',
    // A server-side diagnostic naming every offending field and its code. The
    // client renders `details`, never this string.
    message: `invalid manual targets: ${details
        .map((detail) => `${detail.field} (${detail.code})`)
        .join(', ')}`,
    details,
});

/**
 * One field's outcome: the accepted whole number, or the code describing why it
 * was refused. The two are distinguishable by `typeof`, which is what lets the
 * caller narrow all four fields at once.
 */
const parseManualField = (
    value: unknown,
    range: { min: number; max: number },
): number | ManualTargetFieldCode => {
    if (value === undefined || value === null) {
        return MANUAL_TARGET_FIELD_CODES.REQUIRED;
    }

    // The wire contract declares these as JSON numbers, so a numeric string is
    // refused rather than coerced: "1,940" would otherwise become NaN and a
    // silent coercion is not worth the ambiguity.
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return MANUAL_TARGET_FIELD_CODES.INVALID_TYPE;
    }

    if (!Number.isInteger(value)) {
        return MANUAL_TARGET_FIELD_CODES.NOT_AN_INTEGER;
    }

    if (value < range.min) {
        return MANUAL_TARGET_FIELD_CODES.BELOW_MINIMUM;
    }

    if (value > range.max) {
        return MANUAL_TARGET_FIELD_CODES.ABOVE_MAXIMUM;
    }

    return value;
};

/**
 * Validates a hand-entered target body and returns the four values EXACTLY as
 * entered.
 *
 * Nothing is rebalanced to make the macros add up to the calorie figure. The
 * edit screen promises in so many words that "Macros don't have to add up to
 * your calorie target. We won't adjust them for you", so adjusting them would
 * break a stated promise; a mismatch is reported by {@link assessFeasibility}
 * as an advisory warning instead, and the save still succeeds.
 *
 * Every offending field is reported in one verdict, in wire order, because the
 * screen validates on press and shows all of its inline messages at once.
 */
export const parseManualTargets = (body: unknown): ParsedManualTargets => {
    const record = asRecord(body);

    if (record === null) {
        return manualTargetsError(
            TARGET_FIELDS.map((field) => ({ field, code: MANUAL_TARGET_FIELD_CODES.REQUIRED })),
        );
    }

    const calories = parseManualField(record.calories, MANUAL_CALORIE_RANGE);
    const protein = parseManualField(record.protein, MANUAL_MACRO_RANGE);
    const carbs = parseManualField(record.carbs, MANUAL_MACRO_RANGE);
    const fat = parseManualField(record.fat, MANUAL_MACRO_RANGE);

    if (
        typeof calories !== 'number' ||
        typeof protein !== 'number' ||
        typeof carbs !== 'number' ||
        typeof fat !== 'number'
    ) {
        const details: InvalidRequestDetail[] = [];

        if (typeof calories !== 'number') details.push({ field: 'calories', code: calories });
        if (typeof protein !== 'number') details.push({ field: 'protein', code: protein });
        if (typeof carbs !== 'number') details.push({ field: 'carbs', code: carbs });
        if (typeof fat !== 'number') details.push({ field: 'fat', code: fat });

        return manualTargetsError(details);
    }

    return { kind: 'valid', values: { calories, protein, carbs, fat } };
};

/* ---------------------------------------------------------------------------
 * PUT /meal-planning/targets — the envelope
 *
 * The request parser for the save route, in the pure layer the
 * `backend-architecture` rule puts every parser in (§2): synchronous, returning
 * a verdict rather than throwing, reporting every offending field in one
 * answer, and naming no HTTP status code. `targets.service.ts` calls
 * {@link parseSaveTargetsRequest} and returns its refusal verbatim.
 *
 * {@link parseManualTargets} above already owns the four manual VALUES and is
 * called rather than re-implemented; what is added here is only the envelope
 * around them: which of the two shapes was sent, the estimate revision the
 * estimated shape pins, and the targets revision both shapes pin.
 * ------------------------------------------------------------------------- */

/** The two sources the envelope may declare, as a closed set keyed off the DTO union. */
export const TARGET_SOURCES: Readonly<Record<TargetRoute, true>> = { estimated: true, manual: true };

/**
 * Every key the ESTIMATED shape accepts (AAP §0.5.2:
 * `{source, estimateRevision, expectedTargetsRevision}`) — and therefore, by
 * omission, the definition of an unknown one on that arm.
 *
 * Keyed off `SaveEstimatedTargetsPayload` rather than written out as strings,
 * so a member added to the wire DTO fails to compile here until this parser
 * decides what to do with it. `expectedTargetsRevision` is optional on the DTO
 * and still a key of the shape: it may be omitted, never renamed.
 */
export const ESTIMATED_SAVE_KEYS: Readonly<Record<keyof SaveEstimatedTargetsPayload, true>> = {
    source: true,
    estimateRevision: true,
    expectedTargetsRevision: true,
};

/**
 * Every key the MANUAL shape accepts (AAP §0.5.2:
 * `{source, calories, protein, carbs, fat, expectedTargetsRevision}`), keyed
 * off `SaveManualTargetsPayload` for the same reason.
 *
 * `estimateRevision` is absent deliberately: nothing was recomputed, so there
 * are no inputs to pin, and a body that pins some is describing the other
 * shape.
 */
export const MANUAL_SAVE_KEYS: Readonly<Record<keyof SaveManualTargetsPayload, true>> = {
    source: true,
    calories: true,
    protein: true,
    carbs: true,
    fat: true,
    expectedTargetsRevision: true,
};

/** Confirming the server-calculated estimate: the client never sends the numbers. */
export interface EstimatedSaveRequest {
    source: 'estimated';
    /** The preferences revision the displayed estimate was computed from. */
    estimateRevision: number;
    /** null when the body pinned no targets revision, which is legal only before the first save. */
    expectedTargetsRevision: number | null;
}

/** Hand-entered targets, stored exactly as given. */
export interface ManualSaveRequest {
    source: 'manual';
    values: MealPlanMacroTotals;
    expectedTargetsRevision: number | null;
}

export type SaveTargetsRequest = EstimatedSaveRequest | ManualSaveRequest;

/** The refusal shape both this parser and `targets.service.ts::SaveTargetsResult` carry. */
export interface TargetsErrorVerdict {
    kind: 'error';
    code: 'invalid_request';
    message: string;
    details: InvalidRequestDetail[];
}

export type ParsedSaveTargets = { kind: 'ok'; request: SaveTargetsRequest } | TargetsErrorVerdict;

const invalidRequest = (details: InvalidRequestDetail[]): TargetsErrorVerdict => ({
    kind: 'error',
    code: 'invalid_request',
    // A server-side diagnostic naming every offending field, in the same shape
    // {@link parseManualTargets} produces. The client renders `details`, never
    // this string.
    message: `invalid targets request: ${details
        .map((detail) => `${detail.field} (${detail.code})`)
        .join(', ')}`,
    details,
});

/**
 * One optional revision field: absent, or a whole number that is not negative
 * and that a revision column can actually hold.
 *
 * Absent is reported as `null` rather than as a failure, because "no revision
 * pinned" is legal before the first save; whether it is legal THIS time depends
 * on the stored revision, which no pure parser can know, so that half of the
 * rule is applied under the lock in `targets.service.ts::saveTargets`.
 */
export const parseOptionalRevision = (
    value: unknown,
    field: string,
): { revision: number | null } | InvalidRequestDetail => {
    if (value === undefined || value === null) {
        return { revision: null };
    }

    if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { field, code: MANUAL_TARGET_FIELD_CODES.INVALID_TYPE };
    }

    if (!Number.isInteger(value)) {
        return { field, code: MANUAL_TARGET_FIELD_CODES.NOT_AN_INTEGER };
    }

    if (value < 0) {
        return { field, code: MANUAL_TARGET_FIELD_CODES.BELOW_MINIMUM };
    }

    // The integer check above is not sufficient on its own: `Number.isInteger`
    // is true for `1e30`, a whole number that is neither exactly representable
    // nor storable in the PostgreSQL `integer` column revisions live in. Both
    // halves are one bound, spelt as `preferences.logic.ts` spells it — above
    // `MAX_REVISION` no column can hold the value, and above
    // `Number.MAX_SAFE_INTEGER` the comparison against a stored revision would
    // itself be unsound. Left unchecked, such a value reaches
    // `buildRequestFingerprint`, which refuses it with a TypeError — a 500 for
    // what is plainly a malformed request.
    if (!Number.isSafeInteger(value) || value > MAX_REVISION) {
        return { field, code: MANUAL_TARGET_FIELD_CODES.ABOVE_MAXIMUM };
    }

    return { revision: value };
};

/** The same field, required — the estimated shape cannot be judged without it. */
export const parseRequiredRevision = (value: unknown, field: string): number | InvalidRequestDetail => {
    if (value === undefined || value === null) {
        return { field, code: MANUAL_TARGET_FIELD_CODES.REQUIRED };
    }

    const parsed = parseOptionalRevision(value, field);

    return 'revision' in parsed ? (parsed.revision as number) : parsed;
};

/**
 * Validates the save envelope and reports every problem in one verdict.
 *
 * `source` is judged first and alone when it is unusable: the two shapes have
 * different required fields, so reporting "calories is required" for a body
 * whose `source` is misspelled would describe a shape the client never meant to
 * send. It is also why the key check below runs only after an arm is
 * established — an unusable `source` names no arm, and therefore says nothing
 * about which keys are legal.
 *
 * THE ARM'S SHAPE IS EXACT, AND A KEY OUTSIDE IT IS REFUSED RATHER THAN
 * DROPPED. Accepting a body and ignoring part of it lets a client believe a
 * value it sent was honoured, and on the estimated arm that is the damaging
 * case: `{source: 'estimated', estimateRevision, calories: 9999}` would be
 * stored with whatever the server recomputes, so a client that believed it was
 * confirming the numbers it sent gets different ones with no signal that its
 * `calories` was never read. A key that is legal only on the OTHER arm is
 * reported the same way — for the shape the client declared it is simply not a
 * key of the contract. This is the reasoning
 * `plannedMealLog.logic.ts::parseLogPlannedMealRequest` applies to `mealName`,
 * and the code is spelt the same (`unknown_field`).
 *
 * Unknown keys are collected into the SAME verdict as the field errors, in body
 * order and after them, so one round trip tells the client everything that is
 * wrong with its request.
 */
export const parseSaveTargetsRequest = (body: unknown): ParsedSaveTargets => {
    const record = asRecord(body);

    if (record === null) {
        return invalidRequest([{ field: 'body', code: MANUAL_TARGET_FIELD_CODES.INVALID_TYPE }]);
    }

    const source = record.source;

    if (source === undefined || source === null) {
        return invalidRequest([{ field: 'source', code: MANUAL_TARGET_FIELD_CODES.REQUIRED }]);
    }

    if (typeof source !== 'string' || !Object.prototype.hasOwnProperty.call(TARGET_SOURCES, source)) {
        // The same spelling every other parser in this feature uses for a value
        // outside a closed set, imported rather than restated so the client maps
        // one code.
        return invalidRequest([{ field: 'source', code: PREFERENCE_FIELD_CODES.UNKNOWN_VALUE }]);
    }

    const details: InvalidRequestDetail[] = [];
    const expected = parseOptionalRevision(record.expectedTargetsRevision, 'expectedTargetsRevision');

    if (!('revision' in expected)) {
        details.push(expected);
    }

    // Every own key of the body that the declared arm does not accept. Held
    // aside rather than pushed here so both arms report their own field
    // problems first and these last, which is the order the other parsers in
    // this layer report them in.
    const acceptedKeys: Readonly<Record<string, true>> =
        source === 'manual' ? MANUAL_SAVE_KEYS : ESTIMATED_SAVE_KEYS;
    const unknownFieldDetails: InvalidRequestDetail[] = Object.keys(record)
        .filter((key) => !Object.prototype.hasOwnProperty.call(acceptedKeys, key))
        .map((field) => ({ field, code: MANUAL_TARGET_FIELD_CODES.UNKNOWN_FIELD }));

    if (source === 'manual') {
        // Called with the whole record on purpose: {@link parseManualTargets}
        // reads only the four value keys and is used on its own elsewhere, so
        // the envelope's own keys are this parser's business, not its.
        const values = parseManualTargets(record);

        if (values.kind !== 'valid') {
            details.push(...values.details);
        }

        details.push(...unknownFieldDetails);

        if (details.length > 0 || values.kind !== 'valid') {
            return invalidRequest(details);
        }

        return {
            kind: 'ok',
            request: {
                source: 'manual',
                values: values.values,
                expectedTargetsRevision: (expected as { revision: number | null }).revision,
            },
        };
    }

    const estimateRevision = parseRequiredRevision(record.estimateRevision, 'estimateRevision');

    if (typeof estimateRevision !== 'number') {
        details.push(estimateRevision);
    }

    details.push(...unknownFieldDetails);

    if (details.length > 0 || typeof estimateRevision !== 'number') {
        return invalidRequest(details);
    }

    return {
        kind: 'ok',
        request: {
            source: 'estimated',
            estimateRevision,
            expectedTargetsRevision: (expected as { revision: number | null }).revision,
        },
    };
};

/**
 * Advisory assessment of a set of targets. Every warning accompanies a
 * successful 200 and a stored value — there is no rejection on this route, and
 * `ok: false` means "we have something to tell you about these numbers", never
 * "we refused them".
 *
 * Warnings are emitted in the order their codes are declared, so the array is
 * deterministic. The two calorie warnings are mutually exclusive by
 * construction.
 */
export const assessFeasibility = (values: MealPlanMacroTotals): TargetsFeasibility => {
    const warnings: FeasibilityWarning[] = [];

    const macroEnergy =
        values.protein * KCAL_PER_GRAM.protein +
        values.carbs * KCAL_PER_GRAM.carbs +
        values.fat * KCAL_PER_GRAM.fat;
    const tolerance = FEASIBILITY_THRESHOLDS.macroEnergyMismatchRatio * values.calories;

    if (Math.abs(macroEnergy - values.calories) > tolerance) {
        warnings.push('macro_energy_mismatch');
    }

    if (values.calories < FEASIBILITY_THRESHOLDS.calorieMin) {
        warnings.push('below_catalog_min');
    }

    if (values.calories > FEASIBILITY_THRESHOLDS.calorieMax) {
        warnings.push('above_catalog_max');
    }

    return { ok: warnings.length === 0, warnings };
};

/* ---------------------------------------------------------------------------
 * PUT /meal-planning/targets — the manual route's setup stop
 * ------------------------------------------------------------------------- */

/**
 * The two server-owned setup columns a target save advances, as the row spells
 * them.
 *
 * Snake_case because these are columns rather than a wire shape: the service
 * spreads them straight into the statement that stores the confirmed targets,
 * and naming them anything else would need a mapping layer for two values whose
 * only consumer is that one UPDATE.
 */
export interface ManualSetupAdvance {
    setup_step: SetupStep;
    setup_status: SetupStatus;
}

/**
 * Where setup stands after a MANUAL target confirmation — or nothing at all,
 * which is the answer for every other way this route is reached.
 *
 * WHY A TARGET SAVE MOVES THE RESUME MARKER AT ALL. `targets_manual` is a stop
 * on the manual route's wizard (`MANUAL_ROUTE_ORDER`), and it is the only stop
 * that does not save as a setup step: the manual target screen commits through
 * `PUT /meal-planning/targets` (AAP §0.7.4), so no
 * `PUT /meal-planning/preferences/steps/:step` request can ever answer it. If
 * this save leaves the marker alone, nothing does — a user who force-quits
 * after saving their targets resumes on the target editor they just completed
 * instead of on Diet, and the manual route stalls there.
 *
 * THE TRANSITION IS NOT DECIDED HERE. `nextSetupState` owns sequential
 * progress, the monotonic status rule and the pull-back to a provably
 * unanswered step, and it is handed `targets_manual` as the step just answered
 * — which its own `isCurrentStop` already recognises as a stop a step save
 * cannot reach. Naming the successor as a literal would fork that decision in
 * two, and the fork would be invisible until someone reordered the route.
 *
 * EVERY GUARD IS A STATE THIS ROUTE REALLY REACHES, and each one must write
 * nothing:
 *
 *  * NO ROW. A user editing targets from Account before any onboarding: the row
 *    the save creates is `not_started` with no marker, and advancing it would
 *    invent onboarding progress from a target edit.
 *  * AN ESTIMATED CONFIRMATION. `ESTIMATED_ROUTE_ORDER` goes body → activity →
 *    diet and has no target stop at all: that route confirms its figure on the
 *    Review screen as the first step of generating (AAP §0.7.4), which is not a
 *    wizard stop and earns no progress. The estimated arm also refuses a
 *    manual-route row outright (`resolveEstimateInputs`), so a row bearing this
 *    marker cannot reach a successful estimated save — the guard states the
 *    rule rather than relying on that.
 *  * `not_started`. The Account-only row again, on its second and later saves.
 *  * `ready_for_review` or `completed`. The user has finished the wizard (and,
 *    when completed, has a published week): this is the plan-settings target
 *    editor, and awarding wizard progress there is precisely the regression the
 *    state machine's monotonic status rule exists to prevent.
 *  * A NON-MANUAL `target_route`. A row that has moved back to the estimated
 *    route since the marker was written; its stops are the estimated ones.
 *  * A MARKER THAT IS NOT `targets_manual`. Either an edit-mode re-save from
 *    later in the wizard, or a row already past the target screen — the stop
 *    has been answered once and progress is not earned twice.
 */
export const resolveManualTargetSetupAdvance = (
    stored: SetupStateSnapshot | null,
    source: TargetRoute,
): ManualSetupAdvance | null => {
    if (
        stored === null ||
        source !== 'manual' ||
        stored.setupStatus !== 'in_progress' ||
        stored.targetRoute !== 'manual' ||
        stored.setupStep !== 'targets_manual'
    ) {
        return null;
    }

    const transition = nextSetupState(stored, 'targets_manual', 'manual');

    return { setup_step: transition.setupStep, setup_status: transition.setupStatus };
};

/* ---------------------------------------------------------------------------
 * The canonical read — the truth rules five surfaces depend on
 * ------------------------------------------------------------------------- */

/**
 * Whether the confirmed snapshot still describes the stored targets.
 *
 * This comparison is why the `legacy` source exists. `PUT /api/user/targets`
 * stays untouched for API compatibility and never bumps the targets revision,
 * so a pre-existing integration or an older client can change
 * `users.target_*` after a confirmation without leaving any other trace. The
 * snapshot written at confirmation time is the only record of what was
 * confirmed, so comparing against it is how this read stays truthful without
 * breaking those callers. It detects; it never migrates or overwrites.
 *
 * All four confirmed values must be finite numbers that equal the stored ones.
 * A partially populated account therefore cannot match — and correctly so,
 * since the canonical writer only ever confirms all four at once, so anything
 * incomplete was written by something else.
 */
const confirmedSnapshotMatches = (confirmedTargets: unknown, values: NutritionTargetValues): boolean => {
    const snapshot = asRecord(confirmedTargets);

    if (snapshot === null) {
        return false;
    }

    return TARGET_FIELDS.every((field) => {
        const confirmed = snapshot[field];

        return typeof confirmed === 'number' && Number.isFinite(confirmed) && values[field] === confirmed;
    });
};

/**
 * Which route the stored targets can be attributed to.
 *
 * Anything that cannot be attributed is `legacy`: no preferences row, a route
 * column that does not name one of the two known routes, or a snapshot that no
 * longer matches. An unrecognised route column is a genuinely inconsistent row
 * — the canonical writer sets the route, the snapshot and the revision in one
 * transaction — and `legacy` is the honest answer, because the one thing we
 * cannot do is attest to a route we have no record of.
 */
const resolveTargetSource = (
    values: NutritionTargetValues,
    preferencesRow: TargetsPreferencesRow | null,
): TargetSource => {
    if (preferencesRow === null) {
        return 'legacy';
    }

    if (!isTargetRoute(preferencesRow.target_source)) {
        return 'legacy';
    }

    return confirmedSnapshotMatches(preferencesRow.confirmed_targets, values)
        ? preferencesRow.target_source
        : 'legacy';
};

/**
 * The canonical target read. Review, plan settings, Account, Progress and the
 * planner all act on this verdict:
 *
 *  - `targets` is null ONLY when the user never set targets at all, i.e. all
 *    four columns are null. Otherwise it carries the stored values with their
 *    per-field nullability intact, because the columns are independently
 *    nullable and a missing value is genuinely unknown — coercing one to 0
 *    would present a real target of nothing.
 *  - `complete` is true only with all four set; the planner requires it and
 *    otherwise answers 422 targets_missing.
 *  - `source` attributes the values to a route, or reports `legacy` when they
 *    cannot be attributed; the planner refuses `legacy` with
 *    409 targets_unconfirmed until the user reconfirms.
 *  - `stale` marks a confirmed ESTIMATE whose inputs have since changed. A
 *    confirmed estimate is fixed once confirmed: a later change to goal, body,
 *    activity or pace never rewrites it here or anywhere else. This flag is how
 *    the review and settings screens come to offer a recalculation, and
 *    generation keeps using the confirmed values until the user takes it.
 *    Manual targets never go stale — the user typed them, so a change of inputs
 *    says nothing about them — and `legacy` needs no staleness because those
 *    surfaces already treat it as "review your targets".
 *
 *    THE COMPARISON IS AN ANCESTRY CHECK ON THE PREFERENCES REVISION, exactly
 *    as AAP §0.5.2 defines it: `targets_input_revision ≠ preferences.revision`.
 *    `targets_input_revision` is the preferences `revision` the confirmed
 *    figure was computed at (§0.5.1), and `revision` is where the row stands
 *    now, so the flag answers "was this figure derived from the answers this
 *    user currently has on file?" — one counter, recorded by the canonical
 *    writer and advanced by every preference save. It is deliberately the SAME
 *    number `estimateRevision` pins on the save envelope, so the revision a
 *    client confirmed against is the revision stored as the ancestry.
 *
 *    A narrower counter that moved only when a term of the equation changed
 *    would answer a different and more flattering question, and it is not the
 *    contract: two surfaces read this flag as "review your targets", and the
 *    §0.5.2 rule is what they were specified against. Nothing recalculates
 *    either way — `stale` offers a recalculation, it never performs one.
 *  - `revision` is the targets counter, and 0 when there is no preferences row.
 */
export const deriveTargetsResponse = (
    userRow: TargetsUserRow,
    preferencesRow: TargetsPreferencesRow | null,
): TargetsResponse => {
    const values: NutritionTargetValues = {
        calories: userRow.target_calories,
        protein: userRow.target_protein_g,
        carbs: userRow.target_carbs_g,
        fat: userRow.target_fat_g,
    };

    const revision =
        preferencesRow === null ? NO_PREFERENCES_REVISION : preferencesRow.targets_revision;

    if (TARGET_FIELDS.every((field) => values[field] === null)) {
        // Nothing was ever set, so there is no route to attribute and nothing
        // that could be stale. `complete` is necessarily false here.
        return { targets: null, complete: false, source: null, stale: false, revision };
    }

    const source = resolveTargetSource(values, preferencesRow);

    // `source === 'estimated'` implies a preferences row, since resolving to
    // either named route requires one; the explicit check is what lets the
    // compiler see it.
    //
    // A null `targets_input_revision` is stale by this comparison, and rightly
    // so: an estimate confirmed without recording the inputs it came from
    // cannot be shown to still match them, and the honest answer to "does this
    // still describe your details?" is then "ask again".
    const stale =
        source === 'estimated' &&
        preferencesRow !== null &&
        preferencesRow.targets_input_revision !== preferencesRow.revision;

    return {
        targets: values,
        complete: TARGET_FIELDS.every((field) => values[field] !== null),
        source,
        stale,
        revision,
    };
};
