import { Router } from 'express';
import { getWorkout, getAllWorkouts, getWorkoutSummary, createWorkout, getWeeklySummaryController, updateWorkout } from '../controllers/workout.controller';

const router = Router();

router.get('/workouts/weekly-summary/:numOfWeeks', getWeeklySummaryController);
router.get('/workouts/summary', getWorkoutSummary);
router.get('/workout/:date', getWorkout);
router.get('/workouts', getAllWorkouts);

router.put('/workout/:id', updateWorkout);

router.post('/workout', createWorkout);

export default router;
