import { Request, Response } from 'express';
import { getWorkoutByDate } from '../services/workout.service';

export const getWorkout = async (req: Request, res: Response) => {
    const { date } = req.params;
    const userId = req.headers['x-user-id'] as string; // or however you're passing user auth

    try {
        const workout = await getWorkoutByDate(userId, date);
        return res.json(workout);
    } catch (err) {
        return res.status(500).json({ message: 'Failed to fetch workout', error: err });
    }
};
