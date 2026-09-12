/**
 * The test harness's own suite (Agent Action Plan §0.7.1 / §0.9.1), in three
 * clearly separated concerns:
 *
 *   1. `assertTestDatabase` against injected environments — every accept and
 *      reject rule, in process, with no spawning and no database.
 *   2. The guard proven from OUTSIDE the process it protects. This is the part
 *      that cannot live inside the suite it defends: by the time a test runs,
 *      `jestSetup.ts` has already passed the guard, so the only way to observe
 *      the unsafe path is to run `jestSetup.ts` in a child of our own with an
 *      unsafe `DATABASE_URL` and instrumentation that records any database
 *      module load or socket connect.
 *   3. The rest of the harness exercised for real: the factories through
 *      Prisma, `truncateFeatureTables`, `disconnectTestDatabase`, and
 *      `testApp`'s supertest handle against `/health` and a protected route.
 */

import { spawnSync } from 'child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

import { prisma } from '../../prisma/client';
import { makeCatalogFood, makeUser } from './factories';
import { TEST_EMAIL_HEADER, TEST_USER_ID_HEADER, asUser, request } from './testApp';
import {
    FEATURE_TABLES,
    TestDatabaseGuardError,
    assertTestDatabase,
    disconnectTestDatabase,
    truncateFeatureTables,
} from './testDb';

/** The backend package root — `src/__tests__/setup` is three levels down. */
const BACKEND_ROOT = join(__dirname, '..', '..', '..');

/** A safe environment, which each case below then breaks in exactly one way. */
const SAFE_ENV: NodeJS.ProcessEnv = {
    NODE_ENV: 'test',
    ALLOW_DB_TRUNCATE: 'true',
    DATABASE_URL: 'postgresql://soh:soh@127.0.0.1:5433/soh_test',
};

const envWith = (overrides: NodeJS.ProcessEnv): NodeJS.ProcessEnv => ({ ...SAFE_ENV, ...overrides });

/**
 * The password and user in every URL below. A refusal message reaches CI logs
 * and a terminal, so the suite asserts they never appear in one.
 */
const SECRET_PASSWORD = 'hunter2-not-in-any-message';
const SECRET_USER = 'appuser';
const secretUrl = (host: string, database: string): string =>
    `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@${host}:5432/${database}`;

/** Asserts a refusal and returns it, so a case can make further assertions. */
const expectRefusal = (env: NodeJS.ProcessEnv, code: string): TestDatabaseGuardError => {
    let thrown: unknown;
    try {
        assertTestDatabase(env);
    } catch (error) {
        thrown = error;
    }

    expect(thrown).toBeInstanceOf(TestDatabaseGuardError);
    const refusal = thrown as TestDatabaseGuardError;
    expect(refusal.code).toBe(code);

    return refusal;
};

describe('assertTestDatabase — accepted environments', () => {
    it('accepts the ambient environment the suite is running under', () => {
        // If this fails, the suite could not have got this far: `jestSetup.ts`
        // runs the same call. It is asserted anyway so a future change that
        // makes the guard depend on something only `jestSetup` set up fails
        // here, where the reason is legible.
        expect(() => assertTestDatabase()).not.toThrow();
    });

    it.each([
        ['the documented local name', 'postgresql://soh:soh@127.0.0.1:5433/soh_test'],
        ['a clone-index tail', 'postgresql://soh:soh@127.0.0.1:5433/soh_test_46'],
        ['a zero-padded clone index', 'postgresql://soh:soh@localhost:5433/soh_test_046'],
        ["CI's plainly named database", 'postgresql://ci:ci@localhost:5432/ci'],
        ['the compose service host', 'postgresql://ci:ci@postgres:5432/ci'],
        ['an upper-case host spelling', 'postgresql://soh:soh@LOCALHOST:5433/soh_test'],
    ])('accepts %s', (_case, databaseUrl) => {
        expect(() => assertTestDatabase(envWith({ DATABASE_URL: databaseUrl }))).not.toThrow();
    });
});

describe('assertTestDatabase — NODE_ENV', () => {
    it.each([
        ['development', 'development'],
        ['production', 'production'],
        ['a near miss in case', 'Test'],
        ['a padded value', ' test'],
    ])('refuses %s', (_case, nodeEnv) => {
        const refusal = expectRefusal(envWith({ NODE_ENV: nodeEnv }), 'node_env_not_test');
        expect(refusal.message).toContain('NODE_ENV');
    });

    it('refuses an unset NODE_ENV and says it is not set', () => {
        const refusal = expectRefusal(envWith({ NODE_ENV: undefined }), 'node_env_not_test');
        expect(refusal.message).toContain('not set');
    });
});

describe('assertTestDatabase — ALLOW_DB_TRUNCATE', () => {
    it.each([
        ['an unset value', undefined],
        ['a blank value', ''],
        ['an upper-case value', 'TRUE'],
        ['a numeric value', '1'],
        ['a padded value', 'true '],
        ['an explicit false', 'false'],
    ])('refuses %s', (_case, allowDbTruncate) => {
        const refusal = expectRefusal(
            envWith({ ALLOW_DB_TRUNCATE: allowDbTruncate }),
            'truncate_not_allowed',
        );
        expect(refusal.message).toContain('ALLOW_DB_TRUNCATE');
    });
});

describe('assertTestDatabase — DATABASE_URL', () => {
    it('refuses an absent DATABASE_URL', () => {
        expectRefusal(envWith({ DATABASE_URL: undefined }), 'missing_database_url');
    });

    it('refuses a blank DATABASE_URL', () => {
        expectRefusal(envWith({ DATABASE_URL: '   ' }), 'missing_database_url');
    });

    it.each([
        ['a value that is not a URL', 'soh_test'],
        ['a URL naming no database', 'postgresql://soh:soh@127.0.0.1:5433'],
        ['a URL with an empty path', 'postgresql://soh:soh@127.0.0.1:5433/'],
        ['a malformed percent escape', 'postgresql://soh:soh@127.0.0.1:5433/soh%ZZtest'],
    ])('refuses %s', (_case, databaseUrl) => {
        expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'unparsable_database_url');
    });

    it.each([
        ['the development database', 'postgresql://soh:soh@127.0.0.1:5433/soh_dev_46'],
        ['the shadow database', 'postgresql://soh:soh@127.0.0.1:5433/soh_shadow_46'],
        ['a production-looking name on a local host', 'postgresql://soh:soh@localhost:5432/state_of_health'],
        ['a name that merely contains test', 'postgresql://soh:soh@127.0.0.1:5433/testing_grounds'],
        ['a name with a non-numeric tail after the suffix', 'postgresql://soh:soh@127.0.0.1:5433/soh_test_copy'],
    ])('refuses %s on a local host', (_case, databaseUrl) => {
        const refusal = expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'database_name_not_test');
        expect(refusal.message).toContain('_test');
    });

    it.each([
        ['a test name on a remote host', secretUrl('db.prod.example.com', 'app_test')],
        ['a clone-indexed test name on a remote host', secretUrl('db.prod.example.com', 'app_test_46')],
        ['the production-shaped URL this platform exports', secretUrl('ev7c65ukrc31l80vndc57w5o', 'state_of_health')],
        ['a public IP address', secretUrl('203.0.113.10', 'soh_test')],
    ])('refuses %s', (_case, databaseUrl) => {
        const refusal = expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'database_host_not_local');
        expect(refusal.message).toContain('the host must be one of');
    });

    it.each([
        ['a redirecting host parameter', `postgresql://soh:${SECRET_PASSWORD}@127.0.0.1:5433/soh_test?host=db.prod.example.com`],
        ['a redirecting dbname parameter', `postgresql://soh:${SECRET_PASSWORD}@127.0.0.1:5433/soh_test?dbname=state_of_health`],
        ['a percent-encoded database name', `postgresql://soh:${SECRET_PASSWORD}@127.0.0.1:5433/soh%5Ftest`],
        ['a URL with no host at all', 'postgresql:///soh_test'],
    ])('refuses %s, because the URL does not determine what it opens', (_case, databaseUrl) => {
        // Fail-closed, and the reason it matters: `pg` and Prisma resolve these
        // two forms differently, so a guard that classified the authority while
        // the driver connected elsewhere would be decoration.
        expectRefusal(envWith({ DATABASE_URL: databaseUrl }), 'ambiguous_database_url');
    });

    it('never puts the password, the user or the URL in a refusal message', () => {
        const urls = [
            secretUrl('db.prod.example.com', 'app_test'),
            secretUrl('127.0.0.1', 'state_of_health'),
            `postgresql://soh:${SECRET_PASSWORD}@127.0.0.1:5433/soh_test?host=db.prod.example.com`,
        ];

        for (const databaseUrl of urls) {
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
        }
    });

    it('checks all three conditions, reporting NODE_ENV first when several fail', () => {
        // Order is part of the contract: the cheapest, least ambiguous
        // condition is reported, so an operator fixes one thing at a time
        // instead of chasing a URL problem that was not the first fault.
        const refusal = expectRefusal(
            { NODE_ENV: 'development', DATABASE_URL: secretUrl('db.prod.example.com', 'state_of_health') },
            'node_env_not_test',
        );
        expect(refusal.message).not.toContain('state_of_health');
    });
});

describe('FEATURE_TABLES', () => {
    it('covers the sixteen feature tables, the three diary tables and the five legacy tables', () => {
        expect(FEATURE_TABLES).toHaveLength(24);
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

/**
 * The out-of-process proof.
 *
 * The child runs `jestSetup.ts` itself — the real file, through
 * `ts-node/register/transpile-only` — with two `--require` hooks in front of
 * it. Transpile-only is deliberate: it keeps the child's failure attributable
 * to the guard rather than to a type error, which is why the assertions below
 * are on the guard's own condition rather than merely on a non-zero exit.
 *
 * The instrumentation patches `Module._load` (recording any load of
 * `@prisma/client`, the generated client or `pg`) and
 * `net.Socket.prototype.connect` (recording any connect attempt), and writes a
 * marker line to stderr for each. A passing case therefore shows the guard's
 * message and NO markers.
 */
describe('the guard, proven from outside the process it protects', () => {
    const MODULE_MARKER = 'DB_MODULE_LOADED:';
    const CONNECT_MARKER = 'SOCKET_CONNECT_ATTEMPTED';

    let hookDirectory: string;
    let hookPath: string;
    let controlPath: string;

    beforeAll(() => {
        // Outside the checkout, by construction: a repository is not a scratch
        // space, and a stray fixture inside `src/` would join the test match.
        hookDirectory = mkdtempSync(join(tmpdir(), 'soh-testdb-guard-'));
        hookPath = join(hookDirectory, 'record-db-access.js');
        controlPath = join(hookDirectory, 'instrument-control.js');

        writeFileSync(
            hookPath,
            `'use strict';
const Module = require('module');
const net = require('net');
const WATCHED = /@prisma[\\\\/]client|generated[\\\\/]prisma|^pg$|[\\\\/]pg[\\\\/]|[\\\\/]pg$/;
const originalLoad = Module._load;
Module._load = function (request) {
    if (typeof request === 'string' && WATCHED.test(request)) {
        process.stderr.write('${MODULE_MARKER}' + request + '\\n');
    }
    return originalLoad.apply(this, arguments);
};
const originalConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function () {
    process.stderr.write('${CONNECT_MARKER}\\n');
    return originalConnect.apply(this, arguments);
};
`,
        );

        writeFileSync(
            controlPath,
            `'use strict';
require(process.argv[2]);
const net = require('net');
const socket = net.connect({ host: '127.0.0.1', port: 1 });
socket.on('error', () => {});
socket.destroy();
`,
        );
    });

    afterAll(() => {
        rmSync(hookDirectory, { recursive: true, force: true });
    });

    const runChildWith = (env: NodeJS.ProcessEnv) =>
        spawnSync(
            process.execPath,
            [
                '--require',
                hookPath,
                '--require',
                'ts-node/register/transpile-only',
                join('src', '__tests__', 'setup', 'jestSetup.ts'),
            ],
            {
                cwd: BACKEND_ROOT,
                encoding: 'utf8',
                timeout: 60_000,
                // A deliberately minimal environment: inheriting this process's
                // would hand the child the safe DATABASE_URL the suite runs
                // under and prove nothing.
                env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
            },
        );

    it(
        'records a database module load and a connect when they do happen (instrument control)',
        () => {
            // Without this, a silent child would be indistinguishable from a
            // broken instrument — the assertions below would pass even if the
            // hooks recorded nothing at all.
            const control = spawnSync(
                process.execPath,
                ['--require', hookPath, controlPath, join(BACKEND_ROOT, 'src', 'generated', 'prisma')],
                { cwd: BACKEND_ROOT, encoding: 'utf8', timeout: 60_000, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
            );

            expect(control.status).toBe(0);
            expect(control.stderr).toContain(MODULE_MARKER);
            expect(control.stderr).toContain(CONNECT_MARKER);
        },
        60_000,
    );

    it.each([
        [
            'a production-shaped URL on an unroutable host with NODE_ENV=test',
            {
                NODE_ENV: 'test',
                ALLOW_DB_TRUNCATE: 'true',
                DATABASE_URL: `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@unroutable.invalid:5433/state_of_health`,
            },
            'database_host_not_local',
        ],
        [
            'the local development database',
            {
                NODE_ENV: 'test',
                ALLOW_DB_TRUNCATE: 'true',
                DATABASE_URL: `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@127.0.0.1:5433/soh_dev_46`,
            },
            'database_name_not_test',
        ],
        [
            'NODE_ENV=development with an otherwise valid test URL',
            {
                NODE_ENV: 'development',
                ALLOW_DB_TRUNCATE: 'true',
                DATABASE_URL: `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@127.0.0.1:5433/soh_test_46`,
            },
            'node_env_not_test',
        ],
        [
            'ALLOW_DB_TRUNCATE unset',
            {
                NODE_ENV: 'test',
                DATABASE_URL: `postgresql://${SECRET_USER}:${SECRET_PASSWORD}@127.0.0.1:5433/soh_test_46`,
            },
            'truncate_not_allowed',
        ],
    ])(
        'aborts the run for %s before any database module loads or any socket connects',
        (_case, env, code) => {
            const child = runChildWith(env as NodeJS.ProcessEnv);

            expect(child.error).toBeUndefined();
            expect(child.status).not.toBe(0);
            expect(child.status).toBe(1);
            expect(child.stderr).toContain('TestDatabaseGuardError');
            expect(child.stderr).toContain(code);
            // Nothing that could reach a database was even loaded, and nothing
            // dialled out. The unroutable host in the first case is what makes
            // this meaningful: a connect attempt there would hang rather than
            // quietly succeed, so silence here is the guard's, not luck's.
            expect(child.stderr).not.toContain(MODULE_MARKER);
            expect(child.stderr).not.toContain(CONNECT_MARKER);
            expect(child.stderr).not.toContain(SECRET_PASSWORD);
            expect(child.stderr).not.toContain(SECRET_USER);
            expect(child.stdout).toBe('');
        },
        60_000,
    );
});

describe('truncateFeatureTables', () => {
    beforeAll(async () => {
        await truncateFeatureTables();
    });

    afterAll(async () => {
        await truncateFeatureTables();
    });

    it('empties the rows the factories create, leaving both tables readable', async () => {
        const user = await makeUser();
        const food = await makeCatalogFood();

        const createdUser = await prisma.users.findUnique({ where: { id: user.id } });
        const createdFood = await prisma.catalog_foods.findUnique({ where: { id: food.id } });

        expect(createdUser?.email).toBe(user.email);
        expect(createdFood?.publication_status).toBe('published');
        expect(createdFood?.nutrition_provenance).toBe('source_backed');
        // The list columns the migration makes NOT NULL: an omitted list must
        // read back as the empty set, never as null.
        expect(createdFood?.allergen_tags).toEqual([]);

        await truncateFeatureTables();

        expect(await prisma.users.count()).toBe(0);
        expect(await prisma.catalog_foods.count()).toBe(0);
    });

    it('is idempotent, so a suite may call it in both beforeAll and afterAll', async () => {
        await truncateFeatureTables();
        await expect(truncateFeatureTables()).resolves.toBeUndefined();

        expect(await prisma.meal_plans.count()).toBe(0);
        expect(await prisma.recipe_versions.count()).toBe(0);
    });

    it('refuses to truncate when the ambient environment stops being a test one', async () => {
        const previous = process.env.ALLOW_DB_TRUNCATE;
        delete process.env.ALLOW_DB_TRUNCATE;

        try {
            await expect(truncateFeatureTables()).rejects.toBeInstanceOf(TestDatabaseGuardError);
        } finally {
            process.env.ALLOW_DB_TRUNCATE = previous;
        }

        // And the guard did not leave the environment or the connection broken.
        await expect(truncateFeatureTables()).resolves.toBeUndefined();
    });
});

describe('testApp', () => {
    afterAll(async () => {
        await truncateFeatureTables();
        await disconnectTestDatabase();
    });

    it('reaches the unauthenticated health endpoint', async () => {
        const response = await request.get('/health');

        expect(response.status).toBe(200);
        expect(response.body.status).toBe('ok');
    });

    it('answers 401 with the shipped body when no identity header is sent', async () => {
        const response = await request.get('/api/weigh-ins');

        expect(response.status).toBe(401);
        expect(response.body).toEqual({ error: 'No token provided' });
    });

    it("propagates the header identity as the request's user", async () => {
        const user = await makeUser();
        await prisma.body_weight_entries.create({
            data: { user_id: user.id, weight: 81.5, logged_at: new Date('2026-01-05T07:00:00.000Z') },
        });

        const response = await asUser(request.get('/api/weigh-ins'), {
            uid: user.id,
            email: user.email,
        });

        // Not merely "not 401": the row comes back only if the uid from the
        // header reached `getUserId(req)` and scoped the query, which is the
        // whole contract of the auth mock in `jestSetup.ts`.
        expect(response.status).toBe(200);
        expect(response.body.weighIns).toHaveLength(1);
        expect(response.body.weighIns[0].weight).toBe(81.5);
    });

    it('scopes a request to its own user, so another uid sees nothing', async () => {
        const response = await asUser(request.get('/api/weigh-ins'), { uid: 'test-user-0000000002' });

        expect(response.status).toBe(200);
        expect(response.body.weighIns).toEqual([]);
    });

    it('exports the header names the setup mock reads', () => {
        expect(TEST_USER_ID_HEADER).toBe('x-test-user-id');
        expect(TEST_EMAIL_HEADER).toBe('x-test-email');
    });
});
