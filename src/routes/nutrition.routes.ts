import { Router } from 'express';
import {
    aiUsageController,
    deleteMealEntryController,
    estimateController,
    getDailyMacrosController,
    getHistoryController,
    labelScanController,
    logMealEntryController,
    updateMealEntryController,
    updateTargetsController,
} from '../controllers/nutrition.controller';

const router = Router();

// Literal paths before parameterized ones (same rule as workout.routes.ts).
router.get('/macros/history', getHistoryController);
router.get('/macros/ai-usage', aiUsageController);
router.get('/macros/:date', getDailyMacrosController);

// Meals are a fixed per-day set (see DEFAULT_MEALS in nutrition.service) —
// there are intentionally no create/rename/delete meal routes.
router.post('/macros/meal/:mealId/entries', logMealEntryController);
router.put('/macros/entry/:id', updateMealEntryController);
router.delete('/macros/entry/:id', deleteMealEntryController);

router.post('/macros/estimate', estimateController);
router.post('/macros/label-scan', labelScanController);

router.put('/user/targets', updateTargetsController);

export default router;
