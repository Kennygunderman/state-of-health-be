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
//
// EVERY HANDLER HERE IS `getUserId(req)` → A PURE PARSER → ONE SERVICE CALL
// (AAP §0.7.2, Rule backend-architecture §4). Each request decision these four
// routes make is owned by a `*.logic.ts` function this file calls —
// `parseCatalogSearchQuery` and `parseCatalogSuggestionsQuery` in
// `catalog.logic.ts`, `parseRecipeVersionPath` in `recipe.logic.ts`, and
// `parsePagination` for the shared page block — so no allowed-value check or
// coercion is written inline below, and no service is handed a raw request
// value or asked to answer with a 400-shaped verdict. That is what keeps the
// validation rules unit-testable without HTTP and the services HTTP-agnostic
// (§8): they return a DTO or `null`, and the mapping to 400/404/503 happens
// only in this file.

import { Request, Response } from 'express';
import { parseCatalogSearchQuery, parseCatalogSuggestionsQuery } from '../services/catalog.logic';
import { getStatus, getSuggestions, searchPublishedFoods } from '../services/catalog.service';
import { MealPlanningDisabledError } from '../services/mealPlanning.errors';
import { parseRecipeVersionPath } from '../services/recipe.logic';
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
const RECIPE_NOT_FOUND = 'Recipe not found';

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
        const parsed = parseCatalogSuggestionsQuery(req.query);
        if (parsed.kind !== 'ok') {
            return res.status(400).json({ error: parsed.code, details: parsed.details });
        }
        const suggestions = await getSuggestions(parsed.suggestionKind, parsed.limit);
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
        const parsed = parseRecipeVersionPath(req.params);
        if (parsed.kind !== 'ok') {
            return res.status(400).json({ error: parsed.code, details: parsed.details });
        }
        const version = await getRecipeVersionForUser(userId, parsed.recipeVersionId);
        if (version === null) {
            return res.status(404).json({ error: RECIPE_NOT_FOUND });
        }
        return res.json(version);
    } catch (error) {
        return handleCatalogError(res, error, 'Failed to get recipe');
    }
};
