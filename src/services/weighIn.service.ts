import { prisma } from '../prisma/client';
import { CreateWeighInPayload, WeighInResponse } from '../types/weighIn';

const mapWeighIn = (entry: { id: string; weight: number; logged_at: Date }): WeighInResponse => ({
    id: entry.id,
    weight: entry.weight,
    loggedAt: entry.logged_at.toISOString(),
});

export const getWeighInsForUser = async (userId: string): Promise<WeighInResponse[]> => {
    const entries = await prisma.body_weight_entries.findMany({
        where: { user_id: userId },
        orderBy: { logged_at: 'desc' },
    });
    return entries.map(mapWeighIn);
};

export const createWeighIn = async (userId: string, payload: CreateWeighInPayload): Promise<WeighInResponse> => {
    const entry = await prisma.body_weight_entries.create({
        data: {
            user_id: userId,
            weight: payload.weight,
            logged_at: new Date(payload.loggedAt),
        },
    });
    return mapWeighIn(entry);
};

export const deleteWeighIn = async (userId: string, weighInId: string): Promise<boolean> => {
    const { count } = await prisma.body_weight_entries.deleteMany({
        where: { id: weighInId, user_id: userId },
    });
    return count > 0;
};
