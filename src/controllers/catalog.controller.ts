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
// EVERY HANDLER HERE RESOLVES THE CALLER FIRST WITH `getUserId(req)`, AND
// EVERY INPUT-BEARING ONE THEN RUNS A PURE PARSER BEFORE ITS ONE SERVICE CALL
// (AAP §0.7.2, Rule backend-architecture §4). `/catalog/status` is the
// exception to the parser half and only to it: the request carries no path
// segment, no query and no body, so there is nothing to parse and
// `getCatalogStatusController` calls `getStatus()` directly. The gated recipe
// read adds one step to the sequence and nothing else — its
// `MEAL_PLANNING_ENABLED` check sits between the resolved caller and the
// parser, for the reason stated at that check.
//
// Each request decision the three input-bearing routes make is owned by a
// `*.logic.ts` function this file calls — `parseCatalogSearchRequest` and
// `parseCatalogSuggestionsQuery` in `catalog.logic.ts`, and
// `parseRecipeVersionPath` in `recipe.logic.ts` — so no allowed-value check or
// coercion is written inline below, and no service is handed a raw request
// value or asked to answer with a 400-shaped verdict. That is what keeps the
// validation rules unit-testable without HTTP and the services HTTP-agnostic
// (§8): they return a DTO or `null`, and the mapping to 400/404/503 happens
// only in this file.
//
// THE PAGE BLOCK IS PARSED, NOT CLAMPED. `?page=` and `?limit=` used to be read
// here through the lenient `parsePagination`, which bounds whatever it is given
// — so `?page=0`, `?page=2.7`, `?page=-1`, `?page=abc` and `?limit=1000` were
// rewritten into a valid request and answered `200 OK`, reporting success for
// input nobody sent (CWE-20). `parseCatalogSearchRequest` now validates `q` and
// the page block as ONE verdict, and the same strict rule reaches
// `/catalog/foods/suggestions` through its own parser, so every malformed page
// block leaves this file as `400 invalid_request` with the field named — and it
// does so before a service, and therefore before Prisma, is reached (§0.5.2).
// `toPaginationBlock` still builds the response envelope from the parsed pair,
// so the request and the block it is answered with can never disagree.

import { Request, Response } from 'express';
import { parseCatalogSearchRequest, parseCatalogSuggestionsQuery } from '../services/catalog.logic';
import { getStatus, getSuggestions, searchPublishedFoods } from '../services/catalog.service';
import { MealPlanningDisabledError } from '../services/mealPlanning.errors';
import { parseRecipeVersionPath } from '../services/recipe.logic';
import { getRecipeVersionForUser } from '../services/recipe.service';
import { CatalogSearchResponse } from '../types/catalog';
import { isMealPlanningEnabled } from '../utils/featureFlags';
import { getUserId } from '../utils/getUserId';
import { toPaginationBlock } from '../utils/pagination';

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
        const parsed = parseCatalogSearchRequest(req.query);
        if (parsed.kind !== 'ok') {
            return res.status(400).json({ error: parsed.code, details: parsed.details });
        }
        const { items, total } = await searchPublishedFoods(parsed.q, parsed.page, parsed.limit);
        const response: CatalogSearchResponse = {
            items,
            pagination: toPaginationBlock(total, parsed.page, parsed.limit),
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
    try {
        // The kill switch is checked AFTER `getUserId(req)`, not before it, the
        // same way `mealPlanning.controller.ts` checks it in all fifteen gated
        // handlers (AAP §0.7.2, Rule backend-architecture §4). The order changes
        // no response — this router mounts after `authenticateFirebaseToken`, so
        // `req.user` is already populated and `getUserId` cannot fail where the
        // gate would have run — it only keeps the caller resolved by the time
        // the refusal is decided, which is what makes a support question about
        // one account during a rollout answerable.
        //
        // It still runs BEFORE the parser and BEFORE the lookup, so a refusal
        // cannot reveal whether a version is well-formed, exists, or is this
        // caller's (AAP §0.9.2's recipe visibility rule).
        const userId = getUserId(req);
        if (!isMealPlanningEnabled()) {
            return res.status(503).json({ error: FEATURE_DISABLED });
        }
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
