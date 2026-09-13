/**
 * The test-database guards, and the only place the suite is allowed to destroy
 * data (Agent Action Plan §0.7.1 / §0.9.1).
 *
 * Two questions, in this order, both answered before a test runs:
 *
 *   1. `assertTestDatabase` — IDENTITY. May this run destroy this database?
 *   2. `assertSchemaFreshness` — SHAPE. Is this database the schema the code
 *      expects? See that section's own header for why identity alone is not
 *      enough, and `npm run check:test-db` for the command form.
 *
 * Everything about the shape of this module serves one property: the guard must
 * run BEFORE anything can reach a database. That is why there is no
 * module-scope import of `@prisma/client`, `../../generated/prisma`,
 * `../../prisma/client`, `pg` or `../../app` anywhere below —
 * `src/prisma/client.ts` constructs its client on the second line of the file,
 * at import time, so importing it here would put a live client in the module
 * graph before `jestSetup.ts` had checked a single condition. The Prisma client
 * is therefore required LAZILY, inside the one function that needs it, after
 * the guard has passed. `testDb.test.ts` proves that from outside the process,
 * where it is provable: it spawns a child with an unsafe `DATABASE_URL` and a
 * `Module._load` / `net.Socket.prototype.connect` hook, and asserts the child
 * died with the guard's reason and recorded zero loads and zero connects.
 *
 * The origin rules themselves are NOT re-implemented here. They live in
 * `scripts/lib/dbGuard.ts`, which owns URL parsing, the local-host set, the
 * `_test` name rule including the clone-index form (`soh_test_46`), and CI's
 * plainly named `ci` database. Importing them means the scripts and the test
 * harness cannot drift apart — a second derivation is a second thing to get
 * wrong. Importing that module is side-effect-free here: its module-load
 * enforcement only fires when `process.argv[1]` names one of the nine catalog
 * scripts, and under Jest (or under the `ts-node` child the proof spawns) it
 * does not.
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import {
    CI_DATABASE_NAME,
    LOCAL_HOSTS,
    TEST_DATABASE_SUFFIX,
    classifyDatabaseOrigin,
    findConnectionRedirectingParams,
    hasEncodedDatabaseName,
    isLocalDatabaseHost,
    isTestDatabaseName,
    parseDatabaseUrl,
} from '../../../scripts/lib/dbGuard';

/**
 * Which condition refused the run. Stable strings, so a test asserts on the
 * code and stays readable when the prose of a message is improved.
 */
export type TestDatabaseGuardCode =
    | 'node_env_not_test'
    | 'truncate_not_allowed'
    | 'missing_database_url'
    | 'unparsable_database_url'
    | 'ambiguous_database_url'
    | 'database_host_not_local'
    | 'database_name_not_test'
    | 'unrecognised_database_origin';

/**
 * The guard's refusal. Carries the failing condition as a code, and a message
 * that names the condition plus the host and database it judged — never the
 * `DATABASE_URL` itself, because that string carries the user and the password
 * and this message reaches CI logs, a Jest reporter and the terminal.
 */
export class TestDatabaseGuardError extends Error {
    constructor(
        message: string,
        public readonly code: TestDatabaseGuardCode,
    ) {
        super(message);
        this.name = 'TestDatabaseGuardError';
    }
}

/** Env var names, spelled once. */
const NODE_ENV = 'NODE_ENV';
const ALLOW_DB_TRUNCATE = 'ALLOW_DB_TRUNCATE';
const DATABASE_URL = 'DATABASE_URL';

/** The only accepted values of the two switches. Exact matches, both of them. */
const REQUIRED_NODE_ENV = 'test';
const REQUIRED_ALLOW_DB_TRUNCATE = 'true';

/** How every refusal describes the judged target. Host and name only. */
const describeTarget = (host: string, database: string): string =>
    `database "${database}" on host "${host}"`;

/**
 * The three conditions a destructive test run must satisfy, checked on an
 * injected environment so every rule is reachable from a unit test without
 * spawning a process:
 *
 *   1. `NODE_ENV === 'test'` — exactly, so `development` or an unset value
 *      refuses rather than being coerced.
 *   2. `ALLOW_DB_TRUNCATE === 'true'` — exactly, so `TRUE`, `1` and a blank
 *      value refuse. Truncation is not something to enable by accident.
 *   3. `DATABASE_URL` names a `_test` database (with or without a clone index)
 *      or exactly `ci`, on a host in `LOCAL_HOSTS`.
 *
 * All three must hold. The third is delegated to `classifyDatabaseOrigin`, so
 * "is this a test database" means exactly what it means to the catalog scripts,
 * including the fail-closed refusals for a URL whose query string can redirect
 * the connection or whose database name is percent-encoded.
 *
 * Throws `TestDatabaseGuardError`; returns nothing on success.
 */
export const assertTestDatabase = (env: NodeJS.ProcessEnv = process.env): void => {
    if (env[NODE_ENV] !== REQUIRED_NODE_ENV) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite: ${NODE_ENV} must be exactly "${REQUIRED_NODE_ENV}", and it is ` +
                `${env[NODE_ENV] === undefined ? 'not set' : `"${env[NODE_ENV]}"`}.`,
            'node_env_not_test',
        );
    }

    if (env[ALLOW_DB_TRUNCATE] !== REQUIRED_ALLOW_DB_TRUNCATE) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite: ${ALLOW_DB_TRUNCATE} must be exactly ` +
                `"${REQUIRED_ALLOW_DB_TRUNCATE}", and it is ` +
                `${env[ALLOW_DB_TRUNCATE] === undefined ? 'not set' : `"${env[ALLOW_DB_TRUNCATE]}"`}. ` +
                'The suite truncates tables, so that acknowledgement is required.',
            'truncate_not_allowed',
        );
    }

    const databaseUrl = env[DATABASE_URL];
    if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite: ${DATABASE_URL} is not set.`,
            'missing_database_url',
        );
    }

    const parsed = parseDatabaseUrl(databaseUrl);
    if (parsed === null) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite: ${DATABASE_URL} is not a connection URL naming a database.`,
            'unparsable_database_url',
        );
    }

    // Three forms of "the URL does not determine its own target", all refused
    // before any host or name rule is applied, because in each of them the
    // authority the rules would judge is not where the driver would connect:
    //
    //  - a query string carrying libpq's connection keywords (`?host=`,
    //    `?dbname=`, `?service=`…), which move the connection somewhere other
    //    than the authority the URL displays;
    //  - a percent-escape in the database name, which Prisma opens literally
    //    while `pg` decodes it — two different databases, one spelling;
    //  - no authority at all, which leaves the server to PGHOST or a socket.
    //
    // Each is refused rather than classified, so the answer cannot be wrong in
    // the dangerous direction. The two predicates come from the same shared
    // module as the rules, so this stays one derivation rather than two.
    const redirectingParams = findConnectionRedirectingParams(databaseUrl);
    if (redirectingParams.length > 0) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite: ${DATABASE_URL} sets connection parameters that can change ` +
                `the database it opens (${redirectingParams.join(', ')}), so the host and name in it are ` +
                'not the target. Point it directly at the database instead.',
            'ambiguous_database_url',
        );
    }

    if (hasEncodedDatabaseName(databaseUrl)) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite: the database name "${parsed.database}" in ${DATABASE_URL} is ` +
                'percent-encoded, and Prisma would open that name literally while other PostgreSQL clients ' +
                'would decode it. Write the database name literally.',
            'ambiguous_database_url',
        );
    }

    const origin = classifyDatabaseOrigin(databaseUrl);
    if (origin.originClass === 'test') {
        return;
    }

    // A URL with no authority. The name is known and the host is not, and a
    // name rule alone is not the test rule — both halves are required.
    if (origin.host.length === 0 || parsed.host.length === 0) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite: ${DATABASE_URL} names no host, so the server would come from ` +
                'the environment rather than from the URL.',
            'ambiguous_database_url',
        );
    }

    const target = describeTarget(parsed.host, parsed.database);

    if (!isLocalDatabaseHost(parsed.host)) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite against ${target}: the host must be one of ` +
                `${LOCAL_HOSTS.join(', ')}. A "${TEST_DATABASE_SUFFIX}" name on a remote host is a naming ` +
                'convention, not a disposable database.',
            'database_host_not_local',
        );
    }

    if (!isTestDatabaseName(parsed.database)) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite against ${target}: the database name must end in ` +
                `"${TEST_DATABASE_SUFFIX}" (optionally followed by a clone index, as in ` +
                `"soh${TEST_DATABASE_SUFFIX}_46") or be exactly "${CI_DATABASE_NAME}".`,
            'database_name_not_test',
        );
    }

    // Both halves of the rule hold, yet the shared classifier did not answer
    // `test`. Unreachable against today's rules and deliberately kept: those
    // rules live in another module, and if they ever narrow, this refuses
    // instead of truncating a database nobody classified.
    throw new TestDatabaseGuardError(
        `Refusing to run the test suite against ${target}: it classified as "${origin.originClass}" ` +
            `(${origin.reason}), not as a test database.`,
        'unrecognised_database_origin',
    );
};

/**
 * Every table this feature owns, the three diary tables its rows hang off, and
 * the legacy tables a `CASCADE` from `users` cannot reach. Explicit and frozen
 * rather than derived from the information schema: a derived list would
 * silently grow to include whatever else lives in the database, and this list
 * is the blast radius of `truncateFeatureTables`.
 *
 * Grouped for readability only — one `TRUNCATE … CASCADE` statement is
 * order-independent — with the sixteen meal-planning tables in dependency
 * order (parents last).
 */
export const FEATURE_TABLES: readonly string[] = Object.freeze([
    'meal_plan_actions',
    'grocery_items',
    'meal_plan_meals',
    'meal_plan_days',
    'meal_plans',
    'meal_plan_preferences',
    'recipe_ingredients',
    'recipe_versions',
    'recipes',
    'catalog_validation_records',
    'catalog_food_components',
    'catalog_food_portions',
    'catalog_food_aliases',
    'catalog_foods',
    'catalog_generation_batches',
    'catalog_import_runs',
    'meal_entries',
    'meals',
    'users',
    // Listed explicitly because a `CASCADE` from `users` does not reach them,
    // which is not recoverable from the list above: `workout_days` carries a
    // `user_id` but declares no foreign key to `users`, `usda_api_cache` has no
    // `user_id` at all, and `ai_usage` keys on `(user_id, day)` without a
    // foreign key either. Measured against the migrated schema rather than
    // assumed — seeded rows in all three survived a `TRUNCATE … CASCADE` of the
    // nineteen tables above, and a surviving `usda_api_cache` row is what makes
    // an offline or catalog suite pass or fail on what ran before it.
    // `daily_exercises` and `exercise_sets` DO cascade, through
    // `user_exercises`; they are named anyway because they hang off
    // `workout_days` just as directly, and it is now truncated by name.
    'workout_days',
    'daily_exercises',
    'exercise_sets',
    'usda_api_cache',
    'ai_usage',
]);

/** Unquoted identifier syntax: what may be interpolated into DDL at all. */
const SAFE_IDENTIFIER_PATTERN = /^[a-z_][a-z0-9_]*$/;

/**
 * Double-quotes one table name from `FEATURE_TABLES`. Nothing a caller supplies
 * ever reaches this — `truncateFeatureTables` takes no arguments — and the
 * pattern check is the second lock: a table name that is not a plain lower-case
 * identifier fails loudly instead of being quoted into a statement.
 */
const quoteIdentifier = (identifier: string): string => {
    if (!SAFE_IDENTIFIER_PATTERN.test(identifier)) {
        throw new Error(
            `FEATURE_TABLES contains "${identifier}", which is not a plain lower-case SQL identifier; ` +
                'refusing to build a TRUNCATE statement from it.',
        );
    }
    return `"${identifier}"`;
};

/**
 * The one Prisma member this module uses, declared structurally so no type or
 * value from the generated client enters this module's import graph. Keeping
 * the surface this small is also why the harness works on a checkout where
 * `prisma generate` has not been run until a suite actually touches the
 * database.
 */
interface TestPrismaClient {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
}

/**
 * Loads the shared Prisma singleton on first use. `require`, not `import`:
 * TypeScript's CommonJS emit hoists every `import` above the module body, which
 * would defeat the whole point of the guard (see this file's header).
 */
const requirePrismaClient = (): TestPrismaClient => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- a lazy load is the point; see above
    const loaded = require('../../prisma/client') as { prisma: TestPrismaClient };
    return loaded.prisma;
};

/**
 * Empties every feature table in one statement, after re-running the guard.
 *
 * The guard runs again here even though `jestSetup.ts` already ran it: a suite
 * can mutate `process.env` between files, and the cost of re-checking three
 * strings is nothing against truncating the wrong database once.
 *
 * `CASCADE` additionally empties every table holding a foreign key into these
 * ones — the per-user legacy tables that do reference `users`, such as
 * `templates`, `runs` and `foods` — which is intended: §0.7.1 specifies
 * `CASCADE`, and a test database with half a user's rows removed is worse than
 * an empty one. It reaches only what a foreign key leads to, which is why
 * `FEATURE_TABLES` names the three tables nothing leads to.
 *
 * `TRUNCATE` cannot be parameterised, so the statement is built from the frozen
 * `FEATURE_TABLES` constant through `quoteIdentifier` and from nothing else.
 *
 * The schema gate below runs here too, and for the same reason the identity
 * guard does: this function is the one place that reaches a database without
 * `jestSetup.ts` having run first — a suite importing this module directly, or
 * a Jest configuration that ever loses its `setupFiles` entry, would otherwise
 * truncate and query a database nobody checked the shape of. It is memoised, so
 * in the normal case where the setup file already ran it costs nothing.
 */
export const truncateFeatureTables = async (): Promise<void> => {
    assertTestDatabase();
    await assertSchemaFreshnessOnce();

    const identifiers = FEATURE_TABLES.map(quoteIdentifier).join(', ');
    const prisma = requirePrismaClient();

    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${identifiers} CASCADE`);
};

/* -------------------------------------------------------------------------- *
 * The second gate: is this database the SHAPE the code expects?
 *
 * `assertTestDatabase` above settles the database's IDENTITY — may this run
 * destroy it. Nothing above settles its shape, and the gap between the two is
 * the most expensive failure this harness can produce. A pre-provisioned test
 * database whose `_prisma_migrations` row for a migration records a checksum
 * that no longer matches that migration's file on disk is a database that
 * CLAIMS to be migrated and is not: `prisma migrate deploy` reports "No pending
 * migrations to apply", because the migration NAME is recorded and deploy does
 * not compare checksums, so nothing in the documented setup repairs it. Every
 * query naming a column the edited migration added then fails inside Prisma —
 * one such column produced 22 failing suites and roughly two hundred lines of
 * `PrismaClientKnownRequestError` per suite, not one of which named the
 * database, the migration or the remedy.
 *
 * This gate answers that in one message, before a test runs. The expected value
 * is never pinned: it is the sha256 of whatever
 * `prisma/migrations/<name>/migration.sql` holds AT RUN TIME, which is exactly
 * what Prisma records, so editing a migration moves both sides together and the
 * gate cannot go stale.
 *
 * It REFUSES four states, all of them "the database claims a migration state it
 * does not have":
 *
 *   drifted            a recorded checksum differs from the file on disk
 *   unfinished         recorded as started, unfinished, or rolled back
 *   pending            on disk, absent from a non-empty ledger
 *   unknown_migration  recorded in the ledger, not on disk
 *
 * It SKIPS four states, silently in-suite and as a printed warning from the
 * command form, because in each of them there is nothing to compare — and
 * because 25 of the 30 test files are pure logic that never open a connection.
 * Failing those where they pass today would be a worse defect than the one this
 * fixes:
 *
 *   unreachable        no connection (no container, wrong port, refused)
 *   no_ledger          no `_prisma_migrations` table, or no rows in it
 *   ledger_unreadable  the ledger exists and the read failed
 *   no_migrations      `prisma/migrations` holds no migration on disk
 *
 * Same lazy-loading discipline as the Prisma client above: `pg` is required
 * inside the reader, after the identity guard has passed, so this section adds
 * nothing to the module graph that could reach a database on import.
 * -------------------------------------------------------------------------- */

/** Which refusal. Stable strings, for the same reason as the identity codes. */
export type SchemaFreshnessCode =
    | 'schema_drifted'
    | 'migration_unfinished'
    | 'migration_pending'
    | 'migration_not_on_disk';

/** Why the gate did not reach a verdict. Never a failure; see the header. */
export type SchemaFreshnessSkipReason =
    | 'not_applicable'
    | 'unreachable'
    | 'no_ledger'
    | 'ledger_unreadable'
    | 'no_migrations';

/**
 * The schema gate's refusal. One message, carrying everything the reader needs
 * to act — and, like the identity guard's, naming the host and database rather
 * than the `DATABASE_URL`, because it reaches CI logs and terminals.
 */
export class SchemaFreshnessError extends Error {
    constructor(
        message: string,
        public readonly code: SchemaFreshnessCode,
    ) {
        super(message);
        this.name = 'SchemaFreshnessError';

        // No frames, on purpose. Every frame this error could carry is inside
        // this harness — the async reader, the comparison — and none of them is
        // where the fault is; Jest renders the topmost frame as a source
        // excerpt, which for an awaited setup file lands on an unrelated line of
        // this file and buries the message it is printed beside. An empty stack
        // makes Jest print the message and nothing else, which is the whole
        // diagnosis. (A stack set to the message instead prints it twice: Jest
        // treats a stack's frameless lines as more message.)
        this.stack = '';
    }
}

/** A read that could not be completed. Its reason becomes a skip, not a throw. */
export class SchemaReadFailure extends Error {
    constructor(
        message: string,
        public readonly reason: SchemaFreshnessSkipReason,
    ) {
        super(message);
        this.name = 'SchemaReadFailure';
    }
}

/** One migration as it exists on disk. */
export interface MigrationFingerprint {
    /** The directory name, which is what Prisma stores in `migration_name`. */
    name: string;
    /** sha256 of the file's bytes — the value Prisma stores in `checksum`. */
    checksum: string;
    /** The statements, for the column scan below. */
    sql: string;
}

/** Where the ledger lives, relative to this file: `backend/prisma/migrations`. */
export const MIGRATIONS_DIRECTORY = join(__dirname, '..', '..', '..', 'prisma', 'migrations');

/** The one file Prisma hashes in a migration directory. */
const MIGRATION_FILE_NAME = 'migration.sql';

/**
 * Every migration on disk, in the order Prisma applies them (directory name
 * ascending), each hashed the way Prisma hashes it: sha256 over the file's
 * BYTES, not over a re-encoded string, so a migration carrying anything
 * non-ASCII fingerprints identically here and there.
 *
 * A missing directory and a directory without a `migration.sql` both yield
 * nothing rather than throwing: the caller turns an empty result into a skip,
 * and a checkout with no migrations is not a broken database.
 */
export const readMigrationFingerprints = (
    directory: string = MIGRATIONS_DIRECTORY,
): MigrationFingerprint[] => {
    if (!existsSync(directory)) {
        return [];
    }

    return readdirSync(directory, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort()
        .flatMap((name) => {
            const file = join(directory, name, MIGRATION_FILE_NAME);

            if (!existsSync(file)) {
                return [];
            }

            const bytes = readFileSync(file);

            return [
                {
                    name,
                    checksum: createHash('sha256').update(bytes).digest('hex'),
                    sql: bytes.toString('utf8'),
                },
            ];
        });
};

/** One row of `_prisma_migrations`, reduced to what the comparison needs. */
export interface AppliedMigrationRow {
    /** `migration_name`, which equals the migration's directory name. */
    name: string;
    /** `checksum`, which Prisma wrote as sha256 of the file it applied. */
    checksum: string;
    /** `finished_at IS NOT NULL`. */
    finished: boolean;
    /** `rolled_back_at IS NOT NULL`. */
    rolledBack: boolean;
}

/** A migration the database recorded under a checksum that is not the file's. */
export interface MigrationDrift {
    name: string;
    recordedChecksum: string;
    onDiskChecksum: string;
}

/** What the ledger says, against what is on disk. Every category is reported. */
export interface LedgerComparison {
    kind: 'fresh' | 'drifted' | 'unfinished' | 'pending' | 'unknown_migration';
    drifted: readonly MigrationDrift[];
    unfinished: readonly string[];
    pending: readonly string[];
    unknown: readonly string[];
}

/**
 * Pure: compares the migrations on disk with the rows a database recorded.
 *
 * The ledger keeps a row per ATTEMPT, so one migration can appear more than
 * once — a rolled-back attempt followed by a successful one is a migration that
 * is applied. The last row that finished and was not rolled back is therefore
 * the row that describes the database; a name with rows but no such row is a
 * migration that never completed, which is a different fault from a checksum
 * that moved and gets its own verdict.
 */
export const compareMigrationLedger = (
    fingerprints: readonly MigrationFingerprint[],
    ledger: readonly AppliedMigrationRow[],
): LedgerComparison => {
    const applied = new Map<string, AppliedMigrationRow>();
    const attempted = new Set<string>();

    for (const row of ledger) {
        attempted.add(row.name);

        if (row.finished && !row.rolledBack) {
            applied.set(row.name, row);
        }
    }

    const drifted: MigrationDrift[] = [];
    const unfinished: string[] = [];
    const pending: string[] = [];

    for (const fingerprint of fingerprints) {
        const row = applied.get(fingerprint.name);

        if (row === undefined) {
            if (attempted.has(fingerprint.name)) {
                unfinished.push(fingerprint.name);
            } else {
                pending.push(fingerprint.name);
            }

            continue;
        }

        if (row.checksum !== fingerprint.checksum) {
            drifted.push({
                name: fingerprint.name,
                recordedChecksum: row.checksum,
                onDiskChecksum: fingerprint.checksum,
            });
        }
    }

    const onDisk = new Set(fingerprints.map((fingerprint) => fingerprint.name));
    const unknown = [...attempted].filter((name) => !onDisk.has(name)).sort();

    // Assigned in reverse precedence, so the most diagnostic category wins the
    // code without nesting the conditions. The message still lists them all.
    let kind: LedgerComparison['kind'] = 'fresh';

    if (unknown.length > 0) {
        kind = 'unknown_migration';
    }

    if (pending.length > 0) {
        kind = 'pending';
    }

    if (unfinished.length > 0) {
        kind = 'unfinished';
    }

    if (drifted.length > 0) {
        kind = 'drifted';
    }

    return { kind, drifted, unfinished, pending, unknown };
};

/**
 * Removes `--` line comments and `/* *\/` block comments, tracking string and
 * quoted-identifier literals so a comment marker INSIDE one survives. Newlines
 * are kept, so nothing that follows shifts onto a previous line.
 */
const stripSqlComments = (sql: string): string => {
    let stripped = '';
    let index = 0;
    let quote: string | null = null;

    while (index < sql.length) {
        const character = sql[index];
        const next = sql[index + 1];

        if (quote !== null) {
            stripped += character;

            if (character === quote) {
                // A doubled quote escapes itself; it does not end the literal.
                if (next === quote) {
                    stripped += next;
                    index += 2;
                    continue;
                }

                quote = null;
            }

            index += 1;
            continue;
        }

        if (character === "'" || character === '"') {
            quote = character;
            stripped += character;
            index += 1;
            continue;
        }

        if (character === '-' && next === '-') {
            while (index < sql.length && sql[index] !== '\n') {
                index += 1;
            }

            continue;
        }

        if (character === '/' && next === '*') {
            index += 2;

            while (index < sql.length && !(sql[index] === '*' && sql[index + 1] === '/')) {
                index += 1;
            }

            index += 2;
            continue;
        }

        stripped += character;
        index += 1;
    }

    return stripped;
};

/**
 * Splits on a single-character delimiter that is outside every literal and,
 * when `respectParentheses` is set, outside every parenthesised group — which
 * is what separates the items of a `CREATE TABLE` body from the commas inside
 * an index expression or a default.
 */
const splitOutsideLiterals = (
    text: string,
    delimiter: string,
    respectParentheses: boolean,
): string[] => {
    const parts: string[] = [];
    let current = '';
    let depth = 0;
    let quote: string | null = null;

    for (let index = 0; index < text.length; index += 1) {
        const character = text[index];

        if (quote !== null) {
            current += character;

            if (character === quote) {
                if (text[index + 1] === quote) {
                    current += text[index + 1];
                    index += 1;
                    continue;
                }

                quote = null;
            }

            continue;
        }

        if (character === "'" || character === '"') {
            quote = character;
            current += character;
            continue;
        }

        if (respectParentheses && character === '(') {
            depth += 1;
        }

        if (respectParentheses && character === ')') {
            depth -= 1;
        }

        if (character === delimiter && (!respectParentheses || depth === 0)) {
            parts.push(current);
            current = '';
            continue;
        }

        current += character;
    }

    parts.push(current);

    return parts;
};

/** Items of a `CREATE TABLE` body that declare a constraint, not a column. */
const TABLE_CONSTRAINT_KEYWORDS: readonly string[] = Object.freeze([
    'constraint',
    'primary',
    'unique',
    'foreign',
    'check',
    'exclude',
    'like',
]);

// One capture group each, with the surrounding quotes optional rather than
// alternated, so a caller never has to choose between two groups.
const CREATE_TABLE_HEAD =
    /create\s+table\s+(?:if\s+not\s+exists\s+)?(?:only\s+)?"?([a-z_][a-z0-9_]*)"?\s*\(/i;
const ALTER_TABLE_HEAD = /alter\s+table\s+(?:if\s+exists\s+)?(?:only\s+)?"?([a-z_][a-z0-9_]*)"?/i;
const ADD_COLUMN_ITEM = /^add\s+column\s+(?:if\s+not\s+exists\s+)?"?([a-z_][a-z0-9_]*)"?/i;
const COLUMN_ITEM = /^"?([a-z_][a-z0-9_]*)"?\s+\S/i;

/**
 * Pure: every column a migration's SQL declares, as table -> column names.
 *
 * Deliberately conservative. Its only job is to turn "this database is not what
 * the migration describes" into "…and here is the column it is missing", so a
 * construct it cannot read costs the message a line of detail and never a false
 * refusal — the verdict is decided by checksums, above, not here. It reads the
 * two forms a Prisma migration uses: columns inside a `CREATE TABLE` body, and
 * `ALTER TABLE … ADD COLUMN`, including several `ADD COLUMN` items in one
 * statement.
 */
export const declaredColumnsFromMigrationSql = (sql: string): Map<string, Set<string>> => {
    const declared = new Map<string, Set<string>>();

    const record = (table: string, column: string): void => {
        const columns = declared.get(table) ?? new Set<string>();
        columns.add(column);
        declared.set(table, columns);
    };

    for (const rawStatement of splitOutsideLiterals(stripSqlComments(sql), ';', false)) {
        const statement = rawStatement.trim();

        if (statement.length === 0) {
            continue;
        }

        const createHead = CREATE_TABLE_HEAD.exec(statement);

        if (createHead !== null) {
            const table = createHead[1].toLowerCase();
            const bodyStart = createHead.index + createHead[0].length;
            const body = takeParenthesisedBody(statement, bodyStart);

            for (const rawItem of splitOutsideLiterals(body, ',', true)) {
                const item = rawItem.trim();
                const firstWord = item.split(/\s+/, 1)[0].replace(/"/g, '').toLowerCase();

                if (TABLE_CONSTRAINT_KEYWORDS.includes(firstWord)) {
                    continue;
                }

                const column = COLUMN_ITEM.exec(item);

                if (column !== null) {
                    record(table, column[1].toLowerCase());
                }
            }

            continue;
        }

        const alterHead = ALTER_TABLE_HEAD.exec(statement);

        if (alterHead === null) {
            continue;
        }

        const table = alterHead[1].toLowerCase();
        const actions = statement.slice(alterHead.index + alterHead[0].length);

        for (const rawAction of splitOutsideLiterals(actions, ',', true)) {
            const added = ADD_COLUMN_ITEM.exec(rawAction.trim());

            if (added !== null) {
                record(table, added[1].toLowerCase());
            }
        }
    }

    return declared;
};

/**
 * The text between the parenthesis that opened at `start - 1` and its match.
 * Depth-tracked and literal-aware, so a `DEFAULT '(x)'` or a nested type
 * cannot end the body early. An unbalanced statement yields what there is,
 * which is all this scanner's caller needs.
 */
const takeParenthesisedBody = (statement: string, start: number): string => {
    let depth = 1;
    let quote: string | null = null;

    for (let index = start; index < statement.length; index += 1) {
        const character = statement[index];

        if (quote !== null) {
            if (character === quote) {
                if (statement[index + 1] === quote) {
                    index += 1;
                    continue;
                }

                quote = null;
            }

            continue;
        }

        if (character === "'" || character === '"') {
            quote = character;
            continue;
        }

        if (character === '(') {
            depth += 1;
            continue;
        }

        if (character === ')') {
            depth -= 1;

            if (depth === 0) {
                return statement.slice(start, index);
            }
        }
    }

    return statement.slice(start);
};

/** How many missing columns the message lists before it summarises the rest. */
const MISSING_COLUMN_LIMIT = 12;

/** The two remedies, spelled once. `{database}` is substituted per target. */
const RECREATE_REMEDY = [
    'Recreate the test database and apply the ledger to it:',
    '    DROP DATABASE "{database}"; CREATE DATABASE "{database}";   (run from another database)',
    '    npx prisma migrate deploy',
];

const DEPLOY_REMEDY = [
    'Apply the ledger to it:',
    '    npx prisma migrate deploy',
    'If you applied prisma/manual-migrations/meal-planning/001_meal_planning.sql by hand instead, record',
    'that migration as applied so deploy does not re-run it:',
    '    npx prisma migrate resolve --applied <migration name>',
];

/**
 * Pure: the whole refusal, as ONE message.
 *
 * This is the function the whole gate exists for. It names the database and the
 * host, every migration in every category that failed with both checksums where
 * there are two, the columns the migration declares and the database does not
 * have, why `prisma migrate deploy` reports nothing to do, and the command that
 * fixes it. Nothing here reaches for the `DATABASE_URL`, for the same reason as
 * the identity guard: this text lands in CI logs and terminals.
 */
export const describeSchemaFreshnessRefusal = (input: {
    host: string;
    database: string;
    comparison: LedgerComparison;
    missingColumns: readonly string[];
}): string => {
    const { host, database, comparison, missingColumns } = input;
    const lines: string[] = [
        `Refusing to run the test suite against ${describeTarget(host, database)}: its migration ledger ` +
            'does not describe the migrations in prisma/migrations, so this database is not the ' +
            'schema this code expects.',
        '',
    ];

    for (const drift of comparison.drifted) {
        lines.push(
            `  ${drift.name} was applied from a different version of its migration file:`,
            `      recorded checksum ${drift.recordedChecksum}`,
            `      on-disk checksum  ${drift.onDiskChecksum}`,
        );
    }

    for (const name of comparison.unfinished) {
        lines.push(`  ${name} is recorded as started but never finished, or was rolled back.`);
    }

    for (const name of comparison.pending) {
        lines.push(`  ${name} is on disk and this database has no record of it.`);
    }

    for (const name of comparison.unknown) {
        lines.push(
            `  ${name} is recorded here and is not on disk, so this checkout is older than this database.`,
        );
    }

    if (missingColumns.length > 0) {
        lines.push(
            '',
            `  declared by the migrations above and missing from this database (${missingColumns.length}):`,
        );

        for (const column of missingColumns.slice(0, MISSING_COLUMN_LIMIT)) {
            lines.push(`      ${column}`);
        }

        if (missingColumns.length > MISSING_COLUMN_LIMIT) {
            lines.push(`      ... and ${missingColumns.length - MISSING_COLUMN_LIMIT} more`);
        }
    }

    lines.push('');

    // The sentence that saves the reader an hour: the obvious command reports
    // success against exactly this database, because a recorded NAME is all
    // `migrate deploy` looks at.
    if (comparison.drifted.length > 0 || comparison.unfinished.length > 0) {
        lines.push(
            '  "npx prisma migrate deploy" will not repair this. It compares migration NAMES, not',
            '  checksums, so against this database it reports nothing pending while the schema is wrong.',
        );
    }

    const remedy = comparison.kind === 'pending' ? DEPLOY_REMEDY : RECREATE_REMEDY;

    for (const line of remedy) {
        lines.push(`  ${line.replace(/\{database\}/g, database)}`);
    }

    return lines.join('\n');
};

/** What the gate reads from the database, and nothing more. */
export interface SchemaObservation {
    /** `null` when the database has no `_prisma_migrations` table at all. */
    ledger: readonly AppliedMigrationRow[] | null;
    /** Lower-cased table name -> the columns the database actually has. */
    columns: ReadonlyMap<string, ReadonlySet<string>>;
}

/**
 * How the gate observes a database. A parameter rather than a mock, so every
 * verdict below is reachable from a unit test that opens no connection — which
 * is what lets `testDb.test.ts` keep passing with no PostgreSQL running.
 */
export type SchemaReader = () => Promise<SchemaObservation>;

/** Both reads, capped: a stalled server must not stall 30 test files. */
const SCHEMA_READ_TIMEOUT_MS = 5_000;

/** The ledger Prisma maintains. Resolved through the search path, as pg does. */
const LEDGER_TABLE = '_prisma_migrations';

/** The one `pg` member this module uses, declared structurally for the same
 * reason as `TestPrismaClient` above — and because `pg` ships no types and
 * `@types/pg` is deliberately not a dependency of this repository. */
interface LedgerClient {
    connect(): Promise<void>;
    query(sql: string): Promise<{ rows: Array<Record<string, unknown>> }>;
    end(): Promise<void>;
}

interface PostgresModule {
    Client: new (config: {
        connectionString: string;
        connectionTimeoutMillis?: number;
        query_timeout?: number;
        application_name?: string;
    }) => LedgerClient;
}

/** `require`, not `import`, for the reason in this file's header. */
const requireLedgerClient = (connectionString: string): LedgerClient => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- a lazy load is the point; see above
    const postgres = require('pg') as PostgresModule;

    return new postgres.Client({
        connectionString,
        connectionTimeoutMillis: SCHEMA_READ_TIMEOUT_MS,
        query_timeout: SCHEMA_READ_TIMEOUT_MS,
        // Names this connection in pg_stat_activity, so a held connection is
        // attributable to the guard rather than to a suite.
        application_name: 'soh-test-db-guard',
    });
};

/**
 * One row per migration ATTEMPT, oldest first, which is the order
 * `compareMigrationLedger` relies on to let the last successful attempt
 * describe the database.
 */
const LEDGER_QUERY =
    'SELECT migration_name, checksum, finished_at IS NOT NULL AS finished, ' +
    `rolled_back_at IS NOT NULL AS rolled_back FROM ${LEDGER_TABLE} ORDER BY started_at`;

/** Reads the ledger into the comparison's row shape. Narrow on purpose: every
 * value is coerced here, so nothing downstream has to trust the driver's types. */
const readLedgerRows = async (client: LedgerClient): Promise<AppliedMigrationRow[]> =>
    (await client.query(LEDGER_QUERY)).rows.map((row) => ({
        name: String(row.migration_name),
        checksum: String(row.checksum),
        finished: row.finished === true,
        rolledBack: row.rolled_back === true,
    }));

/** A driver error's code, and never its message: those name users and hosts. */
const errorCodeOf = (error: unknown): string => {
    const code = (error as { code?: unknown } | null | undefined)?.code;

    return typeof code === 'string' && code.length > 0 ? code : 'unknown';
};

/**
 * The real reader: one connection, three cheap reads, always closed.
 *
 * Failures are classified rather than raised: a refused connection is a
 * developer without a container, and a ledger that cannot be read is a
 * permission or a shape this gate does not understand. Neither is evidence that
 * the schema is wrong, so both become a skip through `SchemaReadFailure`.
 */
export const createSchemaReader =
    (connectionString: string): SchemaReader =>
    async (): Promise<SchemaObservation> => {
        const client = requireLedgerClient(connectionString);

        try {
            await client.connect();
        } catch (error) {
            throw new SchemaReadFailure(`connection failed (${errorCodeOf(error)})`, 'unreachable');
        }

        try {
            // Presence first, because selecting from an absent table is an
            // ERROR that would read as "unreadable" when it means "not migrated
            // yet", and those two states take different exits below.
            const ledgerPresence = await client.query(
                `SELECT to_regclass('${LEDGER_TABLE}') IS NOT NULL AS present`,
            );
            const present = ledgerPresence.rows[0]?.present === true;
            const ledger = present ? await readLedgerRows(client) : null;

            const columnRows = await client.query(
                'SELECT table_name, column_name FROM information_schema.columns ' +
                    'WHERE table_schema = current_schema()',
            );

            const columns = new Map<string, Set<string>>();

            for (const row of columnRows.rows) {
                const table = String(row.table_name).toLowerCase();
                const existing = columns.get(table) ?? new Set<string>();
                existing.add(String(row.column_name).toLowerCase());
                columns.set(table, existing);
            }

            return { ledger, columns };
        } catch (error) {
            throw new SchemaReadFailure(
                `the migration ledger could not be read (${errorCodeOf(error)})`,
                'ledger_unreadable',
            );
        } finally {
            // Never leaves a handle behind: an open client here would keep a
            // Jest worker alive after its last test.
            await client.end().catch(() => undefined);
        }
    };

/** Verified, or not verified and why. A skip is never a failure. */
export type SchemaFreshnessResult =
    | { checked: true; target: string; migrations: number }
    | { checked: false; reason: SchemaFreshnessSkipReason; detail: string };

export interface SchemaFreshnessOptions {
    /** Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Defaults to `backend/prisma/migrations`. */
    migrationsDirectory?: string;
    /** Defaults to a real `pg` read of the `DATABASE_URL` above. */
    readSchema?: SchemaReader;
}

const FATAL_CODE_BY_KIND: Readonly<Record<Exclude<LedgerComparison['kind'], 'fresh'>, SchemaFreshnessCode>> =
    Object.freeze({
        drifted: 'schema_drifted',
        unfinished: 'migration_unfinished',
        pending: 'migration_pending',
        unknown_migration: 'migration_not_on_disk',
    });

/**
 * Pure: what the failing migrations declare that the database does not have.
 *
 * Only the migrations the comparison faulted are read, and a table that is
 * absent entirely is reported once as a table rather than as thirty missing
 * columns. `unknown` migrations are not read, because by definition there is no
 * file to read them from.
 */
export const missingDeclaredColumns = (
    fingerprints: readonly MigrationFingerprint[],
    comparison: LedgerComparison,
    observed: ReadonlyMap<string, ReadonlySet<string>>,
): string[] => {
    const faulted = new Set<string>([
        ...comparison.drifted.map((drift) => drift.name),
        ...comparison.unfinished,
        ...comparison.pending,
    ]);

    const missing = new Set<string>();

    for (const fingerprint of fingerprints) {
        if (!faulted.has(fingerprint.name)) {
            continue;
        }

        for (const [table, columns] of declaredColumnsFromMigrationSql(fingerprint.sql)) {
            const present = observed.get(table);

            if (present === undefined) {
                missing.add(`${table} (no such table)`);
                continue;
            }

            for (const column of columns) {
                if (!present.has(column)) {
                    missing.add(`${table}.${column}`);
                }
            }
        }
    }

    return [...missing].sort();
};

/**
 * The gate. Throws `SchemaFreshnessError` when the database claims a migration
 * state it does not have; returns a skip when there is nothing to compare.
 *
 * The identity half is NOT re-implemented: a `DATABASE_URL` the shared
 * classifier does not call a test database is `not_applicable` here, because
 * `assertTestDatabase` already refuses it and two refusals for one cause is one
 * message too many.
 */
export const assertSchemaFreshness = async (
    options: SchemaFreshnessOptions = {},
): Promise<SchemaFreshnessResult> => {
    const env = options.env ?? process.env;
    const databaseUrl = env[DATABASE_URL];

    if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
        return { checked: false, reason: 'not_applicable', detail: `${DATABASE_URL} is not set` };
    }

    const parsed = parseDatabaseUrl(databaseUrl);

    if (parsed === null || classifyDatabaseOrigin(databaseUrl).originClass !== 'test') {
        return {
            checked: false,
            reason: 'not_applicable',
            detail: `${DATABASE_URL} does not name a test database; the identity guard owns that refusal`,
        };
    }

    const target = describeTarget(parsed.host, parsed.database);
    const fingerprints = readMigrationFingerprints(options.migrationsDirectory);

    if (fingerprints.length === 0) {
        return {
            checked: false,
            reason: 'no_migrations',
            detail: `no migration is on disk under ${options.migrationsDirectory ?? MIGRATIONS_DIRECTORY}`,
        };
    }

    let observation: SchemaObservation;

    try {
        const read = options.readSchema ?? createSchemaReader(databaseUrl);
        observation = await read();
    } catch (error) {
        // Fails OPEN, deliberately: 25 of the 30 test files never open a
        // connection, and a developer running those without a database must not
        // be stopped by a check that could not run. The command form prints
        // this, so it is never silent in the place where it matters.
        return {
            checked: false,
            reason: error instanceof SchemaReadFailure ? error.reason : 'ledger_unreadable',
            detail: `${target}: ${error instanceof Error ? error.message : String(error)}`,
        };
    }

    if (observation.ledger === null || observation.ledger.length === 0) {
        return {
            checked: false,
            reason: 'no_ledger',
            detail:
                `${target} has no applied migration to compare. Run "npx prisma migrate deploy" against ` +
                'it before the suites that need a database.',
        };
    }

    const comparison = compareMigrationLedger(fingerprints, observation.ledger);

    if (comparison.kind === 'fresh') {
        return { checked: true, target, migrations: fingerprints.length };
    }

    throw new SchemaFreshnessError(
        describeSchemaFreshnessRefusal({
            host: parsed.host,
            database: parsed.database,
            comparison,
            missingColumns: missingDeclaredColumns(fingerprints, comparison, observation.columns),
        }),
        FATAL_CODE_BY_KIND[comparison.kind],
    );
};

/**
 * The ambient check, run at most once per module instance.
 *
 * Jest gives every test file its own module registry, so this dedupes the two
 * callers within one file — `jestSetup.ts` before the first test, and
 * `truncateFeatureTables` before it destroys anything — rather than across
 * files. One connection per file, closed immediately, is the whole cost.
 */
let ambientCheck: Promise<SchemaFreshnessResult> | undefined;

export const assertSchemaFreshnessOnce = (): Promise<SchemaFreshnessResult> => {
    if (ambientCheck === undefined) {
        ambientCheck = assertSchemaFreshness();
    }

    return ambientCheck;
};

/** Where a caller may point the gate at a different ledger. */
export const MIGRATIONS_DIRECTORY_FLAG = '--migrations';

/** Just enough of `console` to be substitutable in a test. */
export interface CommandOutput {
    log(line: string): void;
    warn(line: string): void;
    error(line: string): void;
}

/**
 * The command form, which `npm run check:test-db` runs and `pretest` runs
 * before Jest starts. It exists so `npm test` against a stale database says one
 * thing once, instead of saying nothing and letting every suite fail.
 *
 * Exit codes: 1 for a refusal (either gate), 0 for verified and 0 for a skip —
 * a skip is printed as a warning and carries the command that would fix it.
 *
 * `output` and `overrides` are parameters rather than module state so the whole
 * command, including its exit codes, is reachable from a test that opens no
 * connection. An explicit `--migrations` on the command line outranks
 * `overrides.migrationsDirectory`: it is what the operator typed.
 */
export const runSchemaFreshnessCommand = async (
    argv: readonly string[] = process.argv.slice(2),
    output: CommandOutput = console,
    overrides: SchemaFreshnessOptions = {},
): Promise<number> => {
    let migrationsDirectory: string | undefined = overrides.migrationsDirectory;
    const flagIndex = argv.indexOf(MIGRATIONS_DIRECTORY_FLAG);

    if (flagIndex !== -1) {
        const value = argv[flagIndex + 1];

        if (value === undefined || value.startsWith('--')) {
            output.error(
                `${MIGRATIONS_DIRECTORY_FLAG} needs a directory holding the migrations to compare against.`,
            );

            return 1;
        }

        migrationsDirectory = value;
    }

    // The identity gate first, and through the same function the suite uses, so
    // the command cannot disagree with the harness about what is safe.
    try {
        assertTestDatabase(overrides.env);
    } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));

        return 1;
    }

    try {
        const result = await assertSchemaFreshness({ ...overrides, migrationsDirectory });

        if (result.checked) {
            output.log(
                `test-database check: ${result.target} matches prisma/migrations ` +
                    `(${result.migrations} migration${result.migrations === 1 ? '' : 's'}).`,
            );

            return 0;
        }

        output.warn(`test-database check: not verified (${result.reason}) - ${result.detail}`);

        return 0;
    } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));

        return 1;
    }
};

// Only when this file IS the program. Under Jest, `require.main` is the runner,
// so importing this module never starts the command.
if (require.main === module) {
    void runSchemaFreshnessCommand().then((code) => {
        // `exitCode` rather than `exit`: stdout is a pipe under npm, and exiting
        // outright can truncate the one message this command exists to print.
        process.exitCode = code;
    });
}

