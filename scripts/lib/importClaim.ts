// A cross-host, process-lifetime claim on the shared USDA credential.
//
// WHAT THIS GUARANTEES. While a claim handle is held, at most ONE importer
// process per scope is running — across every host, container and terminal that
// can reach the same PostgreSQL server — for exactly as long as the claiming
// process lives. A second launch is refused with a typed error naming the
// scope, or (when it asks for it) queues behind the first for a bounded wait.
// The guarantee ends when the process ends, by release, by exit, by `kill -9`
// or by the machine disappearing, because it is carried by a PostgreSQL session
// and PostgreSQL ends the session with the connection.
//
// WHAT IT DOES NOT GUARANTEE. It serialises importers; it does not count
// requests. The hourly ceiling — 900 of USDA's 1,000 requests per hour per key,
// leaving 100 for the running API's estimate and branded-search traffic on the
// same `USDA_API_KEY` — remains `rateLimiter.ts`'s durable ledger, and nothing
// here replaces, reads or adjusts it. The two are complementary halves of one
// problem:
//
//   * the LEDGER closes restart-within-the-hour on one host: a second run
//     starting 10 minutes after the first died still sees what the first
//     spent, because the stamps are on disk rather than in a closure;
//   * this CLAIM closes concurrency across hosts: two importers that share no
//     filesystem cannot both be running, so their two process-local buckets
//     cannot both be handing out a fresh 900.
//
// Neither subsumes the other. The ledger cannot see another host; the claim
// cannot see another hour. Run both — the claim around the stage, the limiter
// inside it — and the only remaining residue is the one named at the end of
// this comment.
//
// WHY A SESSION-SCOPED ADVISORY LOCK ON A CONNECTION THIS MODULE OWNS.
// `checkpoint.ts` already takes an advisory lock when it opens or resumes a
// run, and its THE CLAIM comment is explicit that the lock is
// TRANSACTION-scoped: it guarantees one run row per (kind, manifest_version)
// and releases at commit, so two launches of one stage both hold a handle to
// the same run and can both work through it. That comment also names the
// remedy and rules out the two alternatives:
//
//   * a durable lease (owner id + expiry on the run row, reasserted as work
//     proceeds) needs columns `catalog_import_runs` does not have AND a
//     periodic reassertion — the background timer the Agent Action Plan
//     (§0.8.2) excludes from this feature;
//   * a session-scoped lock taken through the POOLED Prisma client cannot
//     work, because Prisma routes each statement to whichever connection is
//     free, so the lock would be held by an arbitrary connection and could
//     never be released deterministically.
//
// So the lock "belongs to the CLI entry point, which owns its own process and
// can hold it for exactly as long as it works". This module is that owner. It
// opens ONE `pg` connection, holds `pg_try_advisory_lock` on it, and hands back
// a handle whose `release()` unlocks and closes it. There is no lease, no
// expiry column, no heartbeat and no timer: the server drops the lock when the
// session goes away, which is the property a lease exists to emulate and gets
// wrong. `pg` is already a declared runtime dependency of this service (AAP
// §0.4.2 adds none), and no schema change is involved — advisory locks need no
// table.
//
// WHY `pg_try_advisory_lock` AND NOT `pg_advisory_lock`. A blocking lock gives
// an operator a silent hang: the second importer prints its banner and then
// waits, indefinitely, with no output distinguishing "queued" from "wedged". A
// try-lock refuses in one round trip with a message that says who is in the
// way, which is what a human at a terminal can act on. The caller that would
// rather queue than refuse asks for it explicitly with `waitMs`, and even then
// the wait is BOUNDED and polls — so the refusal still arrives, just later.
//
// FAIL CLOSED, ALWAYS. Every path that cannot establish the claim throws
// `ImportClaimError` rather than returning something the caller might read as
// permission: no connection string, a connection that cannot be opened, a lock
// the server granted but does not show this session holding (which is what a
// transaction-pooling proxy in front of PostgreSQL looks like — it would break
// the session-scope guarantee silently), and a connection that dies while the
// claim is held. An importer that refuses to start is restarted by an operator
// in a minute; an importer that runs unserialised spends a key the live API
// depends on and the first symptom is a user-facing feature being throttled.
//
// NO CREDENTIAL IS EVER REPORTED. `DATABASE_URL` carries the database password
// in its userinfo, so the connection string reaches `pg` and nothing else: not
// an error message, not a log field, not the handle. What is reported is the
// scope, the advisory lock key, the server HOST (`hostOf`, hostname only) and
// the backend pid — the four things an operator needs to find the other holder
// in `pg_stat_activity`, none of which is a secret.
//
// THE ONE RESIDUE LEFT. An importer that restarts on a DIFFERENT host inside
// the same hour cannot see what the previous host spent: the claim serialises
// the two so they never run together, and the file ledger is per-host, so the
// second host starts its own rolling hour from zero and the pair can exceed 900
// in one wall-clock hour. Closing that needs what `rateLimiter.ts`'s
// `UsdaRateLedger` port exists for — a shared rolling-window table in the
// database, behind the same `reserve` contract, keyed by this same scope —
// which is a schema change (`prisma/schema.prisma` has no such table) and
// therefore a proposal to the migration owner rather than something either
// module can do alone. Until it lands: one host per hour, which this claim now
// makes an operational instruction rather than an assumption.
//
// Jest's `roots` is `<rootDir>/src`, so no test file can live in this folder;
// the suite is `src/__tests__/scripts/importClaim.test.ts` and reaches this
// module by relative path. `sleep`, `now` and `logger` are injected so the
// bounded wait can be driven without real time, and the driver is required
// LAZILY inside the claim (mirroring `src/__tests__/setup/testDb.ts`), so
// importing this module loads no driver, opens no socket and reads no
// environment variable.

import { hostOf, safeError, type LogFields, type ScriptLogger } from './logger';
import { DEFAULT_USDA_RATE_LEDGER_SCOPE } from './rateLimiter';

/**
 * The environment variable the connection string comes from — the same one
 * `dbGuard.ts` classifies and Prisma connects with, read in exactly one place
 * (`getImportClaimConnectionString`).
 */
const DATABASE_URL_ENV_VAR = 'DATABASE_URL';

/**
 * The advisory-lock key's namespace.
 *
 * Advisory locks share ONE key space per database, and this repository already
 * takes them under two other namespaces (`catalog-run:…` in `checkpoint.ts`,
 * `meal-planning:<userId>` on the request path). The prefix is what keeps this
 * claim from colliding with either: `hashtext` is a 32-bit hash, so a collision
 * is possible in principle, and the prefix reduces it to a birthday problem
 * over a handful of long, structured strings. The failure direction is also the
 * safe one — a collision makes this claim REFUSE while an unrelated lock is
 * held, never grant while a real importer runs.
 */
export const IMPORT_CLAIM_LOCK_NAMESPACE = 'usda-import';

/**
 * The accounting scope every importer of the shared key must agree on.
 *
 * Imported from `rateLimiter.ts` rather than re-spelled, so the claim and the
 * hourly ledger are keyed alike by construction: the thing being protected is
 * one credential's hour against one vendor host, and two modules spelling that
 * differently would serialise one set of processes while metering another.
 */
export const DEFAULT_USDA_IMPORT_CLAIM_SCOPE = DEFAULT_USDA_RATE_LEDGER_SCOPE;

/**
 * How long a claim waits for the connection itself.
 *
 * Present because `pg` waits on the operating system's TCP timeout by default,
 * which on an unroutable host is minutes of silence — indistinguishable, at a
 * terminal, from an importer that has started working. A bounded connect turns
 * that into a typed refusal.
 */
export const DEFAULT_CLAIM_CONNECT_TIMEOUT_MS = 10_000;

/**
 * How often a bounded wait re-tries the lock. Short enough that queueing feels
 * immediate when the holder finishes, long enough that a multi-minute wait is
 * hundreds of round trips rather than millions.
 */
export const DEFAULT_CLAIM_POLL_INTERVAL_MS = 250;

/**
 * What the claim's connection calls itself in `pg_stat_activity`. An operator
 * hunting the holder of a refused claim finds it by this name plus the pid the
 * refusal is logged against.
 */
export const IMPORT_CLAIM_APPLICATION_NAME = 'usda-import-claim';

/**
 * The advisory-lock key for an accounting scope. Exported because the refusal
 * names it and an operator may want to look it up directly:
 *
 *   SELECT * FROM pg_locks WHERE locktype = 'advisory';
 */
export const usdaImportClaimLockKey = (scope: string): string => `${IMPORT_CLAIM_LOCK_NAMESPACE}:${scope}`;

/** Takes the claim without blocking. The key is BOUND, never interpolated. */
const CLAIM_LOCK_SQL = 'SELECT pg_try_advisory_lock(hashtext($1)) AS granted';

/** Releases it. Answers false when this session did not hold it. */
const RELEASE_LOCK_SQL = 'SELECT pg_advisory_unlock(hashtext($1)) AS released';

/**
 * Proves, from the server's own lock catalogue, that the session this module
 * owns is the one holding the claim — and reports that session's pid.
 *
 * Why the arithmetic. `pg_try_advisory_lock(bigint)` records its key split
 * across two `oid` columns: `classid` holds the high 32 bits, `objid` the low
 * 32, and `objsubid` is 1 for the single-key form (2 for the two-int form).
 * `hashtext` returns a signed 32-bit integer, so the key is negative for
 * roughly half of all scopes; masking with 4294967295 before the `oid` cast is
 * what makes the reconstruction correct for those — an unmasked cast of a
 * negative value is out of `oid` range and would error, and a naive
 * `(classid << 32) | objid` overflows `bigint` for an unsigned high word.
 *
 * Why verify at all. `pg_try_advisory_lock` answering true proves that SOME
 * session took the lock. It is the session-scope of that lock which carries
 * this module's entire guarantee, and that holds only if the statement ran on
 * the connection this module owns and keeps. A connection pooler in transaction
 * mode between here and PostgreSQL breaks precisely that, silently, and this
 * query is what turns the silence into a refusal: the check runs as its own
 * statement, so a pooler that moved it elsewhere reports a lock this session
 * does not hold.
 *
 * Exported so the suite can run this exact text — a wrong mask or a wrong
 * `objsubid` would make every claim refuse, and that is a failure a test must
 * catch rather than an operator.
 */
export const IMPORT_CLAIM_LOCK_HELD_SQL = `WITH claim AS (SELECT hashtext($1) AS key)
SELECT pg_backend_pid() AS backend_pid,
       EXISTS (
           SELECT 1
           FROM pg_locks held_lock, claim
           WHERE held_lock.locktype = 'advisory'
             AND held_lock.pid = pg_backend_pid()
             AND held_lock.granted
             AND held_lock.classid = ((claim.key::bigint >> 32) & 4294967295)::oid
             AND held_lock.objid = (claim.key::bigint & 4294967295)::oid
             AND held_lock.objsubid = 1
       ) AS held`;

/**
 * Why a claim could not be established, or could not be trusted once it was.
 * Every one of them is a refusal to import, never an import that proceeded
 * unserialised.
 *
 * `held_by_another_importer` is the ordinary, expected outcome of a second
 * launch and the only one an operator sees routinely: it means the mechanism
 * worked. `missing_connection_string` and the two `invalid_*` codes are the
 * caller's own inputs, refused before a socket is opened.
 * `database_unreachable` covers everything between this process and a usable
 * session — DNS, TCP, authentication, a database that does not exist, the
 * connect timeout. `claim_not_verified` is the lock the server granted but this
 * session does not hold (see `IMPORT_CLAIM_LOCK_HELD_SQL`).
 * `claim_connection_lost` is the claim that WAS held and is not any more: the
 * server has already released the lock, so whatever is still running is no
 * longer serialised and must stop.
 */
export type ImportClaimErrorCode =
    | 'missing_connection_string'
    | 'invalid_scope'
    | 'invalid_wait_window'
    | 'database_unreachable'
    | 'held_by_another_importer'
    | 'claim_not_verified'
    | 'claim_connection_lost';

/**
 * A claim that could not be established or could not be trusted. Follows
 * `RateLimitConfigError`'s template (§8) — a named class carrying what a caller
 * needs in order to report the failure without re-parsing the message.
 *
 * The scope and the lock key travel on it because they are what identifies the
 * contended resource, and an entry point mapping this to an exit code wants to
 * print them. The connection string deliberately does NOT travel on it, and
 * never appears in `message`: it carries the database password, and this
 * message reaches a terminal, a CI log and the committed pipeline reports.
 */
export class ImportClaimError extends Error {
    constructor(
        public readonly code: ImportClaimErrorCode,
        message: string,
        public readonly scope: string,
        public readonly lockKey: string,
    ) {
        super(message);
        this.name = 'ImportClaimError';
    }
}

/**
 * The claim itself.
 *
 * `isHeld` is a QUESTION, not a field: the answer changes without this process
 * doing anything, because the server releases the lock the moment the
 * connection carrying it dies. A long loop under a claim should ask (or call
 * `assertHeld`) between units of work — a claim that has quietly lapsed
 * serialises nothing.
 */
export interface UsdaImportClaim {
    /** The accounting scope this claim serialises. */
    readonly scope: string;
    /** The advisory-lock key derived from it, as reported and as lockable. */
    readonly lockKey: string;
    /** The pid of the PostgreSQL backend holding the lock, for `pg_stat_activity`. */
    readonly backendPid: number;
    /** True while the owning connection is alive and the claim has not been released. */
    isHeld(): boolean;
    /** Throws `ImportClaimError('claim_connection_lost')` unless the claim is still held. */
    assertHeld(): void;
    /**
     * Releases the lock and closes the connection. Idempotent, and safe after
     * the connection has already died — so it belongs in a `finally` and needs
     * no guard around it.
     */
    release(): Promise<void>;
}

/** What `claimUsdaImport` takes. Only `connectionString` is required. */
export interface UsdaImportClaimOptions {
    /**
     * The PostgreSQL connection string the claim opens its own connection with.
     * Required rather than defaulted, so the environment read stays visible at
     * the entry point: call `getImportClaimConnectionString()` for it.
     */
    connectionString: string;
    /**
     * The accounting scope, defaulting to `DEFAULT_USDA_IMPORT_CLAIM_SCOPE`. It
     * names the shared CREDENTIAL's importer, not this run, so every importer
     * spending the same key must pass the same scope — and it is logged, so it
     * must not be, or be derived from, the key itself.
     */
    scope?: string;
    /**
     * How long to queue behind another importer before refusing. Omitted (or 0)
     * refuses on the first attempt, which is the right default for an operator
     * at a terminal. A CI stage that would rather run late than not at all
     * passes a window here.
     */
    waitMs?: number;
    /** How often a bounded wait re-tries; defaults to `DEFAULT_CLAIM_POLL_INTERVAL_MS`. */
    pollIntervalMs?: number;
    /** Bounded connect, defaulting to `DEFAULT_CLAIM_CONNECT_TIMEOUT_MS`. */
    connectTimeoutMs?: number;
    /** Injected so a bounded wait is testable without real time. */
    sleep?: (ms: number) => Promise<void>;
    /** Injected for the same reason; supplies the deadline and the held duration. */
    now?: () => number;
    /** Structured logging, off when absent — as in the sibling modules. */
    logger?: ScriptLogger;
}

// --------------------------------------------------------------------------
// A narrow typed surface over node-postgres.
//
// `pg` is a declared runtime dependency of this service (8.16.0) but ships no
// type declarations, and @types/pg is deliberately not added for one module
// (AAP §0.4.2 adds no package). Declaring only the four calls this module makes
// keeps it type-safe under `strict` without widening the dependency set. This
// is the same pattern, for the same reason, as `src/__tests__/api/compat.test.ts`.
// --------------------------------------------------------------------------

interface PgQueryResult<TRow> {
    rows: TRow[];
}

interface PgClient {
    connect(): Promise<void>;
    query<TRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<TRow>>;
    end(): Promise<void>;
    /**
     * The connection-level error channel. `pg` emits `error` on a client whose
     * connection drops, and an emitter with no listener for it throws out of
     * the event loop — so this module registers one before it connects, both to
     * learn that the claim has lapsed and so that a dropped connection cannot
     * crash a long import from outside any `try`.
     */
    on(event: 'error', listener: (error: Error) => void): void;
}

interface PgClientConfig {
    connectionString: string;
    application_name: string;
    connectionTimeoutMillis: number;
}

interface PgModule {
    Client: new (config: PgClientConfig) => PgClient;
}

/**
 * Loads the driver on first use.
 *
 * `require` inside a function, not a top-level `import`: TypeScript's CommonJS
 * emit hoists every `import` above the module body, and this module promises
 * that importing it has no side effect — the suites that exercise the pure
 * accessor and the lock-key helper must not pull a database driver into the
 * module graph to do it.
 */
const requirePg = (): PgModule => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- pg ships no types; see the comment above
    return require('pg') as PgModule;
};

/**
 * `pg`'s failures carry a machine-readable `code` — `ECONNREFUSED`, `ETIMEDOUT`,
 * `28P01` (bad password), `3D000` (no such database). The code is reported and
 * the driver's own message is NOT: a message can echo the connection string it
 * was handed, and that string carries the password.
 */
const errorCodeOf = (error: unknown): string | null => {
    if (typeof error === 'object' && error !== null && 'code' in error) {
        const code = (error as { code?: unknown }).code;
        if (typeof code === 'string' && code.length > 0) {
            return code;
        }
    }
    return null;
};

/** Deliberately not `unref()`'d — a queued claim has to keep its process alive. */
const defaultSleep = (ms: number): Promise<void> =>
    new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
    });

/**
 * Resolves the connection string the claim is taken on — the ONLY place this
 * module reads the environment.
 *
 * It fails loudly, exactly as `getUsdaImportRateLimitPerHour` does and for the
 * sharper version of the same reason: there is no safe default for "which
 * database serialises the importers". Defaulting to a local socket would hand
 * each host a private lock space and every importer its own claim, which is
 * indistinguishable from success and is precisely the unserialised run this
 * module exists to prevent.
 *
 * The value is returned VERBATIM — not trimmed, not normalised. It is a
 * credential-bearing string destined for `pg` and nothing else, and rewriting
 * it here would mean a claim taken against a target the operator did not type.
 */
export const getImportClaimConnectionString = (env: NodeJS.ProcessEnv = process.env): string => {
    const raw = env[DATABASE_URL_ENV_VAR];

    if (raw === undefined || raw.trim().length === 0) {
        throw new ImportClaimError(
            'missing_connection_string',
            `${DATABASE_URL_ENV_VAR} is not set, so the USDA import claim has no database to serialise ` +
                'importers through. Refusing to import unserialised.',
            DEFAULT_USDA_IMPORT_CLAIM_SCOPE,
            usdaImportClaimLockKey(DEFAULT_USDA_IMPORT_CLAIM_SCOPE),
        );
    }

    return raw;
};

/**
 * The scope, validated — and validated against the form `rateLimiter.ts` keys
 * its hourly ledger by, which is the trimmed, lower-cased string
 * (`normalizeLedgerScope` there).
 *
 * Accepting ONLY that form is what keeps one credential to one name. The
 * alternative is worse in both directions: a scope this module repaired
 * differently from the ledger would serialise one set of processes while
 * metering another, and a scope it accepted verbatim in two spellings
 * (`API.NAL.USDA.GOV` and `api.nal.usda.gov`) would hand out two locks for one
 * credential — two locks being no lock at all. It is not repaired silently
 * either, because the scope lives in whatever configuration every importer of
 * that credential reads: the refusal names the form to use, so the mistake is
 * fixed once at the source rather than guessed at by each reader.
 */
const resolveScope = (scope: string | undefined): string => {
    const resolved = scope === undefined ? DEFAULT_USDA_IMPORT_CLAIM_SCOPE : scope;

    if (resolved.trim().length === 0) {
        throw new ImportClaimError(
            'invalid_scope',
            'The USDA import claim scope must not be blank: it is the name every importer of one credential ' +
                'has to agree on, and a blank one would pool unrelated keys under a single claim.',
            resolved,
            usdaImportClaimLockKey(resolved),
        );
    }

    const normalized = resolved.trim().toLowerCase();

    if (resolved !== normalized) {
        throw new ImportClaimError(
            'invalid_scope',
            'The USDA import claim scope must be spelled exactly as the hourly ledger keys it — ' +
                `"${normalized}", with no surrounding whitespace and in lower case. Passed as given, this ` +
                'claim and that ledger would key the same credential under two different names.',
            resolved,
            usdaImportClaimLockKey(resolved),
        );
    }

    return resolved;
};

/** A wait window, validated: a finite, non-negative number of milliseconds. */
const resolveWaitMs = (waitMs: number | undefined, scope: string, lockKey: string): number => {
    if (waitMs === undefined) {
        return 0;
    }

    if (!Number.isFinite(waitMs) || waitMs < 0) {
        throw new ImportClaimError(
            'invalid_wait_window',
            'The USDA import claim wait window must be a finite number of milliseconds at or above zero ' +
                `(got ${Number.isFinite(waitMs) ? `${waitMs}` : 'a non-finite value'}).`,
            scope,
            lockKey,
        );
    }

    return waitMs;
};

/** A poll interval, validated the same way, and floored at 1ms so it cannot spin. */
const resolvePollIntervalMs = (pollIntervalMs: number | undefined, scope: string, lockKey: string): number => {
    if (pollIntervalMs === undefined) {
        return DEFAULT_CLAIM_POLL_INTERVAL_MS;
    }

    if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1) {
        throw new ImportClaimError(
            'invalid_wait_window',
            'The USDA import claim poll interval must be a finite number of milliseconds at or above one ' +
                `(got ${Number.isFinite(pollIntervalMs) ? `${pollIntervalMs}` : 'a non-finite value'}).`,
            scope,
            lockKey,
        );
    }

    return pollIntervalMs;
};

/** A connect timeout, validated the same way. */
const resolveConnectTimeoutMs = (connectTimeoutMs: number | undefined, scope: string, lockKey: string): number => {
    if (connectTimeoutMs === undefined) {
        return DEFAULT_CLAIM_CONNECT_TIMEOUT_MS;
    }

    if (!Number.isFinite(connectTimeoutMs) || connectTimeoutMs < 1) {
        throw new ImportClaimError(
            'invalid_wait_window',
            'The USDA import claim connect timeout must be a finite number of milliseconds at or above one ' +
                `(got ${Number.isFinite(connectTimeoutMs) ? `${connectTimeoutMs}` : 'a non-finite value'}).`,
            scope,
            lockKey,
        );
    }

    return connectTimeoutMs;
};

/**
 * Claims the importer's right to spend the shared USDA credential, or throws.
 *
 * The sequence, and why it is this order:
 *
 *   1. validate the caller's own inputs, before a socket exists;
 *   2. register the connection-error listener, BEFORE connecting, so a failure
 *      during the connect cannot reach the event loop unhandled;
 *   3. connect, with a bounded timeout — an unreachable database is a refusal,
 *      never a wait of unknown length;
 *   4. `pg_try_advisory_lock`, once, and then on a polling schedule until the
 *      deadline when `waitMs` asks for it;
 *   5. verify, from `pg_locks`, that THIS session holds what was granted, and
 *      that the connection has not dropped in the meantime;
 *   6. only then report success.
 *
 * Every failure path closes the connection it opened, so a refused claim leaks
 * neither a socket nor a lock.
 */
export const claimUsdaImport = async (options: UsdaImportClaimOptions): Promise<UsdaImportClaim> => {
    const scope = resolveScope(options.scope);
    const lockKey = usdaImportClaimLockKey(scope);
    const waitMs = resolveWaitMs(options.waitMs, scope, lockKey);
    const pollIntervalMs = resolvePollIntervalMs(options.pollIntervalMs, scope, lockKey);
    const connectTimeoutMs = resolveConnectTimeoutMs(options.connectTimeoutMs, scope, lockKey);
    const sleep = options.sleep ?? defaultSleep;
    const now = options.now ?? Date.now;
    const logger = options.logger;

    if (options.connectionString.trim().length === 0) {
        throw new ImportClaimError(
            'missing_connection_string',
            'The USDA import claim was given a blank connection string, so it has no database to serialise ' +
                'importers through. Refusing to import unserialised.',
            scope,
            lockKey,
        );
    }

    // Hostname only, and derived once. It is the one piece of the connection
    // string that is safe to report, and every message and log line below uses
    // this instead of the string itself.
    const host = hostOf(options.connectionString);

    // `scope` is reserved by the logger for its own metadata (see
    // RESERVED_LOG_FIELDS), so the field is `claimScope` — the same rename
    // rateLimiter.ts makes for `ledgerScope`.
    const fields = (extra?: LogFields): LogFields => ({ claimScope: scope, lockKey, host, ...extra });

    const pg = requirePg();
    const client = new pg.Client({
        connectionString: options.connectionString,
        application_name: IMPORT_CLAIM_APPLICATION_NAME,
        connectionTimeoutMillis: connectTimeoutMs,
    });

    let connectionLost = false;

    client.on('error', (error: Error) => {
        connectionLost = true;
        // WARN and not ERROR: by itself this is information, and it is
        // `assertHeld`/`withUsdaImportClaim` that turn it into the failure of
        // the work it was protecting. Logged here so the moment it happened is
        // on the record even if the claim was idle at the time.
        logger?.warn('usda_import_claim_connection_lost', fields({ error: safeError(error) }));
    });

    /** Closes the connection on a path that will not return a handle. */
    const discardConnection = async (): Promise<void> => {
        try {
            await client.end();
        } catch (error) {
            // A connection that will not close cleanly says nothing the caller
            // can act on, and the refusal it is being discarded for is the
            // outcome that must reach them. It is recorded rather than dropped.
            logger?.debug('usda_import_claim_connection_discard_failed', fields({ error: safeError(error) }));
        }
    };

    try {
        await client.connect();
    } catch (error) {
        await discardConnection();

        throw new ImportClaimError(
            'database_unreachable',
            `The USDA import claim could not open its own connection to the database on host "${host}" ` +
                `(${errorCodeOf(error) ?? 'unknown error'}), so it cannot serialise this importer against ` +
                'others. Refusing to import unserialised.',
            scope,
            lockKey,
        );
    }

    /** One non-blocking attempt. A driver failure here is an unreachable database. */
    const tryTakeLock = async (): Promise<boolean> => {
        try {
            const result = await client.query<{ granted: boolean }>(CLAIM_LOCK_SQL, [lockKey]);
            return result.rows.length > 0 && result.rows[0].granted === true;
        } catch (error) {
            await discardConnection();

            throw new ImportClaimError(
                'database_unreachable',
                `The USDA import claim could not be taken on the database at host "${host}" ` +
                    `(${errorCodeOf(error) ?? 'unknown error'}). Refusing to import unserialised.`,
                scope,
                lockKey,
            );
        }
    };

    const startedAtMs = now();
    const deadlineMs = startedAtMs + waitMs;
    let granted = await tryTakeLock();
    let waited = false;

    // The wait ends at the deadline, and the loop is ALSO bounded by the number
    // of sleeps that window can hold: each is at most `pollIntervalMs` long, so
    // `ceil(waitMs / pollIntervalMs)` of them exhaust it. Under a real clock the
    // deadline check below is what ends the wait and the bound is never the
    // binding constraint; the bound is what makes termination independent of the
    // clock, since an injected `now` that does not advance would otherwise spin
    // here for ever. `waitMs` of 0 yields 0 sleeps — exactly one attempt.
    const maxSleeps = Math.ceil(waitMs / pollIntervalMs);

    for (let sleeps = 0; !granted && sleeps < maxSleeps; sleeps += 1) {
        const remainingMs = deadlineMs - now();

        if (remainingMs <= 0) {
            break;
        }

        if (!waited) {
            waited = true;
            logger?.info('usda_import_claim_waiting', fields({ waitMs }));
        }

        // Clamped to the deadline so a long poll interval cannot overshoot a
        // short window — the caller asked for a bound, not for a bound rounded
        // up to the next poll.
        await sleep(Math.min(pollIntervalMs, remainingMs));
        granted = await tryTakeLock();
    }

    if (!granted) {
        await discardConnection();

        throw new ImportClaimError(
            'held_by_another_importer',
            `Another importer holds the USDA import claim for scope "${scope}" (advisory lock ` +
                `"${lockKey}") on the database at host "${host}"` +
                `${waitMs > 0 ? `, and still held it after waiting ${waitMs}ms` : ''}. ` +
                'One importer at a time may spend the shared USDA credential: wait for it to finish, or stop ' +
                'it, before starting another.',
            scope,
            lockKey,
        );
    }

    // The lock is granted. Everything below decides whether it can be BELIEVED.
    let backendPid: number;

    try {
        const verified = await client.query<{ backend_pid: number; held: boolean }>(IMPORT_CLAIM_LOCK_HELD_SQL, [
            lockKey,
        ]);
        const row = verified.rows.length > 0 ? verified.rows[0] : null;

        if (row === null || row.held !== true) {
            throw new ImportClaimError(
                'claim_not_verified',
                `The database at host "${host}" reported the USDA import claim for scope "${scope}" as ` +
                    'granted, but the session this claim owns does not hold it. A connection pooler in ' +
                    'transaction mode between this process and PostgreSQL would do that, and it would leave ' +
                    'the claim unable to serialise anything. Refusing to import unserialised.',
                scope,
                lockKey,
            );
        }

        backendPid = row.backend_pid;
    } catch (error) {
        await discardConnection();

        if (error instanceof ImportClaimError) {
            throw error;
        }

        throw new ImportClaimError(
            'database_unreachable',
            `The USDA import claim could not be verified on the database at host "${host}" ` +
                `(${errorCodeOf(error) ?? 'unknown error'}). Refusing to import unserialised.`,
            scope,
            lockKey,
        );
    }

    // The verification round trip above also proves the connection was alive a
    // moment ago; this catches a drop reported by the error channel while it was
    // in flight. Anything that gets past both is a drop during the work, which
    // `isHeld`/`assertHeld` report.
    if (connectionLost) {
        await discardConnection();

        throw new ImportClaimError(
            'claim_connection_lost',
            `The USDA import claim for scope "${scope}" lost the connection carrying it before it could be ` +
                'used, so PostgreSQL has already released the lock. Refusing to import unserialised.',
            scope,
            lockKey,
        );
    }

    const grantedAtMs = now();
    let released = false;

    logger?.info('usda_import_claim_granted', fields({ backendPid, waitedMs: grantedAtMs - startedAtMs }));

    const isHeld = (): boolean => !released && !connectionLost;

    const claim: UsdaImportClaim = {
        scope,
        lockKey,
        backendPid,
        isHeld,
        assertHeld: (): void => {
            if (isHeld()) {
                return;
            }

            throw new ImportClaimError(
                'claim_connection_lost',
                released
                    ? `The USDA import claim for scope "${scope}" has been released, so the work it was ` +
                      'serialising is no longer protected.'
                    : `The USDA import claim for scope "${scope}" lost the connection carrying it, so ` +
                      'PostgreSQL has released the lock and a second importer can now start. Stop this ' +
                      'import rather than continuing unserialised.',
                scope,
                lockKey,
            );
        },
        release: async (): Promise<void> => {
            if (released) {
                return;
            }

            // Set before the awaits, so a second call during the first one is
            // still a no-op rather than a second unlock.
            released = true;

            if (!connectionLost) {
                try {
                    await client.query(RELEASE_LOCK_SQL, [lockKey]);
                } catch (error) {
                    // The unlock is a courtesy, not the guarantee: ending the
                    // connection below releases the lock, and so does the
                    // process dying. Recorded at debug because there is nothing
                    // for a caller to do about it and the release must not
                    // throw out of a `finally`.
                    logger?.debug('usda_import_claim_unlock_failed', fields({ error: safeError(error) }));
                }
            }

            await discardConnection();

            logger?.info('usda_import_claim_released', fields({ backendPid, heldMs: now() - grantedAtMs }));
        },
    };

    return claim;
};

/**
 * Runs `work` under the claim and releases it afterwards, whether the work
 * resolved or threw. This is what a CLI entry point calls.
 *
 * The work's own error propagates UNCHANGED — an importer failure must not be
 * reshaped into a claim failure, or an operator would go looking for a lock
 * when the real fault was in the import. The one error this helper adds is the
 * claim having lapsed during otherwise successful work: the run was not
 * serialised for its whole length, so it is reported as a failure rather than
 * returned as a result.
 *
 * `scripts/catalog-import-usda.ts` wires it into `main` like this — around the
 * whole stage, so the claim covers every USDA request the run makes, and
 * INSIDE the same process that owns the connection:
 *
 * ```ts
 * import { ImportClaimError, getImportClaimConnectionString, withUsdaImportClaim } from './lib/importClaim';
 *
 * const main = async (): Promise<number> => {
 *     // …argument parsing, dbGuard, preflight…
 *     try {
 *         return await withUsdaImportClaim(
 *             { connectionString: getImportClaimConnectionString(), logger },
 *             async (claim) => {
 *                 logger.info('import_claim_held', {
 *                     stage: STAGE,
 *                     claimScope: claim.scope,
 *                     backendPid: claim.backendPid,
 *                 });
 *
 *                 return await runImportStage(parsed.options, claim);
 *             },
 *         );
 *     } catch (error) {
 *         if (error instanceof ImportClaimError) {
 *             logger.error('import_claim_refused', {
 *                 stage: STAGE,
 *                 code: error.code,
 *                 claimScope: error.scope,
 *                 lockKey: error.lockKey,
 *             });
 *             return 1;
 *         }
 *         throw error;
 *     }
 * };
 * ```
 *
 * `describeFailure` in that file gains one branch — `error instanceof
 * ImportClaimError` mapping to `error.code` — so the fatal path reports a
 * refused claim as itself rather than as `unexpected_error`.
 */
export const withUsdaImportClaim = async <TResult>(
    options: UsdaImportClaimOptions,
    work: (claim: UsdaImportClaim) => Promise<TResult>,
): Promise<TResult> => {
    const claim = await claimUsdaImport(options);

    try {
        const result = await work(claim);

        // After the work, not before: the question is whether the claim held for
        // the WHOLE of it. A lapse mid-run means some of those USDA requests went
        // out unserialised, which is exactly the condition this module exists to
        // make loud.
        claim.assertHeld();

        return result;
    } finally {
        await claim.release();
    }
};
