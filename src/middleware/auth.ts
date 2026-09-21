import { Request, Response, NextFunction } from 'express';
import { admin } from '../utils/firebase';
import { describeErrorSafely, logSafeEvent } from '../utils/safeLogger';

/**
 * What a rejected credential is recorded as, and the action that rejected it.
 *
 * The event name is the log's schema — an operator's query is a literal, and
 * `safeLogger`'s `EVENT_NAME_PATTERN` admits only `[a-z][a-z0-9_]{0,63}`, which
 * is why the dotted form belongs in `action` and the underscored one in the
 * event name (the partition every other call site in this codebase follows).
 */
const AUTH_VERIFY_FAILED = 'auth_verify_failed';
const AUTH_VERIFY_ACTION = 'auth.verify';

export async function authenticateFirebaseToken(req: Request, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const idToken = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    (req as any).user = decodedToken;
    next();
  } catch (error) {
    // One scrubbed line per rejected credential. `console.log(error, …)` stood
    // here, and Node renders a thrown `FirebaseAuthError` in full: a stack of
    // absolute filesystem paths plus the `errorInfo` and `codePrefix`
    // properties the Admin SDK attaches, whose `message` quotes the submitted
    // token back. AAP §0.3.2/§0.7.1 and Rule backend-architecture §8 forbid
    // printing any of it, and `describeErrorSafely` cannot reach `message`,
    // `stack`, `cause` or an own property — so nothing here depends on this
    // call site remembering the rule.
    //
    // `warn`, not `error`: a refused token is a rejection the server chose,
    // not a fault it suffered — the level partition
    // `api/controllerBoundary.test.ts` pins ("a rejection is not also a
    // failure"). The response below is unchanged, and deliberately says no
    // more than which of the two refusals happened.
    logSafeEvent('warn', AUTH_VERIFY_FAILED, {
      action: AUTH_VERIFY_ACTION,
      ...describeErrorSafely(error),
    });

    return res.status(401).json({ error: 'Invalid token' });
  }
}
