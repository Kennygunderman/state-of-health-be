import { Router } from 'express';
import { getExercises } from '../controllers/exercise.controller';

const router = Router();
router.get('/exercises', getExercises);
export default router;
