import { Router } from 'express';
import { getWorkout } from '../controllers/workout.controller';

const router = Router();
router.get('/workouts/:date', getWorkout);
export default router;
