import { Request, Response } from 'express';
import {
    parseGroceryItemPath,
    parseGroceryListPath,
    parseToggleGroceryBody,
} from '../services/grocery.logic';
import { getGroceryList, toggleGroceryItem, uncheckAllGroceries } from '../services/grocery.service';
import {
    generatePlan,
    getAffectedMeals,
    getCurrentMealPlan,
    getMealPlanDay,
    regeneratePlan,
} from '../services/mealPlan.service';
import {
    CatalogFoodNotFoundError,
    EstimateStaleError,
    EstimateUnavailableError,
    IdempotencyConflictError,
    MealPlanningDisabledError,
    NoMatchingMealsError,
    PlanGenerationError,
    PlanNotActiveError,
    PlanNotFoundError,
    PlanOverlapError,
    PreferencesIncompleteError,
    PreviewStaleError,
    ReadOnlyFieldError,
    RecipeIneligibleError,
    StalePlanError,
    StaleRevisionError,
    StaleTargetsError,
    SwapFailedError,
    TargetsMissingError,
    TargetsUnconfirmedError,
    UpcomingExistsError,
} from '../services/mealPlanning.errors';
import { logPlannedMeal } from '../services/plannedMealLog.service';
import { PREFERENCE_FIELD_CODES } from '../services/preferences.logic';
import { getPreferences, savePreferences, saveSetupStep } from '../services/preferences.service';
import { commitSwap, getSwapAlternatives, getSwapPreview } from '../services/swap.service';
import { getTargetEstimate, getTargets, saveTargets } from '../services/targets.service';
import { InvalidRequestDetail } from '../types/mealPlanning';
import { POST_COMMIT_ABORT_HEADER, isMealPlanningEnabled, postCommitAbort } from '../utils/featureFlags';
import { getUserId } from '../utils/getUserId';

const FEATURE_DISABLED = 'feature_disabled';
const INVALID_REQUEST = 'invalid_request';
const PLAN_NOT_FOUND = 'Plan not found';

const assertMealPlanningEnabled = (): void => {
    if (!isMealPlanningEnabled()) {
        throw new MealPlanningDisabledError();
    }
};

const refuseInvalidRequest = (res: Response, verdict: { code: string; details: InvalidRequestDetail[] }) =>
    res.status(400).json({ error: verdict.code, details: verdict.details });

const handleMealPlanningError = (res: Response, error: unknown, fallback: string) => {
    if (error instanceof PreferencesIncompleteError) {
        return res.status(409).json({ error: 'preferences_incomplete' });
    }
    if (error instanceof StaleRevisionError) {
        return res.status(409).json({ error: 'stale_revision', ...error.data });
    }
    if (error instanceof StaleTargetsError) {
        return res.status(409).json({ error: 'stale_targets', currentRevision: error.currentRevision });
    }
    if (error instanceof EstimateStaleError) {
        return res.status(409).json({ error: 'estimate_stale' });
    }
    if (error instanceof EstimateUnavailableError) {
        return res.status(409).json({ error: 'estimate_unavailable', reason: error.reason });
    }
    if (error instanceof TargetsUnconfirmedError) {
        return res.status(409).json({ error: 'targets_unconfirmed' });
    }
    if (error instanceof PlanOverlapError) {
        return res.status(409).json({ error: 'plan_overlap', conflictingPlanId: error.conflictingPlanId });
    }
    if (error instanceof UpcomingExistsError) {
        return res.status(409).json({ error: 'upcoming_exists' });
    }
    if (error instanceof StalePlanError) {
        return res.status(409).json({ error: 'stale_plan', currentRevision: error.currentRevision });
    }
    if (error instanceof PlanNotActiveError) {
        return res.status(409).json({ error: 'plan_not_active', ...error.data });
    }
    if (error instanceof IdempotencyConflictError) {
        return res.status(409).json({ error: 'idempotency_conflict' });
    }
    if (error instanceof PreviewStaleError) {
        return res.status(409).json({ error: 'preview_stale' });
    }
    if (error instanceof ReadOnlyFieldError) {
        return res.status(400).json({
            error: INVALID_REQUEST,
            details: [{ field: error.field, code: PREFERENCE_FIELD_CODES.READ_ONLY_FIELD }],
        });
    }
    if (error instanceof TargetsMissingError) {
        return res.status(422).json({ error: 'targets_missing', missing: error.missing });
    }
    if (error instanceof NoMatchingMealsError) {
        if (error.searchDiagnostics !== undefined) {
            console.error('No meals matched these preferences:', error.searchDiagnostics);
        }
        return res.status(422).json({
            error: 'no_matching_meals',
            limitingConstraints: error.limitingConstraints,
            allergiesKept: error.allergiesKept,
        });
    }
    if (error instanceof RecipeIneligibleError) {
        return res.status(422).json({ error: 'recipe_ineligible' });
    }
    if (error instanceof PlanGenerationError) {
        console.error('Plan generation failed:', error.cause ?? error.message);
        return res.status(502).json({ error: 'plan_generation_failed' });
    }
    if (error instanceof SwapFailedError) {
        console.error('Meal swap failed:', error.cause ?? error.message);
        return res.status(502).json({ error: 'swap_failed' });
    }
    if (error instanceof PlanNotFoundError) {
        return res.status(404).json({ error: PLAN_NOT_FOUND });
    }
    if (error instanceof CatalogFoodNotFoundError) {
        return res.status(404).json({ error: 'catalog_food_not_found' });
    }
    if (error instanceof MealPlanningDisabledError) {
        return res.status(503).json({ error: FEATURE_DISABLED });
    }
    console.error(fallback, error);
    return res.status(500).json({ error: fallback });
};

export const getPreferencesController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const preferences = await getPreferences(userId);
        return res.json(preferences);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to get meal plan preferences');
    }
};

export const saveSetupStepController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const saved = await saveSetupStep(userId, req.params.step, req.body);
        if (saved.kind !== 'ok') {
            return refuseInvalidRequest(res, saved);
        }
        return res.json(saved.response);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to save meal plan setup step');
    }
};

export const savePreferencesController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const saved = await savePreferences(userId, req.body);
        if (saved.kind !== 'ok') {
            return refuseInvalidRequest(res, saved);
        }
        return res.json(saved.response);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to save meal plan preferences');
    }
};

// The three targets routes are deliberately NOT gated by
// `assertMealPlanningEnabled()`, unlike every other handler in this file:
// Account, Progress and the diary's target editor read and write nutrition
// targets through them, so turning meal planning off must leave them answering
// normally rather than 503 (AAP §0.5.2, §0.7.5).
export const getTargetEstimateController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const estimate = await getTargetEstimate(userId);
        return res.json(estimate);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to get nutrition target estimate');
    }
};

export const getNutritionTargetsController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const targets = await getTargets(userId);
        return res.json(targets);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to get nutrition targets');
    }
};

export const saveNutritionTargetsController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const saved = await saveTargets(userId, req.body);
        if (saved.kind !== 'ok') {
            return refuseInvalidRequest(res, saved);
        }
        return res.json(saved.response);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to save nutrition targets');
    }
};

export const generatePlanController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const generated = await generatePlan(userId, req.body);
        if (generated.kind !== 'ok') {
            return refuseInvalidRequest(res, generated);
        }
        if (postCommitAbort('generate', req.header(POST_COMMIT_ABORT_HEADER))) {
            res.socket?.destroy();
            return;
        }
        return res.status(generated.result.status).json(generated.result.body);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to generate meal plan');
    }
};

export const getCurrentPlansController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const plans = await getCurrentMealPlan(userId);
        return res.json(plans);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to get the current meal plan');
    }
};

export const getPlanDayController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const day = await getMealPlanDay(userId, req.params.planId, req.params.date);
        if (day.kind !== 'ok') {
            return refuseInvalidRequest(res, day);
        }
        return res.json(day.envelope);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to get the meal plan day');
    }
};

export const regeneratePlanController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const regenerated = await regeneratePlan(userId, req.params.planId, req.body);
        if (regenerated.kind !== 'ok') {
            return refuseInvalidRequest(res, regenerated);
        }
        if (postCommitAbort('regenerate', req.header(POST_COMMIT_ABORT_HEADER))) {
            res.socket?.destroy();
            return;
        }
        return res.status(regenerated.result.status).json(regenerated.result.body);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to regenerate the meal plan');
    }
};

export const getAffectedMealsController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const affected = await getAffectedMeals(userId, req.params.planId);
        if (affected.kind !== 'ok') {
            return refuseInvalidRequest(res, affected);
        }
        return res.json(affected.response);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to get the affected meals');
    }
};

export const getSwapAlternativesController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const alternatives = await getSwapAlternatives(userId, req.params.planId, req.params.mealId);
        if (alternatives.kind !== 'ok') {
            return refuseInvalidRequest(res, alternatives);
        }
        return res.json(alternatives.response);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to get swap alternatives');
    }
};

export const getSwapPreviewController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const preview = await getSwapPreview(
            userId,
            req.params.planId,
            req.params.mealId,
            req.params.recipeVersionId,
        );
        if (preview.kind !== 'ok') {
            return refuseInvalidRequest(res, preview);
        }
        return res.json(preview.response);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to get the swap preview');
    }
};

export const swapMealController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const swapped = await commitSwap(userId, req.params.planId, req.params.mealId, req.body);
        if (swapped.kind !== 'ok') {
            return refuseInvalidRequest(res, swapped);
        }
        if (postCommitAbort('swap', req.header(POST_COMMIT_ABORT_HEADER))) {
            res.socket?.destroy();
            return;
        }
        return res.status(swapped.result.status).json(swapped.result.body);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to swap the meal');
    }
};

export const getGroceryListController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const path = parseGroceryListPath(req.params);
        if (path.kind !== 'ok') {
            return refuseInvalidRequest(res, path);
        }
        const groceries = await getGroceryList(userId, path.planId);
        return res.json(groceries);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to get the grocery list');
    }
};

export const toggleGroceryItemController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const path = parseGroceryItemPath(req.params);
        if (path.kind !== 'ok') {
            return refuseInvalidRequest(res, path);
        }
        const body = parseToggleGroceryBody(req.body);
        if (body.kind !== 'ok') {
            return refuseInvalidRequest(res, body);
        }
        const toggled = await toggleGroceryItem(userId, path.planId, path.itemId, body.payload);
        return res.json(toggled);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to update the grocery item');
    }
};

export const uncheckAllGroceriesController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const path = parseGroceryListPath(req.params);
        if (path.kind !== 'ok') {
            return refuseInvalidRequest(res, path);
        }
        const unchecked = await uncheckAllGroceries(userId, path.planId);
        return res.json(unchecked);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to uncheck the grocery list');
    }
};

export const logPlannedMealController = async (req: Request, res: Response) => {
    try {
        assertMealPlanningEnabled();
        const userId = getUserId(req);
        const logged = await logPlannedMeal(userId, req.params.planId, req.params.mealId, req.body);
        if (logged.kind !== 'ok') {
            return refuseInvalidRequest(res, logged);
        }
        if (postCommitAbort('log', req.header(POST_COMMIT_ABORT_HEADER))) {
            res.socket?.destroy();
            return;
        }
        return res.status(logged.result.status).json(logged.result.body);
    } catch (error) {
        return handleMealPlanningError(res, error, 'Failed to log the planned meal');
    }
};
