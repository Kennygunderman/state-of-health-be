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
import { UserNotProvisionedError } from '../services/user.service';
import { getUserId, getUserEmail } from '../utils/getUserId';
import { describeErrorSafely, logSafeEvent } from '../utils/safeLogger';

const DAY_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The route descriptors the safe server events below carry.
 *
 * They replace the fixed prose each `console.error` used to print as its first
 * argument: the route's identity is the useful half of those lines, and it is
 * the half that can be recorded without the error object beside it.
 */
const ACTIONS = {
    dailyMacros: 'diary.dailyMacros',
    logEntry: 'diary.logEntry',
    updateEntry: 'diary.updateEntry',
    deleteEntry: 'diary.deleteEntry',
    history: 'diary.history',
    updateTargets: 'diary.updateTargets',
    estimate: 'ai.estimate',
    labelScan: 'ai.labelScan',
    aiUsage: 'ai.usage',
} as const;

/**
 * Records one server fault on a diary route, with the route, the status and a
 * SAFE description of the throw — its class name and, when the runtime supplies
 * one, its machine code.
 *
 * This is the whole of what replaced `console.error('Error …:', error)` on the
 * nine failure paths in this file. Passing the error object rendered its stack,
 * a Prisma error's `meta` (which carries the failing statement's values) and,
 * on the estimate path, `EstimateFailedError.message` — which quotes the
 * vendor's own response text. None of that can satisfy AAP §0.3.2/§0.7.1, and
 * Rule backend-architecture §8 asks for a safe message rather than the raw
 * error. Replacing those nine lines changed no response: every status and body
 * these paths answer with is the one shipped clients already read.
 *
 * The diary's one deliberate status change is at the parsers, not here. A body
 * whose stored text carries U+0000 now earns `400 invalid_request` with
 * `invalid_characters` details — `nutrition.logic.ts::parseMealEntryEditBody`
 * judges `name` for `PUT /macros/entry/:id`, and `parseLogEntryBody` judges
 * `name`, `servingText` and `rawInput` for `POST /macros/meal/:mealId/entries`
 * — where that value used to reach the column, PostgreSQL refused it with
 * `22021` and the route answered 500. `api/log.test.ts` pins both statuses,
 * both bodies and the row the refusal leaves untouched.
 */
const logRouteFailure = (action: string, status: number, error: unknown): void => {
    logSafeEvent('error', 'request_failed', {
        action,
        status,
        ...describeErrorSafely(error),
    });
};

/**
 * Records one REFUSAL on a diary route — a request the server answered with a
 * 4xx it chose, not a fault it suffered.
 *
 * Separate from {@link logRouteFailure} and at `warn`, following the event
 * partition `mealPlanning.controller.ts` established and
 * `api/controllerBoundary.test.ts` pins ("a rejection is not also a failure"):
 * a `request_failed` at `error` says the server broke, and emitting one for a
 * 404 the code deliberately returns would make an interrupted sign-up read like
 * a server fault in every alert that watches that event.
 *
 * The one refusal that earns a line is the unprovisioned principal below: it is
 * invisible in the response (a 404 is indistinguishable from an absent row, by
 * design) and it is an operator's only signal that a sign-up completed its
 * Firebase half and not its `users` half. The route's other 404s — "Meal not
 * found", "Entry not found" — are ordinary and stay unlogged.
 */
const logRouteRejection = (action: string, status: number, code: string, error: unknown): void => {
    logSafeEvent('warn', 'request_rejected', {
        action,
        status,
        code,
        ...describeErrorSafely(error),
    });
};

/**
 * The body every legacy diary and food route answers an unprovisioned caller
 * with, and the machine code its rejection is logged under.
 *
 * Byte-identical to `updateTargetsController`'s existing 404 below, because
 * this is the legacy human-message family: `PUT /api/user/targets` has answered
 * exactly this for exactly this caller since before meal planning existed, and
 * a second spelling of "your account row is missing" would leave shipped
 * clients matching on two strings. The meal-planning routes answer the same
 * condition with their own machine-code envelope; these routes do not borrow it.
 */
const USER_NOT_PROVISIONED_BODY = { error: 'User not found' } as const;
const USER_NOT_PROVISIONED_CODE = 'user_not_provisioned';

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
        // The day read materializes the four meal buckets, so it is a WRITE for
        // a caller seeing a date for the first time, and `getDailyMacros`
        // refuses that write when no `users` row owns it. A permanent condition
        // the caller cannot retry away answers 404 rather than the 500 an
        // unmapped Prisma P2003 produced.
        if (error instanceof UserNotProvisionedError) {
            logRouteRejection(ACTIONS.dailyMacros, 404, USER_NOT_PROVISIONED_CODE, error);
            return res.status(404).json(USER_NOT_PROVISIONED_BODY);
        }
        logRouteFailure(ACTIONS.dailyMacros, 500, error);
        res.status(500).json({ error: 'Failed to get daily macros' });
    }
};

/**
 * The machine code §0.3.1 gives a body no shape could be chosen for. Spelled
 * here because for the `unrecognized_payload` verdict it is the value of `code`
 * and NOT of `error` — the verdict name itself is internal and never reaches the
 * wire.
 */
const UNRECOGNIZED_PAYLOAD_WIRE_CODE = 'invalid_payload';

// The 400 bodies these endpoints answer with, chosen from the parser's verdict
// rather than from the request, which the parser has already read.
//
// Three renderings, because three different things are being preserved:
//
//   * `legacy_fields_required` — message only. That string is what every client
//     sending a malformed legacy body has always been shown, and it carries no
//     code because the shipped response has none.
//   * `unrecognized_payload` — the same frozen string as `error`, PLUS the
//     machine code and the per-field details. A body naming no shape earned
//     that sentence long before the catalog shape existed and is the one
//     refusal here a shipped client can still reach, so replacing `error` with
//     the code would change a live response (§0.5.2) and would render the
//     literal word `invalid_payload` to a user; carrying both satisfies §0.3.1
//     at the same time.
//   * `invalid_request` / `invalid_payload` — the machine code as `error` with
//     the per-field details, so the caller learns which field to fix. Both
//     describe requests only a catalog-aware client can send (a catalog body's
//     own fields, a body naming two foods, a path id the database cannot parse),
//     none of which has a historical body to preserve.
//
// Exhaustive by construction — a new verdict code makes this function fall off
// its end and fail the build, rather than silently inheriting another case's
// body.
const logEntryErrorBody = (verdict: LogEntryErrorVerdict): Record<string, unknown> => {
    switch (verdict.code) {
        case 'legacy_fields_required':
            return { error: verdict.message };
        case 'unrecognized_payload':
            return { error: verdict.message, code: UNRECOGNIZED_PAYLOAD_WIRE_CODE, details: verdict.details };
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
        logRouteFailure(ACTIONS.logEntry, 500, error);
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
        logRouteFailure(ACTIONS.updateEntry, 500, error);
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
        logRouteFailure(ACTIONS.deleteEntry, 500, error);
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
        logRouteFailure(ACTIONS.history, 500, error);
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
        logRouteFailure(ACTIONS.updateTargets, 500, error);
        res.status(500).json({ error: 'Failed to update targets' });
    }
};

const handleEstimateError = (res: Response, error: unknown, action: string, fallback: string) => {
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
        // The class name and nothing else. `EstimateFailedError.message` is
        // built from the model's own failure text, so printing it put vendor
        // response content — the one thing a model boundary must not persist —
        // into the server log.
        logRouteFailure(action, 502, error);
        return res.status(502).json({ error: 'estimation_failed' });
    }
    logRouteFailure(action, 500, error);
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
        return handleEstimateError(res, error, ACTIONS.estimate, 'Failed to estimate meal');
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
        return handleEstimateError(res, error, ACTIONS.labelScan, 'Failed to scan label');
    }
};

// Feeds the app's "X of 5 AI estimates left today" meter.
export const aiUsageController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const usage = await getAiUsage(userId, getUserEmail(req));
        return res.json(usage);
    } catch (error) {
        logRouteFailure(ACTIONS.aiUsage, 500, error);
        res.status(500).json({ error: 'Failed to get AI usage' });
    }
};
