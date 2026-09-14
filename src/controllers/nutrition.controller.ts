import { Request, Response } from 'express';
import {
    deleteMealEntry,
    getDailyMacros,
    getHistory,
    logCatalogMealEntry,
    logMealEntry,
    updateMealEntry,
    updateTargets,
} from '../services/nutrition.service';
import {
    InvalidServingError,
    LogEntryErrorVerdict,
    parseEntryPath,
    parseLogEntryBody,
    parseMealEntryEditBody,
    parseMealEntryPath,
} from '../services/nutrition.logic';
import { estimateMeal, scanLabel, EstimateFailedError } from '../services/estimate.service';
import {
    assertAndConsumeAiCall,
    getAiUsage,
    DailyQuotaError,
    FeatureDisabledError,
} from '../services/entitlement.service';
import { CatalogFoodNotFoundError } from '../services/mealPlanning.errors';
import { getUserId, getUserEmail } from '../utils/getUserId';

const DAY_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

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

// The three 400 bodies these endpoints answer with, chosen from the parser's
// verdict rather than from the request, which the parser has already read. Only
// the legacy guard's verdict gets a message and no code: that string is what
// every client sending a malformed legacy body has always been shown. A catalog
// body, a shapeless body and a malformed path id get the machine code and the
// per-field details instead, so the caller learns which field to fix.
// Exhaustive by construction — a fourth verdict code makes this function fall
// off its end and fail the build, rather than silently inheriting the legacy
// body.
const logEntryErrorBody = (verdict: LogEntryErrorVerdict): Record<string, unknown> => {
    switch (verdict.code) {
        case 'legacy_fields_required':
            return { error: verdict.message };
        case 'invalid_request':
        case 'invalid_payload':
            return { error: verdict.code, details: verdict.details };
    }
};

export const logMealEntryController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const parsed = parseLogEntryBody(req.body);
        if (parsed.kind === 'error') {
            return res.status(400).json(logEntryErrorBody(parsed));
        }

        // The path is judged BEFORE either writer, because `:mealId` reaches a
        // `@db.Uuid` predicate in both of them and an unparsable id would come
        // back from PostgreSQL as a 500 for a request only the caller can fix.
        // It is judged AFTER the body deliberately: a malformed body must keep
        // earning the frozen 400 that shipped clients read, so this check only
        // speaks where the request would otherwise have reached the database.
        // The path is judged BEFORE either writer, because `:mealId` reaches a
        // `@db.Uuid` predicate in both of them and an unparsable id would come
        // back from PostgreSQL as a 500 for a request only the caller can fix.
        // It is judged AFTER the body deliberately: a malformed body must keep
        // earning the frozen 400 that shipped clients read, so this check only
        // speaks where the request would otherwise have reached the database.
        const path = parseMealEntryPath(req.params);
        if (path.kind === 'error') {
            return res.status(400).json(logEntryErrorBody(path));
        }

        const entry =
            parsed.kind === 'catalog'
                ? await logCatalogMealEntry(userId, path.mealId, parsed.payload)
                : await logMealEntry(userId, path.mealId, parsed.payload);
        if (!entry) {
            return res.status(404).json({ error: 'Meal not found' });
        }
        return res.status(201).json(entry);
    } catch (error) {
        if (error instanceof CatalogFoodNotFoundError) {
            return res.status(404).json({ error: 'catalog_food_not_found' });
        }
        if (error instanceof InvalidServingError) {
            return res.status(400).json({ error: 'invalid_serving' });
        }
        console.error('Error logging meal entry:', error);
        res.status(500).json({ error: 'Failed to log meal entry' });
    }
};

export const updateMealEntryController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);

        // Same reason as the log route: `:id` is the `meal_entries` primary key,
        // so a malformed one is a PostgreSQL syntax error rather than a missing
        // row. A well-formed id that is absent or someone else's still answers
        // 404, and the two cases stay indistinguishable.
        const path = parseEntryPath(req.params);
        if (path.kind === 'error') {
            return res.status(400).json(logEntryErrorBody(path));
        }

        // The body's one unanswerable failure, judged for the same reason as the
        // path: a `name` carrying U+0000 reaches `meal_entries.name`, which
        // PostgreSQL refuses, and the caller is the only one who can fix it.
        // Everything else this route has always accepted it still accepts.
        const body = parseMealEntryEditBody(req.body);
        if (body.kind === 'error') {
            return res.status(400).json(logEntryErrorBody(body));
        }

        const entry = await updateMealEntry(userId, path.entryId, body.payload);
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

        const path = parseEntryPath(req.params);
        if (path.kind === 'error') {
            return res.status(400).json(logEntryErrorBody(path));
        }

        const deleted = await deleteMealEntry(userId, path.entryId);
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
