import { Request, Response } from 'express';
import { getUserExercises, deleteUserExercise, createTemplate, getTemplates, deleteTemplate, createExercise } from '../services/exercise.service';
import { getUserId } from '../utils/getUserId';

export const getExercises = async (req: Request, res: Response) => {
    const userId = getUserId(req);

    try {
        const exercises = await getUserExercises(userId);
        return res.json(exercises);
    } catch (err) {
        return res.status(500).json({ message: 'Failed to fetch exercises', error: err });
    }
};

export const deleteExercise = async (req: Request, res: Response) => {
    const userId = getUserId(req);
    const { exerciseId } = req.params;

    try {
        await deleteUserExercise(userId, exerciseId);
        return res.status(204).send();
    } catch (err) {
        if (err instanceof Error && err.message === 'Exercise not found or does not belong to user') {
            return res.status(404).json({ message: err.message });
        }
        return res.status(500).json({ message: 'Failed to delete exercise', error: err });
    }
};

export const createTemplateController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const template = await createTemplate(userId, req.body);
        return res.status(201).json(template);
    } catch (error) {
        console.error('Error creating template:', error);
        res.status(500).json({ error: 'Failed to create template' });
    }
};

export const getTemplatesController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const templates = await getTemplates(userId);
        return res.json({ templates });
    } catch (error) {
        console.error('Error getting templates:', error);
        res.status(500).json({ error: 'Failed to get templates' });
    }
};

export const deleteTemplateController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const { templateId } = req.params;
        await deleteTemplate(userId, templateId);
        return res.status(204).send();
    } catch (error) {
        if (error instanceof Error && error.message === 'Template not found or does not belong to user') {
            return res.status(404).json({ message: error.message });
        }
        console.error('Error deleting template:', error);
        res.status(500).json({ error: 'Failed to delete template' });
    }
};

export const createExerciseController = async (req: Request, res: Response) => {
    try {
        const userId = getUserId(req);
        const exercise = await createExercise(userId, req.body);
        return res.status(201).json(exercise);
    } catch (error) {
        console.error('Error creating exercise:', error);
        res.status(500).json({ error: 'Failed to create exercise' });
    }
};
