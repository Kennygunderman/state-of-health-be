import express, { NextFunction, Request, Response } from 'express';
import workoutRoutes from './routes/workout.routes';
import exerciseRoutes from './routes/exercise.routes';
import migrationRoutes from './routes/migration.routes';
import userRoutes from './routes/user.routes';
import runRoutes from './routes/run.routes';
import recordRoutes from './routes/record.routes';
import weighInRoutes from './routes/weighIn.routes';
import nutritionRoutes from './routes/nutrition.routes';
import foodRoutes from './routes/food.routes';
import catalogRoutes from './routes/catalog.routes';
import mealPlanningRoutes from './routes/mealPlanning.routes';
import { authenticateFirebaseToken } from './middleware/auth';
import { prisma } from './prisma/client';
import { SafeLogLevel, describeErrorSafely, logSafeEvent } from './utils/safeLogger';

const app = express();

// Express names itself in `X-Powered-By` on every response, including the ones
// written below by the body parsers and the terminal handlers. Nothing consumes
// the banner and a scanner reads it as a framework hint, so it is turned off
// here rather than stripped per response.
app.disable('x-powered-by');

/**
 * The hardening headers every response carries, whoever wrote it.
 *
 * `Cache-Control: no-store` is unconditional and applies to `/health` too: every
 * `/api` answer is a per-user document served with an `ETag` and `/health` is a
 * liveness probe, so this server returns nothing publicly cacheable — and one
 * unconditional code path is cheaper to reason about than a path-prefix test a
 * future route could be added outside of.
 */
const BASELINE_RESPONSE_HEADERS: Readonly<Record<string, string>> = {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
    'Cache-Control': 'no-store',
};

/**
 * 180 days. Long enough to cover a returning client's next visit, short enough
 * that the domain is not committed to a year of TLS-only that a certificate
 * lapse could not be walked back from.
 */
const HSTS_POLICY = 'max-age=15552000';

/** The header a TLS-terminating proxy records the original client's scheme in. */
const FORWARDED_PROTO_HEADER = 'x-forwarded-proto';

/**
 * Whether the request reached a TLS listener — this process directly, or the
 * proxy in front of it.
 *
 * The FIRST comma-separated value is the original client's scheme: each hop
 * appends its own, so the last value describes the hop nearest this process,
 * which is plaintext in exactly the deployment HSTS exists for.
 *
 * Read off the raw header rather than through `req.protocol`, which would need
 * `app.set('trust proxy', …)` — a setting that also changes what `req.ip` means
 * for every route mounted below, which is a behaviour change nothing here asks
 * for.
 */
const arrivedOverTls = (req: Request): boolean => {
    if (req.secure) {
        return true;
    }

    const forwarded = req.headers[FORWARDED_PROTO_HEADER];
    const claimed = Array.isArray(forwarded) ? forwarded[0] : forwarded;

    return claimed?.split(',')[0].trim().toLowerCase() === 'https';
};

// Mounted FIRST — ahead of /health and of every body parser — and the position
// is load-bearing (Rule backend-architecture §3.1). A middleware mounted after
// the parsers would still cover every routed answer, and would leave bare
// exactly the responses no route writes: a parser's 400/413 and the terminal
// 404 and error answers at the foot of this file, which are the responses an
// unauthenticated caller can reach most easily.
app.use((req: Request, res: Response, next: NextFunction) => {
    for (const [header, value] of Object.entries(BASELINE_RESPONSE_HEADERS)) {
        res.setHeader(header, value);
    }

    // HSTS over TLS only, deliberately. RFC 6797 §7.2 requires a user agent to
    // IGNORE this header when it arrives over plaintext, so emitting it on the
    // loopback and container-network requests this server also answers would be
    // inert noise rather than protection. Coolify terminates TLS and forwards
    // the client's scheme, so the condition is what makes the policy effective
    // in production without asserting TLS in development.
    if (arrivedOverTls(req)) {
        res.setHeader('Strict-Transport-Security', HSTS_POLICY);
    }

    next();
});

// Unauthenticated: used by Coolify health checks, uptime monitoring, and
// post-deploy verification. GIT_SHA is injected at image build time.
app.get('/health', async (_req, res) => {
    try {
        await prisma.$queryRaw`SELECT 1`;
        res.json({ status: 'ok', version: process.env.GIT_SHA ?? 'unknown' });
    } catch {
        res.status(503).json({ status: 'db_unreachable' });
    }
});

// The AI endpoints accept base64 photos, so they get a larger body limit.
// Must be registered BEFORE the global express.json() — the first JSON parser
// to run wins, and the global one would reject large payloads first.
app.use(['/api/macros/estimate', '/api/macros/label-scan'], express.json({ limit: '10mb' }));
// Avatar uploads are ~20KB base64 but can exceed the 100KB default limit if a
// client skips resizing; the controller enforces the real cap.
app.use('/api/user/avatar', express.json({ limit: '1mb' }));
app.use(express.json());

// User routes: signup is unprotected, avatar routes carry per-route auth
app.use('/api', userRoutes);

// Protected routes
app.use(authenticateFirebaseToken);
app.use('/api', workoutRoutes);
app.use('/api', exerciseRoutes);
app.use('/api', migrationRoutes);
app.use('/api', runRoutes);
app.use('/api', recordRoutes);
app.use('/api', weighInRoutes);
// foodRoutes must mount BEFORE nutritionRoutes: it owns the literal
// /macros/search-branded-foods and /macros/branded-food/:foodId paths, which
// nutrition's /macros/:date would otherwise swallow (date = "search-branded-foods").
app.use('/api', foodRoutes);
app.use('/api', nutritionRoutes);
// Safe to mount last: these own /catalog, /recipes and /meal-planning, which
// share no first path segment with any route above — nutrition's /macros/:date,
// the only parameterized path that could swallow a sibling, cannot reach them.
app.use('/api', catalogRoutes);
app.use('/api', mealPlanningRoutes);

// Mounted LAST, and — the load-bearing half (Rule backend-architecture §3.1) —
// after `app.use(authenticateFirebaseToken)` above. An unrouted path reached
// without a token must keep answering `401 {"error":"No token provided"}`:
// moving this handler above the auth boundary would let an anonymous caller
// tell a path that exists (401) from one that does not (404), which is a
// route-existence oracle. With it here, a 404 is only ever shown to a caller
// the token already admitted.
app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
});

/**
 * One terminal answer: the status and the exact body that goes on the wire.
 *
 * No member is derived from the error. That is the whole mechanism behind
 * closing the development stack leak — `finalhandler` serialises `err.stack`
 * whenever `NODE_ENV !== 'production'`, and a body assembled only from the
 * constants below cannot, in any environment.
 */
interface TerminalAnswer {
    readonly status: number;
    readonly body: { readonly error: string; readonly details?: readonly { field: string; code: string }[] };
}

/** The `{error, details}` envelope (§0.5.2) for a body the parser could not read. */
const MALFORMED_BODY: TerminalAnswer = {
    status: 400,
    body: { error: 'invalid_request', details: [{ field: 'body', code: 'malformed_json' }] },
};

const INVALID_REQUEST: TerminalAnswer = { status: 400, body: { error: 'invalid_request' } };

const INTERNAL_ERROR: TerminalAnswer = { status: 500, body: { error: 'internal_error' } };

/**
 * body-parser 1.20.3's `err.type` → the answer, keyed off the TYPE and never
 * off the message: the type is the library's documented discriminator, while
 * the message is English prose that changes between releases and quotes part of
 * the request back.
 *
 * `entity.parse.failed` covers both halves of a malformed transport body under
 * `express.json()`'s strict mode — truncated JSON, and a top-level scalar or
 * `null`, which parses but is not an object any route could read.
 */
const TRANSPORT_FAILURE_ANSWERS: Readonly<Record<string, TerminalAnswer>> = {
    'entity.parse.failed': MALFORMED_BODY,
    'entity.verify.failed': MALFORMED_BODY,
    'entity.too.large': { status: 413, body: { error: 'payload_too_large' } },
    'charset.unsupported': { status: 415, body: { error: 'unsupported_media_type' } },
    'encoding.unsupported': { status: 415, body: { error: 'unsupported_media_type' } },
};

/** The `type` a thrown value claims, when it claims a string one. */
const readFailureType = (error: unknown): string | undefined => {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    const { type } = error as { type?: unknown };

    return typeof type === 'string' ? type : undefined;
};

/** The HTTP status a thrown value claims, under either of the two names middleware uses. */
const readClaimedStatus = (error: unknown): number | undefined => {
    if (typeof error !== 'object' || error === null) {
        return undefined;
    }

    const { status, statusCode } = error as { status?: unknown; statusCode?: unknown };
    const claimed = typeof status === 'number' ? status : statusCode;

    return typeof claimed === 'number' && Number.isInteger(claimed) ? claimed : undefined;
};

/**
 * The answer for one thrown value: a known transport failure, an unrecognised
 * middleware rejection that named a 4xx, or a server fault.
 *
 * The own-property test is not ceremony: `err.type` is a string this code did
 * not choose, and `'constructor'` or `'toString'` would otherwise index the
 * table through the prototype chain and yield a function where an answer
 * belongs.
 */
const answerFor = (error: unknown): TerminalAnswer => {
    const failureType = readFailureType(error);

    if (failureType !== undefined && Object.prototype.hasOwnProperty.call(TRANSPORT_FAILURE_ANSWERS, failureType)) {
        return TRANSPORT_FAILURE_ANSWERS[failureType];
    }

    const claimedStatus = readClaimedStatus(error);

    return claimedStatus !== undefined && claimedStatus >= 400 && claimedStatus < 500
        ? INVALID_REQUEST
        : INTERNAL_ERROR;
};

/** A request the transport layer refused before any route could run. */
const TRANSPORT_REJECTED = 'transport_rejected';

/** An error that reached this handler with no mapping — a server fault. */
const UNHANDLED_FAILURE = 'unhandled_failure';

/** What these two answers call themselves in a log line: no controller action owns them. */
const TERMINAL_ACTION = 'app.terminal';

// The one error handler, mounted last. Express searches FORWARD from the point
// of failure for a 4-argument handler, so this single handler catches the
// failures of the body parsers mounted far above it — there is no second
// handler beside `express.json()` and there must not be one, or the two could
// answer the same class of failure differently.
app.use((error: unknown, req: Request, res: Response, next: NextFunction) => {
    const answer = answerFor(error);
    const isFault = answer.status >= 500;
    const level: SafeLogLevel = isFault ? 'error' : 'warn';
    const alreadyAnswered = res.headersSent;

    // Exactly one line, through the safe logger: `describeErrorSafely` yields
    // the class name and a machine code and cannot reach `message`, `stack`,
    // `cause` or `meta` (see utils/safeLogger.ts). So neither the log nor the
    // response above can carry the SyntaxError stack and absolute node_modules
    // paths `finalhandler` used to print, and neither outcome depends on
    // NODE_ENV.
    logSafeEvent(level, isFault ? UNHANDLED_FAILURE : TRANSPORT_REJECTED, {
        action: TERMINAL_ACTION,
        method: req.method,
        status: answer.status,
        code: answer.body.error,
        ...describeErrorSafely(error),
        headersSent: alreadyAnswered ? true : undefined,
    });

    if (alreadyAnswered) {
        // A second write on a response whose headers are already on the wire
        // throws inside this handler; Express's default handler is the only
        // thing that can close a half-written response, so delegate to it. This
        // branch is deliberately independent of
        // `mealPlanning.controller.ts::answerKeyedWrite`, which destroys the
        // socket for the post-commit abort seam WITHOUT calling next(err) — so
        // nothing here may assume the seam is the only way to get here.
        return next(error);
    }

    return res.status(answer.status).json(answer.body);
});

export default app;
