// The wire contract for every /api/meal-planning/* request and response body,
// and the shape the mobile app's io-ts codecs mirror. Declarations only: range
// and format validation belongs to the pure parsers in preferences/targets/
// mealPlan/swap/grocery/plannedMealLog *.logic.ts, and the typed error classes
// and their status mapping belong to services/mealPlanning.errors.ts and
// controllers/mealPlanning.controller.ts — this file carries only the data those
// errors serialize beside their machine code.
//
// Two invariants hold throughout: responses carry stable machine codes and data,
// never display prose (the client maps every code to copy through its own strings
// file), and no shape carries an owner field, because the caller is always the
// server-resolved user from the verified Firebase token.

import { MealEntryResponse } from './nutrition';
import { MealSlot, RecipeBadge, RecipeIconKey, RecipeVersionResponse } from './recipe';

/* ---------------------------------------------------------------------------
 * Closed vocabularies
 *
 * The backing Postgres columns are plain TEXT and SMALLINT with no enum and no
 * CHECK constraint, so these unions plus the *.logic.ts parsers are the only
 * place a misspelling is caught. Each member is spelled exactly as the wire
 * spells it. Nullability is declared at the member that can be absent rather
 * than inside an alias, so every alias stays reusable in non-nullable positions.
 * ------------------------------------------------------------------------- */

export type SetupStatus = 'not_started' | 'in_progress' | 'ready_for_review' | 'completed';

// Doubles as the literal `:step` path segment of
// PUT /meal-planning/preferences/steps/:step, with one exception:
// 'targets_manual' is only ever a stored resume marker for the manual-target
// route (which saves through PUT /meal-planning/targets), so it carries no step
// payload and never appears as a path segment.
export type SetupStep =
    | 'goal'
    | 'body'
    | 'activity'
    | 'diet'
    | 'dislikes'
    | 'schedule'
    | 'cooking'
    | 'review'
    | 'targets_manual';

// Which route produced the user's targets: 'estimated' from the calculated
// review screen, 'manual' after Skip or "Prefer not to say".
export type TargetRoute = 'estimated' | 'manual';

export type Goal = 'lose' | 'maintain' | 'gain';

// 'prefer_not_to_say' is answerable but not calculable: it takes the
// manual-target route instead of producing an estimate.
export type SexForEstimate = 'female' | 'male' | 'prefer_not_to_say';

// Display preferences only — heights and weights cross the wire in metric.
export type HeightUnitPref = 'ft_in' | 'cm';

export type WeightUnitPref = 'lb' | 'kg';

// The user's habitual overall activity, training included, applied to the BMR
// exactly once. Logged workouts and runs are never added on top of it.
export type ActivityLevel = 'not_very_active' | 'lightly_active' | 'active' | 'very_active';

export type Diet = 'none' | 'vegetarian' | 'vegan' | 'pescatarian';

export type MealSchedule = 'three' | 'three_plus_snack';

// Loss and gain share the same three paces; 'maintain' carries none.
export type PaceLbPerWeek = 0.5 | 1 | 1.5;

// Total prep plus cooking minutes permitted per meal.
export type CookingTimeLimitMin = 15 | 30 | 45 | 60;

// Relative cost band, 1 being the cheapest. Derived from the weekly budget, or 3
// (no penalty) when the user expressed no budget preference.
export type BudgetTier = 1 | 2 | 3;

// 'legacy' is derived, not stored: it means the four users.target_* values no
// longer equal the confirmed snapshot, so something outside this feature — the
// untouched PUT /api/user/targets, or an older client — wrote them last.
export type TargetSource = 'estimated' | 'manual' | 'legacy';

// Which bound moved a calculated target: the sex-specific floor, the user's own
// BMR, or the ceiling.
export type ClampReason = 'floor' | 'below_bmr' | 'ceiling';

// Advisory only. Manual targets that trip these are still saved and returned
// with 200 — a warning never blocks the user's own numbers.
export type FeasibilityWarning = 'macro_energy_mismatch' | 'below_catalog_min' | 'above_catalog_max';

// A plan whose end_date has passed keeps 'active' in storage but is treated as
// ended by every write path; 'superseded' means a regeneration replaced it.
export type PlanStatus = 'active' | 'superseded';

// Why a planned meal no longer matches the user's saved preferences. Allergen
// and diet flags are never resolved by relaxing a restriction.
export type MealFlagCode = 'diet' | 'allergen' | 'dislike' | 'cooking_time';

// Store-aisle grouping for the weekly grocery list; 'pantry_other' closes the
// list and absorbs everything the four named aisles do not cover.
export type GroceryCategory = 'produce' | 'protein' | 'dairy_alternatives' | 'grains_bread' | 'pantry_other';

export type GroceryBannerCode = 'updated_after_swap' | 'amount_increased';

// Which preference narrowed the candidate set the most when a week could not be
// built. Allergies are never reported, because they are never relaxed.
export type LimitingConstraintKey =
    | 'cooking_time'
    | 'dislikes'
    | 'diet'
    | 'nutrition_tolerance'
    | 'portion_limits'
    | 'slot_coverage'
    | 'catalog_coverage';

// How to read a limiting constraint's value; null when the constraint has no
// numeric value to report.
export type LimitingConstraintUnit = 'minutes' | 'foods' | 'percent' | 'recipes';

/* ---------------------------------------------------------------------------
 * Preferences — GET/PUT /meal-planning/preferences and its per-step saves
 * ------------------------------------------------------------------------- */

// A disliked ingredient hydrated for display. The response returns these
// objects while the request accepts bare ids (PreferencesUpdatePayload
// .dislikedFoodIds): the asymmetry is deliberate, so the chips on the food
// preferences screen render without a second round trip.
export interface DislikedFoodSummary {
    id: string;
    name: string;
    // One value of the ~120-term controlled taxonomy carried as data in
    // data/meal-planning/coverage-plan.v1.json. Left open on purpose: selecting
    // one food also excludes its group, and a new taxonomy term must not become
    // a compile error here.
    foodGroup: string;
}

export interface MealTimeEntry {
    slot: MealSlot;
    time: string; // 'HH:mm'
}

// null on the wire wherever this appears means the user expressed no budget,
// which is a real answer rather than a missing one.
export interface BudgetPreference {
    // Whole units of currency.
    amount: number;
    // 'USD' only in this version. Deliberately not narrowed to the literal: a
    // second currency should be a product decision, not a compile error.
    currency: string;
}

// Side-effect free. A user with no stored row reads back setupStatus
// 'not_started', revision 0 and null for every preference field, including the
// unit preferences — reading never creates a row and the server owns no unit
// defaults, so first-entry toggles are derived client-side.
export interface PreferencesResponse {
    setupStatus: SetupStatus;
    // null before the first step is saved; otherwise the step to resume at.
    setupStep: SetupStep | null;
    // The start date chosen on the review screen, persisted so it survives a
    // restart; null until the user changes it away from the default.
    reviewStartDate: string | null; // 'YYYY-MM-DD'
    // IANA zone name taken from the device and refreshed on every save; the
    // server computes "today" and every date bound in it. null before the first
    // save.
    timeZone: string | null;
    targetRoute: TargetRoute | null;
    // Optimistic-concurrency token: echo it back as expectedRevision on the next
    // write. 0 when no row exists yet.
    revision: number;
    goal: Goal | null;
    goalWeightKg: number | null;
    paceLbPerWeek: PaceLbPerWeek | null;
    age: number | null;
    heightCm: number | null;
    weightKg: number | null;
    sexForEstimate: SexForEstimate | null;
    heightUnitPref: HeightUnitPref | null;
    weightUnitPref: WeightUnitPref | null;
    activityLevel: ActivityLevel | null;
    diet: Diet | null;
    // Either up to nine of the named allergens or exactly ['none'], which is
    // mutually exclusive with all of them. Left open rather than unioned: the
    // exclusivity rule and the member list are enforced in
    // preferences.logic.ts, and the wire codes are data, not contract literals.
    allergens: string[];
    dislikedFoods: DislikedFoodSummary[];
    dislikedFoodGroups: string[];
    mealSchedule: MealSchedule | null;
    // Exactly one entry per slot of the chosen schedule, in wire order
    // (breakfast, lunch, dinner, then snack). The times themselves are not
    // ordered — a snack may legitimately fall between lunch and dinner.
    mealTimes: MealTimeEntry[];
    cookingTimeLimitMin: CookingTimeLimitMin | null;
    budget: BudgetPreference | null;
    noBudgetPreference: boolean;
    budgetTier: BudgetTier | null;
    // Whether a plan is currently active, so the client can choose between
    // starting setup and opening the plan without a second request.
    hasActivePlan: boolean;
}

// The body of PUT /meal-planning/preferences: a partial of the twenty editable
// keys plus a required expectedRevision.
//
// The twenty keys below are a CLOSED set, and the closure is the contract. The
// six server-owned keys of PreferencesResponse — setupStatus, setupStep,
// revision, budgetTier, hasActivePlan and targetRoute — must never appear here,
// and neither may an unknown key: preferences.logic.ts rejects any of them with
// 400 invalid_request and code 'read_only_field'. If a server-owned key is ever
// added to this type, the parser's rejection list and this contract have
// silently diverged.
//
// Every editable key is optional because the body is a partial: an omitted key
// means "leave this as it is". For the three keys that additionally accept null
// — goalWeightKg, paceLbPerWeek and budget — omitted and null are NOT the same,
// and the parser must keep them apart: null means "clear the stored value",
// which is how switching to the 'maintain' goal drops a target weight and a
// pace, and how "no budget preference" drops an amount.
export interface PreferencesUpdatePayload {
    goal?: Goal;
    goalWeightKg?: number | null;
    paceLbPerWeek?: PaceLbPerWeek | null;
    age?: number;
    heightCm?: number;
    weightKg?: number;
    sexForEstimate?: SexForEstimate;
    heightUnitPref?: HeightUnitPref;
    weightUnitPref?: WeightUnitPref;
    activityLevel?: ActivityLevel;
    diet?: Diet;
    allergens?: string[];
    dislikedFoodIds?: string[];
    dislikedFoodGroups?: string[];
    mealSchedule?: MealSchedule;
    mealTimes?: MealTimeEntry[];
    cookingTimeLimitMin?: CookingTimeLimitMin;
    budget?: BudgetPreference | null;
    noBudgetPreference?: boolean;
    timeZone?: string;
    // Required on this endpoint, unlike the per-step saves below: a full save
    // only ever edits an existing row. A mismatch is 409 stale_revision.
    expectedRevision: number;
}

// Carried by every per-step payload. expectedRevision is optional only while no
// preferences row exists — the very first 'goal' save — and is required and
// exact from then on; preferences.logic.ts answers 409 stale_revision when it is
// missing or mismatched after creation. A type cannot express "optional until a
// row exists", so it is optional here and the rule lives in this comment.
export interface SetupStepEnvelope {
    timeZone: string; // IANA zone name
    expectedRevision?: number;
}

export interface GoalStepPayload extends SetupStepEnvelope {
    goal: Goal;
    // Both omitted for the 'maintain' goal, which has neither a target weight
    // nor a pace. Unlike the partial full save, a step save replaces the step's
    // whole answer, so omitted and null are equivalent here.
    goalWeightKg?: number | null;
    paceLbPerWeek?: PaceLbPerWeek | null;
}

// The measured answer to the body step. `skipped` is the discriminant against
// BodySkippedStepPayload and is absent on this variant.
export interface BodyMeasuredStepPayload extends SetupStepEnvelope {
    skipped?: false;
    age: number;
    heightCm: number;
    weightKg: number;
    sexForEstimate: SexForEstimate;
    heightUnitPref: HeightUnitPref;
    weightUnitPref: WeightUnitPref;
}

// Skip on the body step, which sends no measurements and takes the
// manual-target route.
export interface BodySkippedStepPayload extends SetupStepEnvelope {
    skipped: true;
}

export type BodyStepPayload = BodyMeasuredStepPayload | BodySkippedStepPayload;

export interface ActivityStepPayload extends SetupStepEnvelope {
    activityLevel: ActivityLevel;
}

export interface DietStepPayload extends SetupStepEnvelope {
    diet: Diet;
    allergens: string[];
}

export interface DislikesStepPayload extends SetupStepEnvelope {
    // Published catalog food ids; the server derives the food groups to exclude.
    dislikedFoodIds: string[];
}

export interface ScheduleStepPayload extends SetupStepEnvelope {
    mealSchedule: MealSchedule;
    mealTimes: MealTimeEntry[];
}

export interface CookingStepPayload extends SetupStepEnvelope {
    cookingTimeLimitMin: CookingTimeLimitMin;
    // null is the explicit "no amount" answer and pairs with
    // noBudgetPreference true.
    budget: BudgetPreference | null;
    noBudgetPreference: boolean;
}

export interface ReviewStepPayload extends SetupStepEnvelope {
    // Persisted as reviewStartDate, so an edited start date survives a restart.
    startDate: string; // 'YYYY-MM-DD'
}

// The nine payload shapes the eight payload-bearing steps accept.
export type SetupStepPayload =
    | GoalStepPayload
    | BodyStepPayload
    | ActivityStepPayload
    | DietStepPayload
    | DislikesStepPayload
    | ScheduleStepPayload
    | CookingStepPayload
    | ReviewStepPayload;

// Returned by both the per-step save and the full save.
export interface PreferencesSaveResponse {
    preferences: PreferencesResponse;
    // How many planned meals of the active plan no longer match the saved
    // preferences after this write. Drives the plan-settings "Review affected
    // meals" banner; 0 when nothing is flagged or no plan is active.
    affectedMealCount: number;
}


/* ---------------------------------------------------------------------------
 * Targets — GET /meal-planning/targets, GET .../targets/estimate,
 * PUT /meal-planning/targets
 *
 * Three target shapes live here and none of them collapses into another:
 * NutritionTargetValues is per-field nullable because a legacy account may hold
 * only calories; MealPlanMacroTotals is all-number because a plan cannot exist
 * without four confirmed values; and the estimate response is a derivation, not
 * a stored record. These routes are never gated by the server feature flag —
 * Account, Progress and the diary read and write targets through them.
 * ------------------------------------------------------------------------- */

// The four target values as stored, each independently nullable: a legacy
// account that only ever set calories reads back
// {calories: 1900, protein: null, carbs: null, fat: null}. Never coerce a
// missing value to 0 — null means "not set", and 0 would be a real target.
export interface NutritionTargetValues {
    calories: number | null;
    protein: number | null;
    carbs: number | null;
    fat: number | null;
}

// Four macro values that are always present: plan targets, the generation
// snapshot, planned day and meal totals, and swap preview totals.
//
// Structurally identical to MacroTotals in ./nutrition by design and
// deliberately a separate declaration — coupling the planner's contract to the
// diary-totals DTO would let a later change to one silently reshape the other.
export interface MealPlanMacroTotals {
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
}

// The canonical read for every target surface. Three flags encode product rules
// that the shape alone cannot show:
//   complete — all four values are set; the planner requires it and otherwise
//              answers 422 targets_missing.
//   source   — 'legacy' means the stored values no longer match the confirmed
//              snapshot, so the planner refuses them with
//              409 targets_unconfirmed until the user reconfirms.
//   stale    — a confirmed estimate whose goal, body, activity or pace inputs
//              have changed since. Nothing recalculates on its own: the review
//              and settings screens offer a recalculation instead.
export interface TargetsResponse {
    // null only when all four stored values are null, i.e. the user never set
    // targets at all. Doubly nullable: the object may be null, and each member
    // may be null within it.
    targets: NutritionTargetValues | null;
    complete: boolean;
    // null exactly when targets is null.
    source: TargetSource | null;
    stale: boolean;
    // Optimistic-concurrency token for the targets record, distinct from the
    // preferences revision. 0 when no preferences row exists.
    revision: number;
}

// The inputs the estimate was computed from, echoed so the review screen can
// show what produced the numbers.
export interface TargetEstimateInputs {
    age: number;
    heightCm: number;
    weightKg: number;
    // Never 'prefer_not_to_say' in practice: that answer yields
    // 409 estimate_unavailable and takes the manual-target route instead.
    sexForEstimate: SexForEstimate;
    activityLevel: ActivityLevel;
    goal: Goal;
    // null for the 'maintain' goal, which has no pace.
    paceLbPerWeek: PaceLbPerWeek | null;
}

// Recomputed from stored preferences on every read; never persisted by reading.
// Unavailable inputs answer 409 estimate_unavailable rather than guessing.
export interface TargetEstimateResponse {
    source: 'estimated';
    // The preferences revision these inputs came from. Pin it back on the save
    // so the server can refuse an estimate computed from stale inputs
    // (409 estimate_stale). Not a concurrency token for the targets record.
    estimateRevision: number;
    inputs: TargetEstimateInputs;
    // The derivation the review screen shows: basal rate, the rate after the
    // activity factor, and the goal adjustment (negative for loss, positive for
    // gain, 0 for maintain).
    bmr: number;
    tdee: number;
    adjustment: number;
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    // True when a bound moved the calculated calories; clampReason is non-null
    // exactly when this is true.
    clamped: boolean;
    clampReason: ClampReason | null;
}

// Confirming the calculated estimate. The client never sends the numbers: the
// server recomputes them from stored preferences, which is what stops a client
// declaring its own values as "estimated".
export interface SaveEstimatedTargetsPayload {
    source: 'estimated';
    // Pins the INPUTS the displayed estimate came from (a preferences
    // revision). Mismatch is 409 estimate_stale.
    estimateRevision: number;
    // Pins the TARGETS RECORD being replaced — a different thing from
    // estimateRevision. Required whenever TargetsResponse.revision is above 0,
    // and mismatched or missing then is 409 stale_targets; omitted only for the
    // first save, when there is no prior revision to pin.
    expectedTargetsRevision?: number;
}

// Entering targets by hand, from Skip, "Prefer not to say", or the edit screen.
// Values are stored exactly as entered and never rebalanced to match the
// calorie figure.
export interface SaveManualTargetsPayload {
    source: 'manual';
    calories: number;
    protein: number;
    carbs: number;
    fat: number;
    // Same rule as on the estimated variant.
    expectedTargetsRevision?: number;
}

export type SaveTargetsPayload = SaveEstimatedTargetsPayload | SaveManualTargetsPayload;

// Advisory result of saving manual targets. Infeasible-but-valid numbers are
// saved and returned with 200 and warnings — there is no 422 on this route.
export interface TargetsFeasibility {
    ok: boolean;
    warnings: FeasibilityWarning[];
}

export interface SaveTargetsResponse {
    targets: TargetsResponse;
    feasibility: TargetsFeasibility;
}


/* ---------------------------------------------------------------------------
 * Plans — POST /meal-planning/plans, GET .../plans/current,
 * GET .../plans/:planId/days/:date, POST .../plans/:planId/regenerate,
 * GET .../plans/:planId/affected-meals
 * ------------------------------------------------------------------------- */

// The recipe projection carried on a planned meal: what the plan card and the
// swap rows render, not the full recipe (GET /recipes/:recipeVersionId serves
// that).
export interface MealPlanMealRecipeSummary {
    versionId: string;
    recipeId: string;
    name: string;
    iconKey: RecipeIconKey;
    // prep plus cook minutes, the figure the cooking-time limit is applied to.
    totalMinutes: number;
    badges: RecipeBadge[];
    // The single literal, not the provenance union: planning policy admits only
    // recipes whose every ingredient is source-backed, so a planned meal is
    // never an estimate. Widening this would erase a guarantee the client
    // relies on to label planned meals without a source qualifier.
    nutritionProvenance: 'source_backed';
}

// An array of objects rather than an array of codes: several details can share
// one code and survive a round trip losslessly (two milk-bearing meals both
// flag 'allergen' with their own detail).
export interface MealFlag {
    code: MealFlagCode;
    // Machine-readable specifics for the code — the offending allergen or
    // ingredient names, or the exceeded limit. Left open because the values are
    // catalog data, and formatted client-side.
    detail: string[];
}

// One diary entry logged against this planned meal. This is a LIST rather than
// a single value because a deliberate second serving is a distinct entry.
//
// The client derives the card's state from it and from nothing else: the meal
// reads as logged when an entry references the CURRENT recipe.versionId, and
// gets the logged-then-swapped treatment when entries reference only a
// DIFFERENT version — which is why recipeName is present, so the caption can
// name the recipe actually eaten after any number of swaps.
export interface LoggedPlannedEntry {
    entryId: string;
    // The diary date the entry landed on, which is not necessarily the planned
    // date.
    date: string; // 'YYYY-MM-DD'
    // The diary bucket's name, e.g. 'Breakfast'.
    mealName: string;
    // The portion actually eaten, which may differ from portionMultiplier.
    servings: number;
    loggedAt: string; // ISO-8601
    recipeVersionId: string;
    recipeName: string;
}

// The recipe this slot held before the last swap. An audit value for naming the
// previous recipe — never the source of logged state, which is derived from
// loggedEntries alone.
export interface PreviousRecipeSummary {
    versionId: string;
    name: string;
}

export interface MealPlanMealResponse {
    id: string;
    // Bumped when this meal is swapped; the plan's own revision is the token
    // writes pin.
    revision: number;
    slot: MealSlot;
    slotTime: string; // 'HH:mm'
    sortOrder: number;
    recipe: MealPlanMealRecipeSummary;
    // How much of one recipe serving this meal plans. Deliberately a plain
    // number: the allowed set is narrower for a snack than for a main slot, so
    // one union would be wrong for snacks. The server recomputes it and answers
    // 409 preview_stale on a mismatch; the allowed sets live in
    // mealPlan.logic.ts and swap.logic.ts.
    portionMultiplier: number;
    // The portion rendered for display, e.g. '1 serving'.
    portionText: string;
    planned: MealPlanMacroTotals;
    // Empty when the meal matches every saved preference.
    flags: MealFlag[];
    // Ordered by loggedAt ascending, then entryId, so the latest entry is last
    // and the ordering is stable across reads. Empty when nothing was logged.
    loggedEntries: LoggedPlannedEntry[];
    // null when this slot was never swapped.
    previousRecipe: PreviousRecipeSummary | null;
}

export interface MealPlanDayResponse {
    id: string;
    date: string; // 'YYYY-MM-DD' in the user's stored time zone
    // 0-based offset from the plan's start date.
    dayIndex: number;
    // The sum of the day's planned meals. Planned, never consumed — the diary
    // owns what was eaten.
    plannedTotals: MealPlanMacroTotals;
    // True on the plan's last date, which is where the client offers the next
    // week.
    isLastDay: boolean;
    meals: MealPlanMealResponse[];
}

export interface MealPlanSummary {
    plannedMeals: number;
    groceryItemCount: number;
    // Diary entries linked to this plan's meals — the count the regeneration
    // dialog promises to keep.
    loggedEntryCount: number;
}

export interface MealPlanResponse {
    id: string;
    // The optimistic-concurrency token every plan write pins as
    // expectedPlanRevision. Every mutating response carries the new value.
    revision: number;
    // 1 for a first generation, incremented by each regeneration; also what
    // varies the generator's seed so a regeneration differs from the plan it
    // replaces.
    generationAttempt: number;
    startDate: string; // 'YYYY-MM-DD'
    endDate: string; // 'YYYY-MM-DD', six days after startDate
    status: PlanStatus;
    // The user's CURRENT confirmed targets — the same values Account and the
    // diary show.
    targets: MealPlanMacroTotals;
    // The snapshot the plan was actually built against.
    generationTargets: MealPlanMacroTotals;
    // targets and generationTargets differ, i.e. the targets moved after this
    // plan was built. Nothing regenerates on its own; the client captions it.
    targetsStale: boolean;
    preferencesRevision: number;
    targetsRevision: number;
    // True when any meal carries a flag, so the client can show the banner
    // without walking every day.
    hasIncompatibilities: boolean;
    summary: MealPlanSummary;
    // The seven days, in date order.
    days: MealPlanDayResponse[];
}

export interface GeneratePlanPayload {
    startDate: string; // 'YYYY-MM-DD'
    // Deduplication key minted once per user intent, sent on all four keyed
    // writes (generate, regenerate, swap, log). Replaying the same key with the
    // same body returns the stored response verbatim; the same key with a
    // different body is 409 idempotency_conflict. It never enters the
    // generator's seed, so a retry under a new key still yields the same
    // candidate plan.
    idempotencyKey: string; // UUID v4
    // Pin the inputs the plan is built from; either moving is
    // 409 stale_revision.
    expectedPreferencesRevision: number;
    expectedTargetsRevision: number;
}

export interface RegeneratePlanPayload {
    idempotencyKey: string; // UUID v4
    // The plan being replaced; a mismatch is 409 stale_plan and a
    // non-active plan is 409 plan_not_active.
    expectedPlanRevision: number;
    expectedPreferencesRevision: number;
    expectedTargetsRevision: number;
}

// Both members may be null: null/null is a user with no plan at all, which is
// the client's empty state.
export interface CurrentMealPlanResponse {
    // The active plan containing today in the user's stored time zone.
    current: MealPlanResponse | null;
    // An active plan starting after today. At most one may exist.
    upcoming: MealPlanResponse | null;
}

// One day read on its own, for fresh logged state without refetching the week.
// Readable for a superseded plan too, so history keeps working — planStatus is
// what tells the client whether writes are still allowed.
export interface MealPlanDayEnvelopeResponse {
    planId: string;
    planRevision: number;
    planStatus: PlanStatus;
    day: MealPlanDayResponse;
}

export interface AffectedMeal {
    mealId: string;
    date: string; // 'YYYY-MM-DD'
    slot: MealSlot;
    recipeName: string;
    // Never empty: a meal is only listed here because it carries flags.
    flags: MealFlag[];
}

export interface AffectedMealsResponse {
    meals: AffectedMeal[];
}


/* ---------------------------------------------------------------------------
 * Swap — GET .../meals/:mealId/alternatives,
 * GET .../alternatives/:recipeVersionId/preview, POST .../meals/:mealId/swap
 * ------------------------------------------------------------------------- */

// A narrow projection carrying only what an alternative row renders. The full
// recipe arrives with the preview.
export interface SwapAlternative {
    recipeVersionId: string;
    name: string;
    iconKey: RecipeIconKey;
    calories: number;
    protein: number;
    totalMinutes: number;
    // The portion that best fits the day with this candidate in place; a recipe
    // with no admissible portion is not listed at all.
    portionMultiplier: number;
}

export interface SwapAlternativesResponse {
    // The meal being replaced, so the screen can keep it visible while the user
    // chooses. It is never cleared while looking for a replacement.
    current: MealPlanMealResponse;
    // Up to eight, in deterministic order. An EMPTY array is a meaningful
    // result, not a failure: it is the client's "no alternatives for this slot"
    // state, distinct from an error loading them.
    alternatives: SwapAlternative[];
}

export interface SwapPreviewAlternative {
    recipe: RecipeVersionResponse;
    // Recomputed server-side and bound to this preview: committing a different
    // portion is 409 preview_stale.
    portionMultiplier: number;
    portionText: string;
    // This candidate at this portion, not the whole day.
    nutrition: MealPlanMacroTotals;
}

export interface SwapPreviewResponse {
    alternative: SwapPreviewAlternative;
    // The day's totals with the swap applied.
    dayTotalsIfSwapped: MealPlanMacroTotals;
    targets: MealPlanMacroTotals;
    // Signed: negative when the swap lowers the day's calories, positive when it
    // raises them.
    calorieDelta: number;
    // The revision the preview was computed against; send it back as
    // expectedPlanRevision to commit.
    planRevision: number;
}

export interface SwapMealPayload {
    recipeVersionId: string;
    // Echo the previewed value; the server recomputes it and answers
    // 409 preview_stale if the two disagree.
    portionMultiplier: number;
    expectedPlanRevision: number;
    idempotencyKey: string; // UUID v4
}

// Counts of grocery rows the swap changed, for the confirmation copy.
export interface GroceryChangeSummary {
    added: number;
    removed: number;
    increased: number;
}

export interface SwapMealResponse {
    meal: MealPlanMealResponse;
    // The whole day, because a swap moves the day's planned totals.
    day: MealPlanDayResponse;
    planRevision: number;
    groceryChangeSummary: GroceryChangeSummary;
}

/* ---------------------------------------------------------------------------
 * Grocery — GET .../plans/:planId/groceries, PUT .../groceries/:itemId,
 * POST .../groceries/uncheck-all
 *
 * Grocery writes are state-setting and carry NO idempotency key and NO expected
 * revision: they are last-write-wins and do not bump the plan revision, because
 * a check mark is not a plan change.
 * ------------------------------------------------------------------------- */

// An increase on an item the user had already checked. The item STAYS checked —
// nothing disappears from the list — and is shown flagged instead.
//
// All three strings are pre-formatted for display and are rendered verbatim: the
// client must not recompute a delta from quantityGrams, because previousDisplayText
// is the last amount the user acknowledged, not the amount before the most recent
// change, so repeated swaps keep comparing against what the user actually saw.
export interface GroceryItemFlag {
    previousDisplayText: string;
    newDisplayText: string;
    deltaDisplayText: string;
    flaggedAt: string; // ISO-8601
}

export interface GroceryItem {
    id: string;
    catalogFoodId: string;
    // 'raw' | 'cooked' | 'prepared' | 'dry' | 'as_purchased'. Raw, dry and
    // cooked amounts of one food never merge into a single row. Left open here
    // rather than unioned because CatalogFoodState in ./catalog owns that
    // vocabulary and this contract does not depend on the catalog contract.
    foodState: string;
    name: string;
    // The aggregated weight backing displayText. Measured, never a container
    // count.
    quantityGrams: number;
    // The shopping amount as rendered, e.g. '2.5 lb' or '12 eggs'. The unit
    // family is fixed per row when the plan is generated, so an update may move
    // oz to lb but never mass to count.
    displayText: string;
    isChecked: boolean;
    // null when the item is not flagged, which is every item except an increase
    // on an already-checked one. A decrease never flags and never unchecks.
    flag: GroceryItemFlag | null;
}

export interface GroceryBanner {
    code: GroceryBannerCode;
    // Present only for 'updated_after_swap', naming the slot whose swap changed
    // the list.
    mealSlot?: string;
    // Present only for 'amount_increased', naming the flagged items; the client
    // pluralises its copy from the count.
    itemNames?: string[];
}

export interface GrocerySection {
    category: GroceryCategory;
    items: GroceryItem[];
}

export interface GroceryListResponse {
    planId: string;
    planRevision: number;
    startDate: string; // 'YYYY-MM-DD'
    endDate: string; // 'YYYY-MM-DD'
    totalCount: number;
    checkedCount: number;
    // null when there is nothing to announce.
    banner: GroceryBanner | null;
    // Aisle sections in store order, unchecked items only. An EMPTY array is the
    // client's empty-LIST state — a plan that needs no ingredients — which is a
    // different screen from having no plan at all (the absence of a plan
    // entirely).
    sections: GrocerySection[];
    // Checked items, held apart so they stay visible below the list instead of
    // vanishing from it.
    checkedItems: GroceryItem[];
}

export interface ToggleGroceryItemPayload {
    // The desired state, not a toggle instruction, which is what makes the write
    // safely repeatable without a key. Checking or unchecking clears any flag.
    isChecked: boolean;
}

export interface ToggleGroceryItemResponse {
    item: GroceryItem;
    checkedCount: number;
}

export interface UncheckAllGroceriesResponse {
    // Always 0 on success; returned so the client updates its counter from the
    // server rather than assuming.
    checkedCount: number;
}

/* ---------------------------------------------------------------------------
 * Planned-meal logging — POST .../meals/:mealId/log
 * ------------------------------------------------------------------------- */

export interface LogPlannedMealPayload {
    // The portion actually eaten, which may differ from the planned portion.
    // Range-validated in plannedMealLog.logic.ts.
    servings: number;
    // The diary date to log against; must fall inside the plan's week.
    date: string; // 'YYYY-MM-DD'
    // An existing diary bucket (meals.id) owned by the caller whose own date
    // equals `date`, obtained from GET /api/macros/:date, which self-heals the
    // four buckets. No mealName is accepted: the client picks a bucket, it never
    // names one.
    diaryMealId: string;
    expectedPlanRevision: number;
    idempotencyKey: string; // UUID v4
}

export interface LogPlannedMealResponse {
    // The created diary entry. Embedding the diary DTO is deliberate: the client
    // reads entry.mealPlanMealId and entry.nutritionProvenance straight off the
    // log result to render the "From meal plan" caption without a refetch.
    entry: MealEntryResponse;
    // The planned meal with its new loggedEntries, so the card can switch to its
    // logged state from this response alone.
    mealPlanMeal: MealPlanMealResponse;
    planRevision: number;
}


/* ---------------------------------------------------------------------------
 * Error wire data
 *
 * The DATA an error serializes beside its machine code — nothing else. The error
 * classes live in services/mealPlanning.errors.ts and the code-to-status mapping
 * lives in controllers/mealPlanning.controller.ts, so no status constant and no
 * display prose appears here. The codes that carry no data beyond themselves
 * (preferences_incomplete, targets_unconfirmed, upcoming_exists,
 * idempotency_conflict, preview_stale, recipe_ineligible,
 * plan_generation_failed, swap_failed, feature_disabled) need no shape.
 * ------------------------------------------------------------------------- */

// One field-level validation failure. Both members are machine-readable: the
// client maps `code` to its own copy and highlights `field`.
export interface InvalidRequestDetail {
    field: string;
    code: string;
}

// 400 invalid_request. Also the shape carrying code 'read_only_field' when a
// preferences body includes a server-owned or unknown key.
export interface InvalidRequestErrorData {
    details: InvalidRequestDetail[];
}

// One preference that narrowed the candidate set. editStep being a SetupStep is
// what lets the client route the user straight to the right setup screen without
// parsing a message.
export interface LimitingConstraint {
    constraintKey: LimitingConstraintKey;
    // null when the constraint has no numeric value to report, e.g. a slot with
    // no eligible recipes at all.
    value: number | null;
    // null exactly when value is null.
    unit: LimitingConstraintUnit | null;
    // The slots affected; empty when the constraint applies to the whole week.
    slots: string[];
    editStep: SetupStep;
}

// 422 no_matching_meals — a feasibility verdict, not a server failure.
export interface NoMatchingMealsErrorData {
    // Named in a deterministic order, most limiting first.
    limitingConstraints: LimitingConstraint[];
    // The literal, because it is a promise rather than a flag: allergies are
    // never among the constraints suggested for relaxation.
    allergiesKept: true;
}

// 409 stale_revision on the plan routes, where two inputs are pinned at once and
// either may have moved. The client re-reads both and retries from fresh data.
export interface StaleRevisionErrorData {
    preferencesRevision: number;
    targetsRevision: number;
}

// 409 stale_revision on the preference routes, which pin one counter.
export interface StaleRevisionCounterErrorData {
    currentRevision: number;
}

// 409 stale_targets. Carries the authoritative revision so the client can
// re-read, compare against its draft, and resolve silently when they already
// agree.
export interface StaleTargetsErrorData {
    currentRevision: number;
}

// 409 stale_plan.
export interface StalePlanErrorData {
    currentRevision: number;
}

// A regeneration replaced this plan; the client follows the replacement.
export interface PlanSupersededErrorData {
    replacementPlanId: string;
}

// The plan's last date has passed. Reads still work, writes do not.
export interface PlanEndedErrorData {
    reason: 'ended';
}

// 409 plan_not_active, in its two forms. The members discriminate the variants.
export type PlanNotActiveErrorData = PlanSupersededErrorData | PlanEndedErrorData;

// 409 plan_overlap — the requested week collides with an existing active plan.
export interface PlanOverlapErrorData {
    conflictingPlanId: string;
}

// 409 estimate_unavailable. 'prefer_not_to_say' and missing measurements both
// route the user to manual target entry.
export interface EstimateUnavailableErrorData {
    reason: 'prefer_not_to_say' | 'missing_inputs';
}

// 422 targets_missing — the planner needs all four values.
export interface TargetsMissingErrorData {
    // The target field names that are still unset.
    missing: string[];
}
