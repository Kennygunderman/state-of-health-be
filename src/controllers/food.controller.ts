import { Request, Response } from 'express';
import { FoodErrorVerdict, parseCreateFoodBody, parseFoodPath, parseUpdateFoodBody } from '../services/food.logic';
import { createFood, deleteFood, getFoodsForUser, updateFood } from '../services/food.service';
import { getBrandedFood, searchBrandedFoods, UsdaError } from '../services/usda.service';
import { UserNotProvisionedError } from '../services/user.service';
import { getUserId } from '../utils/getUserId';
import { describeErrorSafely, logSafeEvent } from '../utils/safeLogger';

/**
 * The route descriptors the safe server events below carry.
 *
 * They replace the fixed prose each `console.error` printed as its first
 * argument: the route's identity is the useful half of those lines, and it is
 * the half that can be recorded without the error object beside it. The dots
 * live in this field and never in an event NAME — `safeLogger`'s
 * `EVENT_NAME_PATTERN` admits no `.` and rewrites a dotted name to
 * `unnamed_event`.
 */
const ACTIONS = {
    list: 'food.list',
    create: 'food.create',
    update: 'food.update',
    delete: 'food.delete',
    searchBranded: 'food.searchBranded',
    brandedDetail: 'food.brandedDetail',
} as const;

/**
 * Records one server fault on a food route, with the route, the status and a
 * SAFE description of the throw — its class name and, when the runtime supplies
 * one, its machine code.
 *
 * This is the whole of what replaced `console.error('…', error)` on the six
 * logging sites in this file, and it is the fix for a measured leak rather than
 * a tidy-up. One `POST /api/foods` 500 printed: a Prisma stack with fourteen
 * absolute filesystem paths, a four-line source excerpt of `food.service.ts`,
 * five frames inside `src/generated/prisma/runtime/library.js`, the connector's
 * error quoting the offending value, the whole `data {…}` payload INCLUDING
 * `user_id`, and `clientVersion: '6.9.0'`. None of that can satisfy AAP
 * §0.3.2/§0.7.1, and Rule backend-architecture §8 asks for a safe message
 * rather than the raw error. `describeErrorSafely` cannot express any of it:
 * `message`, `stack`, `cause` and `meta` are unreachable through it.
 *
 * Identical in shape to `nutrition.controller.ts::logRouteFailure`, because an
 * operator's query is a literal and the two legacy families must be greppable
 * as one stream. No response changed: every status and body these paths answer
 * with is the one shipped clients already read.
 */
const logRouteFailure = (action: string, status: number, error: unknown): void => {
    logSafeEvent('error', 'request_failed', {
        action,
        status,
        ...describeErrorSafely(error),
    });
};

/**
 * Records one REFUSAL on a food route — a request the server answered with a
 * 4xx it chose, not a fault it suffered.
 *
 * Separate from {@link logRouteFailure} and at `warn`, following the partition
 * `nutrition.controller.ts` and `mealPlanning.controller.ts` established and
 * `api/controllerBoundary.test.ts` pins ("a rejection is not also a failure"):
 * a `request_failed` at `error` says the server broke, and emitting one for a
 * 404 the code deliberately returns would make an interrupted sign-up read like
 * a server fault in every alert that watches that event.
 *
 * The one refusal that earns a line is the unprovisioned principal below — the
 * same condition, the same code and the same body as the diary's day read,
 * which is invisible in the response by design and is an operator's only signal
 * that a sign-up completed its Firebase half and not its `users` half. This
 * route's other refusals are ordinary and stay unlogged: "Food not found" and
 * "Branded food not found" are answers, and a 400 from the payload parsers
 * names the field the caller must fix in the response itself.
 */
const logRouteRejection = (action: string, status: number, code: string, error: unknown): void => {
    logSafeEvent('warn', 'request_rejected', {
        action,
        status,
        code,
        ...describeErrorSafely(error),
    });
};

/** The machine code the unprovisioned-principal refusal is logged under, as the diary spells it. */
const USER_NOT_PROVISIONED_CODE = 'user_not_provisioned';

/**
 * The 400 body a refused food write answers with, chosen from the parser's
 * verdict.
 *
 * Two renderings, the same split `nutrition.controller.ts::logEntryErrorBody`
 * documents: the frozen sentence is the response every client sending a
 * nameless or non-numeric create body has always read and carries no code,
 * while a field outside its contract is a refusal no shipped client can have
 * seen and is rendered as §0.5.2's machine-readable envelope. Exhaustive by
 * construction — a new verdict code fails the build rather than inheriting a
 * body it was not written for.
 */
const foodErrorBody = (verdict: FoodErrorVerdict): Record<string, unknown> => {
    switch (verdict.code) {
        case 'food_fields_required':
            return { error: verdict.message };
        case 'invalid_request':
            return { error: verdict.code, details: verdict.details };
    }
};

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
        // The first fetch seeds the four starter foods, so this read is a WRITE
        // for a library that has never held a row, and `getFoodsForUser` refuses
        // that write when no `users` row owns it. The body is the one
        // `PUT /api/user/targets` has always answered for the same caller, so a
        // missing account row reads identically wherever a legacy route meets
        // it — instead of the 500 an unmapped Prisma P2003 produced here.
        if (error instanceof UserNotProvisionedError) {
            logRouteRejection(ACTIONS.list, 404, USER_NOT_PROVISIONED_CODE, error);
            return res.status(404).json({ error: 'User not found' });
        }
        logRouteFailure(ACTIONS.list, 500, error);
        res.status(500).json({ error: 'Failed to get foods' });
    }
};

export const createFoodController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);

        // The shipped `isValidFoodPayload` guard, moved into
        // `food.logic.ts::parseCreateFoodBody` with the §0.5.2 bounds beside it
        // (Rule backend-architecture §4 — the predicate is pure logic the
        // controller delegates to). The frozen sentence still answers every
        // body the guard already refused; a macro or `servingAmount` past the
        // column's range now earns `400 invalid_request` where it used to be
        // rounded, handed to PostgreSQL and answered with a 500.
        const parsed = parseCreateFoodBody(req.body);
        if (parsed.kind === 'error') {
            return res.status(400).json(foodErrorBody(parsed));
        }

        const food = await createFood(userId, parsed.payload);
        return res.status(201).json(food);
    } catch (error) {
        logRouteFailure(ACTIONS.create, 500, error);
        res.status(500).json({ error: 'Failed to create food' });
    }
};

export const updateFoodController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);

        // This route validated nothing: `updateFood` called
        // `payload.name.trim()` on an unvalidated body, so `{"name": 123}` was
        // a TypeError and a 500, and every numeric overflowed its column the
        // same way the create route's did. The parse is judged BEFORE the
        // ownership read deliberately — a malformed body is the caller's to fix
        // whether or not the food is theirs, and answering 400 without reading
        // the row tells them nothing about whether it exists.
        // The path is judged with the body, and for the same reason: an
        // unparsable id used to reach Prisma and answer 500 (P2023) where the
        // diary's own routes answer `400 invalid_id` for the identical input.
        const path = parseFoodPath(req.params.id);
        if (path.kind === 'error') {
            return res.status(400).json(foodErrorBody(path));
        }

        const parsed = parseUpdateFoodBody(req.body);
        if (parsed.kind === 'error') {
            return res.status(400).json(foodErrorBody(parsed));
        }

        const food = await updateFood(userId, path.id, parsed.payload);
        if (!food) {
            return res.status(404).json({ error: 'Food not found' });
        }
        return res.json(food);
    } catch (error) {
        logRouteFailure(ACTIONS.update, 500, error);
        res.status(500).json({ error: 'Failed to update food' });
    }
};

export const deleteFoodController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const path = parseFoodPath(req.params.id);
        if (path.kind === 'error') {
            return res.status(400).json(foodErrorBody(path));
        }

        const deleted = await deleteFood(userId, path.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Food not found' });
        }
        return res.json({ success: true });
    } catch (error) {
        logRouteFailure(ACTIONS.delete, 500, error);
        res.status(500).json({ error: 'Failed to delete food' });
    }
};

/**
 * Maps a vendor failure on the two branded-food routes, and records it safely.
 *
 * `error.message` is NOT logged, and that is the point of this function rather
 * than a detail of it: `UsdaError.message` is built from the vendor's own
 * response text, which is the one thing a vendor boundary must never persist —
 * `nutrition.controller.ts::handleEstimateError` states the same rule for
 * `EstimateFailedError.message` and this file now follows it. The class name
 * and the status are what an operator needs to tell a vendor outage from a
 * fault in our own handler, and `describeErrorSafely` supplies exactly that.
 *
 * Both responses are unchanged, including the shared `fallback` string that is
 * still this 500's body.
 */
const handleUsdaError = (res: Response, error: unknown, action: string, fallback: string) => {
    if (error instanceof UsdaError) {
        logRouteFailure(action, 502, error);
        return res.status(502).json({ error: 'branded_search_failed' });
    }
    logRouteFailure(action, 500, error);
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
        return handleUsdaError(res, error, ACTIONS.searchBranded, 'Failed to search branded foods');
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
        return handleUsdaError(res, error, ACTIONS.brandedDetail, 'Failed to get branded food');
    }
};
