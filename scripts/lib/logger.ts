// Structured, secret-safe logging for the meal-planning CLI scripts.
//
// Everything the catalog pipeline prints goes through here, because Rule
// backend-architecture §8 requires a safe message rather than the raw error
// object: a stack trace or a vendor error string reaching a terminal, a CI log
// or a committed report is a credential leak. The three real vectors in this
// pipeline are DATABASE_URL (the password lives in the URL userinfo and pg and
// Prisma echo the connection string), USDA_API_KEY (`api_key=` sits in the
// query string of every USDA request URL, which fetch failures quote back) and
// OPENROUTER_API_KEY (an `Authorization: Bearer` header that OpenRouter's own
// error bodies can reflect).
//
// The module imports two Node builtins — `fs`, for the synchronous fatal write
// path at the bottom of the file, which is the only way a refusal can be
// guaranteed to reach fd 2 before `process.exit()`, and `crypto`, for the
// one-way digest `opaqueDigest` below hands a caller that must correlate two
// runs without naming the thing they were pointed at — and nothing else. It
// reads no environment variable and has no import-time side effect. It formats
// and redacts, and decides nothing about the pipeline (§1.1); the log level is
// an injected option rather than a new env key (§1.6/§9); and `write`/`now` are
// injected so the pure rules below are unit-testable from `src/__tests__`
// (§11 — Jest's `roots` is `<rootDir>/src`, so no test file can live here).

import crypto from 'crypto';
import fs from 'fs';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogFields = Record<string, unknown>;

export interface ScriptLogger {
    debug(event: string, fields?: LogFields): void;
    info(event: string, fields?: LogFields): void;
    warn(event: string, fields?: LogFields): void;
    error(event: string, fields?: LogFields): void;
    child(scope: string): ScriptLogger;
}

const REDACTED = '***';
const UNSERIALIZABLE = '[unserializable]';

// The three delimiters that end a URL authority (RFC 3986 §3.2) and the
// userinfo delimiter inside it, as code points so the authority scan below is a
// comparison per character rather than a regex call per character.
const CHAR_SLASH = 0x2f;
const CHAR_QUESTION_MARK = 0x3f;
const CHAR_NUMBER_SIGN = 0x23;
const CHAR_AT_SIGN = 0x40;

// The non-alphanumeric characters an RFC 3986 scheme may contain after its
// leading letter: `scheme = ALPHA *( ALPHA / DIGIT / "+" / "-" / "." )`.
const CHAR_PLUS = 0x2b;
const CHAR_HYPHEN = 0x2d;
const CHAR_PERIOD = 0x2e;

const CHAR_DIGIT_ZERO = 0x30;
const CHAR_DIGIT_NINE = 0x39;
const CHAR_UPPERCASE_A = 0x41;
const CHAR_UPPERCASE_Z = 0x5a;
const CHAR_LOWERCASE_A = 0x61;
const CHAR_LOWERCASE_Z = 0x7a;

// The boundary between the ASCII fast path and the Unicode whitespace check.
const CHAR_ASCII_LIMIT = 0x80;
const CHAR_SPACE = 0x20;
const CHAR_TAB = 0x09;
const CHAR_CARRIAGE_RETURN = 0x0d;

const isAsciiLetter = (code: number): boolean =>
    (code >= CHAR_UPPERCASE_A && code <= CHAR_UPPERCASE_Z) || (code >= CHAR_LOWERCASE_A && code <= CHAR_LOWERCASE_Z);

const isSchemeCharacter = (code: number): boolean =>
    isAsciiLetter(code) ||
    (code >= CHAR_DIGIT_ZERO && code <= CHAR_DIGIT_NINE) ||
    code === CHAR_PLUS ||
    code === CHAR_HYPHEN ||
    code === CHAR_PERIOD;

// Exactly the set JavaScript's `\s` matches, which is the set a regex form of
// this rule delegates the question to. The membership matters: a log line is
// prose, and a non-breaking space or a line separator arriving inside a vendor
// error body is what separates one URL from the next in it. Treating such a
// character as part of an authority would let the scan run past the end of one
// URL and miss the credential in the one after it.
const isUrlWhitespace = (code: number): boolean => {
    if (code < CHAR_ASCII_LIMIT) {
        return code === CHAR_SPACE || (code >= CHAR_TAB && code <= CHAR_CARRIAGE_RETURN);
    }
    return (
        code === 0x00a0 ||
        code === 0x1680 ||
        (code >= 0x2000 && code <= 0x200a) ||
        code === 0x2028 ||
        code === 0x2029 ||
        code === 0x202f ||
        code === 0x205f ||
        code === 0x3000 ||
        code === 0xfeff
    );
};

const isAuthorityTerminator = (code: number): boolean =>
    code === CHAR_SLASH || code === CHAR_QUESTION_MARK || code === CHAR_NUMBER_SIGN || isUrlWhitespace(code);

const SCHEME_SEPARATOR = '://';

// One leading letter plus the 40-character scheme body this rule bounds, so the
// walk-back below inspects at most 41 characters per `://` it finds. The
// longest registered URI scheme is about 20 characters, which leaves room for
// an unregistered one and still refuses to walk the length of a vendor error
// body looking for the start of a scheme that is not there.
const MAX_SCHEME_LENGTH = 41;

// Whether the characters immediately to the LEFT of a `://` form a scheme.
//
// Walks left from the separator over scheme-legal characters, stopping at the
// first character that is not one or at the 41-character bound, and reports
// whether the run it covered contains a letter — a scheme must start with one,
// so a run of only digits, `+`, `-` and `.` is not a scheme and the `://` after
// it is not a URL.
const hasSchemeBefore = (value: string, separatorIndex: number): boolean => {
    const limit = separatorIndex > MAX_SCHEME_LENGTH ? separatorIndex - MAX_SCHEME_LENGTH : 0;
    let sawLetter = false;

    for (let index = separatorIndex; index > limit; index -= 1) {
        const code = value.charCodeAt(index - 1);
        if (!isSchemeCharacter(code)) {
            break;
        }
        if (isAsciiLetter(code)) {
            sawLetter = true;
        }
    }

    return sawLetter;
};

/**
 * Replaces the userinfo of every URL in a string with `***`, leaving the scheme,
 * host, port, path, query and fragment exactly as they were.
 *
 * `redactUrlUserinfo('postgresql://user:pa@ss@localhost:5433/db')` is
 * `'postgresql://***@localhost:5433/db'`, and a URL whose authority carries no
 * `@` at all comes back byte-identical — a bare host is not a credential and
 * redacting it would cost an operator the one field that says which database a
 * run was pointed at. The result is a fixed point of this function, which is
 * part of SCRUB_RULES' idempotence contract below.
 *
 * WHERE THE USERINFO ENDS, AND WHY IT IS THE LAST `@`.
 *
 * DATABASE_URL is the credential this pipeline is most likely to print, and its
 * password sits in the URL userinfo, so this rule has to be right about where
 * that userinfo stops. RFC 3986 §3.2 ends the authority at the first `/`, `?`,
 * `#` or the end of the string, and within that authority the userinfo is
 * everything before the LAST `@`. An unescaped `@` is legal in a Postgres
 * password and common in generated ones, so `postgresql://user:pa@ss@localhost`
 * has the password `pa@ss` and the host `localhost` — reading the first `@` as
 * the delimiter instead yields the password `pa` and the "host" `ss@localhost`,
 * and emits the password's suffix to an operator's terminal, to a CI log and,
 * through checkpoint.ts's `sanitizeRunLogEntry`, into the
 * `catalog_import_runs.log` column (CWE-532).
 *
 * WHY THIS IS SCANNED AND NOT MATCHED.
 *
 * A regex can express the rule, and both spellings of it are worse than a scan.
 * The reasons are structural rather than measured, so they hold on any runtime
 * and on any machine (no timing figure is quoted here: a millisecond count
 * depends on the host, the load and the engine version, and none of those is
 * recorded beside it — the reproducible assertion is the time BUDGET in
 * `src/__tests__/scripts/catalog-import.test.ts`, which runs the real function
 * on adversarial input):
 *
 *  - An unbounded scheme body — `([a-z][a-z0-9+.-]*:\/\/)` — is quadratic in the
 *    length of a scheme-legal run, because the engine retries the unbounded
 *    quantifier from every offset in that run. A vendor error body is
 *    caller-supplied input this module is expected to survive, so the bound is a
 *    security property. That is why `hasSchemeBefore` above is bounded too.
 *  - A bounded greedy authority — `[^\/\s?#]*@` — is correct on the sample and
 *    still rescans: a global regex retries the bounded scheme quantifier at
 *    every offset of a delimiter-free run. The scan below reads each `://` once
 *    and each authority once, so its cost is linear in the input.
 *  - A bounded authority — `[^\/\s?#]{0,N}@` — fails to match at all once the
 *    authority is longer than N, which does not shorten the leak but widens it:
 *    a 600-character password would go from partially redacted to printed whole.
 *
 * The scan is linear because `indexOf` finds each `://` in one pass, the
 * walk-back for a scheme is capped at 41 characters, and the authority is read
 * once — the resume point after each URL is the end of its authority, and an
 * authority cannot contain a `://` because it cannot contain a `/`.
 */
export const redactUrlUserinfo = (value: string): string => {
    // Guarded rather than trusted, exactly as scrubSecrets is and for the same
    // reason: this runs on error messages and decoded vendor JSON, where the
    // runtime value can disagree with its declared type.
    if (typeof value !== 'string') {
        return '';
    }

    let searchFrom = 0;
    // The prefix of `value` already copied into `redacted`. Left at 0 while
    // nothing has matched, which is how an untouched string is returned as
    // itself rather than rebuilt.
    let copiedUpTo = 0;
    let redacted = '';

    for (;;) {
        const separatorIndex = value.indexOf(SCHEME_SEPARATOR, searchFrom);
        if (separatorIndex < 0) {
            break;
        }
        if (!hasSchemeBefore(value, separatorIndex)) {
            // Not a URL — a bare `://`, or one whose left-hand run holds no
            // letter (`1://`). One character is enough to advance the search:
            // `://` cannot overlap another occurrence of itself.
            searchFrom = separatorIndex + 1;
            continue;
        }

        const authorityStart = separatorIndex + SCHEME_SEPARATOR.length;
        let authorityEnd = value.length;
        let lastAtSignIndex = -1;

        for (let index = authorityStart; index < value.length; index += 1) {
            const code = value.charCodeAt(index);
            if (isAuthorityTerminator(code)) {
                authorityEnd = index;
                break;
            }
            if (code === CHAR_AT_SIGN) {
                lastAtSignIndex = index;
            }
        }

        // Past the authority either way, and strictly past the separator, so the
        // loop always advances. An `@` after this point belongs to a path, a
        // query or a fragment — `https://example.com/path?a=b@c` carries no
        // userinfo and must come back whole.
        searchFrom = authorityEnd;

        if (lastAtSignIndex < 0) {
            continue;
        }

        redacted += `${value.slice(copiedUpTo, authorityStart)}${REDACTED}@`;
        copiedUpTo = lastAtSignIndex + 1;
    }

    if (copiedUpTo === 0) {
        return value;
    }
    return redacted + value.slice(copiedUpTo);
};

// THE SECURITY CONTRACT OF THIS MODULE.
//
// These rules are applied in order to every caller-supplied string that
// reaches the log — field values (however deeply nested), field keys, error
// messages, the scope and the event code. Adding a credential-bearing variable
// to `.env.example` means adding a rule here: a missing pattern is a leaked
// credential, not a formatting nit.
//
// Two properties every rule must keep. Order matters, so a new rule goes where
// its input still exists (the PEM rule must precede the base64 rule, or a
// private key is reduced to its markers plus a redacted body). And every rule's
// output is a fixed point of that rule, which is what makes `scrubSecrets`
// idempotent — callers legitimately pass strings that have already been
// scrubbed once.
//
// One consequence worth knowing: the last rule redacts any long opaque run, so
// it also hides a full SHA-256 digest. A caller that needs to show a checksum
// logs a short prefix (12 characters is well under the threshold) instead of
// widening the pattern.
//
// A rule is either a pattern and its replacement or a named transform. The
// second form exists because one of the five rules below cannot be a regex
// without either leaking or stalling — see `redactUrlUserinfo` above, which
// documents both measurements. The list stays an ORDERED list of transforms
// whichever form each entry takes, and `scrubSecrets` applies them in order.
type ScrubRule = { pattern: RegExp; replacement: string } | { scrub: (value: string) => string };

const SCRUB_RULES: Array<ScrubRule> = [
    { pattern: /-----BEGIN[\s\S]*?-----END[^-\n]*-----/g, replacement: REDACTED },
    // URL userinfo, scanned rather than matched, and SECOND — after the PEM
    // rule and before the Bearer rule, which are the two neighbours that fix
    // its position: a private key must already have been collapsed by the rule
    // above, and this must run before the Bearer rule so a credential written
    // as a URL is gone before anything else can claim part of it.
    // `redactUrlUserinfo`
    // carries the reasoning — the authority is read to its RFC 3986 end and the
    // LAST `@` in it is the userinfo delimiter, because an unescaped `@` is
    // legal in a URL password and stopping at the first one prints its suffix.
    { scrub: redactUrlUserinfo },
    { pattern: /bearer\s+[^\s"',;)\]}]+/gi, replacement: `Bearer ${REDACTED}` },
    // The parameter name is kept (it is useful in a log) and only its value is
    // lost. Longest alternatives come first so `access_token` is not split by
    // `token`, and the `\b` branch keeps `pageSize=20` and `monkey=1` intact.
    //
    // `_` and `-` are lead-in characters beside `?&;` because `_` is itself a
    // word character: with `\b` alone there is no boundary between `USDA_` and
    // `API_KEY`, so the env-file shape every credential-bearing name in
    // .env.example has — `USDA_API_KEY=`, `OPENROUTER_API_KEY=`,
    // `FIREBASE_SERVICE_ACCOUNT=` — never tripped this rule and was printed, and
    // persisted by checkpoint.ts into `catalog_import_runs.log`, verbatim.
    //
    // Both quantifiers around the name are bounded for the same reason the URL
    // rule above is, and for the same structural reason rather than a measured
    // one: a lead-in written as the prefix loop `(?:[A-Za-z0-9]+[_-])*`, or a
    // trailing-segment loop relaxed to `{0,32}`, nests one unbounded-in-practice
    // quantifier inside another and rescans a long name-shaped run from every
    // offset in it. The bounded forms below cannot. The trailing loop is what
    // recognises a suffixed name (`API_KEY_ID`, `SERVICE_ACCOUNT_JSON`), and four
    // segments is more than any name this pipeline configures.
    {
        pattern:
            /([?&;_-]|\b)((?:access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|private[_-]?key|client[_-]?secret|service[_-]?account|authorization|credentials?|password|passwd|signature|secret|token|auth|bearer|key)(?:[_-][A-Za-z0-9]{1,32}){0,4}[_-]?)(\s*=\s*)[^&\s#"']*/gi,
        replacement: `$1$2$3${REDACTED}`,
    },
    { pattern: /[A-Za-z0-9+/]{40,}={0,2}/g, replacement: REDACTED },
];

export const scrubSecrets = (value: string): string => {
    // Guarded rather than trusted: this runs on error messages and decoded
    // vendor JSON, where the runtime value can disagree with its declared type.
    if (typeof value !== 'string') {
        return '';
    }
    return SCRUB_RULES.reduce(
        (scrubbed, rule) => ('scrub' in rule ? rule.scrub(scrubbed) : scrubbed.replace(rule.pattern, rule.replacement)),
        value,
    );
};

// THE KEY-NAME HALF OF THE SECURITY CONTRACT.
//
// SCRUB_RULES can only see the string it is handed. It recognises
// `password=hunter2` inside a value, but a bare `hunter2` stored under a field
// called `password` carries no pattern at all, and the name is the only signal
// there is. This vocabulary is that signal, and it lives here — beside the
// patterns — so the pipeline keeps exactly ONE definition of "what is a
// secret": checkpoint.ts imports it for the persisted run log, which means an
// operator's terminal and the `catalog_import_runs.log` column can no longer
// disagree about the same payload. They did disagree while the list lived only
// in checkpoint.ts, and the terminal was the permissive side of the two.
//
// Matched as whole WORDS after a camelCase/snake_case split, never as
// substrings: that is what keeps `author` and `authored_by` out of the
// credential set while still catching `authHeader`, and what makes
// `dbPassword`, `db_password` and `DB-PASSWORD` one case rather than three.
const SECRET_BEARING_KEY_WORDS: ReadonlySet<string> = new Set([
    'password',
    'passwd',
    'secret',
    'token',
    'credential',
    'credentials',
    'signature',
    'authorization',
    'auth',
    'bearer',
]);

// The bare word `key` is DELIBERATELY ABSENT above, and that exclusion is worth
// defending against a future edit that "completes" the list: this pipeline's
// diagnostics legitimately record `batchKey`, `sourceKey` and `manifestKey`, and
// a resume key is the one field that explains where an interrupted run stopped
// — redacting it would cost an operator the reason to read the log at all.
// `tokensUsed` survives for the related reason that word matching gives
// `['tokens', 'used']`, and `tokens` is not `token`.
//
// Names that only read as a credential once their words are joined are
// therefore matched as PHRASES against the key with its separators removed,
// since splitting `apiKey` or `x-api-key` into words would produce the excluded
// `key` again. `serviceaccount` is in the list for FIREBASE_SERVICE_ACCOUNT.
//
// The phrase match is UNANCHORED — anywhere in the collapsed key — and stays
// that way. Anchoring it to the end would be tidier and would silently stop
// redacting `serviceAccountJson`, `apiKeyHeader` and the plural `apiKeys`,
// every one of which is a name this codebase could plausibly grow, so the
// looseness is the safe direction of the trade and is not a defect to fix.
//
// THE PRICE OF THAT LOOSENESS, AND WHO PAYS IT: A FIELD NAME IS A FIXED
// IDENTIFIER, NEVER DERIVED FROM DATA.
//
// Because the match is unanchored and decided before recursion, ANY key whose
// name merely mentions a credential loses its whole value to `***` — including
// a key that was only ever going to hold safe prose. A caller that builds field
// names out of data therefore cannot predict which of its fields survive:
// `catalog-import-usda.ts` reported unmet prerequisites as one field per gap
// code, and `gap_usda_api_key_missing` collapsed to `gapusdaapikeymissing`,
// matched `apikey`, and replaced the requirement-and-remedy sentence an
// operator needed with `***` — the safe half of the diagnostic destroyed while
// nothing unsafe was ever present.
//
// The contract both sides of that keep is: the KEY is a fixed identifier the
// author wrote, and anything derived from data — a gap code, a check name, a
// category, a source key — goes in a VALUE. A set of them is one neutral plural
// key holding structured objects (`gaps: [{code, requirement, remedy}]`), whose
// own keys are fixed and whose values still pass through SCRUB_RULES. That is
// what "redact values, not safe diagnostic prose" means operationally, and it
// costs nothing: a credential appearing INSIDE such prose is still scrubbed by
// the value rules above — `USDA_API_KEY=abc` becomes `USDA_API_KEY=***` and a
// DSN loses its userinfo — so moving the code out of the key name protects the
// diagnostic without weakening the vocabulary below.
const SECRET_BEARING_KEY_PHRASES: readonly string[] = [
    'apikey',
    'accesstoken',
    'refreshtoken',
    'idtoken',
    'privatekey',
    'clientsecret',
    'serviceaccount',
];

// One split shared by the word check and, in its collapsed form, the phrase
// check, so the two halves cannot drift apart.
const secretKeyWordsOf = (key: string): string[] =>
    key
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .split(/[^A-Za-z0-9]+/)
        .filter((word) => word.length > 0)
        .map((word) => word.toLowerCase());

/**
 * Whether a field NAME declares its value to be a credential — as opposed to a
 * string that might happen to contain one, which is SCRUB_RULES' job.
 *
 * Exported because both redaction paths in this pipeline have to answer the
 * question identically: `sanitizeLogFields` below asks it of every object key on
 * its way to a terminal line, and checkpoint.ts's `sanitizeRunLogEntry` asks it
 * of every key on its way into the `log` JSONB column. A caller that stores or
 * prints caller-supplied structures elsewhere asks it too, rather than
 * reinventing the vocabulary.
 *
 * `isSecretBearingKey('dbPassword')` and `isSecretBearingKey('x-api-key')` are
 * both true; `isSecretBearingKey('batchKey')`, `'sourceKey'`, `'tokensUsed'` and
 * `'authored_by'` are all false, deliberately (see the two lists above).
 */
export const isSecretBearingKey = (key: string): boolean => {
    // Guarded rather than trusted, like scrubSecrets above: this runs on keys
    // taken from decoded vendor JSON, where a runtime value can disagree with
    // its declared type, and a non-string here must not throw on a log path.
    if (typeof key !== 'string') {
        return false;
    }
    const collapsed = key.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (SECRET_BEARING_KEY_PHRASES.some((phrase) => collapsed.includes(phrase))) {
        return true;
    }
    return secretKeyWordsOf(key).some((word) => SECRET_BEARING_KEY_WORDS.has(word));
};

/**
 * A MACHINE code carried by a thrown value — Prisma's `P2002`, Node's
 * `ENOENT`, a typed error's own `code`. Bounded and alphanumeric, so a `code`
 * that is really a message, a path, a SQL fragment or an echoed argument fails
 * the test and is dropped rather than logged. The same pattern
 * `src/utils/safeLogger.ts` applies at the HTTP edge, kept identical so the two
 * halves of this codebase answer "what may a log say about a failure" the same
 * way.
 */
const ERROR_CODE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** An error class name is a class name; 64 characters covers every class here and bounds a foreign one. */
const MAX_ERROR_NAME_LENGTH = 64;

const FALLBACK_ERROR_NAME = 'Error';
const NON_ERROR_NAME = 'UnknownError';

/** The closed description of a failure: no field of it can carry caller, vendor or model text. */
export interface SafeErrorFields {
    readonly name: string;
    readonly code?: string;
    readonly status?: number;
}

// A property read off a thrown value that cannot itself fail: `throw` accepts
// any value, so a getter here may throw and the value may be a primitive or
// null. A logging path must answer either way.
const propertyOfThrown = (error: unknown, key: 'code' | 'status'): unknown => {
    try {
        return (error as Record<string, unknown> | null | undefined)?.[key];
    } catch {
        return undefined;
    }
};

/**
 * Whether a thrown value is an `Error`, ACROSS REALMS.
 *
 * WHY `instanceof` ALONE IS NOT ENOUGH, and why this matters more than it looks.
 * `instanceof` compares against one realm's `Error.prototype`, and a thrown
 * value does not always come from the realm doing the checking. The case that
 * bites here is Jest: each test file runs inside a sandboxed context with its
 * own intrinsics, while `fs`, `JSON` and the other core modules throw errors
 * built from the HOST realm's `Error` — so a bare `error instanceof Error` is
 * `false` for the very failures these scripts report most often. The same is true of a
 * value crossing a `vm` context or a worker boundary.
 *
 * Before this function existed the consequence was invisible, because
 * {@link safeError} still carried a `message` and the `ENOENT` was inside it.
 * It is not invisible now: the closed field set made `code` the ONLY carrier of
 * what an operator acts on, so a realm mismatch silently downgraded a
 * diagnosable `Error (code ENOENT)` to a bare `UnknownError`. Two engineers hit
 * exactly that while writing assertions against a filesystem refusal, which is
 * how it was found.
 *
 * `Object.prototype.toString` reads the value's internal tag rather than its
 * prototype chain, so a native `Error` from any realm answers `[object Error]`
 * — including subclasses and `AggregateError`, and excluding `DOMException`,
 * which carries its own tag.
 *
 * A HOSTILE VALUE CAN SPOOF THE TAG by setting `Symbol.toStringTag`, and that
 * buys it nothing: every field read afterwards is constrained independently —
 * `name` is scrubbed and bounded to {@link MAX_ERROR_NAME_LENGTH}, `code` must
 * match {@link ERROR_CODE_PATTERN}, `status` must be an integer in the HTTP
 * range — so the worst a spoof achieves is being described as an error it
 * resembles. The check decides which BRANCH runs, never what may be printed.
 *
 * WHY BOTH INSPECTIONS ARE CONTAINED. Neither operation is safe on an arbitrary
 * value, and `throw` accepts any value at all:
 *
 *  * `Object.prototype.toString.call(value)` READS `Symbol.toStringTag`, so an
 *    object defining that key as a throwing getter makes the tag check throw.
 *  * `instanceof` invokes `Error[Symbol.hasInstance]` and walks the prototype
 *    chain, so a `Proxy` with a `getPrototypeOf` trap makes even that throw.
 *
 * An exception here would escape {@link safeError}, which is called from the
 * top-level catch and the run finalizer of every stage — so a hostile or merely
 * exotic thrown value would REPLACE the failure being reported and suppress the
 * refusal entirely. Both inspections are therefore contained and the value is
 * treated as a non-error when either is untrustworthy, which is the safe
 * default: {@link NON_ERROR_NAME} says only that the thrown value was not an
 * error this module could classify, and that is exactly what an unreadable
 * value is.
 */
const isErrorLike = (value: unknown): value is Error => {
    try {
        if (value instanceof Error) {
            return true;
        }
    } catch {
        return false;
    }

    try {
        return Object.prototype.toString.call(value) === '[object Error]';
    } catch {
        return false;
    }
};

/**
 * `value instanceof ctor`, CONTAINED — for the one place it has to be: deciding
 * what a THROWN value is.
 *
 * `instanceof` is not a safe operation on an arbitrary value. It consults
 * `ctor[Symbol.hasInstance]` and walks the value's prototype chain, so a `Proxy`
 * with a `getPrototypeOf` trap makes it throw. `throw` accepts any value, so a
 * failure-classifying chain of bare `error instanceof X` checks is a chain of
 * operations that can each raise — which is why every such check in `scripts/`
 * now goes through this function.
 *
 * WHY THAT IS WORSE THAN IT SOUNDS. These chains run in `describeFailure`, which
 * every stage calls from its top-level catch and its run finalizer. An exception
 * raised WHILE classifying a failure replaces the failure being reported and
 * escapes the handler, so the stage exits with no structured account of why —
 * the single thing that handler exists to produce. `safeError` is already total
 * for the same reason; this is the other half of it, because a chain that throws
 * before reaching `safeError` never gets the chance to be described at all.
 *
 * A value this returns `false` for is reported as an unrecognised failure, which
 * is the honest answer: a value whose type cannot be determined is not known to
 * be any of the classes the chain was asking about.
 */
export const isThrownInstanceOf = <T>(
    value: unknown,
    ctor: abstract new (...args: never[]) => T,
): value is T => {
    try {
        return value instanceof ctor;
    } catch {
        return false;
    }
};

const machineCodeOf = (error: unknown): string | undefined => {
    const code = propertyOfThrown(error, 'code');

    return typeof code === 'string' && ERROR_CODE_PATTERN.test(code) ? code : undefined;
};

// An HTTP status, and only an integer in the HTTP range: a `status` holding
// anything else is a field this module does not recognise and does not print.
const statusOf = (error: unknown): number | undefined => {
    const status = propertyOfThrown(error, 'status');

    return typeof status === 'number' && Number.isInteger(status) && status >= 100 && status <= 599
        ? status
        : undefined;
};

/**
 * The sanctioned way to render a thrown value (§8), and a CLOSED one: the class
 * name, a machine `code` when the value carries one, and an HTTP `status` when
 * it carries one. Nothing else.
 *
 * WHY `message` IS NOT HERE, AND WHY REMOVING IT WAS THE FIX. Every line this
 * module writes outlives the command that wrote it — an operator's terminal, a
 * CI log, and (through checkpoint.ts's `sanitizeRunLogEntry`) the
 * `catalog_import_runs.log` JSONB column that committed reports are assembled
 * from. `SCRUB_RULES` removes credential PATTERNS, and an arbitrary
 * `Error.message` carries no pattern to remove: Prisma prints the failing
 * statement's values and the connection target, `fs` prints absolute paths,
 * `Intl`/`Date` echo the argument that was rejected, a vendor body arrives
 * verbatim, and a model-proposed name arrives as whatever the model wrote. A
 * scrubbed message is therefore a message that has been checked for the three
 * configured credentials and for nothing else, which is not the same as safe to
 * persist (CWE-532). The three fields above are values this repository owns end
 * to end, so the guarantee is a property of the TYPE rather than of each call
 * site's judgement — no caller can reach a message through this function, and
 * the compiler says so.
 *
 * WHAT REPLACES IT. The diagnosis lives in fields the caller composes: the
 * stage's own `code` (every script's `describeFailure` maps each error class to
 * one), the typed `context` its error classes carry, and the fixed remedy
 * prose written in this repository. A stage that has narrowed a value to ITS
 * OWN error class may still forward that error's message deliberately — the
 * text is this repository's, so it echoes no foreign input — by reading
 * `error.message` through `scrubSecrets` at the narrowed site, which is what
 * `scripts/seed-dev.ts` does and documents. The distinction is provenance, and
 * only the call site knows it.
 *
 * `name` survives so the typed errors this folder throws — DatabaseOriginError,
 * ManifestError, ModelBudgetError, CheckpointError — stay distinguishable in
 * the log, while the stack, the cause, the message and the object itself never
 * leave this function.
 */
export const safeError = (error: unknown): SafeErrorFields => {
    // `isErrorLike`, not `instanceof`: a core module's error reaching a Jest
    // sandbox is not an instance of that sandbox's `Error`, and the closed field
    // set makes `code` the only carrier of what an operator acts on — see the
    // reasoning there.
    if (!isErrorLike(error)) {
        // Never `String(value)`: that prints the value this function exists to
        // withhold.
        return { name: NON_ERROR_NAME };
    }

    const rawName = typeof error.name === 'string' && error.name.length > 0 ? error.name : FALLBACK_ERROR_NAME;
    const name = scrubSecrets(rawName).slice(0, MAX_ERROR_NAME_LENGTH) || FALLBACK_ERROR_NAME;
    const code = machineCodeOf(error);
    const status = statusOf(error);

    // Assembled so an absent member is ABSENT rather than `undefined`: these
    // objects are compared as key sets by the canary tests and serialised into
    // a JSONB column, and `{name, code: undefined}` reads as a code that was
    // lost rather than one that never existed.
    return {
        name,
        ...(code === undefined ? {} : { code }),
        ...(status === undefined ? {} : { status }),
    };
};

/**
 * {@link safeError} rendered as one clause, for a sentence this repository is
 * composing about a failure it did not compose.
 *
 * `formatSafeError(new Error())` is `'Error'`; an `ENOENT` from `fs` is
 * `'Error (code ENOENT)'`; a vendor failure carrying a status is
 * `'UsdaError (status 503)'`. It exists because the alternative every caller
 * reached for was `${safeError(error).message}`, and the eight sentences that
 * did so are exactly the disclosure this module now makes unreachable: they
 * kept their own actionable half ("Move or repair the file and run again") and
 * lose only the foreign prose.
 */
export const formatSafeError = (error: unknown): string => {
    const described = safeError(error);
    const qualifiers: string[] = [];

    if (described.code !== undefined) {
        qualifiers.push(`code ${described.code}`);
    }
    if (described.status !== undefined) {
        qualifiers.push(`status ${String(described.status)}`);
    }

    return qualifiers.length === 0 ? described.name : `${described.name} (${qualifiers.join(', ')})`;
};

/**
 * How much of the digest is printed. Twelve hex characters is 48 bits: enough
 * that two databases in one operator's hands do not collide, short enough that
 * the last rule in SCRUB_RULES — which redacts any opaque run of 40 or more —
 * leaves it intact.
 */
const OPAQUE_DIGEST_CHARS = 12;

/**
 * A one-way digest of a value a log line must be able to CORRELATE but not
 * DISCLOSE.
 *
 * The case this exists for is the database a run was pointed at. An operator
 * comparing two runs, or a report reader checking that a benchmark and a load
 * describe the same target, needs to know whether the two targets were the
 * same; neither needs the host or the database name, and a stage log carrying
 * them publishes an organisation's internal topology into CI output and
 * committed artefacts. The digest answers the first question and cannot answer
 * the second: it is SHA-256 truncated, so it is not reversible, and an operator
 * who wants to confirm which database a digest names computes it from their own
 * `DATABASE_URL` rather than reading it out of a log.
 *
 * Not a substitute for redaction: a caller passes the identifying values here
 * deliberately, and everything else about them stays out of the line.
 */
export const opaqueDigest = (value: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        // A digest of nothing would still be a fixed 12 characters and would
        // read as an identity, so the absence is stated instead.
        return 'none';
    }

    return crypto.createHash('sha256').update(value).digest('hex').slice(0, OPAQUE_DIGEST_CHARS);
};

// Evidence URLs are model-proposed, so they are attacker-influenced input and
// are logged at host level only; a full URL would also carry its query string,
// which is where USDA's api_key lives.
export const hostOf = (value: string): string => {
    try {
        return new URL(value).hostname.toLowerCase();
    } catch {
        return 'invalid-url';
    }
};

// Exists so a module that does read the environment can report a missing
// variable by name without being tempted to interpolate its value.
export const describeMissingEnv = (name: string): string => `${name} is not set`;

// Log fields are diagnostics, not payloads: a structure deeper than this is a
// caller mistake, and recursing it must not risk the stack during a long run.
const MAX_FIELD_DEPTH = 8;

const sanitizeValue = (value: unknown, depth: number, seen: Set<object>): unknown => {
    if (value === null) {
        return null;
    }
    if (typeof value === 'string') {
        return scrubSecrets(value);
    }
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'undefined') {
        return value;
    }
    // JSON.stringify throws on a BigInt, and Prisma returns one for some
    // columns, so it becomes its decimal string.
    if (typeof value === 'bigint') {
        return String(value);
    }
    if (typeof value === 'function' || typeof value === 'symbol') {
        return UNSERIALIZABLE;
    }
    if (value instanceof Error) {
        return safeError(value);
    }
    // Recursed as a plain object a Date has no own keys and would serialise to
    // `{}`, silently losing the timestamp.
    if (value instanceof Date) {
        const time = value.getTime();
        return Number.isFinite(time) ? value.toISOString() : UNSERIALIZABLE;
    }
    if (depth >= MAX_FIELD_DEPTH) {
        return UNSERIALIZABLE;
    }

    const container = value as object;
    // `seen` tracks the current path only — it is cleared on the way out — so a
    // node shared by two branches is kept while a true cycle is caught.
    if (seen.has(container)) {
        return UNSERIALIZABLE;
    }
    seen.add(container);
    try {
        if (Array.isArray(value)) {
            return value.map((entry): unknown => sanitizeValue(entry, depth + 1, seen));
        }
        const record = container as Record<string, unknown>;
        const output: Record<string, unknown> = {};
        for (const key of Object.keys(record)) {
            // Redaction by key name is decided on the RAW key and happens BEFORE
            // any recursion, for two reasons. A credential nested under
            // `credentials: {...}` must not be recursed into and partially
            // preserved — the whole subtree is the secret. And the key is tested
            // before scrubbing precisely because scrubbing can rewrite it: check
            // raw, write scrubbed, which is the ordering checkpoint.ts's
            // persisted path already used and the reason the two agree now.
            output[scrubSecrets(key)] = isSecretBearingKey(key)
                ? REDACTED
                : sanitizeValue(record[key], depth + 1, seen);
        }
        return output;
    } catch {
        // A throwing getter or an exotic host object is a caller problem, never
        // a reason for the run to end.
        return UNSERIALIZABLE;
    } finally {
        seen.delete(container);
    }
};

const sanitizeFields = (fields?: LogFields): Record<string, unknown> => {
    if (!fields || typeof fields !== 'object') {
        return {};
    }
    const sanitized = sanitizeValue(fields, 0, new Set<object>());
    if (sanitized === null || typeof sanitized !== 'object' || Array.isArray(sanitized)) {
        return { fields: UNSERIALIZABLE };
    }
    return sanitized as Record<string, unknown>;
};

/**
 * The recursive field sanitizer on its own, for a caller that has to make a
 * structure safe somewhere other than a log line — persisting diagnostics into
 * a JSONB column, for instance, where the same rules apply and the same
 * scrubbing has to happen before the value is stored rather than printed.
 *
 * Identical behaviour to what every log line already goes through: every string
 * value and every key scrubbed by SCRUB_RULES, every value whose key
 * `isSecretBearingKey` recognises replaced outright without being recursed into,
 * Errors normalized through `safeError`, BigInt and Date rendered,
 * functions/symbols and anything deeper than MAX_FIELD_DEPTH replaced with
 * `[unserializable]`, cycles broken, and a throwing getter contained. A
 * non-object argument yields `{}`.
 */
export const sanitizeLogFields = (fields?: LogFields): Record<string, unknown> => sanitizeFields(fields);

const timestampOf = (clock: () => Date): string => {
    try {
        return clock().toISOString();
    } catch {
        // An injected clock yielding an invalid Date must not end the run, and
        // the line still needs a `ts` to stay parseable.
        return 'invalid-timestamp';
    }
};

// The four metadata keys of every line, written by one function so the reserved
// list below cannot drift from what the serializer actually emits.
const buildMetadata = (
    level: LogLevel,
    scope: string,
    event: string,
    clock: () => Date,
): Record<string, unknown> => ({
    ts: timestampOf(clock),
    level,
    scope: scrubSecrets(scope),
    event: scrubSecrets(event),
});

/**
 * The field names this module owns. They are metadata, never caller data: `ts`,
 * `level`, `scope` and `event` are how a committed report, a CI log grep or an
 * operator identifies a line, so a caller field must not be able to set them.
 *
 * Derived from `buildMetadata` rather than written out twice. The fixed clock is
 * only a means of producing the shape at module load — nothing observes it.
 */
export const RESERVED_LOG_FIELDS: readonly string[] = Object.freeze(
    Object.keys(buildMetadata('info', '', '', (): Date => new Date(0))),
);

const RENAMED_FIELD_PREFIX = 'field_';

// A colliding caller field is renamed, not dropped: the value may be the one
// diagnostic that explains the run, and losing it silently is its own bug. The
// name is deterministic so a report consumer can find it again, and numbered
// only when the plain form is itself taken — by another caller key, or by an
// earlier rename.
const renamedFieldName = (key: string, taken: ReadonlySet<string>): string => {
    const base = `${RENAMED_FIELD_PREFIX}${key}`;
    if (!taken.has(base)) {
        return base;
    }
    // `taken` is finite, so at most `taken.size` of the numbered variants can be
    // occupied and one of the first `taken.size` is free. The bound makes that
    // termination argument explicit instead of relying on it.
    for (let suffix = 2; suffix <= taken.size + 1; suffix += 1) {
        const candidate = `${base}_${suffix}`;
        if (!taken.has(candidate)) {
            return candidate;
        }
    }
    // Unreachable by the counting argument above, and still a real, distinct
    // name rather than a thrown error on a logging path.
    return `${base}_${taken.size + 2}`;
};

// One JSON object per line: human-scannable in a terminal and machine-parseable
// for the committed reports. Metadata is written first and caller fields follow,
// so the field order is `ts`, `level`, `scope`, `event`, then the caller's — but
// order is not what protects the metadata. A caller field whose sanitized name
// collides with a RESERVED_LOG_FIELDS entry is renamed before it is copied, so
// `logger.info('started', { level: 'debug' })` records the caller's value under
// `field_level` and still reports `"level":"info"`. Without that, a field value
// — which on this pipeline can come from a model response or a vendor error
// body — could forge the identity of the line carrying it.
const serializeEntry = (
    level: LogLevel,
    scope: string,
    event: string,
    fields: LogFields | undefined,
    clock: () => Date,
): string => {
    const metadata = buildMetadata(level, scope, event, clock);
    const entry: Record<string, unknown> = { ...metadata };
    const sanitized = sanitizeFields(fields);
    const callerKeys = Object.keys(sanitized);
    // Seeded with both the reserved names and every caller key, so a rename can
    // never land on a name another caller field is about to claim.
    const taken = new Set<string>(RESERVED_LOG_FIELDS);
    for (const key of callerKeys) {
        taken.add(key);
    }

    for (const key of callerKeys) {
        if (!RESERVED_LOG_FIELDS.includes(key)) {
            entry[key] = sanitized[key];
            continue;
        }
        const renamed = renamedFieldName(key, taken);
        taken.add(renamed);
        entry[renamed] = sanitized[key];
    }

    try {
        return JSON.stringify(entry);
    } catch {
        // The caller's fields are what failed to serialise, so they are dropped
        // wholesale — but the line keeps the true metadata, because a line that
        // cannot be attributed is worse than a line without its fields.
        return JSON.stringify({ ...metadata, fields: UNSERIALIZABLE });
    }
};

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const thresholdOf = (level: LogLevel): number =>
    Object.prototype.hasOwnProperty.call(LEVEL_ORDER, level) ? LEVEL_ORDER[level] : LEVEL_ORDER.info;

// Progress on stdout, problems on stderr (§8), so a piped run separates them.
const defaultWrite = (line: string, level: LogLevel): void => {
    const stream = level === 'warn' || level === 'error' ? process.stderr : process.stdout;
    try {
        stream.write(`${line}\n`);
    } catch {
        // A closed pipe (`… | head`) must not end a multi-hour import, and a
        // failed write has nowhere left to be reported.
    }
};

export const createLogger = (
    scope: string,
    options?: { level?: LogLevel; write?: (line: string, level: LogLevel) => void; now?: () => Date },
): ScriptLogger => {
    const level: LogLevel = options && options.level ? options.level : 'info';
    const write = options && options.write ? options.write : defaultWrite;
    const now = options && options.now ? options.now : (): Date => new Date();
    const threshold = thresholdOf(level);

    const emit = (entryLevel: LogLevel, event: string, fields?: LogFields): void => {
        if (LEVEL_ORDER[entryLevel] < threshold) {
            return;
        }
        write(serializeEntry(entryLevel, scope, event, fields, now), entryLevel);
    };

    return {
        debug: (event: string, fields?: LogFields): void => emit('debug', event, fields),
        info: (event: string, fields?: LogFields): void => emit('info', event, fields),
        warn: (event: string, fields?: LogFields): void => emit('warn', event, fields),
        error: (event: string, fields?: LogFields): void => emit('error', event, fields),
        child: (childScope: string): ScriptLogger => createLogger(`${scope}:${childScope}`, { level, write, now }),
    };
};

// THE FATAL PATH.
//
// `defaultWrite` above goes through process.stderr, whose writes are buffered
// when the stream is a pipe, and `process.exit()` discards whatever is still
// buffered. Measured on this runtime: 200,001 bytes written with
// `process.stderr.write` followed immediately by `process.exit(1)` deliver
// 65,536 bytes — one pipe buffer — through a pipe, while the same bytes written
// with `fs.writeSync(2, …)` deliver all 200,001. A guard that refuses to run
// must not lose the reason it refused, so the refusal path writes to the file
// descriptor synchronously and only then exits.
const STDOUT_FD = 1;
const STDERR_FD = 2;

// A short bound on each side of the retry loop: a fatal path may stall a moment
// for a slow reader, but it must not hang the process it is trying to end. The
// worst case here is roughly one second of pausing before the line is dropped.
const FATAL_WRITE_MAX_ATTEMPTS = 1024;
const FATAL_WRITE_RETRY_PAUSE_MS = 1;

// The only synchronous sleep available to a CommonJS script without adding a
// dependency or an await point. `Atomics.wait` on a buffer no other thread can
// see parks this thread for the timeout and returns 'timed-out'. It is
// wrapped because a runtime that disables SharedArrayBuffer (or forbids
// blocking on the main thread) throws here, and an immediate retry is a correct
// — merely busier — fallback.
const pauseSynchronously = (milliseconds: number): void => {
    try {
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
    } catch {
        // Fall through to an immediate retry.
    }
};

/**
 * Writes one already-serialized line straight to a file descriptor, with the
 * same `(line, level)` shape as `createLogger`'s injectable `write`, so it can
 * be passed wherever that option is accepted.
 *
 * Problems go to fd 2 and progress to fd 1, matching `defaultWrite`. Partial
 * writes are resumed from the byte offset the kernel accepted, `EAGAIN`/`EINTR`
 * are retried after a brief synchronous pause, and every other failure —
 * `EPIPE` from `… | head`, `EBADF` from a closed descriptor, anything
 * unforeseen — is swallowed: this function runs while the process is already
 * reporting a fatal condition, and throwing on top of that would replace the
 * diagnosis with an unrelated stack trace.
 */
export const writeLineSync = (line: string, level: LogLevel): void => {
    const fd = level === 'warn' || level === 'error' ? STDERR_FD : STDOUT_FD;

    let buffer: Buffer;
    try {
        buffer = Buffer.from(`${line}\n`, 'utf8');
    } catch {
        // An unencodable line has nowhere to go and nothing left to report it.
        return;
    }

    let written = 0;
    let attempts = 0;
    while (written < buffer.length && attempts < FATAL_WRITE_MAX_ATTEMPTS) {
        attempts += 1;
        try {
            written += fs.writeSync(fd, buffer, written, buffer.length - written);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (code === 'EAGAIN' || code === 'EINTR') {
                // A full pipe with a slow reader, or a signal mid-write. Both
                // are transient, so pause and resume from the same offset.
                pauseSynchronously(FATAL_WRITE_RETRY_PAUSE_MS);
                continue;
            }
            return;
        }
    }
};

/**
 * A logger whose output is on the file descriptor before the call returns, for
 * the paths that log and then terminate the process — today the module-load
 * refusal in dbGuard.ts.
 *
 * Identical to `createLogger` in every other respect, including the field
 * sanitization and reserved-key protection above, and it honours an injected
 * `write`/`now`/`level` so a test can capture the line instead of the terminal.
 * Ordinary logging keeps the buffered stream path: it is faster, and a
 * long-running import writing thousands of progress lines synchronously would
 * pay for durability it does not need.
 */
export const createFatalLogger = (
    scope: string,
    options?: { level?: LogLevel; write?: (line: string, level: LogLevel) => void; now?: () => Date },
): ScriptLogger =>
    createLogger(scope, {
        // The same default level as createLogger, so the only difference between
        // the two factories is where the bytes go.
        level: options && options.level ? options.level : 'info',
        write: options && options.write ? options.write : writeLineSync,
        now: options && options.now ? options.now : (): Date => new Date(),
    });
