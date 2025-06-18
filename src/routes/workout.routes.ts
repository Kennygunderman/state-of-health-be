import { Router } from 'express';
import { getWorkout, getAllWorkouts, getWorkoutSummary } from '../controllers/workout.controller';

const router = Router();

router.get('/workouts/summary', getWorkoutSummary);
router.get('/workouts/:date', getWorkout);
router.get('/workouts', getAllWorkouts);

export default router;
