import { Request, Response } from 'express';
import { createUser, getAvatar, updateAvatar } from '../services/user.service';
import { CreateUserRequest, UpdateAvatarRequest } from '../types/user';
import { getUserId } from '../utils/getUserId';
import { describeErrorSafely, logSafeEvent } from '../utils/safeLogger';

/**
 * The route descriptors the safe server events below carry, spelled as the
 * other legacy families spell theirs so one grep covers the whole stream. The
 * dots live in this field and never in an event NAME — `safeLogger`'s
 * `EVENT_NAME_PATTERN` admits no `.` and rewrites a dotted name to
 * `unnamed_event`.
 */
const ACTIONS = {
    create: 'user.create',
    updateAvatar: 'user.updateAvatar',
    getAvatar: 'user.getAvatar',
} as const;

/**
 * Records one server fault on a user route, with a SAFE description of the
 * throw — its class name and, when the runtime supplies one, its machine code.
 *
 * This replaced `console.error('…', error)` on all three sites in this file,
 * and on `POST /api/user` it matters more than on any other legacy route
 * because that route sits BEFORE the auth boundary in `app.ts`: the leak was
 * reachable with no credential at all. A duplicate email — one request, no
 * token — printed a stack carrying three absolute filesystem paths rooted at
 * the deployment directory. `describeErrorSafely` cannot express a stack,
 * message, cause or `meta`, which is what Rule backend-architecture §8 asks for
 * and what AAP §0.3.2/§0.7.1 require.
 */
const logRouteFailure = (action: string, status: number, error: unknown): void => {
    logSafeEvent('error', 'request_failed', {
        action,
        status,
        ...describeErrorSafely(error),
    });
};

// ~400KB of base64 ≈ 300KB decoded — far above the ~20KB the app sends after
// resizing to 192px, but low enough to keep junk out of the users table.
const MAX_AVATAR_BASE64_LENGTH = 400_000;
const BASE64_REGEX = /^[A-Za-z0-9+/]+={0,2}$/;

export const createUserController = async (req: Request, res: Response) => {
    try {
        const { userId, email, firstName, lastName }: CreateUserRequest = req.body;

        // Validate required fields
        if (!userId) {
            return res.status(400).json({ error: 'User ID is required' });
        }

        if (!email) {
            return res.status(400).json({ error: 'Email is required' });
        }

        // Basic email validation
        const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        if (!emailRegex.test(email)) {
            return res.status(400).json({ error: 'Invalid email format' });
        }

        const user = await createUser({
            userId,
            email,
            firstName,
            lastName
        });

        return res.status(201).json(user);
    } catch (error) {
        // The two conflicts below are REFUSALS the caller earned, not faults
        // this server suffered, so they are recorded as such and the 500 keeps
        // the fault level. The shipped code logged the raw error before it drew
        // that distinction, so an ordinary duplicate signup emitted a stack at
        // error level. The `conflict` field carries which of the two it was —
        // a fixed string chosen here, never the throw's own message.
        if (error instanceof Error) {
            if (error.message === 'User already exists') {
                logSafeEvent('warn', 'request_rejected', {
                    action: ACTIONS.create,
                    status: 409,
                    conflict: 'user_exists',
                });
                return res.status(409).json({ error: error.message });
            }
            if (error.message === 'Email already exists') {
                logSafeEvent('warn', 'request_rejected', {
                    action: ACTIONS.create,
                    status: 409,
                    conflict: 'email_exists',
                });
                return res.status(409).json({ error: error.message });
            }
        }

        logRouteFailure(ACTIONS.create, 500, error);
        return res.status(500).json({ error: 'Failed to create user' });
    }
};

export const updateAvatarController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { avatarBase64 }: UpdateAvatarRequest = req.body;

        if (avatarBase64 !== null) {
            if (typeof avatarBase64 !== 'string' || avatarBase64.length === 0) {
                return res.status(400).json({ error: 'avatarBase64 must be a non-empty string or null' });
            }
            if (avatarBase64.length > MAX_AVATAR_BASE64_LENGTH) {
                return res.status(400).json({ error: 'avatarBase64 exceeds the maximum allowed size' });
            }
            if (!BASE64_REGEX.test(avatarBase64)) {
                return res.status(400).json({ error: 'avatarBase64 must be plain base64 (no data URI prefix)' });
            }
        }

        const avatar = await updateAvatar(userId, avatarBase64);
        return res.json(avatar);
    } catch (error) {
        logRouteFailure(ACTIONS.updateAvatar, 500, error);
        return res.status(500).json({ error: 'Failed to update avatar' });
    }
};

export const getAvatarController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const avatar = await getAvatar(userId);
        return res.json(avatar);
    } catch (error) {
        logRouteFailure(ACTIONS.getAvatar, 500, error);
        return res.status(500).json({ error: 'Failed to get avatar' });
    }
}; 