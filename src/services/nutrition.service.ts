import { prisma } from '../prisma/client';
import {
    DailyMacrosResponse,
    DailySummaryResponse,
    LogMealEntryPayload,
    MacroTargetsResponse,
    MacroTotals,
    MealEntryResponse,
    MealResponse,
    UpdateMealEntryPayload,
} from '../types/nutrition';

const DEFAULT_MEALS = ['Breakfast', 'Lunch', 'Dinner', 'Snack'];
const INPUT_METHODS = ['library', 'search', 'ai_text', 'ai_photo'];

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
}

interface MealRow {
    id: string;
    name: string;
    sort_order: number;
    meal_entries: MealEntryRow[];
}

const toDayKey = (date: Date): string => date.toISOString().slice(0, 10);

const asEaten = (perServing: number, servings: number): number => Math.round(perServing * servings);

const mapEntry = (entry: MealEntryRow): MealEntryResponse => ({
    id: entry.id,
    foodId: entry.food_id,
    name: entry.name,
    servingText: entry.serving_text,
    servings: entry.servings,
    calories: entry.calories,
    protein: entry.protein_g,
    carbs: entry.carbs_g,
    fat: entry.fat_g,
    inputMethod: entry.input_method,
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
            raw_input: payload.rawInput ?? null,
        },
    });
    return mapEntry(entry);
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
        where: { id: entryId },
        data: {
            ...(payload.servings !== undefined ? { servings: payload.servings } : {}),
            ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
            ...(payload.calories !== undefined ? { calories: Math.round(payload.calories) } : {}),
            ...(payload.protein !== undefined ? { protein_g: Math.round(payload.protein) } : {}),
            ...(payload.carbs !== undefined ? { carbs_g: Math.round(payload.carbs) } : {}),
            ...(payload.fat !== undefined ? { fat_g: Math.round(payload.fat) } : {}),
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
    return {
        days: rows.map((row) => ({
            date: toDayKey(row.date),
            mealCount: Number(row.meal_count),
            calories: row.calories ?? 0,
            protein: row.protein ?? 0,
            carbs: row.carbs ?? 0,
            fat: row.fat ?? 0,
        })),
        total: Number(totalRows[0]?.count ?? 0),
    };
};

export const updateTargets = async (
    userId: string,
    targets: Partial<MacroTargetsResponse>,
): Promise<MacroTargetsResponse | null> => {
    const existing = await prisma.users.findUnique({ where: { id: userId } });
    if (!existing) return null;
    const user = await prisma.users.update({
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
