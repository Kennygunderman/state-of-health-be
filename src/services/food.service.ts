import { prisma } from '../prisma/client';
import { CreateFoodPayload, FoodResponse } from '../types/nutrition';

const FOOD_SOURCES = ['manual', 'label_scan', 'branded', 'seed'];

// The four starter foods every fresh library gets — carried over from the old
// app's initialState.ts so new users aren't staring at an empty list.
const STARTER_FOODS = [
    { name: 'Chicken Breast', serving_amount: 4, serving_unit: 'oz', calories: 176, protein_g: 35, carbs_g: 0, fat_g: 4 },
    { name: 'Egg', serving_amount: 1, serving_unit: 'large', calories: 78, protein_g: 6, carbs_g: 0, fat_g: 6 },
    { name: 'Peanut Butter', serving_amount: 2, serving_unit: 'tbsp', calories: 180, protein_g: 7, carbs_g: 4, fat_g: 16 },
    { name: 'Apple', serving_amount: 1, serving_unit: 'medium', calories: 96, protein_g: 0, carbs_g: 24, fat_g: 0 },
];

interface FoodRow {
    id: string;
    name: string;
    serving_amount: number;
    serving_unit: string | null;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    brand: string | null;
    source: string;
}

const mapFood = (food: FoodRow): FoodResponse => ({
    id: food.id,
    name: food.name,
    servingAmount: food.serving_amount,
    servingUnit: food.serving_unit,
    calories: food.calories,
    protein: food.protein_g,
    carbs: food.carbs_g,
    fat: food.fat_g,
    brand: food.brand,
    source: food.source,
});

// Seed only when the user has never had any foods (soft-deleted rows count as
// "had" — deleting a starter food shouldn't resurrect it on next fetch).
const seedStarterFoodsIfEmpty = async (userId: string): Promise<void> => {
    const existing = await prisma.foods.count({ where: { user_id: userId } });
    if (existing > 0) return;
    await prisma.foods.createMany({
        data: STARTER_FOODS.map((food) => ({ ...food, user_id: userId, source: 'seed' })),
    });
};

export const getFoodsForUser = async (
    userId: string,
    query: string,
    page: number,
    limit: number,
): Promise<{ foods: FoodResponse[]; total: number }> => {
    await seedStarterFoodsIfEmpty(userId);

    const where = {
        user_id: userId,
        deleted_at: null,
        ...(query ? { name: { contains: query, mode: 'insensitive' as const } } : {}),
    };
    const [rows, total] = await Promise.all([
        prisma.foods.findMany({
            where,
            orderBy: [{ created_at: 'desc' }],
            skip: (page - 1) * limit,
            take: limit,
        }),
        prisma.foods.count({ where }),
    ]);
    return { foods: rows.map(mapFood), total };
};

export const createFood = async (userId: string, payload: CreateFoodPayload): Promise<FoodResponse> => {
    const source = payload.source && FOOD_SOURCES.includes(payload.source) ? payload.source : 'manual';
    const food = await prisma.foods.create({
        data: {
            user_id: userId,
            name: payload.name.trim(),
            serving_amount: payload.servingAmount ?? 1,
            serving_unit: payload.servingUnit?.trim() || null,
            calories: Math.round(payload.calories),
            protein_g: Math.round(payload.protein),
            carbs_g: Math.round(payload.carbs),
            fat_g: Math.round(payload.fat),
            brand: payload.brand?.trim() || null,
            source,
        },
    });
    return mapFood(food);
};

export const updateFood = async (
    userId: string,
    foodId: string,
    payload: Partial<CreateFoodPayload>,
): Promise<FoodResponse | null> => {
    const existing = await prisma.foods.findFirst({ where: { id: foodId, user_id: userId, deleted_at: null } });
    if (!existing) return null;
    const food = await prisma.foods.update({
        where: { id: foodId },
        data: {
            ...(payload.name !== undefined ? { name: payload.name.trim() } : {}),
            ...(payload.servingAmount !== undefined ? { serving_amount: payload.servingAmount } : {}),
            ...(payload.servingUnit !== undefined ? { serving_unit: payload.servingUnit?.trim() || null } : {}),
            ...(payload.calories !== undefined ? { calories: Math.round(payload.calories) } : {}),
            ...(payload.protein !== undefined ? { protein_g: Math.round(payload.protein) } : {}),
            ...(payload.carbs !== undefined ? { carbs_g: Math.round(payload.carbs) } : {}),
            ...(payload.fat !== undefined ? { fat_g: Math.round(payload.fat) } : {}),
        },
    });
    return mapFood(food);
};

export const deleteFood = async (userId: string, foodId: string): Promise<boolean> => {
    const { count } = await prisma.foods.updateMany({
        where: { id: foodId, user_id: userId, deleted_at: null },
        data: { deleted_at: new Date() },
    });
    return count > 0;
};

// Used by the branded-search logging path: re-logging the same branded food
// should reuse the existing library row instead of creating a duplicate.
export const findOrCreateBrandedFood = async (
    userId: string,
    payload: CreateFoodPayload,
): Promise<FoodResponse> => {
    const existing = await prisma.foods.findFirst({
        where: {
            user_id: userId,
            deleted_at: null,
            source: 'branded',
            name: { equals: payload.name.trim(), mode: 'insensitive' },
            brand: payload.brand?.trim() || null,
        },
    });
    if (existing) return mapFood(existing);
    return createFood(userId, { ...payload, source: 'branded' });
};
