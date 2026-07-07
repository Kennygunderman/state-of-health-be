import { Request, Response } from 'express';
import { createWeighIn, deleteWeighIn, getWeighInsForUser } from '../services/weighIn.service';
import { getUserId } from '../utils/getUserId';

export const getWeighIns = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const weighIns = await getWeighInsForUser(userId);
        return res.json({ weighIns });
    } catch (error) {
        console.error('Error getting weigh-ins:', error);
        res.status(500).json({ error: 'Failed to get weigh-ins' });
    }
};

export const createWeighInController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { weight, loggedAt, unit } = req.body;

        const parsedWeight = Number(weight);
        const parsedLoggedAt = new Date(loggedAt);
        if (!Number.isFinite(parsedWeight) || parsedWeight <= 0 || isNaN(parsedLoggedAt.getTime())) {
            return res.status(400).json({ error: 'weight must be a positive number and loggedAt a valid date' });
        }
        if (unit !== undefined && unit !== 'lbs' && unit !== 'kg' && unit !== 'st') {
            return res.status(400).json({ error: "unit must be 'lbs', 'kg', or 'st'" });
        }

        const weighIn = await createWeighIn(userId, { weight: parsedWeight, loggedAt, unit });
        return res.status(201).json(weighIn);
    } catch (error) {
        console.error('Error creating weigh-in:', error);
        res.status(500).json({ error: 'Failed to create weigh-in' });
    }
};

export const deleteWeighInController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const deleted = await deleteWeighIn(userId, req.params.id);
        if (!deleted) {
            return res.status(404).json({ error: 'Weigh-in not found' });
        }
        return res.json({ success: true });
    } catch (error) {
        console.error('Error deleting weigh-in:', error);
        res.status(500).json({ error: 'Failed to delete weigh-in' });
    }
};
