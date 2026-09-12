import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { FEATURE_TABLES, TestDatabaseGuardError, assertTestDatabase } from './testDb';

const BACKEND_ROOT = join(__dirname, '..', '..', '..');
const JEST_SETUP_FILE = join(__dirname, 'jestSetup.ts');
const TEST_TSCONFIG = join(BACKEND_ROOT, 'tsconfig.test.json');

const CHILD_TIMEOUT_MS = 60_000;

const UNROUTABLE_RFC_5737_DOCUMENTATION_HOST = '192.0.2.1';

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
            { scenario: 'the production-shaped URL this platform exports', databaseUrl: secretUrl('ev7c65ukrc31l80vndc57w5o', 'state_of_health') },
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
    const DATABASE_MODULE_PATTERN = String.raw`@prisma[\\/]client|generated[\\/]prisma`;

    let probeDirectory: string;
    let hookPath: string;
    let markerPath: string;
    let instrumentControlPath: string;

    beforeAll(() => {
        probeDirectory = mkdtempSync(join(tmpdir(), 'soh-guard-proof-'));
        hookPath = join(probeDirectory, 'record-database-access.js');
        markerPath = join(probeDirectory, 'database-access.log');
        instrumentControlPath = join(probeDirectory, 'instrument-control.js');

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
});
