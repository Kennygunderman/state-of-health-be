/**
 * The HTTP entry point every API suite drives (Agent Action Plan §0.7.1
 * Group 1): one supertest handle on the real Express app, plus the two header
 * names the auth mock in `jestSetup.ts` reads.
 *
 * No logic lives here by design — it is a seam, not a helper library. The app
 * is the shipped `src/app.ts` with its real route table and mount order; only
 * the Firebase boundary and the auth middleware are replaced, and both are
 * replaced in `jestSetup.ts` so they are already in place before this module's
 * import of `app` runs.
 *
 * Importing this module loads `app.ts`, and therefore the Prisma client. That
 * is safe only because `jestSetup.ts` is a `setupFiles` entry whose first
 * statement is the database guard — a suite must never import this module from
 * a context where that guard has not run.
 */

import supertest from 'supertest';

import app from '../../app';

/** Identifies the caller to the auth mock. Its absence is a 401. */
export const TEST_USER_ID_HEADER = 'x-test-user-id';

/** Optional email claim, mirroring the Firebase token's `email`. */
export const TEST_EMAIL_HEADER = 'x-test-email';

/** The supertest handle: `await request.get('/health')`. */
export const request = supertest(app);

/** Who a request is made as. `email` is optional exactly as the claim is. */
export interface TestIdentity {
    uid: string;
    email?: string;
}

/**
 * Attaches the identity headers to a request:
 *
 *   await asUser(request.get('/api/weigh-ins'), { uid: 'user-1' }).expect(200);
 *
 * Returns the same `Test` so it stays chainable, and sets the email header only
 * when an email is given — a token without an `email` claim is a real case
 * (`getUserEmail` returns `undefined` for it).
 */
export const asUser = (test: supertest.Test, identity: TestIdentity): supertest.Test => {
    const withUser = test.set(TEST_USER_ID_HEADER, identity.uid);

    return identity.email === undefined ? withUser : withUser.set(TEST_EMAIL_HEADER, identity.email);
};
