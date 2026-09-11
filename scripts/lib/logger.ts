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
// The module imports one Node builtin — `fs`, for the synchronous fatal write
// path at the bottom of the file, which is the only way a refusal can be
// guaranteed to reach fd 2 before `process.exit()` — and nothing else. It reads
// no environment variable and has no import-time side effect. It formats and
// redacts, and decides nothing about the pipeline (§1.1); the log level is an
// injected option rather than a new env key (§1.6/§9); and `write`/`now` are
// injected so the pure rules below are unit-testable from `src/__tests__`
// (§11 — Jest's `roots` is `<rootDir>/src`, so no test file can live here).

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
// private key is reduced to its markers plus a redacted body). And every
// replacement is a fixed point of its own pattern, which is what makes
// `scrubSecrets` idempotent — callers legitimately pass strings that have
// already been scrubbed once.
//
// One consequence worth knowing: the last rule redacts any long opaque run, so
// it also hides a full SHA-256 digest. A caller that needs to show a checksum
// logs a short prefix (12 characters is well under the threshold) instead of
// widening the pattern.
const SCRUB_RULES: Array<{ pattern: RegExp; replacement: string }> = [
    { pattern: /-----BEGIN[\s\S]*?-----END[^-\n]*-----/g, replacement: REDACTED },
    // The scheme body is BOUNDED, and that bound is a security property rather
    // than a tidiness choice. Written `*`, this pattern rescans to the end of
    // the string from every offset inside a long run of scheme-legal characters
    // looking for a `://` that never arrives: measured here, a 200,000-character
    // run of `A-KEY-` took 19,758 ms and one of `A-KEY` 23,420 ms, so a vendor
    // error body — caller-supplied input this module is expected to survive —
    // could stall the pipeline inside its own logger. The longest registered URI
    // scheme is about 20 characters, so 40 leaves room for an unregistered one
    // and still measures 34 ms on the same input with `postgresql://user:pass@`
    // and a 300-character URL password both still redacted. Do not unbound it.
    { pattern: /([a-z][a-z0-9+.-]{0,40}:\/\/)[^/\s@]+@/gi, replacement: `$1${REDACTED}@` },
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
    // rule above is. A lead-in written as the prefix loop `(?:[A-Za-z0-9]+[_-])*`
    // measured 20,541 ms on `'api_key_'.repeat(25000)`, and relaxing the
    // trailing-segment loop to `{0,32}` measured 19,900 ms; the forms below stay
    // in single-digit milliseconds on those inputs. The trailing loop is what
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
    return SCRUB_RULES.reduce((scrubbed, rule) => scrubbed.replace(rule.pattern, rule.replacement), value);
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

// The sanctioned way to render a thrown value (§8). `name` survives so the
// typed errors this folder throws — DatabaseOriginError, ManifestError,
// ModelBudgetError, CheckpointError — stay distinguishable in the log, while
// the stack, the cause and the object itself never leave this function.
export const safeError = (error: unknown): { name: string; message: string } => {
    if (error instanceof Error) {
        const name = typeof error.name === 'string' && error.name.length > 0 ? error.name : 'Error';
        const message = typeof error.message === 'string' ? error.message : '';
        return { name: scrubSecrets(name), message: scrubSecrets(message) };
    }
    return { name: 'UnknownError', message: 'Unknown error' };
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
