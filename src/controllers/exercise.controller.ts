import { Request, Response } from 'express';
import { getUserExercises, deleteUserExercise } from '../services/exercise.service';

export const getExercises = async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;

    try {
        const exercises = await getUserExercises(userId);
        return res.json(exercises);
    } catch (err) {
        return res.status(500).json({ message: 'Failed to fetch exercises', error: err });
    }
};

export const deleteExercise = async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const { exerciseId } = req.params;

    try {
        await deleteUserExercise(userId, exerciseId);
        return res.json({ message: 'Exercise deleted successfully' });
    } catch (err) {
        if (err instanceof Error && err.message === 'Exercise not found or does not belong to user') {
            return res.status(404).json({ message: err.message });
        }
        return res.status(500).json({ message: 'Failed to delete exercise', error: err });
    }
};
