import { Request, Response } from 'express';
import {
    deleteMealEntry,
    getDailyMacros,
    getHistory,
    logMealEntry,
    updateMealEntry,
    updateTargets,
} from '../services/nutrition.service';
import { estimateMeal, scanLabel, EstimateFailedError } from '../services/estimate.service';
import {
    assertAndConsumeAiCall,
    getAiUsage,
    DailyQuotaError,
    FeatureDisabledError,
} from '../services/entitlement.service';
import { getUserId, getUserEmail } from '../utils/getUserId';

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
    if (error instanceof FeatureDisabledError) {
        return res.status(503).json({ error: 'feature_disabled' });
    }
    if (error instanceof DailyQuotaError) {
        return res.status(429).json({
            error: 'quota_exceeded',
            used: error.used,
            limit: error.limit,
            resetsAt: error.resetsAt,
        });
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
        await assertAndConsumeAiCall(userId, getUserEmail(req));
        const estimate = await estimateMeal(hasText ? text.trim() : undefined, hasImage ? imageBase64 : undefined);
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
        await assertAndConsumeAiCall(userId, getUserEmail(req));
        const scan = await scanLabel(imageBase64);
        return res.json(scan);
    } catch (error) {
        return handleEstimateError(res, error, 'Failed to scan label');
    }
};

// Feeds the app's "X of 5 AI estimates left today" meter.
export const aiUsageController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const usage = await getAiUsage(userId, getUserEmail(req));
        return res.json(usage);
    } catch (error) {
        console.error('Error getting AI usage:', error);
        res.status(500).json({ error: 'Failed to get AI usage' });
    }
};
