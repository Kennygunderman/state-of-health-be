import { prisma } from '../prisma/client';

// Access control for the AI endpoints (estimate + label-scan): kill switch,
// then a free daily quota shared by both endpoints. Consumption is counted
// BEFORE the LLM call — a failed call still spends tokens, so failures must
// not be free retries for an abuser.

const DEFAULT_DAILY_QUOTA = 5;

export class FeatureDisabledError extends Error {
    constructor() {
        super('AI features are disabled');
        this.name = 'FeatureDisabledError';
    }
}

export class DailyQuotaError extends Error {
    constructor(
        public readonly used: number,
        public readonly limit: number,
        public readonly resetsAt: string,
    ) {
        super('Daily AI quota reached');
        this.name = 'DailyQuotaError';
    }
}

const getDailyQuota = (): number => {
    const parsed = Number(process.env.AI_DAILY_QUOTA);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_DAILY_QUOTA;
};

const currentDay = (): string => new Date().toISOString().slice(0, 10);

// First millisecond of the next UTC day — when the quota row rolls over.
const quotaResetsAt = (): string => {
    const now = new Date();
    return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)).toISOString();
};

// Friends-and-family bypass of the daily cap. Matched against the Firebase
// token's email claim (never a client-supplied value). Comma-separated,
// case-insensitive.
export const isUnlimited = (email?: string): boolean => {
    if (!email) return false;
    const whitelist = (process.env.AI_UNLIMITED_EMAILS || '')
        .split(',')
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean);
    return whitelist.includes(email.toLowerCase());
};

export interface AiUsage {
    used: number;
    limit: number;
    resetsAt: string;
    unlimited: boolean;
}

export const getAiUsage = async (userId: string, email?: string): Promise<AiUsage> => {
    const row = await prisma.ai_usage.findUnique({
        where: { user_id_day: { user_id: userId, day: currentDay() } },
    });
    return { used: row?.count ?? 0, limit: getDailyQuota(), resetsAt: quotaResetsAt(), unlimited: isUnlimited(email) };
};

// Gate + consume one AI call. AI_FEATURES_ENABLED=false is the kill switch
// (authoritative even against scripted callers with a valid token).
export const assertAndConsumeAiCall = async (userId: string, email?: string): Promise<void> => {
    if (process.env.AI_FEATURES_ENABLED === 'false') {
        throw new FeatureDisabledError();
    }
    if (isUnlimited(email)) return;

    const day = currentDay();
    const limit = getDailyQuota();
    const usage = await prisma.ai_usage.findUnique({
        where: { user_id_day: { user_id: userId, day } },
    });
    if ((usage?.count ?? 0) >= limit) {
        throw new DailyQuotaError(usage?.count ?? 0, limit, quotaResetsAt());
    }

    await prisma.ai_usage.upsert({
        where: { user_id_day: { user_id: userId, day } },
        create: { user_id: userId, day, count: 1 },
        update: { count: { increment: 1 } },
    });
};
