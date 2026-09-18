// The row -> DTO boundary for the weekly meal plan: the one place
// `meal_plans`, `meal_plan_days` and `meal_plan_meals` rows become the
// camelCase wire shapes `src/types/mealPlanning.ts` declares and the mobile
// io-ts codecs decode (`convertMealPlan.ts`, `convertMealPlanDay.ts`). One
// shape, one mapper — a second builder for any of these responses is drift, and
// drift here is a client that stops decoding.
//
// A file of its own rather than a private const in `mealPlan.service.ts`
// because THREE services return these shapes (Rule backend-architecture §6,
// "promoted to `src/services/<domain>.mapper.ts` once two services need it or
// it grows past a screenful" — this is both):
//
//  * `mealPlan.service.ts` — the plan, day and meal reads behind
//    POST /meal-planning/plans, GET .../plans/current,
//    GET .../plans/:planId/days/:date and POST .../plans/:planId/regenerate.
//  * `swap.service.ts` — the meal and day it returns from a committed swap, and
//    `formatPortionText` for the preview, so the portion a user approves reads
//    exactly as the meal they end up with.
//  * `plannedMealLog.service.ts` — the meal it returns beside the created diary
//    entry, so a logged meal comes back in the same shape the plan showed.
//
// Those services own every query; this file owns every field. Rows arrive as
// ARGUMENTS and there is no Prisma client, no `fetch`, no clock and no
// `process.env` here — a mapper that fetched would be a service. That is also
// what keeps the import graph acyclic: nothing below imports a service.
//
// THE THREE PIECES BELOW THAT ARE NOT DTO BUILDERS are here for the same
// reason and no other: each is the pure half of a read all three services
// perform, so sharing it is what keeps their answers identical while each keeps
// its own owner-scoped query.
//
//  * `groupLoggedPlannedEntries` — linked diary rows grouped by planned meal,
//    with entries a user has detached by editing dropped.
//  * `toPlanLifecycleState` — a plan row as the facts `mealPlan.logic.ts`'s
//    lifecycle rules judge, dates read as day keys and the successor flattened.
//  * `readPlannedTotals` — stored planned macros as the integers a card renders.
//
// What they are NOT is rules: which status may be written to, and which targets
// a week is judged against, are `mealPlan.logic.ts`'s (`requireWritablePlan`,
// `resolveReportedTargets`), and an orchestration fault is the raising
// service's own error class, never this file's `MealPlanMappingError`.
//
// The row types are structural snake_case interfaces rather than Prisma's
// generated models, matching `recipe.mapper.ts` and `catalog.mapper.ts`: a
// caller reading through `$queryRaw` has no model type to offer, and a mapper
// that demanded one would push its callers into casts. Prisma's own payload
// types satisfy them structurally, so an `include`d row passes without one.
//
// THE COMPOSITION CHAIN is the file's shape (§6, "composite responses get their
// own mapper that composes the smaller ones"):
//
//     toMealPlanResponse            -> toMealPlanDayResponse -> toMealPlanMealResponse
//     toMealPlanDayEnvelopeResponse -^                       -> mapPlannedRecipeSummary
//
// The envelope is the second composite: one day plus the plan facts the
// single-day read reports around it, including the effective lifecycle a client
// gates Swap and Log on.
//
// `recipe.mapper.ts` owns that last step. Every planned meal carries the same
// compact recipe projection the swap rows do, and its header names this file as
// the consumer that composes it; rebuilding the projection here would give one
// shape two sources of truth.
//
// Five conventions this file holds the line on:
//
//  * NON-NEGOTIABLE FIELDS GET REAL DEFAULTS, never an optional the client has
//    to guess about (§6). `flags` and `loggedEntries` are `[]` rather than
//    absent and `previousRecipe` is `null` rather than missing, which is what
//    lets the mobile codecs decode them without union gymnastics: an empty list
//    is the positive claim "nothing flagged" / "nothing logged".
//
//  * A BROKEN PROMISE IS A FAULT, NOT A DEFAULT. Every field the contract
//    declares non-optional is backed by a NOT NULL column, so a row that cannot
//    supply one is drift rather than a client condition and this file throws
//    `MealPlanMappingError`. `flags` is the one exception and it is deliberate: a
//    malformed flag ENTRY is dropped rather than failing the read, because the
//    alternative is a plan screen that cannot load and therefore cannot be used
//    to fix anything.
//
//  * NOTHING IS RECOMPUTED, AND ROUNDING FOR DISPLAY HAPPENS EXACTLY HERE. The
//    stored `planned_*` columns are reported as stored in every respect but
//    one: they are rounded per value, once, on their way onto the wire, because
//    this is the display boundary and the client is forbidden from rounding.
//    `readPlannedTotals` is that step and delegates to the codebase's single
//    display round; nothing else in the module is re-derived, re-summed or
//    re-ordered from anything but the rows handed in.
//
//  * CODES GO ON THE WIRE, NEVER PROSE. `slot`, `status`, the flag codes, the
//    recipe's `iconKey` and `badges` all travel as the values the database
//    stores; the client renders them through `src/constants/strings.ts`.
//    Labelling here would hard-code English into the API.
//
//  * DATES ARE READ IN UTC ONLY. See `toDayKey`. `start_date`, `end_date` and
//    `meal_plan_days.date` are `@db.Date` columns that Prisma returns as
//    midnight UTC, and reading LOCAL components on a server west of UTC would
//    shift every plan day back by one and start the seven-day strip a day
//    early.
//
// WHAT THIS FILE DOES NOT DECIDE (each belongs to a neighbour, and a rule
// re-decided here would be a rule no unit test could reach — §7, §11):
//
//  * WHAT MAKES A PLAN ENDED. `status` is reported exactly as stored, and an
//    ended plan is still `'active'` in the column by design (§0.5.1). Endedness
//    is `mealPlan.logic.ts::isPlanEnded`, which every write path applies —
//    `readPlanLifecycle` and `toMealPlanDayEnvelopeResponse` below CALL that
//    predicate with the day key their caller resolved, so the day envelope
//    reports the writers' own verdict rather than a local re-derivation of it.
//  * WHETHER A MEAL IS LOGGED. `plannedMealLog.logic.ts::deriveLoggedStatus`
//    owns that rule; this file emits the `loggedEntries` it and the client read.
//  * ELIGIBILITY, TOLERANCES, SCORING AND PORTION SETS — `mealPlan.logic.ts`
//    and `swap.logic.ts`.
//  * GROCERY DISPLAY AND RECIPE SCALING — `grocery.mapper.ts` /
//    `grocery.logic.ts` and `recipe.mapper.ts` / `recipe.logic.ts`.
//
// This is a `*.mapper.ts` and deliberately has no `__tests__` file of its own:
// `jest.config.ts` derives its per-path coverage gate from the `*.logic.ts`
// modules on disk, and these mappings are verified end to end by
// `src/__tests__/api/plans.test.ts`, `swaps.test.ts` and `log.test.ts`.

import {
    LoggedPlannedEntry,
    MealFlag,
    MealFlagCode,
    MealPlanDayEnvelopeResponse,
    MealPlanDayResponse,
    MealPlanMacroTotals,
    MealPlanMealResponse,
    MealPlanResponse,
    MealPlanSummary,
    PlanLifecycle,
    PlanStatus,
    PreviousRecipeSummary,
} from '../types/mealPlanning';
import { MealSlot } from '../types/recipe';
import { formatQuarters, pluralizeCount } from '../utils/units';
import {
    PlanLifecycleState,
    derivePortionUnit,
    isDayKey,
    isPlanActiveStatus,
    isPlanEnded,
    sameMacroTotals,
} from './mealPlan.logic';
import { isClockTime } from './preferences.logic';
import { isMealSlot, roundNutritionForDisplay } from './recipe.logic';
import { RecipeVersionRow, mapPlannedRecipeSummary } from './recipe.mapper';

/* ---------------------------------------------------------------------------
 * The one error this file throws
 * ------------------------------------------------------------------------- */

/**
 * A stored column contradicting the response contract, raised while a row is
 * being shaped into a response.
 *
 * Its own class rather than a bare `Error` so the message says which column of
 * which row could not be read, and deliberately NOT a member of
 * `mealPlanning.errors.ts`: that vocabulary is the closed set of failures the
 * CLIENT must distinguish and act on — one class per §0.5.2 machine code — and
 * there is no client action for "the plan row this server wrote is not
 * readable". It reaches the controller as a 500, exactly as
 * `grocery.service.ts`'s and `mealPlanningAction.service.ts`'s own invariant
 * faults do.
 *
 * NAMED FOR MAPPING, and scoped to it: `GroceryMappingError` and
 * `RecipeMappingError` are the sibling mappers' equivalents, and a service's own
 * invariant fault is that service's class — `mealPlan.service.ts` declares
 * `MealPlanDataError` for its reads, writes and lifecycle, `swap.service.ts`
 * `SwapDataError`, `plannedMealLog.service.ts` `PlannedMealLogWriteError`. A
 * service must never reach into this file for an orchestration error: that would
 * make the mapper the owner of its caller's error vocabulary and invert the
 * dependency the layering exists to fix.
 */
export class MealPlanMappingError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'MealPlanMappingError';
    }
}

/* ---------------------------------------------------------------------------
 * Constants
 * ------------------------------------------------------------------------- */

/** Characters of a `YYYY-MM-DD` day key — the ISO prefix `toDayKey` slices. */
const DAY_KEY_LENGTH = 10;

/**
 * The four macro keys every stored macro column must carry, in wire order.
 *
 * Read from one list rather than spelled out per key so the checks below and the
 * objects they build cannot disagree about which four they are.
 */
const MACRO_KEYS = ['calories', 'protein', 'carbs', 'fat'] as const;

/**
 * Membership tests keyed off the DTO's own unions, so they are exhaustive by
 * construction: widening `MealFlagCode` or `PlanStatus` in
 * `types/mealPlanning.ts` stops these literals compiling until the new member is
 * handled here. The construction `recipe.mapper.ts` and `preferences.service.ts`
 * both use, and for the same stated reason — a hand-listed array of the same
 * strings falls behind the contract silently.
 */
const MEAL_FLAG_CODES: Readonly<Record<MealFlagCode, true>> = {
    diet: true,
    allergen: true,
    dislike: true,
    cooking_time: true,
};

const PLAN_STATUSES: Readonly<Record<PlanStatus, true>> = { active: true, superseded: true };

/**
 * The three `PlanLifecycle` members, named so the values the envelope reports
 * are typed against the union rather than written as bare strings at three call
 * sites. `ACTIVE_LIFECYCLE` doubles as the one definition of `isWritable`.
 */
const ACTIVE_LIFECYCLE: PlanLifecycle = 'active';
const ENDED_LIFECYCLE: PlanLifecycle = 'ended';
const SUPERSEDED_LIFECYCLE: PlanLifecycle = 'superseded';

/* ---------------------------------------------------------------------------
 * Reading a stored column into the type the contract promises
 *
 * The database is snake_case and the wire is camelCase; the translation happens
 * here and nowhere else for these three shapes (Rule backend-architecture §6,
 * §10 — Prisma's models are NOT renamed to match the DTOs). Every `jsonb`
 * column arrives as `unknown` and is READ DEFENSIVELY, never asserted, because
 * a column is data to inspect rather than a shape to assume.
 * ------------------------------------------------------------------------- */

const asRecord = (value: unknown): Record<string, unknown> | null =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;

const asMember = <T extends string>(set: Readonly<Record<T, true>>, value: unknown): T | null =>
    typeof value === 'string' && Object.prototype.hasOwnProperty.call(set, value) ? (value as T) : null;

/**
 * A stored `@db.Date` as a `YYYY-MM-DD` day key, from its UTC components and
 * nothing else.
 *
 * The repository's `toDayKey` convention, spelled the same way in
 * `nutrition.service.ts`, `preferences.service.ts` and `grocery.mapper.ts`: the
 * column holds a calendar day, Prisma returns it as midnight UTC, and reading
 * LOCAL components on a server west of UTC would move a plan's last day back by
 * one and end the week a day early. Never a locale formatter either, for the
 * same reason.
 *
 * The result is validated with `mealPlan.logic.ts::isDayKey` rather than
 * trusted, which catches the one case slicing cannot: `toISOString` switches to
 * an expanded, sign-prefixed year outside the four-digit range, so a corrupt
 * date would otherwise yield a ten-character string that is not a day key at
 * all. An unparseable value is named rather than left to surface as
 * `toISOString`'s bare `RangeError`.
 */
export const toDayKey = (date: Date, column: string, rowId: string): string => {
    if (!Number.isFinite(date.getTime())) {
        throw new MealPlanMappingError(`${column} on row ${rowId} is not a valid date`);
    }

    const dayKey = date.toISOString().slice(0, DAY_KEY_LENGTH);

    if (!isDayKey(dayKey)) {
        throw new MealPlanMappingError(
            `${column} on row ${rowId} is ${date.toISOString()}, which is not a YYYY-MM-DD calendar date`,
        );
    }

    return dayKey;
};

/**
 * The stored `meal_plan_meals.flags` column as the DTO's flags.
 *
 * VALIDATED, never asserted, and defensive PER ENTRY: a malformed entry is
 * dropped rather than failing the whole read, because the alternative is a plan
 * screen that cannot load — and therefore cannot be used to fix anything. The
 * same reading `preferences.service.ts` applies where it WRITES the column, so a
 * flag written there round-trips through here unchanged.
 *
 * An array of `{code, detail}` objects rather than of bare codes, because
 * several details can share one code: two milk-bearing meals both flag
 * `allergen` with their own ingredient names. Collapsing this to a code array or
 * to a map keyed by code would lose them.
 */
export const readStoredFlags = (stored: unknown): MealFlag[] => {
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
 * What kind of value a key holds, WITHOUT the value itself.
 *
 * `'a string'`, `'absent'`, `'a non-finite number'` — enough for an engineer to
 * see why a column would not read, and nothing a log must not hold.
 */
const describeValueKind = (value: unknown): string => {
    if (value === undefined) {
        return 'absent';
    }

    if (value === null) {
        return 'null';
    }

    if (typeof value === 'number') {
        return 'a non-finite number';
    }

    return `a ${typeof value}`;
};

/**
 * Which of the four macro keys are unreadable, and how — never what they hold.
 *
 * A STORED TARGETS SNAPSHOT IS USER DATA: it is the calorie and macro figures
 * this person eats to. Serialising the column into the exception message put
 * those figures — and, for a corrupted column, whatever else the JSON held —
 * into every log line the controller writes for the fault (CWE-532: insertion of
 * sensitive information into log output). The diagnosis does not need them. The
 * plan id locates the row for anyone authorised to read it, and the key names
 * with their value kinds say what is wrong, which is what a fix starts from.
 */
const describeMacroDefects = (record: Record<string, unknown> | null): string => {
    if (record === null) {
        return 'the column is not a JSON object';
    }

    const defects = MACRO_KEYS.filter(
        (key) => !(typeof record[key] === 'number' && Number.isFinite(record[key])),
    ).map((key) => `${key} is ${describeValueKind(record[key])}`);

    return defects.length === 0 ? 'no macro key is unreadable' : defects.join(', ');
};

/**
 * The stored `meal_plans.targets_snapshot` column as four macro values.
 *
 * THROWS rather than defaulting, and that is the right trade here even though
 * the flags above are read leniently. The two columns fail differently: a
 * missing flag understates an incompatibility the user can still see on the meal
 * itself, while a fabricated snapshot would report that the week was built
 * against zero calories — it would make `targetsStale` meaningless and caption a
 * plan with a target nobody ever set. The column is written from four confirmed
 * positive numbers, so an unreadable value is a data fault to surface and fix.
 */
export const readTargetsSnapshot = (stored: unknown, planId: string): MealPlanMacroTotals => {
    const record = asRecord(stored);
    const values = MACRO_KEYS.map((key) => record?.[key]);

    if (!values.every((value): value is number => typeof value === 'number' && Number.isFinite(value))) {
        throw new MealPlanMappingError(
            `meal_plans.targets_snapshot on plan ${planId} does not carry four finite macro values ` +
                `(${describeMacroDefects(record)}); the plan it was built against cannot be reported without them`,
        );
    }

    const [calories, protein, carbs, fat] = values;

    return { calories, protein, carbs, fat };
};

/**
 * Stored planned macros as the four integers a card renders.
 *
 * STEP 2 OF THE ROUNDING CONTRACT (§0.7.3), and the reason it is this file's
 * job: `recipe.logic.ts::scalePlannedNutrition` computes a planned portion at
 * full precision, the columns store it that way, `mealPlan.logic.ts
 * ::computeDayTotals` sums it that way — and the only place a number becomes
 * something a person reads is here, on its way onto the wire. The client is
 * forbidden from rounding (its converter schema bans `Math.round` outright), so
 * a fractional value on the wire is a fractional value on the screen, where
 * Figma's plan card reads "420 cal".
 *
 * It is also what keeps the client's arithmetic and the server's agreeing to the
 * integer. The diary snapshot is rounded once on insert and consumed totals are
 * `round(snapshot × servings)`; a card carrying 419.6 at 1½ servings would show
 * 629 while the entry the server writes says 630. Rounded here, both say 630.
 *
 * The rounding itself is delegated to `recipe.logic.ts::roundNutritionForDisplay`
 * — the ONE display round in the codebase — so the plan card, the swap preview
 * and the alternatives list cannot each round differently. Finiteness is checked
 * HERE first so the fault names the column and the row that hold the bad value,
 * rather than surfacing as a recipe-derivation error about an anonymous number.
 *
 * PER-VALUE AND INDEPENDENT: a meal is rounded as a meal and a day as a day, so
 * a day total may differ by up to a unit or two from adding up the rounded meals
 * beside it. That is the correct trade — the day is the sum of what was actually
 * planned rather than the sum of four display strings — and it is stated here so
 * the next reader does not "fix" it by rounding the day out of the meals.
 */
export const readPlannedTotals = (stored: MealPlanMacroTotals, column: string, rowId: string): MealPlanMacroTotals => {
    const offending = MACRO_KEYS.filter((key) => !Number.isFinite(stored[key]));

    if (offending.length > 0) {
        throw new MealPlanMappingError(
            `${column} on row ${rowId} is not four finite numbers — ${offending.join(', ')} cannot be rounded ` +
                'for display',
        );
    }

    return roundNutritionForDisplay(stored);
};

/**
 * The stored `meal_plans.status` column as the DTO's two-value union.
 *
 * An unrecognised value is a fault rather than a default: the two statuses mean
 * "you may write to this" and "follow the replacement", and guessing either
 * would let a stale screen mutate a plan or send the user nowhere. Note that an
 * ENDED plan is `'active'` here by design — §0.5.1 keeps the column as it is and
 * makes endedness a RULE (`mealPlan.logic.ts::isPlanEnded`) that every write
 * path applies, so this function reports the column and never reinterprets it.
 * {@link readPlanLifecycle} is where that rule is applied to say what the column
 * MEANS on a given calendar day; a caller wanting to know whether a plan still
 * accepts writes wants that one, not this.
 */
export const readPlanStatus = (stored: string, planId: string): PlanStatus => {
    const status = asMember(PLAN_STATUSES, stored);

    if (status === null) {
        throw new MealPlanMappingError(
            `meal_plans.status on plan ${planId} is "${stored}", which is neither "active" nor "superseded"`,
        );
    }

    return status;
};

/**
 * A plan row and the caller's calendar day as the DTO's effective lifecycle.
 *
 * The one place the stored status and the plan's dates are read TOGETHER. An
 * `'active'` row whose last date has passed in the user's zone is `'ended'` —
 * the state §0.5.1 defines and no column holds — while a stored `'superseded'`
 * row stays `'superseded'` however its dates fall, because following the
 * replacement is what a client does about it either way.
 *
 * Both halves come from `mealPlan.logic.ts`, so this is the rule REPORTED and
 * not a second copy of it: `isPlanActiveStatus` decides which status accepts
 * writes and `isPlanEnded` owns the date comparison (including the rejection of
 * a malformed day key, which is why `today` is not re-validated here).
 *
 * Unlike `requireWritablePlan`, a superseded plan does NOT have to have its
 * successor resolved here. That function raises on an unresolved one because
 * following the link is the whole point of its refusal; a READ may not fail for
 * it, because the day payload — the diary's history — is the answer the caller
 * came for.
 *
 * `today` is a `YYYY-MM-DD` key resolved by the caller in the user's stored
 * zone; passing the server's day would report a finished week as live for every
 * user east of it for up to a day.
 */
export const readPlanLifecycle = (
    plan: { id: string; status: string; end_date: Date },
    today: string,
): PlanLifecycle => {
    if (!isPlanActiveStatus(plan)) {
        return SUPERSEDED_LIFECYCLE;
    }

    const endDate = toDayKey(plan.end_date, 'meal_plans.end_date', plan.id);

    return isPlanEnded({ end_date: endDate }, today) ? ENDED_LIFECYCLE : ACTIVE_LIFECYCLE;
};

/**
 * The stored `meal_plan_meals.slot` column as the slot union.
 *
 * `recipe.logic.ts::isMealSlot` decides membership, so the vocabulary has one
 * owner. A meal whose slot is unreadable is a fault: the slot is what the
 * portion set, the eligibility clause and the day's ordering all turn on, so
 * reporting a guessed one would describe a meal that was never planned.
 */
export const readMealSlot = (stored: string, mealId: string): MealSlot => {
    if (!isMealSlot(stored)) {
        throw new MealPlanMappingError(
            `meal_plan_meals.slot on meal ${mealId} is "${stored}", which is not a meal slot`,
        );
    }

    return stored;
};

/**
 * The stored `meal_plan_meals.slot_time` column as an `HH:mm` clock time.
 *
 * `preferences.logic.ts::isClockTime` decides the format, so the one definition
 * the schedule parser enforces on the way in is the one applied on the way out.
 * It is also what makes the day's ordering meaningful: `toMealPlanDayResponse`
 * sorts on this string, which only works because every stored value is a
 * zero-padded 24-hour time.
 *
 * Private, unlike its neighbours: only the meal mapper reads this column, while
 * the others are also read by `mealPlan.service.ts`'s affected-meals and
 * lifecycle paths. Exporting it would be API surface with no caller.
 */
const readSlotTime = (stored: string, mealId: string): string => {
    if (!isClockTime(stored)) {
        throw new MealPlanMappingError(
            `meal_plan_meals.slot_time on meal ${mealId} is "${stored}", which is not an HH:mm time`,
        );
    }

    return stored;
};

/* ---------------------------------------------------------------------------
 * Portion text — ONE definition
 * ------------------------------------------------------------------------- */

/**
 * A portion multiplier as the string the plan card and the swap preview render,
 * in the recipe's OWN serving unit: `'1 bowl'`, `'½ wrap'`, `'1¼ plates'`, and
 * `'1 serving'` only for a recipe whose serving description gives no usable unit.
 *
 * THE ONE DEFINITION, exported for that reason: `MealPlanMealResponse
 * .portionText` and `SwapPreviewAlternative.portionText` describe the same
 * quantity, and the preview a user approves must read exactly as the meal they
 * end up with. A second spelling in `swap.service.ts` is how the two come to
 * disagree over three quarters of a serving.
 *
 * THE UNIT IS THE RECIPE'S, not this module's. `serving_description` is what the
 * recipe states one serving is — a bowl, a plate, a wrap — and rendering every
 * recipe as an anonymous "serving" would throw that away on the two screens
 * where the user is deciding how much to eat. Which descriptions yield a usable
 * unit is `mealPlan.logic.ts::derivePortionUnit`'s rule, not a formatting
 * detail; this function only composes the string from it, so a caller that has
 * the recipe row hands over the column and gets the recipe's own noun back.
 *
 * The glyph comes from `utils/units.ts::formatQuarters` — the same renderer the
 * grocery list uses for cups and tablespoons — because every allowed multiplier
 * (`{0.5, 0.75, 1, 1.25, 1.5, 1.75, 2}`, snacks `{0.5 … 1.5}`) is an exact
 * quarter, so nothing is rounded away. The noun is inflected by that module's
 * `pluralizeCount`, so every unit has one plural in the codebase.
 *
 * Singular AT OR BELOW one and plural above it: "½ bowl" is the English a
 * reader expects, while `pluralizeCount`'s own numeric rule (plural for anything
 * but exactly one) would render "½ bowls". The count handed to it is therefore
 * the INFLECTION, not the quantity — the quantity is already in the glyph.
 */
export const formatPortionText = (portionMultiplier: number, servingDescription: string | null): string => {
    if (!Number.isFinite(portionMultiplier) || portionMultiplier <= 0) {
        throw new MealPlanMappingError(
            `portion_multiplier must be a finite number greater than 0 to render, received ` +
                `${String(portionMultiplier)}`,
        );
    }

    const noun = pluralizeCount(portionMultiplier > 1 ? 2 : 1, derivePortionUnit(servingDescription));

    return `${formatQuarters(portionMultiplier)} ${noun}`;
};

/* ---------------------------------------------------------------------------
 * The row contracts — what each mapper needs to be handed
 *
 * Structural and snake_case, so Prisma's `include`d payloads satisfy them
 * without a cast and a `$queryRaw` caller can satisfy them too. Each declares
 * only the columns the mapping reads: a projection that grew a column this file
 * ignores should not have to be re-declared here.
 * ------------------------------------------------------------------------- */

/**
 * The recipe version a slot held before its last swap, as the audit join
 * projects it.
 *
 * Two columns because two are all the DTO names. `previous_recipe_version_id` is
 * nullable and `ON DELETE SET NULL`, so the join legitimately returns nothing.
 */
export interface PreviousRecipeVersionRow {
    id: string;
    name: string;
}

/** One `meal_plan_meals` row, without its recipe version. */
export interface PlanMealRow {
    id: string;
    revision: number;
    slot: string;
    slot_time: string;
    sort_order: number;
    portion_multiplier: number;
    planned_calories: number;
    planned_protein_g: number;
    planned_carbs_g: number;
    planned_fat_g: number;
    /**
     * `jsonb NOT NULL DEFAULT '[]'`, typed `unknown` because a JSON column is
     * data to inspect rather than a shape to assume — `readStoredFlags` reads it.
     */
    flags: unknown;
    previous_recipe_versions: PreviousRecipeVersionRow | null;
}

/**
 * One planned meal with the recipe version its summary is mapped from.
 *
 * The version is a separate member rather than folded into `PlanMealRow`
 * because `toMealPlanMealResponse` takes it as its own argument: a caller that
 * loaded the version separately — the swap commit, which maps the meal against
 * the recipe it is moving TO — can map without restuffing the row it read.
 */
export interface PlanMealWithRecipeRow extends PlanMealRow {
    recipe_versions: RecipeVersionRow;
}

/** One `meal_plan_days` row, without its meals. */
export interface PlanDayRow {
    id: string;
    /** `@db.Date`, so midnight UTC — read through `toDayKey` and never locally. */
    date: Date;
    day_index: number;
    planned_calories: number;
    planned_protein_g: number;
    planned_carbs_g: number;
    planned_fat_g: number;
}

/** One day with its meals, as a plan read returns it. */
export interface PlanDayWithMealsRow extends PlanDayRow {
    meal_plan_meals: readonly PlanMealWithRecipeRow[];
}

/**
 * The `meal_plans` columns a plan response reports.
 *
 * `incompatibility_flags` is deliberately absent: it is an audit record, and
 * `hasIncompatibilities` is derived from the MEALS' own flags, because two
 * sources for one fact is how a banner outlives the meal that caused it.
 */
export interface PlanRow {
    id: string;
    revision: number;
    generation_attempt: number;
    /**
     * The idempotency key the publishing write carried, reported so a client can
     * recognise a plan as the product of its own unresolved request.
     */
    generation_key: string;
    /** `@db.Date`. */
    start_date: Date;
    /** `@db.Date`. */
    end_date: Date;
    status: string;
    preferences_revision: number;
    targets_revision: number;
    /** `jsonb NOT NULL` — read through `readTargetsSnapshot`. */
    targets_snapshot: unknown;
}

/* ---------------------------------------------------------------------------
 * What the caller must resolve, because a mapper cannot
 * ------------------------------------------------------------------------- */

/**
 * The diary entries linked to this plan's meals, keyed by `meal_plan_meal_id`.
 *
 * Handed in rather than looked up because they are the diary's rows, not the
 * plan's — the one part of a plan DTO that cannot be derived from plan tables.
 * The caller is responsible for the two predicates that make them truthful:
 * `deleted_at IS NULL` and the owner's `user_id`.
 *
 * A meal absent from the map has nothing logged, which is why every mapper
 * below defaults to an empty list rather than treating absence as unknown.
 */
export type LoggedEntriesByMealId = ReadonlyMap<string, readonly LoggedPlannedEntry[]>;

/**
 * One linked diary entry as the read that fetched it returns it.
 *
 * `meal_plan_meal_id`, `recipe_version_id` and the joined `recipe_versions` are
 * nullable because the COLUMNS are: `nutrition.service.ts::updateMealEntry`
 * clears the links when a user edits an entry's name or macros, detaching it
 * from the plan. {@link groupLoggedPlannedEntries} drops such a row.
 */
export interface LoggedPlannedEntryRow {
    id: string;
    date: Date;
    servings: number;
    logged_at: Date;
    meal_plan_meal_id: string | null;
    recipe_version_id: string | null;
    meals: { name: string };
    recipe_versions: { name: string } | null;
}

/**
 * Linked diary rows grouped by the planned meal they belong to.
 *
 * THE ROW→SHAPE HALF of the plan's logged state, and the half that is pure: the
 * read itself is owner-scoped I/O and belongs to whichever service is
 * performing it — the plan reads, the swap's read-back and the planned-log's
 * read-back all need this same grouping, and three copies of it are three
 * chances to order or detach differently.
 *
 * A DETACHED ENTRY IS DROPPED, not defaulted. An entry whose plan link was
 * cleared is no longer evidence that this meal was eaten, so including it with
 * a placeholder recipe would light the LOGGED badge for a meal the user has
 * since rewritten by hand. The three nullable fields are checked together
 * because `updateMealEntry` clears them together.
 *
 * Ordering is NOT established here — {@link toMealPlanMealResponse} sorts each
 * meal's list through `byLoggedAt`, so the contract's order is a property of the
 * DTO rather than of whichever query produced the rows.
 */
export const groupLoggedPlannedEntries = (
    entries: readonly LoggedPlannedEntryRow[],
): Map<string, LoggedPlannedEntry[]> => {
    const byMealId = new Map<string, LoggedPlannedEntry[]>();

    for (const entry of entries) {
        if (entry.meal_plan_meal_id === null || entry.recipe_version_id === null || entry.recipe_versions === null) {
            continue;
        }

        const logged: LoggedPlannedEntry = {
            entryId: entry.id,
            date: toDayKey(entry.date, 'meal_entries.date', entry.id),
            mealName: entry.meals.name,
            servings: entry.servings,
            loggedAt: entry.logged_at.toISOString(),
            recipeVersionId: entry.recipe_version_id,
            recipeName: entry.recipe_versions.name,
        };

        const existing = byMealId.get(entry.meal_plan_meal_id);

        if (existing) {
            existing.push(logged);
        } else {
            byMealId.set(entry.meal_plan_meal_id, [logged]);
        }
    }

    return byMealId;
};

/**
 * One `meal_plans` row with its replacement, as a lifecycle read returns it.
 *
 * `replaced_by_plans` is the relation ordered and taken to one by the caller;
 * an empty array means nothing superseded this plan.
 */
export interface PlanLifecycleRow {
    id: string;
    status: string;
    start_date: Date;
    end_date: Date;
    replaced_by_plans: readonly { id: string }[];
}

/**
 * A stored plan row as the facts `mealPlan.logic.ts`'s lifecycle rules turn on.
 *
 * The snake_case→day-key translation and nothing else: `status` is passed
 * through as stored (an ENDED plan is still `'active'` in the column, and which
 * status makes a plan unwritable is `requireWritablePlan`'s rule, not this
 * file's), and the replacement id is flattened out of the relation.
 *
 * Shared because THREE services need one plan's writability — the plan service,
 * the swap and the planned log — and each performs its own owner-scoped read
 * (§5.1). What they must not each own is the reading of the dates: a plan whose
 * `start_date` were read in local time on a server west of UTC would be judged
 * against yesterday's calendar, and that decision belongs in one place.
 */
export const toPlanLifecycleState = (plan: PlanLifecycleRow): PlanLifecycleState => ({
    id: plan.id,
    status: plan.status,
    start_date: toDayKey(plan.start_date, 'meal_plans.start_date', plan.id),
    end_date: toDayKey(plan.end_date, 'meal_plans.end_date', plan.id),
    replacement_plan_id: plan.replaced_by_plans[0]?.id ?? null,
});

/** What `toMealPlanDayResponse` needs beyond the day's own rows. */
export interface MealPlanDayContext {
    /**
     * The plan's `end_date` as a day key. `isLastDay` is this comparison, so the
     * caller reads it from the parent plan — a day read on its own joins it.
     */
    endDate: string;
    loggedByMealId: LoggedEntriesByMealId;
}

/** What `toMealPlanResponse` needs beyond the plan's own rows. */
export interface MealPlanResponseContext {
    /**
     * The user's CURRENT confirmed targets, read through
     * `targets.service.ts::getTargets` so the plan card, Account and the diary
     * all show one number. `targetsStale` is derived from these against the
     * stored snapshot, so a caller that cannot read four complete values should
     * pass the snapshot itself: the comparison then reports "not stale", which
     * is truthful, where inventing zeros would caption a plan against a target
     * nobody set.
     */
    targets: MealPlanMacroTotals;
    /** Real counts, never estimates — the regeneration dialog binds its rows to these. */
    summary: MealPlanSummary;
    loggedByMealId: LoggedEntriesByMealId;
}

/* ---------------------------------------------------------------------------
 * Ordering — made true here rather than assumed of the query
 * ------------------------------------------------------------------------- */

/**
 * Two strings by UTF-16 code unit.
 *
 * Deliberately NOT `String.prototype.localeCompare`, which is the decision
 * `grocery.mapper.ts::byListPosition` and `mealPlanningAction.logic.ts
 * ::byCodeUnit` each record for themselves: its ordering depends on the
 * runtime's locale and ICU data, so two servers could order one plan's days or
 * one meal's entries differently and "the latest entry" would stop being a
 * defined thing.
 *
 * Code-unit order is also CHRONOLOGICAL order for both formats sorted below —
 * zero-padded `HH:mm` and the `toISOString` timestamps the caller builds
 * `loggedAt` from — which is what makes a string compare the right tool here
 * rather than a date parse.
 */
const byCodeUnit = (left: string, right: string): number => (left === right ? 0 : left < right ? -1 : 1);

/**
 * A day's meals in clock order.
 *
 * SORTED ON `slot_time`, which is the order the day view renders and NOT the
 * order the slots are named in: the schedule parser deliberately places no
 * ordering constraint on the stored times, so a 15:30 snack legitimately falls
 * between lunch and dinner (Figma 07).
 *
 * `sort_order` then `id` break a tie, so two slots sharing a time still come
 * back in one stable order across reads rather than in whatever order the
 * database happened to return. Sorting a COPY, because mutating a caller's array
 * is a side effect a pure mapper must not have.
 */
const byClockTime = (meals: readonly PlanMealWithRecipeRow[]): PlanMealWithRecipeRow[] =>
    [...meals].sort(
        (left, right) =>
            byCodeUnit(left.slot_time, right.slot_time) ||
            left.sort_order - right.sort_order ||
            byCodeUnit(left.id, right.id),
    );

/**
 * One meal's logged entries in the order the contract promises: `loggedAt`
 * ascending, then `entryId`.
 *
 * Re-sorted here rather than trusted from the caller's `ORDER BY`, so the
 * ordering is a property of the DTO instead of a property of one query. It is
 * load-bearing and not cosmetic: it makes "the latest entry" a defined thing, so
 * the client's "View in diary" always targets the same row and two reads of one
 * plan never reorder the captions. `entryId` breaks a tie at the same instant,
 * which two taps a millisecond apart can genuinely produce.
 */
const byLoggedAt = (entries: readonly LoggedPlannedEntry[]): LoggedPlannedEntry[] =>
    [...entries].sort(
        (left, right) => byCodeUnit(left.loggedAt, right.loggedAt) || byCodeUnit(left.entryId, right.entryId),
    );

/* ---------------------------------------------------------------------------
 * The DTO boundary — one row shape, one mapper (Rule §6)
 * ------------------------------------------------------------------------- */

/** The recipe this slot held before its last swap, or null when it was never swapped. */
const mapPreviousRecipe = (meal: PlanMealRow): PreviousRecipeSummary | null =>
    meal.previous_recipe_versions === null
        ? null
        : { versionId: meal.previous_recipe_versions.id, name: meal.previous_recipe_versions.name };

/**
 * One `meal_plan_meals` row as the wire shape.
 *
 * `recipe` is `recipe.mapper.ts::mapPlannedRecipeSummary`'s output and is never
 * hand-built here: that function owns the projection, narrows `iconKey` and
 * `badges` to their closed sets, and asserts `nutritionProvenance` against the
 * stored column so a planned meal is never presented as an estimate. Planning
 * admits only source-backed recipes, so the literal is true by construction —
 * but it is checked rather than assumed, because emitting it for a row that says
 * otherwise would present an estimate as verified nutrition.
 *
 * `flags`, `loggedEntries` and `previousRecipe` carry REAL DEFAULTS — `[]`, `[]`
 * and `null` — never an absent member the client has to guess about (§6). An
 * empty list here is the positive claim "nothing flagged" / "nothing logged".
 *
 * `loggedEntries` IS A LIST, not a boolean and not one value, because a
 * deliberate second serving is a distinct entry and two clients logging under
 * two keys are two intents by design. Each entry's `recipeName` is the name of
 * the version THAT ENTRY references — joined by the caller from the entry's own
 * `recipe_versions` row, never copied from this meal's current recipe — which is
 * what lets the logged-then-swapped caption name the recipe actually eaten after
 * A -> B -> C.
 *
 * THE LOGGED STATE ITSELF IS NOT A FIELD, and that is the design. The meal reads
 * as logged when an entry references the current `recipe.versionId`, and gets the
 * logged-then-swapped treatment when entries reference only a DIFFERENT version;
 * `plannedMealLog.logic.ts::deriveLoggedStatus` is where that rule lives and the
 * client derives the card from the same list. Because it is derived live on every
 * read, deleting the diary entry clears the logged state with no `is_logged`
 * column to correct, editing servings changes only what was consumed, and a name
 * or macro edit detaches the entry (`nutrition.service.ts::updateMealEntry`
 * clears its `recipe_version_id`) so it stops counting here too.
 *
 * `previousRecipe` is an AUDIT value — the version this slot held before its
 * last swap — and never the source of logged state: with A logged and the slot
 * swapped to B and then to C it says B, while the entries still say A.
 */
export const toMealPlanMealResponse = (
    meal: PlanMealRow,
    recipeVersion: RecipeVersionRow,
    loggedEntries: readonly LoggedPlannedEntry[],
): MealPlanMealResponse => ({
    id: meal.id,
    revision: meal.revision,
    slot: readMealSlot(meal.slot, meal.id),
    slotTime: readSlotTime(meal.slot_time, meal.id),
    sortOrder: meal.sort_order,
    recipe: mapPlannedRecipeSummary(recipeVersion),
    portionMultiplier: meal.portion_multiplier,
    portionText: formatPortionText(meal.portion_multiplier, recipeVersion.serving_description),
    planned: readPlannedTotals(
        {
            calories: meal.planned_calories,
            protein: meal.planned_protein_g,
            carbs: meal.planned_carbs_g,
            fat: meal.planned_fat_g,
        },
        'meal_plan_meals.planned_*',
        meal.id,
    ),
    flags: readStoredFlags(meal.flags),
    loggedEntries: byLoggedAt(loggedEntries),
    previousRecipe: mapPreviousRecipe(meal),
});

/**
 * One `meal_plan_days` row and its meals as the wire shape.
 *
 * `plannedTotals` comes from the STORED `planned_*` columns rather than from
 * re-summing the meals. The two agree — generation writes the sum and a swap
 * rewrites it in the same transaction that rewrites the meal — and reading the
 * column is what makes that agreement checkable: a day whose stored total had
 * drifted would be visible, where a re-sum would silently paper over it.
 *
 * THE COLUMNS HOLD FULL PRECISION AND THE WIRE CARRIES INTEGERS. Both the day's
 * totals and each meal's go through {@link readPlannedTotals}, which is step 2
 * of the rounding contract (§0.7.3) and is documented there. The three
 * objections that argue for reporting the stored floats all dissolve on
 * inspection:
 *
 *  - `plannedTotals === computeDayTotals(meals)` is a STORAGE invariant, held
 *    over the full-precision values `mealPlan.logic.ts` sums and the transaction
 *    writes. Rounding at the wire boundary does not touch either side of it, and
 *    `mealPlan.logic.ts`'s tests assert it where it lives.
 *  - the swap preview reports the same quantity, so it rounds the same way
 *    (`swap.service.ts::getSwapPreview`) while the COMMIT keeps storing the
 *    full-precision total it computed. Preview and day therefore agree to the
 *    integer, which is exactly what "the day you approved" means to a reader.
 *  - rounding is a display concern owned by ONE function,
 *    `recipe.logic.ts::roundNutritionForDisplay` — and this is the display
 *    boundary. Calling it here is what stops the client rounding, which its
 *    converter is forbidden to do, and what makes the client's
 *    `round(snapshot × servings)` land on the integer the server stores.
 *
 * Each value is rounded once, and meals and days are rounded independently, so a
 * day total can sit a unit or two away from the sum of the rounded meals shown
 * beside it. See {@link readPlannedTotals}.
 *
 * `isLastDay` is `date === endDate`, the plan's seventh day, which is where the
 * client offers the next week. Derived from the plan's own end date rather than
 * from `day_index === 6`, so a day stored with a wrong index cannot move the
 * offer to the wrong card.
 */
export const toMealPlanDayResponse = (
    day: PlanDayRow,
    meals: readonly PlanMealWithRecipeRow[],
    context: MealPlanDayContext,
): MealPlanDayResponse => {
    const date = toDayKey(day.date, 'meal_plan_days.date', day.id);

    return {
        id: day.id,
        date,
        dayIndex: day.day_index,
        plannedTotals: readPlannedTotals(
            {
                calories: day.planned_calories,
                protein: day.planned_protein_g,
                carbs: day.planned_carbs_g,
                fat: day.planned_fat_g,
            },
            'meal_plan_days.planned_*',
            day.id,
        ),
        isLastDay: date === context.endDate,
        meals: byClockTime(meals).map((meal) =>
            toMealPlanMealResponse(meal, meal.recipe_versions, context.loggedByMealId.get(meal.id) ?? []),
        ),
    };
};

/**
 * A whole plan as the wire shape — the composite that composes the two mappers
 * above (§6), so a plan, a day read on its own and the day returned by a swap
 * are the same shape built by the same code.
 *
 * THE TWO TARGET SETS ARE BOTH REPORTED, and the difference between them is the
 * point. `targets` is what the user's targets are NOW (the same values Account
 * and the diary show); `generationTargets` is the snapshot this week was
 * actually searched against; `targetsStale` is simply their inequality. Emitting
 * both is what lets the planned-totals card show live targets and caption
 * "Targets changed since this plan was built" — nothing regenerates on its own,
 * because a plan the user is part-way through is not something to rebuild
 * underneath them.
 *
 * `hasIncompatibilities` is ANY meal carrying a flag, derived from the meals
 * this response already carries so the banner turns on exactly the flags the
 * client can see. `meal_plans.incompatibility_flags` is an audit record and is
 * deliberately not read as authority — two sources for one fact is how a banner
 * outlives the meal that caused it.
 *
 * `status` is the stored value and nothing more. A plan past its `end_date` is
 * still `'active'` in the column by design; endedness is
 * `mealPlan.logic.ts::isPlanEnded`, applied by the write paths, and inventing a
 * third status here would put that rule in a second place.
 *
 * `days` are sorted by date, so "the seven days, in date order" is a property of
 * the DTO rather than of the caller's `ORDER BY`. The keys are `YYYY-MM-DD`, for
 * which code-unit order is chronological order.
 */
export const toMealPlanResponse = (
    plan: PlanRow,
    days: readonly PlanDayWithMealsRow[],
    context: MealPlanResponseContext,
): MealPlanResponse => {
    const generationTargets = readTargetsSnapshot(plan.targets_snapshot, plan.id);
    const endDate = toDayKey(plan.end_date, 'meal_plans.end_date', plan.id);

    const dayResponses = days
        .map((day) =>
            toMealPlanDayResponse(day, day.meal_plan_meals, {
                endDate,
                loggedByMealId: context.loggedByMealId,
            }),
        )
        .sort((left, right) => byCodeUnit(left.date, right.date));

    return {
        id: plan.id,
        revision: plan.revision,
        generationAttempt: plan.generation_attempt,
        // An additive extra rather than a §0.5.2 member, and therefore optional
        // on the DTO: it is populated here for every published plan
        // (`meal_plans.generation_key` is NOT NULL, no fallback) so the screen
        // that owns a pending generation can recognise its own result (§0.7.4),
        // while a client is built to tolerate its absence. `ownership.test.ts`
        // pins that this mapper keeps sending it, which is what the optional
        // declaration no longer does.
        generationKey: plan.generation_key,
        startDate: toDayKey(plan.start_date, 'meal_plans.start_date', plan.id),
        endDate,
        status: readPlanStatus(plan.status, plan.id),
        targets: context.targets,
        generationTargets,
        targetsStale: !sameMacroTotals(context.targets, generationTargets),
        preferencesRevision: plan.preferences_revision,
        targetsRevision: plan.targets_revision,
        hasIncompatibilities: dayResponses.some((day) => day.meals.some((meal) => meal.flags.length > 0)),
        summary: context.summary,
        days: dayResponses,
    };
};

/* ---------------------------------------------------------------------------
 * The single-day envelope
 * ------------------------------------------------------------------------- */

/**
 * The `meal_plans` columns the day envelope reports, as Prisma returns them.
 *
 * `end_date` is here for one reason: endedness is a comparison against the
 * caller's calendar day, so the envelope cannot state whether writes are still
 * accepted without the plan's last date. A day read that selected only
 * `{id, revision, status}` is exactly the read that could not tell an ended week
 * from a live one.
 */
export interface PlanDayEnvelopeRow {
    id: string;
    revision: number;
    status: string;
    end_date: Date;
}

/**
 * One day as `GET /plans/:planId/days/:date` answers it.
 *
 * WHY THE ENVELOPE IS BUILT HERE rather than inline in the service: it now
 * carries a derived verdict, and a derived member assembled at a call site is
 * one nothing can test and the next call site will spell differently. This is
 * the file that owns every field of these responses.
 *
 * `today` is a `YYYY-MM-DD` day key the CALLER resolves in the user's stored
 * IANA zone (`preferences.service.ts::resolveUserToday`). A day key rather than
 * a clock, because this file has none by design — and the user's zone rather
 * than the server's, because a bare date plus a Firebase identity cannot
 * establish which calendar day it is for them (§0.5.2).
 *
 * THE RULE IS APPLIED HERE, NOT RESTATED. `planLifecycle` and `isWritable` come
 * from `mealPlan.logic.ts::isPlanActiveStatus` and `::isPlanEnded` — the same
 * two predicates `requireWritablePlan` refuses writes with, so the envelope
 * cannot promise a write the writer would answer
 * `409 plan_not_active {reason: 'ended'}` on. Comparing `end_date` against
 * `today` locally instead is the "second, subtly different spelling"
 * `isPlanEnded`'s own docblock warns about.
 *
 * `planStatus` stays the stored column, unreinterpreted: §0.5.1 keeps an ended
 * plan `'active'` in storage and §0.5.2 declares the member, so the envelope
 * reports both what is stored and what it MEANS today.
 *
 * THE TWO LIFECYCLE MEMBERS ARE ADDITIVE EXTRAS, not §0.5.2 members, so the DTO
 * declares them optional and a client is built to work without them (it falls
 * back to `planStatus` and recovers from `409 plan_not_active`). This mapper
 * nevertheless sends both on every day read, because they are what spare a user
 * a refusal they could have been told about first;
 * `src/__tests__/api/planDayWriteability.test.ts` is what pins that, now that
 * the optional declaration does not.
 */
export const toMealPlanDayEnvelopeResponse = (
    plan: PlanDayEnvelopeRow,
    day: MealPlanDayResponse,
    today: string,
): MealPlanDayEnvelopeResponse => {
    const status = readPlanStatus(plan.status, plan.id);
    const lifecycle = readPlanLifecycle(plan, today);

    return {
        planId: plan.id,
        planRevision: plan.revision,
        planStatus: status,
        planLifecycle: lifecycle,
        // Derived from the lifecycle rather than re-tested, so the verdict and
        // the reason it reports can never disagree.
        isWritable: lifecycle === ACTIVE_LIFECYCLE,
        day,
    };
};
