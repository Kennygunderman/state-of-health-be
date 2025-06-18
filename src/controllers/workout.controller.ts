import { Request, Response } from 'express';
import { getWorkoutByDate, getAllWorkoutsForUser, getWorkoutSummary as getWorkoutSummaryService } from '../services/workout.service';

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

export const getWorkoutSummary = async (req: Request, res: Response) => {
    try {
        const userId = req.headers['x-user-id'] as string;
        if (!userId) {
            return res.status(401).json({ error: 'User ID is required' });
        }

        const page = parseInt(req.query.page as string) || 1;
        const limit = parseInt(req.query.limit as string) || 10;

        const { summaries, total } = await getWorkoutSummaryService(userId, page, limit);
        return res.json({
            summaries,
            pagination: {
                page,
                limit,
                total,
                totalPages: Math.ceil(total / limit)
            }
        });
    } catch (error) {
        console.error('Error getting workout summary:', error);
        res.status(500).json({ error: 'Failed to get workout summary' });
    }
};
