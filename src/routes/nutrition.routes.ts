import { Router } from 'express';
import {
    createMealController,
    deleteMealController,
    deleteMealEntryController,
    estimateController,
    getDailyMacrosController,
    getHistoryController,
    labelScanController,
    logMealEntryController,
    renameMealController,
    updateMealEntryController,
    updateTargetsController,
} from '../controllers/nutrition.controller';

const router = Router();

// Literal paths before parameterized ones (same rule as workout.routes.ts).
router.get('/macros/history', getHistoryController);
router.get('/macros/:date', getDailyMacrosController);

router.post('/macros/meals', createMealController);
router.put('/macros/meal/:id', renameMealController);
router.delete('/macros/meal/:id', deleteMealController);

router.post('/macros/meal/:mealId/entries', logMealEntryController);
router.put('/macros/entry/:id', updateMealEntryController);
router.delete('/macros/entry/:id', deleteMealEntryController);

router.post('/macros/estimate', estimateController);
router.post('/macros/label-scan', labelScanController);

router.put('/user/targets', updateTargetsController);

export default router;
