import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
    AppliedMigrationRow,
    CommandOutput,
    LedgerComparison,
    MigrationFingerprint,
    SchemaObservation,
    SchemaReader,
} from './testDb';
import {
    FEATURE_TABLES,
    MIGRATIONS_DIRECTORY,
    MIGRATIONS_DIRECTORY_FLAG,
    SchemaFreshnessError,
    SchemaReadFailure,
    TestDatabaseGuardError,
    assertSchemaFreshness,
    assertTestDatabase,
    compareMigrationLedger,
    declaredColumnsFromMigrationSql,
    describeSchemaFreshnessRefusal,
    missingDeclaredColumns,
    readMigrationFingerprints,
    runSchemaFreshnessCommand,
} from './testDb';

const BACKEND_ROOT = join(__dirname, '..', '..', '..');
const JEST_SETUP_FILE = join(__dirname, 'jestSetup.ts');
/** The module under test, which is also the `npm run check:test-db` program. */
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
    "estimate_inputs_revision" INTEGER,
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
            'estimate_inputs_revision',
            'id',
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

        expect(missing).toEqual(['meal_plan_preferences.estimate_inputs_revision']);
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
            'meal_plan_preferences.estimate_inputs_revision',
            'users.email',
        ]);
    });

    it('is empty when the database has everything the faulted migration declares', () => {
        const missing = missingDeclaredColumns(
            ON_DISK,
            driftedOnFeature,
            observed([
                ['meal_plan_preferences', ['id', 'user_id', 'allergens', 'estimate_inputs_revision']],
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
        const message = refusalFor(drift, ['meal_plan_preferences.estimate_inputs_revision']);

        expect(message).toContain('database "soh_test_46" on host "127.0.0.1"');
        expect(message).toContain(FEATURE_MIGRATION);
        expect(message).toContain(`recorded checksum ${'a'.repeat(64)}`);
        expect(message).toContain(`on-disk checksum  ${'b'.repeat(64)}`);
        expect(message).toContain('meal_plan_preferences.estimate_inputs_revision');
    });

    it('says that migrate deploy will not repair a drift, and how to recreate the database', () => {
        const message = refusalFor(drift);

        expect(message).toContain('"npx prisma migrate deploy" will not repair this');
        expect(message).toContain('DROP DATABASE "soh_test_46"; CREATE DATABASE "soh_test_46";');
        expect(message).toContain('npx prisma migrate deploy');
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

        it('skips as no_migrations when no migration is on disk', async () => {
            const empty = mkdtempSync(join(tmpdir(), 'soh-no-migrations-'));
            const readSchema = readerFor(observationFor(appliedCleanly));

            try {
                await expect(check(freshEnv(), readSchema, empty)).resolves.toEqual({
                    checked: false,
                    reason: 'no_migrations',
                    detail: expect.stringContaining(empty),
                });
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

        it('skips as unreachable when the reader cannot connect', async () => {
            const readSchema: SchemaReader = jest
                .fn<Promise<SchemaObservation>, []>()
                .mockRejectedValue(new SchemaReadFailure('connection failed (ECONNREFUSED)', 'unreachable'));

            await expect(check(freshEnv(), readSchema)).resolves.toEqual({
                checked: false,
                reason: 'unreachable',
                detail: expect.stringContaining('ECONNREFUSED'),
            });
        });

        it('skips as ledger_unreadable for any other read failure, rather than reporting a wrong schema', async () => {
            const readSchema: SchemaReader = jest
                .fn<Promise<SchemaObservation>, []>()
                .mockRejectedValue(new Error('permission denied for table _prisma_migrations'));

            await expect(check(freshEnv(), readSchema)).resolves.toEqual({
                checked: false,
                reason: 'ledger_unreadable',
                detail: expect.stringContaining('permission denied'),
            });
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
            expect(refusal.message).toContain('meal_plan_preferences.estimate_inputs_revision');
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

    beforeAll(() => {
        probeDirectory = mkdtempSync(join(tmpdir(), 'soh-guard-proof-'));
        hookPath = join(probeDirectory, 'record-database-access.js');
        markerPath = join(probeDirectory, 'database-access.log');
        instrumentControlPath = join(probeDirectory, 'instrument-control.js');
        setupShapeProbePath = join(probeDirectory, 'setup-shape-probe.js');

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
});
