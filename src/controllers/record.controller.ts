import { Request, Response } from 'express';
import { getPersonalRecordsForUser } from '../services/record.service';
import { getUserId } from '../utils/getUserId';

export const getRecords = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { exerciseRecords, runRecords } = await getPersonalRecordsForUser(userId);
        return res.json({ exerciseRecords, runRecords });
    } catch (error) {
        console.error('Error getting records:', error);
        res.status(500).json({ error: 'Failed to get records' });
    }
};
