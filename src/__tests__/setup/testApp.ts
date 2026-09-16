import supertest from 'supertest';

import app from '../../app';

export const TEST_USER_ID_HEADER = 'x-test-user-id';

export const TEST_EMAIL_HEADER = 'x-test-email';

// `src/app.ts` never calls listen() — `src/server.ts` owns that — which is what
// makes driving the shipped app, with its real mount order, valid in process.
export const request: supertest.Agent = supertest(app);

export interface TestIdentity {
    uid: string;
    email?: string;
}

export const asUser = (test: supertest.Test, identity: TestIdentity): supertest.Test => {
    const withUser = test.set(TEST_USER_ID_HEADER, identity.uid);

    return identity.email === undefined ? withUser : withUser.set(TEST_EMAIL_HEADER, identity.email);
};
