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
//      stops `migrate deploy` applying that DDL a second time, which is the
//      whole point of the resolve step in the operator procedure the
//      manual-migrations README documents — deploy names no migration the copy
//      covers, everything it does apply is a later migration the copy never
//      claimed (the copy is the meal-planning DDL and nothing else), and a
//      further deploy then has nothing left to apply at all;
//   4. the two resulting schemas are identical — same columns in the same
//      positions with the same types, defaults and generation expressions, same
//      indexes, same constraints, and the same normalised schema dump;
//   5. every legacy row survives both ledgers byte-for-byte, and neither set
//      of additive columns was backfilled: none of the four columns
//      20260908000000_meal_planning adds to meal_entries, and no
//      usda_api_cache row carries the http_status that
//      20260909000000_usda_cache_http_status adds, both asserted against a
//      database where the columns demonstrably exist so the claim cannot pass
//      by their absence.
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
// Requirements, and what happens without them. 0.9.1 makes this gate a
// release requirement, so nothing here degrades: a missing prerequisite is a
// FAILURE, never a skip, because a skipped mandatory gate reports green while
// producing none of the evidence it exists for. The suite needs a test-class
// DATABASE_URL, the Prisma CLI, both ledgers, the fixture, and a pg_dump whose
// major version is at least the server's — the plan compares the ledgers on a
// normalised `pg_dump --schema-only`, which makes the dump mandatory evidence
// and not a bonus on top of the catalogue comparison in (4). Whichever is
// missing, the gate registers a failing test whose name says which one it is,
// and the message says what was tried and how to make it runnable; see
// `resolveSchemaDumpRunner` for the three ways a pg_dump is found, one of
// which needs no PostgreSQL client installed at all. The role behind
// DATABASE_URL must be able to CREATE DATABASE; if it cannot, the PostgreSQL
// permission error surfaces from beforeAll.

import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
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

// The column 20260909000000_usda_cache_http_status adds to usda_api_cache. It
// is nullable with no default and is deliberately NOT backfilled — that
// migration's own header refuses to stamp pre-existing rows 200 because doing
// so "would manufacture exactly the evidence this column exists to record" —
// so it is treated exactly like the meal_entries four: excluded from the row
// hashes, and asserted unpopulated afterwards.
const ADDITIVE_USDA_API_CACHE_COLUMNS = ['http_status'] as const;

// Every column any ledger in prisma/migrations adds to a table this suite
// fingerprints, by table. The row hashes subtract these so ONE hash query
// describes a table both before and after the migrations run; a column missing
// from this map makes an additive, data-preserving migration look like it
// rewrote rows it never touched.
//
// One entry per migration that adds columns to a pre-existing table:
//   * meal_entries — 20260908000000_meal_planning adds the four link and
//     provenance columns above;
//   * usda_api_cache — 20260909000000_usda_cache_http_status adds http_status.
//
// A table absent from this map is hashed whole, which is what makes the
// exclusion narrow: the additive columns are removed from the hash by name,
// and every other column of every table still reaches it.
//
// The value type admits `undefined` because most tables have no entry, and the
// lookup below is written to read that as "hash the whole row".
const ADDITIVE_COLUMNS_BY_TABLE: Readonly<Record<string, readonly string[] | undefined>> = {
    meal_entries: ADDITIVE_MEAL_ENTRY_COLUMNS,
    usda_api_cache: ADDITIVE_USDA_API_CACHE_COLUMNS,
};

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
// Capability probe. Runs at collection time, because what it finds decides
// which tests are registered: the gate's own cases when the environment can
// carry them, and otherwise one case that FAILS with the reason. Nothing here
// produces a skip — see "Requirements" in the header.
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
        // The CLI's own output is quoted, so it is scrubbed: some Prisma errors
        // echo the datasource URL back, and this message reaches CI logs.
        throw new Error(
            `${label} failed with status ${result.status}\n` +
                `${withoutCredentials(result.stdout)}\n${withoutCredentials(result.stderr)}`,
        );
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
// (string_agg over sorted per-row hashes) and ignores that table's additive
// columns from ADDITIVE_COLUMNS_BY_TABLE, so the identical query describes a
// table before and after the migrations.
const readTableFingerprints = async (url: string, tables: string[]): Promise<Record<string, string>> =>
    withClient(url, async (client) => {
        const fingerprints: Record<string, string> = {};

        for (const table of tables) {
            // Per table, because the additive columns differ per table: the
            // jsonb `-` operator is only applied for the columns a migration
            // adds to THIS table, and a table no migration added a column to
            // is hashed whole (an empty subtraction list leaves to_jsonb's
            // result untouched).
            const withoutAdditiveColumns = (ADDITIVE_COLUMNS_BY_TABLE[table] ?? [])
                .map((column) => `- '${column}'`)
                .join(' ');
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

// The usda_api_cache pair of the two reads above, and for the same reason: the
// count is the no-backfill claim, and the information_schema read is what stops
// it passing against a database that never gained the column at all.
const readUsdaApiCacheAdditiveColumns = async (url: string): Promise<string[]> =>
    withClient(url, async (client) => {
        const result = await client.query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'usda_api_cache'
               AND column_name = ANY($1::text[])
             ORDER BY column_name`,
            [[...ADDITIVE_USDA_API_CACHE_COLUMNS]],
        );
        return result.rows.map((row) => row.column_name);
    });

const countStampedUsdaApiCacheRows = async (url: string): Promise<number> =>
    withClient(url, async (client) => {
        const predicate = ADDITIVE_USDA_API_CACHE_COLUMNS.map((column) => `"${column}" IS NOT NULL`).join(' OR ');
        const result = await client.query<{ stamped: number }>(
            `SELECT COUNT(*)::int AS stamped FROM usda_api_cache WHERE ${predicate}`,
        );
        return result.rows[0].stamped;
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

// --------------------------------------------------------------------------
// Resolving a pg_dump this gate can actually run, and running it without
// putting a password where `ps` can read it.
//
// §0.9.1 compares the two ledgers on a NORMALISED `pg_dump --schema-only` of
// each database, so the dump is mandatory evidence rather than a bonus: with
// no pg_dump there is no gate, which is why nothing below degrades to a skip.
// "A pg_dump" also means a specific one — pg_dump refuses to dump a server
// newer than itself — so the major version is part of resolving it.
//
// Three ways to get one are tried, in this order, and the first that verifies
// is the one used:
//
//   1. PG_DUMP_BIN — an explicit executable. A host whose `pg_dump` on PATH
//      belongs to an older major usually still ships the right one under
//      /usr/lib/postgresql/<major>/bin, and CI resolves it that way and
//      exports this variable so the choice is visible in the job log.
//   2. `pg_dump` on PATH.
//   3. `docker exec <container> pg_dump` — what makes this gate runnable on a
//      host with no PostgreSQL client at all, because the server itself runs
//      in a container that ships a client of exactly the matching version.
//      The container is PG_DUMP_CONTAINER when that is set, and is otherwise
//      discovered as the running container that publishes the port
//      DATABASE_URL names.
//
// A candidate is accepted only once it has proven both halves of what it is
// needed for: `--version` identifies a pg_dump whose major is at least the
// server's, and it can actually dump a database on this server — probed
// read-only against the ambient test database, because a client of the right
// version that cannot authenticate, or a container that is not the one behind
// this URL, is useless in exactly the same way as a missing binary.
//
// Credentials. The local path spells the connection out in non-secret flags
// (--host, --port, --username, --dbname) and passes the password through a
// PGPASSFILE, because argv is world-readable through `ps` on a shared host and
// a `postgresql://user:password@…` URL in argv publishes the password to every
// process on the machine. The container path passes no password at all: it
// connects over the container's own local socket. No message here quotes the
// URL, and any connection URL a child process prints is scrubbed of its
// userinfo before it is quoted.
// --------------------------------------------------------------------------

/** An explicit pg_dump executable, tried ahead of everything else. */
const PG_DUMP_BIN_VAR = 'PG_DUMP_BIN';

/** The container running the server, when it must not be discovered. */
const PG_DUMP_CONTAINER_VAR = 'PG_DUMP_CONTAINER';

/** The dump flags, identical for every runner: DDL only, portable, no noise. */
const PG_DUMP_SCHEMA_ARGS = ['--schema-only', '--no-owner', '--no-privileges', '--no-comments'] as const;

/** A schema dump is far larger than the default 1 MB pipe buffer allows. */
const PG_DUMP_MAX_BUFFER = 64 * 1024 * 1024;

/** What `pg_dump --version` prints, and where its major number sits in it. */
const PG_DUMP_VERSION_PATTERN = /pg_dump\s+\(PostgreSQL\)\s+((\d+)[^\s]*)/i;

/** libpq's default, used when the URL states no port. */
const DEFAULT_POSTGRES_PORT = '5432';

/**
 * Removes the userinfo from any connection URL a child process printed, so a
 * quoted diagnostic cannot carry the password DATABASE_URL holds.
 */
const withoutCredentials = (text: string): string => text.replace(/:\/\/[^\s/@]*@/g, '://***@');

/**
 * Names a target the way `setup/testDb.ts` does — host and database, never the
 * URL — because these messages reach CI logs and a Jest reporter.
 */
const describeTarget = (host: string, database: string): string => `database "${database}" on host "${host}"`;

interface ChildOutcome {
    status: number;
    stdout: string;
    stderr: string;
}

const runChild = (
    command: string,
    args: readonly string[],
    env: NodeJS.ProcessEnv = process.env,
): ChildOutcome => {
    const result = spawnSync(command, [...args], { encoding: 'utf8', maxBuffer: PG_DUMP_MAX_BUFFER, env });
    // A command that could not be spawned at all — a missing binary, no docker
    // daemon — reports through `error` and leaves stderr empty, so both are
    // folded into the one diagnostic the caller quotes.
    const diagnostics = [result.error === undefined ? '' : result.error.message, String(result.stderr ?? '')]
        .filter((part) => part.trim() !== '')
        .join('; ');

    return {
        status: result.status ?? -1,
        stdout: String(result.stdout ?? ''),
        stderr: withoutCredentials(diagnostics),
    };
};

/** The first line of a child's output, for a one-line diagnostic. */
const firstLine = (text: string): string => text.trim().split('\n')[0] ?? '';

/** How a diagnostic quotes a failed child: exit code, then what it said. */
const describeFailure = (outcome: ChildOutcome): string => {
    const said = firstLine(outcome.stderr) === '' ? firstLine(outcome.stdout) : firstLine(outcome.stderr);
    return said === '' ? `exit ${outcome.status}` : `exit ${outcome.status}: ${said}`;
};

/** The non-secret half of a connection. */
interface ServerAddress {
    host: string;
    port: string;
    user: string;
}

/** The ambient connection, with the password kept apart from the rest. */
interface AmbientConnection {
    address: ServerAddress;
    password: string;
}

const connectionOf = (ambientUrl: string): AmbientConnection => {
    const url = new URL(ambientUrl);
    return {
        address: {
            host: url.hostname,
            port: url.port === '' ? DEFAULT_POSTGRES_PORT : url.port,
            user: decodeURIComponent(url.username),
        },
        password: decodeURIComponent(url.password),
    };
};

/** Escapes the two characters a PGPASSFILE field treats as syntax. */
const escapePgpassField = (value: string): string => value.replace(/([\\:])/g, '\\$1');

/**
 * Runs a local pg_dump with the password in a PGPASSFILE.
 *
 * The file is written mode 0600 — libpq ignores a password file that is group-
 * or world-readable — inside a fresh `mkdtemp` directory that only this user
 * can enter, and the whole directory is removed in `finally`, so it does not
 * outlive the one invocation even when pg_dump fails or throws.
 */
const runLocalPgDump = (binary: string, connection: AmbientConnection, database: string): ChildOutcome => {
    const { host, port, user } = connection.address;
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'compat-ledger-pgpass-'));
    const passFile = path.join(directory, 'pgpass');

    try {
        fs.writeFileSync(
            passFile,
            `${[host, port, database, user, connection.password].map(escapePgpassField).join(':')}\n`,
            { mode: 0o600 },
        );

        return runChild(
            binary,
            [...PG_DUMP_SCHEMA_ARGS, '--host', host, '--port', port, '--username', user, '--dbname', database],
            { ...process.env, PGPASSFILE: passFile },
        );
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
};

/**
 * Runs pg_dump inside the container that runs the server, over that
 * container's own local socket — which is why this path passes neither
 * --host/--port nor any password: a local connection inside the official
 * postgres image is trusted.
 */
const runContainerPgDump = (container: string, connection: AmbientConnection, database: string): ChildOutcome =>
    runChild('docker', [
        'exec',
        container,
        'pg_dump',
        ...PG_DUMP_SCHEMA_ARGS,
        '--username',
        connection.address.user,
        '--dbname',
        database,
    ]);

/** One way of reaching a pg_dump, before it has been verified. */
interface DumpCandidate {
    readonly description: string;
    readonly version: () => ChildOutcome;
    readonly dump: (database: string) => ChildOutcome;
}

/** A verified runner. `dump` throws rather than returning null: see §0.9.1. */
interface SchemaDumpRunner {
    /** Names the runner in every message about it, success or failure. */
    readonly description: string;
    readonly dump: (database: string) => string[];
}

const localCandidate = (binary: string, origin: string, connection: AmbientConnection): DumpCandidate => ({
    description: `"${binary}" (${origin})`,
    version: () => runChild(binary, ['--version']),
    dump: (database) => runLocalPgDump(binary, connection, database),
});

const containerCandidate = (container: string, origin: string, connection: AmbientConnection): DumpCandidate => ({
    description: `pg_dump inside container "${container}" (${origin})`,
    version: () => runChild('docker', ['exec', container, 'pg_dump', '--version']),
    dump: (database) => runContainerPgDump(container, connection, database),
});

type CandidateVerdict = { accepted: true; runner: SchemaDumpRunner } | { accepted: false; reason: string };

const verifyCandidate = (
    candidate: DumpCandidate,
    connection: AmbientConnection,
    serverMajor: number,
    probeDatabase: string,
): CandidateVerdict => {
    const version = candidate.version();
    if (version.status !== 0) {
        return { accepted: false, reason: `${candidate.description}: ${describeFailure(version)}` };
    }

    const identified = PG_DUMP_VERSION_PATTERN.exec(version.stdout);
    if (identified === null) {
        return {
            accepted: false,
            reason: `${candidate.description}: --version printed "${firstLine(version.stdout)}", which does not identify a pg_dump`,
        };
    }

    const reportedVersion = identified[1];
    const major = Number(identified[2]);
    if (major < serverMajor) {
        return {
            accepted: false,
            reason:
                `${candidate.description}: it is pg_dump ${reportedVersion} and the server is PostgreSQL ` +
                `${serverMajor}; pg_dump refuses to dump a server newer than itself`,
        };
    }

    const probe = candidate.dump(probeDatabase);
    if (probe.status !== 0) {
        return {
            accepted: false,
            reason:
                `${candidate.description}: it is pg_dump ${reportedVersion}, but it could not dump ` +
                `${describeTarget(connection.address.host, probeDatabase)} — ${describeFailure(probe)}`,
        };
    }
    // DDL, not merely output: the ambient database is migrated (the guard in
    // `setup/testDb.ts` refuses to run the suite otherwise), so a dump of it
    // that contains no CREATE TABLE did not come from this server, whatever
    // the candidate answered `--version` with.
    if (!probe.stdout.includes('CREATE TABLE ')) {
        return {
            accepted: false,
            reason:
                `${candidate.description}: it is pg_dump ${reportedVersion}, but dumping ` +
                `${describeTarget(connection.address.host, probeDatabase)} produced no DDL, so it is not ` +
                'connected to the server this gate compares',
        };
    }

    const description = `${candidate.description} reporting PostgreSQL ${reportedVersion}`;

    return {
        accepted: true,
        runner: {
            description,
            dump: (database) => {
                const result = candidate.dump(database);
                if (result.status !== 0) {
                    throw new Error(
                        `${description} could not dump ${describeTarget(connection.address.host, database)}: ` +
                            describeFailure(result),
                    );
                }

                const lines = normalizeSchemaDump(result.stdout);
                if (lines.length === 0) {
                    // An empty dump on both sides would satisfy the comparison
                    // and prove nothing, so it is a failure here rather than a
                    // vacuous pass there.
                    throw new Error(
                        `${description} produced an empty schema dump for ` +
                            `${describeTarget(connection.address.host, database)}`,
                    );
                }
                return lines;
            },
        },
    };
};

/** Every running container publishing `port`, in the order docker lists them. */
const discoverServerContainers = (port: string): { containers: string[] } | { reason: string } => {
    const listed = runChild('docker', ['ps', '--filter', `publish=${port}`, '--format', '{{.Names}}']);
    if (listed.status !== 0) {
        return {
            reason: `no container could be discovered for port ${port}: docker ps ${describeFailure(listed)}`,
        };
    }

    const containers = listed.stdout
        .split('\n')
        .map((name) => name.trim())
        .filter((name) => name !== '');

    return containers.length === 0
        ? { reason: `no running container publishes port ${port}, so the server is not one this gate can dump from` }
        : { containers };
};

type DumpRunnerResolution = { ok: true; runner: SchemaDumpRunner } | { ok: false; attempts: string[] };

const resolveSchemaDumpRunner = (
    connection: AmbientConnection,
    serverMajor: number,
    probeDatabase: string,
): DumpRunnerResolution => {
    const candidates: DumpCandidate[] = [];
    const explicitBinary = process.env[PG_DUMP_BIN_VAR];
    const explicitContainer = process.env[PG_DUMP_CONTAINER_VAR];
    let discoveryFailure: string | null = null;

    if (explicitBinary !== undefined && explicitBinary.trim() !== '') {
        candidates.push(localCandidate(explicitBinary.trim(), `from ${PG_DUMP_BIN_VAR}`, connection));
    }
    candidates.push(localCandidate('pg_dump', 'found on PATH', connection));

    if (explicitContainer !== undefined && explicitContainer.trim() !== '') {
        // An explicit container is a decision, not a hint: discovery is not
        // consulted behind it, so a wrong name fails loudly instead of being
        // silently replaced by whatever else publishes the port.
        candidates.push(containerCandidate(explicitContainer.trim(), `from ${PG_DUMP_CONTAINER_VAR}`, connection));
    } else {
        const discovered = discoverServerContainers(connection.address.port);
        if ('reason' in discovered) {
            discoveryFailure = discovered.reason;
        } else {
            for (const container of discovered.containers) {
                candidates.push(
                    containerCandidate(
                        container,
                        `discovered as a container publishing port ${connection.address.port}`,
                        connection,
                    ),
                );
            }
        }
    }

    const attempts: string[] = [];
    for (const candidate of candidates) {
        const verdict = verifyCandidate(candidate, connection, serverMajor, probeDatabase);
        if (verdict.accepted) {
            return { ok: true, runner: verdict.runner };
        }
        attempts.push(verdict.reason);
    }
    if (discoveryFailure !== null) {
        attempts.push(discoveryFailure);
    }

    return { ok: false, attempts };
};

/** What a reader has to be told when the gate cannot produce its evidence. */
const dumpRunnerFailureMessage = (
    attempts: string[],
    serverMajor: number,
    address: ServerAddress,
    probeDatabase: string,
): string =>
    [
        'The dual-ledger equivalence gate (Agent Action Plan 0.9.1) compares the two migration ledgers on a ' +
            'normalised `pg_dump --schema-only`, and no pg_dump able to dump this server could be resolved. ' +
            'That evidence is mandatory, so the gate fails here rather than skipping it.',
        `Server: PostgreSQL ${serverMajor}, ${describeTarget(address.host, probeDatabase)}.`,
        'Tried, in order:',
        ...attempts.map((attempt) => `  - ${attempt}`),
        'Any one of these makes it runnable:',
        `  - install a PostgreSQL ${serverMajor} (or newer) client, so that pg_dump is on PATH;`,
        `  - set ${PG_DUMP_BIN_VAR} to such a pg_dump (commonly ` +
            `/usr/lib/postgresql/${serverMajor}/bin/pg_dump when PATH holds an older major);`,
        `  - make the container that runs the server reachable to \`docker exec\`, by setting ` +
            `${PG_DUMP_CONTAINER_VAR} to its name or by publishing port ${address.port} from it so it can be ` +
            'discovered.',
    ].join('\n');

const readServerMajorVersion = async (url: string): Promise<number> =>
    withClient(url, async (client) => {
        const result = await client.query<{ server_version_num: string }>('SHOW server_version_num');
        const reported = result.rows[0]?.server_version_num;
        const numeric = Number(reported);

        if (!Number.isFinite(numeric) || numeric <= 0) {
            throw new Error(`the server reported an unusable version number: ${JSON.stringify(reported)}`);
        }
        // 160015 is PostgreSQL 16.15; the major is the leading two digits for
        // every version pg_dump's compatibility rule is stated in terms of.
        return Math.floor(numeric / 10_000);
    });

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
    // Printed as well as failed: a Jest failure arrives after the whole run,
    // and this is the one line that tells whoever started it, straight away,
    // that the gate cannot run and why.
    // eslint-disable-next-line no-console
    console.warn(
        `[compat.test.ts] The dual-ledger equivalence gate CANNOT run: ${capability.reason}. ` +
            'It proves that prisma/migrations/20260908000000_meal_planning and ' +
            'prisma/manual-migrations/meal-planning/001_meal_planning.sql produce the same schema and ' +
            'preserve every legacy row. Point DATABASE_URL at a test database to run it.',
    );
}

describe('migration ledgers', () => {
    if (!capability.ok) {
        // A registered FAILURE, not a skip. 0.9.1 makes this gate a release
        // requirement, and a skipped requirement reports green while proving
        // nothing — which is exactly how a run can end with no evidence that
        // the two ledgers agree. The reason is the actionable part, so it is
        // both the test name and the failure.
        const reason = capability.reason;

        it(`prove the Prisma migration and the manual copy agree — cannot run because ${reason}`, () => {
            throw new Error(
                'The dual-ledger equivalence gate (Agent Action Plan 0.9.1) is mandatory and its ' +
                    `prerequisites are not met: ${reason}. It proves that ` +
                    'prisma/migrations/20260908000000_meal_planning and ' +
                    'prisma/manual-migrations/meal-planning/001_meal_planning.sql produce the same schema and ' +
                    'preserve every legacy row, so it fails rather than skipping. Run it with NODE_ENV=test and ' +
                    'DATABASE_URL pointing at a test-class database this suite may create neighbours of.',
            );
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
    // The intermediate pair, and the reason there is one: the two orders above
    // each run the WHOLE ledger, so a construct a later entry adds to or removes
    // from both of them agrees on both whatever the operator copy did with it.
    // These two hold the init schema plus exactly one file — the authoritative
    // feature migration on one, the copy on the other — and nothing after it.
    const authoritativeOnlyDatabase = `${capability.ambientDatabase}_ledger_c_test`;
    const manualOnlyDatabase = `${capability.ambientDatabase}_ledger_d_test`;
    const connection = connectionOf(ambientUrl);

    const fixture = readFixture();
    const legacyTables = fixture.insert_order;

    interface LedgerOutcome {
        loadedRows: Record<string, number>;
        fingerprintsBeforeMigration: Record<string, string>;
        fingerprintsAfterMigration: Record<string, string>;
        catalogue: string[];
        schemaDump: string[];
        publicTables: string[];
        additiveColumns: string[];
        backfilledRows: number;
        usdaApiCacheAdditiveColumns: string[];
        stampedUsdaApiCacheRows: number;
        searchVector: string;
        // The stdout of the FIRST `migrate deploy` this ledger runs — the one
        // immediately after its `migrate resolve --applied` step, and so the
        // one whose `Applying migration` lines name exactly what that ledger
        // left for Prisma to do. Order B's assertions read it: the resolve is
        // what must stop the meal-planning DDL the operator applied by hand
        // being applied a second time.
        deployAfterResolveStdout: string;
        // The deploy that must have nothing left to do, for both ledgers: for
        // order A the deploy after the manual reference copy, for order B a
        // further deploy after the one above applied whatever the manual copy
        // does not cover.
        finalDeployStdout: string;
    }

    let ledgerA: LedgerOutcome | null = null;
    let ledgerB: LedgerOutcome | null = null;
    let manualCopyNotices: string[] = [];
    let catalogueBeforeManualCopy: string[] = [];
    let catalogueAfterManualCopy: string[] = [];
    let catalogueAfterAuthoritativeFeature: string[] = [];
    let catalogueAfterManualCopyAlone: string[] = [];
    let dumpRunner: SchemaDumpRunner | null = null;

    const outcomeOf = (ledger: LedgerOutcome | null, label: string): LedgerOutcome => {
        if (ledger === null) {
            throw new Error(`ledger ${label} did not complete; its assertions cannot be evaluated`);
        }
        return ledger;
    };

    const resolvedDumpRunner = (): SchemaDumpRunner => {
        if (dumpRunner === null) {
            throw new Error('beforeAll must resolve the pg_dump runner before a ledger is dumped');
        }
        return dumpRunner;
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

    // Brings a disposable database up on the init schema plus exactly ONE ledger
    // file, applied directly rather than through `migrate deploy`, and returns
    // its catalogue. No fixture and no `migrate resolve`: this measures what one
    // file does to a schema, so anything that would let a second file run is
    // deliberately absent.
    const catalogueAfterLedgerFile = async (database: string, sqlPath: string): Promise<string[]> => {
        await recreateDatabase(maintenanceUrl, database);
        const url = databaseUrlFor(ambientUrl, database);

        await applyLedgerFile(url, INIT_SQL);
        await applyLedgerFile(url, sqlPath);

        return readCatalogue(url);
    };

    const finishLedger = async (
        url: string,
        database: string,
        loadedRows: Record<string, number>,
        fingerprintsBeforeMigration: Record<string, string>,
        deployAfterResolveStdout: string,
        finalDeployStdout: string,
    ): Promise<LedgerOutcome> => ({
        loadedRows,
        fingerprintsBeforeMigration,
        fingerprintsAfterMigration: await readTableFingerprints(url, legacyTables),
        catalogue: await readCatalogue(url),
        // Always a real dump: the runner is resolved in beforeAll and throws if
        // it cannot produce one, so no ledger can reach its assertions holding
        // an absent dump that the comparison would then have to tolerate.
        schemaDump: resolvedDumpRunner().dump(database),
        publicTables: await readPublicTableNames(url),
        additiveColumns: await readMealEntryAdditiveColumns(url),
        backfilledRows: await countBackfilledMealEntries(url),
        usdaApiCacheAdditiveColumns: await readUsdaApiCacheAdditiveColumns(url),
        stampedUsdaApiCacheRows: await countStampedUsdaApiCacheRows(url),
        searchVector: await readSearchVectorDefinition(url),
        deployAfterResolveStdout,
        finalDeployStdout,
    });

    beforeAll(async () => {
        // Refuse before creating anything if the derived names are not what this
        // suite is allowed to destroy. The ambient database is never a target.
        for (const database of [ledgerADatabase, ledgerBDatabase, authoritativeOnlyDatabase, manualOnlyDatabase]) {
            if (database === capability.ambientDatabase) {
                throw new Error(`refusing to use the ambient database '${database}' as a disposable ledger database`);
            }
            if (!isTestDatabaseName(database)) {
                throw new Error(`refusing to create '${database}': it is not a test-class database name`);
            }
        }

        // The dump runner is resolved BEFORE either database is built, and the
        // failure is thrown from here so that every case in this describe goes
        // red with one message naming what was tried: the gate's evidence
        // cannot be produced, which is a failure of the gate and not of one
        // assertion inside it. The probe is the ambient database — it exists,
        // it is a test database, and dumping its schema reads nothing the rest
        // of this suite depends on.
        const serverMajor = await readServerMajorVersion(ambientUrl);
        const resolution = resolveSchemaDumpRunner(connection, serverMajor, capability.ambientDatabase);

        if (!resolution.ok) {
            throw new Error(
                dumpRunnerFailureMessage(
                    resolution.attempts,
                    serverMajor,
                    connection.address,
                    capability.ambientDatabase,
                ),
            );
        }
        dumpRunner = resolution.runner;
        // The evidence this gate turns on is only as good as the tool that
        // produced it, so the run says which one that was.
        // eslint-disable-next-line no-console
        console.info(
            `[compat.test.ts] The normalised schema dumps both ledgers are compared on come from ` +
                `${dumpRunner.description}.`,
        );

        // Order A — the ledger every environment actually runs, then the
        // operator's reference copy on top of it, which must change nothing.
        const preparedA = await prepareLegacyDatabase(ledgerADatabase);
        const deployA = expectPrismaSuccess('migrate deploy (order A)', runPrisma(preparedA.url, ['migrate', 'deploy']));
        catalogueBeforeManualCopy = await readCatalogue(preparedA.url);
        manualCopyNotices = await applyLedgerFile(preparedA.url, MANUAL_SQL);
        catalogueAfterManualCopy = await readCatalogue(preparedA.url);
        const redeployA = expectPrismaSuccess(
            'migrate deploy after the manual copy (order A)',
            runPrisma(preparedA.url, ['migrate', 'deploy']),
        );
        ledgerA = await finishLedger(
            preparedA.url,
            ledgerADatabase,
            preparedA.loadedRows,
            preparedA.fingerprints,
            deployA,
            redeployA,
        );

        // Order B — the operator procedure the manual-migrations README
        // documents: apply the copy by hand, tell Prisma it is applied, and
        // deploy, which must then not apply the copy's DDL a second time.
        //
        // That deploy is not necessarily a no-op, and the second one below is
        // why this half runs two. The copy covers the meal-planning DDL and
        // nothing else — the README is explicit that the folder holds exactly
        // three files — so any later migration in prisma/migrations is still
        // genuinely pending after the resolve, and deploy applying it is the
        // ledger working rather than the resolve failing. The first deploy is
        // therefore asserted on what it applied, and the second on there being
        // nothing left, which is the claim §0.9.1 makes about this order.
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
        const redeployB = expectPrismaSuccess(
            'migrate deploy a second time (order B)',
            runPrisma(preparedB.url, ['migrate', 'deploy']),
        );
        ledgerB = await finishLedger(
            preparedB.url,
            ledgerBDatabase,
            preparedB.loadedRows,
            preparedB.fingerprints,
            deployB,
            redeployB,
        );

        // The intermediate comparison — the copy against the migration it copies,
        // each alone. Both orders above finish on the whole ledger, which
        // includes 20260910000000_catalog_prefix_fold_indexes, and that entry
        // drops the alias index the copy is supposed to reproduce; on those two
        // databases the index is therefore absent whatever the copy did with it,
        // so their agreement about it says nothing. These two run one file each
        // and stop, which is where that claim can still be measured.
        catalogueAfterAuthoritativeFeature = await catalogueAfterLedgerFile(authoritativeOnlyDatabase, FEATURE_SQL);
        catalogueAfterManualCopyAlone = await catalogueAfterLedgerFile(manualOnlyDatabase, MANUAL_SQL);
    }, 900_000);

    afterAll(async () => {
        for (const database of [ledgerADatabase, ledgerBDatabase, authoritativeOnlyDatabase, manualOnlyDatabase]) {
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

    // What Agent Action Plan 0.1.4 C3 actually claims about
    // prisma/manual-migrations/meal-planning/001_meal_planning.sql is that it is
    // 20260908000000_meal_planning's DDL written idempotently — an equivalence
    // between one file and one migration, which the two whole-ledger orders
    // below cannot see on their own. They compare two databases that have each
    // run every entry, so a construct a later entry adds to both, or removes
    // from both, matches on both however the copy behaved. This pair is the
    // direct measurement: the init schema plus one file, compared before
    // anything later runs.
    describe('the manual reference copy measured against the migration it copies', () => {
        it('produces the same catalogue as the authoritative migration, before any later entry runs', () => {
            expect(symmetricDifference(catalogueAfterAuthoritativeFeature, catalogueAfterManualCopyAlone)).toEqual({
                onlyInFirst: [],
                onlyInSecond: [],
            });
        });

        it('creates the alias index the authoritative migration creates, so losing it from both cannot pass', () => {
            const lowerAliasIndexLines = (catalogue: string[]): string[] =>
                catalogue.filter((line) => line.includes('idx_catalog_food_aliases_lower_alias'));

            const authoritative = lowerAliasIndexLines(catalogueAfterAuthoritativeFeature);
            const copy = lowerAliasIndexLines(catalogueAfterManualCopyAlone);

            // The non-vacuity guard for the case that made this describe
            // necessary. The copy's statement for this index is the one place it
            // is conditional on the schema it meets — it skips when
            // 20260910000000_catalog_prefix_fold_indexes' replacement index is
            // already there — and a guard that never took its creating branch
            // would leave the catalogue comparison above perfectly happy, since
            // neither of these databases would have the index. Asserting the
            // expression and the operator class positively on BOTH sides is what
            // distinguishes "the copy reproduced the migration" from "neither
            // has it".
            expect(authoritative).toHaveLength(1);
            expect(copy).toHaveLength(1);
            for (const line of [...authoritative, ...copy]) {
                expect(line).toContain('lower(alias)');
                expect(line).toContain('text_pattern_ops');
            }
            expect(copy).toEqual(authoritative);
        });

        it('does not create the replacement fold indexes, which are a later entry´s work', () => {
            const foldIndexLines = (catalogue: string[]): string[] =>
                catalogue.filter((line) => /INDEX \S+ idx_catalog_(food_aliases|foods)_fold_/.test(line));

            // The other half of the guard's story: the copy must not reach
            // forward either. If it created the fold indexes itself, its own
            // guard would then skip the alias index on a pre-feature schema and
            // the equivalence above would fail — so this pins the boundary
            // rather than restating it.
            expect(foldIndexLines(catalogueAfterAuthoritativeFeature)).toEqual([]);
            expect(foldIndexLines(catalogueAfterManualCopyAlone)).toEqual([]);
        });
    });

    describe('the manual reference copy applied by hand and then resolved', () => {
        it('loads the whole fixture into a database holding only the init migration', () => {
            const outcome = outcomeOf(ledgerB, 'B');
            expect(outcome.loadedRows).toEqual(outcomeOf(ledgerA, 'A').loadedRows);
        });

        it('never re-applies the DDL the copy already applied, and then reports nothing left to apply', () => {
            const outcome = outcomeOf(ledgerB, 'B');
            // Prisma announces each migration it applies on its own line:
            // "Applying migration `20260908000000_meal_planning`".
            const applyingLines = outcome.deployAfterResolveStdout
                .split('\n')
                .filter((line) => line.includes('Applying migration'));
            const appliedMigrations = applyingLines
                .map((line) => /Applying migration `([^`]+)`/.exec(line))
                .filter((match): match is RegExpExecArray => match !== null)
                .map((match) => match[1]);

            // The operator procedure only holds if `migrate resolve --applied`
            // convinces `migrate deploy` the work is done. If it did not, deploy
            // would try the Prisma migration on a schema that already has it —
            // which is precisely the second application of the hand-applied DDL
            // the resolve step exists to prevent, and what the
            // manual-migrations README tells an operator to run it for.
            expect(applyingLines.filter((line) => line.includes(FEATURE_MIGRATION))).toEqual([]);

            // Everything the deploy DID apply lies outside the manual copy's
            // scope. The copy carries the meal-planning DDL and the init schema
            // is already resolved, so a deploy that named either of those
            // migrations would be re-running DDL the database already has;
            // anything else it names is a later migration the copy never
            // claimed to cover, and applying it is the ledger working.
            expect(appliedMigrations.filter((name) => name === FEATURE_MIGRATION || name === INIT_MIGRATION)).toEqual(
                [],
            );

            // And once those are applied, the ledger is settled: a further
            // deploy has nothing to do at all, which is what §0.9.1 asserts
            // about this order.
            expect(outcome.finalDeployStdout).toMatch(/No pending migrations to apply/);
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
                catalogue.filter((line) => line.includes('idx_catalog_food_aliases_fold_alias'));

            const a = aliasIndexLines(outcomeOf(ledgerA, 'A').catalogue);
            const b = aliasIndexLines(outcomeOf(ledgerB, 'B').catalogue);

            // The non-vacuity guard for this construct, in the same shape as the
            // generated column above. The catalogue equality test at the top of
            // this describe is satisfied by two databases that BOTH lost the
            // operator class, so only a positive assertion holds the manual copy
            // to the authoritative migration here — and the class is a
            // correctness property, not a preference: without
            // `text_pattern_ops` the index cannot serve the left-anchored
            // `translate(alias, …) LIKE` predicate `catalog.service.ts` wrote it
            // for, because the collation of a database created the ordinary way
            // is not C. `pg_indexes.indexdef`, which `readCatalogue` records, does
            // carry the class, so the comparison can see it; the pg_catalog
            // sections of `docs/meal-planning/schema-catalog-evidence.sql` are
            // what pin it against the ledger being wrong in the same way twice.
            //
            // The schema-dump comparison below sees the class too, from the
            // other direction; this assertion is what holds it when the two
            // ledgers are wrong about it in the same way, which is the one case
            // a ledger-against-ledger comparison cannot catch.
            expect(a).toHaveLength(1);
            expect(b).toHaveLength(1);
            expect(a[0]).toContain('text_pattern_ops');
            expect(b[0]).toContain('text_pattern_ops');
            expect(a).toEqual(b);
        });

        // Unconditional, because 0.9.1 names this comparison as the gate's
        // evidence: the runner behind it is resolved in beforeAll, which fails
        // the whole describe if no pg_dump can be found, so there is nothing
        // left here to make conditional.
        it('produces an identical normalised pg_dump schema', () => {
            const a = outcomeOf(ledgerA, 'A').schemaDump;
            const b = outcomeOf(ledgerB, 'B').schemaDump;

            // Non-vacuity before equality, in the shape the rest of this
            // describe uses it: two dumps that both missed the feature schema
            // compare equal to each other and prove nothing. Every table the
            // migration adds must be in the DDL that is being compared.
            const missingFrom = (dump: string[]): string[] =>
                MEAL_PLANNING_TABLES.filter(
                    (table) => !dump.some((line) => line.includes(`CREATE TABLE public.${table} (`)),
                );
            expect(missingFrom(a)).toEqual([]);
            expect(missingFrom(b)).toEqual([]);

            // pg_dump reproduces what a human reviewer would read, so it
            // catches anything the catalogue query does not select.
            expect(symmetricDifference(a, b)).toEqual({ onlyInFirst: [], onlyInSecond: [] });
            expect(a).toEqual(b);
        });
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

        it('backfills no observed http_status onto the usda_api_cache rows that predate the column', () => {
            const a = outcomeOf(ledgerA, 'A');
            const b = outcomeOf(ledgerB, 'B');

            // Non-vacuity, in two parts, because a count of zero is also what a
            // database with no such column and a table with no such rows would
            // produce: the column has to be there afterwards, and the fixture's
            // cached responses have to be in the table being counted.
            expect(a.usdaApiCacheAdditiveColumns).toEqual([...ADDITIVE_USDA_API_CACHE_COLUMNS].sort());
            expect(b.usdaApiCacheAdditiveColumns).toEqual([...ADDITIVE_USDA_API_CACHE_COLUMNS].sort());
            expect(a.loadedRows.usda_api_cache).toBeGreaterThan(0);
            expect(b.loadedRows.usda_api_cache).toBeGreaterThan(0);

            // 20260909000000_usda_cache_http_status refuses to stamp rows
            // written before it with a 200, because that status would be a
            // status nobody observed — "exactly the evidence this column exists
            // to record", in the migration's own words. A NULL here is the
            // truthful reading that a cached response predates the ledger, so
            // every fixture row must still be carrying one.
            expect(a.stampedUsdaApiCacheRows).toBe(0);
            expect(b.stampedUsdaApiCacheRows).toBe(0);
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
// the request aborted after commit through the post-commit abort header, then
// replayed over the wire — belongs to `src/__tests__/api/fault.test.ts`, and
// the lock/reserve races belong to `src/__tests__/api/concurrency.test.ts`
// (§0.9.2). Both suites are in this checkpoint and own that evidence, and this
// describe deliberately does not restate it: what a client sees is theirs, and
// neither of them reads the column those answers are stored in. That column is
// what this is — the ledger's persistence at the service seam: the stored
// `meal_plan_actions` row, the bytes of `response_snapshot` itself and the key
// order PostgreSQL holds them in, underneath the wire-level proofs.
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

// ==========================================================================
// The additive-contract gate (§0.9.1 "Contract compatibility").
//
// The three suites above prove the schema the migration produces, the new
// behaviour of the entries endpoint, and the replay ledger. What none of them
// answers is the question this gate exists for: does a client written against
// the PREVIOUS release still get exactly what it got before? The prompt's
// preservation directive — "Keep existing API consumers compatible" — is a
// claim about responses that were never supposed to move, so the only proof is
// to state each one and compare.
//
// Everything below is therefore a pin on shipped behaviour, read off
// `nutrition.controller.ts`, `nutrition.service.ts`, `food.controller.ts` and
// `app.ts` and then observed over HTTP:
//
//   * the diary entry DTO — the eleven keys the mobile codec decodes, the two
//     additive members that are always PRESENT and sometimes null, and no
//     fourteenth key;
//   * the frozen responses — the five-field 400, the two 404 strings, the
//     `{success: true}` body, the day-read date guard, and the history page
//     block with its `parseInt(...) || default` behaviour;
//   * the untouched legacy target writer, which still writes `users.target_*`
//     and still creates no meal-planning state;
//   * the ownership boundary of the two entry routes, where the owner-bearing
//     write predicate changed and the HTTP answer did not;
//   * the neighbours this feature never touched, including both body-size
//     parser tiers.
//
// Why these belong here rather than in a `*.logic.test.ts`: every one of them
// is controller wiring, a mapper, a Prisma predicate or a mount order
// (`backend-architecture` §11). The per-field parser rules they sit on top of
// are `nutrition.logic.test.ts`'s and are deliberately not restated — what is
// asserted here is the RESPONSE, byte for byte, which only the mounted app can
// produce. Identity always arrives through the auth mock's header (§4), so a
// cross-user case still means what it says.
// ==========================================================================

import { MacroTotals } from '../../types/nutrition';

/**
 * The eleven keys `mapEntry` emitted before this feature, in its own order.
 * Every one of them is part of the mobile client's `MealEntryResponse` codec,
 * so a rename or an omission here is a client-visible break.
 */
const LEGACY_MEAL_ENTRY_DTO_KEYS = [
    'id',
    'foodId',
    'name',
    'servingText',
    'servings',
    'calories',
    'protein',
    'carbs',
    'fat',
    'inputMethod',
    'loggedAt',
] as const;

/**
 * The two this release adds. They are ADDITIVE in the strict sense the client's
 * codec needs: always present, `null` where they do not apply. The mobile
 * decoder declares them as `io.union([io.string, io.null])` inside an
 * `io.partial`, and a plain optional would reject an explicit `null` — so an
 * absent key and a null key are two different failures, and only one of them is
 * the contract.
 */
const ADDITIVE_MEAL_ENTRY_DTO_KEYS = ['mealPlanMealId', 'nutritionProvenance'] as const;

/** Both sets, sorted — the complete key set a diary entry may carry. */
const MEAL_ENTRY_DTO_KEYS = [...LEGACY_MEAL_ENTRY_DTO_KEYS, ...ADDITIVE_MEAL_ENTRY_DTO_KEYS]
    .slice()
    .sort();

/** The ten keys `food.service.ts::mapFood` emits, sorted. Untouched by this feature. */
const FOOD_DTO_KEYS = [
    'brand',
    'calories',
    'carbs',
    'fat',
    'id',
    'name',
    'protein',
    'servingAmount',
    'servingUnit',
    'source',
].sort();

/** The four starter foods `getFoodsForUser` seeds into an empty library. */
const STARTER_FOOD_NAMES = ['Apple', 'Chicken Breast', 'Egg', 'Peanut Butter'];

const sortedKeys = (value: object): string[] => Object.keys(value).sort();

/**
 * Resolves one of the four diary buckets for a day the way the app does — by
 * reading the day, which is what materializes them (§0.7.4). Nothing here
 * inserts a `meals` row directly, so the id every case below posts to is one a
 * client could actually hold.
 */
const diaryMealId = async (identity: { uid: string }, dayKey: string, mealName: string): Promise<string> => {
    const day = await asUser(request.get(`/api/macros/${dayKey}`), identity).expect(200);
    const meal = (day.body.meals as { id: string; name: string }[]).find(
        (candidate) => candidate.name === mealName,
    );

    if (meal === undefined) {
        throw new Error(`the day read for ${dayKey} returned no ${mealName} bucket`);
    }

    return meal.id;
};

/** Where an entry sits. The update contract carries no move fields, and this is how that is checked. */
const storedPlacement = async (entryId: string): Promise<{ meal_id: string; date: Date }> => {
    const row = await prisma.meal_entries.findUnique({
        where: { id: entryId },
        select: { meal_id: true, date: true },
    });

    if (row === null) {
        throw new Error(`entry ${entryId} was not written`);
    }

    return row;
};

/** The four `users` columns the legacy target writer owns, read straight from the row. */
const storedTargetColumns = async (userId: string) => {
    const row = await prisma.users.findUnique({
        where: { id: userId },
        select: {
            target_calories: true,
            target_protein_g: true,
            target_carbs_g: true,
            target_fat_g: true,
        },
    });

    if (row === null) {
        throw new Error(`user ${userId} was not created`);
    }

    return row;
};

describe('the diary entry DTO', () => {
    const owner = { uid: '' };
    let lunchId = '';

    beforeEach(async () => {
        await truncateFeatureTables();

        const user = await makeUser();
        owner.uid = user.id;
        lunchId = await diaryMealId(owner, DAY_KEY, 'Lunch');
    });

    afterAll(async () => {
        await truncateFeatureTables();
    });

    const logEntry = (body: Record<string, unknown>) =>
        asUser(request.post(`/api/macros/meal/${lunchId}/entries`).send(body), owner);

    it('carries the eleven keys a shipped client decodes, and exactly two more', async () => {
        const created = await logEntry({
            ...legacyBody(),
            servingText: '1 cup',
            servings: 0.33,
            inputMethod: 'ai_photo',
        }).expect(201);

        // The whole key set at once, so a leaked `catalogFoodId`,
        // `recipeVersionId`, `userId` or snake_case column fails here rather
        // than in a client the next release ships against.
        expect(sortedKeys(created.body)).toEqual(MEAL_ENTRY_DTO_KEYS);

        for (const key of LEGACY_MEAL_ENTRY_DTO_KEYS) {
            expect(created.body).toHaveProperty(key);
        }

        expect(created.body.id).toEqual(expect.any(String));
        expect(created.body.name).toBe('Scrambled eggs');
        expect(created.body.servingText).toBe('1 cup');
        expect(created.body.servings).toBe(0.33);
        expect(created.body.inputMethod).toBe('ai_photo');
    });

    it('reports the two additive members as present, not as absent', async () => {
        const created = await logEntry(legacyBody()).expect(201);

        // `in`, not a falsy check: `undefined` and `null` are both falsy and
        // only one of them is the contract. This is the assertion the mobile
        // codec's `io.union([io.string, io.null])` actually depends on.
        for (const key of ADDITIVE_MEAL_ENTRY_DTO_KEYS) {
            expect(key in created.body).toBe(true);
        }

        expect(created.body.mealPlanMealId).toBeNull();
        // Not null here: a client-supplied snapshot is classified, and null is
        // reserved for rows written before the column existed (§0.7.3).
        expect(created.body.nutritionProvenance).toBe('user_entered');
    });

    it('keeps the macros per serving, while the meal total is what was eaten', async () => {
        const created = await logEntry({ ...legacyBody(), servings: 3 }).expect(201);

        // The DTO's four numbers are the SNAPSHOT — `calories * servings` is
        // the client's job, and the day read's totals are the server's. Mixing
        // the two would triple every number the app displays on a 3-serving row.
        expect(created.body.calories).toBe(220);
        expect(created.body.protein).toBe(14);
        expect(created.body.carbs).toBe(2);
        expect(created.body.fat).toBe(16);

        const day = await asUser(request.get(`/api/macros/${DAY_KEY}`), owner).expect(200);
        const lunch = (day.body.meals as { id: string; totals: MacroTotals }[]).find(
            (meal) => meal.id === lunchId,
        );

        expect(lunch?.totals).toStrictEqual({ calories: 660, protein: 42, carbs: 6, fat: 48 });
        expect(day.body.totals).toStrictEqual({ calories: 660, protein: 42, carbs: 6, fat: 48 });
    });

    it('rounds a fractional macro to the integer the column holds', async () => {
        const created = await logEntry({ ...legacyBody(), calories: 10.6 }).expect(201);

        expect(created.body.calories).toBe(11);
    });

    it('reports foodId and servingText as null rather than omitting them', async () => {
        const created = await logEntry(legacyBody()).expect(201);

        expect('foodId' in created.body).toBe(true);
        expect('servingText' in created.body).toBe(true);
        expect(created.body.foodId).toBeNull();
        expect(created.body.servingText).toBeNull();
    });

    it('reports loggedAt as an ISO-8601 instant that round-trips', async () => {
        const created = await logEntry(legacyBody()).expect(201);
        const loggedAt = created.body.loggedAt as string;

        expect(loggedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
        expect(new Date(loggedAt).toISOString()).toBe(loggedAt);
    });

    it('is the same shape on the create, the day read and the update', async () => {
        const created = await logEntry(legacyBody()).expect(201);
        const updated = await asUser(
            request.put(`/api/macros/entry/${created.body.id}`).send({ servings: 2 }),
            owner,
        ).expect(200);
        const day = await asUser(request.get(`/api/macros/${DAY_KEY}`), owner).expect(200);
        const read = (day.body.meals as { entries: Record<string, unknown>[] }[])
            .flatMap((meal) => meal.entries)
            .find((entry) => entry.id === created.body.id);

        // One mapper, three responses (§6): a client decodes the same shape
        // wherever an entry reaches it.
        expect(sortedKeys(updated.body)).toEqual(MEAL_ENTRY_DTO_KEYS);
        expect(read).toBeDefined();
        expect(sortedKeys(read as object)).toEqual(MEAL_ENTRY_DTO_KEYS);
    });

    it.each(['library', 'search', 'ai_text', 'ai_photo'])(
        'stores the input method a body may ask for and classifies the snapshot: %s',
        async (inputMethod) => {
            const created = await logEntry({ ...legacyBody(), inputMethod }).expect(201);

            expect(created.body.inputMethod).toBe(inputMethod);
            // The numbers arrived from the client whatever method produced
            // them, so none of the four earns a source label (§0.7.3).
            expect(created.body.nutritionProvenance).toBe('user_entered');
            expect((await storedEntry(created.body.id)).nutrition_provenance).toBe('user_entered');
        },
    );

    it('refuses to let a body claim the planned origin', async () => {
        const created = await logEntry({ ...legacyBody(), inputMethod: 'meal_plan' }).expect(201);

        // 'meal_plan' is in the COLUMN's vocabulary and not in the accept-list
        // a body may choose from: the diary captions a row "From meal plan"
        // from this field alone, and a legacy body carries no plan, no recipe
        // version and unverifiable macros. It is not rejected — that would fail
        // a request the endpoint accepts today — it is simply not honoured.
        expect(created.body.inputMethod).toBe('library');
        expect(created.body.mealPlanMealId).toBeNull();
        expect((await storedEntry(created.body.id)).input_method).toBe('library');
    });

    it.each<[string, unknown]>([
        ['an unknown string', 'bogus'],
        ['a number', 42],
        ['null', null],
    ])('falls back to library for a method it cannot use: %s', async (_case, inputMethod) => {
        const created = await logEntry({ ...legacyBody(), inputMethod }).expect(201);

        expect(created.body.inputMethod).toBe('library');
    });

    it('falls back to library when the body names no method at all', async () => {
        const created = await logEntry(legacyBody()).expect(201);

        expect(created.body.inputMethod).toBe('library');
    });
});


describe('the frozen diary responses', () => {
    const owner = { uid: '' };
    let breakfastId = '';
    let lunchId = '';

    beforeEach(async () => {
        await truncateFeatureTables();

        const user = await makeUser();
        owner.uid = user.id;
        breakfastId = await diaryMealId(owner, DAY_KEY, 'Breakfast');
        lunchId = await diaryMealId(owner, DAY_KEY, 'Lunch');
    });

    afterAll(async () => {
        await truncateFeatureTables();
    });

    describe('the five-field guard on the entries route', () => {
        // One complete body, minus one field per case. Every one of the five is
        // "required" by the shipped message, so each removal must earn the same
        // string — and it is asserted on a WELL-FORMED path, because the
        // ordering case (a malformed path must not pre-empt this) is already
        // covered above and this is the plain contract.
        it.each(['name', 'calories', 'protein', 'carbs', 'fat'])(
            'answers the frozen 400 when %s is missing',
            async (field) => {
                const body: Record<string, unknown> = { ...legacyBody() };
                delete body[field];

                const response = await asUser(
                    request.post(`/api/macros/meal/${breakfastId}/entries`).send(body),
                    owner,
                ).expect(400);

                // toStrictEqual, so a `details` key added beside the message
                // fails: shipped clients read `{error}` and nothing else.
                expect(response.body).toStrictEqual({ error: LEGACY_REQUIRED_MESSAGE });
                expect(await prisma.meal_entries.count({ where: { meal_id: breakfastId } })).toBe(0);
            },
        );

        it('answers it for a name that is only whitespace', async () => {
            const response = await asUser(
                request.post(`/api/macros/meal/${breakfastId}/entries`).send({ ...legacyBody(), name: '   ' }),
                owner,
            ).expect(400);

            expect(response.body).toStrictEqual({ error: LEGACY_REQUIRED_MESSAGE });
        });

        it('still accepts a macro sent as a numeric string, as it always has', async () => {
            // The `Number()` coercion in the shipped guard is load-bearing
            // compatibility, not laxness: a client sending "220" has always
            // been accepted and the writer rounds it identically.
            const created = await asUser(
                request.post(`/api/macros/meal/${breakfastId}/entries`).send({
                    name: 'Coerced',
                    calories: '220',
                    protein: '14',
                    carbs: '2',
                    fat: '16',
                }),
                owner,
            ).expect(201);

            expect(created.body.calories).toBe(220);
            expect(created.body.fat).toBe(16);
        });

        it('answers 201 with the entry for a body that satisfies it', async () => {
            const created = await asUser(
                request.post(`/api/macros/meal/${breakfastId}/entries`).send(legacyBody()),
                owner,
            ).expect(201);

            expect(sortedKeys(created.body)).toEqual(MEAL_ENTRY_DTO_KEYS);
        });
    });

    describe('the two 404 strings on the entry routes', () => {
        it('answers the update of an absent entry with Entry not found', async () => {
            const response = await asUser(
                request.put(`/api/macros/entry/${ABSENT_UUID}`).send({ servings: 2 }),
                owner,
            ).expect(404);

            expect(response.body).toStrictEqual({ error: 'Entry not found' });
        });

        it('answers the delete of an absent entry with Entry not found', async () => {
            const response = await asUser(request.delete(`/api/macros/entry/${ABSENT_UUID}`), owner).expect(404);

            expect(response.body).toStrictEqual({ error: 'Entry not found' });
        });

        it('answers a successful delete with {success: true} and soft-deletes the row', async () => {
            const created = await asUser(
                request.post(`/api/macros/meal/${lunchId}/entries`).send(legacyBody()),
                owner,
            ).expect(201);

            const response = await asUser(request.delete(`/api/macros/entry/${created.body.id}`), owner).expect(200);

            expect(response.body).toStrictEqual({ success: true });
            // Soft, not hard: the row stays for history and for the plan links
            // that reference it, and the diary read filters on deleted_at.
            expect((await storedEntry(created.body.id)).deleted_at).not.toBeNull();
        });
    });

    describe('the day read´s date guard', () => {
        it.each([
            ['a single-digit month', '2026-1-05'],
            ['a two-digit year', '26-01-05'],
            ['slashes', '2026/01/05'],
            ['free text', 'not-a-date'],
        ])('refuses %s with the frozen message', async (_case, dayKey) => {
            const response = await asUser(
                request.get(`/api/macros/${encodeURIComponent(dayKey)}`),
                owner,
            ).expect(400);

            expect(response.body).toStrictEqual({ error: 'date must be yyyy-MM-dd' });
        });

        it('accepts a well-formed day key and echoes it', async () => {
            const response = await asUser(request.get('/api/macros/2026-01-05'), owner).expect(200);

            expect(response.body.date).toBe('2026-01-05');
            expect((response.body.meals as { name: string }[]).map((meal) => meal.name)).toEqual([
                'Breakfast',
                'Lunch',
                'Dinner',
                'Snack',
            ]);
        });

        it('is syntactic only: a calendar-impossible key passes the guard and fails behind it', async () => {
            // `^\d{4}-\d{2}-\d{2}$` matches 2026-13-45, `new Date` makes it an
            // Invalid Date, and Prisma refuses it — so the shipped answer is a
            // 500 with the handler's own message. Pinned as it is, deliberately
            // NOT repaired here: tightening the guard would change a response
            // this gate exists to hold still, and it is recorded as an
            // observation instead.
            const response = await asUser(request.get('/api/macros/2026-13-45'), owner).expect(500);

            expect(response.body).toStrictEqual({ error: 'Failed to get daily macros' });
        });

        it('lets JavaScript roll an out-of-range day rather than refusing it', async () => {
            // 2026-02-30 is syntactically valid, so it is accepted and the key
            // is echoed back verbatim while the rows are addressed by the date
            // `new Date` produced. Same reasoning as above: observed, not fixed.
            const response = await asUser(request.get('/api/macros/2026-02-30'), owner).expect(200);

            expect(response.body.date).toBe('2026-02-30');
        });
    });
});

describe('the diary history read', () => {
    const owner = { uid: '' };

    // Three days with known totals, built through the endpoint rather than
    // inserted, so what the history read summarizes is what a client logged:
    //   2026-03-11  two buckets, 100x2 + 50  -> 250 kcal, mealCount 2
    //   2026-03-10  one zero-calorie entry   -> excluded by the HAVING clause
    //   2026-03-09  one bucket, 300          -> 300 kcal, mealCount 1
    const NEWEST_DAY = '2026-03-11';
    const ZERO_CALORIE_DAY = '2026-03-10';
    const OLDEST_DAY = '2026-03-09';

    beforeAll(async () => {
        await truncateFeatureTables();

        const user = await makeUser();
        owner.uid = user.id;

        const log = async (dayKey: string, mealName: string, body: Record<string, unknown>) => {
            const mealId = await diaryMealId(owner, dayKey, mealName);

            await asUser(request.post(`/api/macros/meal/${mealId}/entries`).send(body), owner).expect(201);
        };

        await log(NEWEST_DAY, 'Breakfast', {
            name: 'Oats',
            calories: 100,
            protein: 10,
            carbs: 5,
            fat: 2,
            servings: 2,
        });
        await log(NEWEST_DAY, 'Lunch', { name: 'Soup', calories: 50, protein: 5, carbs: 3, fat: 1 });
        await log(ZERO_CALORIE_DAY, 'Breakfast', {
            name: 'Black coffee',
            calories: 0,
            protein: 0,
            carbs: 0,
            fat: 0,
        });
        await log(OLDEST_DAY, 'Breakfast', { name: 'Bagel', calories: 300, protein: 1, carbs: 1, fat: 1 });
    }, 60_000);

    afterAll(async () => {
        await truncateFeatureTables();
    });

    it('answers the shipped page block with its defaults', async () => {
        const response = await asUser(request.get('/api/macros/history'), owner).expect(200);

        expect(sortedKeys(response.body)).toEqual(['days', 'pagination']);
        expect(response.body.pagination).toStrictEqual({ page: 1, limit: 30, total: 2, totalPages: 1 });
    });

    it('summarizes each day as eaten, newest first', async () => {
        const response = await asUser(request.get('/api/macros/history'), owner).expect(200);
        const days = response.body.days as {
            date: string;
            mealCount: number;
            calories: number;
            protein: number;
            carbs: number;
            fat: number;
            meals: { name: string; sortOrder: number; calories: number }[];
        }[];

        // ORDER BY date DESC, and the totals are `SUM(ROUND(value * servings))`
        // — the 2-serving oats count twice, which is what makes these the
        // as-eaten figures rather than the snapshots.
        expect(days.map((day) => day.date)).toEqual([NEWEST_DAY, OLDEST_DAY]);
        expect(days[0]).toMatchObject({
            date: NEWEST_DAY,
            mealCount: 2,
            calories: 250,
            protein: 25,
            carbs: 13,
            fat: 5,
        });
        expect(days[1]).toMatchObject({ date: OLDEST_DAY, mealCount: 1, calories: 300 });
        // mealCount is COUNT(DISTINCT meal_id), so it counts buckets and not
        // entries, and the per-meal breakdown is ordered by the bucket's own
        // sort order.
        expect(days[0].meals.map((meal) => [meal.name, meal.sortOrder, meal.calories])).toEqual([
            ['Breakfast', 0, 200],
            ['Lunch', 1, 50],
        ]);
    });

    it('skips a day whose entries add up to zero calories', async () => {
        const response = await asUser(request.get('/api/macros/history'), owner).expect(200);
        const days = response.body.days as { date: string }[];

        // `HAVING SUM(ROUND(calories * servings)) > 0` — the old app's
        // behaviour, and the reason the day is absent from both the page and
        // the total rather than present with a zero.
        expect(days.map((day) => day.date)).not.toContain(ZERO_CALORIE_DAY);
        expect(response.body.pagination.total).toBe(2);
    });

    it.each([
        ['page=0, because 0 is falsy', 'page=0', 1, 30],
        ['a non-numeric page', 'page=abc', 1, 30],
        ['limit=0, for the same reason', 'limit=0', 1, 30],
        ['a non-numeric limit', 'limit=abc', 1, 30],
    ])('falls back through parseInt(...) || default for %s', async (_case, query, page, limit) => {
        const response = await asUser(request.get(`/api/macros/history?${query}`), owner).expect(200);

        expect(response.body.pagination).toMatchObject({ page, limit });
    });

    it('pages with the limit it was given, and reports totalPages from it', async () => {
        const first = await asUser(request.get('/api/macros/history?page=1&limit=1'), owner).expect(200);
        const second = await asUser(request.get('/api/macros/history?page=2&limit=1'), owner).expect(200);

        expect(first.body.pagination).toStrictEqual({ page: 1, limit: 1, total: 2, totalPages: 2 });
        expect((first.body.days as { date: string }[]).map((day) => day.date)).toEqual([NEWEST_DAY]);
        expect((second.body.days as { date: string }[]).map((day) => day.date)).toEqual([OLDEST_DAY]);
    });

    it('answers a user with nothing logged with an empty page rather than a 404', async () => {
        const stranger = await makeUser();

        const response = await asUser(request.get('/api/macros/history'), { uid: stranger.id }).expect(200);

        expect(response.body.days).toEqual([]);
        // Math.ceil(0 / 30) is 0, which is what this endpoint has always
        // reported for an empty history.
        expect(response.body.pagination).toStrictEqual({ page: 1, limit: 30, total: 0, totalPages: 0 });
    });
});


describe('the untouched legacy target writer', () => {
    const owner = { uid: '' };

    beforeEach(async () => {
        await truncateFeatureTables();

        // Targets null, which is "never opted in" — the state this route has
        // always been the only writer for.
        const user = await makeUser();
        owner.uid = user.id;
    });

    afterAll(async () => {
        await truncateFeatureTables();
    });

    const putLegacyTargets = (body: Record<string, unknown>) =>
        asUser(request.put('/api/user/targets').send(body), owner);

    it('answers User not found for an identity with no row', async () => {
        const response = await asUser(request.put('/api/user/targets').send({ calories: 2000 }), {
            uid: 'no-such-user',
        }).expect(404);

        expect(response.body).toStrictEqual({ error: 'User not found' });
    });

    it('writes the four columns and returns exactly them', async () => {
        const response = await putLegacyTargets({
            calories: 2000,
            protein: 150,
            carbs: 200,
            fat: 70,
        }).expect(200);

        expect(response.body).toStrictEqual({ calories: 2000, protein: 150, carbs: 200, fat: 70 });
        expect(await storedTargetColumns(owner.uid)).toStrictEqual({
            target_calories: 2000,
            target_protein_g: 150,
            target_carbs_g: 200,
            target_fat_g: 70,
        });
    });

    it('creates no meal-planning state and advances no targets revision', async () => {
        await putLegacyTargets({ calories: 2000, protein: 150, carbs: 200, fat: 70 }).expect(200);

        // §0.1.3: this route "stays untouched for API compatibility". It is not
        // the canonical writer, so it owns no preferences row and no revision —
        // and the canonical read stays truthful about that by reporting the
        // values as `legacy` rather than by being written to.
        expect(await prisma.meal_plan_preferences.count()).toBe(0);

        const canonical = await asUser(request.get('/api/meal-planning/targets'), owner).expect(200);

        expect(canonical.body).toStrictEqual({
            targets: { calories: 2000, protein: 150, carbs: 200, fat: 70 },
            complete: true,
            source: 'legacy',
            stale: false,
            revision: 0,
        });
    });

    it('rounds a fractional value the way it always has', async () => {
        const response = await putLegacyTargets({ calories: 1999.6 }).expect(200);

        expect(response.body.calories).toBe(2000);
    });

    it('writes an explicit null, because clearing a target is a real request', async () => {
        await putLegacyTargets({ calories: 2000, protein: 150, carbs: 200, fat: 70 }).expect(200);

        const response = await putLegacyTargets({ protein: null }).expect(200);

        expect(response.body).toStrictEqual({ calories: 2000, protein: null, carbs: 200, fat: 70 });
        expect((await storedTargetColumns(owner.uid)).target_protein_g).toBeNull();
    });

    it.each<[string, Record<string, unknown>]>([
        ['zero', { calories: 0 }],
        ['a negative number', { calories: -500 }],
        ['a value that does not coerce to a number', { calories: 'abc' }],
        ['a field the body does not name at all', {}],
    ])('leaves the stored value alone for %s', async (_case, body) => {
        await putLegacyTargets({ calories: 2000, protein: 150, carbs: 200, fat: 70 }).expect(200);

        // The shipped coercion keeps a value only when it is finite AND > 0;
        // everything else collapses to `undefined`, which the service reads as
        // "not being written". That makes 0 and a negative number SILENTLY
        // IGNORED rather than stored or refused — the compat trap this case
        // exists for, since a client that means "clear it" has to send null.
        const response = await putLegacyTargets(body).expect(200);

        expect(response.body.calories).toBe(2000);
        expect((await storedTargetColumns(owner.uid)).target_calories).toBe(2000);
    });

    it('cannot carry NaN over the wire, and ignores the string that produces it', async () => {
        await putLegacyTargets({ calories: 2000, protein: 150, carbs: 200, fat: 70 }).expect(200);

        // JSON has no NaN literal: `JSON.stringify({x: NaN})` is `{"x":null}`,
        // so a client "sending NaN" actually sends null and CLEARS the column.
        // The NaN branch of the coercion is only reachable through a
        // non-numeric string, and that branch ignores the field instead.
        const asNull = await putLegacyTargets({ protein: Number.NaN }).expect(200);
        const asString = await putLegacyTargets({ carbs: 'not a number' }).expect(200);

        expect(asNull.body.protein).toBeNull();
        expect(asString.body.carbs).toBe(200);
    });

    it('turns confirmed targets into legacy ones the moment it moves a value', async () => {
        // The canonical writer first, so there is something to diverge from.
        const confirmed = await asUser(
            request
                .put('/api/meal-planning/targets')
                .send({ source: 'manual', calories: 2000, protein: 150, carbs: 200, fat: 70 }),
            owner,
        ).expect(200);
        const confirmedRevision = confirmed.body.targets.revision as number;

        expect(confirmed.body.targets).toMatchObject({ source: 'manual', complete: true });
        expect(confirmedRevision).toBeGreaterThan(0);

        // Then the untouched legacy route, moving one of the four.
        await putLegacyTargets({ calories: 2100 }).expect(200);

        const canonical = await asUser(request.get('/api/meal-planning/targets'), owner).expect(200);

        // §0.5.2: the stored values no longer equal `confirmed_targets`, so the
        // attribution becomes `legacy` — which is how an old client keeps
        // working while the planner still refuses to build a week from numbers
        // nobody confirmed. The revision does NOT move: this writer never
        // touches it.
        expect(canonical.body).toStrictEqual({
            targets: { calories: 2100, protein: 150, carbs: 200, fat: 70 },
            complete: true,
            source: 'legacy',
            stale: false,
            revision: confirmedRevision,
        });
    });
});

describe('the diary entry ownership boundary', () => {
    const owner = { uid: '' };
    const stranger = { uid: '' };
    let strangerEntryId = '';
    let ownerBreakfastId = '';
    let ownerLunchId = '';

    beforeEach(async () => {
        await truncateFeatureTables();

        const first = await makeUser();
        const second = await makeUser();
        owner.uid = first.id;
        stranger.uid = second.id;

        ownerBreakfastId = await diaryMealId(owner, DAY_KEY, 'Breakfast');
        ownerLunchId = await diaryMealId(owner, DAY_KEY, 'Lunch');

        const strangerBreakfastId = await diaryMealId(stranger, DAY_KEY, 'Breakfast');
        const created = await asUser(
            request.post(`/api/macros/meal/${strangerBreakfastId}/entries`).send(legacyBody()),
            stranger,
        ).expect(201);

        strangerEntryId = created.body.id as string;
    });

    afterAll(async () => {
        await truncateFeatureTables();
    });

    it('answers a foreign update with Entry not found and changes nothing', async () => {
        const before = await storedEntry(strangerEntryId);

        const response = await asUser(
            request.put(`/api/macros/entry/${strangerEntryId}`).send({ servings: 9, name: 'Hijacked', calories: 1 }),
            owner,
        ).expect(404);

        expect(response.body).toStrictEqual({ error: 'Entry not found' });
        // The HTTP answer was already 404 before the write predicate gained its
        // owner key — the read did the authorizing — so the ONLY way to see
        // that the predicate landed is to read the row back. Rule §5.1: a write
        // that finds by id alone is a cross-user write waiting to happen.
        expect(await storedEntry(strangerEntryId)).toStrictEqual(before);
    });

    it('answers a foreign delete with Entry not found and leaves the row live', async () => {
        const response = await asUser(request.delete(`/api/macros/entry/${strangerEntryId}`), owner).expect(404);

        expect(response.body).toStrictEqual({ error: 'Entry not found' });
        expect((await storedEntry(strangerEntryId)).deleted_at).toBeNull();

        // Still the stranger's to delete, which is what "unchanged" has to mean.
        await asUser(request.delete(`/api/macros/entry/${strangerEntryId}`), stranger).expect(200);
    });

    it('answers a foreign id and an absent id identically, so existence never leaks', async () => {
        const foreignUpdate = await asUser(
            request.put(`/api/macros/entry/${strangerEntryId}`).send({ servings: 2 }),
            owner,
        );
        const absentUpdate = await asUser(request.put(`/api/macros/entry/${ABSENT_UUID}`).send({ servings: 2 }), owner);
        const foreignDelete = await asUser(request.delete(`/api/macros/entry/${strangerEntryId}`), owner);
        const absentDelete = await asUser(request.delete(`/api/macros/entry/${ABSENT_UUID}`), owner);

        // §1.5 / §8: 404 for both, never 403, and the two indistinguishable.
        expect(foreignUpdate.status).toBe(absentUpdate.status);
        expect(foreignUpdate.body).toStrictEqual(absentUpdate.body);
        expect(foreignDelete.status).toBe(absentDelete.status);
        expect(foreignDelete.body).toStrictEqual(absentDelete.body);
        expect(foreignUpdate.status).toBe(404);
        expect(foreignDelete.status).toBe(404);
    });

    it('leaves the stranger´s day read untouched by the attempts', async () => {
        await asUser(request.put(`/api/macros/entry/${strangerEntryId}`).send({ name: 'Hijacked' }), owner).expect(404);

        const day = await asUser(request.get(`/api/macros/${DAY_KEY}`), stranger).expect(200);
        const entries = (day.body.meals as { entries: { id: string; name: string }[] }[]).flatMap(
            (meal) => meal.entries,
        );

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ id: strangerEntryId, name: 'Scrambled eggs' });
    });

    it('ignores a meal and a date the update body names', async () => {
        const created = await asUser(
            request.post(`/api/macros/meal/${ownerBreakfastId}/entries`).send(legacyBody()),
            owner,
        ).expect(201);
        const before = await storedPlacement(created.body.id);

        const response = await asUser(
            request.put(`/api/macros/entry/${created.body.id}`).send({
                mealId: ownerLunchId,
                date: '2026-04-01',
                servings: 2,
            }),
            owner,
        ).expect(200);

        // §0.5.1: "The existing update contract has no move fields, and none are
        // added: an entry stays in its meal and on its date." The body is
        // accepted — unknown keys have never been refused here — and the two
        // columns a move would need are simply not among the ones the service
        // writes.
        expect(response.body.servings).toBe(2);
        expect(sortedKeys(response.body)).toEqual(MEAL_ENTRY_DTO_KEYS);

        const after = await storedPlacement(created.body.id);

        expect(after.meal_id).toBe(before.meal_id);
        expect(after.meal_id).toBe(ownerBreakfastId);
        expect(after.date.toISOString()).toBe(before.date.toISOString());
    });
});

describe('the neighbours this feature did not touch', () => {
    const owner = { uid: '' };

    beforeEach(async () => {
        await truncateFeatureTables();

        const user = await makeUser();
        owner.uid = user.id;
    });

    afterAll(async () => {
        await truncateFeatureTables();
    });

    it('answers /health without an identity header', async () => {
        // Unauthenticated by design (§3.1): Coolify health checks, uptime
        // monitoring and post-deploy verification all hit it, and mounting the
        // new routers must not have moved it behind the auth boundary.
        const response = await request.get('/health').expect(200);

        expect(sortedKeys(response.body)).toEqual(['status', 'version']);
        expect(response.body.status).toBe('ok');
        expect(response.body.version).toEqual(expect.any(String));
    });

    it('still refuses an authenticated route without one', async () => {
        const response = await request.get('/api/foods').expect(401);

        expect(response.body).toStrictEqual({ error: 'No token provided' });
    });

    it('answers the foods library with its shipped page block and starter foods', async () => {
        const response = await asUser(request.get('/api/foods'), owner).expect(200);
        const foods = response.body.foods as { name: string }[];

        expect(sortedKeys(response.body)).toEqual(['foods', 'pagination']);
        // Defaults 1 and 25, and the four starter foods a fresh library is
        // seeded with on first read — both unchanged by the catalog work, which
        // adds a separate `/api/catalog/foods` route rather than touching this one.
        expect(response.body.pagination).toStrictEqual({ page: 1, limit: 25, total: 4, totalPages: 1 });
        expect(foods.map((food) => food.name).sort()).toEqual(STARTER_FOOD_NAMES);
        expect(sortedKeys(foods[0])).toEqual(FOOD_DTO_KEYS);
    });

    it('answers the AI usage meter unchanged', async () => {
        // No email header, so the unlimited whitelist cannot match whatever the
        // environment has configured and the answer is deterministic.
        const response = await asUser(request.get('/api/macros/ai-usage'), owner).expect(200);

        expect(sortedKeys(response.body)).toEqual(['limit', 'resetsAt', 'unlimited', 'used']);
        expect(response.body.used).toBe(0);
        expect(response.body.unlimited).toBe(false);
        expect(Number.isInteger(response.body.limit) && response.body.limit > 0).toBe(true);
        // The first millisecond of the next UTC day.
        expect(response.body.resetsAt).toMatch(/T00:00:00\.000Z$/);
    });

    describe('the two body-size parser tiers', () => {
        // Comfortably over the global 100 KB default and far under the AI
        // routes' 10 MB one, so one payload tells the two tiers apart.
        const OVERSIZED_BODY = 'x'.repeat(150 * 1024);

        it('lets the AI tier parse a body the global limit would refuse', async () => {
            // §3.1: "the first JSON parser to run wins", so the 10 MB parser has
            // to stay mounted BEFORE the global one. The proof is that the
            // request reaches the controller at all — it answers the controller's
            // own validation message instead of a 413, and no vendor call or
            // quota consumption is involved in getting there.
            const response = await asUser(
                request.post('/api/macros/label-scan').send({ padding: OVERSIZED_BODY }),
                owner,
            ).expect(400);

            expect(response.body).toStrictEqual({ error: 'imageBase64 is required' });
        });

        it('still refuses an oversized diary body at the global tier', async () => {
            const breakfastId = await diaryMealId(owner, DAY_KEY, 'Breakfast');

            // The entries route is on the global parser, which rejects the body
            // before the handler sees it. Express's default error handler owns
            // this response, so only the status is a contract — and nothing
            // reaches the database.
            await asUser(
                request
                    .post(`/api/macros/meal/${breakfastId}/entries`)
                    .send({ ...legacyBody(), rawInput: OVERSIZED_BODY }),
                owner,
            ).expect(413);

            expect(await prisma.meal_entries.count({ where: { user_id: owner.uid } })).toBe(0);
        });
    });
});

