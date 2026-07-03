import { Request, Response } from 'express';
import { createFood, deleteFood, getFoodsForUser, updateFood } from '../services/food.service';
import { getBrandedFood, searchBrandedFoods, UsdaError } from '../services/usda.service';
import { getUserId } from '../utils/getUserId';

const isValidFoodPayload = (body: any): boolean =>
    typeof body?.name === 'string' &&
    body.name.trim().length > 0 &&
    [body.calories, body.protein, body.carbs, body.fat].every((value: any) => Number.isFinite(Number(value)));

export const getFoods = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const query = ((req.query.q as string) ?? '').trim();
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 25;
        const { foods, total } = await getFoodsForUser(userId, query, page, limit);
        return res.json({
            foods,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error('Error getting foods:', error);
        res.status(500).json({ error: 'Failed to get foods' });
    }
};

export const createFoodController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        if (!isValidFoodPayload(req.body)) {
            return res.status(400).json({ error: 'name, calories, protein, carbs, and fat are required' });
        }
        const food = await createFood(userId, req.body);
        return res.status(201).json(food);
    } catch (error) {
        console.error('Error creating food:', error);
        res.status(500).json({ error: 'Failed to create food' });
    }
};

export const updateFoodController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const food = await updateFood(userId, req.params.id, req.body);
        if (!food) {
            return res.status(404).json({ error: 'Food not found' });
        }
        return res.json(food);
    } catch (error) {
        console.error('Error updating food:', error);
        res.status(500).json({ error: 'Failed to update food' });
    }
};

export const deleteFoodController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const deleted = await deleteFood(userId, req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Food not found' });
        }
        return res.json({ success: true });
    } catch (error) {
        console.error('Error deleting food:', error);
        res.status(500).json({ error: 'Failed to delete food' });
    }
};

const handleUsdaError = (res: Response, error: unknown, fallback: string) => {
    if (error instanceof UsdaError) {
        console.error('USDA error:', error.message);
        return res.status(502).json({ error: 'branded_search_failed' });
    }
    console.error(fallback, error);
    return res.status(500).json({ error: fallback });
};

export const searchBrandedFoodsController = async (req: Request, res: Response) => {
    try {
        const query = ((req.query.q as string) ?? '').trim();
        if (query.length < 2) {
            return res.status(400).json({ error: 'q must be at least 2 characters' });
        }
        const items = await searchBrandedFoods(query);
        return res.json({ items });
    } catch (error) {
        return handleUsdaError(res, error, 'Failed to search branded foods');
    }
};

export const getBrandedFoodController = async (req: Request, res: Response) => {
    try {
        const food = await getBrandedFood(req.params.foodId);
        if (!food) {
            return res.status(404).json({ error: 'Branded food not found' });
        }
        return res.json(food);
    } catch (error) {
        return handleUsdaError(res, error, 'Failed to get branded food');
    }
};
