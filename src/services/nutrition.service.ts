import { Prisma } from '../generated/prisma';
import { prisma } from '../prisma/client';
import {
    DailyMacrosResponse,
    DailySummaryResponse,
    DaySummaryMealResponse,
    LogCatalogMealEntryPayload,
    LogMealEntryPayload,
    MacroTargetsResponse,
    MacroTotals,
    MealEntryResponse,
    MealResponse,
    UpdateMealEntryPayload,
} from '../types/nutrition';
import { CatalogFoodNotFoundError } from './mealPlanning.errors';
import {
    CATALOG_INPUT_METHOD,
    CLIENT_SNAPSHOT_PROVENANCE,
    DETACHED_ENTRY_SNAPSHOT,
    PLANNED_INPUT_METHOD,
    PLANNED_SNAPSHOT_PROVENANCE,
    planMealEntryEdit,
    resolveCatalogEntrySnapshot,
    resolveLegacyInputMethod,
    toNutritionProvenance,
} from './nutrition.logic';

const DEFAULT_MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];

// Prisma's "no record matched the where clause" code, raised by `update` when
// its predicate — id, owner AND not-yet-deleted — selects nothing.
const RECORD_NOT_FOUND = 'P2025';

const isRecordNotFound = (error: unknown): boolean =>
    error instanceof Prisma.PrismaClientKnownRequestError && error.code === RECORD_NOT_FOUND;

interface MealEntryRow {
    id: string;
    food_id: string | null;
    name: string;
    serving_text: string | null;
    servings: number;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    input_method: string;
    logged_at: Date;
    deleted_at: Date | null;
    // Meal-planning columns with different null meanings: meal_plan_meal_id is
    // NULL on every entry not logged from a planned meal, while
    // nutrition_provenance is NULL only on rows written before the column
    // existed — a client-supplied snapshot written through the legacy path
    // carries 'user_entered'. Either way the mapper below emits an explicit
    // null rather than omitting the field.
    meal_plan_meal_id: string | null;
    nutrition_provenance: string | null;
    // The other two links are read, never mapped: they stay off the DTO, and
    // updateMealEntry consults all three to decide whether an edit detaches.
    catalog_food_id: string | null;
    recipe_version_id: string | null;
}

interface MealRow {
    id: string;
    name: string;
    sort_order: number;
    meal_entries: MealEntryRow[];
}

const toDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const asEaten = (perServing: number, servings: number): number => Math.round(perServing * servings);

// `toNutritionProvenance` is nutrition.logic.ts's: a stored value outside the
// known set reads as null — "unknown / user-entered", the same class a NULL
// column carries — so an unrecognised string can never be presented to a client
// as verified provenance.
const mapEntry = (entry: MealEntryRow): MealEntryResponse => ({
    id: entry.id,
    foodId: entry.food_id,
    mealPlanMealId: entry.meal_plan_meal_id ?? null,
    name: entry.name,
    servingText: entry.serving_text,
    servings: entry.servings,
    calories: entry.calories,
    protein: entry.protein_g,
    carbs: entry.carbs_g,
    fat: entry.fat_g,
    inputMethod: entry.input_method,
    nutritionProvenance: toNutritionProvenance(entry.nutrition_provenance),
    loggedAt: entry.logged_at.toISOString(),
});

const sumEntries = (entries: MealEntryRow[]): MacroTotals =>
    entries.reduce(
        (totals, entry) => ({
            calories: totals.calories + asEaten(entry.calories, entry.servings),
            protein: totals.protein + asEaten(entry.protein_g, entry.servings),
            carbs: totals.carbs + asEaten(entry.carbs_g, entry.servings),
            fat: totals.fat + asEaten(entry.fat_g, entry.servings),
        }),
        { calories: 0, protein: 0, carbs: 0, fat: 0 },
    );

const mapMeal = (meal: MealRow): MealResponse => ({
    id: meal.id,
    name: meal.name,
    sortOrder: meal.sort_order,
    entries: meal.meal_entries.map(mapEntry),
    totals: sumEntries(meal.meal_entries),
});

const getTargetsForUser = async (userId: string): Promise<MacroTargetsResponse> => {
    const user = await prisma.users.findUnique({
        where: { id: userId },
        select: { target_calories: true, target_protein_g: true, target_carbs_g: true, target_fat_g: true },
    });
    return {
        calories: user?.target_calories ?? null,
        protein: user?.target_protein_g ?? null,
        carbs: user?.target_carbs_g ?? null,
        fat: user?.target_fat_g ?? null,
    };
};

const fetchMealsForDay = (userId: string, date: Date) =>
    prisma.meals.findMany({
        where: { user_id: userId, date, deleted_at: null },
        include: {
            meal_entries: {
                where: { deleted_at: null },
                orderBy: { logged_at: 'asc' },
            },
        },
        orderBy: [{ sort_order: 'asc' }, { created_at: 'asc' }],
    });

export const getDailyMacros = async (userId: string, dateKey: string): Promise<DailyMacrosResponse> => {
    const date = new Date(dateKey);
    let meals = await fetchMealsForDay(userId, date);

    // Meals are a fixed set — lazily top up whichever defaults are missing on
    // read, so new days materialize fully and days created before a default
    // was added self-heal. sort_order comes from DEFAULT_MEALS position.
    const missing = DEFAULT_MEALS.filter((name) => !meals.some((meal) => meal.name === name));
    if (missing.length > 0) {
        await prisma.meals.createMany({
            data: missing.map((name) => ({
                user_id: userId,
                date,
                name,
                sort_order: DEFAULT_MEALS.indexOf(name),
            })),
        });
        meals = await fetchMealsForDay(userId, date);
    }

    const mapped = meals.map(mapMeal);
    return {
        date: dateKey,
        meals: mapped,
        totals: sumEntries(meals.flatMap((meal) => meal.meal_entries)),
        targets: await getTargetsForUser(userId),
    };
};

export const logMealEntry = async (
    userId: string,
    mealId: string,
    payload: LogMealEntryPayload,
): Promise<MealEntryResponse | null> => {
    const meal = await prisma.meals.findFirst({ where: { id: mealId, user_id: userId, deleted_at: null } });
    if (!meal) return null;

    // Old-app behavior: logging a food that's already in the meal bumps its
    // servings instead of inserting a duplicate row.
    if (payload.foodId) {
        const existing = await prisma.meal_entries.findFirst({
            where: { meal_id: mealId, food_id: payload.foodId, deleted_at: null },
        });
        if (existing) {
            const updated = await prisma.meal_entries.update({
                where: { id: existing.id },
                data: { servings: existing.servings + (payload.servings ?? 1) },
            });
            return mapEntry(updated);
        }
    }

    // Resolved, never taken as given: the method arrives from the request, and
    // the ones the server writes on its own authority — 'meal_plan' above all,
    // the field the diary reads as "From meal plan" — are not among those a body
    // may choose. Anything unusable becomes 'library', as it always has.
    const inputMethod = resolveLegacyInputMethod(payload.inputMethod);
    const entry = await prisma.meal_entries.create({
        data: {
            meal_id: mealId,
            user_id: userId,
            date: meal.date,
            food_id: payload.foodId ?? null,
            name: payload.name.trim(),
            serving_text: payload.servingText?.trim() || null,
            servings: payload.servings ?? 1,
            calories: Math.round(payload.calories),
            protein_g: Math.round(payload.protein),
            carbs_g: Math.round(payload.carbs),
            fat_g: Math.round(payload.fat),
            input_method: inputMethod,
            // The macros above arrived from the client, so the server cannot
            // call them source-backed however they were obtained. Rows written
            // before this column existed keep NULL and read as the same
            // "unknown" class; neither earns a provenance label.
            nutrition_provenance: CLIENT_SNAPSHOT_PROVENANCE,
            raw_input: payload.rawInput ?? null,
        },
    });
    return mapEntry(entry);
};

// The catalog counterpart of logMealEntry: the client names a published catalog
// food and a portion, and every number and label is derived from that row by
// nutrition.logic.ts's `resolveCatalogEntrySnapshot` — any macros the body
// carried were already discarded by the parser, and this function would ignore
// them regardless.
//
// Which portion, how its macros are scaled, how they are rounded and which
// provenance class they belong to are all rules and all live in the logic
// module, where they are tested without a database; what is left here is the
// read, the insert, and the 404 for a food that is not publishable.
export const logCatalogMealEntry = async (
    userId: string,
    mealId: string,
    payload: LogCatalogMealEntryPayload,
): Promise<MealEntryResponse | null> => {
    const meal = await prisma.meals.findFirst({ where: { id: mealId, user_id: userId, deleted_at: null } });
    if (!meal) return null;

    // Not published is indistinguishable from not existing, deliberately: a
    // candidate, quarantined, rejected or retired food is simply absent to a
    // caller, so no request can confirm one exists before it is publishable.
    const food = await prisma.catalog_foods.findFirst({
        where: { id: payload.catalogFoodId, publication_status: 'published' },
        include: { catalog_food_portions: true },
    });
    if (!food) {
        throw new CatalogFoodNotFoundError();
    }

    const snapshot = resolveCatalogEntrySnapshot(food, payload.servingText);
    const entry = await prisma.meal_entries.create({
        data: {
            meal_id: mealId,
            user_id: userId,
            date: meal.date,
            // A catalog food is not one of the user's personal foods: no foods
            // row is created and none is referenced, so the legacy food_id
            // dedupe branch above cannot apply and two logs are two entries.
            food_id: null,
            catalog_food_id: food.id,
            name: food.display_name,
            serving_text: snapshot.servingText,
            servings: payload.servings,
            calories: snapshot.perServing.calories,
            protein_g: snapshot.perServing.protein,
            carbs_g: snapshot.perServing.carbs,
            fat_g: snapshot.perServing.fat,
            // Stamped server-side whatever the body claimed, and paired with the
            // provenance the snapshot NARROWED from the catalog row, so the
            // caption the diary renders and the numbers it labels come from the
            // same snapshot. Narrowed and not copied: the column is unrestricted
            // TEXT, and a value outside the closed set would be stored here and
            // then read back as `null` by `toNutritionProvenance` — stripping the
            // estimate label §0.1.4(i) requires an AI-estimated or
            // ingredient-derived food to carry. The snapshot refuses instead, so
            // no entry is written with a label nobody can read.
            input_method: CATALOG_INPUT_METHOD,
            nutrition_provenance: snapshot.nutritionProvenance,
        },
    });
    return mapEntry(entry);
};

// Everything insertPlannedMealEntry writes. The four per-serving macros arrive
// ALREADY ROUNDED, from plannedMealLog.logic.ts's derivePlannedSnapshot — the
// single rounding owner of the planned-meal contract (§0.7.3) — and are stored
// verbatim. This writer rounds nothing; a fractional value reaching it is a
// broken invariant and is refused by requireStoredInteger below.
export interface PlannedMealEntryInsert {
    userId: string;
    mealId: string;
    date: Date;
    mealPlanMealId: string;
    recipeVersionId: string;
    name: string;
    servingText: string | null;
    servings: number;
    perServing: MacroTotals;
}

/**
 * The precondition the planned insert rests on, made loud instead of implicit.
 *
 * §0.7.3 gives the planned-meal path exactly ONE rounding step, and it belongs
 * to `plannedMealLog.logic.ts::derivePlannedSnapshot`: it multiplies the
 * recipe's per-serving values by the portion multiplier at full precision and
 * rounds each of the four results once. This writer stores those integers as
 * they arrive, so a fractional value here means the snapshot step was skipped
 * or a second scaling crept in between — not a value to quietly repair. Rounding
 * it would silently restore agreement with the row while leaving the client's
 * "This adds" card, which only ever sees the stored integers, computing from a
 * different number.
 *
 * A plain `Error` rather than a typed one, following
 * `mealPlanningAction.service.ts::toActionRecord`: this is a broken internal
 * invariant with no client-actionable form — the controller maps it to a 500 —
 * whereas `mealPlanning.errors.ts` exists for states the client must
 * distinguish. The message names the field, the value and the owner, because
 * that trio is what makes the fault diagnosable from a log line alone.
 *
 * The four `meal_entries` macro columns are Prisma `Int`, so a fractional value
 * would in any case be refused by the database — after the transaction had done
 * its work, with a Prisma error naming a column instead of a snapshot.
 */
const requireStoredInteger = (value: number, field: string): number => {
    if (!Number.isInteger(value)) {
        throw new Error(
            `insertPlannedMealEntry received a non-integer perServing.${field} (${String(value)}). ` +
                'Planned per-serving macros are rounded exactly once, by ' +
                'plannedMealLog.logic.ts::derivePlannedSnapshot, and stored verbatim here; this writer ' +
                'does not round (AAP §0.7.3).',
        );
    }

    return value;
};

// Takes the transaction client first, breaking this module's userId-first
// convention (§5): it is a tx-scoped helper with exactly one caller,
// plannedMealLog.service.ts, which has already taken the per-user advisory
// lock, reserved the action row, checked the plan's status and revision, and
// verified this diary meal is the user's and matches `date`. Re-checking any of
// that here would let the two copies drift, so this function only inserts.
export const insertPlannedMealEntry = async (
    tx: Prisma.TransactionClient,
    params: PlannedMealEntryInsert,
): Promise<MealEntryResponse> => {
    const entry = await tx.meal_entries.create({
        data: {
            meal_id: params.mealId,
            user_id: params.userId,
            date: params.date,
            food_id: null,
            meal_plan_meal_id: params.mealPlanMealId,
            recipe_version_id: params.recipeVersionId,
            name: params.name,
            serving_text: params.servingText,
            servings: params.servings,
            // Stored VERBATIM, and asserted to be integers rather than made
            // into them. The planned-meal contract rounds once, in
            // `derivePlannedSnapshot`, and the diary then shows
            // Math.round(snapshot * servings); a second Math.round here would
            // be a no-op on these values today and a second rounding site
            // forever, which is how the app's "This adds" card and the server's
            // totals come to disagree once anything upstream changes.
            calories: requireStoredInteger(params.perServing.calories, 'calories'),
            protein_g: requireStoredInteger(params.perServing.protein, 'protein'),
            carbs_g: requireStoredInteger(params.perServing.carbs, 'carbs'),
            fat_g: requireStoredInteger(params.perServing.fat, 'fat'),
            // The only place this value is written. No request can ask for it:
            // `resolveLegacyInputMethod` keeps it off the legacy path, and the
            // catalog writer stamps 'search'.
            input_method: PLANNED_INPUT_METHOD,
            // Planning admits only source-backed ingredients, so a planned meal
            // is never an estimate.
            nutrition_provenance: PLANNED_SNAPSHOT_PROVENANCE,
        },
    });
    return mapEntry(entry);
};

// Which values the edit writes, and whether writing them detaches the entry
// from the plan meal, recipe version or catalog food it was logged from, are
// nutrition.logic.ts's `planMealEntryEdit`: it normalizes each provided value
// the way this writer stores it and detaches only when a normalized value
// actually differs from the stored one, so a resubmission or a retry that
// changes nothing keeps the links, the "From meal plan" caption and the source
// label it arrived with.
export const updateMealEntry = async (
    userId: string,
    entryId: string,
    payload: UpdateMealEntryPayload,
): Promise<MealEntryResponse | null> => {
    const existing = await prisma.meal_entries.findFirst({
        where: { id: entryId, user_id: userId, deleted_at: null },
    });
    if (!existing) return null;

    const plan = planMealEntryEdit(existing, payload);

    try {
        // `deleted_at: null` belongs in the WRITE predicate and not only in the
        // read above: the two statements run in separate READ COMMITTED
        // snapshots, so a delete that commits between them would otherwise be
        // followed by a successful update of a row the user has already removed —
        // and a 200 describing it. With the condition here the UPDATE matches
        // nothing, Prisma raises P2025, and the caller gets the same 404 the
        // authorization read gives for an entry that is missing or not theirs.
        const entry = await prisma.meal_entries.update({
            where: { id: entryId, user_id: userId, deleted_at: null },
            data: {
                ...plan.fields,
                ...(plan.detachesFromSource ? DETACHED_ENTRY_SNAPSHOT : {}),
            },
        });

        return mapEntry(entry);
    } catch (error) {
        if (isRecordNotFound(error)) return null;

        throw error;
    }
};

export const deleteMealEntry = async (userId: string, entryId: string): Promise<boolean> => {
    const { count } = await prisma.meal_entries.updateMany({
        where: { id: entryId, user_id: userId, deleted_at: null },
        data: { deleted_at: new Date() },
    });
    return count > 0;
};

interface DailySummaryRow {
    date: Date;
    meal_count: bigint;
    calories: number | null;
    protein: number | null;
    carbs: number | null;
    fat: number | null;
}

interface DaySummaryMealRow {
    date: Date;
    meal_id: string;
    name: string;
    sort_order: number;
    calories: number | null;
    protein: number | null;
    carbs: number | null;
    fat: number | null;
}

// Per-meal totals for a set of days, keyed by day. Feeds the history screen's
// line-by-line breakdown; only meals with logged entries appear.
const getMealBreakdowns = async (
    userId: string,
    dates: Date[],
): Promise<Map<string, DaySummaryMealResponse[]>> => {
    if (dates.length === 0) return new Map();
    const rows = await prisma.$queryRaw<DaySummaryMealRow[]>`
        SELECT
            e.date,
            e.meal_id,
            m.name,
            m.sort_order,
            SUM(ROUND(e.calories * e.servings))::int AS calories,
            SUM(ROUND(e.protein_g * e.servings))::int AS protein,
            SUM(ROUND(e.carbs_g * e.servings))::int AS carbs,
            SUM(ROUND(e.fat_g * e.servings))::int AS fat
        FROM meal_entries e
        JOIN meals m ON m.id = e.meal_id
        WHERE e.user_id = ${userId}
            AND e.deleted_at IS NULL
            AND e.date IN (${Prisma.join(dates)})
        GROUP BY e.date, e.meal_id, m.name, m.sort_order
        ORDER BY m.sort_order ASC, m.name ASC
    `;
    const byDay = new Map<string, DaySummaryMealResponse[]>();
    for (const row of rows) {
        const key = toDayKey(row.date);
        const meals = byDay.get(key) ?? [];
        meals.push({
            id: row.meal_id,
            name: row.name,
            sortOrder: row.sort_order,
            calories: row.calories ?? 0,
            protein: row.protein ?? 0,
            carbs: row.carbs ?? 0,
            fat: row.fat ?? 0,
        });
        byDay.set(key, meals);
    }
    return byDay;
};

export const getHistory = async (
    userId: string,
    page: number,
    limit: number,
): Promise<{ days: DailySummaryResponse[]; total: number }> => {
    // Totals multiply per-serving snapshots by servings at read time, same math
    // as the old reselect selectors. Zero-calorie days are skipped (old
    // PreviousDailyMealEntriesScreen behavior).
    const rows = await prisma.$queryRaw<DailySummaryRow[]>`
        SELECT
            date,
            COUNT(DISTINCT meal_id) AS meal_count,
            SUM(ROUND(calories * servings))::int AS calories,
            SUM(ROUND(protein_g * servings))::int AS protein,
            SUM(ROUND(carbs_g * servings))::int AS carbs,
            SUM(ROUND(fat_g * servings))::int AS fat
        FROM meal_entries
        WHERE user_id = ${userId} AND deleted_at IS NULL
        GROUP BY date
        HAVING SUM(ROUND(calories * servings)) > 0
        ORDER BY date DESC
        LIMIT ${limit} OFFSET ${(page - 1) * limit}
    `;
    const totalRows = await prisma.$queryRaw<{ count: bigint }[]>`
        SELECT COUNT(*) AS count FROM (
            SELECT date FROM meal_entries
            WHERE user_id = ${userId} AND deleted_at IS NULL
            GROUP BY date
            HAVING SUM(ROUND(calories * servings)) > 0
        ) days
    `;
    const mealsByDay = await getMealBreakdowns(userId, rows.map((row) => row.date));
    return {
        days: rows.map((row) => ({
            date: toDayKey(row.date),
            mealCount: Number(row.meal_count),
            calories: row.calories ?? 0,
            protein: row.protein ?? 0,
            carbs: row.carbs ?? 0,
            fat: row.fat ?? 0,
            meals: mealsByDay.get(toDayKey(row.date)) ?? [],
        })),
        total: Number(totalRows[0]?.count ?? 0),
    };
};

// `db` defaults to the shared client, so the existing caller is unchanged. A
// transaction client may be passed instead: targets.service.ts writes
// users.target_* and meal_plan_preferences in one transaction, and both must
// commit or neither, or a confirmed target would be recorded against
// preferences that never got it.
export const updateTargets = async (
    userId: string,
    targets: Partial<MacroTargetsResponse>,
    db: Prisma.TransactionClient = prisma,
): Promise<MacroTargetsResponse | null> => {
    const existing = await db.users.findUnique({ where: { id: userId } });
    if (!existing) return null;
    const user = await db.users.update({
        where: { id: userId },
        data: {
            ...(targets.calories !== undefined ? { target_calories: targets.calories } : {}),
            ...(targets.protein !== undefined ? { target_protein_g: targets.protein } : {}),
            ...(targets.carbs !== undefined ? { target_carbs_g: targets.carbs } : {}),
            ...(targets.fat !== undefined ? { target_fat_g: targets.fat } : {}),
        },
    });
    return {
        calories: user.target_calories,
        protein: user.target_protein_g,
        carbs: user.target_carbs_g,
        fat: user.target_fat_g,
    };
};
