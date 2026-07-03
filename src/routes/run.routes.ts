import { Router } from 'express';
import { getRun, getAllRuns, getWeeklyRunSummaryController, createRunController, updateRunController } from '../controllers/run.controller';

const router = Router();

router.get('/runs/weekly-summary/:numOfWeeks', getWeeklyRunSummaryController);
router.get('/runs', getAllRuns);
router.get('/run/:id', getRun);

router.put('/run/:id', updateRunController);

router.post('/run', createRunController);

export default router;
