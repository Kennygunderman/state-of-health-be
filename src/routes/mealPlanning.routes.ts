import { Router } from 'express';
import {
    generatePlanController,
    getAffectedMealsController,
    getCurrentPlansController,
    getGroceryListController,
    getNutritionTargetsController,
    getPlanDayController,
    getPreferencesController,
    getSwapAlternativesController,
    getSwapPreviewController,
    getTargetEstimateController,
    logPlannedMealController,
    regeneratePlanController,
    saveNutritionTargetsController,
    savePreferencesController,
    saveSetupStepController,
    swapMealController,
    toggleGroceryItemController,
    uncheckAllGroceriesController,
} from '../controllers/mealPlanning.controller';

const router = Router();

router.get('/meal-planning/preferences', getPreferencesController);
router.put('/meal-planning/preferences', savePreferencesController);
router.put('/meal-planning/preferences/steps/:step', saveSetupStepController);

// The three routes mealPlanning.controller.ts leaves ungated by MEAL_PLANNING_ENABLED,
// unlike the other fifteen — keep the gate there rather than in router middleware.
router.get('/meal-planning/targets/estimate', getTargetEstimateController);
router.get('/meal-planning/targets', getNutritionTargetsController);
router.put('/meal-planning/targets', saveNutritionTargetsController);

// Literal paths before parameterized ones (Rule backend-architecture §3.1), the
// order nutrition.routes.ts depends on for /macros/history ahead of /macros/:date.
// Nothing registered here depends on it: every parameterized path below carries a
// further segment after :planId, so none of them can match /plans/current.
router.post('/meal-planning/plans', generatePlanController);
router.get('/meal-planning/plans/current', getCurrentPlansController);
router.get('/meal-planning/plans/:planId/days/:date', getPlanDayController);
router.get('/meal-planning/plans/:planId/affected-meals', getAffectedMealsController);
router.post('/meal-planning/plans/:planId/regenerate', regeneratePlanController);

router.get('/meal-planning/plans/:planId/meals/:mealId/alternatives/:recipeVersionId/preview', getSwapPreviewController);
router.get('/meal-planning/plans/:planId/meals/:mealId/alternatives', getSwapAlternativesController);
router.post('/meal-planning/plans/:planId/meals/:mealId/swap', swapMealController);
router.post('/meal-planning/plans/:planId/meals/:mealId/log', logPlannedMealController);

router.get('/meal-planning/plans/:planId/groceries', getGroceryListController);
router.post('/meal-planning/plans/:planId/groceries/uncheck-all', uncheckAllGroceriesController);
router.put('/meal-planning/plans/:planId/groceries/:itemId', toggleGroceryItemController);

export default router;
