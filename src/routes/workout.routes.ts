import { Router } from 'express';
import { getWorkout, getAllWorkouts } from '../controllers/workout.controller';

const router = Router();
router.get('/workouts/:date', getWorkout);
router.get('/workouts', getAllWorkouts);
export default router;
