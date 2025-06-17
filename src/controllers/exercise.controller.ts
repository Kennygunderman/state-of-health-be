import { Request, Response } from 'express';
import { getUserExercises } from '../services/exercise.service';

export const getExercises = async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;

    try {
        const exercises = await getUserExercises(userId);
        return res.json(exercises);
    } catch (err) {
        return res.status(500).json({ message: 'Failed to fetch exercises', error: err });
    }
}; 