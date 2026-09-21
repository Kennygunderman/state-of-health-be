// What the authentication middleware ANSWERS and what it RECORDS.
//
// The recording half is the reason this suite exists. `middleware/auth.ts`
// used to hand the thrown `FirebaseAuthError` to `console.log`, and Node
// renders such a value in full: a stack of absolute filesystem paths, the
// `errorInfo` and `codePrefix` own-properties the Admin SDK attaches, and a
// `message` that quotes the credential the caller submitted (CWE-532,
// CWE-209; AAP §0.3.2/§0.7.1; Rule backend-architecture §8). A one-line swap
// to `logSafeEvent`/`describeErrorSafely` fixed it, and a one-line fix is
// exactly the kind a later refactor undoes silently — so each case below
// asserts on the EMITTED LINE, not merely on the status code.
//
// Two facts about this repository's test setup shape the file:
//
//  1. `src/__tests__/setup/jestSetup.ts` runs as a `setupFiles` entry and
//     registers `jest.mock('../../middleware/auth', …)` for every suite — a
//     header-reading stub that never calls Firebase. A naive import here would
//     test that stub. `jest.unmock('../auth')` below reaches the real module,
//     and the first case pins that it did, so the suite cannot pass by
//     accident against the stub.
//  2. `src/utils/firebase.ts` calls `admin.initializeApp()` at module scope, so
//     it is replaced by a factory whose `verifyIdToken` is a mock this file
//     controls. `describeErrorSafely` and `logSafeEvent` are the REAL ones:
//     the scrubbing is the thing under test, not a double of it.
//
// NO DATABASE, no Express app, no network: a request/response pair of doubles
// and the four `console` writers, spied per case.

jest.unmock('../auth');

const mockVerifyIdToken = jest.fn<Promise<{ uid: string; email?: string }>, [string]>();

jest.mock('../../utils/firebase', () => ({
    admin: {
        auth: () => ({
            verifyIdToken: (idToken: string) => mockVerifyIdToken(idToken),
        }),
    },
    db: {},
}));

import type { NextFunction, Request, Response } from 'express';

import { authenticateFirebaseToken } from '../auth';

/**
 * The credential a caller submits, in the shape a real client sends: a JWT with
 * a distinctive tail, so "the token did not reach the log" is assertable as a
 * substring rather than inferred.
 */
const SUBMITTED_TOKEN = 'eyJhbGciOiJSUzI1NiJ9.e30.sig-4f7a2c9e-not-a-real-token';

/** The uid the success path resolves to. */
const VERIFIED_UID = 'auth-suite-uid';

/** `safeLogger.ts`'s line format: `[meal-planning] <event> <json>`. */
const EVENT_LINE = /^\[meal-planning] (\S+) (\{.*\})$/;

/** The event name and action the fix is pinned to; the evidence checklist cites both. */
const AUTH_VERIFY_FAILED = 'auth_verify_failed';
const AUTH_VERIFY_ACTION = 'auth.verify';

/** The two bodies this middleware has always answered with, byte for byte. */
const NO_TOKEN_BODY = { error: 'No token provided' };
const INVALID_TOKEN_BODY = { error: 'Invalid token' };

/** One captured `console` call, whichever writer made it. */
interface ConsoleCall {
    level: 'log' | 'info' | 'warn' | 'error';
    args: unknown[];
}

/** One emitted server event, read back off the line that carried it. */
interface CapturedEvent {
    level: ConsoleCall['level'];
    line: string;
    event: string;
    fields: Record<string, unknown>;
}

/** What the response double recorded. */
interface RecordedResponse {
    statusCode: number | null;
    body: unknown;
    nextCalls: number;
}

let consoleSpies: jest.SpyInstance[] = [];
let consoleCalls: ConsoleCall[] = [];

beforeEach(() => {
    consoleCalls = [];
    // All FOUR writers, `log` included: the defect was a `console.log`, so a
    // regression that re-adds one has to be visible to this suite rather than
    // slip past a spy set that only watches the safe logger's three levels.
    consoleSpies = (['log', 'info', 'warn', 'error'] as const).map((level) =>
        jest.spyOn(console, level).mockImplementation((...args: unknown[]) => {
            consoleCalls.push({ level, args });
        }),
    );
    mockVerifyIdToken.mockReset();
});

afterEach(() => {
    for (const spy of consoleSpies) {
        spy.mockRestore();
    }
});

/** Every captured call that parsed as a safe-logger event line. */
const capturedEvents = (): CapturedEvent[] =>
    consoleCalls.flatMap(({ level, args }) => {
        const line = String(args[0]);
        const match = EVENT_LINE.exec(line);

        return match === null
            ? []
            : [
                  {
                      level,
                      line,
                      event: match[1],
                      fields: JSON.parse(match[2]) as Record<string, unknown>,
                  },
              ];
    });

/**
 * A stand-in for the value `verifyIdToken` actually rejects with.
 *
 * Shaped from the real class rather than imagined (`firebase-admin`'s
 * `FirebaseError` → `PrefixedFirebaseError` → `FirebaseAuthError`): the SDK
 * never assigns `name`, so a thrown `FirebaseAuthError` reports
 * `name === 'Error'` while its stack's first line says `FirebaseAuthError`; its
 * own enumerable properties are exactly `errorInfo` and `codePrefix`; and its
 * `code` getter returns `<prefix>/<code>`, which `safeLogger`'s
 * `ERROR_CODE_PATTERN` rejects (it admits `[A-Za-z][A-Za-z0-9_]{0,31}`), so no
 * `errorCode` field is emitted for it. Every one of those facts was read off
 * the installed `firebase-admin@13`, and each is what one assertion below
 * depends on.
 */
class FirebaseAuthErrorDouble extends Error {
    readonly errorInfo: { code: string; message: string };

    readonly codePrefix = 'auth';

    constructor(code: string, message: string) {
        super(message);
        this.errorInfo = { code, message };
        // A real one carries 25 frames and 14 absolute paths. Three frames are
        // enough to fail every path assertion below, and the two directory
        // roots are the ones this host's paths actually begin with.
        this.stack = [
            `FirebaseAuthError: ${message}`,
            '    at FirebaseTokenVerifier.mapJwtErrorToAuthError ' +
                '(/tmp/state-of-health/backend/node_modules/firebase-admin/lib/auth/token-verifier.js:281:20)',
            '    at /root/state-of-health/backend/node_modules/firebase-admin/lib/auth/token-verifier.js:255:24',
            '    at processTicksAndRejections (node:internal/process/task_queues:103:5)',
        ].join('\n');
    }

    get code(): string {
        return `${this.codePrefix}/${this.errorInfo.code}`;
    }
}

/**
 * The minimal Express trio this middleware touches.
 *
 * `headers.authorization` is the only request field it reads — deliberately
 * NOT `req.header(…)`, which is what the global stub reads, so a double built
 * this way cannot satisfy the stub.
 */
const doubles = (
    authorization?: string,
): { req: Request & { user?: unknown }; res: Response; next: NextFunction; recorded: RecordedResponse } => {
    const recorded: RecordedResponse = { statusCode: null, body: null, nextCalls: 0 };
    const res = {
        status: (code: number) => {
            recorded.statusCode = code;

            return res;
        },
        json: (body: unknown) => {
            recorded.body = body;

            return res;
        },
    };

    return {
        req: {
            headers: authorization === undefined ? {} : { authorization },
        } as unknown as Request & { user?: unknown },
        res: res as unknown as Response,
        next: (() => {
            recorded.nextCalls += 1;
        }) as NextFunction,
        recorded,
    };
};

/** Runs the middleware over one request and returns what the response recorded. */
const authenticate = async (authorization?: string): Promise<RecordedResponse & { user: unknown }> => {
    const { req, res, next, recorded } = doubles(authorization);

    await authenticateFirebaseToken(req, res, next);

    return { ...recorded, user: req.user };
};

describe('the module under test', () => {
    it('is the real middleware and not the header-reading stub jestSetup installs', () => {
        // Identity against `requireActual`, so the `jest.unmock` above is
        // asserted rather than assumed. Without it every case below would be
        // exercising `jestSetup.ts`'s stub, which never calls Firebase and
        // never logs — and the leak assertions would pass while the leak
        // remained in the shipped middleware.
        const actual = jest.requireActual<typeof import('../auth')>('../auth');

        expect(authenticateFirebaseToken).toBe(actual.authenticateFirebaseToken);
    });
});

describe('a request carrying no usable credential', () => {
    it('answers 401 "No token provided" and records nothing', async () => {
        const { statusCode, body, nextCalls } = await authenticate();

        expect(statusCode).toBe(401);
        expect(body).toEqual(NO_TOKEN_BODY);
        expect(nextCalls).toBe(0);
        // Verification was never attempted, so there is nothing to record: an
        // absent header is the client's own omission, not an event.
        expect(mockVerifyIdToken).not.toHaveBeenCalled();
        expect(consoleCalls).toHaveLength(0);
    });

    it('answers the same 401 for a non-Bearer scheme', async () => {
        const { statusCode, body, nextCalls } = await authenticate('Basic dXNlcjpwYXNz');

        expect(statusCode).toBe(401);
        expect(body).toEqual(NO_TOKEN_BODY);
        expect(nextCalls).toBe(0);
        expect(mockVerifyIdToken).not.toHaveBeenCalled();
        // The submitted secret is not echoed anywhere, including into a log
        // line about the scheme being wrong.
        expect(consoleCalls).toHaveLength(0);
    });
});

describe('a credential Firebase refuses', () => {
    /** The message a real `FirebaseAuthError` carries, extended with the two things a log must survive. */
    const REFUSAL_MESSAGE =
        `Decoding Firebase ID token failed for ${SUBMITTED_TOKEN}. Make sure you passed the entire string JWT ` +
        'which represents an ID token. See https://firebase.google.com/docs/auth/admin/verify-id-tokens\r\n' +
        '[meal-planning] forged_event {"status":"ok"}';

    const refuse = async (): Promise<RecordedResponse & { user: unknown }> => {
        mockVerifyIdToken.mockRejectedValue(new FirebaseAuthErrorDouble('argument-error', REFUSAL_MESSAGE));

        return authenticate(`Bearer ${SUBMITTED_TOKEN}`);
    };

    it('answers 401 "Invalid token" and does not continue the chain', async () => {
        const { statusCode, body, nextCalls, user } = await refuse();

        expect(mockVerifyIdToken).toHaveBeenCalledWith(SUBMITTED_TOKEN);
        expect(statusCode).toBe(401);
        expect(body).toEqual(INVALID_TOKEN_BODY);
        expect(nextCalls).toBe(0);
        expect(user).toBeUndefined();
    });

    it('records exactly one warn-level auth_verify_failed event and nothing else', async () => {
        await refuse();

        // One console call in total: one event line, and no second raw line
        // beside it. `warn` and not `error`, because a refused credential is a
        // rejection the server chose rather than a fault it suffered — the
        // level partition `api/controllerBoundary.test.ts` pins.
        expect(consoleCalls).toHaveLength(1);
        expect(consoleCalls[0].level).toBe('warn');
        expect(consoleCalls[0].args).toHaveLength(1);

        const events = capturedEvents();

        expect(events).toHaveLength(1);
        expect(events[0].event).toBe(AUTH_VERIFY_FAILED);
        expect(events[0].line.split('\n')).toHaveLength(1);
        // The whole field set, asserted exactly: `errorName` is `'Error'`
        // because `firebase-admin` never assigns `name`, and there is no
        // `errorCode` because `auth/argument-error` fails the machine-code
        // pattern. An added field would fail here rather than leak quietly.
        expect(events[0].fields).toEqual({ action: AUTH_VERIFY_ACTION, errorName: 'Error' });
    });

    it('emits no stack frame, no filesystem path, no SDK internals and no part of the token', async () => {
        await refuse();

        const emitted = capturedEvents()[0].line;

        for (const leak of [
            'codePrefix',
            'errorInfo',
            'argument-error',
            'not-a-real-token',
            SUBMITTED_TOKEN,
            '/tmp/',
            '/root/',
            'node_modules',
            'token-verifier.js',
            'firebase.google.com',
            // A newline in the message must not become a second, forgeable
            // log line — `sanitizeLogText` collapses CR/LF, and nothing from
            // the message reaches the line in the first place.
            'forged_event',
        ]) {
            expect(emitted).not.toContain(leak);
        }
        // `at ` followed by a path — the shape of a stack frame — in any form.
        expect(emitted).not.toMatch(/at\s+\S*\//);
    });

    it('records one event per refused request, so the count is the number of attempts', async () => {
        await refuse();
        await refuse();
        await refuse();

        expect(capturedEvents()).toHaveLength(3);
        expect(consoleCalls).toHaveLength(3);
    });

    it('records the same event when the SDK rejects with a value that is not an Error', async () => {
        // A vendor is free to reject with anything. `describeErrorSafely` names
        // it `NonError` without printing it, so the string cannot reach the
        // log — and the client still gets the same 401.
        mockVerifyIdToken.mockRejectedValue(`postgresql://soh:s3cret@db.internal:5432/soh ${SUBMITTED_TOKEN}`);

        const { statusCode, body } = await authenticate(`Bearer ${SUBMITTED_TOKEN}`);
        const events = capturedEvents();

        expect(statusCode).toBe(401);
        expect(body).toEqual(INVALID_TOKEN_BODY);
        expect(events).toHaveLength(1);
        expect(events[0].level).toBe('warn');
        expect(events[0].fields).toEqual({ action: AUTH_VERIFY_ACTION, errorName: 'NonError' });
        expect(events[0].line).not.toContain('s3cret');
        expect(events[0].line).not.toContain(SUBMITTED_TOKEN);
    });
});

describe('a credential Firebase accepts', () => {
    it('attaches the verified claims, calls next once and records nothing', async () => {
        const claims = { uid: VERIFIED_UID, email: 'auth-suite@example.test' };

        mockVerifyIdToken.mockResolvedValue(claims);

        const { statusCode, body, nextCalls, user } = await authenticate(`Bearer ${SUBMITTED_TOKEN}`);

        expect(mockVerifyIdToken).toHaveBeenCalledWith(SUBMITTED_TOKEN);
        expect(nextCalls).toBe(1);
        expect(user).toEqual(claims);
        // The response was never touched: the chain continues, and an answered
        // request is the middleware's silent path — no event, no line.
        expect(statusCode).toBeNull();
        expect(body).toBeNull();
        expect(consoleCalls).toHaveLength(0);
    });
});
