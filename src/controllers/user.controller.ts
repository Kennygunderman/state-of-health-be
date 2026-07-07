import { Request, Response } from 'express';
import { createUser, getAvatar, getProfile, updateAvatar, updateProfile } from '../services/user.service';
import { CreateUserRequest, UpdateAvatarRequest } from '../types/user';
import { UpdateProfileRequest } from '../types/coach';
import { getUserId } from '../utils/getUserId';

const VALID_SEX = ['male', 'female', 'unspecified'];
const VALID_WEIGHT_UNITS = ['lbs', 'kg', 'st'];
const DAY_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;
// IANA identifiers like 'America/Chicago'; also accepts 'UTC'.
const TIMEZONE_REGEX = /^[A-Za-z_]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;

/**
 * Validates the partial profile payload. Returns an error message, or null if
 * valid. Fields are optional; explicit nulls clear sex/birthDate/heightCm.
 */
const validateProfilePayload = (body: Record<string, unknown>): string | null => {
    if (body.sex !== undefined && body.sex !== null && !VALID_SEX.includes(body.sex as string)) {
        return `sex must be one of ${VALID_SEX.join(', ')} or null`;
    }
    if (body.birthDate !== undefined && body.birthDate !== null) {
        if (typeof body.birthDate !== 'string' || !DAY_KEY_REGEX.test(body.birthDate)
            || isNaN(new Date(`${body.birthDate}T00:00:00Z`).getTime())) {
            return 'birthDate must be YYYY-MM-DD or null';
        }
    }
    if (body.heightCm !== undefined && body.heightCm !== null) {
        const height = Number(body.heightCm);
        if (!Number.isFinite(height) || height < 90 || height > 250) {
            return 'heightCm must be a number between 90 and 250, or null';
        }
    }
    if (body.weightUnit !== undefined && !VALID_WEIGHT_UNITS.includes(body.weightUnit as string)) {
        return `weightUnit must be one of ${VALID_WEIGHT_UNITS.join(', ')}`;
    }
    if (body.timezone !== undefined
        && (typeof body.timezone !== 'string' || !TIMEZONE_REGEX.test(body.timezone))) {
        return 'timezone must be an IANA timezone identifier';
    }
    return null;
};

export const getProfileController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const profile = await getProfile(userId);
        if (!profile) {
            return res.status(404).json({ error: 'User not found' });
        }
        return res.json(profile);
    } catch (error) {
        console.error('Error getting profile:', error);
        return res.status(500).json({ error: 'Failed to get profile' });
    }
};

export const updateProfileController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const validationError = validateProfilePayload(req.body ?? {});
        if (validationError) {
            return res.status(400).json({ error: validationError });
        }
        const { sex, birthDate, heightCm, weightUnit, timezone }: UpdateProfileRequest = req.body;
        const profile = await updateProfile(userId, {
            ...(sex !== undefined && { sex }),
            ...(birthDate !== undefined && { birthDate }),
            ...(heightCm !== undefined && { heightCm: heightCm === null ? null : Number(heightCm) }),
            ...(weightUnit !== undefined && { weightUnit }),
            ...(timezone !== undefined && { timezone }),
        });
        if (!profile) {
            return res.status(404).json({ error: 'User not found' });
        }
        return res.json(profile);
    } catch (error) {
        console.error('Error updating profile:', error);
        return res.status(500).json({ error: 'Failed to update profile' });
    }
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
        console.error('Error creating user:', error);
        
        if (error instanceof Error) {
            if (error.message === 'User already exists') {
                return res.status(409).json({ error: error.message });
            }
            if (error.message === 'Email already exists') {
                return res.status(409).json({ error: error.message });
            }
        }
        
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
        console.error('Error updating avatar:', error);
        return res.status(500).json({ error: 'Failed to update avatar' });
    }
};

export const getAvatarController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const avatar = await getAvatar(userId);
        return res.json(avatar);
    } catch (error) {
        console.error('Error getting avatar:', error);
        return res.status(500).json({ error: 'Failed to get avatar' });
    }
}; 