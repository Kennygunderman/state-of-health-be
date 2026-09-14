// The reads below are this feature's one sanctioned exception to
// backend-architecture §5.1 ("every `where` includes the owner key"):
// `catalog_foods` and `recipe_versions` carry no `user_id` at all — they are
// shared reference data, the same catalog and the same recipes for every user —
// so those reads have no owner to scope to and no cross-user row to leak. They
// are still authenticated (this router mounts after `authenticateFirebaseToken`)
// and the caller is still resolved in every handler; the resolved id simply has
// nothing to scope in the three catalog reads, which is why
// `catalog.service.ts` accepts no `userId`. The one per-user question these
// routes ask — may this caller see a RETIRED recipe version? — belongs to
// `recipe.service.getRecipeVersionForUser`, whose reference checks are scoped
// by `user_id`.

import { Request, Response } from 'express';
import { parseCatalogSearchQuery } from '../services/catalog.logic';
import {
    CatalogSuggestionKind,
    getStatus,
    getSuggestions,
    searchPublishedFoods,
} from '../services/catalog.service';
import { MealPlanningDisabledError } from '../services/mealPlanning.errors';
import { getRecipeVersionForUser } from '../services/recipe.service';
import { CatalogSearchResponse } from '../types/catalog';
import { isMealPlanningEnabled } from '../utils/featureFlags';
import { getUserId } from '../utils/getUserId';
import {
    DEFAULT_LIMIT,
    MAX_LIMIT,
    parsePagination,
    toPaginationBlock,
} from '../utils/pagination';

const FEATURE_DISABLED = 'feature_disabled';
const INVALID_REQUEST = 'invalid_request';
const RECIPE_NOT_FOUND = 'Recipe not found';

const SUGGESTION_KIND: CatalogSuggestionKind = 'dislike';
const SUGGESTION_KIND_FIELD = 'kind';
const SUGGESTIONS_DEFAULT_LIMIT = 12;
const SUGGESTIONS_MAX_LIMIT = 30;

const handleCatalogError = (res: Response, error: unknown, fallback: string) => {
    if (error instanceof MealPlanningDisabledError) {
        return res.status(503).json({ error: FEATURE_DISABLED });
    }
    console.error(fallback, error);
    return res.status(500).json({ error: fallback });
};

export const searchCatalogFoodsController = async (req: Request, res: Response) => {
    try {
        getUserId(req);
        const parsed = parseCatalogSearchQuery(req.query.q);
        if (parsed.kind !== 'ok') {
            return res.status(400).json({ error: parsed.code, details: parsed.details });
        }
        const { page, limit } = parsePagination(req.query, {
            defaultLimit: DEFAULT_LIMIT,
            maxLimit: MAX_LIMIT,
        });
        const { items, total } = await searchPublishedFoods(parsed.q, page, limit);
        const response: CatalogSearchResponse = {
            items,
            pagination: toPaginationBlock(total, page, limit),
        };
        return res.json(response);
    } catch (error) {
        return handleCatalogError(res, error, 'Failed to search catalog foods');
    }
};

export const getCatalogSuggestionsController = async (req: Request, res: Response) => {
    try {
        getUserId(req);
        const requestedKind = Array.isArray(req.query.kind) ? req.query.kind[0] : req.query.kind;
        if (requestedKind !== SUGGESTION_KIND) {
            return res.status(400).json({
                error: INVALID_REQUEST,
                details: [{ field: SUGGESTION_KIND_FIELD, code: 'unsupported' }],
            });
        }
        const { limit } = parsePagination(req.query, {
            defaultLimit: SUGGESTIONS_DEFAULT_LIMIT,
            maxLimit: SUGGESTIONS_MAX_LIMIT,
        });
        const suggestions = await getSuggestions(SUGGESTION_KIND, limit);
        return res.json(suggestions);
    } catch (error) {
        return handleCatalogError(res, error, 'Failed to get catalog suggestions');
    }
};

export const getCatalogStatusController = async (req: Request, res: Response) => {
    try {
        getUserId(req);
        const status = await getStatus();
        return res.json(status);
    } catch (error) {
        return handleCatalogError(res, error, 'Failed to get catalog status');
    }
};

export const getRecipeVersionController = async (req: Request, res: Response) => {
    if (!isMealPlanningEnabled()) {
        return res.status(503).json({ error: FEATURE_DISABLED });
    }
    try {
        const userId = getUserId(req);
        const result = await getRecipeVersionForUser(userId, req.params.recipeVersionId);
        if (result.kind !== 'ok') {
            return res.status(400).json({ error: result.code, details: result.details });
        }
        if (result.version === null) {
            return res.status(404).json({ error: RECIPE_NOT_FOUND });
        }
        return res.json(result.version);
    } catch (error) {
        return handleCatalogError(res, error, 'Failed to get recipe');
    }
};
