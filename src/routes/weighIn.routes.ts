import { Router } from 'express';
import { createWeighInController, deleteWeighInController, getWeighIns } from '../controllers/weighIn.controller';

const router = Router();

router.get('/weigh-ins', getWeighIns);

router.post('/weigh-in', createWeighInController);

router.delete('/weigh-in/:id', deleteWeighInController);

export default router;
