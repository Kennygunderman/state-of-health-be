// The pure swap domain: given one planned day, the week around it and the
// plannable catalog, decide WHICH recipe versions may replace a single meal, at
// WHAT portion, and in WHICH order — or answer, in data, that none may.
//
// ONE FUNCTION, THREE CALLERS. The alternatives list, the swap preview and the
// swap commit all reach their candidate through {@link selectSwapCandidates} /
// {@link selectSwapCandidate}, which is the whole point of the rule in the
// Agent Action Plan §0.7.3: three independent implementations of "which meals
// fit this slot" is how a preview eventually shows a portion the commit refuses
// — or worse, how a commit writes a meal the list would never have offered.
// `swap.service.ts` owns every await, the transaction and the grocery diff; it
// calls this module for every decision and adds no rule of its own.
//
// Everything here is deterministic and synchronous — no Prisma, no fetch, no
// filesystem, no `process.env`, no clock, and deliberately NO PRNG. Row-shaped
// inputs are declared below as structural interfaces rather than imported
// Prisma types, so every rule is exercisable from plain object literals, and the
// snake_case ↔ camelCase wire translation happens in the mapper layer and
// nowhere near here (Rule backend-architecture §6, §7, §10). Anything that needs
// "now" takes it as an argument.
//
// FOUR PROPERTIES ARE LOAD-BEARING, and each is one plausible "simplification"
// away from being lost. Every one has a named test in
// `__tests__/swap.logic.test.ts`:
//
//  * NOTHING IS RE-DERIVED HERE. Eligibility is `recipe.logic.ts`'s
//    {@link evaluatePlanningEligibility}, repetition is `mealPlan.logic.ts`'s
//    {@link violatesRepetitionRule}, the day bands are its
//    {@link isDayWithinTolerance}, the ranking metric is its
//    {@link targetProximity} and the portion sets are its
//    {@link portionMultipliersForSlot}. A second spelling of any of them is a
//    defect even while it still agrees: the generator and the swap have to
//    accept exactly the same meals, or a swap eventually offers a dish the
//    generator refused — an allergen, an estimate, or a week that breaks its
//    own repetition rule.
//
//  * THE CURRENT MEAL NEVER COUNTS AGAINST ITSELF. Repetition is evaluated
//    against the week with the meal being replaced REMOVED. It is the one place
//    the swap rule genuinely differs from the generator's, and forgetting it
//    silently shrinks the alternatives list for every mid-week swap.
//
//  * PRNG-FREE, TOTAL RANKING. The order is `(targetProximity of the resulting
//    day QUANTISED to whole TOLERANCE_EPSILON steps, recipe.slug,
//    recipe.version)`. The generator's seeded shuffle is deliberately absent:
//    the alternatives list is refetched on every screen open, and a seeded
//    tie-break would reshuffle rows under the user's thumb. The quantisation is
//    what makes the three keys a TOTAL order over any candidate set: an "equal
//    within epsilon" primary key is not transitive, so it would make the sorted
//    list depend on the order the caller's query returned rows in — the very
//    instability this ranking exists to rule out.
//
//  * AN EMPTY LIST IS AN ANSWER. A recipe with no admissible portion is
//    excluded rather than offered at its least-bad one, and a slot with nothing
//    admissible returns `[]` — the state the client renders as 13d ("No
//    alternatives fit"). Substituting a best-effort candidate would trade a
//    truthful empty screen for a meal that breaks the day the user just
//    approved.
//
// Not this module's job: reading or writing anything, the keyed-write sequence
// (`mealPlanningAction.service.ts`), the grocery diff a commit produces
// (`grocery.logic.ts`), the logged-state derivation a swapped slot displays
// (`plannedMealLog.logic.ts::deriveLoggedStatus`), wire shaping (the mappers),
// and HTTP status codes (the controller).

import {
    DEFAULT_PORTION_POLICY,
    MealPlanInputError,
    PlanRecipeCandidate,
    TOLERANCE_EPSILON,
    addDaysToDayKey,
    computeDayTotals,
    isDayKey,
    isDayWithinTolerance,
    portionMultipliersForSlot,
    targetProximity,
    violatesRepetitionRule,
} from './mealPlan.logic';
import { PreviewStaleError, RecipeIneligibleError } from './mealPlanning.errors';
import { PlanningPreferences, evaluatePlanningEligibility, scalePlannedNutrition } from './recipe.logic';
import type { MealFlag, MealPlanMacroTotals } from '../types/mealPlanning';
import type { MealSlot } from '../types/recipe';

/* ---------------------------------------------------------------------------
 * Policy constants
 *
 * Every number the selection turns on is named, and the two that are product
 * policy are exported so a test asserts against the same value the rule uses.
 * ------------------------------------------------------------------------- */

/**
 * How many alternatives a list ever carries (§0.7.3).
 *
 * Truncation happens AFTER ranking, so the eight rows are the eight best rather
 * than the first eight the catalog happened to yield. Eight is a product
 * decision about a scrollable sheet, not an arithmetic one.
 *
 * It bounds the OFFER and not just the sheet: {@link selectSwapCandidate} picks
 * from these rows, so the preview and the commit are held to the same eight the
 * list showed.
 */
export const MAX_SWAP_ALTERNATIVES = 8;

/**
 * The share of the day target a swap is judged against: the WHOLE day.
 *
 * The generator scores a partial day against its slot's cumulative guidance
 * share, because it is still filling the day. A swap replaces one meal of an
 * already complete day, so the only meaningful comparison is the finished day
 * against the finished target — which is why {@link targetProximity} is called
 * with 1 here and never with a slot share.
 */
const WHOLE_DAY_SHARE = 1;

/**
 * Decimals a portion multiplier is compared at.
 *
 * Two, because two is the portion representation the whole contract already
 * uses: the client's fraction chips store `0.33`/`0.66`, `plannedMealLog.logic.ts`
 * holds servings to two decimals, and `portion_multiplier` is a `DOUBLE
 * PRECISION` column that has been through JSON. Comparing raw floats would let
 * a value that survived a round trip differ from the recomputed one in the
 * fifteenth digit and fail a commit the user did nothing wrong in.
 */
const PORTION_MULTIPLIER_DECIMALS = 2;

const PORTION_MULTIPLIER_SCALE = 10 ** PORTION_MULTIPLIER_DECIMALS;

/** `meal_plan_meals.revision` starts at 1, so a stored revision is never lower. */
const MIN_MEAL_REVISION = 1;

/* ---------------------------------------------------------------------------
 * The rows and the context these rules read
 * ------------------------------------------------------------------------- */

/**
 * One stored meal of the day being edited, INCLUDING the one being replaced.
 *
 * `planned` is the row's `planned_*` values at full precision, which is what
 * makes "the day if you swap" comparable with the day the user is looking at:
 * the swapped-in meal's nutrition replaces this meal's contribution and every
 * other meal's is carried through unchanged and unrounded.
 */
export interface SwapDayMeal {
    id: string;
    slot: MealSlot;
    recipeId: string;
    recipeVersionId: string;
    portionMultiplier: number;
    planned: MealPlanMacroTotals;
    /**
     * `meal_plan_meals.revision` as currently stored.
     *
     * Carried on the row rather than passed to {@link swapMealWrite} as a
     * fourth argument, deliberately: the next revision is a property of the
     * meal being replaced, and a caller that had to supply it separately could
     * pass the plan's revision, or yesterday's, and the write would still
     * typecheck.
     */
    revision: number;
}

/**
 * One planned meal of the whole plan week — the minimum the repetition rule
 * reads, and nothing more.
 *
 * Narrower than {@link SwapDayMeal} on purpose. Repetition counts recipes
 * across days and never looks at nutrition, so widening this shape would invite
 * a caller to load seven days of macros to answer a spacing question.
 */
export interface SwapWeekMeal {
    id: string;
    /** `YYYY-MM-DD` in the user's own calendar, the same key the plan stores. */
    date: string;
    recipeId: string;
}

/**
 * Everything one selection needs, and nothing it could fetch.
 *
 * The two meal collections have distinct jobs and are deliberately not merged:
 * `dayMeals` answers "what does this day total if I swap" (nutrition), and
 * `weekMeals` answers "may this recipe appear here at all" (spacing). One
 * combined shape would force every caller to load the whole week's macros.
 */
export interface SwapSelectionContext {
    /** `meal_plan_meals.id` of the meal being replaced. */
    mealId: string;
    /** The day key that meal sits on. */
    date: string;
    slot: MealSlot;
    /** The day's stored meals, the one being replaced included. */
    dayMeals: readonly SwapDayMeal[];
    /** Every planned meal of the plan, the one being replaced included. */
    weekMeals: readonly SwapWeekMeal[];
    /** The plan's day targets — all four, positive; the imported rules enforce it. */
    targets: MealPlanMacroTotals;
    preferences: PlanningPreferences;
    /** The plannable set: current recipe versions, as the generator sees them. */
    recipes: readonly PlanRecipeCandidate[];
    /** Narrows {@link MAX_SWAP_ALTERNATIVES}; never widens it. */
    limit?: number;
}

/**
 * One admissible alternative, with every number the list row, the preview and
 * the commit each need — computed once, so the three cannot disagree about any
 * of them.
 */
export interface SwapCandidate {
    recipe: PlanRecipeCandidate;
    /** The single admissible multiplier this recipe is offered at. */
    portionMultiplier: number;
    /** `per_serving × portionMultiplier`, unrounded. Display rounding is the mapper's. */
    nutrition: MealPlanMacroTotals;
    /** The whole day's totals with this candidate in the slot, unrounded. */
    dayTotalsIfSwapped: MealPlanMacroTotals;
    /** `dayTotalsIfSwapped.calories − the day's current calories`; negative when the day gets lighter. */
    calorieDelta: number;
    /** The ranking key: {@link targetProximity} of the resulting day over the whole day. */
    targetProximity: number;
}

/**
 * The `meal_plan_meals` columns a commit writes, snake_case as the row stores
 * them so the service hands this straight to Prisma without a second shape.
 *
 * `previous_recipe_version_id` and `swapped_at` are an AUDIT record of the last
 * swap and are never the source of the card's logged-then-swapped caption: with
 * A logged and the slot swapped to B and then to C, this column says B while the
 * diary entries still say A. `plannedMealLog.logic.ts::deriveLoggedStatus` reads
 * the entries, which is why it stays right after any number of swaps.
 */
export interface SwapMealWrite {
    recipe_version_id: string;
    portion_multiplier: number;
    planned_calories: number;
    planned_protein_g: number;
    planned_carbs_g: number;
    planned_fat_g: number;
    previous_recipe_version_id: string;
    swapped_at: Date;
    revision: number;
    /**
     * The meal's incompatibility flags after the swap — always empty (§0.7.3:
     * "a swap to a compatible recipe clears that meal's flags").
     *
     * Typed as {@link MealFlag}`[]` rather than as an empty tuple so the column's
     * shape is stated where the write is declared: `meal_plan_meals.flags` is an
     * array of `{code, detail}` objects, and the DTO's `flags` carries the same
     * shape.
     */
    flags: MealFlag[];
}

/* ---------------------------------------------------------------------------
 * Input integrity — faults that would make the selection meaningless
 *
 * Each of these describes a context that could not legitimately exist, and each
 * would otherwise fail QUIETLY in the one direction that matters: by admitting
 * more alternatives than the rules allow. {@link MealPlanInputError} is
 * `mealPlan.logic.ts`'s class for exactly that — a programming or
 * data-integrity fault to surface and fix, never a feasibility answer to
 * render — and is reused rather than re-declared.
 * ------------------------------------------------------------------------- */

/**
 * The meal being replaced, resolved from the day it is supposed to sit on.
 *
 * A day that does not contain it throws rather than defaulting: its nutrition
 * would then be added to the day instead of replacing a meal's, and every
 * candidate would be judged against a day one meal too heavy. A slot that
 * disagrees with the stored row throws for the same reason — the slot decides
 * the portion set and the eligibility clause, so judging a lunch under
 * breakfast's rules would offer meals the generator would not have placed.
 */
const requireCurrentMeal = (context: SwapSelectionContext): SwapDayMeal => {
    if (!isDayKey(context.date)) {
        throw new MealPlanInputError(
            `date must be a YYYY-MM-DD calendar date, received ${JSON.stringify(context.date)}`,
            'date',
        );
    }

    const currentMeal = context.dayMeals.find((meal) => meal.id === context.mealId);

    if (currentMeal === undefined) {
        throw new MealPlanInputError(
            `dayMeals must contain the meal being replaced (${JSON.stringify(context.mealId)}); ` +
                'without it the resulting day cannot be computed',
            'dayMeals',
        );
    }

    if (currentMeal.slot !== context.slot) {
        throw new MealPlanInputError(
            `slot ${JSON.stringify(context.slot)} does not match the stored slot ` +
                `${JSON.stringify(currentMeal.slot)} of the meal being replaced`,
            'slot',
        );
    }

    return currentMeal;
};

/** The list length this selection truncates to. A caller may only narrow the policy maximum. */
const resolveLimit = (limit: number | undefined): number => {
    if (limit === undefined) {
        return MAX_SWAP_ALTERNATIVES;
    }

    if (!Number.isInteger(limit) || limit <= 0) {
        throw new MealPlanInputError(
            `limit must be a positive integer when supplied, received ${String(limit)}`,
            'limit',
        );
    }

    // Clamped rather than honoured: eight is the product rule (§0.7.3) and
    // `limit` exists to ask for fewer, so a caller passing a page size cannot
    // quietly turn the alternatives sheet into the whole catalog.
    return Math.min(limit, MAX_SWAP_ALTERNATIVES);
};

/* ---------------------------------------------------------------------------
 * Repetition — the week, with the meal being replaced removed
 * ------------------------------------------------------------------------- */

/** The three backward-looking sets {@link violatesRepetitionRule} is asked for. */
interface RepetitionWindow {
    /** Remaining uses per recipe in the week, the meal being replaced excluded. */
    usesByRecipeId: ReadonlyMap<string, number>;
    /** Recipes planned on the day BEFORE or the day AFTER — see the note below. */
    adjacentDayRecipeIds: ReadonlySet<string>;
    /** Recipes planned on the other meals of this same day. */
    sameDayRecipeIds: ReadonlySet<string>;
}

/**
 * Derives the repetition window for this swap.
 *
 * THE REMOVAL is the rule: the meal being replaced is dropped from the week
 * before anything is counted, so it never counts against itself. Its slot is
 * about to be empty, and a recipe already planned twice in the week — where one
 * of those two uses IS this meal — is a perfectly legal choice for it. Without
 * the removal, the dish currently in the slot would also appear in the same-day
 * set and block its own republished version.
 *
 * BOTH NEIGHBOURS ARE PASSED AS `previousDayRecipeIds`, and the asymmetry in
 * that parameter's name is worth the sentence it takes to explain. The generator
 * walks days forward, so when it fills day *n* only day *n − 1* exists and
 * "never on consecutive days" needs one neighbour. A mid-week swap has TWO
 * neighbours, and the rule is symmetric — a recipe on Thursday is just as much
 * "consecutive" with Wednesday as Wednesday's is with Thursday. Passing the
 * union of both days is what makes the swap honour the same spacing the
 * generator produced; passing only the day before would let a swap create a
 * Thursday/Friday repeat the generator would never have placed.
 *
 * A week that does not contain the meal being replaced throws: nothing was
 * removed, so every count would include the outgoing meal and the list would be
 * narrower than the rules require — the silent failure this check exists to
 * prevent. A malformed day key throws for the matching reason: it would simply
 * never match a neighbour, quietly disabling the spacing rule for that row.
 */
const repetitionWindow = (context: SwapSelectionContext): RepetitionWindow => {
    const previousDay = addDaysToDayKey(context.date, -1);
    const nextDay = addDaysToDayKey(context.date, 1);

    const usesByRecipeId = new Map<string, number>();
    const adjacentDayRecipeIds = new Set<string>();
    const sameDayRecipeIds = new Set<string>();
    let removedCurrentMeal = false;

    for (const meal of context.weekMeals) {
        if (!isDayKey(meal.date)) {
            throw new MealPlanInputError(
                `weekMeals[].date must be a YYYY-MM-DD calendar date, received ${JSON.stringify(meal.date)}`,
                'weekMeals',
            );
        }

        if (meal.id === context.mealId) {
            removedCurrentMeal = true;
            continue;
        }

        usesByRecipeId.set(meal.recipeId, (usesByRecipeId.get(meal.recipeId) ?? 0) + 1);

        if (meal.date === previousDay || meal.date === nextDay) {
            adjacentDayRecipeIds.add(meal.recipeId);
        }

        if (meal.date === context.date) {
            sameDayRecipeIds.add(meal.recipeId);
        }
    }

    if (!removedCurrentMeal) {
        throw new MealPlanInputError(
            `weekMeals must contain the meal being replaced (${JSON.stringify(context.mealId)}) so it can be ` +
                'removed from the repetition count; otherwise the meal counts against itself',
            'weekMeals',
        );
    }

    return { usesByRecipeId, adjacentDayRecipeIds, sameDayRecipeIds };
};

/* ---------------------------------------------------------------------------
 * Admissibility — the generator's hard set, plus "is this an alternative at all"
 * ------------------------------------------------------------------------- */

/**
 * Whether a recipe version may be offered for this slot.
 *
 * Three clauses, in the order that makes a refusal cheapest to reach:
 *
 *  1. IT MUST BE A DIFFERENT VERSION FROM THE ONE ALREADY IN THE SLOT. The
 *     identical version is not an alternative: committing it would bump the
 *     meal's revision, stamp `swapped_at` and re-diff the grocery list to
 *     produce the meal the user already had. This is also what makes an empty
 *     list truthful — a slot whose only eligible recipe is the one already
 *     planned answers `[]` (13d) rather than offering the user their own lunch.
 *     Matched on `recipe_version_id` and not on `recipe_id`, deliberately: after
 *     a catalog refresh republishes a dish, the meal holds the retired version
 *     while the catalog offers a NEW current version of the same recipe, and
 *     that version is a genuinely different meal to plan — often the only one
 *     still offered for that dish. The repetition rule with the current meal
 *     removed is what keeps it from breaking the week's spacing.
 *  2. IT MUST PASS PLANNING ELIGIBILITY, through `recipe.logic.ts`'s single
 *     implementation. Allergies are never relaxed to fill a short list, and
 *     neither are the structural clauses: only a `current`, `source_backed`,
 *     `allergen_status = 'known'` version that declares this slot can be a
 *     candidate. The verdict form is used rather than its boolean twin because
 *     both are the same implementation and nothing here needs a second rule.
 *  3. IT MUST NOT BREAK THE WEEK'S REPETITION RULE, against the window above.
 */
const isAdmissibleAlternative = (
    context: SwapSelectionContext,
    currentMeal: SwapDayMeal,
    repetition: RepetitionWindow,
    recipe: PlanRecipeCandidate,
): boolean => {
    if (recipe.recipe_version_id === currentMeal.recipeVersionId) {
        return false;
    }

    if (!evaluatePlanningEligibility(recipe, context.preferences, context.slot).eligible) {
        return false;
    }

    return !violatesRepetitionRule(
        recipe.recipe_id,
        repetition.usesByRecipeId.get(recipe.recipe_id) ?? 0,
        repetition.adjacentDayRecipeIds,
        repetition.sameDayRecipeIds,
    );
};

/* ---------------------------------------------------------------------------
 * Selection — the day as it stands, the portion, the list, the one candidate
 * ------------------------------------------------------------------------- */

/**
 * The day's totals as currently planned, at full precision.
 *
 * The baseline every `calorieDelta` is measured from, and the number the
 * preview's "Saturday total if you swap" card is compared against. Summed
 * through `mealPlan.logic.ts::computeDayTotals`, so it is the same arithmetic —
 * in the same order — that produced the day totals already on screen.
 */
export const currentDayTotalsFor = (context: SwapSelectionContext): MealPlanMacroTotals => {
    requireCurrentMeal(context);

    return computeDayTotals(context.dayMeals);
};

/**
 * The portion this recipe would be offered at, or `null` when none is
 * admissible.
 *
 * The rule, exactly as §0.7.3 states it: over the multipliers the slot allows,
 * take the one that MINIMISES |resulting day calories − target calories|,
 * SUBJECT TO the full day tolerance on the resulting day — the same tolerance
 * the generator accepts a finished day with, so a swap can never leave a day the
 * generator would have rejected. Note the two halves are not the same test:
 * tolerance is a hard gate over all four values (a candidate that lands the
 * day's calories exactly on target but its protein below the band is refused),
 * while the calorie distance only chooses between portions that already passed.
 *
 * Ties break toward the SMALLER multiplier, deterministically: the multipliers
 * are ascending and an equal distance does not displace the incumbent, so a
 * recipe whose half and three-quarter portions are equally far from the target
 * is offered at a half. Smaller rather than larger because the tie is a free
 * choice and the smaller portion is the more conservative one; either way it has
 * to be FIXED, or the list and the commit could pick differently for the same
 * inputs. Distances are compared within {@link TOLERANCE_EPSILON} so two
 * portions that are mathematically equidistant but summed by different paths
 * still tie instead of being separated by a rounding artefact.
 *
 * `null` is the honest answer for a recipe no portion of which fits, and the
 * caller excludes it. Offering its least-bad portion would put a day outside
 * tolerance behind a row the user has no way to evaluate.
 *
 * This function answers the PORTION question only. Whether the recipe may be
 * offered at all — eligibility, repetition, and not being the meal already in
 * the slot — belongs to {@link selectSwapCandidates}, and therefore to
 * {@link selectSwapCandidate}, which picks one of its rows: that is why the
 * list, the preview and the commit all go through those two rather than calling
 * this directly.
 */
export const selectSwapPortion = (
    context: SwapSelectionContext,
    recipe: PlanRecipeCandidate,
): SwapCandidate | null => {
    const currentMeal = requireCurrentMeal(context);
    const currentDayCalories = computeDayTotals(context.dayMeals).calories;

    let best: SwapCandidate | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;

    for (const portionMultiplier of portionMultipliersForSlot(context.slot, DEFAULT_PORTION_POLICY)) {
        const nutrition = scalePlannedNutrition(recipe.per_serving, portionMultiplier);
        // Substituted IN PLACE rather than appended, so the day is summed in the
        // order its meals are stored. `swap.service.ts` recomputes the stored day
        // totals from those same rows, and a different summation order would
        // differ from this preview in the last bits.
        const dayTotalsIfSwapped = computeDayTotals(
            context.dayMeals.map((meal) => (meal.id === currentMeal.id ? { planned: nutrition } : meal)),
        );

        if (!isDayWithinTolerance(dayTotalsIfSwapped, context.targets)) {
            continue;
        }

        const distance = Math.abs(dayTotalsIfSwapped.calories - context.targets.calories);

        if (distance >= bestDistance - TOLERANCE_EPSILON) {
            continue;
        }

        bestDistance = distance;
        best = {
            recipe,
            portionMultiplier,
            nutrition,
            dayTotalsIfSwapped,
            calorieDelta: dayTotalsIfSwapped.calories - currentDayCalories,
            targetProximity: targetProximity(dayTotalsIfSwapped, context.targets, WHOLE_DAY_SHARE),
        };
    }

    return best;
};

/**
 * The proximity a candidate is ranked by, quantised to whole
 * {@link TOLERANCE_EPSILON} steps.
 *
 * THE QUANTISATION IS WHAT MAKES THE ORDER A TOTAL ONE. The intent is that
 * float noise must not decide a rank — two candidates whose proximities are
 * mathematically equal but summed by different paths have to fall through to the
 * portable lexical keys — but "equal within epsilon" is NOT transitive, and a
 * comparator built on it is not a total order: with proximities 0, 0.75e-9 and
 * 1.5e-9 the first two are "equal", the last two are "equal", and the outer pair
 * is not, so `Array.prototype.sort` yields a different list for different input
 * orders and the list reshuffles under the user's thumb between two reads of the
 * same plan. Rounding to a bucket replaces approximate equality with real
 * equivalence classes: equal buckets are genuinely interchangeable, the tuple
 * `(bucket, slug, version)` is a total order, and the result is
 * permutation-independent. The trade-off is explicit and correct at this scale —
 * two proximities closer together than epsilon may still land in adjacent
 * buckets when they straddle a boundary, which orders them by proximity rather
 * than by slug; both are stable answers, and no third candidate can make them
 * disagree.
 *
 * THE BUCKET IS ALWAYS AN EXACT INTEGER for the values this function sees, which
 * is what lets two of them be compared for equality at all. A candidate is only
 * ranked after passing {@link isDayWithinTolerance}, so each of the four relative
 * terms {@link targetProximity} sums is bounded by its own band, and with the
 * contract's smallest legal macro target (1 g, §0.7.3) the worst conceivable sum
 * is still under about 55. Divided by epsilon that is ~5.5e10, eight orders of
 * magnitude inside `Number.MAX_SAFE_INTEGER` (9.007e15 — reached only at a
 * proximity around 9.0e6), so the rounding is exact and two equal proximities
 * cannot round to different integers.
 */
const proximityBucket = (candidate: SwapCandidate): number =>
    Math.round(candidate.targetProximity / TOLERANCE_EPSILON);

/**
 * The ranking: `(targetProximity of the resulting day bucketed to
 * {@link TOLERANCE_EPSILON}, recipe.slug, recipe.version)`, ascending.
 *
 * Exported because it IS the contract the client's "stable across refetches"
 * behaviour rests on, and a test that asserts it directly cannot be fooled by a
 * fixture that happens to order correctly for another reason.
 *
 * Deliberately PRNG-free — the generator's seeded shuffle rank has no place
 * here. Generation runs once per week and uses the seed to vary between users;
 * an alternatives list is refetched every time the sheet opens, so a seeded
 * tie-break would reorder the rows under the user's thumb between two reads of
 * the same plan. `slug` and `version` are the PORTABLE identity — stable across
 * independent catalog loads where a database id is not — so two environments
 * loaded from the same release rank identically.
 *
 * The buckets are compared with `<`/`>` rather than subtracted, for two reasons:
 * the sign is all a comparator is read for, and a proximity that is somehow not
 * a number then falls through to the lexical keys — as it did when this
 * comparison was an epsilon test — instead of returning `NaN` and leaving the
 * sort undefined.
 *
 * The epsilon inside {@link selectSwapPortion} is deliberately left as a
 * distance test and needs no such treatment: that is a linear scan over a fixed
 * ascending multiplier order keeping a single incumbent, so a near-tie resolves
 * deterministically to the smaller multiplier. Transitivity is a requirement of
 * a SORT comparator, not of a scan.
 */
export const compareSwapCandidates = (left: SwapCandidate, right: SwapCandidate): number => {
    const leftBucket = proximityBucket(left);
    const rightBucket = proximityBucket(right);

    if (leftBucket < rightBucket) {
        return -1;
    }

    if (leftBucket > rightBucket) {
        return 1;
    }

    if (left.recipe.slug !== right.recipe.slug) {
        return left.recipe.slug < right.recipe.slug ? -1 : 1;
    }

    return left.recipe.version - right.recipe.version;
};

/**
 * The alternatives for one meal: every admissible recipe version at its chosen
 * portion, ranked, truncated.
 *
 * Truncation happens AFTER the sort, so the rows are the best N and not the
 * first N the catalog yielded. The result is a fresh array in a fresh order and
 * `context.recipes` is never mutated — the caller's array is very often the
 * query result a later step reuses.
 *
 * An empty array is a real answer (13d), not an error: the slot has nothing to
 * offer under the user's own restrictions, and the client says so.
 */
export const selectSwapCandidates = (context: SwapSelectionContext): SwapCandidate[] => {
    const currentMeal = requireCurrentMeal(context);
    const repetition = repetitionWindow(context);
    const limit = resolveLimit(context.limit);

    const candidates: SwapCandidate[] = [];

    for (const recipe of context.recipes) {
        if (!isAdmissibleAlternative(context, currentMeal, repetition, recipe)) {
            continue;
        }

        const candidate = selectSwapPortion(context, recipe);

        if (candidate === null) {
            continue;
        }

        candidates.push(candidate);
    }

    return candidates.sort(compareSwapCandidates).slice(0, limit);
};

/**
 * One named candidate, taken from the LIST ITSELF — the function the preview and
 * the commit both call, which is what makes the three incapable of disagreeing.
 *
 * IT SELECTS FROM `selectSwapCandidates`' ROWS, truncation included, and that is
 * the rule rather than an implementation detail (§0.7.3: the same function is
 * "called by the alternatives list, the preview and the commit so the three
 * cannot disagree", and "the preview computes deltas for exactly the listed
 * (recipe, portion)"). A recipe the sheet never offered must not become
 * committable: the eight rows ARE the offer, and a preview or a commit reading a
 * wider set than the list is exactly the disagreement the one-function rule
 * exists to prevent — the user would be shown, and could then commit, a meal the
 * list refused to present. Deriving the answer from the list instead of
 * re-deriving it beside the list also means the portion, the resulting day and
 * the proximity are the very numbers the row carried, not a second computation
 * that happens to agree today.
 *
 * Throws {@link RecipeIneligibleError} when the recipe is not, or is no longer,
 * one of the listed candidates for this slot: it is outside the listed set, it
 * is not in the plannable set, it is the version already in the slot, a catalog
 * refresh retired it, a preference change ruled it out, the week's repetition
 * rule now refuses it, or no portion of it keeps the day inside tolerance. Every
 * one of those is the same answer to the client — `422 recipe_ineligible`, "that
 * meal no longer fits" (§0.5.2's preview row declares exactly `200` or
 * `422 recipe_ineligible`) — so they are one error rather than a taxonomy the
 * client would have to branch on.
 */
export const selectSwapCandidate = (
    context: SwapSelectionContext,
    recipeVersionId: string,
): SwapCandidate => {
    const listed = selectSwapCandidates(context).find(
        (candidate) => candidate.recipe.recipe_version_id === recipeVersionId,
    );

    if (listed === undefined) {
        throw new RecipeIneligibleError();
    }

    return listed;
};

/* ---------------------------------------------------------------------------
 * The commit — the preview binding, and the columns a swap writes
 * ------------------------------------------------------------------------- */

/** A portion at the two-decimal representation the contract stores and transports. */
const toStoredPortion = (multiplier: number): number =>
    Math.round(multiplier * PORTION_MULTIPLIER_SCALE) / PORTION_MULTIPLIER_SCALE;

/**
 * The preview binding: the committed portion must be the recomputed one.
 *
 * THE PREVIEW BINDS THE PORTION, NOT THE TARGETS. A commit carries the
 * multiplier the user saw; the server recomputes it through
 * {@link selectSwapCandidate} and compares. They diverge when something moved
 * between the preview and the commit — most often a target save, which changes
 * which multiplier minimises the day's calorie gap — and committing anyway would
 * swap in an amount of food the user never approved. {@link PreviewStaleError}
 * (`409 preview_stale`) sends the client back for a fresh preview, which mints a
 * new intent. A target change that leaves the recomputed multiplier equal is not
 * staleness and the commit proceeds.
 *
 * Compared at two decimals and with NO tolerance beyond that, deliberately: a
 * tolerance is how a genuinely different portion — a half serving against three
 * quarters — starts passing as "close enough". Any value that is not the
 * recomputed portion fails closed, a non-finite one included: there is no
 * repair that could be right, because the only correct portion is the one the
 * preview showed.
 */
export const requireBoundPortion = (requested: number, recomputed: number): void => {
    if (toStoredPortion(requested) !== toStoredPortion(recomputed)) {
        throw new PreviewStaleError();
    }
};

/**
 * The `meal_plan_meals` update a committed swap performs.
 *
 * Pure, so the audit trail is decided here and merely written by
 * `swap.service.ts`: the new version and its portion, the planned macros at FULL
 * precision (the diary rounds once on insert, and rounding here would shift
 * every number downstream), the outgoing version recorded as
 * `previous_recipe_version_id`, the INJECTED `now` as `swapped_at`, and the
 * meal's next revision so the client's `expectedPlanRevision` check has
 * something to move against.
 *
 * THE FLAGS ARE CLEARED, UNCONDITIONALLY AND WITHOUT BEING EVALUATED (§0.7.3:
 * "a swap to a compatible recipe clears that meal's flags"). The `[]` needs no
 * condition because the compatibility was already established: every candidate
 * that can reach a commit came out of {@link selectSwapCandidates} and therefore
 * passed `isAdmissibleAlternative`, whose eligibility clause is
 * `recipe.logic.ts::evaluatePlanningEligibility` against the user's CURRENT
 * preferences — the same rule `preferences.service.ts` flags a meal by. A
 * committed swap is a swap to a compatible recipe by construction, so re-deriving
 * the flags here could only produce `[]` more expensively, with a second spelling
 * of the flag rule to keep in step. Writing the column is not optional: leaving
 * the outgoing meal's flags in place would keep `getAffectedMeals` and
 * `MealPlanResponse.hasIncompatibilities` reporting a meal this selection has
 * just established as compatible, and the 16 banner would never clear.
 *
 * `now` is a parameter and never `new Date()`: a module that reads the clock
 * cannot be tested for the value it writes, and the commit's timestamp has to be
 * the transaction's own rather than whatever the last-called function observed.
 * An invalid `Date` and a revision that is not a stored revision both throw
 * {@link MealPlanInputError} rather than being written — an `Invalid Date`
 * reaches the column as a fault nobody can reconstruct, and a revision that
 * moved backwards would let a stale client's write win.
 */
export const swapMealWrite = (meal: SwapDayMeal, candidate: SwapCandidate, now: Date): SwapMealWrite => {
    if (!Number.isInteger(meal.revision) || meal.revision < MIN_MEAL_REVISION) {
        throw new MealPlanInputError(
            `meal.revision must be an integer of at least ${MIN_MEAL_REVISION} to advance, ` +
                `received ${String(meal.revision)}`,
            'revision',
        );
    }

    if (Number.isNaN(now.getTime())) {
        throw new MealPlanInputError('now must be a valid Date to stamp swapped_at with', 'now');
    }

    return {
        recipe_version_id: candidate.recipe.recipe_version_id,
        portion_multiplier: candidate.portionMultiplier,
        planned_calories: candidate.nutrition.calories,
        planned_protein_g: candidate.nutrition.protein,
        planned_carbs_g: candidate.nutrition.carbs,
        planned_fat_g: candidate.nutrition.fat,
        previous_recipe_version_id: meal.recipeVersionId,
        swapped_at: now,
        revision: meal.revision + 1,
        flags: [],
    };
};
