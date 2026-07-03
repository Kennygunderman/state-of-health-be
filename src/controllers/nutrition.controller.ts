import { Request, Response } from 'express';
import {
    createMeal,
    deleteMeal,
    deleteMealEntry,
    getDailyMacros,
    getHistory,
    logMealEntry,
    renameMeal,
    updateMealEntry,
    updateTargets,
} from '../services/nutrition.service';
import { estimateMeal, scanLabel, EstimateRateLimitError, EstimateFailedError } from '../services/estimate.service';
import { getUserId } from '../utils/getUserId';

const DAY_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

const isValidMacroPayload = (body: any): boolean =>
    typeof body?.name === 'string' &&
    body.name.trim().length > 0 &&
    [body.calories, body.protein, body.carbs, body.fat].every((value: any) => Number.isFinite(Number(value)));

export const getDailyMacrosController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { date } = req.params;
        if (!DAY_KEY_REGEX.test(date)) {
            return res.status(400).json({ error: 'date must be yyyy-MM-dd' });
        }
        const day = await getDailyMacros(userId, date);
        return res.json(day);
    } catch (error) {
        console.error('Error getting daily macros:', error);
        res.status(500).json({ error: 'Failed to get daily macros' });
    }
};

export const createMealController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { date, name } = req.body;
        if (!DAY_KEY_REGEX.test(date ?? '') || typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'date (yyyy-MM-dd) and name are required' });
        }
        const meal = await createMeal(userId, { date, name });
        return res.status(201).json(meal);
    } catch (error) {
        console.error('Error creating meal:', error);
        res.status(500).json({ error: 'Failed to create meal' });
    }
};

export const renameMealController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { name } = req.body;
        if (typeof name !== 'string' || !name.trim()) {
            return res.status(400).json({ error: 'name is required' });
        }
        const meal = await renameMeal(userId, req.params.id, name);
        if (!meal) {
            return res.status(404).json({ error: 'Meal not found' });
        }
        return res.json(meal);
    } catch (error) {
        console.error('Error renaming meal:', error);
        res.status(500).json({ error: 'Failed to rename meal' });
    }
};

export const deleteMealController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const deleted = await deleteMeal(userId, req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Meal not found' });
        }
        return res.json({ success: true });
    } catch (error) {
        console.error('Error deleting meal:', error);
        res.status(500).json({ error: 'Failed to delete meal' });
    }
};

export const logMealEntryController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        if (!isValidMacroPayload(req.body)) {
            return res.status(400).json({ error: 'name, calories, protein, carbs, and fat are required' });
        }
        const entry = await logMealEntry(userId, req.params.mealId, req.body);
        if (!entry) {
            return res.status(404).json({ error: 'Meal not found' });
        }
        return res.status(201).json(entry);
    } catch (error) {
        console.error('Error logging meal entry:', error);
        res.status(500).json({ error: 'Failed to log meal entry' });
    }
};

export const updateMealEntryController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const entry = await updateMealEntry(userId, req.params.id, req.body);
        if (!entry) {
            return res.status(404).json({ error: 'Entry not found' });
        }
        return res.json(entry);
    } catch (error) {
        console.error('Error updating meal entry:', error);
        res.status(500).json({ error: 'Failed to update meal entry' });
    }
};

export const deleteMealEntryController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const deleted = await deleteMealEntry(userId, req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Entry not found' });
        }
        return res.json({ success: true });
    } catch (error) {
        console.error('Error deleting meal entry:', error);
        res.status(500).json({ error: 'Failed to delete meal entry' });
    }
};

export const getHistoryController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 30;
        const { days, total } = await getHistory(userId, page, limit);
        return res.json({
            days,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit),
            },
        });
    } catch (error) {
        console.error('Error getting macros history:', error);
        res.status(500).json({ error: 'Failed to get macros history' });
    }
};

export const updateTargetsController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const parseTarget = (value: any): number | null | undefined => {
            if (value === undefined) return undefined;
            if (value === null) return null;
            const parsed = Math.round(Number(value));
            return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
        };
        const targets = await updateTargets(userId, {
            calories: parseTarget(req.body.calories),
            protein: parseTarget(req.body.protein),
            carbs: parseTarget(req.body.carbs),
            fat: parseTarget(req.body.fat),
        });
        if (!targets) {
            return res.status(404).json({ error: 'User not found' });
        }
        return res.json(targets);
    } catch (error) {
        console.error('Error updating targets:', error);
        res.status(500).json({ error: 'Failed to update targets' });
    }
};

const handleEstimateError = (res: Response, error: unknown, fallback: string) => {
    if (error instanceof EstimateRateLimitError) {
        return res.status(429).json({ error: 'estimate_limit_reached' });
    }
    if (error instanceof EstimateFailedError) {
        console.error('Estimate failed:', error.message);
        return res.status(502).json({ error: 'estimation_failed' });
    }
    console.error(fallback, error);
    return res.status(500).json({ error: fallback });
};

export const estimateController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { text, imageBase64 } = req.body;
        const hasText = typeof text === 'string' && text.trim().length > 0;
        const hasImage = typeof imageBase64 === 'string' && imageBase64.length > 0;
        if (!hasText && !hasImage) {
            return res.status(400).json({ error: 'text or imageBase64 is required' });
        }
        const estimate = await estimateMeal(userId, hasText ? text.trim() : undefined, hasImage ? imageBase64 : undefined);
        return res.json(estimate);
    } catch (error) {
        return handleEstimateError(res, error, 'Failed to estimate meal');
    }
};

export const labelScanController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { imageBase64 } = req.body;
        if (typeof imageBase64 !== 'string' || imageBase64.length === 0) {
            return res.status(400).json({ error: 'imageBase64 is required' });
        }
        const scan = await scanLabel(userId, imageBase64);
        return res.json(scan);
    } catch (error) {
        return handleEstimateError(res, error, 'Failed to scan label');
    }
};
