import { Router } from 'express';
import { createUserController, getAvatarController, updateAvatarController } from '../controllers/user.controller';
import { authenticateFirebaseToken } from '../middleware/auth';

const router = Router();

// Unprotected: called at signup, before the client has a verified session.
router.post('/user', createUserController);

// This router mounts before the global auth middleware (see app.ts), so the
// avatar routes carry their own auth.
router.get('/user/avatar', authenticateFirebaseToken, getAvatarController);
router.put('/user/avatar', authenticateFirebaseToken, updateAvatarController);

export default router;
