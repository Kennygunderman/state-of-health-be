import { Router } from 'express';
import {
    acknowledgeCheckInController,
    deleteCoachController,
    enrollCoachController,
    getCoachStateController,
    updateCoachSettingsController,
} from '../controllers/coach.controller';

const router = Router();

// Expenditure state (works for every user, enrolled or not); for coached
// users this read also lazily generates the current week's plan.
router.get('/coach/state', getCoachStateController);

// Coached mode lifecycle — see tdee-coach-plan.md §3.2.
router.post('/coach/enroll', enrollCoachController);
router.put('/coach/settings', updateCoachSettingsController);
router.delete('/coach', deleteCoachController);
router.post('/coach/checkin/:planId/ack', acknowledgeCheckInController);

export default router;
