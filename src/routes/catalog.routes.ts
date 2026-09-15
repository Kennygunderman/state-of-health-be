import { Router } from 'express';
import {
    getCatalogStatusController,
    getCatalogSuggestionsController,
    getRecipeVersionController,
    searchCatalogFoodsController,
} from '../controllers/catalog.controller';

const router = Router();

router.get('/catalog/foods/suggestions', getCatalogSuggestionsController);
router.get('/catalog/foods', searchCatalogFoodsController);
router.get('/catalog/status', getCatalogStatusController);

// Only this read is gated: the controller answers 503 feature_disabled when
// MEAL_PLANNING_ENABLED is off. The catalog reads above are never gated — Add
// Food's catalog section does not depend on meal planning.
router.get('/recipes/:recipeVersionId', getRecipeVersionController);

export default router;
