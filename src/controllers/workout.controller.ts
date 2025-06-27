import { Request, Response } from 'express';
import { getWorkoutByDate, getAllWorkoutsForUser, getWorkoutSummary as getWorkoutSummaryService, createWorkout as createWorkoutService, getWeeklySummary, updateWorkout as updateWorkoutService } from '../services/workout.service';
import { getUserId } from '../utils/getUserId';

export const getWorkout = async (req: Request, res: Response) => {
    const { date } = req.params;
    const userId = getUserId(req);

    try {
        const workout = await getWorkoutByDate(userId, date);
        return res.json(workout);
    } catch (err) {
        return res.status(500).json({ message: 'Failed to fetch workout', error: err });
    }
};

export const getAllWorkouts = async (req: Request, res: Response) => {
    const userId = getUserId(req);
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
        const userId = getUserId(req);
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

export const createWorkout = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        await createWorkoutService(userId, req.body);
        // Fetch the newly created workout by date
        const workout = await getWorkoutByDate(userId, req.body.date);
        return res.status(201).json(workout);
    } catch (error) {
        console.error('Error creating workout:', error);
        res.status(500).json({ error: 'Failed to create workout' });
    }
};

export const getWeeklySummaryController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const numOfWeeks = parseInt(req.params.numOfWeeks, 10) || 7;
        const summary = await getWeeklySummary(userId, numOfWeeks);
        return res.json(summary);
    } catch (error) {
        console.error('Error getting weekly summary:', error);
        res.status(500).json({ error: 'Failed to get weekly summary' });
    }
};

export const updateWorkout = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const workoutId = req.params.id;
        // Call the service to update the workout
        const updated = await updateWorkoutService(userId, workoutId, req.body);
        if (!updated) {
            return res.status(404).json({ error: 'Workout not found' });
        }
        // Fetch the updated workout by date
        const workout = await getWorkoutByDate(userId, updated.date.toISOString());
        return res.json(workout);
    } catch (error) {
        console.error('Error updating workout:', error);
        res.status(500).json({ error: 'Failed to update workout' });
    }
};
