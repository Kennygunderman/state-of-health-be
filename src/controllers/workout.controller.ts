import { Request, Response } from 'express';
import { getWorkoutByDate, getAllWorkoutsForUser } from '../services/workout.service';

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

export const getAllWorkouts = async (req: Request, res: Response) => {
    const userId = req.headers['x-user-id'] as string;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;

    try {
        const { workouts, total } = await getAllWorkoutsForUser(userId, page, limit);
        return res.json({
            workouts,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (err) {
        return res.status(500).json({ message: 'Failed to fetch workouts', error: err });
    }
};
