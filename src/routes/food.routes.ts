import { Router } from 'express';
import {
    createFoodController,
    deleteFoodController,
    getBrandedFoodController,
    getFoods,
    searchBrandedFoodsController,
    updateFoodController,
} from '../controllers/food.controller';

const router = Router();

router.get('/foods', getFoods);
router.post('/foods', createFoodController);
router.put('/foods/:id', updateFoodController);
router.delete('/foods/:id', deleteFoodController);

router.get('/macros/search-branded-foods', searchBrandedFoodsController);
router.get('/macros/branded-food/:foodId', getBrandedFoodController);

export default router;
