import { Router } from 'express';
import {
    createUserController,
    getAvatarController,
    getProfileController,
    updateAvatarController,
    updateProfileController,
} from '../controllers/user.controller';
import { authenticateFirebaseToken } from '../middleware/auth';

const router = Router();

// Unprotected: called at signup, before the client has a verified session.
router.post('/user', createUserController);

// This router mounts before the global auth middleware (see app.ts), so the
// avatar/profile routes carry their own auth.
router.get('/user/avatar', authenticateFirebaseToken, getAvatarController);
router.put('/user/avatar', authenticateFirebaseToken, updateAvatarController);

// Coach profile fields (sex/birthDate/heightCm/weightUnit/timezone). The app
// calls PUT on login to sync timezone + weight unit — see tdee-coach-plan.md §3.5.
router.get('/user/profile', authenticateFirebaseToken, getProfileController);
router.put('/user/profile', authenticateFirebaseToken, updateProfileController);

export default router;
