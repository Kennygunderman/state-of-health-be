import { Router } from 'express';
import { getExercises, deleteExercise, createTemplateController, getTemplatesController, deleteTemplateController, createExerciseController } from '../controllers/exercise.controller';

const router = Router();

router.get('/exercises', getExercises);
router.post('/exercise', createExerciseController);
router.delete('/exercise/:exerciseId', deleteExercise);

router.get('/templates', getTemplatesController);
router.post('/template', createTemplateController);
router.delete('/template/:templateId', deleteTemplateController);

export default router;
