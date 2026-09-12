import type { NextFunction, Request, Response } from 'express';

import { assertTestDatabase } from './testDb';

assertTestDatabase();

// Deleted rather than blanked: `usda.service.ts` and `openrouter.service.ts`
// read their key once behind an accessor that throws a typed "not configured"
// error when it is ABSENT, and an empty string is a configured-but-invalid key
// that would be sent to the vendor. Removing them makes offline the suite's
// default and is what `api/offline.test.ts` rests on.
delete process.env.USDA_API_KEY;
delete process.env.OPENROUTER_API_KEY;

process.env.MEAL_PLANNING_ENABLED = 'true';
process.env.MEAL_PLANNING_FAULT = 'off';

// Mandatory, not decorative: `app.ts` imports `migration.routes.ts`, whose
// live line-2 import of `migration.service.ts` imports `{ db }` from
// `utils/firebase`, which calls `admin.initializeApp()` and `admin.firestore()`
// at module scope. Without this factory, importing `app.ts` needs real
// credentials and falls back to the gitignored `serviceAccountKey.json`, so
// every suite that touches HTTP dies on MODULE_NOT_FOUND.
jest.mock('../../utils/firebase', () => {
    const firestore = {
        collection: () => ({ get: async () => ({ docs: [] }) }),
    };

    return {
        admin: {
            auth: () => ({
                verifyIdToken: async (idToken: string) => ({
                    uid: `test-uid-${idToken}`,
                    email: `${idToken}@example.test`,
                }),
            }),
            firestore: () => firestore,
            credential: { cert: () => ({}) },
            initializeApp: () => undefined,
        },
        db: firestore,
    };
});

// The identity arrives in a header because a header is the request's
// authentication channel: it stands in for the Firebase token the real
// middleware verifies, so a handler still learns the caller only through
// `getUserId(req)` and the ownership suites' "another user's id returns 404"
// keeps its meaning. A body or query field would make the identity
// client-supplied data and prove nothing.
jest.mock('../../middleware/auth', () => ({
    authenticateFirebaseToken: (req: Request, res: Response, next: NextFunction) => {
        const uid = req.header('x-test-user-id');

        if (uid === undefined || uid.length === 0) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const email = req.header('x-test-email');
        const claims: { uid: string; email?: string } =
            typeof email === 'string' && email.length > 0 ? { uid, email } : { uid };

        (req as Request & { user?: { uid: string; email?: string } }).user = claims;

        return next();
    },
}));
