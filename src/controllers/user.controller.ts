import { Request, Response } from 'express';
import { createUser, getAvatar, updateAvatar } from '../services/user.service';
import { CreateUserRequest, UpdateAvatarRequest } from '../types/user';
import { getUserId } from '../utils/getUserId';

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