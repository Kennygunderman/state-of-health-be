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
    NutritionProvenance,
    UpdateMealEntryPayload,
} from '../types/nutrition';
import { CatalogFoodNotFoundError } from './mealPlanning.errors';

const DEFAULT_MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
const INPUT_METHODS = ['library', 'search', 'ai_text', 'ai_photo', 'meal_plan'];

const NUTRITION_PROVENANCES: NutritionProvenance[] = [
    'source_backed',
    'ingredient_derived',
    'ai_estimated',
    'user_entered',
];

// The portion a catalog entry names must be one this food actually stores, and
// only the catalog row can say which those are — so the check cannot live in
// nutrition.logic.ts with the rest of the body validation, and this is the
// failure it reports instead. Declared here rather than in mealPlanning.errors
// for the reason that file states: a failure belongs to the module that raises
// it, the way estimate.service owns EstimateFailedError. The controller maps it
// to 400 invalid_serving; nothing here knows that status (§8).
export class InvalidServingError extends Error {
    constructor(public readonly servingText: string) {
        super('servingText does not name a stored portion of this food');
        this.name = 'InvalidServingError';
    }
}

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

// A stored value outside the known set is reported as null — "unknown /
// user-entered", the same class a NULL column carries — so an unrecognised
// string can never be presented to a client as verified provenance.
const toNutritionProvenance = (value: string | null): NutritionProvenance | null =>
    value !== null && NUTRITION_PROVENANCES.includes(value as NutritionProvenance)
        ? (value as NutritionProvenance)
        : null;

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

    const inputMethod =
        payload.inputMethod && INPUT_METHODS.includes(payload.inputMethod) ? payload.inputMethod : 'library';
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
            nutrition_provenance: 'user_entered',
            raw_input: payload.rawInput ?? null,
        },
    });
    return mapEntry(entry);
};

interface CatalogPortionRow {
    description: string;
    gram_weight: number;
    is_default: boolean;
}

interface CatalogFoodRow {
    id: string;
    display_name: string;
    nutrition_provenance: string;
    nutrition_basis: string;
    basis_amount: number;
    calories: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    density_g_per_ml: number | null;
    catalog_food_portions: CatalogPortionRow[];
}

// A published food is guaranteed to carry all four macros and a default portion
// with a known gram weight, so anything missing here is a data fault rather
// than a bad request: inventing a weight or reading a NULL nutrient as zero
// would log numbers nobody measured under a source-backed label.
const requireCatalogValue = (value: number | null, foodId: string, what: string): number => {
    if (value === null || !Number.isFinite(value) || value <= 0) {
        throw new Error(`Published catalog food ${foodId} has no usable ${what}`);
    }
    return value;
};

const requireNutrient = (value: number | null, foodId: string, nutrient: string): number => {
    if (value === null || !Number.isFinite(value)) {
        throw new Error(`Published catalog food ${foodId} has no ${nutrient} value`);
    }
    return value;
};

// The mass a food's stated nutrient values describe, so one per-gram rate can
// be scaled to any stored portion. 'per_100g' states them against a mass
// already; 'per_100ml' needs the density to become one; 'per_serving' states
// them against basis_amount of the food's own default portion.
const basisGrams = (food: CatalogFoodRow, defaultPortion: CatalogPortionRow): number => {
    const basisAmount = requireCatalogValue(food.basis_amount, food.id, 'nutrition basis amount');

    switch (food.nutrition_basis) {
        case 'per_100g':
            return basisAmount;
        case 'per_100ml':
            return basisAmount * requireCatalogValue(food.density_g_per_ml, food.id, 'density');
        case 'per_serving':
            return basisAmount * requireCatalogValue(defaultPortion.gram_weight, food.id, 'default portion weight');
        default:
            throw new Error(`Published catalog food ${food.id} has an unsupported nutrition basis`);
    }
};

// Resolves the portion the entry is logged against, and derives that portion's
// per-serving macros from it.
//
// The portion drives the stored label AND the stored numbers together. An
// omitted servingText takes the default portion; a named one must match a
// portion this food actually stores, because the text is what the saved macros
// claim to describe — labelling one portion's numbers with another portion's
// name, or storing a string the catalog never measured, is the unverifiable
// claim the servingText check exists to prevent.
const catalogPortionSnapshot = (
    food: CatalogFoodRow,
    servingText: string | undefined,
): { description: string; perServing: MacroTotals } => {
    const defaultPortion = food.catalog_food_portions.find((portion) => portion.is_default);
    if (!defaultPortion) {
        throw new Error(`Published catalog food ${food.id} has no default portion`);
    }

    let portion = defaultPortion;
    if (servingText !== undefined) {
        const named = food.catalog_food_portions.find((candidate) => candidate.description === servingText);
        if (!named) {
            throw new InvalidServingError(servingText);
        }
        portion = named;
    }

    const scale =
        requireCatalogValue(portion.gram_weight, food.id, 'portion weight') / basisGrams(food, defaultPortion);

    // Rounded to integers because meal_entries stores per-serving macros as
    // Int, and rounded here only: the read path multiplies this snapshot by
    // servings, so scaling it first would round twice and drift.
    return {
        description: portion.description,
        perServing: {
            calories: Math.round(requireNutrient(food.calories, food.id, 'calories') * scale),
            protein: Math.round(requireNutrient(food.protein_g, food.id, 'protein') * scale),
            carbs: Math.round(requireNutrient(food.carbs_g, food.id, 'carbs') * scale),
            fat: Math.round(requireNutrient(food.fat_g, food.id, 'fat') * scale),
        },
    };
};

// The catalog counterpart of logMealEntry: the client names a published catalog
// food and a portion, and every number and label is derived here from that
// row — any macros the body carried were already discarded by the parser, and
// this function would ignore them regardless.
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

    const snapshot = catalogPortionSnapshot(food, payload.servingText);
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
            serving_text: snapshot.description,
            servings: payload.servings,
            calories: snapshot.perServing.calories,
            protein_g: snapshot.perServing.protein,
            carbs_g: snapshot.perServing.carbs,
            fat_g: snapshot.perServing.fat,
            // Stamped server-side whatever the body claimed, and paired with the
            // catalog row's own provenance so the caption the diary renders and
            // the numbers it labels come from the same snapshot.
            input_method: 'search',
            nutrition_provenance: food.nutrition_provenance,
        },
    });
    return mapEntry(entry);
};

// Everything insertPlannedMealEntry writes. The per-serving macros arrive at
// full precision and are rounded here, once.
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
            // The single rounding in the planned-meal contract: the planned
            // portion is computed at full precision, rounded once into this
            // snapshot, and the diary then shows Math.round(snapshot *
            // servings). Rounding anywhere else makes the app's "This adds"
            // card and the server's totals disagree.
            calories: Math.round(params.perServing.calories),
            protein_g: Math.round(params.perServing.protein),
            carbs_g: Math.round(params.perServing.carbs),
            fat_g: Math.round(params.perServing.fat),
            input_method: 'meal_plan',
            // Planning admits only source-backed ingredients, so a planned meal
            // is never an estimate.
            nutrition_provenance: 'source_backed',
        },
    });
    return mapEntry(entry);
};

// What an entry keeps once its numbers are no longer the plan's or the
// catalog's: every link is cleared, so the plan card returns to unlogged and
// both captions — "From meal plan" and any source label — go with them.
// 'library' is this column's own schema default and the value logMealEntry
// already falls back to for an unrecognised method, so no new input method
// enters the wire and an older client decodes a detached entry unchanged.
const DETACHED_SNAPSHOT = {
    meal_plan_meal_id: null,
    catalog_food_id: null,
    recipe_version_id: null,
    input_method: 'library',
    nutrition_provenance: 'user_entered',
} as const;

// A servings edit only says how much was eaten, which the linked plan meal or
// catalog food still describes, so the links stand and the plan stays logged.
// Rewriting the name or any macro replaces what the entry claims the food IS —
// the plan did not produce those numbers, so nothing may keep vouching for them.
const detachesFromSource = (
    existing: Pick<MealEntryRow, 'meal_plan_meal_id' | 'catalog_food_id' | 'recipe_version_id'>,
    payload: UpdateMealEntryPayload,
): boolean => {
    const isLinked =
        existing.meal_plan_meal_id !== null ||
        existing.catalog_food_id !== null ||
        existing.recipe_version_id !== null;
    const rewritesSnapshot =
        payload.name !== undefined ||
        payload.calories !== undefined ||
        payload.protein !== undefined ||
        payload.carbs !== undefined ||
        payload.fat !== undefined;

    return isLinked && rewritesSnapshot;
};

export const updateMealEntry = async (
    userId: string,
    entryId: string,
    payload: UpdateMealEntryPayload,
): Promise<MealEntryResponse | null> => {
    const existing = await prisma.meal_entries.findFirst({
        where: { id: entryId, user_id: userId, deleted_at: null },
    });
    if (!existing) return null;
    const entry = await prisma.meal_entries.update({
        where: { id: entryId, user_id: userId },
        data: {
            ...(payload.servings !== undefined ? { servings: payload.servings } : {}),
            ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
            ...(payload.calories !== undefined ? { calories: Math.round(payload.calories) } : {}),
            ...(payload.protein !== undefined ? { protein_g: Math.round(payload.protein) } : {}),
            ...(payload.carbs !== undefined ? { carbs_g: Math.round(payload.carbs) } : {}),
            ...(payload.fat !== undefined ? { fat_g: Math.round(payload.fat) } : {}),
            ...(detachesFromSource(existing, payload) ? DETACHED_SNAPSHOT : {}),
        },
    });
    return mapEntry(entry);
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
