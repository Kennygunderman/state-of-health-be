import { Router } from 'express';
import { getExercises, deleteExercise, createTemplateController, getTemplatesController, deleteTemplateController } from '../controllers/exercise.controller';

const router = Router();

router.get('/exercises', getExercises);
router.delete('/exercises/:exerciseId', deleteExercise);

router.post('/template', createTemplateController);
router.get('/templates', getTemplatesController);
router.delete('/templates/:templateId', deleteTemplateController);

export default router;
