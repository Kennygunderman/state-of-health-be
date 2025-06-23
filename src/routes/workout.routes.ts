import { Router } from 'express';
import { getWorkout, getAllWorkouts, getWorkoutSummary, createWorkout, getWeeklySummaryController } from '../controllers/workout.controller';

const router = Router();

router.get('/workouts/weekly-summary/:numOfWeeks', getWeeklySummaryController);
router.get('/workouts/summary', getWorkoutSummary);
router.get('/workout/:date', getWorkout);
router.get('/workouts', getAllWorkouts);
router.post('/workout', createWorkout);

export default router;
