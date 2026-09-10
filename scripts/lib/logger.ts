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
// The module imports nothing and reads no environment variable. It formats and
// redacts, and decides nothing about the pipeline (§1.1); the log level is an
// injected option rather than a new env key (§1.6/§9); and `write`/`now` are
// injected so the pure rules below are unit-testable from `src/__tests__`
// (§11 — Jest's `roots` is `<rootDir>/src`, so no test file can live here).

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
    { pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s@]+@/gi, replacement: `$1${REDACTED}@` },
    { pattern: /bearer\s+[^\s"',;)\]}]+/gi, replacement: `Bearer ${REDACTED}` },
    // The parameter name is kept (it is useful in a log) and only its value is
    // lost. Longest alternatives come first so `access_token` is not split by
    // `token`, and the `\b` branch keeps `pageSize=20` and `monkey=1` intact.
    {
        pattern: /([?&;]|\b)(access_token|api_key|apikey|password|signature|secret|token|auth|key)=[^&\s#"']*/gi,
        replacement: `$1$2=${REDACTED}`,
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
            output[scrubSecrets(key)] = sanitizeValue(record[key], depth + 1, seen);
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

const timestampOf = (clock: () => Date): string => {
    try {
        return clock().toISOString();
    } catch {
        // An injected clock yielding an invalid Date must not end the run, and
        // the line still needs a `ts` to stay parseable.
        return 'invalid-timestamp';
    }
};

// One JSON object per line: human-scannable in a terminal and machine-parseable
// for the committed reports. `ts`, `level`, `scope` and `event` are written
// first and are therefore reserved field names — caller fields are spread last.
const serializeEntry = (
    level: LogLevel,
    scope: string,
    event: string,
    fields: LogFields | undefined,
    clock: () => Date,
): string => {
    const entry: Record<string, unknown> = {
        ts: timestampOf(clock),
        level,
        scope: scrubSecrets(scope),
        event: scrubSecrets(event),
    };
    const sanitized = sanitizeFields(fields);
    for (const key of Object.keys(sanitized)) {
        entry[key] = sanitized[key];
    }
    try {
        return JSON.stringify(entry);
    } catch {
        return JSON.stringify({
            ts: entry.ts,
            level,
            scope: entry.scope,
            event: entry.event,
            fields: UNSERIALIZABLE,
        });
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
