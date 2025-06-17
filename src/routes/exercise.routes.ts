import { Router } from 'express';
import { getExercises, deleteExercise } from '../controllers/exercise.controller';

const router = Router();

router.get('/exercises', getExercises);
router.delete('/exercise/:exerciseId', deleteExercise);

export default router;
