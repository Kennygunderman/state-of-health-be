// The dual-ledger gate.
//
// Two files in this repository contain the same meal-planning DDL, and the
// Agent Action Plan (0.1.4 "Migration ledger", 0.9.1 "Schema — dual-ledger
// equivalence") resolves that duplication by naming one of them authoritative
// rather than by deleting either:
//
//   * prisma/migrations/20260908000000_meal_planning/migration.sql is the
//     ledger that actually runs. `prisma migrate deploy` applies it at
//     container boot and in CI, so it is what every environment gets.
//   * prisma/manual-migrations/meal-planning/001_meal_planning.sql is the
//     operator reference copy the prompt requires: the same DDL written
//     idempotently (CREATE TABLE IF NOT EXISTS, ADD COLUMN IF NOT EXISTS,
//     guarded DO blocks) for an operator who has to apply it by hand. It is
//     excluded from the image and run by no tooling.
//
// "The same DDL" is the whole load-bearing claim, and the plan is explicit
// that it must be proven rather than asserted. This suite is that proof. It
// builds two disposable databases, migrates one by each ledger, and compares
// them; and because a schema comparison alone would say nothing about the
// users whose data the migration runs over, it first loads
// data/meal-planning/fixtures/legacy-upgrade.fixture.json — a representative
// pre-feature dataset — and checks every legacy row through the migration.
//
// What it establishes, in the order the describes below run:
//   1. the committed fixture is representative (three target profiles, all four
//      food sources, soft deletes, fractional servings, a zero-calorie day) and
//      contains nothing the migration adds, so it can load into a database that
//      has only the init migration applied;
//   2. applying the Prisma ledger and then the manual copy leaves the manual
//      copy a no-op — every statement reports "already exists, skipping" and
//      the schema does not move;
//   3. applying the manual copy by hand and then `migrate resolve --applied`
//      leaves `migrate deploy` with nothing to apply, which is the operator
//      procedure the manual-migrations README documents;
//   4. the two resulting schemas are identical — same columns in the same
//      positions with the same types, defaults and generation expressions, same
//      indexes, same constraints, and (where pg_dump is available) the same
//      normalised schema dump;
//   5. every legacy row survives both ledgers byte-for-byte, and none of the
//      four additive meal_entries columns was backfilled.
//
// Safety. This suite never touches the database DATABASE_URL points at. It
// derives two names from it, refuses to proceed unless each derived name is a
// test-class name that differs from the ambient one (the same rules
// scripts/lib/dbGuard.ts applies to the CLI pipeline), and drops both at the
// end — and again at the start, so an interrupted run leaves nothing behind.
// It creates databases rather than truncating a shared one, which is why it
// does not ask for the ALLOW_DB_TRUNCATE flag that the truncating helpers use:
// there is nothing here for that flag to protect.
//
// Requirements, and what happens without them. The suite needs a test-class
// DATABASE_URL and the Prisma CLI; without either it registers a single
// skipped test whose name says which one is missing, so the gate is visibly
// absent instead of silently passing. pg_dump is optional in the same way and
// only skips its own assertion, because the catalogue comparison in (4) is the
// essential proof and runs from SQL alone. Anything that fails once the
// environment has claimed capability is a failure, never a skip. The role
// behind DATABASE_URL must be able to CREATE DATABASE; if it cannot, the
// PostgreSQL permission error surfaces from beforeAll.

import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import { classifyDatabaseOrigin, isTestDatabaseName } from '../../../scripts/lib/dbGuard';

// --------------------------------------------------------------------------
// A narrow typed surface over node-postgres.
//
// `pg` is a runtime dependency of this service but ships no type declarations,
// and @types/pg is deliberately not added for one test file. Declaring only the
// four calls this suite makes keeps it type-safe under `strict` without
// widening the dependency set, and keeps the Prisma client out of it — the
// client is bound to a single DATABASE_URL at import time and so cannot reach
// the disposable databases this suite creates.
// --------------------------------------------------------------------------

interface PgQueryResult<TRow> {
    rows: TRow[];
}

interface PgClient {
    connect(): Promise<void>;
    query<TRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<TRow>>;
    end(): Promise<void>;
    on(event: 'notice', listener: (notice: { message?: string }) => void): void;
}

interface PgModule {
    Client: new (config: { connectionString: string }) => PgClient;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pg = require('pg') as PgModule;

const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');
const PRISMA_BIN = path.join(BACKEND_ROOT, 'node_modules', '.bin', 'prisma');
const PRISMA_SCHEMA = path.join('prisma', 'schema.prisma');
const FIXTURE_PATH = path.join(BACKEND_ROOT, 'data', 'meal-planning', 'fixtures', 'legacy-upgrade.fixture.json');

const INIT_MIGRATION = '20260706000000_init';
const FEATURE_MIGRATION = '20260908000000_meal_planning';
const INIT_SQL = path.join(BACKEND_ROOT, 'prisma', 'migrations', INIT_MIGRATION, 'migration.sql');
const FEATURE_SQL = path.join(BACKEND_ROOT, 'prisma', 'migrations', FEATURE_MIGRATION, 'migration.sql');
const MANUAL_SQL = path.join(
    BACKEND_ROOT,
    'prisma',
    'manual-migrations',
    'meal-planning',
    '001_meal_planning.sql',
);

// The four columns 20260908000000_meal_planning adds to meal_entries. They are
// excluded from every row hash so that one hash query works before and after
// the migration, and they are asserted null afterwards so a silent backfill
// cannot hide inside "the rows are still there".
const ADDITIVE_MEAL_ENTRY_COLUMNS = [
    'meal_plan_meal_id',
    'catalog_food_id',
    'recipe_version_id',
    'nutrition_provenance',
] as const;

// The sixteen tables the migration introduces. Listed so the equivalence check
// cannot pass vacuously: two databases that both failed to gain the feature
// schema would compare equal to each other.
const MEAL_PLANNING_TABLES = [
    'catalog_foods',
    'catalog_food_aliases',
    'catalog_food_portions',
    'catalog_food_components',
    'catalog_validation_records',
    'catalog_import_runs',
    'catalog_generation_batches',
    'recipes',
    'recipe_versions',
    'recipe_ingredients',
    'meal_plan_preferences',
    'meal_plans',
    'meal_plan_days',
    'meal_plan_meals',
    'grocery_items',
    'meal_plan_actions',
] as const;

const FIXTURE_METADATA_KEYS = ['fixture_version', 'description', 'insert_order', 'type_notes'];

// 'note' is documentation carried on a fixture row, not a column. Every other
// key must be a real column of its table, or the loader throws: a fixture that
// drifts from the schema has to fail loudly rather than quietly drop data.
const FIXTURE_ANNOTATION_KEY = 'note';

interface LegacyFixture {
    fixture_version: string;
    description: string;
    insert_order: string[];
    type_notes: Record<string, string>;
    [collection: string]: unknown;
}

type FixtureRow = Record<string, unknown>;

// --------------------------------------------------------------------------
// Capability probe. Runs at collection time, because whether this suite can
// run at all decides whether its tests are registered or skipped.
// --------------------------------------------------------------------------

type Capability = { ok: true; ambientUrl: string; ambientDatabase: string } | { ok: false; reason: string };

const probeCapability = (): Capability => {
    const ambientUrl = process.env.DATABASE_URL;
    const origin = classifyDatabaseOrigin(ambientUrl);

    if (origin.originClass !== 'test') {
        return {
            ok: false,
            reason: `DATABASE_URL must name a test database (it classified as '${origin.originClass}': ${origin.reason})`,
        };
    }
    if (typeof ambientUrl !== 'string' || ambientUrl.length === 0) {
        return { ok: false, reason: 'DATABASE_URL is not set' };
    }
    if (!fs.existsSync(PRISMA_BIN)) {
        return { ok: false, reason: `the Prisma CLI is not installed at ${PRISMA_BIN}` };
    }
    for (const sqlPath of [INIT_SQL, FEATURE_SQL, MANUAL_SQL]) {
        if (!fs.existsSync(sqlPath)) {
            return { ok: false, reason: `a migration ledger is missing: ${sqlPath}` };
        }
    }
    if (!fs.existsSync(FIXTURE_PATH)) {
        return { ok: false, reason: `the legacy fixture is missing: ${FIXTURE_PATH}` };
    }

    return { ok: true, ambientUrl, ambientDatabase: origin.database };
};

const pgDumpBinary = (): string => process.env.PG_DUMP_BIN || 'pg_dump';

const probePgDump = (): boolean => {
    const probe = spawnSync(pgDumpBinary(), ['--version'], { encoding: 'utf8' });
    return probe.status === 0 && /pg_dump/i.test(String(probe.stdout));
};

// --------------------------------------------------------------------------
// Local helpers. Kept inside this file on purpose: a shared test-helper module
// would be ceremony for one suite, and these encode decisions that only make
// sense here (UTC sessions, hashes that ignore the additive columns, a
// normaliser tuned to pg_dump's preamble).
// --------------------------------------------------------------------------

const databaseUrlFor = (ambientUrl: string, database: string): string => {
    const url = new URL(ambientUrl);
    url.pathname = `/${database}`;
    return url.toString();
};

const withClient = async <TResult>(
    url: string,
    run: (client: PgClient, notices: string[]) => Promise<TResult>,
): Promise<TResult> => {
    const client = new pg.Client({ connectionString: url });
    const notices: string[] = [];

    client.on('notice', (notice) => notices.push(String(notice.message ?? '')));
    await client.connect();
    // Both settings are what make the row hashes comparable at all: a timestamptz
    // rendered through a different session zone, or a date through a different
    // DateStyle, hashes differently while holding the same instant.
    await client.query("SET TIME ZONE 'UTC'");
    await client.query("SET DATESTYLE TO 'ISO, MDY'");

    try {
        return await run(client, notices);
    } finally {
        await client.end();
    }
};

const runPrisma = (url: string, args: string[]): { status: number; stdout: string; stderr: string } => {
    const result = spawnSync(PRISMA_BIN, [...args, '--schema', PRISMA_SCHEMA], {
        cwd: BACKEND_ROOT,
        encoding: 'utf8',
        // DATABASE_URL is passed per invocation and process.env is left alone.
        // The CLI loads backend/.env itself, and an env entry here outranks it,
        // so the child targets the disposable database no matter what .env says.
        env: { ...process.env, DATABASE_URL: url },
    });

    return {
        status: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: String(result.stderr ?? ''),
    };
};

const expectPrismaSuccess = (label: string, result: { status: number; stdout: string; stderr: string }): string => {
    if (result.status !== 0) {
        throw new Error(`${label} failed with status ${result.status}\n${result.stdout}\n${result.stderr}`);
    }
    return result.stdout;
};

const recreateDatabase = async (maintenanceUrl: string, database: string): Promise<void> => {
    await withClient(maintenanceUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
        await client.query(`CREATE DATABASE "${database}"`);
    });
};

const dropDatabase = async (maintenanceUrl: string, database: string): Promise<void> => {
    await withClient(maintenanceUrl, async (client) => {
        await client.query(`DROP DATABASE IF EXISTS "${database}" WITH (FORCE)`);
    });
};

// Applies a ledger file as one simple query. Sending the whole file in a single
// statement is deliberate: the manual copy uses dollar-quoted DO blocks whose
// bodies contain semicolons, which a naive split on ';' would tear apart.
const applyLedgerFile = async (url: string, sqlPath: string): Promise<string[]> =>
    withClient(url, async (client, notices) => {
        await client.query(fs.readFileSync(sqlPath, 'utf8'));
        return [...notices];
    });

const loadFixture = async (url: string, fixture: LegacyFixture): Promise<Record<string, number>> =>
    withClient(url, async (client) => {
        const loaded: Record<string, number> = {};

        for (const table of fixture.insert_order) {
            const columns = await client.query<{ column_name: string }>(
                `SELECT column_name FROM information_schema.columns
                 WHERE table_schema = 'public' AND table_name = $1`,
                [table],
            );
            if (columns.rows.length === 0) {
                throw new Error(`fixture collection '${table}' has no table in this database`);
            }
            const known = new Set(columns.rows.map((row) => row.column_name));
            let inserted = 0;

            for (const row of fixtureRows(fixture, table)) {
                const keys = Object.keys(row).filter((key) => key !== FIXTURE_ANNOTATION_KEY);
                const unknown = keys.filter((key) => !known.has(key));
                if (unknown.length > 0) {
                    throw new Error(`fixture collection '${table}' has unknown column(s): ${unknown.join(', ')}`);
                }

                const identifiers = keys.map((key) => `"${key}"`).join(', ');
                const placeholders = keys.map((_key, index) => `$${index + 1}`).join(', ');
                await client.query(
                    `INSERT INTO "${table}" (${identifiers}) VALUES (${placeholders})`,
                    keys.map((key) => row[key]),
                );
                inserted += 1;
            }

            loaded[table] = inserted;
        }

        return loaded;
    });

// Every column, index and constraint of the public schema as sorted lines.
// Sorted so the comparison is order-independent, but carrying
// ordinal_position as a compared value so a column added in a different
// position is still caught.
const readCatalogue = async (url: string): Promise<string[]> =>
    withClient(url, async (client) => {
        const columns = await client.query<{
            table_name: string;
            column_name: string;
            ordinal_position: number;
            data_type: string;
            udt_name: string;
            is_nullable: string;
            column_default: string;
            character_maximum_length: string;
            numeric_precision: string;
            numeric_scale: string;
            datetime_precision: string;
            is_generated: string;
            generation_expression: string;
        }>(
            `SELECT table_name, column_name, ordinal_position, data_type, udt_name, is_nullable,
                    COALESCE(column_default, '') AS column_default,
                    COALESCE(character_maximum_length::text, '') AS character_maximum_length,
                    COALESCE(numeric_precision::text, '') AS numeric_precision,
                    COALESCE(numeric_scale::text, '') AS numeric_scale,
                    COALESCE(datetime_precision::text, '') AS datetime_precision,
                    is_generated,
                    COALESCE(generation_expression, '') AS generation_expression
             FROM information_schema.columns
             WHERE table_schema = 'public'
             ORDER BY table_name, column_name`,
        );

        const indexes = await client.query<{ tablename: string; indexname: string; indexdef: string }>(
            `SELECT tablename, indexname, indexdef FROM pg_indexes
             WHERE schemaname = 'public'
             ORDER BY tablename, indexname`,
        );

        const constraints = await client.query<{ table_name: string; conname: string; definition: string }>(
            `SELECT con.conrelid::regclass::text AS table_name, con.conname,
                    pg_get_constraintdef(con.oid) AS definition
             FROM pg_constraint con
             JOIN pg_namespace nsp ON nsp.oid = con.connamespace
             WHERE nsp.nspname = 'public'
             ORDER BY 1, 2, 3`,
        );

        return [
            ...columns.rows.map(
                (row) =>
                    `COLUMN ${row.table_name}.${row.column_name} position=${row.ordinal_position} ` +
                    `type=${row.data_type}/${row.udt_name} nullable=${row.is_nullable} ` +
                    `default=${row.column_default} length=${row.character_maximum_length} ` +
                    `numeric=${row.numeric_precision},${row.numeric_scale} datetime=${row.datetime_precision} ` +
                    `generated=${row.is_generated} expression=${row.generation_expression}`,
            ),
            ...indexes.rows.map((row) => `INDEX ${row.tablename} ${row.indexname} ${row.indexdef}`),
            ...constraints.rows.map((row) => `CONSTRAINT ${row.table_name} ${row.conname} ${row.definition}`),
        ];
    });

// A row count and a content hash per table. The hash is order-independent
// (string_agg over sorted per-row hashes) and ignores the additive columns, so
// the identical query describes a table before and after the migration.
const readTableFingerprints = async (url: string, tables: string[]): Promise<Record<string, string>> =>
    withClient(url, async (client) => {
        const fingerprints: Record<string, string> = {};
        const withoutAdditiveColumns = ADDITIVE_MEAL_ENTRY_COLUMNS.map((column) => `- '${column}'`).join(' ');

        for (const table of tables) {
            // The alias must not be spelled like any column of any table here:
            // `to_jsonb(x)` resolves x to a column before a table alias, so
            // aliasing this `source` silently hashes foods.source instead of the
            // row (PostgreSQL then reports 'cannot delete from scalar').
            try {
                const result = await client.query<{ row_count: number; row_hash: string }>(
                    `SELECT COUNT(*)::int AS row_count,
                            COALESCE(md5(string_agg(row_digest, '' ORDER BY row_digest)), 'empty') AS row_hash
                     FROM (
                         SELECT md5(((to_jsonb(hashed_row) ${withoutAdditiveColumns}))::text) AS row_digest
                         FROM "${table}" hashed_row
                     ) digests`,
                );
                const [row] = result.rows;
                fingerprints[table] = `${row.row_count} rows / ${row.row_hash}`;
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                throw new Error(`could not fingerprint table '${table}': ${detail}`);
            }
        }

        return fingerprints;
    });

const readPublicTableNames = async (url: string): Promise<string[]> =>
    withClient(url, async (client) => {
        const result = await client.query<{ table_name: string }>(
            `SELECT table_name FROM information_schema.tables
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
             ORDER BY table_name`,
        );
        return result.rows.map((row) => row.table_name);
    });

const readMealEntryAdditiveColumns = async (url: string): Promise<string[]> =>
    withClient(url, async (client) => {
        const result = await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'meal_entries'
               AND column_name = ANY($1::text[])
             ORDER BY column_name`,
            [[...ADDITIVE_MEAL_ENTRY_COLUMNS]],
        );
        return result.rows.map((row) => row.column_name);
    });

const countBackfilledMealEntries = async (url: string): Promise<number> =>
    withClient(url, async (client) => {
        const predicate = ADDITIVE_MEAL_ENTRY_COLUMNS.map((column) => `"${column}" IS NOT NULL`).join(' OR ');
        const result = await client.query<{ backfilled: number }>(
            `SELECT COUNT(*)::int AS backfilled FROM meal_entries WHERE ${predicate}`,
        );
        return result.rows[0].backfilled;
    });

const readSearchVectorDefinition = async (url: string): Promise<string> =>
    withClient(url, async (client) => {
        const result = await client.query<{ is_generated: string; generation_expression: string }>(
            `SELECT is_generated, COALESCE(generation_expression, '') AS generation_expression
             FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'catalog_foods' AND column_name = 'search_vector'`,
        );
        const [row] = result.rows;
        return row === undefined ? 'absent' : `${row.is_generated} ${row.generation_expression}`;
    });

// pg_dump's preamble is environment noise: comments carry the server and dump
// versions, and the SET / set_config lines carry session settings. Dropping
// them leaves the DDL, which is what the two ledgers are being compared on.
const normalizeSchemaDump = (dump: string): string[] =>
    dump
        .split('\n')
        .map((line) => line.replace(/\r$/, ''))
        .filter(
            (line) =>
                line.trim() !== '' &&
                !/^\s*--/.test(line) &&
                !/^SET\s/.test(line) &&
                !/^SELECT pg_catalog\.set_config/.test(line) &&
                !/^\\/.test(line),
        );

const readSchemaDump = (url: string): string[] | null => {
    const result = spawnSync(
        pgDumpBinary(),
        ['--schema-only', '--no-owner', '--no-privileges', '--no-comments', url],
        { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
    );
    if (result.status !== 0) {
        return null;
    }
    return normalizeSchemaDump(String(result.stdout ?? ''));
};

const symmetricDifference = (left: string[], right: string[]): { onlyInFirst: string[]; onlyInSecond: string[] } => {
    const leftSet = new Set(left);
    const rightSet = new Set(right);
    return {
        onlyInFirst: left.filter((line) => !rightSet.has(line)),
        onlyInSecond: right.filter((line) => !leftSet.has(line)),
    };
};

const readFixture = (): LegacyFixture => JSON.parse(fs.readFileSync(FIXTURE_PATH, 'utf8')) as LegacyFixture;

const fixtureRows = (fixture: LegacyFixture, collection: string): FixtureRow[] => {
    const rows = fixture[collection];
    return Array.isArray(rows) ? (rows as FixtureRow[]) : [];
};

const fixtureCollections = (fixture: LegacyFixture): string[] =>
    Object.keys(fixture).filter((key) => !FIXTURE_METADATA_KEYS.includes(key));

// --------------------------------------------------------------------------
// The suite
// --------------------------------------------------------------------------

const capability = probeCapability();

if (!capability.ok) {
    // Jest prints no test names for a wholly skipped suite, so the skip alone
    // would be a line of output nobody can act on. This is the reason, written
    // where it cannot be missed.
    // eslint-disable-next-line no-console
    console.warn(
        `[compat.test.ts] The dual-ledger equivalence gate did NOT run: ${capability.reason}. ` +
            'It proves that prisma/migrations/20260908000000_meal_planning and ' +
            'prisma/manual-migrations/meal-planning/001_meal_planning.sql produce the same schema and ' +
            'preserve every legacy row. Point DATABASE_URL at a test database to run it.',
    );
}

describe('migration ledgers', () => {
    if (!capability.ok) {
        // Registered as a skip rather than silently omitted: the status stays
        // honest (a skip is not a pass) and the reason travels with the name.
        it.skip(`prove the Prisma migration and the manual copy agree — not run because ${capability.reason}`, () => {
            expect(capability.ok).toBe(false);
        });
        return;
    }

    const ambientUrl = capability.ambientUrl;
    const maintenanceUrl = databaseUrlFor(ambientUrl, 'postgres');
    // Derived from the ambient name and suffixed '_test' so both stay inside the
    // test class dbGuard recognises, whether the ambient database is a clone's
    // soh_test_<index> or CI's plainly named one.
    const ledgerADatabase = `${capability.ambientDatabase}_ledger_a_test`;
    const ledgerBDatabase = `${capability.ambientDatabase}_ledger_b_test`;
    const pgDumpAvailable = probePgDump();

    const fixture = readFixture();
    const legacyTables = fixture.insert_order;

    interface LedgerOutcome {
        loadedRows: Record<string, number>;
        fingerprintsBeforeMigration: Record<string, string>;
        fingerprintsAfterMigration: Record<string, string>;
        catalogue: string[];
        schemaDump: string[] | null;
        publicTables: string[];
        additiveColumns: string[];
        backfilledRows: number;
        searchVector: string;
        finalDeployStdout: string;
    }

    let ledgerA: LedgerOutcome | null = null;
    let ledgerB: LedgerOutcome | null = null;
    let manualCopyNotices: string[] = [];
    let catalogueBeforeManualCopy: string[] = [];
    let catalogueAfterManualCopy: string[] = [];

    const outcomeOf = (ledger: LedgerOutcome | null, label: string): LedgerOutcome => {
        if (ledger === null) {
            throw new Error(`ledger ${label} did not complete; its assertions cannot be evaluated`);
        }
        return ledger;
    };

    // Brings a disposable database to the point where the feature migration is
    // about to be applied: the init schema in place, recorded in Prisma's
    // history so `migrate deploy` will not re-apply it, and the fixture loaded.
    const prepareLegacyDatabase = async (
        database: string,
    ): Promise<{ url: string; loadedRows: Record<string, number>; fingerprints: Record<string, string> }> => {
        await recreateDatabase(maintenanceUrl, database);
        const url = databaseUrlFor(ambientUrl, database);

        await applyLedgerFile(url, INIT_SQL);
        expectPrismaSuccess(
            `migrate resolve --applied ${INIT_MIGRATION}`,
            runPrisma(url, ['migrate', 'resolve', '--applied', INIT_MIGRATION]),
        );

        const loadedRows = await loadFixture(url, fixture);
        const fingerprints = await readTableFingerprints(url, legacyTables);

        return { url, loadedRows, fingerprints };
    };

    const finishLedger = async (
        url: string,
        loadedRows: Record<string, number>,
        fingerprintsBeforeMigration: Record<string, string>,
        finalDeployStdout: string,
    ): Promise<LedgerOutcome> => ({
        loadedRows,
        fingerprintsBeforeMigration,
        fingerprintsAfterMigration: await readTableFingerprints(url, legacyTables),
        catalogue: await readCatalogue(url),
        schemaDump: pgDumpAvailable ? readSchemaDump(url) : null,
        publicTables: await readPublicTableNames(url),
        additiveColumns: await readMealEntryAdditiveColumns(url),
        backfilledRows: await countBackfilledMealEntries(url),
        searchVector: await readSearchVectorDefinition(url),
        finalDeployStdout,
    });

    beforeAll(async () => {
        // Refuse before creating anything if the derived names are not what this
        // suite is allowed to destroy. The ambient database is never a target.
        for (const database of [ledgerADatabase, ledgerBDatabase]) {
            if (database === capability.ambientDatabase) {
                throw new Error(`refusing to use the ambient database '${database}' as a disposable ledger database`);
            }
            if (!isTestDatabaseName(database)) {
                throw new Error(`refusing to create '${database}': it is not a test-class database name`);
            }
        }

        // Order A — the ledger every environment actually runs, then the
        // operator's reference copy on top of it, which must change nothing.
        const preparedA = await prepareLegacyDatabase(ledgerADatabase);
        expectPrismaSuccess('migrate deploy (order A)', runPrisma(preparedA.url, ['migrate', 'deploy']));
        catalogueBeforeManualCopy = await readCatalogue(preparedA.url);
        manualCopyNotices = await applyLedgerFile(preparedA.url, MANUAL_SQL);
        catalogueAfterManualCopy = await readCatalogue(preparedA.url);
        const redeployA = expectPrismaSuccess(
            'migrate deploy after the manual copy (order A)',
            runPrisma(preparedA.url, ['migrate', 'deploy']),
        );
        ledgerA = await finishLedger(preparedA.url, preparedA.loadedRows, preparedA.fingerprints, redeployA);

        // Order B — the operator procedure the manual-migrations README
        // documents: apply the copy by hand, tell Prisma it is applied, and
        // deploy, which must then have nothing left to do.
        const preparedB = await prepareLegacyDatabase(ledgerBDatabase);
        await applyLedgerFile(preparedB.url, MANUAL_SQL);
        expectPrismaSuccess(
            `migrate resolve --applied ${FEATURE_MIGRATION}`,
            runPrisma(preparedB.url, ['migrate', 'resolve', '--applied', FEATURE_MIGRATION]),
        );
        const deployB = expectPrismaSuccess(
            'migrate deploy after resolving the manual copy (order B)',
            runPrisma(preparedB.url, ['migrate', 'deploy']),
        );
        ledgerB = await finishLedger(preparedB.url, preparedB.loadedRows, preparedB.fingerprints, deployB);
    }, 900_000);

    afterAll(async () => {
        for (const database of [ledgerADatabase, ledgerBDatabase]) {
            if (database !== capability.ambientDatabase && isTestDatabaseName(database)) {
                await dropDatabase(maintenanceUrl, database);
            }
        }
    }, 180_000);

    describe('the legacy fixture this gate migrates', () => {
        it('covers every legacy table, both owners and all three target profiles', () => {
            expect(fixtureCollections(fixture).slice().sort()).toEqual(legacyTables.slice().sort());
            expect(legacyTables).toHaveLength(16);

            const users = fixtureRows(fixture, 'users');
            const targetsOf = (user: FixtureRow): unknown[] => [
                user.target_calories,
                user.target_protein_g,
                user.target_carbs_g,
                user.target_fat_g,
            ];
            expect(users.filter((user) => targetsOf(user).every((value) => value !== null))).toHaveLength(1);
            expect(
                users.filter(
                    (user) => user.target_calories !== null && targetsOf(user).some((value) => value === null),
                ),
            ).toHaveLength(1);
            expect(users.filter((user) => targetsOf(user).every((value) => value === null))).toHaveLength(1);

            const foodSources = new Set(fixtureRows(fixture, 'foods').map((food) => food.source));
            expect([...foodSources].sort()).toEqual(['branded', 'label_scan', 'manual', 'seed']);

            const owners = new Set(fixtureRows(fixture, 'meal_entries').map((entry) => entry.user_id));
            expect(owners.size).toBeGreaterThanOrEqual(2);
        });

        it('carries the soft-deleted, fractional and zero-calorie rows the diary reads turn on', () => {
            for (const collection of ['foods', 'meals', 'meal_entries', 'user_exercises']) {
                expect(fixtureRows(fixture, collection).some((row) => row.deleted_at !== null)).toBe(true);
            }

            const entries = fixtureRows(fixture, 'meal_entries');
            expect(new Set(entries.map((entry) => entry.input_method))).toEqual(
                new Set(['library', 'search', 'ai_text', 'ai_photo']),
            );
            expect(entries.filter((entry) => !Number.isInteger(entry.servings)).length).toBeGreaterThanOrEqual(3);
            expect(new Set(entries.map((entry) => entry.date)).size).toBeGreaterThanOrEqual(3);
            expect(entries.some((entry) => entry.food_id === null)).toBe(true);

            const softDeletedFoods = new Set(
                fixtureRows(fixture, 'foods')
                    .filter((food) => food.deleted_at !== null)
                    .map((food) => food.id),
            );
            expect(
                entries.some((entry) => entry.deleted_at === null && softDeletedFoods.has(entry.food_id)),
            ).toBe(true);

            // The day whose live entries sum to zero: it must be loadable and it
            // must be the day the history aggregate drops.
            const liveCaloriesByDay = new Map<string, number>();
            for (const entry of entries) {
                if (entry.deleted_at !== null) {
                    continue;
                }
                const key = `${String(entry.user_id)}|${String(entry.date)}`;
                const asEaten = Math.round(Number(entry.calories) * Number(entry.servings));
                liveCaloriesByDay.set(key, (liveCaloriesByDay.get(key) ?? 0) + asEaten);
            }
            const zeroDays = [...liveCaloriesByDay.entries()].filter(([, calories]) => calories === 0);
            expect(zeroDays).toHaveLength(1);
            expect([...liveCaloriesByDay.values()].filter((calories) => calories > 0).length).toBeGreaterThanOrEqual(3);
        });

        it('contains nothing the meal-planning migration adds, so it can load before that migration runs', () => {
            const offendingKeys: string[] = [];
            for (const collection of fixtureCollections(fixture)) {
                for (const row of fixtureRows(fixture, collection)) {
                    for (const key of Object.keys(row)) {
                        if ((ADDITIVE_MEAL_ENTRY_COLUMNS as readonly string[]).includes(key)) {
                            offendingKeys.push(`${collection}.${key}`);
                        }
                    }
                }
            }
            expect(offendingKeys).toEqual([]);
            expect(fixtureCollections(fixture).filter((c) => (MEAL_PLANNING_TABLES as readonly string[]).includes(c))).toEqual([]);
            expect(
                fixtureRows(fixture, 'meal_entries').filter((entry) => entry.input_method === 'meal_plan'),
            ).toEqual([]);
        });
    });

    describe('the Prisma ledger followed by the manual reference copy', () => {
        it('loads the whole fixture into a database holding only the init migration', () => {
            const outcome = outcomeOf(ledgerA, 'A');
            const totalRows = Object.values(outcome.loadedRows).reduce((sum, count) => sum + count, 0);

            expect(Object.keys(outcome.loadedRows).slice().sort()).toEqual(legacyTables.slice().sort());
            expect(Object.values(outcome.loadedRows).every((count) => count > 0)).toBe(true);
            expect(totalRows).toBeGreaterThanOrEqual(60);
        });

        it('leaves the manual copy a no-op: the schema does not move and every statement skips', () => {
            expect(symmetricDifference(catalogueBeforeManualCopy, catalogueAfterManualCopy)).toEqual({
                onlyInFirst: [],
                onlyInSecond: [],
            });
            expect(manualCopyNotices.length).toBeGreaterThan(0);
            expect(manualCopyNotices.filter((notice) => !/already exists, skipping$/.test(notice))).toEqual([]);
        });

        it('reports nothing left to apply on a further deploy', () => {
            expect(outcomeOf(ledgerA, 'A').finalDeployStdout).toMatch(/No pending migrations to apply/);
        });
    });

    describe('the manual reference copy applied by hand and then resolved', () => {
        it('loads the whole fixture into a database holding only the init migration', () => {
            const outcome = outcomeOf(ledgerB, 'B');
            expect(outcome.loadedRows).toEqual(outcomeOf(ledgerA, 'A').loadedRows);
        });

        it('reports nothing left to apply once the migration is resolved as applied', () => {
            // The operator procedure only holds if `migrate resolve --applied`
            // convinces `migrate deploy` the work is done. If it did not, deploy
            // would try the Prisma migration on a schema that already has it.
            expect(outcomeOf(ledgerB, 'B').finalDeployStdout).toMatch(/No pending migrations to apply/);
        });
    });

    describe('schema equivalence between the two ledgers', () => {
        it('produces an identical column, index and constraint catalogue', () => {
            const a = outcomeOf(ledgerA, 'A').catalogue;
            const b = outcomeOf(ledgerB, 'B').catalogue;

            expect(symmetricDifference(a, b)).toEqual({ onlyInFirst: [], onlyInSecond: [] });
            expect(a).toEqual(b);
        });

        it('creates the same tables under both ledgers, including all sixteen the migration adds', () => {
            const a = outcomeOf(ledgerA, 'A');
            const b = outcomeOf(ledgerB, 'B');

            // Non-vacuity: two databases that both missed the feature schema
            // would satisfy the catalogue comparison above and prove nothing.
            expect(a.publicTables).toEqual(b.publicTables);
            expect(MEAL_PLANNING_TABLES.filter((table) => !a.publicTables.includes(table))).toEqual([]);
            expect(MEAL_PLANNING_TABLES.filter((table) => !b.publicTables.includes(table))).toEqual([]);
            expect(a.additiveColumns).toEqual([...ADDITIVE_MEAL_ENTRY_COLUMNS].sort());
            expect(b.additiveColumns).toEqual([...ADDITIVE_MEAL_ENTRY_COLUMNS].sort());
        });

        it('defines catalog_foods.search_vector as the same stored generated column under both', () => {
            const a = outcomeOf(ledgerA, 'A').searchVector;
            const b = outcomeOf(ledgerB, 'B').searchVector;

            // The generated column is one of the three constructs Prisma's
            // datamodel cannot express, so it is the likeliest place for the
            // hand-written copy to drift from the migration.
            expect(a).toMatch(/^ALWAYS to_tsvector\(/);
            expect(a).toBe(b);
        });

        it('declares the alias index with the same text_pattern_ops class under both', () => {
            const aliasIndexLines = (catalogue: string[]): string[] =>
                catalogue.filter((line) => line.includes('idx_catalog_food_aliases_lower_alias'));

            const a = aliasIndexLines(outcomeOf(ledgerA, 'A').catalogue);
            const b = aliasIndexLines(outcomeOf(ledgerB, 'B').catalogue);

            // The non-vacuity guard for this construct, in the same shape as the
            // generated column above. The catalogue equality test at the top of
            // this describe is satisfied by two databases that BOTH lost the
            // operator class, so only a positive assertion holds the manual copy
            // to the authoritative migration here — and the class is a
            // correctness property, not a preference: without
            // `text_pattern_ops` the index cannot serve the left-anchored
            // `lower(alias) LIKE` predicate `catalog.service.ts` wrote it for,
            // because the collation of a database created the ordinary way is
            // not C. `pg_indexes.indexdef`, which `readCatalogue` records, does
            // carry the class, so the comparison can see it; the pg_catalog
            // section of `docs/meal-planning/expected-schema-diff.sql` is what
            // pins it against the ledger being wrong in the same way twice.
            //
            // It also matters that this is the only ledger-equivalence evidence
            // this run produces: `pg_dump` is absent on this host, so the schema
            // dump comparison below is skipped and the catalogue is all there is.
            expect(a).toHaveLength(1);
            expect(b).toHaveLength(1);
            expect(a[0]).toContain('text_pattern_ops');
            expect(b[0]).toContain('text_pattern_ops');
            expect(a).toEqual(b);
        });

        (pgDumpAvailable ? it : it.skip)(
            `produces an identical pg_dump schema${pgDumpAvailable ? '' : ' — not run because pg_dump is unavailable'}`,
            () => {
                const a = outcomeOf(ledgerA, 'A').schemaDump;
                const b = outcomeOf(ledgerB, 'B').schemaDump;

                // pg_dump reproduces what a human reviewer would read, so it
                // catches anything the catalogue query does not select.
                expect(a).not.toBeNull();
                expect(b).not.toBeNull();
                if (a === null || b === null) {
                    return;
                }
                expect(symmetricDifference(a, b)).toEqual({ onlyInFirst: [], onlyInSecond: [] });
                expect(a).toEqual(b);
            },
        );
    });

    describe('legacy data preservation across both ledgers', () => {
        it('leaves every legacy table unchanged when the Prisma ledger migrates it', () => {
            const outcome = outcomeOf(ledgerA, 'A');
            expect(outcome.fingerprintsAfterMigration).toEqual(outcome.fingerprintsBeforeMigration);
        });

        it('leaves every legacy table unchanged when the manual copy migrates it', () => {
            const outcome = outcomeOf(ledgerB, 'B');
            expect(outcome.fingerprintsAfterMigration).toEqual(outcome.fingerprintsBeforeMigration);
        });

        it('agrees row for row between the two ledgers', () => {
            expect(outcomeOf(ledgerB, 'B').fingerprintsAfterMigration).toEqual(
                outcomeOf(ledgerA, 'A').fingerprintsAfterMigration,
            );
        });

        it('backfills none of the additive meal_entries columns', () => {
            // The columns arrive nullable and unpopulated. A migration that
            // guessed a provenance for existing rows would be presenting a
            // user's own numbers as something the server had verified.
            expect(outcomeOf(ledgerA, 'A').backfilledRows).toBe(0);
            expect(outcomeOf(ledgerB, 'B').backfilledRows).toBe(0);
        });
    });
});

// ==========================================================================
// The diary entries endpoint's request and provenance contract.
//
// The suite above proves the SCHEMA the migration produces; this one proves the
// BEHAVIOUR of the endpoint that writes into it, over HTTP, against the
// database `DATABASE_URL` names — not the disposable ones above, which the
// Prisma client cannot reach. `POST /api/macros/meal/:mealId/entries` is a
// shipped endpoint that has gained a second body shape and four additive
// columns (§0.5.2), and §0.9.1 makes it one of the contract-compatibility
// gates, so what is asserted here is what an existing client and a new one may
// each rely on:
//
//   * a malformed path id is answered `400 invalid_request` with `invalid_id`,
//     for BOTH body shapes, instead of reaching a @db.Uuid predicate and
//     returning a 500 — while a malformed BODY still earns the frozen 400
//     message shipped clients read, and a well-formed id that is absent or
//     someone else's still earns the 404 that keeps those two cases
//     indistinguishable;
//   * a client-supplied snapshot is stored as `user_entered` and a row written
//     before the column existed keeps `null`, and neither carries a source
//     label;
//   * a catalog food's own provenance class reaches the diary intact, and a
//     published row whose class this release cannot read is REFUSED rather than
//     logged with the label silently missing;
//   * an edit detaches an entry from the food vouching for its numbers only
//     when a normalized value actually changes, so a whole-entry resubmission
//     keeps the link, the input method and the provenance;
//   * an update that loses a race with a soft delete writes nothing and answers
//     404, which is asserted by injecting the delete into the window between
//     the authorization read and the write rather than by hoping for a
//     schedule.
// ==========================================================================

import { prisma } from '../../prisma/client';
import { makeCatalogFood, makeUser } from '../setup/factories';
import { asUser, request } from '../setup/testApp';
import { truncateFeatureTables } from '../setup/testDb';

/** A syntactically valid v4 UUID that names nothing. */
const ABSENT_UUID = 'e3b0c442-98fc-4c14-9afb-f4c8996fb924';

const LEGACY_REQUIRED_MESSAGE = 'name, calories, protein, carbs, and fat are required';

const DAY_KEY = '2026-03-11';

const legacyBody = () => ({
    name: 'Scrambled eggs',
    calories: 220,
    protein: 14,
    carbs: 2,
    fat: 16,
});

interface StoredEntryColumns {
    name: string;
    calories: number;
    protein_g: number;
    carbs_g: number;
    fat_g: number;
    servings: number;
    input_method: string;
    nutrition_provenance: string | null;
    catalog_food_id: string | null;
    meal_plan_meal_id: string | null;
    recipe_version_id: string | null;
    deleted_at: Date | null;
}

const storedEntry = async (entryId: string): Promise<StoredEntryColumns> => {
    const row = await prisma.meal_entries.findUnique({
        where: { id: entryId },
        select: {
            name: true,
            calories: true,
            protein_g: true,
            carbs_g: true,
            fat_g: true,
            servings: true,
            input_method: true,
            nutrition_provenance: true,
            catalog_food_id: true,
            meal_plan_meal_id: true,
            recipe_version_id: true,
            deleted_at: true,
        },
    });

    if (row === null) {
        throw new Error(`entry ${entryId} was not written`);
    }

    return row;
};

describe('the diary entries endpoint', () => {
    const owner = { uid: '' };
    let breakfastId = '';

    beforeEach(async () => {
        await truncateFeatureTables();

        const user = await makeUser();
        owner.uid = user.id;

        // The day read is what materializes the four buckets (§0.7.4), so the
        // meal id every test below posts to is one a client obtains exactly as
        // the app does.
        const day = await asUser(request.get(`/api/macros/${DAY_KEY}`), owner).expect(200);
        const breakfast = (day.body.meals as { id: string; name: string }[]).find(
            (meal) => meal.name === 'Breakfast',
        );

        if (breakfast === undefined) {
            throw new Error('the day read did not return a Breakfast bucket');
        }

        breakfastId = breakfast.id;
    });

    afterAll(async () => {
        await truncateFeatureTables();
    });

    describe('a malformed path id', () => {
        it.each([
            ['a string that is not a UUID', 'not-a-uuid'],
            ['a SQL fragment', "'%20OR%201=1--"],
            ['a UUID missing its hyphens', '9b2fbd4c7c214a178b361d5a2d4f9c10'],
            ['a v1 UUID', '9b2fbd4c-7c21-1a17-8b36-1d5a2d4f9c10'],
        ])('is refused with invalid_id for a legacy body: %s', async (_case, mealId) => {
            const response = await asUser(
                request.post(`/api/macros/meal/${mealId}/entries`).send(legacyBody()),
                owner,
            ).expect(400);

            expect(response.body).toStrictEqual({
                error: 'invalid_request',
                details: [{ field: 'mealId', code: 'invalid_id' }],
            });
        });

        it('is refused with invalid_id for a catalog body', async () => {
            const food = await makeCatalogFood();

            const response = await asUser(
                request
                    .post('/api/macros/meal/not-a-uuid/entries')
                    .send({ catalogFoodId: food.id, servings: 1, inputMethod: 'search' }),
                owner,
            ).expect(400);

            expect(response.body).toStrictEqual({
                error: 'invalid_request',
                details: [{ field: 'mealId', code: 'invalid_id' }],
            });
        });

        it('writes nothing', async () => {
            await asUser(request.post('/api/macros/meal/not-a-uuid/entries').send(legacyBody()), owner).expect(400);

            expect(await prisma.meal_entries.count({ where: { user_id: owner.uid } })).toBe(0);
        });

        it('does not pre-empt the frozen 400 a malformed body earns', async () => {
            // Order matters for compatibility: a client sending a bad body must
            // keep seeing the message it has always seen, so the path is judged
            // after the body and only where the request would otherwise have
            // reached the database.
            const response = await asUser(
                request.post('/api/macros/meal/not-a-uuid/entries').send({ name: 'Eggs' }),
                owner,
            ).expect(400);

            expect(response.body).toStrictEqual({ error: LEGACY_REQUIRED_MESSAGE });
        });

        it('is refused on the update and delete routes too', async () => {
            const updateResponse = await asUser(
                request.put('/api/macros/entry/entry-1').send({ servings: 2 }),
                owner,
            ).expect(400);
            const deleteResponse = await asUser(request.delete('/api/macros/entry/entry-1'), owner).expect(400);

            expect(updateResponse.body).toStrictEqual({
                error: 'invalid_request',
                details: [{ field: 'id', code: 'invalid_id' }],
            });
            expect(deleteResponse.body).toStrictEqual({
                error: 'invalid_request',
                details: [{ field: 'id', code: 'invalid_id' }],
            });
        });
    });

    describe('a well-formed path id', () => {
        it('still answers 404 for a meal that does not exist', async () => {
            const response = await asUser(
                request.post(`/api/macros/meal/${ABSENT_UUID}/entries`).send(legacyBody()),
                owner,
            ).expect(404);

            expect(response.body).toStrictEqual({ error: 'Meal not found' });
        });

        it('answers 404 identically for another user´s meal, so existence never leaks', async () => {
            const stranger = await makeUser();
            const strangerDay = await asUser(request.get(`/api/macros/${DAY_KEY}`), { uid: stranger.id }).expect(200);
            const strangerBreakfast = (strangerDay.body.meals as { id: string; name: string }[]).find(
                (meal) => meal.name === 'Breakfast',
            );

            const response = await asUser(
                request.post(`/api/macros/meal/${strangerBreakfast?.id ?? ABSENT_UUID}/entries`).send(legacyBody()),
                owner,
            ).expect(404);

            expect(response.body).toStrictEqual({ error: 'Meal not found' });
        });

        it('answers 404 for an entry id that is not the caller´s', async () => {
            const created = await asUser(
                request.post(`/api/macros/meal/${breakfastId}/entries`).send(legacyBody()),
                owner,
            ).expect(201);
            const stranger = await makeUser();

            await asUser(request.put(`/api/macros/entry/${created.body.id}`).send({ servings: 3 }), {
                uid: stranger.id,
            }).expect(404);
        });
    });

    describe('the provenance a stored snapshot carries', () => {
        it('classifies a client-supplied snapshot as user-entered and shows no source label', async () => {
            const response = await asUser(
                request.post(`/api/macros/meal/${breakfastId}/entries`).send(legacyBody()),
                owner,
            ).expect(201);

            expect(response.body.nutritionProvenance).toBe('user_entered');
            expect(response.body.mealPlanMealId).toBeNull();
            expect(response.body.inputMethod).toBe('library');
            expect((await storedEntry(response.body.id)).nutrition_provenance).toBe('user_entered');
        });

        it('leaves a row written before the column existed unclassified', async () => {
            const created = await asUser(
                request.post(`/api/macros/meal/${breakfastId}/entries`).send(legacyBody()),
                owner,
            ).expect(201);

            // The state the migration leaves every pre-feature row in: the
            // column is nullable and nothing backfills it.
            await prisma.meal_entries.update({
                where: { id: created.body.id },
                data: { nutrition_provenance: null },
            });

            const day = await asUser(request.get(`/api/macros/${DAY_KEY}`), owner).expect(200);
            const entry = (day.body.meals as { entries: { id: string; nutritionProvenance: unknown }[] }[])
                .flatMap((meal) => meal.entries)
                .find((candidate) => candidate.id === created.body.id);

            expect(entry?.nutritionProvenance).toBeNull();
        });

        it('carries a catalog food´s own class into the diary', async () => {
            const food = await makeCatalogFood({ nutrition_provenance: 'ai_estimated' });

            const response = await asUser(
                request
                    .post(`/api/macros/meal/${breakfastId}/entries`)
                    .send({ catalogFoodId: food.id, servings: 1, inputMethod: 'search' }),
                owner,
            ).expect(201);

            // The label is the whole point: an AI-estimated food must reach the
            // diary as an estimate, never as an unlabelled row.
            expect(response.body.nutritionProvenance).toBe('ai_estimated');
            expect(response.body.inputMethod).toBe('search');
            expect((await storedEntry(response.body.id)).catalog_food_id).toBe(food.id);
        });

        it('refuses to log a published food whose class this release cannot read', async () => {
            const food = await makeCatalogFood({ nutrition_provenance: 'verified' });

            // Copied verbatim, this value would be stored and then read back as
            // `null` — an entry with no provenance label at all. Failing closed
            // writes nothing instead, so the label can never go missing silently.
            await asUser(
                request
                    .post(`/api/macros/meal/${breakfastId}/entries`)
                    .send({ catalogFoodId: food.id, servings: 1, inputMethod: 'search' }),
                owner,
            ).expect(500);

            expect(await prisma.meal_entries.count({ where: { meal_id: breakfastId } })).toBe(0);
        });

        it('refuses a serving the food does not store, rather than relabelling the default portion', async () => {
            const food = await makeCatalogFood();

            const response = await asUser(
                request
                    .post(`/api/macros/meal/${breakfastId}/entries`)
                    .send({ catalogFoodId: food.id, servings: 1, servingText: '1 slice', inputMethod: 'search' }),
                owner,
            ).expect(400);

            expect(response.body).toStrictEqual({ error: 'invalid_serving' });
            expect(await prisma.meal_entries.count({ where: { meal_id: breakfastId } })).toBe(0);
        });
    });

    describe('editing an entry that something vouches for', () => {
        const logCatalogEntry = async (): Promise<{ entryId: string; foodId: string }> => {
            const food = await makeCatalogFood();
            const created = await asUser(
                request
                    .post(`/api/macros/meal/${breakfastId}/entries`)
                    .send({ catalogFoodId: food.id, servings: 1, inputMethod: 'search' }),
                owner,
            ).expect(201);

            return { entryId: created.body.id as string, foodId: food.id };
        };

        it('keeps the link for a servings-only edit', async () => {
            const { entryId, foodId } = await logCatalogEntry();

            await asUser(request.put(`/api/macros/entry/${entryId}`).send({ servings: 2 }), owner).expect(200);

            const stored = await storedEntry(entryId);
            expect(stored.servings).toBe(2);
            expect(stored.catalog_food_id).toBe(foodId);
            expect(stored.input_method).toBe('search');
            expect(stored.nutrition_provenance).toBe('source_backed');
        });

        it('keeps the link when the whole entry is re-submitted unaltered', async () => {
            const { entryId, foodId } = await logCatalogEntry();
            const before = await storedEntry(entryId);

            // What a form save or a retry of a lost response sends: every field,
            // none of them different. Detaching here would strip the source
            // label and un-log a planned meal without a number moving.
            await asUser(
                request.put(`/api/macros/entry/${entryId}`).send({
                    name: before.name,
                    calories: before.calories,
                    protein: before.protein_g,
                    carbs: before.carbs_g,
                    fat: before.fat_g,
                    servings: before.servings,
                }),
                owner,
            ).expect(200);

            const after = await storedEntry(entryId);
            expect(after.catalog_food_id).toBe(foodId);
            expect(after.input_method).toBe('search');
            expect(after.nutrition_provenance).toBe('source_backed');
        });

        it('keeps the link when a padded name and a rounding-equal macro are sent', async () => {
            const { entryId, foodId } = await logCatalogEntry();
            const before = await storedEntry(entryId);

            await asUser(
                request
                    .put(`/api/macros/entry/${entryId}`)
                    .send({ name: `  ${before.name}  `, calories: before.calories + 0.4 }),
                owner,
            ).expect(200);

            const after = await storedEntry(entryId);
            expect(after.name).toBe(before.name);
            expect(after.calories).toBe(before.calories);
            expect(after.catalog_food_id).toBe(foodId);
        });

        it('accepts an edit that names no column at all', async () => {
            const { entryId, foodId } = await logCatalogEntry();

            // The active-row condition is in the write predicate, and Prisma
            // applies it even when the update names no column — so a request
            // that changes nothing still answers 200 for a live entry, exactly
            // as it did before that condition was added.
            const response = await asUser(request.put(`/api/macros/entry/${entryId}`).send({}), owner).expect(200);

            expect(response.body.id).toBe(entryId);
            expect((await storedEntry(entryId)).catalog_food_id).toBe(foodId);
        });

        it('detaches when a macro is actually rewritten', async () => {
            const { entryId } = await logCatalogEntry();
            const before = await storedEntry(entryId);

            await asUser(
                request.put(`/api/macros/entry/${entryId}`).send({ calories: before.calories + 100 }),
                owner,
            ).expect(200);

            // The catalog did not produce these numbers, so nothing may keep
            // vouching for them — and the fallback classes are ones an older
            // client already decodes.
            const after = await storedEntry(entryId);
            expect(after.calories).toBe(before.calories + 100);
            expect(after.catalog_food_id).toBeNull();
            expect(after.meal_plan_meal_id).toBeNull();
            expect(after.recipe_version_id).toBeNull();
            expect(after.input_method).toBe('library');
            expect(after.nutrition_provenance).toBe('user_entered');
        });

        it('detaches when the name is rewritten', async () => {
            const { entryId } = await logCatalogEntry();

            const response = await asUser(
                request.put(`/api/macros/entry/${entryId}`).send({ name: 'Something I made up' }),
                owner,
            ).expect(200);

            expect(response.body.nutritionProvenance).toBe('user_entered');
            expect((await storedEntry(entryId)).catalog_food_id).toBeNull();
        });
    });

    describe('an update that races a soft delete', () => {
        it('writes nothing and answers 404 when the delete commits first', async () => {
            const created = await asUser(
                request.post(`/api/macros/meal/${breakfastId}/entries`).send(legacyBody()),
                owner,
            ).expect(201);
            const entryId = created.body.id as string;

            // The race, made deterministic. The writer authorizes with a read
            // and then writes, and the two statements run in separate READ
            // COMMITTED snapshots — so this middleware commits the delete in
            // exactly the window a concurrent DELETE request would land in. The
            // proof is the outcome: with `deleted_at` in the write predicate the
            // UPDATE matches nothing and the caller is told 404; without it the
            // update succeeds and describes a row the user has already removed.
            let armed = true;
            prisma.$use(async (params, next) => {
                if (armed && params.model === 'meal_entries' && params.action === 'update') {
                    armed = false;
                    await prisma.$executeRaw`UPDATE meal_entries SET deleted_at = now() WHERE id = ${entryId}::uuid`;
                }

                return next(params);
            });

            try {
                const response = await asUser(
                    request.put(`/api/macros/entry/${entryId}`).send({ servings: 4, name: 'Rewritten' }),
                    owner,
                ).expect(404);

                expect(response.body).toStrictEqual({ error: 'Entry not found' });

                const stored = await storedEntry(entryId);
                expect(stored.deleted_at).not.toBeNull();
                expect(stored.servings).toBe(1);
                expect(stored.name).toBe('Scrambled eggs');
            } finally {
                armed = false;
            }
        });

        it('answers 404 for an entry the caller has already deleted', async () => {
            const created = await asUser(
                request.post(`/api/macros/meal/${breakfastId}/entries`).send(legacyBody()),
                owner,
            ).expect(201);

            await asUser(request.delete(`/api/macros/entry/${created.body.id}`), owner).expect(200);
            await asUser(request.put(`/api/macros/entry/${created.body.id}`).send({ servings: 2 }), owner).expect(404);
            await asUser(request.delete(`/api/macros/entry/${created.body.id}`), owner).expect(404);
        });
    });
});

// ==========================================================================
// The idempotent-replay ledger, against real PostgreSQL.
//
// §0.5.1 requires a repeated keyed write to return "the stored first-response
// status and body … unchanged … so a client can never distinguish a replay
// from the original response", and §0.9.2 states the same row as "the same key
// and body replayed without the header returns the stored 201/200 body
// BYTE-FOR-BYTE". `mealPlanningAction.logic.test.ts` pins the rules that make
// that true with no database; what it cannot do is read the column. This suite
// is the column: it commits one keyed action through
// `withMealPlanningTransaction`/`runKeyedAction`, replays it, and asserts the
// stored `meal_plan_actions` row, the bytes of `response_snapshot` itself and
// the key order PostgreSQL holds them in.
//
// WHY HERE. The HTTP-level comparison of an original and a replayed response —
// the request aborted after commit with `x-test-abort-after-commit`, then
// replayed over the wire — belongs to `src/__tests__/api/fault.test.ts`, and
// the lock/reserve races belong to `src/__tests__/api/concurrency.test.ts`
// (§0.9.2). Those two suites own that evidence; neither exists in this
// checkpoint, and this file is the only PostgreSQL-backed home available, so
// the ledger's persistence is proven here at the service seam rather than left
// modelled inside a unit test. This is a statement of ownership: when those
// suites land, the wire-level byte comparison is theirs and this describe stays
// what it is — the column-level proof underneath it.
// ==========================================================================

import { IdempotencyConflictError } from '../../services/mealPlanning.errors';
import { buildRequestFingerprint } from '../../services/mealPlanningAction.logic';
import {
    KeyedActionResult,
    runKeyedAction,
    withMealPlanningTransaction,
} from '../../services/mealPlanningAction.service';
import { MealPlanResponse } from '../../types/mealPlanning';
import { makePlan } from '../setup/factories';

/** The `meal_plan_actions` columns this suite reads, in database spelling. */
interface LedgerRowColumns {
    response_status: number | null;
    plan_revision_after: number | null;
    meal_plan_id: string | null;
    meal_plan_meal_id: string | null;
    meal_entry_id: string | null;
}

/** `response_snapshot` rendered by PostgreSQL itself, not by Prisma. */
interface SnapshotTextRow {
    snapshot_text: string;
}

/** One key per row, in the column's own order. */
interface SnapshotKeyRow {
    key: string;
}

/**
 * A generate response written the way a mapper assembling a DTO field by field
 * produces one: NOT in the order `jsonb` holds keys in. That is the whole point
 * of the fixture — if the ledger stored it as it arrived, the column would
 * reorder it and no replay could reproduce the first response's bytes.
 *
 * It carries one of every scalar class a keyed body can hold: a two-decimal
 * float (`65.5`, `610.4`), Number.MAX_SAFE_INTEGER + 1, `null`, both booleans,
 * a multi-byte string with an astral-plane emoji, and a two-element array whose
 * order is meaning. Cast because the ledger stores a response body without
 * inspecting it, and assembling a whole 7-day `MealPlanResponse` would make the
 * fixture about the plan mapper instead of about the column.
 */
const NON_CANONICAL_GENERATE_BODY = {
    id: 'plan-1',
    revision: 2,
    targets: { calories: 1940, protein: 146, fat: 65.5 },
    days: [
        { date: '2026-07-05', meals: [{ slot: 'lunch', planned: { calories: 610.4, protein: 45 } }] },
        { date: '2026-07-06', meals: [{ slot: 'dinner', planned: { calories: 720, protein: 52 } }] },
    ],
    note: 'café — crème brûlée 🥗',
    big: 9007199254740992,
    nothing: null,
    isLocked: false,
    wasRegenerated: true,
} as unknown as MealPlanResponse;

/** A body that differs from the one above, for the conflicting-request case. */
const OTHER_GENERATE_BODY = { ...NON_CANONICAL_GENERATE_BODY, id: 'plan-2' } as unknown as MealPlanResponse;

describe('the meal-planning action ledger', () => {
    const owner = { uid: '' };
    let planId = '';
    let workRuns = 0;

    /** The §0.5.2 generate request this suite keys and fingerprints. */
    const generateRequest = (startDate: string) => ({
        startDate,
        idempotencyKey: '0f9d5b1e-4c4a-4c2e-9f1a-6b2d7e8c9a10',
        expectedPreferencesRevision: 1,
        expectedTargetsRevision: 1,
    });

    /**
     * One keyed write, run exactly as a service runs it: the transaction from
     * `withMealPlanningTransaction`, the sequence from `runKeyedAction`, the
     * fingerprint from the real `buildRequestFingerprint`.
     *
     * `work` bumps `meal_plans.revision` and returns the new value, which is
     * what §0.5.1's "write, bump, record" does — and it makes "did the work run
     * twice" measurable in the database rather than only in a counter: a second
     * execution would leave the plan at revision 3.
     */
    const runGenerate = async (body: MealPlanResponse, startDate: string): Promise<KeyedActionResult> => {
        const request = generateRequest(startDate);

        return withMealPlanningTransaction((tx) =>
            runKeyedAction(
                tx,
                {
                    userId: owner.uid,
                    actionType: 'generate',
                    idempotencyKey: request.idempotencyKey,
                    fingerprint: buildRequestFingerprint('POST', 'generate', {}, request),
                },
                async (lockedTx) => {
                    workRuns += 1;

                    const bumped = await lockedTx.meal_plans.update({
                        where: { id_user_id: { id: planId, user_id: owner.uid } },
                        data: { revision: { increment: 1 } },
                        select: { revision: true },
                    });

                    return { body, planRevisionAfter: bumped.revision, mealPlanId: planId };
                },
            ),
        );
    };

    const ledgerRows = async (): Promise<LedgerRowColumns[]> =>
        prisma.meal_plan_actions.findMany({
            where: { user_id: owner.uid, idempotency_key: generateRequest('2026-07-05').idempotencyKey },
            select: {
                response_status: true,
                plan_revision_after: true,
                meal_plan_id: true,
                meal_plan_meal_id: true,
                meal_entry_id: true,
            },
        });

    beforeEach(async () => {
        await truncateFeatureTables();
        workRuns = 0;

        const user = await makeUser();
        owner.uid = user.id;

        // A real plan, because the ledger row's `meal_plan_id` carries a
        // composite foreign key to `meal_plans(id, user_id)`: a completion
        // naming a plan that does not exist is rejected by the database, which
        // is exactly the guard that makes the stored row traceable. One day is
        // enough — nothing here reads the plan's contents.
        const plan = await makePlan(owner.uid, { dayCount: 1 });
        planId = plan.id;
    });

    afterAll(async () => {
        await truncateFeatureTables();
    });

    it('commits one action row carrying the status and the revision it recorded', async () => {
        const first = await runGenerate(NON_CANONICAL_GENERATE_BODY, '2026-07-05');
        const rows = await ledgerRows();

        expect(rows).toHaveLength(1);
        // 201 for a generate (§0.5.2), persisted rather than derived at read
        // time, and the revision the bump produced.
        expect(rows[0].response_status).toBe(201);
        expect(rows[0].plan_revision_after).toBe(2);
        expect(rows[0].meal_plan_id).toBe(planId);
        // A generate records the plan it published and nothing else.
        expect(rows[0].meal_plan_meal_id).toBeNull();
        expect(rows[0].meal_entry_id).toBeNull();
        expect(first.status).toBe(201);
        expect(first.planRevisionAfter).toBe(2);
    });

    it('replays the stored response without running the work again', async () => {
        await runGenerate(NON_CANONICAL_GENERATE_BODY, '2026-07-05');
        const replay = await runGenerate(NON_CANONICAL_GENERATE_BODY, '2026-07-05');

        expect(workRuns).toBe(1);
        // The database agrees: a second execution would have bumped the plan
        // again. This is the guarantee the ledger exists for — at most once,
        // however many times the client retries.
        const plan = await prisma.meal_plans.findUnique({ where: { id: planId }, select: { revision: true } });

        expect(plan?.revision).toBe(2);
        expect(replay.status).toBe(201);
        expect(replay.planRevisionAfter).toBe(2);
        expect((await ledgerRows())).toHaveLength(1);
    });

    it('replays the body BYTE-FOR-BYTE, which is §0.9.2 read literally', async () => {
        const first = await runGenerate(NON_CANONICAL_GENERATE_BODY, '2026-07-05');
        const replay = await runGenerate(NON_CANONICAL_GENERATE_BODY, '2026-07-05');

        // The first answer came from memory and the replay came out of a `jsonb`
        // column that reorders object keys at rest. They agree to the byte
        // because both serialise a canonically ordered value — the ledger stores
        // the body in the order the column would impose anyway.
        expect(JSON.stringify(replay.body)).toBe(JSON.stringify(first.body));
        expect(replay.body).toEqual(first.body);
        expect(replay.body).toEqual(NON_CANONICAL_GENERATE_BODY);
    });

    it('holds the served bytes in the column itself, in the column\'s own key order', async () => {
        const first = await runGenerate(NON_CANONICAL_GENERATE_BODY, '2026-07-05');

        const [stored] = await prisma.$queryRaw<SnapshotTextRow[]>`
            SELECT response_snapshot::text AS snapshot_text
            FROM meal_plan_actions
            WHERE user_id = ${owner.uid}
        `;

        // Parsed before it is compared, deliberately: `jsonb::text` renders a
        // space after every `:` and `,` while `JSON.stringify` renders none, so
        // a raw string comparison would fail over whitespace rather than over
        // ORDER, which is the only thing at issue. Parsing normalises the
        // whitespace and preserves the key order, so this asserts exactly what
        // it means to.
        expect(JSON.stringify(JSON.parse(stored.snapshot_text))).toBe(JSON.stringify(first.body));

        // And the order directly from PostgreSQL, with no JavaScript object in
        // between: `jsonb_object_keys` returns the keys in the order the column
        // holds them, which is the measurement the deleted in-test model used
        // to stand in for.
        const keys = await prisma.$queryRaw<SnapshotKeyRow[]>`
            SELECT key FROM meal_plan_actions, jsonb_object_keys(response_snapshot) AS key
            WHERE user_id = ${owner.uid}
        `;

        expect(keys.map((row) => row.key)).toEqual([
            'id',
            'big',
            'days',
            'note',
            'nothing',
            'targets',
            'isLocked',
            'revision',
            'wasRegenerated',
        ]);
        expect(keys.map((row) => row.key)).toEqual(Object.keys(first.body as Record<string, unknown>));
    });

    it('preserves every scalar class in the column, not only the key order', async () => {
        await runGenerate(NON_CANONICAL_GENERATE_BODY, '2026-07-05');

        const [stored] = await prisma.$queryRaw<SnapshotTextRow[]>`
            SELECT response_snapshot::text AS snapshot_text
            FROM meal_plan_actions
            WHERE user_id = ${owner.uid}
        `;
        const snapshot = JSON.parse(stored.snapshot_text) as Record<string, unknown>;
        const days = snapshot.days as Record<string, unknown>[];
        const lunch = (days[0].meals as Record<string, unknown>[])[0].planned as Record<string, number>;

        expect((snapshot.targets as Record<string, number>).fat).toBe(65.5);
        expect(lunch.calories).toBe(610.4);
        expect(snapshot.big).toBe(9007199254740992);
        expect(snapshot.nothing).toBeNull();
        expect(snapshot.note).toBe('café — crème brûlée 🥗');
        expect(snapshot.isLocked).toBe(false);
        expect(snapshot.wasRegenerated).toBe(true);
        expect(days.map((day) => day.date)).toEqual(['2026-07-05', '2026-07-06']);
    });

    it('refuses the same key with a different request, so the guarantee is not "any body replays"', async () => {
        await runGenerate(NON_CANONICAL_GENERATE_BODY, '2026-07-05');

        // A different start date is a different request: the fingerprint moves,
        // the stored response no longer answers it, and §0.5.1 answers
        // `409 idempotency_conflict` rather than replaying a result the client
        // did not ask for. Byte-for-byte replay applies to the SAME request
        // only.
        await expect(runGenerate(OTHER_GENERATE_BODY, '2026-07-12')).rejects.toThrow(IdempotencyConflictError);

        expect(workRuns).toBe(1);
        expect(await ledgerRows()).toHaveLength(1);
    });
});
