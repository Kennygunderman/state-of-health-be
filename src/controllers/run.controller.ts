import { Request, Response } from 'express';
import { getRunById, getAllRunsForUser, getWeeklyRunSummary, createRun, updateRun } from '../services/run.service';
import { getUserId } from '../utils/getUserId';

export const getRun = async (req: Request, res: Response) => {
    const { id } = req.params;
    const userId = getUserId(req);

    try {
        const run = await getRunById(userId, id);
        if (!run) {
            return res.status(404).json({ error: 'Run not found' });
        }
        return res.json(run);
    } catch (err) {
        return res.status(500).json({ message: 'Failed to fetch run', error: err });
    }
};

export const getAllRuns = async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 10;

    try {
        const { runs, total } = await getAllRunsForUser(userId, page, limit);
        return res.json({
            runs,
            pagination: { page, limit, total, totalPages: Math.ceil(total / limit) }
        });
    } catch (err) {
        return res.status(500).json({ message: 'Failed to fetch runs', error: err });
    }
};

export const getWeeklyRunSummaryController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const numOfWeeks = parseInt(req.params.numOfWeeks, 10) || 7;
        const summary = await getWeeklyRunSummary(userId, numOfWeeks);
        return res.json(summary);
    } catch (error) {
        console.error('Error getting weekly run summary:', error);
        res.status(500).json({ error: 'Failed to get weekly run summary' });
    }
};

export const createRunController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { run, newRecords } = await createRun(userId, req.body);
        return res.status(201).json({ ...run, newRecords });
    } catch (error) {
        console.error('Error creating run:', error);
        res.status(500).json({ error: 'Failed to create run' });
    }
};

export const updateRunController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const runId = req.params.id;
        const updated = await updateRun(userId, runId, req.body);
        if (!updated) {
            return res.status(404).json({ error: 'Run not found' });
        }
        return res.json({ ...updated.run, newRecords: updated.newRecords });
    } catch (error) {
        console.error('Error updating run:', error);
        res.status(500).json({ error: 'Failed to update run' });
    }
};
