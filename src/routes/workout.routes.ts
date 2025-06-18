import { Router } from 'express';
import { getWorkout, getAllWorkouts, getWorkoutSummary, createWorkout, getWeeklySummaryController } from '../controllers/workout.controller';

const router = Router();

router.get('/workouts/weekly-summary/:numOfWeeks', getWeeklySummaryController);
router.get('/workouts/summary', getWorkoutSummary);
router.get('/workouts/:date', getWorkout);
router.get('/workouts', getAllWorkouts);
router.post('/workouts', createWorkout);

export default router;
