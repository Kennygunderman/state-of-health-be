import { Request, Response, NextFunction } from 'express';
import { prisma } from '../prisma/client';
import { getUserId } from '../utils/getUserId';

const ONE_HOUR_MS = 60 * 60 * 1000;

// In-process throttle so we write users.last_active_at at most once per hour
// per user instead of once per request. Resets on process restart, which is
// fine — worst case is one extra write. Feeds the inactivity win-back pushes
// (tdee-coach-plan.md §5.3); precision beyond "roughly when" doesn't matter.
const lastWriteByUser = new Map<string, number>();

export function trackLastActive(req: Request, _res: Response, next: NextFunction) {
    try {
        const userId = getUserId(req);
        const now = Date.now();
        const lastWrite = lastWriteByUser.get(userId);
        if (!lastWrite || now - lastWrite >= ONE_HOUR_MS) {
            lastWriteByUser.set(userId, now);
            // Fire-and-forget: activity tracking must never block or fail a request.
            prisma.users
                .update({ where: { id: userId }, data: { last_active_at: new Date() } })
                .catch(() => {
                    // User row may not exist yet (signup race) — retry next hour.
                    lastWriteByUser.delete(userId);
                });
        }
    } catch {
        // No user on the request (shouldn't happen behind auth) — skip silently.
    }
    next();
}
