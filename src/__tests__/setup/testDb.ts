/**
 * The test-database guards, and the only place the suite is allowed to destroy
 * data (Agent Action Plan §0.7.1 / §0.9.1).
 *
 * Three questions, in this order, all answered before a test destroys anything:
 *
 *   1. `assertTestDatabase` — IDENTITY, from the URL. May this run destroy this
 *      database? Pure and synchronous, so it can run before any driver loads.
 *   2. `assertSessionTarget` — IDENTITY, from the SERVER. Is the session the
 *      suite gets the `public` schema of that same database? A `search_path`
 *      default set on the role or the database redirects every unqualified
 *      statement while leaving the URL untouched, so the string gate above
 *      cannot see it and only a live session can. That section's own header
 *      carries the measurement; it refuses rather than skips.
 *   3. `assertSchemaFreshness` — SHAPE. Is this database the schema the code
 *      expects? See that section's own header for why identity alone is not
 *      enough, and `runSchemaFreshnessCommand` at the foot of this file for the
 *      command form.
 *
 * (1) runs for every test file, from `jestSetup.ts`, before anything else in the
 * process. (3) runs there too, asynchronously. (2) runs where data is about to
 * be destroyed — `truncateFeatureTables`, which every DB-backed suite calls
 * before it touches data — because it needs a connection and the pure-logic
 * files never open one.
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
    CONFIRM_TARGET_FLAG as DB_GUARD_CONFIRM_TARGET_FLAG,
    DEFAULT_SCHEMA,
    LOCAL_HOSTS,
    TEST_DATABASE_SUFFIX,
    classifyDatabaseOrigin,
    findConnectionRedirectingParams,
    findSchemaRedirectingParams,
    hasEncodedDatabaseName,
    isLocalDatabaseHost,
    isTestDatabaseName,
    parseConfirmTarget,
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

    // Four forms of "the URL does not determine its own target", all refused
    // before any host or name rule is applied, because in each of them what the
    // rules would judge is not what the driver would destroy:
    //
    //  - a query string carrying libpq's connection keywords (`?host=`,
    //    `?dbname=`, `?service=`…), which move the connection somewhere other
    //    than the authority the URL displays;
    //  - a percent-escape in the database name, which Prisma opens literally
    //    while `pg` decodes it — two different databases, one spelling;
    //  - no authority at all, which leaves the server to PGHOST or a socket;
    //  - a query string that redirects the SCHEMA (`?schema=`, `?options=-c
    //    search_path=…`), which leaves the database exactly where the URL says
    //    it is and moves the tables. That one is this guard's own business
    //    rather than a general tidiness rule: `truncateFeatureTables` below
    //    empties tables by name, and a redirected search path was measured to
    //    make that statement empty another schema's copies of them — under
    //    Prisma AND under `pg` — inside a database whose `_test` name passes
    //    every rule here. The statement is schema-qualified as well (see
    //    `qualifiedTable`), so this refusal and that qualification are two
    //    independent answers to the same question.
    //
    // Each is refused rather than classified, so the answer cannot be wrong in
    // the dangerous direction. The predicates come from the same shared module
    // as the rules, so this stays one derivation rather than two.
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

    const schemaParams = findSchemaRedirectingParams(databaseUrl);
    if (schemaParams.length > 0) {
        throw new TestDatabaseGuardError(
            `Refusing to run the test suite: ${DATABASE_URL} redirects the schema ` +
                `(${schemaParams.join(', ')}), so the tables this suite would empty are not the ` +
                `${DEFAULT_SCHEMA} tables of database "${parsed.database}". Remove those parameters; the ` +
                `${DEFAULT_SCHEMA} schema is the one the migrations create.`,
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
 * Double-quotes one identifier. Nothing a caller supplies ever reaches this —
 * `truncateFeatureTables` takes no arguments — and the pattern check is the
 * second lock: an identifier that is not a plain lower-case one fails loudly
 * instead of being quoted into a statement.
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
 * One table of `FEATURE_TABLES`, SCHEMA-QUALIFIED.
 *
 * The qualification is the point, not decoration. An unqualified `"users"`
 * resolves through the session's `search_path`, and a `DATABASE_URL` can move
 * that: measured on PostgreSQL 16.15, `…/soh_test_34?schema=live` (Prisma) and
 * `…/soh_test_34?options=-c search_path=live` (Prisma and `pg` alike) both made
 * `TRUNCATE TABLE "probe_rows" CASCADE` empty `live.probe_rows` and leave
 * `public.probe_rows` untouched — from a URL whose `_test` name and local host
 * satisfy every rule in `assertTestDatabase`. Naming the schema means this
 * statement destroys the tables the migrations created and no others,
 * whatever a session setting says.
 *
 * `assertTestDatabase` refuses those URLs outright as well. That is deliberate
 * duplication: the guard stops a redirected URL from reaching a suite at all,
 * and this stops the one statement that destroys data from following a
 * `search_path` set any other way — a `PGOPTIONS` in the environment, a `SET
 * search_path` left by earlier SQL, or an `ALTER ROLE … SET search_path` on the
 * role the suite connects as. Neither answer depends on the other.
 */
const qualifiedTable = (table: string): string => `${quoteIdentifier(DEFAULT_SCHEMA)}.${quoteIdentifier(table)}`;

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
 * `FEATURE_TABLES` constant through `qualifiedTable` — which names the schema,
 * so the statement cannot follow a redirected `search_path` — and from nothing
 * else.
 *
 * The session gate and the schema gate below run here too, and for the same
 * reason the identity guard does: this function is the one place that reaches a
 * database without `jestSetup.ts` having run first — a suite importing this
 * module directly, or a Jest configuration that ever loses its `setupFiles`
 * entry, would otherwise truncate and query a database nobody checked the
 * identity or the shape of. Both are memoised, so in the normal case where the
 * setup file already ran, the whole of a second and later call is three string
 * comparisons.
 *
 * The session gate runs FIRST of the two, and it is what makes this function
 * the harness's single protection for the DB-backed suites rather than only for
 * its own statement: those suites issue unqualified raw DML of their own, which
 * a schema-qualified `TRUNCATE` cannot protect, and every one of them calls this
 * function before it touches data. It refuses — it never skips — so a redirected
 * session stops the run here instead of quietly following the redirect. The
 * order also keeps the shape verdict honest: the schema gate reports on a
 * database whose identity this run has confirmed over a connection.
 */
export const truncateFeatureTables = async (): Promise<void> => {
    assertTestDatabase();
    await assertSessionTargetOnce();
    await assertSchemaFreshnessOnce();

    const prisma = requirePrismaClient();

    await prisma.$executeRawUnsafe(truncateFeatureTablesStatement());
};

/**
 * The exact statement `truncateFeatureTables` executes, exported so a test can
 * assert on it without a database — the schema qualification is a safety
 * property, and a property nothing reads is a property that regresses.
 */
export const truncateFeatureTablesStatement = (): string =>
    `TRUNCATE TABLE ${FEATURE_TABLES.map(qualifiedTable).join(', ')} CASCADE`;

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

/**
 * The two remedies, spelled once. `{database}` is substituted per target.
 *
 * The recreate names THE GUARDED COMMAND at the foot of this file rather than a
 * bare `DROP DATABASE`. A hand-typed drop is checked by nothing — a `_test` name
 * on a tunnelled or forwarded production server satisfies every rule a person
 * can apply by eye — while `--recreate` re-runs the identity gate, demands the
 * target be named on the command line, reads the target back over a real
 * connection, and applies the ledger from a `DATABASE_URL` it derives itself.
 * This text is where an operator meets the repair, so it is where the safe form
 * has to be.
 */
const RECREATE_REMEDY = [
    'Recreate the test database with the guarded command, which re-runs this gate\'s identity checks,',
    'reads the target back before it drops anything, and applies the ledger to the fresh database:',
    '    NODE_ENV=test ALLOW_DB_TRUNCATE=true \\',
    '      npx ts-node --project tsconfig.test.json src/__tests__/setup/testDb.ts \\',
    '      --recreate --confirm-target {database}',
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

/**
 * The ledger Prisma maintains, SCHEMA-QUALIFIED for the same reason
 * `qualifiedTable` qualifies the truncation: this gate's verdict is about the
 * schema the suite's own statements reach, and a `search_path` set anywhere
 * outside the URL would otherwise point the read at a different schema's ledger
 * — reporting a database fresh, or reporting no ledger at all, on the strength
 * of tables the suite never touches.
 */
const LEDGER_TABLE = `${DEFAULT_SCHEMA}._prisma_migrations`;

/**
 * The three `pg` members this module uses, declared structurally for the same
 * reason as `TestPrismaClient` above — and because `pg` ships no types and
 * `@types/pg` is deliberately not a dependency of this repository.
 *
 * Exported because the recreate command at the foot of this file takes an
 * opener of this shape as a parameter, which is what lets every one of its
 * refusals be asserted without a PostgreSQL server — and, more importantly,
 * lets a test assert that a refused recreate issued no statement at all.
 */
export interface PostgresSession {
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
    }) => PostgresSession;
}

/** Names the schema gate's connection in `pg_stat_activity`. */
const LEDGER_APPLICATION_NAME = 'soh-test-db-guard';

/**
 * One `pg` session. `require`, not `import`, for the reason in this file's
 * header; the application name and the timeouts are the caller's, because the
 * schema gate reads two cheap columns while the recreate waits on DDL.
 */
const requirePostgresSession = (
    connectionString: string,
    applicationName: string,
    timeoutMs: number,
): PostgresSession => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires -- a lazy load is the point; see above
    const postgres = require('pg') as PostgresModule;

    return new postgres.Client({
        connectionString,
        connectionTimeoutMillis: timeoutMs,
        query_timeout: timeoutMs,
        // Names this connection in pg_stat_activity, so a held connection is
        // attributable to the guard rather than to a suite.
        application_name: applicationName,
    });
};

const requireLedgerClient = (connectionString: string): PostgresSession =>
    requirePostgresSession(connectionString, LEDGER_APPLICATION_NAME, SCHEMA_READ_TIMEOUT_MS);

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
const readLedgerRows = async (client: PostgresSession): Promise<AppliedMigrationRow[]> =>
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

            // `table_schema = '<DEFAULT_SCHEMA>'` rather than
            // `current_schema()`, so the columns compared are the ones the
            // suite's own statements resolve to (see `LEDGER_TABLE`). The value
            // is this repository's compile-time constant, not input: `pg`'s
            // query surface here takes SQL only, and a schema name that were
            // ever not a plain identifier would fail `quoteIdentifier` in
            // `qualifiedTable` long before this read.
            const columnRows = await client.query(
                'SELECT table_name, column_name FROM information_schema.columns ' +
                    `WHERE table_schema = '${DEFAULT_SCHEMA}'`,
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

/** What a developer without a running database is told to do about it. */
const UNREACHABLE_REMEDY =
    'Start the PostgreSQL server that URL names and run this again; the suites that need no database run ' +
    'without it.';

/**
 * The gate. Throws `SchemaFreshnessError` when the database claims a migration
 * state it does not have; returns a skip when there is nothing to compare.
 *
 * The identity half is NOT re-implemented: a `DATABASE_URL` the shared
 * classifier does not call a test database is `not_applicable` here, because
 * `assertTestDatabase` already refuses it and two refusals for one cause is one
 * message too many.
 *
 * Every skip's `detail` names the target it judged, and the three with an
 * unambiguous remedy carry it: `no_ledger` the deploy that populates an empty
 * ledger, `no_migrations` the directory it scanned and the flag that points it
 * elsewhere, `unreachable` the server to start. `ledger_unreadable` carries the
 * driver's error instead, because a permission, an unexpected shape and a
 * timeout do not share a fix, and `not_applicable` carries neither — the
 * identity guard owns that URL.
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
            detail:
                `no migration is on disk under ${options.migrationsDirectory ?? MIGRATIONS_DIRECTORY}. ` +
                `Run this from the backend package root, or pass ${MIGRATIONS_DIRECTORY_FLAG} <directory> ` +
                'to compare against the ledger you mean.',
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
        const reason = error instanceof SchemaReadFailure ? error.reason : 'ledger_unreadable';
        const detail = `${target}: ${error instanceof Error ? error.message : String(error)}`;

        // A refused connection has one remedy and it is worth printing. An
        // unreadable ledger does not: the read failed for a permission, a shape
        // or a timeout, and which of those it was decides what to do about it,
        // so the driver's own error is the whole of what this can honestly say.
        return {
            checked: false,
            reason,
            detail: reason === 'unreachable' ? `${detail}. ${UNREACHABLE_REMEDY}` : detail,
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

/* -------------------------------------------------------------------------- *
 * The third gate: is the session the suite actually GETS that database's
 * `public` schema?
 *
 * `assertTestDatabase` reads a string, and a string is all it can read. It runs
 * before `@prisma/client` can load, which is the property that makes it worth
 * having, and the price of that property is that it cannot ask the server
 * anything. Everything it judges — host, database name, redirecting parameters —
 * is what the URL SAYS.
 *
 * A server-side default says nothing in the URL and moves the tables anyway.
 * Measured on PostgreSQL 16.15 against a clean `…/<db>_test` URL with no query
 * string at all:
 *
 *     ALTER ROLE <role> IN DATABASE <db> SET search_path = live, public;
 *     ALTER DATABASE <db> SET search_path = live, public;
 *
 * Either one leaves every rule above satisfied — there is nothing in the URL to
 * refuse — while the session that arrives reports `current_schema() = live` and
 * `search_path = live, public`. `truncateFeatureTables` survives that because
 * its statement names the schema (see `qualifiedTable`), but the suites this
 * harness serves also issue UNQUALIFIED raw DML — `UPDATE meal_plan_meals …`,
 * `SELECT … FROM meal_plan_preferences … FOR UPDATE`, `UPDATE users …` — and
 * every one of those follows the redirect to another schema's copies of those
 * tables. A run like that reads and writes data no assertion in the suite is
 * looking at.
 *
 * So the session is ASKED, once, over a real connection, and both halves must
 * hold: `current_database()` is the database the URL literally names, and
 * `current_schema()` is `public`. Anything else is a HARD REFUSAL — an error
 * that stops the run — and deliberately NOT one of the schema gate's skips: a
 * skip would let the run continue against the redirected schema, which is the
 * outcome this gate exists to prevent. An unreadable session is refused for the
 * same reason: this check sits immediately before a `TRUNCATE … CASCADE`, so a
 * session whose database and schema are unknown is a session nothing is
 * destroyed through.
 *
 * It is wired into `truncateFeatureTables`, which is the one function every
 * DB-backed suite calls before it touches data — so the refusal covers suites
 * this file never names, without their having to opt in. The `--recreate`
 * command at the foot of this file asks the same two questions of its own
 * read-back session (`target_database_mismatch`, `target_schema_redirected`),
 * with the server fingerprint on top, and keeps its own refusals: it must judge
 * a target it is about to DROP rather than one it is about to empty.
 *
 * The session reader below is shared with that read-back rather than written
 * twice, and `pg` is still required lazily inside `requirePostgresSession`, so
 * this section adds nothing to the module graph that could reach a database on
 * import.
 * -------------------------------------------------------------------------- */

/** What a session answered about itself and the server it reached. */
export interface SessionIdentity {
    /** `current_database()` — the database actually reached. */
    database: string;
    /** `current_schema()` — where an unqualified statement resolves. */
    schema: string;
    /** `current_setting('search_path')`, reported so a refusal can explain itself. */
    searchPath: string;
    role: string;
    serverVersion: string;
    /**
     * `inet_server_addr()` / `inet_server_port()`: recorded, and compared only
     * between the recreate's OWN two sessions — never with the URL. Measured
     * through the published port of a container, the server reports its own
     * address and port (172.17.0.2:5432) while the URL names the published pair
     * (127.0.0.1:5433), so an equality check against the URL would refuse a
     * legitimate local target. Both are `null` for a session that arrived over a
     * Unix socket, where the server reports neither.
     */
    serverAddress: string | null;
    serverPort: number | null;
    /**
     * `pg_postmaster_start_time()` — the running cluster's own identity, and
     * readable by an unprivileged role (unlike `pg_control_system()`). Together
     * with the version and the reported address it is what makes "the server the
     * `DROP` reaches is the server the read-back verified" a checked fact rather
     * than an assumption about two connection strings.
     */
    postmasterStartTime: string;
}

/**
 * One round trip, answering both gates' questions. Shared by the session gate
 * below and by the recreate's read-back, which is why it reads the server's
 * fingerprint columns that only the recreate compares: two queries would be two
 * things to keep in step, and the four extra columns cost nothing.
 */
const SESSION_IDENTITY_QUERY = [
    'SELECT current_database() AS database,',
    '       current_schema() AS schema,',
    '       current_user AS role,',
    '       version() AS server_version,',
    '       inet_server_addr()::text AS server_address,',
    '       inet_server_port() AS server_port,',
    '       pg_postmaster_start_time()::text AS postmaster_start_time,',
    "       current_setting('search_path') AS search_path",
].join('\n');

const readIdentityString = (row: Record<string, unknown>, column: string): string => {
    const value = row[column];

    return typeof value === 'string' ? value : '';
};

const readIdentityOptionalString = (row: Record<string, unknown>, column: string): string | null => {
    const value = row[column];

    return typeof value === 'string' && value.length > 0 ? value : null;
};

const readIdentityOptionalNumber = (row: Record<string, unknown>, column: string): number | null => {
    const value = row[column];

    if (typeof value === 'number' && Number.isFinite(value)) {
        return value;
    }

    if (typeof value === 'string' && value.trim().length > 0 && Number.isFinite(Number(value))) {
        return Number(value);
    }

    return null;
};

/**
 * Asks an OPEN session what it is. Every value is coerced here, so nothing
 * downstream has to trust the driver's types, and a server that answers with no
 * row at all is a failure rather than an empty identity that would compare
 * unequal to everything.
 */
const askSessionIdentity = async (session: PostgresSession): Promise<SessionIdentity> => {
    const result = await session.query(SESSION_IDENTITY_QUERY);
    const row = result.rows.length > 0 ? result.rows[0] : undefined;

    if (row === undefined) {
        throw new Error('the server returned no row for its own identity');
    }

    return {
        database: readIdentityString(row, 'database'),
        schema: readIdentityString(row, 'schema'),
        searchPath: readIdentityString(row, 'search_path'),
        role: readIdentityString(row, 'role'),
        serverVersion: readIdentityString(row, 'server_version'),
        serverAddress: readIdentityOptionalString(row, 'server_address'),
        serverPort: readIdentityOptionalNumber(row, 'server_port'),
        postmasterStartTime: readIdentityString(row, 'postmaster_start_time'),
    };
};

/**
 * Opens one session, asks it what it is, and always hangs up.
 *
 * The connection is closed before the caller acts on the answer. For the
 * session gate that keeps the cost at one short-lived connection per test file;
 * for the recreate it is what lets the target be read back and then dropped,
 * because `DROP DATABASE` fails while any session — including that command's
 * own — is connected to it.
 */
const readSessionIdentity = async (session: PostgresSession): Promise<SessionIdentity> => {
    try {
        await session.connect();

        return await askSessionIdentity(session);
    } finally {
        // Never leaves a handle behind, and never replaces the verdict with a
        // failure to hang up: the caller either refuses with what it learned or
        // proceeds, and neither outcome depends on the hang-up.
        await session.end().catch(() => undefined);
    }
};

/** How a gate opens a session. A parameter, so every refusal is testable. */
export type PostgresSessionOpener = (connectionString: string) => PostgresSession;

/** Names the session gate's connection in `pg_stat_activity`. */
const SESSION_GUARD_APPLICATION_NAME = 'soh-test-db-session-guard';

/**
 * The same budget as the schema gate's read, and for a stronger reason: this
 * check runs immediately before the truncation, so a server that cannot answer
 * one round trip inside it is a server the truncation would not complete
 * against either.
 */
const SESSION_READ_TIMEOUT_MS = 5_000;

/** Which condition refused the run. Stable strings, as everywhere above. */
export type TestDatabaseSessionCode =
    /** The session could not be opened, or could not be asked what it reached. */
    | 'session_unreadable'
    /** The session reached a different database than the URL names. */
    | 'session_database_mismatch'
    /** Unqualified statements in this session resolve outside `public`. */
    | 'session_schema_redirected';

/**
 * The session gate's refusal. Carries the failing condition as a code and a
 * message naming the host, the database and what the session answered — never
 * the `DATABASE_URL`, for the same reason `TestDatabaseGuardError` never does:
 * that string carries the user and the password, and this message reaches a
 * terminal, a Jest reporter and CI logs.
 */
export class TestDatabaseSessionError extends Error {
    constructor(
        message: string,
        public readonly code: TestDatabaseSessionCode,
    ) {
        super(message);
        this.name = 'TestDatabaseSessionError';
    }
}

export interface SessionTargetOptions {
    /** Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Defaults to a real `pg` session on the `DATABASE_URL` the env holds. */
    openSession?: PostgresSessionOpener;
}

/** What one verified session reached. Returned so a caller can report it. */
export interface SessionTargetVerification {
    /** `database "x" on host "y"`, as every message in this module spells it. */
    target: string;
    /** `current_database()`, equal to the name the URL carries. */
    database: string;
    /** `current_schema()`, equal to `DEFAULT_SCHEMA`. */
    schema: string;
    /** `search_path` as the session reported it, for the verified log line. */
    searchPath: string;
    /** `current_user`, which is the role a refusal would tell an operator to reset. */
    role: string;
}

const openSessionGuardSession: PostgresSessionOpener = (connectionString) =>
    requirePostgresSession(connectionString, SESSION_GUARD_APPLICATION_NAME, SESSION_READ_TIMEOUT_MS);

/** How a refusal spells a `current_schema()` the server answered as NULL. */
const NO_REACHABLE_SCHEMA = '(none)';

/**
 * What a read failure may be quoted as. A driver error that carries a SQLSTATE
 * is reported BY THAT CODE and never by its text: `28P01` arrives as
 * `password authentication failed for user "soh"`, which would put the database
 * user in a message this module promises never to name one in. Everything else —
 * a timeout, a socket error, this module's own "no identity row" — carries no
 * code and no identity either, so its message is the honest detail.
 */
const describeSessionReadFailure = (error: unknown): string => {
    const code = errorCodeOf(error);

    if (code !== 'unknown') {
        return `driver error ${code}`;
    }

    return error instanceof Error && error.message.length > 0 ? error.message : 'no reason given';
};

/**
 * Asks the session the suite will use what it actually reached, and refuses
 * unless it is the `public` schema of the database the URL names.
 *
 * Runs `assertTestDatabase` first, through the same function every other caller
 * uses: a URL this module would refuse must not be opened in order to be
 * measured. Both dependencies that could reach a server — the environment and
 * the session opener — are parameters, so every refusal below is reachable from
 * a unit test that opens no connection.
 *
 * Throws `TestDatabaseGuardError` (identity, from the string gate) or
 * `TestDatabaseSessionError` (this gate). Returns what it verified on success.
 */
export const assertSessionTarget = async (
    options: SessionTargetOptions = {},
): Promise<SessionTargetVerification> => {
    const env = options.env ?? process.env;

    assertTestDatabase(env);

    // Non-null after the gate: it refuses an unset, blank or unparsable URL.
    const databaseUrl = env[DATABASE_URL] as string;
    const parsed = parseDatabaseUrl(databaseUrl) as { host: string; database: string; port: string };
    const target = describeTarget(parsed.host, parsed.database);
    const openSession = options.openSession ?? openSessionGuardSession;

    let identity: SessionIdentity;

    try {
        identity = await readSessionIdentity(openSession(databaseUrl));
    } catch (error) {
        throw new TestDatabaseSessionError(
            `Refusing to run the test suite against ${target}: the session could not be asked which ` +
                `database and schema it reaches (${describeSessionReadFailure(error)}). The suite empties ` +
                'every table this feature owns, so a session that cannot answer that is not one this ' +
                'harness destroys data through. Start the PostgreSQL server that URL names, and check the ' +
                'credentials in it.',
            'session_unreadable',
        );
    }

    if (identity.database !== parsed.database) {
        throw new TestDatabaseSessionError(
            `Refusing to run the test suite against ${target}: the session reached database ` +
                `"${identity.database}" instead. What this run would empty is not what ${DATABASE_URL} ` +
                'displays, so the name in it is not the target. Point it directly at the database, with ' +
                'no connection parameters and no PG* variable in the environment.',
            'session_database_mismatch',
        );
    }

    if (identity.schema !== DEFAULT_SCHEMA) {
        const reached = identity.schema.length > 0 ? `"${identity.schema}"` : NO_REACHABLE_SCHEMA;

        throw new TestDatabaseSessionError(
            `Refusing to run the test suite against ${target}: an unqualified statement in this session ` +
                `resolves in schema ${reached} rather than ${DEFAULT_SCHEMA} (search_path is ` +
                `"${identity.searchPath}"), and the suites issue unqualified SQL — so this run would read ` +
                `and write another schema's copies of these tables. Nothing in ${DATABASE_URL} shows ` +
                'that; a server-side default does it. Reset both of the two that can: ' +
                `ALTER ROLE ${identity.role} IN DATABASE ${identity.database} RESET search_path, and ` +
                `ALTER DATABASE ${identity.database} RESET search_path. A PGOPTIONS in the environment ` +
                'does it too.',
            'session_schema_redirected',
        );
    }

    return {
        target,
        database: identity.database,
        schema: identity.schema,
        searchPath: identity.searchPath,
        role: identity.role,
    };
};

/**
 * The session check, run at most once per module instance.
 *
 * Memoised exactly the way `assertSchemaFreshnessOnce` is, and for the same
 * reason: Jest gives every test file its own module registry, so a DB-backed
 * file that truncates in every `beforeEach` pays one connection and one round
 * trip for the whole file rather than one per test. Pure-logic files never call
 * it at all, because they never truncate.
 *
 * The REFUSAL is memoised too, deliberately: a redirect does not move between
 * two tests of one file, so every later `beforeEach` refuses with the same
 * message instead of opening another connection to re-measure it.
 */
let sessionCheck: Promise<SessionTargetVerification> | undefined;

export const assertSessionTargetOnce = (): Promise<SessionTargetVerification> => {
    if (sessionCheck === undefined) {
        sessionCheck = assertSessionTarget();
    }

    return sessionCheck;
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
 * The command form: the standalone diagnostic an operator runs to ask the URL
 * and the shape questions without running the suite, invoked directly rather
 * than through a package script, so nothing is attached to the `npm test`
 * lifecycle:
 *
 *   npx ts-node --project tsconfig.test.json src/__tests__/setup/testDb.ts
 *
 * It answers "is this database ready for the suite" in one message. The suite
 * itself does not depend on it — `jestSetup.ts` runs those two gates as a
 * `setupFiles` entry, before any application module loads — so this is a way to
 * ask early, not a second owner of pre-test safety. It is the DIAGNOSIS half of
 * the module's command line; `--recreate` is the repair, dispatched by
 * `runTestDbCommand` at the foot of this file.
 *
 * The session gate is deliberately NOT one of the two asked here, and the
 * reason is this command's fail-open contract: a developer with no database must
 * get a warning and a zero exit, while the session gate refuses a session it
 * cannot read because a truncation is about to follow it. Mixing the two would
 * mean either a hard failure for a developer who only wanted the diagnosis, or a
 * skip in the one gate that must never skip. It is asked where it belongs —
 * `truncateFeatureTables`, immediately before the data is destroyed — and
 * `--recreate` asks the same two questions of its own read-back.
 *
 * Exit codes: 1 for a refusal (either gate), 0 for verified and 0 for a skip.
 *
 * A skip is printed as ONE warning naming its reason and the target it judged.
 * Three of the four skips reachable here also carry what to do about it:
 * `no_ledger` the `npx prisma migrate deploy` that fills an empty ledger,
 * `no_migrations` the directory that was scanned and the `--migrations` flag
 * that points the comparison elsewhere, and `unreachable` the server to start.
 * The fourth, `ledger_unreadable`, carries the driver's own error and no
 * command, because a permission, a shape this gate does not understand and a
 * timeout do not share a remedy — naming one would be a guess in a message
 * whose whole value is that it is not. (`not_applicable` is unreachable from
 * here: every URL that would produce it is refused by the identity gate above
 * first.)
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

/* -------------------------------------------------------------------------- *
 * `--recreate`: the guarded way to replace a stale test database.
 *
 * The schema gate above diagnoses a database that claims a migration state it
 * does not have, and for a drifted or unfinished ledger the only repair is to
 * drop the database and apply the ledger to a fresh one. That operation used to
 * live in `README.md` as raw `psql`: a `grep` for a `_test` suffix, then
 * `DROP DATABASE`, then a bare `npx prisma migrate deploy`. A name suffix says
 * nothing about WHICH SERVER answers — an SSH tunnel or a forwarded container
 * port puts a production server on `127.0.0.1`, and this project's development
 * environment exports a production `DATABASE_URL` into every new shell that
 * does not override it — so that block could drop a production database and
 * redeploy into it while satisfying every rule it checked.
 *
 * This is the executable answer. Three independent gates settle the target
 * before a single `DROP` is issued, and the replay that follows is pointed at a
 * URL this code derives rather than one it inherits:
 *
 *   1. `assertTestDatabase` — the same identity gate the suite passes, which is
 *      the shared `scripts/lib/dbGuard.ts` rule set (local host, `_test`/`ci`
 *      name, no connection- or schema-redirecting parameters, no percent-encoded
 *      name). Nothing here re-derives any of it.
 *   2. `--confirm-target <database>` — the operator TYPES the name, and it must
 *      equal the one the URL names, through dbGuard's own `parseConfirmTarget`.
 *      This is what an ambient `DATABASE_URL` cannot satisfy: a URL nobody read
 *      is a URL nobody confirmed.
 *   3. A READ-BACK over a real connection to the target itself. Parsing a string
 *      is not enough for an operation that drops a database: the session reports
 *      `current_database()` and `current_schema()`, and a target that answers
 *      with a different name, or whose unqualified statements resolve outside
 *      `public` (an `ALTER ROLE … SET search_path` is invisible in any URL), is
 *      refused. The server's own fingerprint is read here and compared with the
 *      maintenance session's, so the `DROP` cannot be issued to a different
 *      server than the one that was verified.
 *   4. `prisma migrate deploy` runs against a `DATABASE_URL` this code DERIVES
 *      from the validated target and hands to the child process, so the replay
 *      cannot follow whatever the ambient environment held.
 *
 * Every refusal carries a stable code and names the host and the database, the
 * way `assertTestDatabase` does, and none of them reaches the `DROP`.
 * `testDb.test.ts` measures that twice: in process, through sessions that record
 * every statement they are given (an empty record is the proof), and from a
 * child process for the identity and confirmation refusals, where no driver
 * load and no socket is the same proof one level further out.
 * -------------------------------------------------------------------------- */

/** Asks the command form for the recreate rather than the diagnosis. */
export const RECREATE_FLAG = '--recreate';

/**
 * The confirmation flag, re-exported from `scripts/lib/dbGuard.ts` rather than
 * spelled again here. `parseConfirmTarget` is the only parser; the refusals
 * below only NAME the flag, and naming it from the same constant the parser
 * uses is what stops a rename from leaving this module's messages recommending
 * a flag that no longer works.
 */
export const CONFIRM_TARGET_FLAG = DB_GUARD_CONFIRM_TARGET_FLAG;

/**
 * Where the `DROP`/`CREATE` pair is issued from. A database cannot be dropped
 * from inside itself, and `postgres` is the maintenance database every
 * PostgreSQL installation this repository supports ships with — including the
 * `postgres:16-alpine` image CI and local development use.
 */
export const MAINTENANCE_DATABASE = 'postgres';

/** The backend package root: `prisma migrate deploy`'s working directory. */
const PACKAGE_ROOT = join(__dirname, '..', '..', '..');

/** The Prisma CLI, resolved from the installed package rather than a PATH lookup. */
const PRISMA_CLI_MODULE = 'prisma/build/index.js';

/** Names the recreate's two sessions in `pg_stat_activity`. */
const RECREATE_APPLICATION_NAME = 'soh-test-db-recreate';

/**
 * Longer than the schema gate's 5 s: `DROP DATABASE` blocks while another
 * session holds the database, and `CREATE DATABASE` copies a template.
 */
const RECREATE_TIMEOUT_MS = 60_000;

/** PostgreSQL's `invalid_catalog_name`: the database in the URL does not exist. */
const ABSENT_DATABASE_SQLSTATE = '3D000';

/**
 * Which condition refused the recreate, or which step failed. Stable strings,
 * for the same reason as the identity and schema codes above.
 */
export type TestDatabaseRecreateCode =
    /** `--recreate` without `--confirm-target`. */
    | 'confirmation_required'
    /** `--confirm-target` named a different database than the URL. */
    | 'confirmation_mismatch'
    /** The name is not a plain identifier, so it cannot be quoted into DDL. */
    | 'database_name_not_identifier'
    /** The target could not be read back, so it must not be dropped. */
    | 'target_unreadable'
    /** The connection reached a different database than the URL names. */
    | 'target_database_mismatch'
    /** Unqualified statements in the target resolve outside `public`. */
    | 'target_schema_redirected'
    /** The maintenance database could not be reached. */
    | 'maintenance_unreadable'
    /** The maintenance session is ON the target, which cannot drop it. */
    | 'maintenance_is_target'
    /** The maintenance session reached a different server than the read-back. */
    | 'server_identity_mismatch'
    /** `DROP`/`CREATE` failed; the message carries the server's own reason. */
    | 'recreate_statement_failed'
    /** The Prisma CLI could not be started, or exited non-zero. */
    | 'migrate_deploy_failed'
    /** The fresh database's ledger could not be verified afterwards. */
    | 'ledger_not_verified';

/**
 * The recreate's refusal or failure. Carries the failing condition as a code and
 * a message naming the host and the database — never the `DATABASE_URL`, for
 * the same reason `TestDatabaseGuardError` never does: the string carries the
 * user and the password, and this message reaches a terminal and CI logs.
 */
export class TestDatabaseRecreateError extends Error {
    constructor(
        message: string,
        public readonly code: TestDatabaseRecreateCode,
    ) {
        super(message);
        this.name = 'TestDatabaseRecreateError';
    }
}

/**
 * The server a session reached, as one comparable string. `null` for an address
 * or a port the server did not report (a Unix socket) is spelled rather than
 * dropped, so "neither session saw an address" compares equal while "one did and
 * one did not" does not.
 */
export const serverFingerprint = (identity: SessionIdentity): string =>
    [
        identity.serverAddress ?? 'no-address',
        identity.serverPort === null ? 'no-port' : String(identity.serverPort),
        identity.postmasterStartTime,
        identity.serverVersion,
    ].join(' | ');

/** A driver error's SQLSTATE, or an empty string when it carries none. */
const sqlStateOf = (error: unknown): string => {
    const code = (error as { code?: unknown } | null | undefined)?.code;

    return typeof code === 'string' ? code : '';
};

/**
 * The URL for one database on the authority the validated `DATABASE_URL` names.
 *
 * DERIVED, not edited: everything that decides which server is reached — scheme,
 * user, password, host, port, and the query parameters the guard has already
 * cleared — is carried across unchanged, and the path is replaced with the name
 * this command validated. That is what makes the `migrate deploy` child's
 * `DATABASE_URL` a value this code computed rather than one it inherited.
 */
export const deriveDatabaseUrl = (databaseUrl: string, database: string): string => {
    const url = new URL(databaseUrl);
    url.pathname = `/${database}`;

    return url.toString();
};

/** The two statements, built from the validated name through `quoteIdentifier`. */
export const recreateStatements = (database: string): readonly string[] => [
    `DROP DATABASE IF EXISTS ${quoteIdentifier(database)}`,
    `CREATE DATABASE ${quoteIdentifier(database)}`,
];

/** The `CREATE` alone: what an absent target needs, with nothing to drop. */
export const createStatements = (database: string): readonly string[] => [
    `CREATE DATABASE ${quoteIdentifier(database)}`,
];

const openRecreateSession: PostgresSessionOpener = (connectionString) =>
    requirePostgresSession(connectionString, RECREATE_APPLICATION_NAME, RECREATE_TIMEOUT_MS);

/** The `prisma migrate deploy` child, described completely before it is started. */
export interface MigrateDeployInvocation {
    /** The Node executable; the CLI runs as a module rather than through a shell. */
    readonly command: string;
    readonly args: readonly string[];
    readonly env: NodeJS.ProcessEnv;
    readonly cwd: string;
}

export interface MigrateDeployResult {
    /** `null` when the child was killed by a signal rather than exiting. */
    readonly exitCode: number | null;
    readonly signal: NodeJS.Signals | null;
    /** Everything the child wrote to its error descriptor, for the failure report. */
    readonly stderr: string;
}

export type MigrateDeployRunner = (invocation: MigrateDeployInvocation) => Promise<MigrateDeployResult>;

/**
 * Pure: the argument list and child environment for the replay.
 *
 * The one decision worth pinning is `DATABASE_URL`. It is ASSIGNED from the
 * derived target rather than inherited, so whatever the operator's shell held —
 * in this environment, a production URL exported into every new shell — cannot
 * be what the migrations are applied to. `cwd` is the backend package root
 * because `prisma/migrations` and `prisma/schema.prisma` are resolved relative
 * to it, so a run from any other directory would find no ledger to apply.
 */
export const buildMigrateDeployInvocation = (input: {
    databaseUrl: string;
    env: NodeJS.ProcessEnv;
    packageRoot: string;
    nodeExecutable: string;
    prismaCliPath: string;
}): MigrateDeployInvocation => ({
    command: input.nodeExecutable,
    args: [input.prismaCliPath, 'migrate', 'deploy'],
    env: { ...input.env, [DATABASE_URL]: input.databaseUrl },
    cwd: input.packageRoot,
});

/**
 * Spawns the CLI, inheriting stdout so Prisma's own report reaches the operator,
 * and capturing stderr so a failure can be reported with Prisma's error text.
 *
 * `require`, not `import`: nothing in the normal test path spawns a process, and
 * this module is loaded by every suite through `jestSetup.ts`.
 */
export const runMigrateDeployProcess: MigrateDeployRunner = (invocation) =>
    new Promise<MigrateDeployResult>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires -- lazy by design; see above
        const { spawn } = require('child_process') as typeof import('child_process');

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
                new TestDatabaseRecreateError(
                    `The recreate could not start the Prisma CLI (${invocation.command} ` +
                        `${invocation.args[0] ?? ''}): ${error.message}. Run npm ci in backend/ and try again.`,
                    'migrate_deploy_failed',
                ),
            );
        });

        child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
            resolve({ exitCode: code, signal, stderr: Buffer.concat(chunks).toString('utf8') });
        });
    });

export interface RecreateOptions {
    /** Defaults to `process.env`. */
    env?: NodeJS.ProcessEnv;
    /** Defaults to `process.argv.slice(2)`; read for `--confirm-target`. */
    argv?: readonly string[];
    /** Defaults to a real `pg` session. */
    openSession?: PostgresSessionOpener;
    /** Defaults to a real `prisma migrate deploy` child process. */
    runMigrateDeploy?: MigrateDeployRunner;
    /** Defaults to `backend/prisma/migrations`; the ledger applied and verified. */
    migrationsDirectory?: string;
    /** Defaults to a real `pg` read of the recreated database. */
    readSchema?: SchemaReader;
    /** Defaults to `process.execPath`. */
    nodeExecutable?: string;
    /** Defaults to the installed Prisma CLI. */
    prismaCliPath?: string;
}

/** What one recreate did, in the order it did it. */
export interface RecreateOutcome {
    /** `database "x" on host "y"`, as every message in this module spells it. */
    target: string;
    /** `false` when the database did not exist, so nothing was dropped. */
    dropped: boolean;
    /** Every statement issued, in order. Empty for every refusal. */
    statements: readonly string[];
    /** How many migrations the fresh ledger was verified to carry. */
    migrations: number;
}

/**
 * Drops and recreates the test database the environment names, then applies the
 * migration ledger to it and verifies the result.
 *
 * THE ORDER IS THE CONTRACT. The two string-level gates run first and reach no
 * network; the read-back runs next and issues no DDL; only then does the
 * maintenance session issue `DROP`/`CREATE`; only then is Prisma started. A test
 * that asserts no statement was issued for each refusal is asserting this order,
 * which is why every step is a parameter rather than a module-level dependency.
 *
 * Throws `TestDatabaseGuardError` (identity), `TestDatabaseRecreateError` (every
 * condition above) or `SchemaFreshnessError` (a fresh database whose ledger does
 * not describe `prisma/migrations`, which would mean the replay itself is
 * broken). Returns what it did on success.
 */
export const recreateTestDatabase = async (options: RecreateOptions = {}): Promise<RecreateOutcome> => {
    const env = options.env ?? process.env;
    const argv = options.argv ?? process.argv.slice(2);
    const openSession = options.openSession ?? openRecreateSession;
    const runMigrateDeploy = options.runMigrateDeploy ?? runMigrateDeployProcess;

    // 1. The identity gate, unchanged and shared with the suite. It owns every
    //    rule about hosts, names and redirecting parameters, so this command has
    //    no opinion of its own about what is safe to destroy.
    assertTestDatabase(env);

    // Non-null after the gate: it refuses an unset, blank or unparsable URL.
    const databaseUrl = env[DATABASE_URL] as string;
    const parsed = parseDatabaseUrl(databaseUrl) as { host: string; database: string; port: string };
    const target = describeTarget(parsed.host, parsed.database);

    // The name reaches DDL, so it must be a plain identifier. `quoteIdentifier`
    // would throw on anything else, but it would throw a bare Error from inside
    // the statement builder; refusing here gives the operator a code and a
    // message instead. `isTestDatabaseName` accepts an upper-case prefix
    // (`SOH_test`), so this is reachable rather than theoretical.
    if (!SAFE_IDENTIFIER_PATTERN.test(parsed.database)) {
        throw new TestDatabaseRecreateError(
            `Refusing to recreate ${target}: the database name is not a plain lower-case SQL identifier, ` +
                'so this command will not quote it into a DROP or CREATE statement.',
            'database_name_not_identifier',
        );
    }

    // 2. The confirmation, through dbGuard's own parser so `--confirm-target`
    //    means here exactly what it means to the catalog writers.
    const confirmTarget = parseConfirmTarget(argv);

    if (confirmTarget === null) {
        throw new TestDatabaseRecreateError(
            `Refusing to recreate ${target}: this command DROPS the database it is given, so it must be ` +
                `named on the command line — pass ${CONFIRM_TARGET_FLAG} ${parsed.database}. An ambient ` +
                `${DATABASE_URL} is a target nobody read.`,
            'confirmation_required',
        );
    }

    if (confirmTarget !== parsed.database) {
        throw new TestDatabaseRecreateError(
            `Refusing to recreate ${target}: ${CONFIRM_TARGET_FLAG} names "${confirmTarget}", which is not ` +
                `the database ${DATABASE_URL} points at. One of the two is not what you think it is.`,
            'confirmation_mismatch',
        );
    }

    // 3. The read-back. Both URLs are derived from the validated one, so the
    //    session that is verified and the session that drops cannot be pointed
    //    at different servers by anything but the server itself — which is what
    //    the fingerprint comparison below covers.
    const targetUrl = deriveDatabaseUrl(databaseUrl, parsed.database);
    const maintenanceUrl = deriveDatabaseUrl(databaseUrl, MAINTENANCE_DATABASE);

    let targetIdentity: SessionIdentity | null = null;

    try {
        targetIdentity = await readSessionIdentity(openSession(targetUrl));
    } catch (error) {
        // An absent database is not a failed verification: there is nothing to
        // drop and nothing to lose, so the run continues with the CREATE alone.
        // Every other failure — refused connection, authentication, a timeout, a
        // permission this read needs and does not have — means the target could
        // not be verified, and an unverified target is not dropped.
        if (sqlStateOf(error) !== ABSENT_DATABASE_SQLSTATE) {
            throw new TestDatabaseRecreateError(
                `Refusing to recreate ${target}: the database could not be read back over a connection ` +
                    `(${error instanceof Error ? error.message : String(error)}). This command DROPS what it ` +
                    'is given, so a target it cannot verify is left alone.',
                'target_unreadable',
            );
        }
    }

    if (targetIdentity !== null) {
        if (targetIdentity.database !== parsed.database) {
            throw new TestDatabaseRecreateError(
                `Refusing to recreate ${target}: the connection reached database ` +
                    `"${targetIdentity.database}" instead. The database that would be dropped is not the one ` +
                    `${DATABASE_URL} displays; point it directly at the database.`,
                'target_database_mismatch',
            );
        }

        if (targetIdentity.schema !== DEFAULT_SCHEMA) {
            throw new TestDatabaseRecreateError(
                `Refusing to recreate ${target}: an unqualified statement in it resolves in schema ` +
                    `"${targetIdentity.schema}" rather than ${DEFAULT_SCHEMA} (search_path is ` +
                    `"${targetIdentity.searchPath}"), so the migrations this command replays would create ` +
                    `their tables somewhere the suite never reads. A role or database default can redirect ` +
                    `that where no URL shows it: ALTER ROLE ${targetIdentity.role} IN DATABASE ` +
                    `${targetIdentity.database} RESET search_path, and ALTER DATABASE ` +
                    `${targetIdentity.database} RESET search_path.`,
                'target_schema_redirected',
            );
        }
    }

    const maintenanceSession = openSession(maintenanceUrl);
    let maintenanceIdentity: SessionIdentity;

    try {
        // This session stays OPEN: it is the one that issues the DDL, so its
        // identity is read through `askSessionIdentity` rather than through the
        // connect-and-hang-up form the target read-back uses.
        await maintenanceSession.connect();

        maintenanceIdentity = await askSessionIdentity(maintenanceSession);
    } catch (error) {
        await maintenanceSession.end().catch(() => undefined);

        throw new TestDatabaseRecreateError(
            `Refusing to recreate ${target}: the "${MAINTENANCE_DATABASE}" maintenance database on host ` +
                `"${parsed.host}" could not be reached ` +
                `(${error instanceof Error ? error.message : String(error)}), and a database cannot be ` +
                'dropped from inside itself.',
            'maintenance_unreadable',
        );
    }

    const statements: string[] = [];

    try {
        // Kept deliberately although the identity gate makes it unreachable
        // today — `postgres` is neither a `_test` name nor `ci`, so a URL naming
        // it never gets here. If that rule ever widens, this refuses rather than
        // issuing a DROP from the session that is connected to the target.
        if (maintenanceIdentity.database === parsed.database) {
            throw new TestDatabaseRecreateError(
                `Refusing to recreate ${target}: the maintenance session is connected to that same ` +
                    'database, and PostgreSQL cannot drop a database from inside itself.',
                'maintenance_is_target',
            );
        }

        // The `DROP` is about to be issued HERE, to this server. Comparing the
        // fingerprints is what makes it the server the read-back verified rather
        // than a second one the same authority happened to resolve to.
        if (targetIdentity !== null && serverFingerprint(maintenanceIdentity) !== serverFingerprint(targetIdentity)) {
            throw new TestDatabaseRecreateError(
                `Refusing to recreate ${target}: the "${MAINTENANCE_DATABASE}" session reached a different ` +
                    `server (${serverFingerprint(maintenanceIdentity)}) than the read-back of the target ` +
                    `(${serverFingerprint(targetIdentity)}), so the DROP would not be issued to the server ` +
                    'that was verified.',
                'server_identity_mismatch',
            );
        }

        const planned = targetIdentity === null ? createStatements(parsed.database) : recreateStatements(parsed.database);

        for (const statement of planned) {
            try {
                await maintenanceSession.query(statement);
                statements.push(statement);
            } catch (error) {
                throw new TestDatabaseRecreateError(
                    `Recreating ${target} failed on "${statement}": ` +
                        `${error instanceof Error ? error.message : String(error)}. Close every other ` +
                        'connection to that database and run this again.',
                    'recreate_statement_failed',
                );
            }
        }
    } finally {
        await maintenanceSession.end().catch(() => undefined);
    }

    // 4. The replay, against the derived URL and nothing else.
    const deployment = await runMigrateDeploy(
        buildMigrateDeployInvocation({
            databaseUrl: targetUrl,
            env,
            packageRoot: PACKAGE_ROOT,
            nodeExecutable: options.nodeExecutable ?? process.execPath,
            // Resolved lazily, like every other dependency here: the path is
            // needed only by a run that has passed every gate above.
            prismaCliPath: options.prismaCliPath ?? require.resolve(PRISMA_CLI_MODULE),
        }),
    );

    if (deployment.exitCode !== 0) {
        throw new TestDatabaseRecreateError(
            `${target} was recreated, and "prisma migrate deploy" against it ` +
                `${deployment.signal === null ? `exited ${deployment.exitCode}` : `was killed by ${deployment.signal}`}. ` +
                `The database is now empty, so apply the ledger before running the suite. ` +
                `${deployment.stderr.trim().length > 0 ? deployment.stderr.trim() : ''}`.trim(),
            'migrate_deploy_failed',
        );
    }

    // The proof, through this module's own schema-qualified read of
    // `public._prisma_migrations`: a deploy that reported success against some
    // other database would leave this one with no ledger, and that is exactly
    // what a skip here means.
    const verification = await assertSchemaFreshness({
        env: { ...env, [DATABASE_URL]: targetUrl },
        migrationsDirectory: options.migrationsDirectory,
        readSchema: options.readSchema,
    });

    if (!verification.checked) {
        throw new TestDatabaseRecreateError(
            `${target} was recreated and "prisma migrate deploy" reported success, but its migration ledger ` +
                `could not be verified afterwards (${verification.reason}) - ${verification.detail}`,
            'ledger_not_verified',
        );
    }

    return {
        target,
        dropped: targetIdentity !== null,
        statements,
        migrations: verification.migrations,
    };
};

/**
 * The recreate's command form. One message on success, one on refusal.
 *
 * Exit codes match the diagnosis above: 0 for a completed recreate, 1 for any
 * refusal or failure. `output` and the overrides are parameters for the same
 * reason they are there — every path is reachable from a test that opens no
 * connection and starts no process.
 */
export const runRecreateCommand = async (
    argv: readonly string[] = process.argv.slice(2),
    output: CommandOutput = console,
    overrides: RecreateOptions = {},
): Promise<number> => {
    try {
        const outcome = await recreateTestDatabase({ ...overrides, argv: overrides.argv ?? argv });

        output.log(
            `test-database recreate: ${outcome.target} ` +
                `${outcome.dropped ? 'dropped and recreated' : 'created (it did not exist)'}, ` +
                `${outcome.migrations} migration${outcome.migrations === 1 ? '' : 's'} applied and verified.`,
        );

        for (const statement of outcome.statements) {
            output.log(`  ${statement}`);
        }

        return 0;
    } catch (error) {
        output.error(error instanceof Error ? error.message : String(error));

        return 1;
    }
};

/**
 * The module's command form, which is two commands: the default diagnosis and
 * the `--recreate` repair. Dispatching on the flag keeps one entry point for
 * both, so an operator who has the diagnosis in their history is one flag away
 * from the fix, and the fix cannot be reached without passing the diagnosis's
 * own identity gate.
 */
export const runTestDbCommand = async (
    argv: readonly string[] = process.argv.slice(2),
    output: CommandOutput = console,
    overrides: SchemaFreshnessOptions & RecreateOptions = {},
): Promise<number> =>
    argv.includes(RECREATE_FLAG)
        ? runRecreateCommand(argv, output, overrides)
        : runSchemaFreshnessCommand(argv, output, overrides);

// Only when this file IS the program. Under Jest, `require.main` is the runner,
// so importing this module never starts the command.
if (require.main === module) {
    void runTestDbCommand().then((code) => {
        // `exitCode` rather than `exit`: stdout is a pipe whenever the caller
        // redirects or captures it, and exiting outright can truncate the one
        // message this command exists to print.
        process.exitCode = code;
    });
}

