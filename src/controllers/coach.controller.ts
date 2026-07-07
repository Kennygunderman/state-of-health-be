import { Request, Response } from 'express';
import {
    acknowledgeCheckIn,
    deleteCoach,
    enrollCoach,
    getCoachState,
    updateCoachSettings,
} from '../services/coach/coach.service';
import { getUserId } from '../utils/getUserId';

const VALID_GOALS = ['lose', 'maintain', 'gain'];
const VALID_SEX = ['male', 'female', 'unspecified'];
const VALID_FAT_BIAS = ['low', 'balanced', 'high'];
const DAY_KEY_REGEX = /^\d{4}-\d{2}-\d{2}$/;

/** Rate bounds by goal (%BW/week) — mirrors the wizard presets (plan §1.2). */
const RATE_BOUNDS: Record<string, { min: number; max: number }> = {
    lose: { min: 0.25, max: 1.0 },
    gain: { min: 0.1, max: 0.5 },
    maintain: { min: 0, max: 0 },
};

const validateGoalAndRate = (goal: unknown, ratePctBw: unknown): string | null => {
    if (!VALID_GOALS.includes(goal as string)) {
        return `goal must be one of ${VALID_GOALS.join(', ')}`;
    }
    const rate = Number(ratePctBw);
    const bounds = RATE_BOUNDS[goal as string];
    if (!Number.isFinite(rate) || rate < bounds.min || rate > bounds.max) {
        return `ratePctBw for goal '${goal}' must be between ${bounds.min} and ${bounds.max}`;
    }
    return null;
};

export const getCoachStateController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const state = await getCoachState(userId);
        if (!state) {
            return res.status(404).json({ error: 'User not found' });
        }
        return res.json(state);
    } catch (error) {
        console.error('Error getting coach state:', error);
        return res.status(500).json({ error: 'Failed to get coach state' });
    }
};

export const enrollCoachController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { goal, ratePctBw, sex, birthDate, heightCm } = req.body ?? {};

        const goalRateError = validateGoalAndRate(goal, ratePctBw);
        if (goalRateError) {
            return res.status(400).json({ error: goalRateError });
        }
        if (sex !== undefined && sex !== null && !VALID_SEX.includes(sex)) {
            return res.status(400).json({ error: `sex must be one of ${VALID_SEX.join(', ')} or null` });
        }
        if (birthDate !== undefined && birthDate !== null
            && (typeof birthDate !== 'string' || !DAY_KEY_REGEX.test(birthDate))) {
            return res.status(400).json({ error: 'birthDate must be YYYY-MM-DD or null' });
        }
        if (heightCm !== undefined && heightCm !== null) {
            const height = Number(heightCm);
            if (!Number.isFinite(height) || height < 90 || height > 250) {
                return res.status(400).json({ error: 'heightCm must be between 90 and 250, or null' });
            }
        }

        const state = await enrollCoach(userId, {
            goal,
            ratePctBw: Number(ratePctBw),
            ...(sex !== undefined && { sex }),
            ...(birthDate !== undefined && { birthDate }),
            ...(heightCm !== undefined && { heightCm: heightCm === null ? null : Number(heightCm) }),
        });
        if (!state) {
            return res.status(404).json({ error: 'User not found' });
        }
        return res.status(201).json(state);
    } catch (error) {
        console.error('Error enrolling in coach:', error);
        return res.status(500).json({ error: 'Failed to enroll in coach' });
    }
};

export const updateCoachSettingsController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { goal, ratePctBw, proteinPref, fatBias, mode } = req.body ?? {};

        if (goal !== undefined || ratePctBw !== undefined) {
            // Goal and rate move together: validating one requires the other.
            if (goal === undefined || ratePctBw === undefined) {
                return res.status(400).json({ error: 'goal and ratePctBw must be provided together' });
            }
            const goalRateError = validateGoalAndRate(goal, ratePctBw);
            if (goalRateError) {
                return res.status(400).json({ error: goalRateError });
            }
        }
        if (proteinPref !== undefined && proteinPref !== null) {
            const pref = Number(proteinPref);
            if (!Number.isFinite(pref) || pref < 1 || pref > 3) {
                return res.status(400).json({ error: 'proteinPref must be between 1 and 3 g/kg, or null' });
            }
        }
        if (fatBias !== undefined && fatBias !== null && !VALID_FAT_BIAS.includes(fatBias)) {
            return res.status(400).json({ error: `fatBias must be one of ${VALID_FAT_BIAS.join(', ')} or null` });
        }
        if (mode !== undefined && mode !== 'coached' && mode !== 'paused') {
            return res.status(400).json({ error: "mode must be 'coached' or 'paused'" });
        }

        const state = await updateCoachSettings(userId, {
            ...(goal !== undefined && { goal }),
            ...(ratePctBw !== undefined && { ratePctBw: Number(ratePctBw) }),
            ...(proteinPref !== undefined && { proteinPref: proteinPref === null ? null : Number(proteinPref) }),
            ...(fatBias !== undefined && { fatBias }),
            ...(mode !== undefined && { mode }),
        });
        if (!state) {
            return res.status(404).json({ error: 'Not enrolled in coach' });
        }
        return res.json(state);
    } catch (error) {
        console.error('Error updating coach settings:', error);
        return res.status(500).json({ error: 'Failed to update coach settings' });
    }
};

export const deleteCoachController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const deleted = await deleteCoach(userId);
        if (!deleted) {
            return res.status(404).json({ error: 'Not enrolled in coach' });
        }
        return res.json({ success: true });
    } catch (error) {
        console.error('Error deleting coach profile:', error);
        return res.status(500).json({ error: 'Failed to delete coach profile' });
    }
};

export const acknowledgeCheckInController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const acknowledged = await acknowledgeCheckIn(userId, req.params.planId);
        if (!acknowledged) {
            return res.status(404).json({ error: 'Plan not found or already acknowledged' });
        }
        return res.json({ success: true });
    } catch (error) {
        console.error('Error acknowledging check-in:', error);
        return res.status(500).json({ error: 'Failed to acknowledge check-in' });
    }
};
