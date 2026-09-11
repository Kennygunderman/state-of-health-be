/**
 * The test-database guard, and the only place the suite is allowed to destroy
 * data (Agent Action Plan §0.7.1 / §0.9.1).
 *
 * Everything about the shape of this module serves one property: the guard must
 * run BEFORE anything can reach a database. That is why there is no
 * module-scope import of `@prisma/client`, `../../generated/prisma`,
 * `../../prisma/client`, `pg` or `../../app` anywhere below —
 * `src/prisma/client.ts` constructs its client on the second line of the file,
 * at import time, so importing it here would put a live client in the module
 * graph before `jestSetup.ts` had checked a single condition. The Prisma client
 * is therefore required LAZILY, inside the two functions that need it, after
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
 * Every table this feature owns, plus the three legacy tables its rows hang
 * off. Explicit and frozen rather than derived from the information schema: a
 * derived list would silently grow to include whatever else lives in the
 * database, and this list is the blast radius of `truncateFeatureTables`.
 *
 * The sixteen meal-planning tables are in dependency order (parents last) for
 * readability only — one `TRUNCATE … CASCADE` statement is order-independent.
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
 * The two Prisma members this module uses, declared structurally so no type or
 * value from the generated client enters this module's import graph. Keeping
 * the surface this small is also why the harness works on a checkout where
 * `prisma generate` has not been run until a suite actually touches the
 * database.
 */
interface TestPrismaClient {
    $executeRawUnsafe(query: string, ...values: unknown[]): Promise<number>;
    $disconnect(): Promise<void>;
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
 * `CASCADE` also empties whatever else references these tables (the legacy
 * per-user tables hanging off `users`), which is intended — §0.7.1 specifies
 * `CASCADE`, and a test database with half a user's rows removed is worse than
 * an empty one. `TRUNCATE` cannot be parameterised, so the statement is built
 * from the frozen `FEATURE_TABLES` constant through `quoteIdentifier` and from
 * nothing else.
 */
export const truncateFeatureTables = async (): Promise<void> => {
    assertTestDatabase();

    const identifiers = FEATURE_TABLES.map(quoteIdentifier).join(', ');
    const prisma = requirePrismaClient();

    await prisma.$executeRawUnsafe(`TRUNCATE TABLE ${identifiers} CASCADE`);
};

/**
 * Closes the shared client's pool so Jest's process can exit. Non-destructive,
 * so it does not re-run the guard: an `afterAll` must be able to clean up even
 * on the path where an assertion about the environment has already failed.
 */
export const disconnectTestDatabase = async (): Promise<void> => {
    const prisma = requirePrismaClient();
    await prisma.$disconnect();
};
