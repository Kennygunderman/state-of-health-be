// The guarded wrapper for the two Prisma schema commands that RESET the
// database they are given.
//
// WHY THIS FILE EXISTS. The schema-drift evidence in
// docs/meal-planning/expected-schema-diff.sql is produced by `prisma migrate
// diff --from-migrations`, and a new migration is authored with `prisma migrate
// dev --create-only` (Agent Action Plan 0.5.1, 0.9.1). Both were published as
// RAW command lines carrying `--shadow-database-url "$SHADOW_DATABASE_URL"`,
// with nothing between an inherited, mistyped or stale value and a database
// Prisma empties. Measured against prisma 6.9.0 on PostgreSQL 16.15: a shadow
// database carrying an operator's own table came back with that table DROPPED
// and the command still exited 2, reporting success. A destructive command
// whose target is an environment variable needs a guard that runs BEFORE it,
// and that guard is this file.
//
// WHAT IT GUARANTEES, in this order, with nothing skipped:
//
//   1. The URL is classified by scripts/lib/dbGuard.ts — `assertShadowDatabase`
//      for the diff, `evaluateScriptDatabase` under the `development_only`
//      policy for the authoring command (see MODES below). A refusal ends the
//      run with NO connection opened and NO Prisma process spawned.
//   2. The target is READ BACK over a real connection, and the database and
//      schema actually reached must be the ones the URL names. A guard that
//      only parses a string cannot see a role whose `search_path` was altered
//      server-side, or a connector that resolved a different database than the
//      URL displays.
//   3. For the database the command RESETS, the read-back additionally
//      certifies that NO ORDINARY OR PARTITIONED BASE TABLE IN THE REACHED
//      `public` SCHEMA HOLDS A ROW. That is an occupancy statement about the
//      tables of that one schema, not a guarantee that the database is empty:
//      the enumeration is `pg_class.relkind IN ('r', 'p')` with partitions
//      covered through their parents, scoped to the schema check 2 has already
//      pinned to `public`, so a row sitting in another schema of the same
//      database is outside what this check can see. It is the executable form
//      of the shadow contract (0.4.4: "Nothing of value may live here"), and
//      the check that turns the measured accident above into a refusal.
//      Measured: both commands leave the replayed schema behind with every
//      table EMPTY and no `_prisma_migrations` row, so a legitimate second run
//      passes this check, while an application database reached under a
//      `_shadow` name — which carries at least its own migration ledger — does
//      not.
//
//      IT FAILS CLOSED AGAINST ROW-LEVEL SECURITY, which is the one way an
//      occupied table can answer "empty". Measured on PostgreSQL 16.15: a
//      `NOSUPERUSER NOBYPASSRLS` role owning `public.operator_rows`, one row in
//      it, `ENABLE` plus `FORCE ROW LEVEL SECURITY` and a `USING (false)`
//      policy — `EXISTS (SELECT 1 FROM "public"."operator_rows")` answered
//      FALSE, and the relation and its hidden row were dropped by the replay.
//      An owner can drop what a policy hides from it, so the certification now
//      runs with `row_security = off`, treats any error raised while asking the
//      occupancy question as a refusal rather than as "empty", and refuses a
//      relation carrying `relrowsecurity` or `relforcerowsecurity` outright.
//   4. Only then is Prisma spawned, with the argument list fixed here rather
//      than typed by an operator.
//
// MODES, and which variable each one's destructive surface actually is.
// Measured, because the two commands do not agree and the difference decides
// what may be guarded:
//
//   `diff`         `prisma migrate diff --from-migrations prisma/migrations
//                  --to-schema-datamodel prisma/schema.prisma
//                  --shadow-database-url <validated> --exit-code --script`.
//                  The reset target is SHADOW_DATABASE_URL, passed on the
//                  command line, so it is classified and read back here. This
//                  mode needs no DATABASE_URL at all — measured: it exits 2
//                  under `env -u DATABASE_URL` — so DATABASE_URL is DELETED
//                  from the child environment, which removes the whole class of
//                  accident where a deployment DATABASE_URL is sitting in the
//                  operator's shell.
//
//   `create-only`  `prisma migrate dev --create-only --name <name>`. This
//                  command has NO `--shadow-database-url` flag (measured
//                  against prisma 6.9.0: `migrate dev --help` lists only
//                  `--config`, `--schema`, `--name`, `--create-only`,
//                  `--skip-generate` and `--skip-seed`) and prisma/schema.prisma
//                  declares no `shadowDatabaseUrl` datasource field, so it does
//                  NOT consume SHADOW_DATABASE_URL — measured: it exited 0 with
//                  that variable pointing at an unreachable host. What it
//                  actually does is create, replay and drop a TEMPORARY shadow
//                  database on the DATABASE_URL server, and reset the
//                  DATABASE_URL database itself if it finds drift. So the
//                  surface to guard in this mode is DATABASE_URL, and it is
//                  held to the strictest policy the guard has — a database
//                  whose own NAME says development, on a local host. Validating
//                  SHADOW_DATABASE_URL here instead would be a guard on a value
//                  the command ignores.
//
// EXIT CODES, AS THIS WRAPPER ACTUALLY EXITS. Prisma's own verdicts are passed
// through UNCHANGED — 0.9.1's gate, the header of
// docs/meal-planning/expected-schema-diff.sql and the CI step all decide on
// them and a second vocabulary would make one of the three wrong — and 3 is
// this wrapper's own code, which none of Prisma's paths produce:
//
//   2   Prisma ran and found differences — the EXPECTED result of the diff, and
//       what the committed evidence records.
//   0   Prisma ran and found none: the datamodel and the ledger agree, so the
//       committed capture is stale or the construct it stands for is gone from
//       the migration. (`create-only` reports success with this code.)
//   1   PRISMA ITSELF FAILED, AFTER a read-back that had already succeeded. The
//       residual cause is P3006, a migration that does not replay cleanly onto
//       the shadow database; the other case is the target changing between the
//       read-back and the run. A NON-EMPTY shadow database is not among them —
//       raw, that case exits 2 and destroys the content, which is why check 3
//       above exists.
//   3   THIS WRAPPER STOPPED THE RUN, and no Prisma verdict was produced. Every
//       refusal exits here: a URL dbGuard refused, a read-back that could not
//       connect, authenticate or find the database — measured: P1001, P1003 and
//       P1000 are the RAW command's exit 1 and are this wrapper's 3, because the
//       `pg` read-back reaches them first and Prisma is never invoked — a
//       database or schema that was not the one the URL names, the occupancy or
//       row-security refusal, or a Prisma CLI that could not be started.
//
// WHETHER A CONNECTION WAS OPENED is not uniform across those refusals, and the
// difference matters to an operator reading a log. The STRING-LEVEL refusals —
// a missing, unparsable, target-changing or percent-encoded URL, or one that is
// not a shadow origin — happen in dbGuard before anything is opened. The
// read-back refusals, the occupancy and row-security refusals and
// `prisma_unavailable` all happen after a connection was opened (and closed
// again). What holds for all of them is the sentence above: no Prisma verdict
// was produced.
//
// WHY THE SQL IS ON fd 1 AND EVERY WORD OF OURS IS ON fd 2. The diff's output
// is compared BYTE FOR BYTE against a committed file, so the child's stdout is
// inherited untouched and this wrapper's own structured log goes to the error
// descriptor. `schema-diff.ts diff > capture.sql` therefore produces exactly
// what the raw command produced.
//
// THE IMPORT ORDERING IS LOAD-BEARING. `./lib/bootstrap` is the literal first
// statement (AAP 0.7.1, Rule backend-architecture §10): IPv4-first DNS ordering
// before any network module, then dotenv. `./lib/dbGuard` is imported for its
// exported rules, and this entry point is deliberately ABSENT from that
// module's SCRIPT_DATABASE_POLICIES, so its module-load DATABASE_URL
// enforcement is a no-op here. That absence is correct rather than an
// oversight: the diff addresses no DATABASE_URL at all, and refusing this
// command for the value of a variable it deletes would make the evidence gate
// depend on an unrelated line of someone's `.env`.
import './lib/bootstrap';

import { spawn } from 'child_process';
import path from 'path';

import {
    DEFAULT_SCHEMA,
    DEVELOPMENT_DATABASE_SUFFIX,
    DatabaseOriginError,
    LOCAL_HOSTS,
    SHADOW_DATABASE_SUFFIX,
    SHADOW_DATABASE_URL_ENV,
    assertShadowDatabase,
    classifyDatabaseOrigin,
    evaluateScriptDatabase,
    parseConfirmTarget,
    parseDatabaseUrl,
} from './lib/dbGuard';
import type { DatabaseOrigin } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogLevel, ScriptLogger } from './lib/logger';

const STAGE = 'schema-diff';

const DATABASE_URL_ENV = 'DATABASE_URL';

/** The two modes, spelled exactly as they are typed on the command line. */
export const SCHEMA_DIFF_MODES = ['diff', 'create-only'] as const;

export type SchemaDiffMode = (typeof SCHEMA_DIFF_MODES)[number];

/**
 * The exit code for "this wrapper stopped the run". Deliberately neither 0, 1
 * nor 2: those three are Prisma's own verdicts and 0.9.1's gate decides on
 * them, so a refusal must not be able to impersonate one.
 */
export const SCHEMA_DIFF_REFUSED_EXIT_CODE = 3;

/** Prisma's `--exit-code` verdict for "the two sources differ". */
export const PRISMA_DIFFERENCES_EXIT_CODE = 2;

/** The relative paths the diff compares, fixed here so no operator types them. */
const MIGRATIONS_DIRECTORY = 'prisma/migrations';
const SCHEMA_DATAMODEL = 'prisma/schema.prisma';

/** The CLI this wrapper spawns, resolved from the installed package. */
const PRISMA_CLI_MODULE = 'prisma/build/index.js';

/**
 * Names the read-back session in `pg_stat_activity`, so an operator who sees a
 * connection arrive moments before a schema command can attribute it.
 */
const READBACK_APPLICATION_NAME = 'soh-schema-diff-readback';

/**
 * The read-back is a handful of short statements — the row-security setting, the
 * identity row, the relation list and one bounded `EXISTS` union per batch — so
 * anything slower than this is a database in trouble rather than a big one.
 */
const READBACK_CONNECT_TIMEOUT_MS = 10_000;
const READBACK_QUERY_TIMEOUT_MS = 30_000;

/**
 * How many tables one occupancy statement covers. The check is one
 * `EXISTS (SELECT 1 FROM …)` per table, unioned, so it stops at the first row
 * of each — but a single statement naming thousands of relations is a statement
 * nobody can read in a log, so it is issued in bounded batches.
 */
const OCCUPANCY_BATCH_SIZE = 64;

/** How many relations a refusal names before it summarises the rest. */
const OCCUPANCY_REPORT_LIMIT = 10;

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

const MIGRATION_NAME_FLAG = '--name';

/**
 * dbGuard's own flag. It is accepted and skipped rather than rejected, for the
 * same reason the pipeline stages skip it: an operator who types it out of
 * habit should not be stopped by the argument parser. It opens nothing here —
 * neither mode's policy has a confirmation door.
 */
const CONFIRM_TARGET_FLAG = '--confirm-target';

// ---------------------------------------------------------------------------
// Errors (Rule backend-architecture §8) — thrown from anywhere, mapped once, at
// main(), to an exit code. dbGuard's own DatabaseOriginError travels beside
// this one and is reported the same way.
// ---------------------------------------------------------------------------

export type SchemaDiffErrorCode =
    /** `create-only` was pointed at a DATABASE_URL the guard refuses. */
    | 'database_url_refused'
    /** The read-back could not connect, or could not run its statements. */
    | 'target_unreadable'
    /** The database reached is not the one the URL names. */
    | 'target_database_mismatch'
    /** An unqualified statement in the reached session resolves outside the default schema. */
    | 'target_schema_redirected'
    /**
     * The database the command would RESET holds rows — or the occupancy
     * question could not be answered for it, which is the same refusal: a
     * target that cannot be SHOWN empty is not certified empty.
     */
    | 'target_not_disposable'
    /**
     * A relation in the database the command would RESET is protected by
     * row-level security, so this session cannot certify it empty. Measured:
     * a relation whose rows are hidden from the reading role is still DROPPED
     * by the replay, together with the rows nobody could see.
     */
    | 'target_row_security'
    /** The Prisma CLI could not be started. */
    | 'prisma_unavailable';

export class SchemaDiffError extends Error {
    constructor(
        message: string,
        public readonly code: SchemaDiffErrorCode,
    ) {
        super(message);
        this.name = 'SchemaDiffError';
    }
}

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

export interface SchemaDiffOptions {
    readonly help: boolean;
    /** `null` only together with `help`, which needs no mode. */
    readonly mode: SchemaDiffMode | null;
    /** `--name`; required by `create-only` and rejected by `diff`. */
    readonly migrationName: string | null;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: SchemaDiffOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

const isSchemaDiffMode = (value: string): value is SchemaDiffMode =>
    (SCHEMA_DIFF_MODES as readonly string[]).includes(value);

interface Token {
    readonly flag: string;
    readonly inlineValue: string | null;
}

const splitToken = (token: string): Token => {
    const separator = token.indexOf('=');
    if (!token.startsWith('--') || separator < 0) {
        return { flag: token, inlineValue: null };
    }
    return { flag: token.slice(0, separator), inlineValue: token.slice(separator + 1) };
};

/**
 * The mode is a POSITIONAL argument — `schema-diff.ts diff`, not
 * `schema-diff.ts --mode diff` — because it selects which command runs, and a
 * run with no mode must be refused rather than defaulted: defaulting to either
 * one would mean a mistyped invocation silently ran the other.
 */
export const parseSchemaDiffArgs = (argv: readonly string[]): ParseResult => {
    if (argv.some((token) => HELP_FLAGS.includes(token))) {
        return { ok: true, options: { help: true, mode: null, migrationName: null } };
    }

    const errors: ArgumentError[] = [];
    let mode: SchemaDiffMode | null = null;
    let migrationName: string | null = null;
    let migrationNameSeen = false;

    let index = 0;
    const takeValue = (inlineValue: string | null): string | null => {
        if (inlineValue !== null) {
            return inlineValue.length > 0 ? inlineValue : null;
        }
        const next = index < argv.length ? argv[index] : null;
        if (next === null || next.length === 0 || next.startsWith('-')) {
            return null;
        }
        index += 1;
        return next;
    };

    while (index < argv.length) {
        const { flag, inlineValue } = splitToken(argv[index]);
        index += 1;

        if (flag === MIGRATION_NAME_FLAG) {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a migration name` });
                continue;
            }
            if (migrationNameSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            migrationNameSeen = true;
            migrationName = value;
            continue;
        }

        if (flag === CONFIRM_TARGET_FLAG) {
            takeValue(inlineValue);
            continue;
        }

        if (flag.startsWith('-')) {
            errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
            continue;
        }

        if (mode !== null) {
            errors.push({ flag, message: `${STAGE} takes one mode; "${mode}" was already given` });
            continue;
        }

        if (!isSchemaDiffMode(flag)) {
            errors.push({
                flag,
                message: `"${flag}" is not a mode; give one of ${SCHEMA_DIFF_MODES.join(', ')}`,
            });
            continue;
        }

        mode = flag;
    }

    if (mode === null) {
        errors.push({
            flag: '<mode>',
            message: `${STAGE} needs a mode: ${SCHEMA_DIFF_MODES.join(' or ')}`,
        });
    }

    if (mode === 'create-only' && migrationName === null) {
        errors.push({
            flag: MIGRATION_NAME_FLAG,
            message: `create-only needs ${MIGRATION_NAME_FLAG} <name>: prisma prompts for one interactively, which a scripted run cannot answer`,
        });
    }

    if (mode === 'diff' && migrationName !== null) {
        errors.push({
            flag: MIGRATION_NAME_FLAG,
            message: `${MIGRATION_NAME_FLAG} belongs to create-only; the diff writes no migration`,
        });
    }

    // The second clause is not redundant with the first: a null mode has
    // already pushed an error above, and repeating the test here is what
    // narrows `mode` to a mode for the success branch.
    if (errors.length > 0 || mode === null) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, mode, migrationName } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npx ts-node --project tsconfig.scripts.json scripts/schema-diff.ts <mode> [options]   (${STAGE})`,
        '',
        'The guarded wrapper for the two Prisma commands that RESET the database they',
        'are given. Every run classifies its target with scripts/lib/dbGuard.ts, reads',
        'that target back over a real connection, and only then spawns Prisma.',
        '',
        'Modes:',
        '  diff             Emit the migration-ledger-to-datamodel diff as SQL on',
        '                   stdout, the way docs/meal-planning/expected-schema-diff.sql',
        `                   was captured. Target: ${SHADOW_DATABASE_URL_ENV}, which must name a`,
        `                   DISPOSABLE local database whose name ends ${SHADOW_DATABASE_SUFFIX}`,
        '                   (optionally with a clone index), and in which no ordinary or',
        `                   partitioned base table of the reached ${DEFAULT_SCHEMA} schema holds a`,
        '                   row. That is an occupancy statement about the tables of that one',
        '                   schema rather than a guarantee that the database is empty, and it',
        '                   is certified with row security OFF: a relation protected by a',
        '                   row-level security policy is refused rather than read as empty.',
        `                   ${DATABASE_URL_ENV} is deleted from the child environment: this`,
        '                   command does not need it, and a deployment value sitting in',
        '                   the shell is exactly the accident worth removing.',
        '  create-only      Author a new migration without applying it',
        `                   (prisma migrate dev --create-only). Target: ${DATABASE_URL_ENV},`,
        '                   which must be a database whose own NAME says development on',
        '                   a local host. This command has no --shadow-database-url flag',
        '                   and prisma/schema.prisma declares no shadowDatabaseUrl, so it',
        `                   does not read ${SHADOW_DATABASE_URL_ENV} at all: it creates and drops a`,
        `                   temporary shadow database on the ${DATABASE_URL_ENV} server and`,
        '                   resets that database itself if it finds drift.',
        '',
        'Options:',
        `  ${MIGRATION_NAME_FLAG} <name>    The migration name. Required by create-only, rejected by diff.`,
        '  --help, -h       Print this usage block and exit 0.',
        '',
        'Exit codes (Prisma\'s own verdicts passed through unchanged, plus this',
        'wrapper\'s own 3):',
        `  ${PRISMA_DIFFERENCES_EXIT_CODE}   differences exist — Prisma ran and found them, which is the expected`,
        '      result of the diff and what docs/meal-planning/expected-schema-diff.sql',
        '      records.',
        '  0   Prisma ran and found none: the ledger and the datamodel agree, so the',
        '      committed capture is stale or the construct it stands for is gone from',
        '      the migration. (create-only reports success with this code.)',
        '  1   Prisma itself failed AFTER the read-back had already succeeded —',
        '      P3006 (a migration that does not replay cleanly onto the shadow',
        '      database), or the target changing between the read-back and the run.',
        `  ${SCHEMA_DIFF_REFUSED_EXIT_CODE}   this wrapper stopped the run and no Prisma verdict was produced: a URL`,
        '      the guard refused, a read-back that could not connect, authenticate or',
        '      find the database (measured: P1001, P1003 and P1000 are the raw',
        '      command\'s exit 1 and are this wrapper\'s 3, because the read-back',
        '      reaches them before Prisma is invoked), a database or schema that was',
        '      not the one the URL names, the occupancy or row-security refusal, or a',
        '      Prisma CLI that could not be started. No connection is opened for the',
        '      string-level refusals — a missing, unparsable, target-changing or',
        '      percent-encoded URL, or one that is not a shadow origin; the others',
        '      refuse after one was opened and closed again.',
        '',
        'A non-empty target is NOT exit 1. Measured against prisma 6.9.0 on PostgreSQL',
        '16.15, the diff DROPPED an operator table out of the shadow database and still',
        'exited 2 — which is why this wrapper refuses a reset target that holds rows,',
        'and refuses one whose rows a row-level security policy could hide from the',
        'session asking.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// The read-back.
// ---------------------------------------------------------------------------

/** Just enough of a `pg` client for the read-back to be substitutable in a test. */
export interface SchemaDiffConnection {
    connect(): Promise<void>;
    query<TRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<{ rows: TRow[] }>;
    end(): Promise<void>;
}

interface PgModule {
    Client: new (config: {
        connectionString: string;
        application_name?: string;
        connectionTimeoutMillis?: number;
        query_timeout?: number;
    }) => SchemaDiffConnection;
}

/**
 * What the target answered about itself. Every field is safe to log: the URL
 * and its userinfo never appear here (logger.ts never prints the URL, and this
 * wrapper never hands it one).
 */
export interface SchemaDiffTarget {
    /** The host as the URL spells it, for the log line beside the read-back. */
    readonly host: string;
    /** `current_database()` — the database actually reached. */
    readonly database: string;
    /** `current_schema()` — where an unqualified statement resolves. */
    readonly schema: string;
    readonly role: string;
    readonly serverVersion: string;
    /**
     * `inet_server_addr()` / `inet_server_port()`: RECORDED, never compared
     * with the URL. Measured through the published port of a container, the
     * server reports its own address and port (172.17.0.2:5432) while the URL
     * names the published pair (127.0.0.1:5433), so an equality check here
     * would refuse a legitimate local target. `null` when the session arrived
     * over a Unix socket, where the server reports neither.
     */
    readonly serverAddress: string | null;
    readonly serverPort: number | null;
    readonly searchPath: string;
    /**
     * How many ORDINARY and PARTITIONED BASE TABLES the reached schema holds —
     * the population the occupancy check covers, and not a count of everything
     * in the database. See BASE_TABLE_QUERY.
     */
    readonly tablesInSchema: number;
    /** Empty unless the caller asked for the disposable check and it found rows. */
    readonly occupiedTables: readonly string[];
    /**
     * The relations of the reached schema with row-level security enabled or
     * forced. Non-empty is a REFUSAL for the reset target (rows may be hidden
     * from this session, so the relation cannot be certified empty) and is
     * recorded for the `create-only` database, which is never certified.
     */
    readonly rowSecurityProtectedTables: readonly string[];
}

const IDENTITY_QUERY = [
    'SELECT current_database() AS database,',
    '       current_schema() AS schema,',
    '       current_user AS role,',
    '       version() AS server_version,',
    '       inet_server_addr()::text AS server_address,',
    '       inet_server_port() AS server_port,',
    "       current_setting('search_path') AS search_path",
].join('\n');

/**
 * The relations of one schema, with their row-security state beside each name.
 *
 * `relkind IN ('r', 'p')` and `NOT relispartition` is ORDINARY and PARTITIONED
 * BASE TABLES of that one schema — a partition is covered through its parent,
 * and views, sequences, foreign tables and materialised views are not rows
 * anybody stores. The two flags are read in the same statement because the
 * occupancy question below cannot be answered for a relation that carries them:
 * `relrowsecurity` is `ALTER TABLE … ENABLE ROW LEVEL SECURITY` and
 * `relforcerowsecurity` is `… FORCE ROW LEVEL SECURITY`, and either one means a
 * policy decides which rows this session is allowed to see.
 */
const BASE_TABLE_QUERY = [
    'SELECT c.relname AS table_name,',
    '       c.relrowsecurity AS row_security_enabled,',
    '       c.relforcerowsecurity AS row_security_forced',
    '  FROM pg_catalog.pg_class c',
    '  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace',
    " WHERE n.nspname = $1 AND c.relkind IN ('r', 'p') AND NOT c.relispartition",
    ' ORDER BY c.relname',
].join('\n');

/**
 * Turns row-level security OFF for the verification session, and it is the
 * half of the occupancy check that no catalog read can replace.
 *
 * MEASURED, on PostgreSQL 16.15 with a `NOSUPERUSER NOBYPASSRLS` role owning
 * the relation: one row in `public.operator_rows`, `ENABLE` plus `FORCE ROW
 * LEVEL SECURITY` and a `USING (false)` policy make
 * `EXISTS (SELECT 1 FROM "public"."operator_rows")` answer FALSE — the guard
 * read "empty", Prisma was spawned, and the relation and its row were dropped.
 * A query that OBEYS row security cannot certify a relation empty, because the
 * role that owns the relation can still drop it.
 *
 * With `row_security = off`, PostgreSQL raises "query would be affected by
 * row-level security policy for table …" (SQLSTATE 42501) for a role that
 * cannot bypass RLS instead of silently filtering the rows away, and
 * `verifyTarget` turns that error into a REFUSAL. A role that legitimately
 * bypasses row security (a superuser, `BYPASSRLS`, or an owner without `FORCE`)
 * sees every row instead, which is the answer the check needs.
 *
 * Session-level `SET` rather than `SET LOCAL`: the read-back opens no
 * transaction, and the connection is closed before Prisma is spawned, so the
 * setting cannot outlive the verification it belongs to. It is issued only for
 * the target the command RESETS — the `create-only` development database is
 * read, never certified empty, and its rows are the whole point.
 */
const ROW_SECURITY_OFF_STATEMENT = 'SET row_security = off';

/** SQL identifier quoting: the only safe way to name a relation read out of pg_class. */
const quoteIdentifier = (value: string): string => `"${value.replace(/"/g, '""')}"`;

/** SQL literal quoting, for the label each occupancy branch selects back. */
const quoteLiteral = (value: string): string => `'${value.replace(/'/g, "''")}'`;

/**
 * The occupancy statement for one batch of tables. Each branch is an
 * `EXISTS (SELECT 1 FROM …)`, so a table with a billion rows costs the same as
 * a table with one, and a table with none contributes no row at all.
 */
export const buildOccupancyStatement = (schema: string, tables: readonly string[]): string =>
    tables
        .map(
            (table) =>
                `SELECT ${quoteLiteral(table)} AS table_name WHERE EXISTS ` +
                `(SELECT 1 FROM ${quoteIdentifier(schema)}.${quoteIdentifier(table)})`,
        )
        .join(' UNION ALL ');

const readString = (row: Record<string, unknown>, column: string): string => {
    const value = row[column];
    return typeof value === 'string' ? value : '';
};

const readOptionalNumber = (row: Record<string, unknown>, column: string): number | null => {
    const value = row[column];
    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }
    if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
        return Number(value);
    }
    return null;
};

const readOptionalString = (row: Record<string, unknown>, column: string): string | null => {
    const value = row[column];
    return typeof value === 'string' && value.length > 0 ? value : null;
};

/** The spellings PostgreSQL and its drivers use for a definite `false`. */
const FALSE_SPELLINGS: readonly string[] = ['f', 'false', '0', 'no', 'off'];

/**
 * A row-security catalog flag, read so that anything other than a DEFINITE
 * "no" counts as protected.
 *
 * `pg` returns PostgreSQL's `boolean` as a JavaScript boolean, so the first
 * branch is the one that runs. The last branch is the fail-closed one and it is
 * deliberate: BASE_TABLE_QUERY asks for both flags by name, so an absent or
 * unexpectedly typed answer means the question was not answered — and a
 * relation whose row-security state is unknown cannot be certified empty. That
 * makes a future edit to the statement fail loudly on the reset target instead
 * of quietly removing this check.
 */
const readRowSecurityFlag = (row: Record<string, unknown>, column: string): boolean => {
    const value = row[column];
    if (typeof value === 'boolean') {
        return value;
    }
    if (typeof value === 'string') {
        return !FALSE_SPELLINGS.includes(value.trim().toLowerCase());
    }
    return true;
};

/**
 * Relation names in one stable order, so a refusal message and a log line read
 * the same way on two runs against the same database. Plain code-point order
 * rather than `localeCompare`: the names are SQL identifiers, and a
 * locale-dependent order would make a message depend on the operator's
 * environment.
 */
const byName = (left: string, right: string): number => (left < right ? -1 : left > right ? 1 : 0);

/**
 * Names the relations a refusal is about, bounded: an operator needs the first
 * few names to act, and a message carrying a thousand of them is a message
 * nobody reads. Shared by the occupancy and row-security refusals so the two
 * read alike.
 */
const describeTables = (tables: readonly string[]): string => {
    const named = tables.slice(0, OCCUPANCY_REPORT_LIMIT).join(', ');
    return tables.length > OCCUPANCY_REPORT_LIMIT
        ? `${named} and ${tables.length - OCCUPANCY_REPORT_LIMIT} more`
        : named;
};

export interface VerifyTargetInput {
    readonly connectionString: string;
    /** The host and database the URL names, from dbGuard's own parser. */
    readonly expectedHost: string;
    readonly expectedDatabase: string;
    /** The environment variable the URL came from, so a refusal names the right line. */
    readonly urlEnvName: string;
    /**
     * Whether this target is the one the command RESETS. `true` adds the
     * occupancy check — the row-security refusal, `row_security = off` and the
     * per-table `EXISTS` question, all three of which belong to certifying a
     * database empty; `false` is for a database the command only reads and
     * migrates (the `create-only` development database), where rows are the
     * whole point and no certification is attempted.
     */
    readonly requireDisposable: boolean;
    readonly openConnection: (connectionString: string) => SchemaDiffConnection;
    readonly logger: ScriptLogger;
}

/**
 * Opens one connection to the target, asks it what it is, and refuses unless
 * the answers match the URL.
 *
 * THIS IS THE CHECK A STRING CANNOT MAKE. dbGuard refuses a URL whose query
 * string moves the schema, but `ALTER ROLE … SET search_path` and
 * `ALTER DATABASE … SET search_path` move it server-side where no URL shows it,
 * and an unqualified `TRUNCATE`/`DROP` in the replay would then land in another
 * schema of the same database. Likewise a connector that resolved a different
 * database than the URL displays is visible only from inside the session.
 *
 * THE OCCUPANCY CHECK FAILS CLOSED, in two halves that cover different cases.
 * Row-level security decides which rows a session may SEE while leaving what a
 * role may DROP untouched, so a visibility-obeying query cannot certify a
 * relation empty. Therefore: the session runs with `row_security = off`
 * (ROW_SECURITY_OFF_STATEMENT), which turns a role's inability to bypass RLS
 * into an ERROR rather than into silently filtered rows; every error raised
 * while the occupancy question is being asked becomes a REFUSAL rather than an
 * "empty" verdict; and a relation that carries `relrowsecurity` or
 * `relforcerowsecurity` is refused outright, before the occupancy statement is
 * issued for it, because its rows may be hidden from this session whatever the
 * setting says.
 *
 * The connection is closed before Prisma is spawned, and `end()` never throws
 * out of here: a failure to hang up must not replace the verdict.
 */
export const verifyTarget = async (input: VerifyTargetInput): Promise<SchemaDiffTarget> => {
    const connection = input.openConnection(input.connectionString);
    let identity: Record<string, unknown>;
    let tables: string[];
    let protectedTables: string[] = [];
    let occupied: string[] = [];

    try {
        try {
            await connection.connect();

            if (input.requireDisposable) {
                // BEFORE the first question about the target's content, so no
                // answer this function acts on was filtered by a policy.
                await connection.query(ROW_SECURITY_OFF_STATEMENT);
            }

            const identityResult = await connection.query<Record<string, unknown>>(IDENTITY_QUERY);
            const firstRow = identityResult.rows.length > 0 ? identityResult.rows[0] : undefined;
            if (firstRow === undefined) {
                throw new SchemaDiffError(
                    `${STAGE} could not read ${input.urlEnvName}'s target back: the server returned no row for its own identity.`,
                    'target_unreadable',
                );
            }
            identity = firstRow;

            const schema = readString(identity, 'schema');
            const reachedSchema = schema.length > 0 ? schema : DEFAULT_SCHEMA;
            const tableResult = await connection.query<Record<string, unknown>>(BASE_TABLE_QUERY, [reachedSchema]);
            tables = tableResult.rows.map((row) => readString(row, 'table_name'));
            protectedTables = tableResult.rows
                .filter(
                    (row) =>
                        readRowSecurityFlag(row, 'row_security_enabled') ||
                        readRowSecurityFlag(row, 'row_security_forced'),
                )
                .map((row) => readString(row, 'table_name'))
                .sort(byName);

            // Thrown here rather than after the hang-up below, so the occupancy
            // statement is never issued for a relation whose answer would not
            // mean anything — and so the refusal an operator reads names row
            // security rather than reporting a statement that failed.
            if (input.requireDisposable && protectedTables.length > 0) {
                throw new SchemaDiffError(
                    `${STAGE} refuses to run: ${protectedTables.length} relation(s) in schema ` +
                        `"${reachedSchema}" of database "${readString(identity, 'database')}" on host ` +
                        `"${input.expectedHost}" are protected by row-level security ` +
                        `(${describeTables(protectedTables)}). A policy decides which rows this session may ` +
                        'SEE, while the role that owns the relation can still DROP it — measured against ' +
                        'PostgreSQL 16.15, a forced deny-all policy made an occupied table answer "empty" ' +
                        'and the replay dropped the table and the hidden row with it. So a policy-protected ' +
                        `relation cannot be certified empty and this command will not reset it. Point ` +
                        `${input.urlEnvName} at a database made to be thrown away, or drop those relations ` +
                        'deliberately.',
                    'target_row_security',
                );
            }

            if (input.requireDisposable && tables.length > 0) {
                try {
                    for (let start = 0; start < tables.length; start += OCCUPANCY_BATCH_SIZE) {
                        const batch = tables.slice(start, start + OCCUPANCY_BATCH_SIZE);
                        const occupancy = await connection.query<Record<string, unknown>>(
                            buildOccupancyStatement(reachedSchema, batch),
                        );
                        for (const row of occupancy.rows) {
                            occupied.push(readString(row, 'table_name'));
                        }
                    }
                } catch (error) {
                    // A FAILED occupancy question is a refusal, never an empty
                    // verdict. With `row_security = off` a role that cannot
                    // bypass RLS gets "query would be affected by row-level
                    // security policy for table …" (SQLSTATE 42501) here rather
                    // than a silently filtered answer, and that error means the
                    // one thing this check exists to catch: rows this session
                    // is not allowed to see. A revoked SELECT lands here too,
                    // and it deserves the same verdict for the same reason.
                    throw new SchemaDiffError(
                        `${STAGE} could not ask whether the ${tables.length} table(s) in schema ` +
                            `"${reachedSchema}" of database "${readString(identity, 'database')}" on host ` +
                            `"${input.expectedHost}" hold rows: ` +
                            `${error instanceof Error ? error.message : String(error)}. A row-level security ` +
                            'policy or a revoked SELECT hides rows from this session while leaving them in ' +
                            'the database, so an unanswered occupancy question is a refusal rather than an ' +
                            `empty target. Point ${input.urlEnvName} at a database made to be thrown away, ` +
                            'or grant the role reading it unfiltered access to it.',
                        'target_not_disposable',
                    );
                }
                occupied = [...occupied].sort(byName);
            }
        } catch (error) {
            if (error instanceof SchemaDiffError) {
                throw error;
            }
            // Anything the driver raises — refused connection, timeout,
            // authentication, a permission the read-back needs and does not
            // have — is one refusal: the target could not be verified, so it
            // must not be reset. The driver's own message is carried because it
            // names the cause (`ECONNREFUSED`, `password authentication
            // failed`, `permission denied for table …`) and carries no
            // credential: logger.ts redacts the URL, and this path never hands
            // it one.
            throw new SchemaDiffError(
                `${STAGE} could not read ${input.urlEnvName}'s target back over a connection to database ` +
                    `"${input.expectedDatabase}" on host "${input.expectedHost}": ` +
                    `${error instanceof Error ? error.message : String(error)}. The command RESETS what it ` +
                    'is given, so a target that cannot be verified is not used.',
                'target_unreadable',
            );
        }
    } finally {
        try {
            await connection.end();
        } catch {
            // The verdict above is the artefact of this function; a failed
            // hang-up is not worth replacing it with, and the process is about
            // to spawn Prisma or exit either way.
        }
    }

    const database = readString(identity, 'database');
    const schema = readString(identity, 'schema');
    const searchPath = readString(identity, 'search_path');

    const target: SchemaDiffTarget = {
        host: input.expectedHost,
        database,
        schema,
        role: readString(identity, 'role'),
        serverVersion: readString(identity, 'server_version'),
        serverAddress: readOptionalString(identity, 'server_address'),
        serverPort: readOptionalNumber(identity, 'server_port'),
        searchPath,
        tablesInSchema: tables.length,
        occupiedTables: occupied,
        rowSecurityProtectedTables: protectedTables,
    };

    if (database !== input.expectedDatabase) {
        throw new SchemaDiffError(
            `${STAGE} refuses to run: ${input.urlEnvName} names database "${input.expectedDatabase}" but the ` +
                `connection reached "${database}" on host "${input.expectedHost}". The database that would be ` +
                `written is not the one the URL displays; point ${input.urlEnvName} directly at the database.`,
            'target_database_mismatch',
        );
    }

    if (schema !== DEFAULT_SCHEMA) {
        throw new SchemaDiffError(
            `${STAGE} refuses to run: an unqualified statement in database "${database}" on host ` +
                `"${input.expectedHost}" resolves in schema "${schema}" rather than ${DEFAULT_SCHEMA} ` +
                `(search_path is "${searchPath}"). ${DEFAULT_SCHEMA} is the schema this repository's ` +
                'migrations create, and the replay this command performs belongs there. A role or database ' +
                'default can redirect it where no URL shows it, so clear both: ALTER ROLE ' +
                `${target.role} IN DATABASE ${database} RESET search_path, and ALTER DATABASE ${database} ` +
                'RESET search_path.',
            'target_schema_redirected',
        );
    }

    if (input.requireDisposable && occupied.length > 0) {
        throw new SchemaDiffError(
            `${STAGE} refuses to run: database "${database}" on host "${input.expectedHost}" holds rows in ` +
                `${occupied.length} of the ${tables.length} base table(s) of schema "${schema}" ` +
                `(${describeTables(occupied)}). This command RESETS the database it is given — measured ` +
                'against prisma 6.9.0, the diff dropped an operator table out of a shadow database and still ' +
                `exited 2 — so nothing of value may live there. Point ${input.urlEnvName} at a database made ` +
                'to be thrown away, or empty this one deliberately.',
            'target_not_disposable',
        );
    }

    input.logger.info('target_verified', {
        stage: STAGE,
        urlEnvName: input.urlEnvName,
        host: target.host,
        database: target.database,
        schema: target.schema,
        role: target.role,
        serverVersion: target.serverVersion,
        serverAddress: target.serverAddress,
        serverPort: target.serverPort,
        tablesInSchema: target.tablesInSchema,
        disposableChecked: input.requireDisposable,
        // What the verdict above rests on, recorded so the log says which
        // question was asked rather than only that it passed: the occupancy
        // check covers the ordinary and partitioned base tables of this one
        // schema, it ran with row security off, and no relation in it carried a
        // policy. For `create-only` the count is informational — that database
        // is read and migrated, never certified empty.
        rowSecurityDisabledForCheck: input.requireDisposable,
        rowSecurityProtectedTables: target.rowSecurityProtectedTables.length,
    });

    return target;
};

/**
 * The real connection, opened lazily so importing this module for its exported
 * functions loads no driver and touches no network.
 */
export const openPostgresConnection = (connectionString: string): SchemaDiffConnection => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy by design: see the note above
    const pg = require('pg') as PgModule;

    return new pg.Client({
        connectionString,
        application_name: READBACK_APPLICATION_NAME,
        connectionTimeoutMillis: READBACK_CONNECT_TIMEOUT_MS,
        query_timeout: READBACK_QUERY_TIMEOUT_MS,
    });
};

// ---------------------------------------------------------------------------
// The Prisma invocation.
// ---------------------------------------------------------------------------

export interface PrismaInvocation {
    /** The Node executable; the CLI is run as a module rather than through a shell. */
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
}

export interface PrismaRunResult {
    /** `null` when the child was killed by a signal rather than exiting. */
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    /** Everything the child wrote to its error descriptor, for the failure report. */
    readonly stderr: string;
}

export type PrismaRunner = (invocation: PrismaInvocation) => Promise<PrismaRunResult>;

export interface BuildPrismaInvocationInput {
    readonly mode: SchemaDiffMode;
    readonly migrationName: string | null;
    /** The URL the guard accepted, passed on the command line in `diff` mode. */
    readonly shadowDatabaseUrl: string;
    readonly env: NodeJS.ProcessEnv;
    readonly packageRoot: string;
    readonly nodeExecutable: string;
    readonly prismaCliPath: string;
}

/**
 * The argument list and child environment for one mode — a pure function, so
 * the two decisions that matter are unit-testable without a process: WHICH
 * arguments Prisma is given, and WHETHER `DATABASE_URL` reaches it.
 *
 * `cwd` is the backend package root rather than the operator's directory,
 * because the two paths the diff compares are repository-relative and a run
 * from `docs/` would otherwise diff nothing and report that the ledger and the
 * datamodel agree.
 */
export const buildPrismaInvocation = (input: BuildPrismaInvocationInput): PrismaInvocation => {
    const env: NodeJS.ProcessEnv = { ...input.env };

    if (input.mode === 'diff') {
        // The diff needs no datasource URL — measured: it exits 2 under
        // `env -u DATABASE_URL` — so the variable is removed from the child
        // rather than passed through. It cannot help this command and it is the
        // one value in the environment whose accidental presence has
        // consequences. (Prisma still loads backend/.env itself; what this
        // removes is a value an operator exported into the shell.)
        delete env[DATABASE_URL_ENV];

        return {
            command: input.nodeExecutable,
            args: [
                input.prismaCliPath,
                'migrate',
                'diff',
                '--from-migrations',
                MIGRATIONS_DIRECTORY,
                '--to-schema-datamodel',
                SCHEMA_DATAMODEL,
                '--shadow-database-url',
                input.shadowDatabaseUrl,
                '--exit-code',
                '--script',
            ],
            env,
            cwd: input.packageRoot,
        };
    }

    // `create-only` DOES need DATABASE_URL: it reads the migration state of
    // that database, creates and drops a temporary shadow database on its
    // server, and resets the database itself if it finds drift. So the variable
    // stays, and `runSchemaDiff` has already held it to the `development_only`
    // policy before this function is reached.
    const args: string[] = [input.prismaCliPath, 'migrate', 'dev', '--create-only'];
    if (input.migrationName !== null) {
        args.push('--name', input.migrationName);
    }

    return { command: input.nodeExecutable, args, env, cwd: input.packageRoot };
};

/**
 * Spawns the CLI, inheriting stdout so the diff's SQL reaches the caller byte
 * for byte, and capturing stderr so a failure can be reported with Prisma's own
 * error text. The captured text is re-emitted verbatim afterwards, so nothing
 * the child said is lost by having been captured.
 */
export const runPrismaProcess: PrismaRunner = (invocation) =>
    new Promise<PrismaRunResult>((resolve, reject) => {
        const child = spawn(invocation.command, [...invocation.args], {
            cwd: invocation.cwd,
            env: invocation.env,
            stdio: ['ignore', 'inherit', 'pipe'],
        });

        const chunks: Buffer[] = [];
        if (child.stderr !== null) {
            child.stderr.on('data', (chunk: Buffer) => {
                chunks.push(Buffer.from(chunk));
            });
        }

        child.on('error', (error: Error) => {
            reject(
                new SchemaDiffError(
                    `${STAGE} could not start the Prisma CLI (${invocation.command} ${invocation.args[0] ?? ''}): ` +
                        `${error.message}. Run npm ci in backend/ and try again.`,
                    'prisma_unavailable',
                ),
            );
        });

        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
            const stderr = Buffer.concat(chunks).toString('utf8');
            if (stderr.length > 0) {
                // Verbatim, on the error descriptor the child would have used.
                // Prisma's P-code diagnostics are the most useful thing an
                // operator gets out of a failed run, and reformatting them into
                // a log field would hide their layout.
                writeLineSync(stderr.replace(/\n+$/, ''), 'error');
            }
            resolve({ exitCode: code, signal, stderr });
        });
    });

/** The default CLI path, resolved from the installed `prisma` package. */
export const resolvePrismaCliPath = (): string => require.resolve(PRISMA_CLI_MODULE);

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

export type SchemaDiffVerdict =
    /** `diff`, exit 2: the ledger and the datamodel differ, as the evidence records. */
    | 'differences_found'
    /** `diff`, exit 0: they agree, so the committed capture is stale. */
    | 'no_differences'
    /** `create-only`, exit 0. */
    | 'migration_created'
    /** Either mode, exit 1 or a signal: Prisma itself failed. */
    | 'command_failed';

export interface SchemaDiffOutcome {
    readonly mode: SchemaDiffMode;
    readonly verdict: SchemaDiffVerdict;
    /** Passed through to the process exit status; see the header's exit-code table. */
    readonly exitCode: number;
    readonly origin: DatabaseOrigin;
    readonly target: SchemaDiffTarget;
}

export interface SchemaDiffDeps {
    readonly mode: SchemaDiffMode;
    readonly migrationName: string | null;
    readonly env: NodeJS.ProcessEnv;
    readonly logger: ScriptLogger;
    readonly openConnection: (connectionString: string) => SchemaDiffConnection;
    readonly runPrisma: PrismaRunner;
    readonly packageRoot: string;
    readonly nodeExecutable: string;
    readonly prismaCliPath: string;
    /**
     * `--confirm-target`, parsed by dbGuard from the same argv. Neither mode's
     * policy has a confirmation door, so this is read only to record that the
     * flag was seen and opened nothing — an operator who typed it should find
     * that stated rather than have to infer it from silence.
     */
    readonly confirmTarget?: string | null;
}

/** Which environment variable each mode's guarded target comes from. */
export const targetEnvNameFor = (mode: SchemaDiffMode): string =>
    mode === 'diff' ? SHADOW_DATABASE_URL_ENV : DATABASE_URL_ENV;

/**
 * One run, from the guard to the exit code.
 *
 * ORDER IS THE WHOLE CONTRACT. The two string-level guards run first and throw
 * before anything is opened; the read-back runs second and throws before
 * anything is spawned; Prisma runs last. The negative assertions in the suite
 * are asserting exactly that order, and they are the point of the file: for a
 * STRING-LEVEL refusal, that no connection was opened AND no process spawned;
 * for a read-back, occupancy or row-security refusal — which necessarily
 * happens after a connection was opened and closed again — that no process was
 * spawned.
 */
export const runSchemaDiff = async (deps: SchemaDiffDeps): Promise<SchemaDiffOutcome> => {
    const { mode, env, logger } = deps;
    const urlEnvName = targetEnvNameFor(mode);
    const command = `${STAGE} ${mode}`;

    logger.info('stage_invoked', {
        stage: STAGE,
        mode,
        urlEnvName,
        migrationName: deps.migrationName,
        confirmTargetOpensNothing: deps.confirmTarget ?? null,
    });

    // GUARD ONE, and it throws DatabaseOriginError with dbGuard's own code and
    // message. `diff` is the only sanctioned caller of the shadow rule; the
    // authoring command is held to the strictest DATABASE_URL policy instead,
    // because that is the database it touches (see MODES in the header).
    const origin =
        mode === 'diff'
            ? assertShadowDatabase({ command, env, urlEnvName, logger })
            : assertDevelopmentDatabaseUrl(command, env, logger);

    const connectionString = env[urlEnvName];
    if (connectionString === undefined || connectionString.trim().length === 0) {
        // Unreachable through either guard above — both refuse a missing value
        // first — and typed rather than left to the driver, which would read
        // the libpq environment and connect somewhere nobody named.
        throw new SchemaDiffError(
            `${command} needs ${urlEnvName} to be set, and it is not.`,
            'target_unreadable',
        );
    }

    const parsed = parseDatabaseUrl(connectionString);
    if (parsed === null) {
        // Also unreachable: both guards refuse an unparsable URL. Kept so the
        // parsed host and database below are values rather than assertions.
        throw new SchemaDiffError(
            `${command} cannot read ${urlEnvName}: it is not a connection URL naming a database.`,
            'target_unreadable',
        );
    }

    // GUARD TWO. `diff` resets its target, so that target must also be empty.
    const target = await verifyTarget({
        connectionString,
        expectedHost: parsed.host,
        expectedDatabase: parsed.database,
        urlEnvName,
        requireDisposable: mode === 'diff',
        openConnection: deps.openConnection,
        logger,
    });

    const invocation = buildPrismaInvocation({
        mode,
        migrationName: deps.migrationName,
        shadowDatabaseUrl: connectionString,
        env,
        packageRoot: deps.packageRoot,
        nodeExecutable: deps.nodeExecutable,
        prismaCliPath: deps.prismaCliPath,
    });

    logger.info('prisma_invoked', {
        stage: STAGE,
        mode,
        // The argument list minus the shadow URL, which carries a password in
        // its userinfo. The target is already in the log, named.
        args: invocation.args.map((argument) => (argument === connectionString ? '<validated-url>' : argument)),
        databaseUrlPassedToChild: Object.prototype.hasOwnProperty.call(invocation.env, DATABASE_URL_ENV),
        cwd: invocation.cwd,
    });

    const result = await deps.runPrisma(invocation);

    return describeRun({ mode, origin, target, result, logger });
};

/**
 * Why `create-only` is development-only, in the terms of the command rather
 * than of dbGuard's policy table. Exported so the suite asserts the operator
 * reads the reason, not just the code.
 */
export const describeDevelopmentOnlyRefusal = (command: string, origin: DatabaseOrigin): string =>
    `${command} refuses to run against database "${origin.database}" on host "${origin.host}": it is ` +
    `${origin.match === 'name' ? origin.originClass : `${origin.originClass} by its host alone`}. ` +
    '`prisma migrate dev` creates and drops a temporary shadow database on this server, and resets the ' +
    `database it is pointed at if it finds drift, so ${DATABASE_URL_ENV} must name a database whose own ` +
    `NAME says development — ending ${DEVELOPMENT_DATABASE_SUFFIX}, with or without a clone index, on host ` +
    `${LOCAL_HOSTS.join(', ')}. A database that is development by its host alone is every database ` +
    'answering on loopback, a deployment database reached through a tunnel included. There is no ' +
    'confirmation flag for this command.';

/**
 * The `create-only` half of guard one: DATABASE_URL under the strictest policy
 * dbGuard has.
 *
 * `evaluateScriptDatabase` with an explicit policy rather than
 * `assertScriptDatabase`, because that function looks the script up in
 * SCRIPT_DATABASE_POLICIES and this entry point is deliberately absent from it
 * — its module-load enforcement must stay a no-op here, or the diff, which
 * addresses no DATABASE_URL at all, could be refused for the value of a
 * variable it deletes.
 *
 * `development_only` is the policy because `prisma migrate dev` resets the
 * database it is pointed at when it finds drift and creates a database beside
 * it; "development by its host alone" — every database answering on loopback,
 * a tunnelled deployment database included — is not evidence that a database
 * was made for that.
 */
const assertDevelopmentDatabaseUrl = (
    command: string,
    env: NodeJS.ProcessEnv,
    logger: ScriptLogger,
): DatabaseOrigin => {
    const origin = classifyDatabaseOrigin(env[DATABASE_URL_ENV]);
    const verdict = evaluateScriptDatabase({
        script: command,
        policy: 'development_only',
        origin,
        confirmTarget: null,
    });

    if (!verdict.allowed) {
        // Every branch of that function composes a message an operator can act
        // on, and they are reused as written — except the `development_only`
        // one, which explains the policy through the POLICY TABLE ("… is not a
        // known pipeline script, so it falls back to the strictest policy").
        // That sentence is true of the lookup and misleading here: this entry
        // point's absence from the table is deliberate (see the note above),
        // not the reason the policy applies. So that one message is replaced
        // with the reason that does apply, and the rule itself — the
        // classification and the verdict — is still dbGuard's.
        throw new DatabaseOriginError(
            verdict.code === 'development_only' ? describeDevelopmentOnlyRefusal(command, origin) : verdict.message,
            verdict.code,
            origin,
        );
    }

    logger.debug('database_origin_accepted', {
        command,
        urlEnvName: DATABASE_URL_ENV,
        originClass: origin.originClass,
        host: origin.host,
        database: origin.database,
    });

    return origin;
};

interface DescribeRunInput {
    readonly mode: SchemaDiffMode;
    readonly origin: DatabaseOrigin;
    readonly target: SchemaDiffTarget;
    readonly result: PrismaRunResult;
    readonly logger: ScriptLogger;
}

/**
 * Prisma's exit status, read as a verdict and passed through as an exit code.
 *
 * The three codes are not interchangeable and the log says which one happened
 * in words, because an operator reading CI output should not have to remember
 * that 2 is the good one. A signal — a killed child — is reported as a failure
 * with the conventional 128 + signal-free exit code 1, since there is no verdict
 * to pass through.
 *
 * Every code this function returns therefore means PRISMA RAN. The refusals
 * never reach it: they throw before the spawn and `main` maps them to
 * SCHEMA_DIFF_REFUSED_EXIT_CODE.
 */
export const describeRun = (input: DescribeRunInput): SchemaDiffOutcome => {
    const { mode, result, logger } = input;
    const base = { stage: STAGE, mode, database: input.target.database, host: input.target.host };

    if (result.signal !== null || result.exitCode === null) {
        logger.error('prisma_terminated', { ...base, signal: result.signal });
        return { mode, verdict: 'command_failed', exitCode: 1, origin: input.origin, target: input.target };
    }

    if (mode === 'diff') {
        if (result.exitCode === PRISMA_DIFFERENCES_EXIT_CODE) {
            logger.info('schema_differences_found', {
                ...base,
                exitCode: result.exitCode,
                meaning: 'the migration ledger and prisma/schema.prisma differ, which is what docs/meal-planning/expected-schema-diff.sql records',
            });
            return {
                mode,
                verdict: 'differences_found',
                exitCode: result.exitCode,
                origin: input.origin,
                target: input.target,
            };
        }

        if (result.exitCode === 0) {
            logger.error('schema_no_differences', {
                ...base,
                exitCode: result.exitCode,
                meaning: 'the ledger and the datamodel agree, so docs/meal-planning/expected-schema-diff.sql is stale or the construct it records is gone from the migration',
            });
            return {
                mode,
                verdict: 'no_differences',
                exitCode: 0,
                origin: input.origin,
                target: input.target,
            };
        }

        logger.error('prisma_failed', {
            ...base,
            exitCode: result.exitCode,
            // P1001, P1003 and P1000 are deliberately NOT named here: the
            // read-back reaches an unreachable server, a missing database and a
            // failed authentication first and refuses with this wrapper's own
            // code 3, so a Prisma failure at this point is one that happened
            // after a successful read-back.
            meaning: 'Prisma itself failed after the read-back had already succeeded; the residual cause is P3006 (a migration that does not replay cleanly onto the shadow database), the other being the target changing between the read-back and the run',
        });
        return {
            mode,
            verdict: 'command_failed',
            exitCode: result.exitCode,
            origin: input.origin,
            target: input.target,
        };
    }

    if (result.exitCode === 0) {
        logger.info('migration_created', { ...base, exitCode: 0 });
        return { mode, verdict: 'migration_created', exitCode: 0, origin: input.origin, target: input.target };
    }

    logger.error('prisma_failed', { ...base, exitCode: result.exitCode });
    return {
        mode,
        verdict: 'command_failed',
        exitCode: result.exitCode,
        origin: input.origin,
        target: input.target,
    };
};

/**
 * Everything this wrapper prints goes to the ERROR descriptor, whatever its
 * level: fd 1 carries the diff's SQL, which is compared byte for byte against a
 * committed file, so one info line on it would fail the gate it exists to
 * serve. `writeLineSync`'s level argument selects the descriptor only — the
 * serialized line already carries its own level — so passing `'error'` moves
 * the line without relabelling it.
 */
const logToStandardError = (line: string): void => {
    writeLineSync(line, 'error');
};

const logger = createLogger(STAGE, { write: logToStandardError });

/** The backend package root: the two paths the diff compares are relative to it. */
export const packageRoot = (): string => path.resolve(__dirname, '..');

const main = async (): Promise<number> => {
    const parsed = parseSchemaDiffArgs(process.argv.slice(2));

    if (!parsed.ok) {
        for (const failure of parsed.errors) {
            logger.error('argument_rejected', { stage: STAGE, flag: failure.flag, problem: failure.message });
        }
        writeUsage('error');
        return SCHEMA_DIFF_REFUSED_EXIT_CODE;
    }

    if (parsed.options.help || parsed.options.mode === null) {
        writeUsage('info');
        return 0;
    }

    const outcome = await runSchemaDiff({
        mode: parsed.options.mode,
        migrationName: parsed.options.migrationName,
        env: process.env,
        logger,
        openConnection: openPostgresConnection,
        runPrisma: runPrismaProcess,
        packageRoot: packageRoot(),
        nodeExecutable: process.execPath,
        prismaCliPath: resolvePrismaCliPath(),
        confirmTarget: parseConfirmTarget(process.argv),
    });

    return outcome.exitCode;
};

// Guarded so importing this module for parseSchemaDiffArgs,
// buildPrismaInvocation, verifyTarget, describeRun or runSchemaDiff never runs
// a command, opens a connection or loads the `pg` driver.
if (require.main === module) {
    main()
        .then((exitCode) => {
            process.exit(exitCode);
        })
        .catch((error: unknown) => {
            // createFatalLogger, not the module logger: the next statement is
            // process.exit, which discards whatever is still buffered on a
            // piped stderr, and the refusal reason is the only artefact this
            // path produces.
            const fatal = createFatalLogger(STAGE);

            if (error instanceof DatabaseOriginError) {
                fatal.error('database_origin_refused', {
                    stage: STAGE,
                    code: error.code,
                    originClass: error.origin.originClass,
                    host: error.origin.host,
                    database: error.origin.database,
                    error: safeError(error),
                });
                process.exit(SCHEMA_DIFF_REFUSED_EXIT_CODE);
            }

            if (error instanceof SchemaDiffError) {
                fatal.error('target_refused', { stage: STAGE, code: error.code, error: safeError(error) });
                process.exit(SCHEMA_DIFF_REFUSED_EXIT_CODE);
            }

            // Not a refusal: a bug here must not look like one, or it would be
            // "fixed" by pointing the command at a different database.
            fatal.error('stage_failed', { stage: STAGE, error: safeError(error) });
            process.exit(1);
        });
}
