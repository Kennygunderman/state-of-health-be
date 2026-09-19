import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AppliedMigrationRow,
    CommandOutput,
    LedgerComparison,
    MigrateDeployInvocation,
    MigrateDeployResult,
    MigrationFingerprint,
    PostgresSession,
    PostgresSessionOpener,
    RecreateOptions,
    SchemaObservation,
    SchemaReader,
} from './testDb';
import {
    CONFIRM_TARGET_FLAG,
    CONNECTION_LIMIT_PARAMETER,
    FEATURE_TABLES,
    MAINTENANCE_DATABASE,
    MIGRATIONS_DIRECTORY,
    MIGRATIONS_DIRECTORY_FLAG,
    RECREATE_FLAG,
    TEST_CONNECTION_LIMIT,
    SchemaFreshnessError,
    SchemaReadFailure,
    TestDatabaseGuardError,
    TestDatabaseRecreateError,
    TestDatabaseSessionError,
    assertSchemaFreshness,
    assertSessionTarget,
    assertTestDatabase,
    buildMigrateDeployInvocation,
    compareMigrationLedger,
    createStatements,
    declaredColumnsFromMigrationSql,
    deriveDatabaseUrl,
    describeSchemaFreshnessRefusal,
    missingDeclaredColumns,
    pinConnectionLimit,
    readMigrationFingerprints,
    recreateStatements,
    recreateTestDatabase,
    runRecreateCommand,
    runSchemaFreshnessCommand,
    runTestDbCommand,
    serverFingerprint,
    truncateFeatureTablesStatement,
} from './testDb';

const BACKEND_ROOT = join(__dirname, '..', '..', '..');
const JEST_SETUP_FILE = join(__dirname, 'jestSetup.ts');
/**
 * Read as TEXT, never imported: importing it constructs a live Prisma client,
 * which is the one thing this module's header forbids. Text is enough for what
 * the drift guard below asks of it.
 */
const PRISMA_CLIENT_FILE = join(BACKEND_ROOT, 'src', 'prisma', 'client.ts');
/** The module under test, which is also the standalone diagnostic program. */
const TEST_DB_MODULE = join(__dirname, 'testDb.ts');
const TEST_TSCONFIG = join(BACKEND_ROOT, 'tsconfig.test.json');

const CHILD_TIMEOUT_MS = 60_000;

const UNROUTABLE_RFC_5737_DOCUMENTATION_HOST = '192.0.2.1';

/**
 * Stands in for the opaque container-network host a platform-exported
 * `DATABASE_URL` carries. Synthetic on purpose: a real deployment hostname
 * written into test data is an infrastructure disclosure that travels with the
 * repository into every log and diff, and this suite reaches its judgement
 * without it — like every other host below, which are RFC 2606 / RFC 5737
 * documentation values rather than anything real.
 *
 * Dotless, which is the property that earns it a row of its own: `LOCAL_HOSTS`
 * accepts `postgres`, a dotless container-network service name, so a host with
 * no dot in it is the near miss to an accepted value, and no other row in this
 * matrix has that shape. `assertTestDatabase` judges the string and never
 * resolves or connects, so the shape is the whole of what the case exercises.
 */
const OPAQUE_CONTAINER_NETWORK_HOST = 'db-container-host';

const SAFE_ENV: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    ALLOW_DB_TRUNCATE: 'true',
    DATABASE_URL: 'postgresql://soh:soh@127.0.0.1:5433/soh_test',
};

const envWith = (overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...SAFE_ENV, ...overrides });

const SECRET_USER = 'appuser';
const SECRET_PASSWORD = 'hunter2-never-in-any-message';

const secretUrl = (host: string, database: string): string =>
    `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@${host}:5432/${database}`;

const expectRefusal = (env: NodeJS.ProcessEnv, code: string): TestDatabaseGuardError => {
    let thrown: unknown;

    try {
        assertTestDatabase(env);
    } catch (error) {
        thrown = error;
    }

    expect(thrown).toBeInstanceOf(TestDatabaseGuardError);

    const refusal = thrown as TestDatabaseGuardError;
    expect(refusal.name).toBe('TestDatabaseGuardError');
    expect(refusal.code).toBe(code);

    return refusal;
};

describe('assertTestDatabase', () => {
    describe('accepted environments', () => {
        it('accepts the ambient environment this suite is running under', () => {
            expect(() => assertTestDatabase()).not.toThrow();
        });

        it.each([
            { scenario: 'the documented local test database', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/soh_test' },
            { scenario: 'a clone-index tail', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/soh_test_46' },
            { scenario: 'a zero-padded clone index', databaseUrl: 'postgresql://soh:soh@localhost:5433/soh_test_046' },
            { scenario: 'a test name on the compose service host', databaseUrl: 'postgresql://soh:soh@postgres:5432/soh_test' },
            { scenario: "CI's plainly named database on localhost", databaseUrl: 'postgresql://ci:ci@localhost:5432/ci' },
            { scenario: "CI's database on the loopback address", databaseUrl: 'postgresql://ci:ci@127.0.0.1:5432/ci' },
            { scenario: "CI's database on the compose service host", databaseUrl: 'postgresql://ci:ci@postgres:5432/ci' },
            { scenario: 'an upper-case host spelling', databaseUrl: 'postgresql://soh:soh@LOCALHOST:5433/soh_test' },
        ])('accepts $scenario', ({ databaseUrl }) => {
            expect(() => assertTestDatabase(envWith({ DATABASE_URL: databaseUrl }))).not.toThrow();
        });
    });

    describe('NODE_ENV', () => {
        it.each([
            { scenario: 'development', nodeEnv: 'development' },
            { scenario: 'production', nodeEnv: 'production' },
            { scenario: 'a near miss in case', nodeEnv: 'Test' },
            { scenario: 'a padded value', nodeEnv: ' test' },
        ])('refuses $scenario', ({ nodeEnv }) => {
            const refusal = expectRefusal(envWith({ NODE_ENV: nodeEnv }), 'node_env_not_test');

            expect(refusal.message).toContain('NODE_ENV');
        });

        it('refuses an unset NODE_ENV and says it is not set', () => {
            const refusal = expectRefusal(envWith({ NODE_ENV: undefined }), 'node_env_not_test');

            expect(refusal.message).toContain('not set');
        });
    });

    describe('ALLOW_DB_TRUNCATE', () => {
        it.each([
            { scenario: 'an unset value', allowDbTruncate: undefined },
            { scenario: 'a blank value', allowDbTruncate: '' },
            { scenario: 'an upper-case value', allowDbTruncate: 'TRUE' },
            { scenario: 'a numeric value', allowDbTruncate: '1' },
            { scenario: 'a padded value', allowDbTruncate: 'true ' },
            { scenario: 'an explicit false', allowDbTruncate: 'false' },
        ])('refuses $scenario', ({ allowDbTruncate }) => {
            const refusal = expectRefusal(envWith({ ALLOW_DB_TRUNCATE: allowDbTruncate }), 'truncate_not_allowed');

            expect(refusal.message).toContain('ALLOW_DB_TRUNCATE');
        });
    });

    describe('DATABASE_URL', () => {
        it.each([
            { scenario: 'an unset DATABASE_URL', databaseUrl: undefined },
            { scenario: 'an empty DATABASE_URL', databaseUrl: '' },
            { scenario: 'a blank DATABASE_URL', databaseUrl: '   ' },
        ])('refuses $scenario', ({ databaseUrl }) => {
            expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'missing_database_url');
        });

        it.each([
            { scenario: 'a value that is not a URL', databaseUrl: 'soh_test' },
            { scenario: 'unparsable garbage', databaseUrl: '!! not a url !!' },
            { scenario: 'a URL naming no database', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433' },
            { scenario: 'a URL with an empty path', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/' },
            { scenario: 'a malformed percent escape', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/soh%ZZtest' },
        ])('refuses $scenario', ({ databaseUrl }) => {
            expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'unparsable_database_url');
        });

        it.each([
            { scenario: 'the development database', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/soh_dev_46' },
            { scenario: 'the shadow database', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/soh_shadow_46' },
            { scenario: 'a production-looking name', databaseUrl: 'postgresql://soh:soh@localhost:5432/state_of_health' },
            { scenario: 'a name carrying test as a prefix', databaseUrl: 'postgresql://soh:soh@localhost:5432/test_state_of_health' },
            { scenario: 'a name that merely contains test', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/testing_grounds' },
            { scenario: 'a non-numeric tail after the suffix', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/soh_test_copy' },
        ])('refuses $scenario on a local host', ({ databaseUrl }) => {
            const refusal = expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'database_name_not_test');

            expect(refusal.message).toContain('_test');
        });

        it.each([
            { scenario: 'a test name on a remote host', databaseUrl: secretUrl('db.prod.example.com', 'app_test') },
            { scenario: 'a clone-indexed test name on a remote host', databaseUrl: secretUrl('db.prod.example.com', 'app_test_46') },
            { scenario: "CI's database name on a remote host", databaseUrl: secretUrl('db.prod.example.com', 'ci') },
            { scenario: 'a production database on an opaque container-network host, the shape a platform-exported URL carries', databaseUrl: secretUrl(OPAQUE_CONTAINER_NETWORK_HOST, 'state_of_health') },
            { scenario: 'a public IP address', databaseUrl: secretUrl('203.0.113.10', 'soh_test') },
        ])('refuses $scenario', ({ databaseUrl }) => {
            const refusal = expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'database_host_not_local');

            expect(refusal.message).toContain('the host must be one of');
        });

        it.each([
            { scenario: 'a redirecting host parameter', databaseUrl: `${secretUrl('127.0.0.1', 'soh_test')}?host=db.prod.example.com` },
            { scenario: 'a redirecting dbname parameter', databaseUrl: `${secretUrl('127.0.0.1', 'soh_test')}?dbname=state_of_health` },
            { scenario: 'a percent-encoded database name', databaseUrl: secretUrl('127.0.0.1', 'soh%5Ftest') },
            { scenario: 'no host at all', databaseUrl: 'postgresql:///soh_test' },
        ])('refuses $scenario, because the URL does not determine what it opens', ({ databaseUrl }) => {
            expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'ambiguous_database_url');
        });

        // The schema half of the same rule, and the one that reaches this
        // guard's own destructive statement. Measured on PostgreSQL 16.15 with
        // a decoy `live` schema beside `public`: under Prisma `?schema=live`
        // and `?options=-c search_path=live` both made
        // `TRUNCATE TABLE "probe_rows" CASCADE` empty `live.probe_rows` and
        // leave `public.probe_rows` untouched, and under `pg` the `options`
        // form did the same to an unqualified `INSERT`. Every URL below names a
        // `_test` database on a local host, so it satisfies both halves of the
        // test rule and would have been accepted.
        it.each([
            { scenario: 'a Prisma schema parameter', databaseUrl: `${secretUrl('127.0.0.1', 'soh_test')}?schema=live` },
            { scenario: 'a libpq options parameter carrying search_path', databaseUrl: `${secretUrl('127.0.0.1', 'soh_test')}?options=-c%20search_path%3Dlive` },
            { scenario: 'a search_path parameter', databaseUrl: `${secretUrl('127.0.0.1', 'soh_test')}?search_path=live` },
            { scenario: 'an upper-case schema key', databaseUrl: `${secretUrl('127.0.0.1', 'soh_test')}?SCHEMA=live` },
            { scenario: 'a schema key repeated with two values', databaseUrl: `${secretUrl('127.0.0.1', 'soh_test')}?schema=public&schema=live` },
        ])('refuses $scenario, because the tables it would empty are not this database\'s', ({ databaseUrl }) => {
            const refusal = expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'ambiguous_database_url');

            expect(refusal.message).toContain('redirects the schema');
            expect(refusal.message).toContain('public');
        });

        it('accepts schema=public, which names the schema the migrations create', () => {
            expect(() =>
                assertTestDatabase(envWith({ DATABASE_URL: `${secretUrl('127.0.0.1', 'soh_test')}?schema=public` })),
            ).not.toThrow();
        });

        it('accepts a parameter that moves neither the database nor the schema', () => {
            expect(() =>
                assertTestDatabase(
                    envWith({
                        DATABASE_URL: `${secretUrl('127.0.0.1', 'soh_test')}?connection_limit=5&application_name=soh`,
                    }),
                ),
            ).not.toThrow();
        });
    });

    describe('refusal messages', () => {
        it('names the host and the database it judged', () => {
            const refusal = expectRefusal(
                envWith({ DATABASE_URL: secretUrl('db.prod.example.com', 'state_of_health') }),
                'database_host_not_local',
            );

            expect(refusal.message).toContain('db.prod.example.com');
            expect(refusal.message).toContain('state_of_health');
        });

        it.each([
            { scenario: 'a remote test database', databaseUrl: secretUrl('db.prod.example.com', 'app_test') },
            { scenario: 'a local production database', databaseUrl: secretUrl('127.0.0.1', 'state_of_health') },
            { scenario: 'a redirected local test database', databaseUrl: `${secretUrl('127.0.0.1', 'soh_test')}?host=db.prod.example.com` },
        ])('carries neither the password, the user nor the URL for $scenario', ({ databaseUrl }) => {
            let message = '';

            try {
                assertTestDatabase(envWith({ DATABASE_URL: databaseUrl }));
            } catch (error) {
                message = (error as Error).message;
            }

            expect(message).not.toBe('');
            expect(message).not.toContain(SECRET_PASSWORD);
            expect(message).not.toContain(SECRET_USER);
            expect(message).not.toContain(databaseUrl);
            expect(message).not.toContain('postgresql://');
        });

        it('reports NODE_ENV first when several conditions fail, naming nothing from the URL', () => {
            const refusal = expectRefusal(
                { NODE_ENV: 'development', DATABASE_URL: secretUrl('db.prod.example.com', 'state_of_health') },
                'node_env_not_test',
            );

            expect(refusal.message).not.toContain('state_of_health');
            expect(refusal.message).not.toContain('db.prod.example.com');
        });
    });
});

describe('FEATURE_TABLES', () => {
    it('names exactly the sixteen feature tables, the three diary tables and the five legacy tables', () => {
        expect([...FEATURE_TABLES].sort()).toEqual(
            [
                'ai_usage',
                'catalog_food_aliases',
                'catalog_food_components',
                'catalog_food_portions',
                'catalog_foods',
                'catalog_generation_batches',
                'catalog_import_runs',
                'catalog_validation_records',
                'daily_exercises',
                'exercise_sets',
                'grocery_items',
                'meal_entries',
                'meal_plan_actions',
                'meal_plan_days',
                'meal_plan_meals',
                'meal_plan_preferences',
                'meal_plans',
                'meals',
                'recipe_ingredients',
                'recipe_versions',
                'recipes',
                'usda_api_cache',
                'users',
                'workout_days',
            ].sort(),
        );
    });

    it('names the three tables a cascade from users cannot reach', () => {
        expect(FEATURE_TABLES).toContain('workout_days');
        expect(FEATURE_TABLES).toContain('usda_api_cache');
        expect(FEATURE_TABLES).toContain('ai_usage');
    });

    it('is frozen, so no suite can widen the blast radius of a truncate', () => {
        expect(Object.isFrozen(FEATURE_TABLES)).toBe(true);
        expect(() => {
            (FEATURE_TABLES as string[]).push('templates');
        }).toThrow();
    });

    it('names only plain lower-case identifiers', () => {
        for (const table of FEATURE_TABLES) {
            expect(table).toMatch(/^[a-z_][a-z0-9_]*$/);
        }
    });
});

// The statement, asserted without a database. The schema qualification is a
// safety property — it is what stops the one destructive statement in this
// harness from following a `search_path` set outside the URL, by `PGOPTIONS`,
// by earlier SQL or by `ALTER ROLE … SET search_path` — and a property nothing
// reads is a property that regresses.
describe('truncateFeatureTablesStatement', () => {
    it('qualifies every table with the public schema and cascades once', () => {
        const statement = truncateFeatureTablesStatement();

        expect(statement.startsWith('TRUNCATE TABLE ')).toBe(true);
        expect(statement.endsWith(' CASCADE')).toBe(true);

        for (const table of FEATURE_TABLES) {
            expect(statement).toContain(`"public"."${table}"`);
        }
    });

    it('leaves no table unqualified', () => {
        // Read off the statement rather than off the list, so a table added to
        // `FEATURE_TABLES` and interpolated some other way still fails here.
        const tables = truncateFeatureTablesStatement()
            .replace(/^TRUNCATE TABLE /, '')
            .replace(/ CASCADE$/, '')
            .split(', ');

        expect(tables).toHaveLength(FEATURE_TABLES.length);
        for (const table of tables) {
            expect(table).toMatch(/^"public"\."[a-z_][a-z0-9_]*"$/);
        }
    });
});

// The schema gate. Every case below runs with NO database: the reads are a
// parameter (`SchemaReader`), so each verdict is reachable in process, which is
// what keeps this file runnable on a checkout with no PostgreSQL — the same
// property the 25 pure-logic suites depend on.
const INIT_SQL = `-- The first migration.
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT,
    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);
`;

const FEATURE_SQL = `CREATE TABLE IF NOT EXISTS "meal_plan_preferences" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" TEXT NOT NULL,
    "targets_input_revision" INTEGER,
    "allergens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    CONSTRAINT "meal_plan_preferences_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "meal_entries" ADD COLUMN "nutrition_provenance" TEXT,
    ADD COLUMN IF NOT EXISTS "meal_plan_meal_id" UUID;

CREATE INDEX "meal_entries_plan_idx" ON "meal_entries"("meal_plan_meal_id") WHERE "deleted_at" IS NULL;
`;

const INIT_MIGRATION = '20260706000000_init';
const FEATURE_MIGRATION = '20260908000000_meal_planning';

const sha256 = (text: string): string => createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');

const migrationOnDisk = (name: string, sql: string): MigrationFingerprint => ({
    name,
    checksum: sha256(sql),
    sql,
});

const ledgerRow = (
    name: string,
    checksum: string,
    overrides: Partial<AppliedMigrationRow> = {},
): AppliedMigrationRow => ({ name, checksum, finished: true, rolledBack: false, ...overrides });

const ON_DISK: readonly MigrationFingerprint[] = [
    migrationOnDisk(INIT_MIGRATION, INIT_SQL),
    migrationOnDisk(FEATURE_MIGRATION, FEATURE_SQL),
];

const appliedCleanly: readonly AppliedMigrationRow[] = ON_DISK.map((migration) =>
    ledgerRow(migration.name, migration.checksum),
);

describe('readMigrationFingerprints', () => {
    let directory: string;

    beforeAll(() => {
        directory = mkdtempSync(join(tmpdir(), 'soh-migrations-'));

        // Written in reverse, so "sorted by name" cannot pass by accident.
        for (const migration of [...ON_DISK].reverse()) {
            mkdirSync(join(directory, migration.name));
            writeFileSync(join(directory, migration.name, 'migration.sql'), migration.sql);
        }

        // A directory that is not a migration, and a stray file beside them.
        mkdirSync(join(directory, 'notes'));
        writeFileSync(join(directory, 'notes', 'README.md'), 'not a migration\n');
        writeFileSync(join(directory, 'migration.sql'), 'CREATE TABLE "stray" ("id" TEXT);\n');
    });

    afterAll(() => {
        rmSync(directory, { recursive: true, force: true });
    });

    it('returns nothing for a directory that does not exist, rather than throwing', () => {
        expect(readMigrationFingerprints(join(directory, 'absent'))).toEqual([]);
    });

    it('hashes each migration the way Prisma hashes it: sha256 over the file bytes', () => {
        const fingerprints = readMigrationFingerprints(directory);

        expect(fingerprints.map((fingerprint) => fingerprint.name)).toEqual([INIT_MIGRATION, FEATURE_MIGRATION]);
        expect(fingerprints[0].checksum).toBe(sha256(INIT_SQL));
        expect(fingerprints[1].checksum).toBe(sha256(FEATURE_SQL));
        expect(fingerprints[1].sql).toBe(FEATURE_SQL);
    });

    it('skips a directory with no migration.sql and any file beside the directories', () => {
        const names = readMigrationFingerprints(directory).map((fingerprint) => fingerprint.name);

        expect(names).not.toContain('notes');
        expect(names).not.toContain('migration.sql');
    });

    // Deliberately shape-only against the real ledger: this repository's
    // migrations are edited by other work, and a test that pinned their content
    // or their checksums would fail for a change that is none of its business.
    // What must hold is that the real directory reads at all, and reads into the
    // shape the comparison consumes.
    it('reads the repository ledger into fingerprints of the expected shape', () => {
        const fingerprints = readMigrationFingerprints();

        expect(existsSync(MIGRATIONS_DIRECTORY)).toBe(true);
        expect(fingerprints.length).toBeGreaterThanOrEqual(2);

        for (const fingerprint of fingerprints) {
            expect(fingerprint.name).toMatch(/^\d{14}_[a-z0-9_]+$/);
            expect(fingerprint.checksum).toMatch(/^[0-9a-f]{64}$/);
            expect(fingerprint.sql.length).toBeGreaterThan(0);
        }

        expect([...fingerprints].map((fingerprint) => fingerprint.name).sort()).toEqual(
            fingerprints.map((fingerprint) => fingerprint.name),
        );
    });
});

describe('compareMigrationLedger', () => {
    const empty = { drifted: [], unfinished: [], pending: [], unknown: [] };

    it('calls a ledger that matches every file on disk fresh', () => {
        expect(compareMigrationLedger(ON_DISK, appliedCleanly)).toEqual({ kind: 'fresh', ...empty });
    });

    it('reports a recorded checksum that is not the file on disk, with both values', () => {
        const comparison = compareMigrationLedger(ON_DISK, [
            appliedCleanly[0],
            ledgerRow(FEATURE_MIGRATION, 'a'.repeat(64)),
        ]);

        expect(comparison.kind).toBe('drifted');
        expect(comparison.drifted).toEqual([
            {
                name: FEATURE_MIGRATION,
                recordedChecksum: 'a'.repeat(64),
                onDiskChecksum: sha256(FEATURE_SQL),
            },
        ]);
        expect(comparison.pending).toEqual([]);
    });

    it('reports a migration on disk that the ledger has never seen as pending', () => {
        const comparison = compareMigrationLedger(ON_DISK, [appliedCleanly[0]]);

        expect(comparison.kind).toBe('pending');
        expect(comparison.pending).toEqual([FEATURE_MIGRATION]);
    });

    it.each([
        { scenario: 'never finished', overrides: { finished: false } },
        { scenario: 'rolled back', overrides: { rolledBack: true } },
        { scenario: 'both', overrides: { finished: false, rolledBack: true } },
    ])('reports a migration recorded but $scenario as unfinished, not pending', ({ overrides }) => {
        const comparison = compareMigrationLedger(ON_DISK, [
            appliedCleanly[0],
            ledgerRow(FEATURE_MIGRATION, sha256(FEATURE_SQL), overrides),
        ]);

        expect(comparison.kind).toBe('unfinished');
        expect(comparison.unfinished).toEqual([FEATURE_MIGRATION]);
        expect(comparison.pending).toEqual([]);
    });

    it('treats a rolled-back attempt followed by a successful one as applied', () => {
        const comparison = compareMigrationLedger(ON_DISK, [
            appliedCleanly[0],
            ledgerRow(FEATURE_MIGRATION, sha256(FEATURE_SQL), { rolledBack: true }),
            ledgerRow(FEATURE_MIGRATION, sha256(FEATURE_SQL)),
        ]);

        expect(comparison.kind).toBe('fresh');
    });

    it('judges the last applied row when a migration was applied more than once', () => {
        const comparison = compareMigrationLedger(ON_DISK, [
            appliedCleanly[0],
            ledgerRow(FEATURE_MIGRATION, sha256(FEATURE_SQL)),
            ledgerRow(FEATURE_MIGRATION, 'b'.repeat(64)),
        ]);

        expect(comparison.kind).toBe('drifted');
        expect(comparison.drifted[0].recordedChecksum).toBe('b'.repeat(64));
    });

    it('reports a ledger row with no migration on disk, which is a checkout older than the database', () => {
        const comparison = compareMigrationLedger(ON_DISK, [
            ...appliedCleanly,
            ledgerRow('20270101000000_from_the_future', 'c'.repeat(64)),
        ]);

        expect(comparison.kind).toBe('unknown_migration');
        expect(comparison.unknown).toEqual(['20270101000000_from_the_future']);
    });

    it('names drift as the verdict when several categories fail at once, and still reports them all', () => {
        const comparison = compareMigrationLedger(
            [...ON_DISK, migrationOnDisk('20261001000000_later', 'SELECT 1;')],
            [ledgerRow(INIT_MIGRATION, 'd'.repeat(64)), ledgerRow('20270101000000_gone', 'e'.repeat(64))],
        );

        expect(comparison.kind).toBe('drifted');
        expect(comparison.drifted.map((drift) => drift.name)).toEqual([INIT_MIGRATION]);
        expect(comparison.pending).toEqual([FEATURE_MIGRATION, '20261001000000_later']);
        expect(comparison.unknown).toEqual(['20270101000000_gone']);
    });

    it('is fresh for an empty disk and an empty ledger, so the caller decides what nothing means', () => {
        expect(compareMigrationLedger([], []).kind).toBe('fresh');
    });
});

describe('declaredColumnsFromMigrationSql', () => {
    it('reads the columns of a CREATE TABLE body and leaves its constraints out', () => {
        const declared = declaredColumnsFromMigrationSql(FEATURE_SQL);

        expect([...(declared.get('meal_plan_preferences') ?? [])].sort()).toEqual([
            'allergens',
            'id',
            'targets_input_revision',
            'user_id',
        ]);
    });

    it('reads every ADD COLUMN of one ALTER TABLE, including IF NOT EXISTS', () => {
        const declared = declaredColumnsFromMigrationSql(FEATURE_SQL);

        expect([...(declared.get('meal_entries') ?? [])].sort()).toEqual([
            'meal_plan_meal_id',
            'nutrition_provenance',
        ]);
    });

    it('declares nothing for an index, and nothing for a table it only indexes', () => {
        const declared = declaredColumnsFromMigrationSql(
            'CREATE UNIQUE INDEX "x" ON "only_indexed" (lower("alias")) WHERE "published" = true;',
        );

        expect(declared.size).toBe(0);
    });

    it('ignores a commented-out statement and keeps a comment marker inside a literal', () => {
        const declared = declaredColumnsFromMigrationSql(`
-- ALTER TABLE "ghost" ADD COLUMN "never" TEXT;
/* CREATE TABLE "hidden" ("id" TEXT NOT NULL); */
CREATE TABLE "kept" (
    "id" TEXT NOT NULL,
    "note" TEXT NOT NULL DEFAULT 'a -- b',
    "tail" TEXT
);
`);

        expect([...declared.keys()]).toEqual(['kept']);
        expect([...(declared.get('kept') ?? [])].sort()).toEqual(['id', 'note', 'tail']);
    });

    it('does not split an item on a comma inside parentheses', () => {
        const declared = declaredColumnsFromMigrationSql(
            'CREATE TABLE "t" ("amount" NUMERIC(10,2) NOT NULL, "note" TEXT);',
        );

        expect([...(declared.get('t') ?? [])].sort()).toEqual(['amount', 'note']);
    });

    it('lower-cases unquoted and mixed-case identifiers', () => {
        const declared = declaredColumnsFromMigrationSql('create table Orders (Id text not null, Total numeric);');

        expect([...(declared.get('orders') ?? [])].sort()).toEqual(['id', 'total']);
    });

    it('reads nothing at all rather than throwing for SQL it cannot parse', () => {
        expect(declaredColumnsFromMigrationSql('DO $$ BEGIN PERFORM 1; END $$;').size).toBe(0);
        expect(declaredColumnsFromMigrationSql('CREATE TABLE "unbalanced" ("id" TEXT').size).toBe(1);
        expect(declaredColumnsFromMigrationSql('').size).toBe(0);
    });

    // Shape-only against the real migrations, for the reason given above: their
    // content belongs to other work, and this scanner only ever enriches a
    // message that a checksum already decided.
    it('reads the repository migrations into plausible table and column names', () => {
        let tables = 0;
        let columns = 0;

        for (const fingerprint of readMigrationFingerprints()) {
            for (const [table, names] of declaredColumnsFromMigrationSql(fingerprint.sql)) {
                expect(table).toMatch(/^[a-z_][a-z0-9_]*$/);
                tables += 1;

                for (const name of names) {
                    expect(name).toMatch(/^[a-z_][a-z0-9_]*$/);
                    columns += 1;
                }
            }
        }

        expect(tables).toBeGreaterThan(0);
        expect(columns).toBeGreaterThan(tables);
    });
});

describe('missingDeclaredColumns', () => {
    const observed = (
        entries: ReadonlyArray<readonly [string, readonly string[]]>,
    ): ReadonlyMap<string, ReadonlySet<string>> =>
        new Map(entries.map(([table, columns]) => [table, new Set(columns)]));

    const driftedOnFeature: LedgerComparison = {
        kind: 'drifted',
        drifted: [
            { name: FEATURE_MIGRATION, recordedChecksum: 'a'.repeat(64), onDiskChecksum: sha256(FEATURE_SQL) },
        ],
        unfinished: [],
        pending: [],
        unknown: [],
    };

    it('names the column the faulted migration declares and the database does not have', () => {
        const missing = missingDeclaredColumns(
            ON_DISK,
            driftedOnFeature,
            observed([
                ['meal_plan_preferences', ['id', 'user_id', 'allergens']],
                ['meal_entries', ['nutrition_provenance', 'meal_plan_meal_id']],
            ]),
        );

        expect(missing).toEqual(['meal_plan_preferences.targets_input_revision']);
    });

    it('reports an absent table once, rather than once per column it would have', () => {
        const missing = missingDeclaredColumns(
            ON_DISK,
            driftedOnFeature,
            observed([['meal_entries', ['nutrition_provenance', 'meal_plan_meal_id']]]),
        );

        expect(missing).toEqual(['meal_plan_preferences (no such table)']);
    });

    it('reads only the migrations that faulted', () => {
        const missing = missingDeclaredColumns(ON_DISK, driftedOnFeature, observed([]));

        expect(missing).toEqual(['meal_entries (no such table)', 'meal_plan_preferences (no such table)']);
        expect(missing.join(' ')).not.toContain('users');
    });

    it('reads a pending or unfinished migration too, and returns a sorted, deduplicated list', () => {
        const missing = missingDeclaredColumns(
            ON_DISK,
            { kind: 'pending', drifted: [], unfinished: [INIT_MIGRATION], pending: [FEATURE_MIGRATION], unknown: [] },
            observed([
                ['users', ['id']],
                ['meal_plan_preferences', ['id', 'user_id', 'allergens']],
                ['meal_entries', ['nutrition_provenance']],
            ]),
        );

        expect(missing).toEqual([
            'meal_entries.meal_plan_meal_id',
            'meal_plan_preferences.targets_input_revision',
            'users.email',
        ]);
    });

    it('is empty when the database has everything the faulted migration declares', () => {
        const missing = missingDeclaredColumns(
            ON_DISK,
            driftedOnFeature,
            observed([
                ['meal_plan_preferences', ['id', 'user_id', 'allergens', 'targets_input_revision']],
                ['meal_entries', ['nutrition_provenance', 'meal_plan_meal_id']],
            ]),
        );

        expect(missing).toEqual([]);
    });
});

describe('describeSchemaFreshnessRefusal', () => {
    const refusalFor = (comparison: LedgerComparison, missingColumns: readonly string[] = []): string =>
        describeSchemaFreshnessRefusal({
            host: '127.0.0.1',
            database: 'soh_test_46',
            comparison,
            missingColumns,
        });

    const drift: LedgerComparison = {
        kind: 'drifted',
        drifted: [{ name: FEATURE_MIGRATION, recordedChecksum: 'a'.repeat(64), onDiskChecksum: 'b'.repeat(64) }],
        unfinished: [],
        pending: [],
        unknown: [],
    };

    it('names the database, the host, the migration, both checksums and the missing column', () => {
        const message = refusalFor(drift, ['meal_plan_preferences.targets_input_revision']);

        expect(message).toContain('database "soh_test_46" on host "127.0.0.1"');
        expect(message).toContain(FEATURE_MIGRATION);
        expect(message).toContain(`recorded checksum ${'a'.repeat(64)}`);
        expect(message).toContain(`on-disk checksum  ${'b'.repeat(64)}`);
        expect(message).toContain('meal_plan_preferences.targets_input_revision');
    });

    it('says that migrate deploy will not repair a drift, and points at the guarded recreate', () => {
        const message = refusalFor(drift);

        expect(message).toContain('"npx prisma migrate deploy" will not repair this');
        expect(message).toContain('src/__tests__/setup/testDb.ts');
        expect(message).toContain(`${RECREATE_FLAG} ${CONFIRM_TARGET_FLAG} soh_test_46`);
    });

    // The remedy an operator meets is the remedy an operator runs, so the one
    // place this gate names a repair must not name a hand-typed drop: a `_test`
    // name on a tunnelled or forwarded production server satisfies every rule a
    // person can apply by eye, which is the whole reason `--recreate` exists.
    it('names no raw DROP DATABASE anywhere in the repair it recommends', () => {
        expect(refusalFor(drift)).not.toContain('DROP DATABASE');
        expect(
            refusalFor({ kind: 'unfinished', drifted: [], unfinished: [INIT_MIGRATION], pending: [], unknown: [] }),
        ).not.toContain('DROP DATABASE');
    });

    it('tells a pending migration to be deployed, and does not claim deploy is useless', () => {
        const message = refusalFor({
            kind: 'pending',
            drifted: [],
            unfinished: [],
            pending: [FEATURE_MIGRATION],
            unknown: [],
        });

        expect(message).toContain(`${FEATURE_MIGRATION} is on disk and this database has no record of it.`);
        expect(message).toContain('npx prisma migrate deploy');
        expect(message).toContain('npx prisma migrate resolve --applied');
        expect(message).not.toContain('will not repair this');
        expect(message).not.toContain('DROP DATABASE');
    });

    it('describes an unfinished migration and a ledger row with no file', () => {
        expect(
            refusalFor({ kind: 'unfinished', drifted: [], unfinished: [INIT_MIGRATION], pending: [], unknown: [] }),
        ).toContain('recorded as started but never finished, or was rolled back');

        expect(
            refusalFor({ kind: 'unknown_migration', drifted: [], unfinished: [], pending: [], unknown: ['20270101000000_gone'] }),
        ).toContain('this checkout is older than this database');
    });

    it('lists at most twelve missing columns and counts the rest', () => {
        const columns = Array.from({ length: 15 }, (_, index) => `t.c${String(index).padStart(2, '0')}`);
        const message = refusalFor(drift, columns);

        expect(message).toContain('missing from this database (15)');
        expect(message).toContain('t.c00');
        expect(message).toContain('t.c11');
        expect(message).not.toContain('t.c12');
        expect(message).toContain('... and 3 more');
    });

    it('carries no connection URL, user or password', () => {
        const message = refusalFor(drift, ['t.c']);

        expect(message).not.toContain('postgresql://');
        expect(message).not.toContain(SECRET_USER);
        expect(message).not.toContain(SECRET_PASSWORD);
    });
});


describe('assertSchemaFreshness', () => {
    let migrationsDirectory: string;

    /** A reader that answers from memory, so no case below opens a connection. */
    const readerFor = (observation: SchemaObservation): jest.MockedFunction<SchemaReader> =>
        jest.fn<Promise<SchemaObservation>, []>().mockResolvedValue(observation);

    const observationFor = (ledger: readonly AppliedMigrationRow[] | null): SchemaObservation => ({
        ledger,
        columns: new Map([
            ['users', new Set(['id', 'email'])],
            ['meal_plan_preferences', new Set(['id', 'user_id', 'allergens'])],
            ['meal_entries', new Set(['nutrition_provenance', 'meal_plan_meal_id'])],
        ]),
    });

    const freshEnv = (databaseUrl = 'postgresql://soh:soh@127.0.0.1:5433/soh_test_46'): NodeJS.ProcessEnv => ({
        ...SAFE_ENV,
        DATABASE_URL: databaseUrl,
    });

    const check = (
        env: NodeJS.ProcessEnv,
        readSchema: SchemaReader,
        directory: string | undefined = migrationsDirectory,
    ) => assertSchemaFreshness({ env, migrationsDirectory: directory, readSchema });

    const expectRefusedSchema = async (
        readSchema: SchemaReader,
        code: string,
    ): Promise<SchemaFreshnessError> => {
        let thrown: unknown;

        try {
            await check(freshEnv(), readSchema);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(SchemaFreshnessError);

        const refusal = thrown as SchemaFreshnessError;
        expect(refusal.name).toBe('SchemaFreshnessError');
        expect(refusal.code).toBe(code);

        return refusal;
    };

    beforeAll(() => {
        migrationsDirectory = mkdtempSync(join(tmpdir(), 'soh-schema-gate-'));

        for (const migration of ON_DISK) {
            mkdirSync(join(migrationsDirectory, migration.name));
            writeFileSync(join(migrationsDirectory, migration.name, 'migration.sql'), migration.sql);
        }
    });

    afterAll(() => {
        rmSync(migrationsDirectory, { recursive: true, force: true });
    });

    describe('when there is nothing to compare, it skips instead of failing', () => {
        // `envWith`, not `freshEnv`, because a default parameter cannot express
        // "unset": passing undefined to one selects the default value.
        it.each([
            { scenario: 'DATABASE_URL is unset', env: envWith({ DATABASE_URL: undefined }) },
            { scenario: 'DATABASE_URL is blank', env: envWith({ DATABASE_URL: '   ' }) },
        ])('skips as not_applicable when $scenario', async ({ env }) => {
            const readSchema = readerFor(observationFor(appliedCleanly));

            await expect(check(env, readSchema)).resolves.toEqual({
                checked: false,
                reason: 'not_applicable',
                detail: expect.stringContaining('DATABASE_URL'),
            });
            expect(readSchema).not.toHaveBeenCalled();
        });

        it.each([
            { scenario: 'the development database', databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/soh_dev_46' },
            { scenario: 'a remote test database', databaseUrl: 'postgresql://soh:soh@db.prod.example.com:5432/app_test' },
            { scenario: 'an unparsable value', databaseUrl: 'not a url' },
        ])('skips as not_applicable for $scenario, and opens no connection', async ({ databaseUrl }) => {
            const readSchema = readerFor(observationFor(appliedCleanly));

            const result = await check(freshEnv(databaseUrl), readSchema);

            expect(result).toEqual({ checked: false, reason: 'not_applicable', detail: expect.any(String) });
            // The identity guard owns that refusal; this gate must not reach for
            // a database it has just been told is not a test database.
            expect(readSchema).not.toHaveBeenCalled();
        });

        it('skips as no_migrations when no migration is on disk, naming the directory and the flag', async () => {
            const empty = mkdtempSync(join(tmpdir(), 'soh-no-migrations-'));
            const readSchema = readerFor(observationFor(appliedCleanly));

            try {
                const result = await check(freshEnv(), readSchema, empty);

                expect(result).toEqual({
                    checked: false,
                    reason: 'no_migrations',
                    detail: expect.stringContaining(empty),
                });
                expect(result.checked).toBe(false);
                expect((result as { detail: string }).detail).toContain(MIGRATIONS_DIRECTORY_FLAG);
                expect(readSchema).not.toHaveBeenCalled();
            } finally {
                rmSync(empty, { recursive: true, force: true });
            }
        });

        it.each([
            { scenario: 'no _prisma_migrations table', ledger: null },
            { scenario: 'a ledger with no rows', ledger: [] as readonly AppliedMigrationRow[] },
        ])('skips as no_ledger for $scenario, naming the command that would fix it', async ({ ledger }) => {
            const result = await check(freshEnv(), readerFor(observationFor(ledger)));

            expect(result).toEqual({
                checked: false,
                reason: 'no_ledger',
                detail: expect.stringContaining('npx prisma migrate deploy'),
            });
            expect(result.checked).toBe(false);
        });

        it('skips as unreachable when the reader cannot connect, and says to start the server', async () => {
            const readSchema: SchemaReader = jest
                .fn<Promise<SchemaObservation>, []>()
                .mockRejectedValue(new SchemaReadFailure('connection failed (ECONNREFUSED)', 'unreachable'));

            const result = await check(freshEnv(), readSchema);

            expect(result).toEqual({
                checked: false,
                reason: 'unreachable',
                detail: expect.stringContaining('ECONNREFUSED'),
            });
            expect((result as { detail: string }).detail).toContain('Start the PostgreSQL server');
            expect((result as { detail: string }).detail).toContain('database "soh_test_46" on host "127.0.0.1"');
        });

        it('skips as ledger_unreadable for any other read failure, rather than reporting a wrong schema', async () => {
            const readSchema: SchemaReader = jest
                .fn<Promise<SchemaObservation>, []>()
                .mockRejectedValue(new Error('permission denied for table _prisma_migrations'));

            const result = await check(freshEnv(), readSchema);

            expect(result).toEqual({
                checked: false,
                reason: 'ledger_unreadable',
                detail: expect.stringContaining('permission denied'),
            });
            // Deliberately no remedy: a permission, a shape this gate does not
            // understand and a timeout do not share one, so the driver's error
            // is the whole of what the detail can honestly carry. The doc
            // comment on `runSchemaFreshnessCommand` says exactly this, and
            // this is what holds it to it.
            expect((result as { detail: string }).detail).not.toContain('Start the PostgreSQL server');
            expect((result as { detail: string }).detail).not.toContain('npx prisma');
            expect((result as { detail: string }).detail).not.toContain(MIGRATIONS_DIRECTORY_FLAG);
        });

        // `not_applicable` is the fourth skip and the one the command form
        // cannot print: every URL that produces it is refused by the identity
        // gate first, which is why it carries no remedy of its own.
        it('carries no remedy for not_applicable, which the identity gate owns', async () => {
            const result = await check(
                freshEnv('postgresql://soh:soh@127.0.0.1:5433/soh_dev_46'),
                readerFor(observationFor(appliedCleanly)),
            );

            expect(result).toEqual({
                checked: false,
                reason: 'not_applicable',
                detail: expect.stringContaining('the identity guard owns that refusal'),
            });
            expect((result as { detail: string }).detail).not.toContain('npx prisma');
        });
    });

    describe('when the ledger matches', () => {
        it('reports the database it verified and how many migrations it compared', async () => {
            await expect(check(freshEnv(), readerFor(observationFor(appliedCleanly)))).resolves.toEqual({
                checked: true,
                target: 'database "soh_test_46" on host "127.0.0.1"',
                migrations: 2,
            });
        });

        it('does not mind a column the migrations never declared', async () => {
            const observation: SchemaObservation = {
                ledger: appliedCleanly,
                columns: new Map([['something_else', new Set(['whatever'])]]),
            };

            await expect(check(freshEnv(), readerFor(observation))).resolves.toEqual(
                expect.objectContaining({ checked: true }),
            );
        });
    });

    describe('when the database claims a migration state it does not have', () => {
        it('refuses a drifted checksum with one message naming the database and the missing column', async () => {
            const refusal = await expectRefusedSchema(
                readerFor(
                    observationFor([appliedCleanly[0], ledgerRow(FEATURE_MIGRATION, 'a'.repeat(64))]),
                ),
                'schema_drifted',
            );

            expect(refusal.message).toContain('database "soh_test_46" on host "127.0.0.1"');
            expect(refusal.message).toContain(FEATURE_MIGRATION);
            expect(refusal.message).toContain('meal_plan_preferences.targets_input_revision');
            expect(refusal.message).toContain('will not repair this');
        });

        it('refuses a migration on disk that the ledger has never seen', async () => {
            const refusal = await expectRefusedSchema(
                readerFor(observationFor([appliedCleanly[0]])),
                'migration_pending',
            );

            expect(refusal.message).toContain('has no record of it');
        });

        it('refuses a migration that never finished', async () => {
            await expectRefusedSchema(
                readerFor(
                    observationFor([
                        appliedCleanly[0],
                        ledgerRow(FEATURE_MIGRATION, sha256(FEATURE_SQL), { finished: false }),
                    ]),
                ),
                'migration_unfinished',
            );
        });

        it('refuses a ledger row with no migration on disk', async () => {
            await expectRefusedSchema(
                readerFor(observationFor([...appliedCleanly, ledgerRow('20270101000000_gone', 'c'.repeat(64))])),
                'migration_not_on_disk',
            );
        });

        it('carries no stack frames, so the message is not buried under this harness', async () => {
            const refusal = await expectRefusedSchema(
                readerFor(observationFor([appliedCleanly[0], ledgerRow(FEATURE_MIGRATION, 'a'.repeat(64))])),
                'schema_drifted',
            );

            expect(refusal.stack).toBe('');
        });
    });
});

describe('runSchemaFreshnessCommand', () => {
    const recordingOutput = () => {
        const lines: { log: string[]; warn: string[]; error: string[] } = { log: [], warn: [], error: [] };
        const output: CommandOutput = {
            log: (line) => lines.log.push(line),
            warn: (line) => lines.warn.push(line),
            error: (line) => lines.error.push(line),
        };

        return { lines, output };
    };

    const readerFor = (ledger: readonly AppliedMigrationRow[] | null): SchemaReader =>
        jest.fn<Promise<SchemaObservation>, []>().mockResolvedValue({
            ledger,
            columns: new Map([['meal_plan_preferences', new Set(['id'])]]),
        });

    let migrationsDirectory: string;

    beforeAll(() => {
        migrationsDirectory = mkdtempSync(join(tmpdir(), 'soh-schema-command-'));

        for (const migration of ON_DISK) {
            mkdirSync(join(migrationsDirectory, migration.name));
            writeFileSync(join(migrationsDirectory, migration.name, 'migration.sql'), migration.sql);
        }
    });

    afterAll(() => {
        rmSync(migrationsDirectory, { recursive: true, force: true });
    });

    it('exits 0 and says what it verified', async () => {
        const { lines, output } = recordingOutput();

        const code = await runSchemaFreshnessCommand([], output, {
            env: SAFE_ENV,
            migrationsDirectory,
            readSchema: readerFor(appliedCleanly),
        });

        expect(code).toBe(0);
        expect(lines.error).toEqual([]);
        expect(lines.warn).toEqual([]);
        expect(lines.log).toEqual([
            'test-database check: database "soh_test" on host "127.0.0.1" matches prisma/migrations (2 migrations).',
        ]);
    });

    it('exits 0 with one warning when the check could not run', async () => {
        const { lines, output } = recordingOutput();

        const code = await runSchemaFreshnessCommand([], output, {
            env: SAFE_ENV,
            migrationsDirectory,
            readSchema: readerFor(null),
        });

        expect(code).toBe(0);
        expect(lines.error).toEqual([]);
        expect(lines.warn).toHaveLength(1);
        expect(lines.warn[0]).toContain('not verified (no_ledger)');
        expect(lines.warn[0]).toContain('npx prisma migrate deploy');
    });

    // What the doc comment on this function claims about its skips, held to the
    // code: three of the four reachable skips print a remedy, and the fourth
    // prints the driver's error instead of guessing at one.
    it('warns with the server to start when the database cannot be reached', async () => {
        const { lines, output } = recordingOutput();

        const code = await runSchemaFreshnessCommand([], output, {
            env: SAFE_ENV,
            migrationsDirectory,
            readSchema: jest
                .fn<Promise<SchemaObservation>, []>()
                .mockRejectedValue(new SchemaReadFailure('connection failed (ECONNREFUSED)', 'unreachable')),
        });

        expect(code).toBe(0);
        expect(lines.warn).toHaveLength(1);
        expect(lines.warn[0]).toContain('not verified (unreachable)');
        expect(lines.warn[0]).toContain('Start the PostgreSQL server');
    });

    it('warns with the flag that points the comparison elsewhere when no migration is on disk', async () => {
        const { lines, output } = recordingOutput();
        const empty = mkdtempSync(join(tmpdir(), 'soh-command-no-migrations-'));

        try {
            const code = await runSchemaFreshnessCommand([], output, {
                env: SAFE_ENV,
                migrationsDirectory: empty,
                readSchema: readerFor(appliedCleanly),
            });

            expect(code).toBe(0);
            expect(lines.warn).toHaveLength(1);
            expect(lines.warn[0]).toContain('not verified (no_migrations)');
            expect(lines.warn[0]).toContain(MIGRATIONS_DIRECTORY_FLAG);
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });

    it('warns with the driver error and no invented command when the ledger cannot be read', async () => {
        const { lines, output } = recordingOutput();

        const code = await runSchemaFreshnessCommand([], output, {
            env: SAFE_ENV,
            migrationsDirectory,
            readSchema: jest
                .fn<Promise<SchemaObservation>, []>()
                .mockRejectedValue(new Error('permission denied for table _prisma_migrations')),
        });

        expect(code).toBe(0);
        expect(lines.warn).toHaveLength(1);
        expect(lines.warn[0]).toContain('not verified (ledger_unreadable)');
        expect(lines.warn[0]).toContain('permission denied');
        expect(lines.warn[0]).not.toContain('npx prisma');
        expect(lines.warn[0]).not.toContain('Start the PostgreSQL server');
    });

    it('exits 1 with exactly one message when the schema does not match', async () => {
        const { lines, output } = recordingOutput();

        const code = await runSchemaFreshnessCommand([], output, {
            env: SAFE_ENV,
            migrationsDirectory,
            readSchema: readerFor([appliedCleanly[0], ledgerRow(FEATURE_MIGRATION, 'a'.repeat(64))]),
        });

        expect(code).toBe(1);
        expect(lines.log).toEqual([]);
        expect(lines.warn).toEqual([]);
        expect(lines.error).toHaveLength(1);
        expect(lines.error[0]).toContain('Refusing to run the test suite against database "soh_test"');
        expect(lines.error[0]).toContain(FEATURE_MIGRATION);
    });

    it('exits 1 on the identity gate first, and never reads a database it was told not to touch', async () => {
        const { lines, output } = recordingOutput();
        const readSchema = readerFor(appliedCleanly);

        const code = await runSchemaFreshnessCommand([], output, {
            env: { ...SAFE_ENV, NODE_ENV: 'development' },
            migrationsDirectory,
            readSchema,
        });

        expect(code).toBe(1);
        expect(lines.error).toHaveLength(1);
        expect(lines.error[0]).toContain('NODE_ENV');
        expect(readSchema).not.toHaveBeenCalled();
    });

    it('refuses a --migrations flag with no directory after it', async () => {
        const { lines, output } = recordingOutput();

        const code = await runSchemaFreshnessCommand([MIGRATIONS_DIRECTORY_FLAG], output, {
            env: SAFE_ENV,
            readSchema: readerFor(appliedCleanly),
        });

        expect(code).toBe(1);
        expect(lines.error[0]).toContain(MIGRATIONS_DIRECTORY_FLAG);
    });

    it('compares against the directory the flag names, which outranks the caller', async () => {
        const { lines, output } = recordingOutput();
        const empty = mkdtempSync(join(tmpdir(), 'soh-flag-'));

        try {
            const code = await runSchemaFreshnessCommand([MIGRATIONS_DIRECTORY_FLAG, empty], output, {
                env: SAFE_ENV,
                migrationsDirectory,
                readSchema: readerFor(appliedCleanly),
            });

            expect(code).toBe(0);
            expect(lines.warn[0]).toContain('not verified (no_migrations)');
            expect(lines.warn[0]).toContain(empty);
        } finally {
            rmSync(empty, { recursive: true, force: true });
        }
    });
});

// The session gate. Every case here runs with NO database: the session opener
// is a parameter, so each verdict is reachable in process. The LIVE proof — a
// real `search_path` default on a real server, which is the only way to show
// that the URL guard above cannot see one — is at the foot of this file, beside
// the out-of-process proofs.
describe('assertSessionTarget', () => {
    const HOST = '127.0.0.1';
    const DATABASE = 'soh_test_34';

    const sessionEnv = (overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
        ...SAFE_ENV,
        DATABASE_URL: secretUrl(HOST, DATABASE),
        ...overrides,
    });

    /** One session's answers, as the recorder below is told to behave. */
    interface SessionPlan {
        connectError?: Error;
        queryError?: Error;
        noRow?: boolean;
        identity?: Record<string, unknown>;
    }

    const identityRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        database: DATABASE,
        schema: 'public',
        role: 'soh',
        server_version: 'PostgreSQL 16.15 on x86_64-pc-linux-musl',
        server_address: '172.17.0.2',
        server_port: 5432,
        postmaster_start_time: '2026-09-17 09:00:00.123456+00',
        search_path: '"$user", public',
        ...overrides,
    });

    const errorWithCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

    /**
     * A session that answers from memory and records what it was asked. The
     * records are the instrument: `opened` shows whether a connection was
     * attempted at all (empty is the proof that the string gate refused first),
     * `queries` shows that one round trip settled both questions, and `ended`
     * shows the handle was released even when the read failed.
     */
    const sessionRecorder = (plan: SessionPlan = {}) => {
        const opened: string[] = [];
        const queries: string[] = [];
        let ended = 0;

        const openSession: PostgresSessionOpener = (connectionString: string): PostgresSession => {
            opened.push(connectionString);

            return {
                connect: async () => {
                    if (plan.connectError !== undefined) {
                        throw plan.connectError;
                    }
                },
                query: async (sql: string) => {
                    queries.push(sql);

                    if (plan.queryError !== undefined) {
                        throw plan.queryError;
                    }

                    return { rows: plan.noRow === true ? [] : [identityRow(plan.identity)] };
                },
                end: async () => {
                    ended += 1;
                },
            };
        };

        return { openSession, opened, queries, endedCount: (): number => ended };
    };

    const expectSessionRefusal = async (
        options: { env?: NodeJS.ProcessEnv; openSession?: PostgresSessionOpener },
        code: string,
    ): Promise<TestDatabaseSessionError> => {
        let thrown: unknown;

        try {
            await assertSessionTarget(options);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(TestDatabaseSessionError);

        const refusal = thrown as TestDatabaseSessionError;
        expect(refusal.name).toBe('TestDatabaseSessionError');
        expect(refusal.code).toBe(code);
        expect(refusal.message).toContain(DATABASE);
        expect(refusal.message).toContain(HOST);
        expect(refusal.message).not.toContain(SECRET_PASSWORD);
        expect(refusal.message).not.toContain(SECRET_USER);
        expect(refusal.message).not.toContain('postgresql://');

        return refusal;
    };

    it('asks one session what it reached and returns what it verified', async () => {
        const sessions = sessionRecorder();

        const verification = await assertSessionTarget({
            env: sessionEnv(),
            openSession: sessions.openSession,
        });

        expect(verification).toEqual({
            target: `database "${DATABASE}" on host "${HOST}"`,
            database: DATABASE,
            schema: 'public',
            searchPath: '"$user", public',
            role: 'soh',
        });

        // One connection, to the URL itself, and one round trip that settles
        // both halves of the question.
        expect(sessions.opened).toEqual([secretUrl(HOST, DATABASE)]);
        expect(sessions.queries).toHaveLength(1);
        expect(sessions.queries[0]).toContain('current_database()');
        expect(sessions.queries[0]).toContain('current_schema()');
        expect(sessions.queries[0]).toContain("current_setting('search_path')");
        expect(sessions.endedCount()).toBe(1);
    });

    it('issues nothing but that one read, so the gate itself destroys nothing', async () => {
        const sessions = sessionRecorder();

        await assertSessionTarget({ env: sessionEnv(), openSession: sessions.openSession });

        for (const query of sessions.queries) {
            expect(query.startsWith('SELECT ')).toBe(true);
        }
    });

    it('refuses when the session reached a different database than the URL names', async () => {
        const sessions = sessionRecorder({ identity: { database: 'state_of_health' } });

        const refusal = await expectSessionRefusal(
            { env: sessionEnv(), openSession: sessions.openSession },
            'session_database_mismatch',
        );

        expect(refusal.message).toContain('state_of_health');
        expect(refusal.message).toContain('PG*');
    });

    it('refuses a session whose unqualified statements resolve outside public, with both resets', async () => {
        const sessions = sessionRecorder({
            identity: { schema: 'live', search_path: 'live, public' },
        });

        const refusal = await expectSessionRefusal(
            { env: sessionEnv(), openSession: sessions.openSession },
            'session_schema_redirected',
        );

        expect(refusal.message).toContain('"live"');
        expect(refusal.message).toContain('search_path is "live, public"');
        // The two server-side defaults that can do this, both named, because an
        // operator who resets only one is still redirected.
        expect(refusal.message).toContain(`ALTER ROLE soh IN DATABASE ${DATABASE} RESET search_path`);
        expect(refusal.message).toContain(`ALTER DATABASE ${DATABASE} RESET search_path`);
        expect(refusal.message).toContain('unqualified');
    });

    it('spells a current_schema the server answered as NULL rather than showing an empty name', async () => {
        // `search_path` naming only schemas that do not exist: PostgreSQL
        // answers `current_schema()` with NULL, which is not `public` either.
        const sessions = sessionRecorder({
            identity: { schema: null, search_path: 'live' },
        });

        const refusal = await expectSessionRefusal(
            { env: sessionEnv(), openSession: sessions.openSession },
            'session_schema_redirected',
        );

        expect(refusal.message).toContain('resolves in schema (none)');
        expect(refusal.message).not.toContain('schema ""');
    });

    it('refuses an unreadable session by the driver code, never by its text', async () => {
        // A real `28P01` message is `password authentication failed for user
        // "appuser"`, so quoting the text would put the database user in a
        // message this module promises never to name one in.
        const sessions = sessionRecorder({
            connectError: errorWithCode(`password authentication failed for user "${SECRET_USER}"`, '28P01'),
        });

        const refusal = await expectSessionRefusal(
            { env: sessionEnv(), openSession: sessions.openSession },
            'session_unreadable',
        );

        expect(refusal.message).toContain('driver error 28P01');
        expect(refusal.message).not.toContain('password authentication failed');
    });

    it('refuses an unreachable server rather than skipping it, because a truncate follows', async () => {
        const sessions = sessionRecorder({
            connectError: errorWithCode('connect ECONNREFUSED 127.0.0.1:5433', 'ECONNREFUSED'),
        });

        const refusal = await expectSessionRefusal(
            { env: sessionEnv(), openSession: sessions.openSession },
            'session_unreadable',
        );

        expect(refusal.message).toContain('driver error ECONNREFUSED');
        expect(sessions.endedCount()).toBe(1);
    });

    it('refuses when the identity read fails, and still hangs up', async () => {
        const sessions = sessionRecorder({ queryError: errorWithCode('canceling statement', '57014') });

        await expectSessionRefusal(
            { env: sessionEnv(), openSession: sessions.openSession },
            'session_unreadable',
        );

        expect(sessions.endedCount()).toBe(1);
    });

    it('refuses a server that answers with no identity row at all', async () => {
        const sessions = sessionRecorder({ noRow: true });

        const refusal = await expectSessionRefusal(
            { env: sessionEnv(), openSession: sessions.openSession },
            'session_unreadable',
        );

        // No SQLSTATE on this one: it is this harness's own verdict, so its
        // text is the honest detail rather than a code it does not have.
        expect(refusal.message).toContain('no row for its own identity');
    });

    it.each([
        { scenario: 'a development database name', env: { DATABASE_URL: secretUrl(HOST, 'soh_dev_34') }, code: 'database_name_not_test' },
        {
            scenario: 'a _test name on a remote host',
            env: { DATABASE_URL: secretUrl(UNROUTABLE_RFC_5737_DOCUMENTATION_HOST, 'app_test') },
            code: 'database_host_not_local',
        },
        { scenario: 'NODE_ENV that is not test', env: { NODE_ENV: 'development' }, code: 'node_env_not_test' },
        {
            scenario: 'a schema-redirecting URL',
            env: { DATABASE_URL: `${secretUrl(HOST, DATABASE)}?schema=live` },
            code: 'ambiguous_database_url',
        },
    ])('refuses $scenario on the string gate first, opening no session at all', async ({ env, code }) => {
        const sessions = sessionRecorder();
        let thrown: unknown;

        try {
            await assertSessionTarget({ env: sessionEnv(env), openSession: sessions.openSession });
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(TestDatabaseGuardError);
        expect((thrown as TestDatabaseGuardError).code).toBe(code);
        // The point of the order: a URL this module refuses is never opened in
        // order to be measured.
        expect(sessions.opened).toEqual([]);
        expect(sessions.queries).toEqual([]);
    });
});

describe('deriveDatabaseUrl', () => {
    it('replaces only the database, keeping the authority the guard judged', () => {
        expect(
            deriveDatabaseUrl(`postgresql://${SECRET_USER}:${SECRET_PASSWORD}@127.0.0.1:5433/soh_test_46`, 'postgres'),
        ).toBe(`postgresql://${SECRET_USER}:${SECRET_PASSWORD}@127.0.0.1:5433/postgres`);
    });

    it('keeps the query parameters the guard let through, because they decide connectivity', () => {
        expect(deriveDatabaseUrl('postgresql://soh:soh@localhost:5433/soh_test?sslmode=require', 'soh_test')).toBe(
            'postgresql://soh:soh@localhost:5433/soh_test?sslmode=require',
        );
    });
});

describe('pinConnectionLimit', () => {
    it('appends the bound to a URL that names none', () => {
        expect(pinConnectionLimit('postgresql://soh:soh@127.0.0.1:5433/soh_test_46')).toBe(
            `postgresql://soh:soh@127.0.0.1:5433/soh_test_46?connection_limit=${TEST_CONNECTION_LIMIT}`,
        );
    });

    it('keeps the connectivity parameters already on the URL', () => {
        expect(pinConnectionLimit('postgresql://soh:soh@localhost:5433/soh_test?sslmode=require')).toBe(
            `postgresql://soh:soh@localhost:5433/soh_test?sslmode=require&connection_limit=${TEST_CONNECTION_LIMIT}`,
        );
    });

    it('carries percent-encoded credentials through byte for byte', () => {
        expect(pinConnectionLimit(`postgresql://${SECRET_USER}:p%40ss@127.0.0.1:5433/soh_test_46`)).toBe(
            `postgresql://${SECRET_USER}:p%40ss@127.0.0.1:5433/soh_test_46?connection_limit=${TEST_CONNECTION_LIMIT}`,
        );
    });

    it('leaves a bound the caller has already chosen, however small', () => {
        const alreadyBounded = 'postgresql://soh:soh@127.0.0.1:5433/soh_test_46?connection_limit=3';
        expect(pinConnectionLimit(alreadyBounded)).toBe(alreadyBounded);
    });

    it('applies the size it is given', () => {
        expect(pinConnectionLimit('postgresql://soh:soh@127.0.0.1:5433/soh_test_46', 2)).toBe(
            'postgresql://soh:soh@127.0.0.1:5433/soh_test_46?connection_limit=2',
        );
    });

    it('returns an unparseable URL unchanged, so the refusal stays with the guard that owns it', () => {
        expect(pinConnectionLimit('!! not a url !!')).toBe('!! not a url !!');
        expectRefusal(envWith({ DATABASE_URL: '!! not a url !!' }), 'unparsable_database_url');
    });

    it('returns an absent or empty URL unchanged, because there is nothing to size', () => {
        expect(pinConnectionLimit(undefined)).toBeUndefined();
        expect(pinConnectionLimit('')).toBe('');
    });

    it('is pure: it reads no environment and writes none', () => {
        const before = process.env.DATABASE_URL;
        pinConnectionLimit('postgresql://soh:soh@127.0.0.1:5433/soh_test_46');
        expect(process.env.DATABASE_URL).toBe(before);
    });

    it('names the parameter the production client reads, so the two cannot drift apart', () => {
        expect(readFileSync(PRISMA_CLIENT_FILE, 'utf8')).toContain(`'${CONNECTION_LIMIT_PARAMETER}'`);
    });

    it('is applied by jestSetup after the guard, so the bound reaches every client in the process', () => {
        const setup = readFileSync(JEST_SETUP_FILE, 'utf8');
        const guardAt = setup.indexOf('assertTestDatabase();');
        const pinAt = setup.indexOf('pinConnectionLimit(process.env.DATABASE_URL)');

        expect(guardAt).toBeGreaterThanOrEqual(0);
        expect(pinAt).toBeGreaterThan(guardAt);
    });
});

describe('recreateStatements', () => {
    it('quotes the name as an identifier and drops only if it exists', () => {
        expect(recreateStatements('soh_test_46')).toEqual([
            'DROP DATABASE IF EXISTS "soh_test_46"',
            'CREATE DATABASE "soh_test_46"',
        ]);
    });

    it('creates without dropping when there is nothing to drop', () => {
        expect(createStatements('soh_test_46')).toEqual(['CREATE DATABASE "soh_test_46"']);
    });

    it('refuses to build DDL from a name that is not a plain identifier', () => {
        expect(() => recreateStatements('soh_test"; DROP DATABASE "soh_dev')).toThrow(
            /not a plain lower-case SQL identifier/,
        );
    });
});

describe('serverFingerprint', () => {
    const identity = {
        database: 'soh_test_46',
        schema: 'public',
        searchPath: '"$user", public',
        role: 'soh',
        serverVersion: 'PostgreSQL 16.15',
        serverAddress: '172.17.0.2',
        serverPort: 5432,
        postmasterStartTime: '2026-09-10 00:44:55.348093+00',
    };

    it('reads the same for two sessions on one server', () => {
        expect(serverFingerprint(identity)).toBe(serverFingerprint({ ...identity, database: MAINTENANCE_DATABASE }));
    });

    it('reads differently when the cluster is a different one', () => {
        expect(serverFingerprint(identity)).not.toBe(
            serverFingerprint({ ...identity, postmasterStartTime: '2026-09-11 00:00:00+00' }),
        );
    });

    it('spells an address the server did not report, so two sockets still compare equal', () => {
        const overSocket = { ...identity, serverAddress: null, serverPort: null };

        expect(serverFingerprint(overSocket)).toContain('no-address | no-port');
        expect(serverFingerprint(overSocket)).not.toBe(serverFingerprint(identity));
    });
});

describe('buildMigrateDeployInvocation', () => {
    const invocation = (env: NodeJS.ProcessEnv): MigrateDeployInvocation =>
        buildMigrateDeployInvocation({
            databaseUrl: 'postgresql://soh:soh@127.0.0.1:5433/soh_test_46',
            env,
            packageRoot: BACKEND_ROOT,
            nodeExecutable: '/usr/bin/node',
            prismaCliPath: '/app/node_modules/prisma/build/index.js',
        });

    it('runs the Prisma CLI as a module, from the package root that holds prisma/migrations', () => {
        const built = invocation({});

        expect(built.command).toBe('/usr/bin/node');
        expect(built.args).toEqual(['/app/node_modules/prisma/build/index.js', 'migrate', 'deploy']);
        expect(built.cwd).toBe(BACKEND_ROOT);
    });

    // The point of the whole function: the replay is applied to the target this
    // command validated, never to whatever the shell happened to export — which
    // in this environment is a production URL in every new shell.
    it('assigns DATABASE_URL from the derived target instead of inheriting it', () => {
        const built = invocation({
            DATABASE_URL: `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@db.prod.example.com:5432/app`,
            PATH: '/usr/bin',
        });

        expect(built.env.DATABASE_URL).toBe('postgresql://soh:soh@127.0.0.1:5433/soh_test_46');
        expect(built.env.PATH).toBe('/usr/bin');
    });
});

describe('recreateTestDatabase', () => {
    const HOST = '127.0.0.1';
    const TARGET_DATABASE = 'soh_test_46';
    const targetUrl = (database = TARGET_DATABASE, query = ''): string =>
        `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@${HOST}:5433/${database}${query}`;

    const recreateEnv = (databaseUrl = targetUrl()): NodeJS.ProcessEnv => ({ ...SAFE_ENV, DATABASE_URL: databaseUrl });

    const confirmed = (database = TARGET_DATABASE): readonly string[] => [
        RECREATE_FLAG,
        CONFIRM_TARGET_FLAG,
        database,
    ];

    /** One session's answers, as the fake below is told to behave. */
    interface SessionPlan {
        connectError?: Error;
        identityError?: Error;
        noIdentityRow?: boolean;
        identity?: Record<string, unknown>;
        statementError?: { readonly match: string; readonly error: Error };
    }

    const identityRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
        database: TARGET_DATABASE,
        schema: 'public',
        role: 'soh',
        server_version: 'PostgreSQL 16.15 on x86_64-pc-linux-musl',
        server_address: '172.17.0.2',
        server_port: 5432,
        postmaster_start_time: '2026-09-10 00:44:55.348093+00',
        search_path: '"$user", public',
        ...overrides,
    });

    const errorWithCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

    /**
     * Sessions that answer from memory and record everything. The recorder is
     * the instrument every refusal below is measured with: `issued` holds every
     * statement that reached a server, so an empty `issued` is the proof that a
     * refusal dropped nothing.
     */
    const sessionRecorder = (plans: { target?: SessionPlan; maintenance?: SessionPlan } = {}) => {
        const opened: string[] = [];
        const issued: string[] = [];
        const ended: string[] = [];

        const openSession: PostgresSessionOpener = (connectionString: string): PostgresSession => {
            const maintenance = connectionString.endsWith(`/${MAINTENANCE_DATABASE}`);
            const plan = (maintenance ? plans.maintenance : plans.target) ?? {};
            const label = maintenance ? MAINTENANCE_DATABASE : 'target';

            opened.push(label);

            return {
                connect: async () => {
                    if (plan.connectError !== undefined) {
                        throw plan.connectError;
                    }
                },
                query: async (sql: string) => {
                    if (sql.includes('current_database()')) {
                        if (plan.identityError !== undefined) {
                            throw plan.identityError;
                        }

                        // A real maintenance session answers with the
                        // maintenance database's own name, which is what makes
                        // `maintenance_is_target` a refusal rather than the
                        // normal case.
                        const answered = identityRow({
                            ...(maintenance ? { database: MAINTENANCE_DATABASE } : {}),
                            ...plan.identity,
                        });

                        return { rows: plan.noIdentityRow === true ? [] : [answered] };
                    }

                    issued.push(sql);

                    if (plan.statementError !== undefined && sql.includes(plan.statementError.match)) {
                        throw plan.statementError.error;
                    }

                    return { rows: [] };
                },
                end: async () => {
                    ended.push(label);
                },
            };
        };

        return { openSession, opened, issued, ended };
    };

    const deployRunner = (result: Partial<MigrateDeployResult> = {}) =>
        jest
            .fn<Promise<MigrateDeployResult>, [MigrateDeployInvocation]>()
            .mockResolvedValue({ exitCode: 0, signal: null, stderr: '', ...result });

    let migrationsDirectory: string;

    beforeAll(() => {
        migrationsDirectory = mkdtempSync(join(tmpdir(), 'soh-recreate-'));

        for (const migration of ON_DISK) {
            mkdirSync(join(migrationsDirectory, migration.name));
            writeFileSync(join(migrationsDirectory, migration.name, 'migration.sql'), migration.sql);
        }
    });

    afterAll(() => {
        rmSync(migrationsDirectory, { recursive: true, force: true });
    });

    const freshLedgerReader = (): SchemaReader =>
        jest.fn<Promise<SchemaObservation>, []>().mockResolvedValue({
            ledger: appliedCleanly,
            columns: new Map([['meal_plan_preferences', new Set(['id'])]]),
        });

    const options = (overrides: RecreateOptions = {}): RecreateOptions => ({
        env: recreateEnv(),
        argv: confirmed(),
        migrationsDirectory,
        readSchema: freshLedgerReader(),
        nodeExecutable: '/usr/bin/node',
        prismaCliPath: '/app/node_modules/prisma/build/index.js',
        ...overrides,
    });

    const expectRecreateRefusal = async (
        given: RecreateOptions,
        code: string,
    ): Promise<TestDatabaseRecreateError> => {
        let thrown: unknown;

        try {
            await recreateTestDatabase(given);
        } catch (error) {
            thrown = error;
        }

        expect(thrown).toBeInstanceOf(TestDatabaseRecreateError);

        const refusal = thrown as TestDatabaseRecreateError;
        expect(refusal.name).toBe('TestDatabaseRecreateError');
        expect(refusal.code).toBe(code);
        expect(refusal.message).not.toContain(SECRET_PASSWORD);
        expect(refusal.message).not.toContain('postgresql://');

        return refusal;
    };

    describe('when every check passes', () => {
        it('drops, creates, deploys against the derived URL and verifies the fresh ledger', async () => {
            const sessions = sessionRecorder();
            const runMigrateDeploy = deployRunner();

            const outcome = await recreateTestDatabase(
                options({ openSession: sessions.openSession, runMigrateDeploy }),
            );

            expect(outcome).toEqual({
                target: `database "${TARGET_DATABASE}" on host "${HOST}"`,
                dropped: true,
                statements: [`DROP DATABASE IF EXISTS "${TARGET_DATABASE}"`, `CREATE DATABASE "${TARGET_DATABASE}"`],
                migrations: ON_DISK.length,
            });

            // The target is read back FIRST and hung up before the maintenance
            // session issues anything: PostgreSQL cannot drop a database a
            // session is connected to.
            expect(sessions.opened).toEqual(['target', MAINTENANCE_DATABASE]);
            expect(sessions.ended).toEqual(['target', MAINTENANCE_DATABASE]);
            expect(sessions.issued).toEqual([
                `DROP DATABASE IF EXISTS "${TARGET_DATABASE}"`,
                `CREATE DATABASE "${TARGET_DATABASE}"`,
            ]);

            expect(runMigrateDeploy).toHaveBeenCalledTimes(1);
            expect(runMigrateDeploy.mock.calls[0][0].env.DATABASE_URL).toBe(targetUrl());
            expect(runMigrateDeploy.mock.calls[0][0].args).toEqual([
                '/app/node_modules/prisma/build/index.js',
                'migrate',
                'deploy',
            ]);
        });

        it('creates without dropping when the database does not exist yet', async () => {
            const sessions = sessionRecorder({
                target: { connectError: errorWithCode(`database "${TARGET_DATABASE}" does not exist`, '3D000') },
            });

            const outcome = await recreateTestDatabase(
                options({ openSession: sessions.openSession, runMigrateDeploy: deployRunner() }),
            );

            expect(outcome.dropped).toBe(false);
            expect(outcome.statements).toEqual([`CREATE DATABASE "${TARGET_DATABASE}"`]);
            expect(sessions.issued).not.toContain(`DROP DATABASE IF EXISTS "${TARGET_DATABASE}"`);
        });

        it('resolves the installed Prisma CLI and this running Node when the caller names neither', async () => {
            const runMigrateDeploy = deployRunner();

            await recreateTestDatabase({
                env: recreateEnv(),
                argv: confirmed(),
                migrationsDirectory,
                readSchema: freshLedgerReader(),
                openSession: sessionRecorder().openSession,
                runMigrateDeploy,
            });

            const invocation = runMigrateDeploy.mock.calls[0][0];

            expect(invocation.command).toBe(process.execPath);
            expect(invocation.args[0]).toMatch(/prisma[\\/]build[\\/]index\.js$/);
            expect(existsSync(invocation.args[0])).toBe(true);
        });
    });

    describe('the identity gate runs first, so an unsafe URL never reaches a connection', () => {
        it.each([
            {
                scenario: 'a remote host wearing a _test name',
                databaseUrl: `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@db.prod.example.com:5432/app_test`,
                code: 'database_host_not_local',
                confirm: 'app_test',
            },
            {
                scenario: 'a name that is neither _test nor ci',
                databaseUrl: targetUrl('soh_dev_46'),
                code: 'database_name_not_test',
                confirm: 'soh_dev_46',
            },
            {
                scenario: 'a schema-redirecting options parameter',
                databaseUrl: targetUrl(TARGET_DATABASE, '?options=-c%20search_path%3Dlive'),
                code: 'ambiguous_database_url',
                confirm: TARGET_DATABASE,
            },
            {
                scenario: 'a schema parameter naming another schema',
                databaseUrl: targetUrl(TARGET_DATABASE, '?schema=live'),
                code: 'ambiguous_database_url',
                confirm: TARGET_DATABASE,
            },
            {
                scenario: 'a percent-encoded database name',
                databaseUrl: targetUrl('soh%5Ftest_46'),
                code: 'ambiguous_database_url',
                confirm: 'soh%5Ftest_46',
            },
            {
                scenario: 'a connection-redirecting host parameter',
                databaseUrl: targetUrl(TARGET_DATABASE, '?host=db.prod.example.com'),
                code: 'ambiguous_database_url',
                confirm: TARGET_DATABASE,
            },
        ])('refuses $scenario as $code, opening no session and issuing no statement', async ({
            databaseUrl,
            code,
            confirm,
        }) => {
            const sessions = sessionRecorder();
            const runMigrateDeploy = deployRunner();
            let thrown: unknown;

            try {
                await recreateTestDatabase(
                    options({
                        env: recreateEnv(databaseUrl),
                        argv: confirmed(confirm),
                        openSession: sessions.openSession,
                        runMigrateDeploy,
                    }),
                );
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeInstanceOf(TestDatabaseGuardError);
            expect((thrown as TestDatabaseGuardError).code).toBe(code);
            expect(sessions.opened).toEqual([]);
            expect(sessions.issued).toEqual([]);
            expect(runMigrateDeploy).not.toHaveBeenCalled();
        });

        it.each([
            { scenario: 'NODE_ENV is not test', env: { NODE_ENV: 'development' }, code: 'node_env_not_test' },
            {
                scenario: 'ALLOW_DB_TRUNCATE is not acknowledged',
                env: { ALLOW_DB_TRUNCATE: undefined },
                code: 'truncate_not_allowed',
            },
        ])('refuses when $scenario, before anything is opened', async ({ env, code }) => {
            const sessions = sessionRecorder();
            let thrown: unknown;

            try {
                await recreateTestDatabase(
                    options({ env: { ...recreateEnv(), ...env }, openSession: sessions.openSession }),
                );
            } catch (error) {
                thrown = error;
            }

            expect((thrown as TestDatabaseGuardError).code).toBe(code);
            expect(sessions.opened).toEqual([]);
        });
    });

    describe('the confirmation is required, because an ambient DATABASE_URL is a target nobody read', () => {
        it('refuses without --confirm-target, and opens no session', async () => {
            const sessions = sessionRecorder();

            const refusal = await expectRecreateRefusal(
                options({ argv: [RECREATE_FLAG], openSession: sessions.openSession }),
                'confirmation_required',
            );

            expect(refusal.message).toContain(`${CONFIRM_TARGET_FLAG} ${TARGET_DATABASE}`);
            expect(refusal.message).toContain(`database "${TARGET_DATABASE}" on host "${HOST}"`);
            expect(sessions.opened).toEqual([]);
            expect(sessions.issued).toEqual([]);
        });

        it('refuses when --confirm-target names a different database', async () => {
            const sessions = sessionRecorder();

            const refusal = await expectRecreateRefusal(
                options({ argv: confirmed('soh_test_47'), openSession: sessions.openSession }),
                'confirmation_mismatch',
            );

            expect(refusal.message).toContain('"soh_test_47"');
            expect(sessions.issued).toEqual([]);
        });

        it('refuses a test name that cannot be quoted into DDL, before any connection', async () => {
            const sessions = sessionRecorder();

            await expectRecreateRefusal(
                options({
                    env: recreateEnv(targetUrl('SOH_test')),
                    argv: confirmed('SOH_test'),
                    openSession: sessions.openSession,
                }),
                'database_name_not_identifier',
            );

            expect(sessions.opened).toEqual([]);
        });
    });

    describe('the read-back is what a string cannot check, and nothing is dropped without it', () => {
        it('refuses a target it cannot read back, naming the reason the driver gave', async () => {
            const sessions = sessionRecorder({
                target: { connectError: errorWithCode('connect ECONNREFUSED 127.0.0.1:5433', 'ECONNREFUSED') },
            });

            const refusal = await expectRecreateRefusal(
                options({ openSession: sessions.openSession }),
                'target_unreadable',
            );

            expect(refusal.message).toContain('ECONNREFUSED');
            expect(sessions.issued).toEqual([]);
        });

        it('refuses a server that answers with no identity row at all', async () => {
            const sessions = sessionRecorder({ target: { noIdentityRow: true } });

            await expectRecreateRefusal(options({ openSession: sessions.openSession }), 'target_unreadable');

            expect(sessions.issued).toEqual([]);
        });

        it('refuses when the connection reached a different database than the URL names', async () => {
            const sessions = sessionRecorder({ target: { identity: { database: 'state_of_health' } } });

            const refusal = await expectRecreateRefusal(
                options({ openSession: sessions.openSession }),
                'target_database_mismatch',
            );

            expect(refusal.message).toContain('"state_of_health"');
            expect(sessions.issued).toEqual([]);
        });

        it('refuses a session whose unqualified statements resolve outside public', async () => {
            const sessions = sessionRecorder({
                target: { identity: { schema: 'live', search_path: 'live, public' } },
            });

            const refusal = await expectRecreateRefusal(
                options({ openSession: sessions.openSession }),
                'target_schema_redirected',
            );

            expect(refusal.message).toContain('"live"');
            expect(refusal.message).toContain('RESET search_path');
            expect(sessions.issued).toEqual([]);
        });

        it('refuses when the maintenance database cannot be reached', async () => {
            const sessions = sessionRecorder({
                maintenance: { connectError: new Error('password authentication failed for user "soh"') },
            });

            const refusal = await expectRecreateRefusal(
                options({ openSession: sessions.openSession }),
                'maintenance_unreadable',
            );

            expect(refusal.message).toContain('password authentication failed');
            expect(sessions.issued).toEqual([]);
            expect(sessions.ended).toContain(MAINTENANCE_DATABASE);
        });

        it('refuses when the maintenance session reached a different server than the read-back', async () => {
            const sessions = sessionRecorder({
                maintenance: {
                    identity: {
                        database: MAINTENANCE_DATABASE,
                        postmaster_start_time: '2026-09-11 12:00:00+00',
                    },
                },
            });

            const refusal = await expectRecreateRefusal(
                options({ openSession: sessions.openSession }),
                'server_identity_mismatch',
            );

            expect(refusal.message).toContain('different server');
            expect(sessions.issued).toEqual([]);
        });
    });

    describe('when a step fails after the checks pass', () => {
        it('reports the statement that failed, with the reason the server gave', async () => {
            const sessions = sessionRecorder({
                maintenance: {
                    identity: { database: MAINTENANCE_DATABASE },
                    statementError: {
                        match: 'DROP DATABASE',
                        error: new Error('database "soh_test_46" is being accessed by other users'),
                    },
                },
            });
            const runMigrateDeploy = deployRunner();

            const refusal = await expectRecreateRefusal(
                options({ openSession: sessions.openSession, runMigrateDeploy }),
                'recreate_statement_failed',
            );

            expect(refusal.message).toContain('being accessed by other users');
            expect(refusal.message).toContain('DROP DATABASE IF EXISTS');
            expect(sessions.issued).toEqual([`DROP DATABASE IF EXISTS "${TARGET_DATABASE}"`]);
            expect(runMigrateDeploy).not.toHaveBeenCalled();
        });

        it('reports a migrate deploy that exited non-zero, and says the database is empty', async () => {
            const refusal = await expectRecreateRefusal(
                options({
                    openSession: sessionRecorder().openSession,
                    runMigrateDeploy: deployRunner({ exitCode: 1, stderr: 'P1001: Cannot reach database server' }),
                }),
                'migrate_deploy_failed',
            );

            expect(refusal.message).toContain('exited 1');
            expect(refusal.message).toContain('P1001');
            expect(refusal.message).toContain('apply the ledger before running the suite');
        });

        it('reports a migrate deploy killed by a signal', async () => {
            const refusal = await expectRecreateRefusal(
                options({
                    openSession: sessionRecorder().openSession,
                    runMigrateDeploy: deployRunner({ exitCode: null, signal: 'SIGKILL' }),
                }),
                'migrate_deploy_failed',
            );

            expect(refusal.message).toContain('SIGKILL');
        });

        // The proof that the deploy reached THIS database: the verification is
        // this module's own schema-qualified read of public._prisma_migrations,
        // so a deploy that succeeded against some other database leaves this one
        // with no ledger and is reported rather than announced as a success.
        it('reports a recreated database whose ledger is empty afterwards', async () => {
            const refusal = await expectRecreateRefusal(
                options({
                    openSession: sessionRecorder().openSession,
                    runMigrateDeploy: deployRunner(),
                    readSchema: jest
                        .fn<Promise<SchemaObservation>, []>()
                        .mockResolvedValue({ ledger: null, columns: new Map() }),
                }),
                'ledger_not_verified',
            );

            expect(refusal.message).toContain('no_ledger');
        });

        it('lets the schema gate refusal through when the fresh ledger does not match the migrations', async () => {
            let thrown: unknown;

            try {
                await recreateTestDatabase(
                    options({
                        openSession: sessionRecorder().openSession,
                        runMigrateDeploy: deployRunner(),
                        readSchema: jest.fn<Promise<SchemaObservation>, []>().mockResolvedValue({
                            ledger: [appliedCleanly[0], ledgerRow(FEATURE_MIGRATION, 'a'.repeat(64))],
                            columns: new Map(),
                        }),
                    }),
                );
            } catch (error) {
                thrown = error;
            }

            expect(thrown).toBeInstanceOf(SchemaFreshnessError);
            expect((thrown as SchemaFreshnessError).code).toBe('schema_drifted');
        });
    });
});

describe('runRecreateCommand', () => {
    const recordingOutput = () => {
        const lines: { log: string[]; warn: string[]; error: string[] } = { log: [], warn: [], error: [] };
        const output: CommandOutput = {
            log: (line) => lines.log.push(line),
            warn: (line) => lines.warn.push(line),
            error: (line) => lines.error.push(line),
        };

        return { lines, output };
    };

    const RECREATE_ENV: NodeJS.ProcessEnv = {
        ...SAFE_ENV,
        DATABASE_URL: 'postgresql://soh:soh@127.0.0.1:5433/soh_test_46',
    };

    const passingSession: PostgresSessionOpener = (connectionString: string): PostgresSession => ({
        connect: async () => undefined,
        query: async (sql: string) =>
            sql.includes('current_database()')
                ? {
                      rows: [
                          {
                              database: connectionString.endsWith('/postgres') ? 'postgres' : 'soh_test_46',
                              schema: 'public',
                              role: 'soh',
                              server_version: 'PostgreSQL 16.15',
                              server_address: '172.17.0.2',
                              server_port: 5432,
                              postmaster_start_time: '2026-09-10 00:44:55.348093+00',
                              search_path: '"$user", public',
                          },
                      ],
                  }
                : { rows: [] },
        end: async () => undefined,
    });

    let migrationsDirectory: string;

    beforeAll(() => {
        migrationsDirectory = mkdtempSync(join(tmpdir(), 'soh-recreate-command-'));

        for (const migration of ON_DISK) {
            mkdirSync(join(migrationsDirectory, migration.name));
            writeFileSync(join(migrationsDirectory, migration.name, 'migration.sql'), migration.sql);
        }
    });

    afterAll(() => {
        rmSync(migrationsDirectory, { recursive: true, force: true });
    });

    const overridesFor = (overrides: RecreateOptions = {}): RecreateOptions => ({
        env: RECREATE_ENV,
        migrationsDirectory,
        openSession: passingSession,
        runMigrateDeploy: async () => ({ exitCode: 0, signal: null, stderr: '' }),
        readSchema: jest
            .fn<Promise<SchemaObservation>, []>()
            .mockResolvedValue({ ledger: appliedCleanly, columns: new Map() }),
        nodeExecutable: '/usr/bin/node',
        prismaCliPath: '/app/node_modules/prisma/build/index.js',
        ...overrides,
    });

    it('exits 0 and reports what it dropped, created and verified', async () => {
        const { lines, output } = recordingOutput();

        const code = await runRecreateCommand(
            [RECREATE_FLAG, CONFIRM_TARGET_FLAG, 'soh_test_46'],
            output,
            overridesFor(),
        );

        expect(code).toBe(0);
        expect(lines.error).toEqual([]);
        expect(lines.log[0]).toBe(
            'test-database recreate: database "soh_test_46" on host "127.0.0.1" dropped and recreated, ' +
                '2 migrations applied and verified.',
        );
        expect(lines.log).toContain('  DROP DATABASE IF EXISTS "soh_test_46"');
        expect(lines.log).toContain('  CREATE DATABASE "soh_test_46"');
    });

    it('exits 1 with exactly one message on a refusal, and nothing on stdout', async () => {
        const { lines, output } = recordingOutput();

        const code = await runRecreateCommand([RECREATE_FLAG], output, overridesFor());

        expect(code).toBe(1);
        expect(lines.log).toEqual([]);
        expect(lines.warn).toEqual([]);
        expect(lines.error).toHaveLength(1);
        expect(lines.error[0]).toContain(CONFIRM_TARGET_FLAG);
    });

    it('reads the confirmation from the argv it is given rather than from the process', async () => {
        const { lines, output } = recordingOutput();

        const code = await runRecreateCommand(
            [RECREATE_FLAG, `${CONFIRM_TARGET_FLAG}=soh_test_46`],
            output,
            overridesFor(),
        );

        expect(code).toBe(0);
        expect(lines.error).toEqual([]);
    });
});

describe('runTestDbCommand', () => {
    const recordingOutput = () => {
        const lines: { log: string[]; warn: string[]; error: string[] } = { log: [], warn: [], error: [] };
        const output: CommandOutput = {
            log: (line) => lines.log.push(line),
            warn: (line) => lines.warn.push(line),
            error: (line) => lines.error.push(line),
        };

        return { lines, output };
    };

    let migrationsDirectory: string;

    beforeAll(() => {
        migrationsDirectory = mkdtempSync(join(tmpdir(), 'soh-testdb-command-'));

        for (const migration of ON_DISK) {
            mkdirSync(join(migrationsDirectory, migration.name));
            writeFileSync(join(migrationsDirectory, migration.name, 'migration.sql'), migration.sql);
        }
    });

    afterAll(() => {
        rmSync(migrationsDirectory, { recursive: true, force: true });
    });

    it('runs the diagnosis when the recreate flag is absent, and opens no session for it', async () => {
        const { lines, output } = recordingOutput();
        const openSession = jest.fn<PostgresSession, [string]>();

        const code = await runTestDbCommand([], output, {
            env: SAFE_ENV,
            readSchema: jest
                .fn<Promise<SchemaObservation>, []>()
                .mockResolvedValue({ ledger: appliedCleanly, columns: new Map() }),
            migrationsDirectory,
            openSession,
        });

        expect(code).toBe(0);
        expect(lines.log[0]).toContain('test-database check:');
        expect(openSession).not.toHaveBeenCalled();
    });

    it('runs the recreate when the flag is present, and refuses it on the same identity gate', async () => {
        const { lines, output } = recordingOutput();
        const openSession = jest.fn<PostgresSession, [string]>();

        const code = await runTestDbCommand([RECREATE_FLAG, CONFIRM_TARGET_FLAG, 'soh_test'], output, {
            env: { ...SAFE_ENV, NODE_ENV: 'development' },
            openSession,
        });

        expect(code).toBe(1);
        expect(lines.error).toHaveLength(1);
        expect(lines.error[0]).toContain('NODE_ENV');
        expect(openSession).not.toHaveBeenCalled();
    });
});


// The guard cannot prove itself from inside the process it protects: by the time
// any test here runs, `jestSetup.ts` has already passed it, so a test asserting
// "it aborts" would be running in a process that had already loaded Prisma and
// possibly connected. The only place the unsafe path is observable is a child of
// our own, running the real setup file with an unsafe DATABASE_URL.
describe('the guard, proven from outside the process it protects', () => {
    const MARKER_VARIABLE = 'SOH_GUARD_PROBE_MARKER';

    // `src/prisma/client.ts` imports '../generated/prisma', not '@prisma/client',
    // so a hook watching only the package specifier would record nothing and
    // every "no database module loaded" assertion below would pass vacuously.
    //
    // `pg` is watched too, because the schema gate reads the migration ledger
    // through it: the setup file must still load no driver at import time, and
    // the command form must load `pg` and never Prisma. Anchored exactly, so
    // `pg-connection-string` and `pg/lib/...` are not mistaken for it.
    const DATABASE_MODULE_PATTERN = String.raw`@prisma[\\/]client|generated[\\/]prisma|^pg$`;

    let probeDirectory: string;
    let hookPath: string;
    let markerPath: string;
    let instrumentControlPath: string;
    let setupShapeProbePath: string;
    let truncateProbePath: string;

    beforeAll(() => {
        probeDirectory = mkdtempSync(join(tmpdir(), 'soh-guard-proof-'));
        hookPath = join(probeDirectory, 'record-database-access.js');
        markerPath = join(probeDirectory, 'database-access.log');
        instrumentControlPath = join(probeDirectory, 'instrument-control.js');
        setupShapeProbePath = join(probeDirectory, 'setup-shape-probe.js');
        truncateProbePath = join(probeDirectory, 'truncate-probe.js');

        const packagedClientFixture = join(probeDirectory, 'node_modules', '@prisma', 'client');
        mkdirSync(packagedClientFixture, { recursive: true });
        writeFileSync(join(packagedClientFixture, 'index.js'), 'module.exports = {};\n');

        mkdirSync(join(probeDirectory, 'generated'));
        writeFileSync(join(probeDirectory, 'generated', 'prisma.js'), 'module.exports = {};\n');

        writeFileSync(
            hookPath,
            `'use strict';
const Module = require('module');
const net = require('net');
const { appendFileSync } = require('fs');

const markerPath = process.env.${MARKER_VARIABLE};
const databaseModule = new RegExp(${JSON.stringify(DATABASE_MODULE_PATTERN)});
const record = (entry) => appendFileSync(markerPath, entry + '\\n');

const loadModule = Module._load;
Module._load = function (request) {
    if (typeof request === 'string' && databaseModule.test(request)) {
        record('module ' + request);
    }

    return loadModule.apply(this, arguments);
};

const openSocket = net.Socket.prototype.connect;
net.Socket.prototype.connect = function () {
    record('connect');

    return openSocket.apply(this, arguments);
};

const returnsItself = function () {
    return returnsItself;
};
globalThis.jest = new Proxy({}, { get: () => returnsItself });
`,
        );

        writeFileSync(
            instrumentControlPath,
            `'use strict';
const net = require('net');

require('@prisma/client');
require('./generated/prisma');

const socket = net.connect({ host: '127.0.0.1', port: 1 });
socket.on('error', () => socket.destroy());
socket.destroy();
`,
        );

        // Requires the real setup file and reports what its module export IS.
        // Jest awaits that export only when it is a function, so the shape is
        // the contract, and nothing inside this repository would notice if a
        // refactor turned it into an object.
        writeFileSync(
            setupShapeProbePath,
            `'use strict';
const setup = require(process.env.SOH_SETUP_FILE);

process.stdout.write('typeof=' + typeof setup + '\\n');
`,
        );

        // Calls the ONE function every DB-backed suite calls before it touches
        // data, in a process of our own, and reports on its error descriptor
        // what stopped it. Nothing reaches stdout unless the truncation
        // succeeded, so an empty stdout beside a non-zero exit is "no data was
        // emptied", and the marker file says how far the process got.
        //
        // `SOH_TRUNCATE_CALLS` calls it repeatedly, the way a suite's
        // `beforeEach` does, which is how the memoised gate's "one round trip
        // per process" is measured from outside: one recorded connect for two
        // calls.
        writeFileSync(
            truncateProbePath,
            `'use strict';
const { truncateFeatureTables } = require(process.env.SOH_TEST_DB_MODULE);

const calls = Number(process.env.SOH_TRUNCATE_CALLS || '1');

const run = async () => {
    for (let index = 0; index < calls; index += 1) {
        try {
            await truncateFeatureTables();
            process.stdout.write('truncated\\n');
        } catch (error) {
            process.stderr.write((error && error.name) + ' ' + (error && error.code) + '\\n');
            process.stderr.write(String(error && error.message) + '\\n');
            process.exitCode = 1;
        }
    }
};

run();
`,
        );
    });

    afterAll(() => {
        rmSync(probeDirectory, { recursive: true, force: true });
    });

    const readMarker = (): string => (existsSync(markerPath) ? readFileSync(markerPath, 'utf8') : '');

    const runChild = (argv: readonly string[], childEnv: NodeJS.ProcessEnv) => {
        rmSync(markerPath, { force: true });

        return spawnSync(process.execPath, [...argv], {
            cwd: BACKEND_ROOT,
            encoding: 'utf8',
            timeout: CHILD_TIMEOUT_MS,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                NODE_OPTIONS: `--require ${hookPath}`,
                [MARKER_VARIABLE]: markerPath,
                ...childEnv,
            },
        });
    };

    const runSetupFileWith = (databaseEnv: NodeJS.ProcessEnv) =>
        runChild(['--require', 'ts-node/register', JEST_SETUP_FILE], {
            TS_NODE_PROJECT: TEST_TSCONFIG,
            TS_NODE_TRANSPILE_ONLY: '1',
            ...databaseEnv,
        });

    const unsafeEnvironments: ReadonlyArray<{ scenario: string; databaseEnv: NodeJS.ProcessEnv; code: string }> = [
        {
            scenario: 'a production-shaped URL on an unroutable host',
            databaseEnv: {
                NODE_ENV: 'test',
                ALLOW_DB_TRUNCATE: 'true',
                DATABASE_URL: secretUrl(UNROUTABLE_RFC_5737_DOCUMENTATION_HOST, 'state_of_health'),
            },
            code: 'database_host_not_local',
        },
        {
            scenario: 'the local development database',
            databaseEnv: {
                NODE_ENV: 'test',
                ALLOW_DB_TRUNCATE: 'true',
                DATABASE_URL: secretUrl('127.0.0.1', 'soh_dev_46'),
            },
            code: 'database_name_not_test',
        },
        {
            scenario: 'NODE_ENV=development beside an otherwise valid test URL',
            databaseEnv: {
                NODE_ENV: 'development',
                ALLOW_DB_TRUNCATE: 'true',
                DATABASE_URL: secretUrl('127.0.0.1', 'soh_test_46'),
            },
            code: 'node_env_not_test',
        },
        {
            scenario: 'ALLOW_DB_TRUNCATE unset',
            databaseEnv: {
                NODE_ENV: 'test',
                DATABASE_URL: secretUrl('127.0.0.1', 'soh_test_46'),
            },
            code: 'truncate_not_allowed',
        },
        {
            scenario: 'DATABASE_URL unset',
            databaseEnv: {
                NODE_ENV: 'test',
                ALLOW_DB_TRUNCATE: 'true',
            },
            code: 'missing_database_url',
        },
    ];

    it(
        'records a database module load and a socket connect when they do happen, so silence below is the guard and not a broken instrument',
        () => {
            const control = runChild([instrumentControlPath], {});
            const marker = readMarker();

            expect(control.error).toBeUndefined();
            expect(control.status).toBe(0);
            expect(marker).toContain('module @prisma/client');
            expect(marker).toContain('module ./generated/prisma');
            expect(marker).toContain('connect');
        },
        CHILD_TIMEOUT_MS,
    );

    it.each(unsafeEnvironments)(
        'aborts the run for $scenario before any database module loads or any socket opens',
        ({ databaseEnv, code }) => {
            const child = runSetupFileWith(databaseEnv);

            expect(child.error).toBeUndefined();
            expect(child.signal).toBeNull();
            expect(child.status).toBe(1);
            expect(child.stderr).toContain('TestDatabaseGuardError');
            expect(child.stderr).toContain(code);
            expect(child.stderr).not.toContain(SECRET_PASSWORD);
            expect(child.stderr).not.toContain(SECRET_USER);
            expect(child.stdout).toBe('');
            expect(readMarker()).toBe('');
        },
        CHILD_TIMEOUT_MS,
    );

    it(
        'runs the same setup file to completion for a safe DATABASE_URL, so a broken child invocation cannot make the cases above pass',
        () => {
            const child = runSetupFileWith({
                NODE_ENV: 'test',
                ALLOW_DB_TRUNCATE: 'true',
                DATABASE_URL: secretUrl('127.0.0.1', 'soh_test'),
            });

            expect(child.error).toBeUndefined();
            expect(child.signal).toBeNull();
            expect(child.status).toBe(0);
            expect(child.stderr).not.toContain('TestDatabaseGuardError');
            expect(readMarker()).toBe('');
        },
        CHILD_TIMEOUT_MS,
    );

    // The schema gate is asynchronous, so it cannot run at import time like the
    // identity guard: it runs through the setup file's module export, which Jest
    // awaits before the file's first test. That contract is a shape, and this is
    // where the shape is observable.
    it(
        'exports a function from the setup file, the one shape Jest awaits, and still loads no driver to do it',
        () => {
            const child = runChild(['--require', 'ts-node/register', setupShapeProbePath], {
                TS_NODE_PROJECT: TEST_TSCONFIG,
                TS_NODE_TRANSPILE_ONLY: '1',
                SOH_SETUP_FILE: JEST_SETUP_FILE,
                NODE_ENV: 'test',
                ALLOW_DB_TRUNCATE: 'true',
                DATABASE_URL: secretUrl('127.0.0.1', 'soh_test'),
            });

            expect(child.error).toBeUndefined();
            expect(child.status).toBe(0);
            expect(child.stdout).toContain('typeof=function');
            // Importing the setup file must still reach nothing: the gate opens
            // its connection when Jest CALLS that function, not when it loads.
            expect(readMarker()).toBe('');
        },
        CHILD_TIMEOUT_MS,
    );

    describe('the command form', () => {
        const runCommandWith = (databaseEnv: NodeJS.ProcessEnv) =>
            runChild(['--require', 'ts-node/register', TEST_DB_MODULE], {
                TS_NODE_PROJECT: TEST_TSCONFIG,
                TS_NODE_TRANSPILE_ONLY: '1',
                ...databaseEnv,
            });

        it(
            'refuses on the identity gate with one line, exits 1, and loads no driver at all',
            () => {
                const child = runCommandWith({
                    NODE_ENV: 'development',
                    ALLOW_DB_TRUNCATE: 'true',
                    DATABASE_URL: secretUrl('127.0.0.1', 'soh_test'),
                });

                expect(child.error).toBeUndefined();
                expect(child.status).toBe(1);
                expect(child.stdout).toBe('');
                expect(child.stderr.trim().split('\n')).toHaveLength(1);
                expect(child.stderr).toContain('NODE_ENV');
                expect(child.stderr).not.toContain(SECRET_PASSWORD);
                expect(child.stderr).not.toContain(SECRET_USER);
                expect(readMarker()).toBe('');
            },
            CHILD_TIMEOUT_MS,
        );

        // `--recreate` is the one command in this repository that DROPS a
        // database, so its refusals are proven the same way the identity guard
        // is: from a child of our own, where "nothing was reached" is
        // observable. An empty marker file means the child loaded no driver and
        // opened no socket — which is the only way to be sure no DROP was
        // issued, because a statement needs a connection to reach a server.
        //
        // Every case below carries a correct `--confirm-target`, so what stops
        // the run is the identity gate and not a missing confirmation. The
        // command form prints the refusal's MESSAGE (the code is the in-process
        // assertion surface), so that is what each row names.
        it.each([
            {
                scenario: 'a _test name on a remote host',
                databaseUrl: secretUrl(UNROUTABLE_RFC_5737_DOCUMENTATION_HOST, 'app_test'),
                confirm: 'app_test',
                refusal: 'the host must be one of',
            },
            {
                scenario: 'a name that is neither _test nor ci',
                databaseUrl: secretUrl('127.0.0.1', 'soh_dev_46'),
                confirm: 'soh_dev_46',
                refusal: 'the database name must end in',
            },
            {
                scenario: 'a search_path redirected through options',
                databaseUrl: `${secretUrl('127.0.0.1', 'soh_test_46')}?options=-c%20search_path%3Dlive`,
                confirm: 'soh_test_46',
                refusal: 'redirects the schema',
            },
            {
                scenario: 'a percent-encoded database name',
                databaseUrl: secretUrl('127.0.0.1', 'soh%5Ftest_46'),
                confirm: 'soh%5Ftest_46',
                refusal: 'percent-encoded',
            },
        ])(
            'refuses --recreate for $scenario, reaching no server at all',
            ({ databaseUrl, confirm, refusal }) => {
                const child = runChild(
                    [
                        '--require',
                        'ts-node/register',
                        TEST_DB_MODULE,
                        RECREATE_FLAG,
                        CONFIRM_TARGET_FLAG,
                        confirm,
                    ],
                    {
                        TS_NODE_PROJECT: TEST_TSCONFIG,
                        TS_NODE_TRANSPILE_ONLY: '1',
                        NODE_ENV: 'test',
                        ALLOW_DB_TRUNCATE: 'true',
                        DATABASE_URL: databaseUrl,
                    },
                );

                expect(child.error).toBeUndefined();
                expect(child.status).toBe(1);
                expect(child.stdout).toBe('');
                expect(child.stderr).toContain(refusal);
                expect(child.stderr).not.toContain('DROP DATABASE');
                expect(child.stderr).not.toContain(SECRET_PASSWORD);
                expect(child.stderr).not.toContain(SECRET_USER);
                expect(readMarker()).toBe('');
            },
            CHILD_TIMEOUT_MS,
        );

        // The confirmation half of the same proof: a URL that passes every
        // identity rule still reaches nothing until the operator names the
        // target, which is what an inherited DATABASE_URL cannot do.
        it(
            'refuses --recreate with no --confirm-target, and reaches no server',
            () => {
                const child = runChild(['--require', 'ts-node/register', TEST_DB_MODULE, RECREATE_FLAG], {
                    TS_NODE_PROJECT: TEST_TSCONFIG,
                    TS_NODE_TRANSPILE_ONLY: '1',
                    NODE_ENV: 'test',
                    ALLOW_DB_TRUNCATE: 'true',
                    DATABASE_URL: secretUrl('127.0.0.1', 'soh_test_46'),
                });

                expect(child.error).toBeUndefined();
                expect(child.status).toBe(1);
                expect(child.stdout).toBe('');
                expect(child.stderr).toContain(CONFIRM_TARGET_FLAG);
                expect(child.stderr).toContain('soh_test_46');
                expect(child.stderr).not.toContain(SECRET_PASSWORD);
                expect(readMarker()).toBe('');
            },
            CHILD_TIMEOUT_MS,
        );

        // The fail-open half, end to end: a developer with no database gets a
        // warning and a zero exit, which is what keeps the suites that need no
        // database runnable. A port nothing can listen on stands in for that.
        it(
            'warns and exits 0 when the database cannot be reached, through pg and never through Prisma',
            () => {
                const child = runCommandWith({
                    NODE_ENV: 'test',
                    ALLOW_DB_TRUNCATE: 'true',
                    DATABASE_URL: `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@127.0.0.1:1/soh_test`,
                });
                const marker = readMarker();

                expect(child.error).toBeUndefined();
                expect(child.status).toBe(0);
                expect(`${child.stdout}${child.stderr}`).toContain('not verified (unreachable)');
                expect(`${child.stdout}${child.stderr}`).not.toContain(SECRET_PASSWORD);
                expect(marker).toContain('module pg');
                expect(marker).toContain('connect');
                expect(marker).not.toContain('generated/prisma');
                expect(marker).not.toContain('@prisma/client');
            },
            CHILD_TIMEOUT_MS,
        );
    });

    /* ---------------------------------------------------------------------- *
     * The session gate, against a real server.
     *
     * Everything above judges strings. A `search_path` default set on the role
     * or on the database is not in any string — it is in `pg_db_role_setting` —
     * so the only way to show that the URL guard cannot see it, and that the
     * session gate can, is to set one and watch both.
     *
     * The measurement runs on a DISPOSABLE database this section creates and
     * drops on the authority the suite's own `DATABASE_URL` names (through
     * `deriveDatabaseUrl`, so no host, port or credential is written here), with
     * a `_test` name so the identity gate accepts it and a `live` schema for the
     * redirect to land in. Every setting it sets is reset, and the last case
     * asserts the catalog is left with none.
     *
     * It lives inside this describe because the strongest half of the proof is
     * the child harness above: a suite that refused BEFORE touching data is a
     * claim about what did NOT happen, and the marker file is how that becomes
     * observable — the redirected child records the gate's own `pg` connect and
     * no Prisma module at all, so no `TRUNCATE` could have been issued, while
     * the same child with the default reset records the Prisma client loading.
     *
     * When no server answers, or the role may not create a database, every case
     * here reports why and passes: this file must stay runnable with no
     * PostgreSQL, which is the property the 25 pure-logic suites depend on.
     * ---------------------------------------------------------------------- */
    describe('the session gate, against a disposable probe database', () => {
        /** `_test` + a numeric tail, so `isTestDatabaseName` accepts it. */
        const PROBE_DATABASE = `soh_session_probe_test_${process.pid}`;
        const REDIRECTED_SCHEMA = 'live';
        const REDIRECTED_SEARCH_PATH = `${REDIRECTED_SCHEMA}, public`;
        const PROBE_APPLICATION_NAME = 'soh-test-db-session-probe';
        const PROBE_TIMEOUT_MS = 30_000;

        interface ProbeEnvironment {
            readonly host: string;
            readonly role: string;
            readonly probeUrl: string;
            readonly maintenanceUrl: string;
        }

        let probe: ProbeEnvironment | null = null;
        let unavailable = '';

        /** Double-quotes one identifier, doubling any quote inside it. */
        const quoted = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

        /**
         * `require`, not `import`, for the same reason the module under test
         * does it: nothing in this file may put a driver in the module graph
         * until a case that needs a server actually runs.
         */
        const openProbeSession = (connectionString: string): PostgresSession => {
            // eslint-disable-next-line @typescript-eslint/no-var-requires -- a lazy load is the point; see above
            const postgres = require('pg') as {
                Client: new (config: {
                    connectionString: string;
                    connectionTimeoutMillis?: number;
                    query_timeout?: number;
                    application_name?: string;
                }) => PostgresSession;
            };

            return new postgres.Client({
                connectionString,
                connectionTimeoutMillis: PROBE_TIMEOUT_MS,
                query_timeout: PROBE_TIMEOUT_MS,
                application_name: PROBE_APPLICATION_NAME,
            });
        };

        /** Runs statements in order on one session, always hanging up. */
        const runOnProbe = async (
            connectionString: string,
            statements: readonly string[],
        ): Promise<Array<Record<string, unknown>>> => {
            const session = openProbeSession(connectionString);
            const rows: Array<Record<string, unknown>> = [];

            await session.connect();

            try {
                for (const statement of statements) {
                    rows.push(...(await session.query(statement)).rows);
                }
            } finally {
                await session.end().catch(() => undefined);
            }

            return rows;
        };

        const probeEnv = (): NodeJS.ProcessEnv => ({
            NODE_ENV: 'test',
            ALLOW_DB_TRUNCATE: 'true',
            DATABASE_URL: (probe as ProbeEnvironment).probeUrl,
        });

        const setRoleScopedRedirect = async (): Promise<void> => {
            const { role, maintenanceUrl } = probe as ProbeEnvironment;

            await runOnProbe(maintenanceUrl, [
                `ALTER ROLE ${quoted(role)} IN DATABASE ${quoted(PROBE_DATABASE)} ` +
                    `SET search_path = ${REDIRECTED_SEARCH_PATH}`,
            ]);
        };

        const setDatabaseScopedRedirect = async (): Promise<void> => {
            await runOnProbe((probe as ProbeEnvironment).maintenanceUrl, [
                `ALTER DATABASE ${quoted(PROBE_DATABASE)} SET search_path = ${REDIRECTED_SEARCH_PATH}`,
            ]);
        };

        const resetRedirects = async (): Promise<void> => {
            const { role, maintenanceUrl } = probe as ProbeEnvironment;

            await runOnProbe(maintenanceUrl, [
                `ALTER ROLE ${quoted(role)} IN DATABASE ${quoted(PROBE_DATABASE)} RESET search_path`,
                `ALTER DATABASE ${quoted(PROBE_DATABASE)} RESET search_path`,
            ]);
        };

        const remainingDefaults = async (): Promise<number> => {
            const rows = await runOnProbe((probe as ProbeEnvironment).maintenanceUrl, [
                'SELECT count(*)::int AS settings FROM pg_db_role_setting s ' +
                    'JOIN pg_database d ON d.oid = s.setdatabase ' +
                    `WHERE d.datname = '${PROBE_DATABASE}'`,
            ]);

            return Number(rows[0]?.settings ?? -1);
        };

        /** One line per skipped case, so a vacuous pass is never silent. */
        const reportUnavailable = (): void => {
            // eslint-disable-next-line no-console -- the skip must be visible; see this section's header
            console.warn(`session-gate live proof skipped: ${unavailable}`);
        };

        beforeAll(async () => {
            const ambient = process.env.DATABASE_URL;

            if (ambient === undefined || ambient.trim().length === 0) {
                unavailable = 'DATABASE_URL is not set, so there is no authority to create a probe on';

                return;
            }

            const maintenanceUrl = deriveDatabaseUrl(ambient, MAINTENANCE_DATABASE);
            const probeUrl = deriveDatabaseUrl(ambient, PROBE_DATABASE);

            try {
                const rows = await runOnProbe(maintenanceUrl, [
                    'SELECT current_user AS role',
                    `DROP DATABASE IF EXISTS ${quoted(PROBE_DATABASE)}`,
                    `CREATE DATABASE ${quoted(PROBE_DATABASE)}`,
                ]);

                await runOnProbe(probeUrl, [`CREATE SCHEMA IF NOT EXISTS ${quoted(REDIRECTED_SCHEMA)}`]);

                probe = {
                    host: new URL(ambient).hostname,
                    role: String(rows[0]?.role ?? ''),
                    probeUrl,
                    maintenanceUrl,
                };
            } catch (error) {
                unavailable = error instanceof Error ? error.message : String(error);
            }
        }, PROBE_TIMEOUT_MS);

        afterAll(async () => {
            if (probe === null) {
                return;
            }

            // Reset before the drop as well as after every case: a setting left
            // on a shared server outlives this suite, and this server is shared.
            await resetRedirects().catch(() => undefined);
            await runOnProbe(probe.maintenanceUrl, [`DROP DATABASE IF EXISTS ${quoted(PROBE_DATABASE)}`]).catch(
                () => undefined,
            );
        }, PROBE_TIMEOUT_MS);

        it(
            'refuses a role-and-database-scoped search_path default that no URL can show',
            async () => {
                if (probe === null) {
                    reportUnavailable();

                    return;
                }

                // The URL is clean: no query string, a `_test` name, a local
                // host. The string gate accepts it, and says so here.
                expect(() => assertTestDatabase(probeEnv())).not.toThrow();

                await setRoleScopedRedirect();

                let thrown: unknown;

                try {
                    await assertSessionTarget({ env: probeEnv() });
                } catch (error) {
                    thrown = error;
                }

                expect(thrown).toBeInstanceOf(TestDatabaseSessionError);

                const refusal = thrown as TestDatabaseSessionError;
                expect(refusal.code).toBe('session_schema_redirected');
                expect(refusal.message).toContain(`"${REDIRECTED_SCHEMA}"`);
                expect(refusal.message).toContain(PROBE_DATABASE);
                expect(refusal.message).toContain(probe.host);
                expect(refusal.message).toContain('RESET search_path');
                expect(refusal.message).not.toContain('postgresql://');

                await resetRedirects();
            },
            PROBE_TIMEOUT_MS,
        );

        it(
            'refuses a database-scoped search_path default too, so resetting one default is not enough',
            async () => {
                if (probe === null) {
                    reportUnavailable();

                    return;
                }

                await setDatabaseScopedRedirect();

                let thrown: unknown;

                try {
                    await assertSessionTarget({ env: probeEnv() });
                } catch (error) {
                    thrown = error;
                }

                expect(thrown).toBeInstanceOf(TestDatabaseSessionError);
                expect((thrown as TestDatabaseSessionError).code).toBe('session_schema_redirected');
                expect((thrown as TestDatabaseSessionError).message).toContain(
                    `ALTER DATABASE ${PROBE_DATABASE} RESET search_path`,
                );

                await resetRedirects();
            },
            PROBE_TIMEOUT_MS,
        );

        it(
            'accepts the same database once both defaults are reset, reporting the public schema it reached',
            async () => {
                if (probe === null) {
                    reportUnavailable();

                    return;
                }

                await resetRedirects();

                const verification = await assertSessionTarget({ env: probeEnv() });

                expect(verification.database).toBe(PROBE_DATABASE);
                expect(verification.schema).toBe('public');
                expect(verification.target).toContain(PROBE_DATABASE);
                expect(verification.role.length).toBeGreaterThan(0);
            },
            PROBE_TIMEOUT_MS,
        );

        it(
            'refuses through truncateFeatureTables in a child process, loading no Prisma client at all',
            async () => {
                if (probe === null) {
                    reportUnavailable();

                    return;
                }

                await setRoleScopedRedirect();

                try {
                    const child = runChild(['--require', 'ts-node/register', truncateProbePath], {
                        TS_NODE_PROJECT: TEST_TSCONFIG,
                        TS_NODE_TRANSPILE_ONLY: '1',
                        SOH_TEST_DB_MODULE: TEST_DB_MODULE,
                        NODE_ENV: 'test',
                        ALLOW_DB_TRUNCATE: 'true',
                        DATABASE_URL: probe.probeUrl,
                    });
                    const marker = readMarker();

                    expect(child.error).toBeUndefined();
                    expect(child.status).toBe(1);
                    expect(child.stdout).toBe('');
                    expect(child.stderr).toContain('TestDatabaseSessionError');
                    expect(child.stderr).toContain('session_schema_redirected');
                    expect(child.stderr).toContain('RESET search_path');
                    expect(child.stderr).not.toContain('postgresql://');

                    // The gate DID reach the server — it has to, to see a
                    // setting no string carries — and the Prisma client that
                    // issues the TRUNCATE never loaded, so nothing was emptied.
                    expect(marker).toContain('module pg');
                    expect(marker).toContain('connect');
                    expect(marker).not.toContain('generated/prisma');
                    expect(marker).not.toContain('@prisma/client');
                } finally {
                    await resetRedirects();
                }
            },
            CHILD_TIMEOUT_MS,
        );

        it(
            'asks the server once per process however many times a suite truncates',
            async () => {
                if (probe === null) {
                    reportUnavailable();

                    return;
                }

                await setRoleScopedRedirect();

                try {
                    const child = runChild(['--require', 'ts-node/register', truncateProbePath], {
                        TS_NODE_PROJECT: TEST_TSCONFIG,
                        TS_NODE_TRANSPILE_ONLY: '1',
                        SOH_TEST_DB_MODULE: TEST_DB_MODULE,
                        SOH_TRUNCATE_CALLS: '2',
                        NODE_ENV: 'test',
                        ALLOW_DB_TRUNCATE: 'true',
                        DATABASE_URL: probe.probeUrl,
                    });
                    const connects = readMarker()
                        .split('\n')
                        .filter((entry) => entry === 'connect');

                    expect(child.error).toBeUndefined();
                    expect(child.status).toBe(1);
                    // Both calls refused — the memoised verdict is the refusal,
                    // so a later `beforeEach` cannot slip past it — on the
                    // strength of ONE connection.
                    expect(child.stderr.match(/session_schema_redirected/g) ?? []).toHaveLength(2);
                    expect(connects).toHaveLength(1);
                } finally {
                    await resetRedirects();
                }
            },
            CHILD_TIMEOUT_MS,
        );

        it(
            'lets the same child through to the data layer once the default is reset, so the refusal above was the gate',
            async () => {
                if (probe === null) {
                    reportUnavailable();

                    return;
                }

                await resetRedirects();

                const child = runChild(['--require', 'ts-node/register', truncateProbePath], {
                    TS_NODE_PROJECT: TEST_TSCONFIG,
                    TS_NODE_TRANSPILE_ONLY: '1',
                    SOH_TEST_DB_MODULE: TEST_DB_MODULE,
                    NODE_ENV: 'test',
                    ALLOW_DB_TRUNCATE: 'true',
                    DATABASE_URL: probe.probeUrl,
                });
                const marker = readMarker();

                expect(child.error).toBeUndefined();
                expect(child.stderr).not.toContain('TestDatabaseSessionError');
                // The probe database carries no migration, so the statement
                // itself fails on a missing table — which is the point: the run
                // got as far as the Prisma client and the server, which is
                // exactly what the redirected run above never did.
                expect(marker).toContain('generated/prisma');
            },
            CHILD_TIMEOUT_MS,
        );

        it(
            'leaves the shared server with no default of its own behind',
            async () => {
                if (probe === null) {
                    reportUnavailable();

                    return;
                }

                await resetRedirects();

                expect(await remainingDefaults()).toBe(0);
            },
            PROBE_TIMEOUT_MS,
        );
    });
});
