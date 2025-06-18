import { Router } from 'express';
import { getWorkout, getAllWorkouts, getWorkoutSummary, createWorkout } from '../controllers/workout.controller';

const router = Router();

router.get('/workouts/summary', getWorkoutSummary);
router.get('/workouts/:date', getWorkout);
router.get('/workouts', getAllWorkouts);
router.post('/workout', createWorkout);

export default router;
