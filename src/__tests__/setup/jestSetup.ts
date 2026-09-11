/**
 * The Jest `setupFiles` entry (Agent Action Plan §0.7.1 Group 1).
 *
 * `setupFiles`, deliberately, not `setupFilesAfterEnv`: this file runs before
 * the test framework is installed and before any test file — and therefore
 * before any application module — is imported. That placement is what makes
 * the first statement below load-bearing.
 *
 * Order in this file is the contract:
 *
 *   1. `assertTestDatabase()` — the guard, before ANY environment write and
 *      before any `jest.mock` registration, so an unsafe `DATABASE_URL` ends
 *      the run before `@prisma/client`, `src/prisma/client.ts` or `app.ts` can
 *      be loaded and before a single socket is opened. `testDb.test.ts` proves
 *      that from outside this process.
 *   2. The environment the suite runs under: the two live vendor keys are
 *      REMOVED so no test can reach USDA or OpenRouter even by accident, and
 *      the two meal-planning switches are pinned.
 *   3. The two module mocks every API suite depends on.
 *
 * Only `./testDb` is imported at module scope, and that module imports nothing
 * that can reach a database (see its header). The single side effect of the
 * `scripts/lib/dbGuard` import behind it is a no-op under Jest, whose
 * `process.argv[1]` is the Jest binary rather than one of the nine catalog
 * scripts.
 */

import type { NextFunction, Request, Response } from 'express';

import { assertTestDatabase } from './testDb';

assertTestDatabase();

// The suite must be incapable of spending money or hitting a rate limit, so
// the keys are deleted rather than blanked: `usda.service.ts` and
// `openrouter.service.ts` both throw a typed "not configured" error when their
// key is absent, which is the failure a suite should see if it reaches a vendor
// path it forgot to stub.
delete process.env.USDA_API_KEY;
delete process.env.OPENROUTER_API_KEY;

// Planning is ON for the suite — the disabled-path suites set the flag
// themselves — and fault injection is OFF, so a value left in a developer's
// shell cannot change what the suite means. `src/utils/featureFlags.ts` reads
// both once at import, which is why they are written here, before any
// application module exists to read them.
process.env.MEAL_PLANNING_ENABLED = 'true';
process.env.MEAL_PLANNING_FAULT = 'off';

/**
 * `src/utils/firebase.ts` calls `admin.initializeApp()` and
 * `admin.firestore()` at import time, so without this mock no suite can import
 * `app.ts` at all — it would need real service-account credentials and would
 * reach out to Firebase.
 *
 * The factory is self-contained (no out-of-scope references) because Jest
 * hoists `jest.mock` calls above the module body.
 */
jest.mock('../../utils/firebase', () => {
    // Resolves a decoded-token shape derived from the id token, so a suite that
    // exercises the real middleware (by unmocking `../../middleware/auth`) gets
    // a deterministic uid instead of a rejected promise. A suite that needs a
    // rejection calls `verifyIdToken.mockRejectedValueOnce(...)`.
    const verifyIdToken = jest.fn(async (idToken: string) => ({
        uid: `test-uid-${idToken}`,
        email: `${idToken}@example.test`,
    }));

    // Firestore is read only by `migration.service.ts`, and only inside its
    // handlers. `collection` is left implementation-free on purpose: a suite
    // that drives the migration route must state the documents it expects
    // rather than inherit a shared fake.
    const firestore = {
        collection: jest.fn(),
    };

    return {
        admin: {
            auth: () => ({ verifyIdToken }),
            firestore: () => firestore,
        },
        db: firestore,
    };
});

/**
 * The auth boundary, replaced by a header-driven stub so a suite can act as a
 * given user without minting a Firebase ID token (none is available to CI, and
 * the project's Firebase directory holds real users — §0.4.4).
 *
 * The 401 body is the SHIPPED one (`{ error: 'No token provided' }`), because
 * the ownership and auth suites assert on the response a client actually
 * receives; a mock that invented its own body would let a change to the real
 * middleware pass unnoticed.
 *
 * The header names are duplicated as literals here because this factory is
 * hoisted above every import and must not reference an out-of-scope binding;
 * `testApp.ts` exports them as the canonical constants, and
 * `testDb.test.ts` pins the two spellings against each other by driving a
 * protected route with the exported constant and asserting the request is
 * authenticated.
 */
jest.mock('../../middleware/auth', () => ({
    authenticateFirebaseToken: (req: Request, res: Response, next: NextFunction) => {
        const uid = req.header('x-test-user-id');

        if (uid === undefined || uid.length === 0) {
            return res.status(401).json({ error: 'No token provided' });
        }

        const email = req.header('x-test-email');
        // Same shape the real middleware attaches (the decoded Firebase token),
        // so `getUserId`/`getUserEmail` behave identically under test.
        (req as Request & { user?: { uid: string; email?: string } }).user = { uid, email };

        return next();
    },
}));
