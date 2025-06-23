import { Request, Response } from 'express';
import { createUser } from '../services/user.service';
import { CreateUserRequest } from '../types/user';

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