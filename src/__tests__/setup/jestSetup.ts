import type { NextFunction, Request, Response } from 'express';

import { assertSchemaFreshnessOnce, assertTestDatabase } from './testDb';

assertTestDatabase();

// Deleted rather than blanked: `usda.service.ts` and `openrouter.service.ts`
// read their key once behind an accessor that throws a typed "not configured"
// error when it is ABSENT, and an empty string is a configured-but-invalid key
// that would be sent to the vendor. Removing them makes offline the suite's
// default and is what `api/offline.test.ts` rests on.
//
// THIS IS THE WHOLE OF THE VENDOR PROTECTION IN *THIS* PROCESS, and it is
// enough here: with no key, no request is ever built. `globalThis.fetch` is
// deliberately left alone, because several suites replace it themselves to
// observe the rate limiter wrapping it, and a deny installed here would be
// either overwritten by them or in their way.
//
// It does not extend to a CHILD process, and two script suites launch real CLI
// entry points as children that must carry keys to get past their own
// `preflight`. Those children install `./vendorNetworkDeny` through `--require`
// instead, which refuses every request channel and records that it did. The
// split is deliberate: absent keys where nothing needs them, an enforced
// refusal where something does.
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

// The second gate, and the only asynchronous work this file can do. Jest awaits
// a setup file's module export when that export IS a function — `jest-runner`
// does `const setupFile = runtime.requireModule(path); if (typeof setupFile ===
// 'function') { await setupFile(); }` — which runs it after everything above and
// before the file's first test.
//
// `export =`, not `export default`: TypeScript's CommonJS emit puts a default
// export on `exports.default`, which that check never sees, so the gate would
// silently never run. Nothing else in this file is exported, so the assignment
// is the whole module's shape, and `testDb.test.ts` pins both facts.
//
// It answers "is this database the schema the code expects" — see the schema
// section of `./testDb`. A database that cannot be read, or has no applied
// migration, is a skip rather than a failure: 25 of the 30 test files never open
// a connection, and this file runs before every one of them.
export = async (): Promise<void> => {
    await assertSchemaFreshnessOnce();
};
