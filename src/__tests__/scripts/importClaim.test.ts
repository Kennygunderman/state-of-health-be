/**
 * The cross-host importer claim, proven against a real PostgreSQL server.
 *
 * `scripts/lib/importClaim.ts` promises one thing that cannot be established
 * without a database and a second process: at most one importer per scope, for
 * as long as the claiming process lives, across hosts. An in-process test of a
 * mocked driver would prove only that the module calls the functions it calls.
 * So this suite takes real advisory locks on the database `DATABASE_URL` names
 * — the harness has already guaranteed that is a `_test` database
 * (`src/__tests__/setup/testDb.ts`) — and the decisive case spawns a CHILD that
 * holds the claim, because "the lock outlives this module and dies with the
 * process" is only observable across a process boundary.
 *
 * Nothing here needs a table, a migration or a truncation: advisory locks live
 * in the lock manager, not in a schema. Two things are load-bearing instead:
 *
 *   * every scope is suffixed with this run's pid and a random token, so a
 *     sibling suite running against the same database at the same time cannot
 *     collide with it — the locks are server-wide, and a fixed scope name would
 *     make two concurrent runs refuse each other;
 *   * every claim taken is tracked and released in `afterEach`, so a failing
 *     assertion cannot leave a lock (or an open `pg` connection, which would
 *     hang Jest) held for the rest of the run.
 */

import { randomBytes } from 'node:crypto';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
    DEFAULT_CLAIM_POLL_INTERVAL_MS,
    DEFAULT_USDA_IMPORT_CLAIM_SCOPE,
    IMPORT_CLAIM_LOCK_HELD_SQL,
    IMPORT_CLAIM_LOCK_NAMESPACE,
    ImportClaimError,
    type UsdaImportClaim,
    claimUsdaImport,
    getImportClaimConnectionString,
    usdaImportClaimLockKey,
    withUsdaImportClaim,
} from '../../../scripts/lib/importClaim';
import type { LogFields, ScriptLogger } from '../../../scripts/lib/logger';
import { DEFAULT_USDA_RATE_LEDGER_SCOPE } from '../../../scripts/lib/rateLimiter';

// --------------------------------------------------------------------------
// The same narrow typed surface over node-postgres the module declares, for the
// same reason (`pg` ships no types and @types/pg is deliberately not added) and
// following the same precedent as `src/__tests__/api/compat.test.ts`. The suite
// needs its own client so it can observe the server's lock catalogue from a
// session the module does not own.
// --------------------------------------------------------------------------

interface PgQueryResult<TRow> {
    rows: TRow[];
}

interface PgClient {
    connect(): Promise<void>;
    query<TRow = Record<string, unknown>>(text: string, values?: readonly unknown[]): Promise<PgQueryResult<TRow>>;
    end(): Promise<void>;
    on(event: 'error', listener: (error: Error) => void): void;
}

interface PgModule {
    Client: new (config: { connectionString: string; application_name: string }) => PgClient;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pg = require('pg') as PgModule;

const BACKEND_ROOT = join(__dirname, '..', '..', '..');
const TEST_TSCONFIG = join(BACKEND_ROOT, 'tsconfig.test.json');
const CLAIM_MODULE = join(BACKEND_ROOT, 'scripts', 'lib', 'importClaim.ts');

/** Long enough for a `ts-node` cold start plus a connection, on any runner. */
const CHILD_TIMEOUT_MS = 60_000;

/** A password no environment uses, so "it does not appear" is a real assertion. */
const SYNTHETIC_PASSWORD = 'hunter2-never-in-any-message';
const SYNTHETIC_USER = 'claimprobe';

/** Port 1 refuses immediately; nothing listens there and nothing may. */
const REFUSING_CONNECTION_STRING = `postgresql://${SYNTHETIC_USER}:${SYNTHETIC_PASSWORD}@127.0.0.1:1/soh_test`;

/** RFC 5737 documentation address: routable nowhere, so a connect can only time out. */
const UNROUTABLE_CONNECTION_STRING = `postgresql://${SYNTHETIC_USER}:${SYNTHETIC_PASSWORD}@192.0.2.1:5432/soh_test`;

const connectionString = getImportClaimConnectionString();

// Unique per run: the lock space belongs to the server, so two concurrent runs
// of this suite (or of a sibling suite on the same database) must not be able to
// pick the same scope.
const RUN_TOKEN = `${process.pid}-${randomBytes(6).toString('hex')}`;

const scopeFor = (label: string): string => `soh-import-claim-test:${label}:${RUN_TOKEN}`;

interface RecordedLog {
    level: 'debug' | 'info' | 'warn' | 'error';
    event: string;
    fields: LogFields;
}

const createRecordingLogger = (recorded: RecordedLog[]): ScriptLogger => {
    const record =
        (level: RecordedLog['level']) =>
        (event: string, fields?: LogFields): void => {
            recorded.push({ level, event, fields: fields ?? {} });
        };

    return {
        debug: record('debug'),
        info: record('info'),
        warn: record('warn'),
        error: record('error'),
        child: (): ScriptLogger => createRecordingLogger(recorded),
    };
};

/** Everything the module logged, as one string, for "this text appears nowhere" checks. */
const renderLogs = (recorded: readonly RecordedLog[]): string =>
    recorded.map((entry) => `${entry.level} ${entry.event} ${JSON.stringify(entry.fields)}`).join('\n');

/** Claims taken by the test currently running, released in `afterEach` whatever happens. */
let heldClaims: UsdaImportClaim[] = [];

const claim = async (options: Parameters<typeof claimUsdaImport>[0]): Promise<UsdaImportClaim> => {
    const taken = await claimUsdaImport(options);
    heldClaims.push(taken);

    return taken;
};

/** Asserts the refusal is the module's typed error and hands it back for further checks. */
const expectClaimError = async (
    run: () => Promise<unknown>,
    code: ImportClaimError['code'],
): Promise<ImportClaimError> => {
    let thrown: unknown;

    try {
        await run();
    } catch (error) {
        thrown = error;
    }

    expect(thrown).toBeInstanceOf(ImportClaimError);

    const refusal = thrown as ImportClaimError;
    expect(refusal.name).toBe('ImportClaimError');
    expect(refusal.code).toBe(code);

    return refusal;
};

let observer: PgClient;

beforeAll(async () => {
    observer = new pg.Client({ connectionString, application_name: 'importClaim.test-observer' });
    observer.on('error', () => {
        // The observer is a diagnostic session. A drop would fail the assertions
        // that use it, which is the report that matters; the listener exists so
        // the drop cannot crash the runner from outside a test.
    });
    await observer.connect();
});

afterAll(async () => {
    await observer.end();
});

afterEach(async () => {
    const claims = heldClaims;
    heldClaims = [];

    // `release` is idempotent and never throws, so this cannot mask a failure;
    // it runs for every claim even if an earlier one is in an odd state.
    await Promise.all(claims.map((held) => held.release()));
});

describe('usdaImportClaimLockKey', () => {
    it('namespaces the key so it cannot collide with checkpoint.ts or the per-user request locks', () => {
        expect(usdaImportClaimLockKey('api.nal.usda.gov')).toBe('usda-import:api.nal.usda.gov');
        expect(IMPORT_CLAIM_LOCK_NAMESPACE).toBe('usda-import');
    });

    it('is keyed on the same accounting scope the hourly ledger uses for the shared key', () => {
        expect(DEFAULT_USDA_IMPORT_CLAIM_SCOPE).toBe(DEFAULT_USDA_RATE_LEDGER_SCOPE);
        expect(usdaImportClaimLockKey(DEFAULT_USDA_IMPORT_CLAIM_SCOPE)).toBe('usda-import:api.nal.usda.gov');
    });
});

describe('getImportClaimConnectionString', () => {
    it('returns a present value unchanged, credential and all', () => {
        const url = `postgresql://${SYNTHETIC_USER}:${SYNTHETIC_PASSWORD}@db.internal:5432/soh_dev`;

        expect(getImportClaimConnectionString({ DATABASE_URL: url })).toBe(url);
    });

    it('returns the value this suite is running against', () => {
        expect(typeof connectionString).toBe('string');
        expect(connectionString.length).toBeGreaterThan(0);
    });

    it.each([
        { scenario: 'absent', env: {} as NodeJS.ProcessEnv },
        { scenario: 'blank', env: { DATABASE_URL: '' } as NodeJS.ProcessEnv },
        { scenario: 'whitespace only', env: { DATABASE_URL: '   \t ' } as NodeJS.ProcessEnv },
    ])('throws the typed error when DATABASE_URL is $scenario', async ({ env }) => {
        const refusal = await expectClaimError(
            async () => getImportClaimConnectionString(env),
            'missing_connection_string',
        );

        expect(refusal.message).toContain('DATABASE_URL');
        expect(refusal.scope).toBe(DEFAULT_USDA_IMPORT_CLAIM_SCOPE);
        expect(refusal.lockKey).toBe(usdaImportClaimLockKey(DEFAULT_USDA_IMPORT_CLAIM_SCOPE));
    });
});

describe('one claim per scope', () => {
    it('grants the first claimant and reports the session holding it', async () => {
        const scope = scopeFor('exclusive');
        const first = await claim({ connectionString, scope });

        expect(first.scope).toBe(scope);
        expect(first.lockKey).toBe(usdaImportClaimLockKey(scope));
        expect(first.backendPid).toBeGreaterThan(0);
        expect(first.isHeld()).toBe(true);
        expect(() => first.assertHeld()).not.toThrow();
    });

    it('refuses a second claim for the same scope while the first is held, and names the scope', async () => {
        const scope = scopeFor('refusal');
        await claim({ connectionString, scope });

        const refusal = await expectClaimError(
            async () => claim({ connectionString, scope }),
            'held_by_another_importer',
        );

        expect(refusal.scope).toBe(scope);
        expect(refusal.lockKey).toBe(usdaImportClaimLockKey(scope));
        expect(refusal.message).toContain(scope);
        expect(refusal.message).toContain(usdaImportClaimLockKey(scope));
    });

    it('grants the same scope again after release, on a new session', async () => {
        const scope = scopeFor('re-claim');
        const first = await claim({ connectionString, scope });
        const firstPid = first.backendPid;

        await first.release();

        expect(first.isHeld()).toBe(false);

        const second = await claim({ connectionString, scope });

        expect(second.isHeld()).toBe(true);
        expect(second.backendPid).not.toBe(firstPid);
    });

    it('releases idempotently and then refuses to vouch for the claim', async () => {
        const scope = scopeFor('idempotent-release');
        const held = await claim({ connectionString, scope });

        await held.release();
        await held.release();
        await Promise.all([held.release(), held.release()]);

        expect(held.isHeld()).toBe(false);

        const refusal = await expectClaimError(async () => {
            held.assertHeld();
        }, 'claim_connection_lost');

        expect(refusal.scope).toBe(scope);

        // And the release really did release: the scope is claimable again.
        const next = await claim({ connectionString, scope });
        expect(next.isHeld()).toBe(true);
    });

    it('does not serialise two different scopes against each other', async () => {
        const first = await claim({ connectionString, scope: scopeFor('scope-a') });
        const second = await claim({ connectionString, scope: scopeFor('scope-b') });

        expect(first.isHeld()).toBe(true);
        expect(second.isHeld()).toBe(true);
        expect(second.backendPid).not.toBe(first.backendPid);
    });
});

describe('IMPORT_CLAIM_LOCK_HELD_SQL', () => {
    // The claim reports success only when this query confirms the lock, so a
    // wrong mask or a wrong objsubid in it would make every claim refuse. It is
    // asserted directly, in both directions, from a session the module does not
    // own.
    const lockHeldBy = async (client: PgClient, lockKey: string): Promise<boolean> => {
        const result = await client.query<{ backend_pid: number; held: boolean }>(IMPORT_CLAIM_LOCK_HELD_SQL, [
            lockKey,
        ]);

        expect(result.rows).toHaveLength(1);
        expect(result.rows[0].backend_pid).toBeGreaterThan(0);

        return result.rows[0].held;
    };

    it('reports a lock this session holds, and stops reporting it once unlocked', async () => {
        const lockKey = usdaImportClaimLockKey(scopeFor('sql-own-session'));

        expect(await lockHeldBy(observer, lockKey)).toBe(false);

        const granted = await observer.query<{ granted: boolean }>(
            'SELECT pg_try_advisory_lock(hashtext($1)) AS granted',
            [lockKey],
        );
        expect(granted.rows[0].granted).toBe(true);

        expect(await lockHeldBy(observer, lockKey)).toBe(true);

        await observer.query('SELECT pg_advisory_unlock(hashtext($1))', [lockKey]);

        expect(await lockHeldBy(observer, lockKey)).toBe(false);
    });

    it('does not report a lock another session holds, so the check is session-scoped', async () => {
        const scope = scopeFor('sql-other-session');
        const held = await claim({ connectionString, scope });

        expect(held.isHeld()).toBe(true);
        expect(await lockHeldBy(observer, held.lockKey)).toBe(false);
    });
});

describe('withUsdaImportClaim', () => {
    it('runs the work under the claim, returns its value and releases afterwards', async () => {
        const scope = scopeFor('scoped-success');
        let observedInside: { held: boolean; scope: string } | null = null;

        const result = await withUsdaImportClaim({ connectionString, scope }, async (held) => {
            observedInside = { held: held.isHeld(), scope: held.scope };

            // While the work runs, a second importer is refused.
            await expectClaimError(async () => claim({ connectionString, scope }), 'held_by_another_importer');

            return 'imported';
        });

        expect(result).toBe('imported');
        expect(observedInside).toEqual({ held: true, scope });

        // Released: the scope is claimable again.
        const after = await claim({ connectionString, scope });
        expect(after.isHeld()).toBe(true);
    });

    it('releases on a thrown error and propagates the work’s own error unchanged', async () => {
        const scope = scopeFor('scoped-failure');
        const failure = new Error('the import failed for its own reasons');

        await expect(
            withUsdaImportClaim({ connectionString, scope }, async () => {
                throw failure;
            }),
        ).rejects.toBe(failure);

        const after = await claim({ connectionString, scope });
        expect(after.isHeld()).toBe(true);
    });
});

describe('the bounded wait', () => {
    it('is granted once the holder releases inside the window', async () => {
        const scope = scopeFor('wait-granted');
        const holder = await claim({ connectionString, scope });

        // A fake clock driven by the injected sleep, so the window is exercised
        // without spending real time. The holder releases part-way through it,
        // which is the event the wait exists to catch.
        let clockMs = 1_000;
        const slept: number[] = [];
        const sleep = async (ms: number): Promise<void> => {
            slept.push(ms);
            clockMs += ms;

            if (clockMs >= 1_300) {
                await holder.release();
            }
        };

        const waiter = await claim({
            connectionString,
            scope,
            waitMs: 2_000,
            pollIntervalMs: 100,
            sleep,
            now: () => clockMs,
        });

        expect(waiter.isHeld()).toBe(true);
        expect(slept.length).toBeGreaterThan(0);
        expect(Math.max(...slept)).toBeLessThanOrEqual(100);
    });

    it('refuses when the holder does not release, after a bounded number of polls', async () => {
        const scope = scopeFor('wait-refused');
        await claim({ connectionString, scope });

        let clockMs = 0;
        const slept: number[] = [];
        const sleep = async (ms: number): Promise<void> => {
            slept.push(ms);
            clockMs += ms;
        };

        const refusal = await expectClaimError(
            async () =>
                claim({
                    connectionString,
                    scope,
                    waitMs: 1_000,
                    pollIntervalMs: 100,
                    sleep,
                    now: () => clockMs,
                }),
            'held_by_another_importer',
        );

        expect(refusal.message).toContain('after waiting 1000ms');
        expect(slept).toHaveLength(10);
        expect(clockMs).toBe(1_000);
    });

    it('does not spin when an injected clock never advances', async () => {
        const scope = scopeFor('wait-frozen-clock');
        await claim({ connectionString, scope });

        const slept: number[] = [];
        const sleep = async (ms: number): Promise<void> => {
            slept.push(ms);
        };

        await expectClaimError(
            async () =>
                claim({
                    connectionString,
                    scope,
                    waitMs: 5_000,
                    pollIntervalMs: 1_000,
                    sleep,
                    now: () => 42,
                }),
            'held_by_another_importer',
        );

        expect(slept).toHaveLength(5);
    });

    it('polls on its documented default interval', () => {
        expect(DEFAULT_CLAIM_POLL_INTERVAL_MS).toBe(250);
    });

    it.each([
        { scenario: 'negative', waitMs: -1 },
        { scenario: 'not a number', waitMs: Number.NaN },
        { scenario: 'infinite', waitMs: Number.POSITIVE_INFINITY },
    ])('refuses a $scenario wait window before it opens a connection', async ({ waitMs }) => {
        const scope = scopeFor('wait-invalid');

        await expectClaimError(async () => claim({ connectionString, scope, waitMs }), 'invalid_wait_window');

        // Nothing was claimed, so the scope is still free.
        const held = await claim({ connectionString, scope });
        expect(held.isHeld()).toBe(true);
    });
});

describe('the scope is a name two importers must agree on', () => {
    // The hourly ledger in rateLimiter.ts keys on the trimmed, lower-cased
    // scope. A claim that accepted any other spelling would lock one name while
    // the ledger metered another, so every other spelling is refused and the
    // refusal names the one to use.
    it.each([
        { scenario: 'blank', scope: '' },
        { scenario: 'whitespace only', scope: '   ' },
        { scenario: 'padded', scope: ' api.nal.usda.gov ' },
        { scenario: 'upper-case', scope: 'API.NAL.USDA.GOV' },
        { scenario: 'mixed-case', scope: 'Api.Nal.Usda.Gov' },
    ])('refuses a $scenario scope rather than repairing it', async ({ scope }) => {
        const refusal = await expectClaimError(async () => claim({ connectionString, scope }), 'invalid_scope');

        expect(refusal.scope).toBe(scope);
    });

    it('names the ledger-normalised spelling in the refusal', async () => {
        const refusal = await expectClaimError(
            async () => claim({ connectionString, scope: ' API.NAL.USDA.GOV ' }),
            'invalid_scope',
        );

        expect(refusal.message).toContain('"api.nal.usda.gov"');
    });

    it('accepts the default scope, which is already in that form', async () => {
        const scope = scopeFor('normalised');

        expect(scope).toBe(scope.trim().toLowerCase());

        const held = await claim({ connectionString, scope });
        expect(held.isHeld()).toBe(true);
    });
});

describe('fail closed', () => {
    it('refuses rather than granting when the database cannot be reached', async () => {
        const refusal = await expectClaimError(
            async () => claim({ connectionString: REFUSING_CONNECTION_STRING, scope: scopeFor('unreachable') }),
            'database_unreachable',
        );

        expect(refusal.message).toContain('127.0.0.1');
        expect(refusal.message).toContain('ECONNREFUSED');
        expect(refusal.message).not.toContain(SYNTHETIC_PASSWORD);
    });

    it(
        'refuses within its connect timeout rather than hanging on an unroutable host',
        async () => {
            const startedAt = Date.now();

            await expectClaimError(
                async () =>
                    claim({
                        connectionString: UNROUTABLE_CONNECTION_STRING,
                        scope: scopeFor('unroutable'),
                        connectTimeoutMs: 1_500,
                    }),
                'database_unreachable',
            );

            expect(Date.now() - startedAt).toBeLessThan(15_000);
        },
        30_000,
    );

    it('refuses a blank connection string', async () => {
        const refusal = await expectClaimError(
            async () => claim({ connectionString: '   ', scope: scopeFor('blank-connection-string') }),
            'missing_connection_string',
        );

        expect(refusal.message).toContain('Refusing to import unserialised');
    });
});

describe('no credential reaches a message or a log field', () => {
    it('reports the host, the scope and the lock key, and never the connection string', async () => {
        const recorded: RecordedLog[] = [];
        const scope = scopeFor('log-hygiene-granted');

        const held = await claim({ connectionString, scope, logger: createRecordingLogger(recorded) });
        await held.release();

        const logs = renderLogs(recorded);

        expect(recorded.map((entry) => entry.event)).toEqual([
            'usda_import_claim_granted',
            'usda_import_claim_released',
        ]);
        expect(logs).toContain(scope);
        expect(logs).toContain(usdaImportClaimLockKey(scope));
        expect(logs).not.toContain(connectionString);

        for (const entry of recorded) {
            const durationField = entry.event === 'usda_import_claim_granted' ? 'waitedMs' : 'heldMs';

            expect(Object.keys(entry.fields).sort()).toEqual(
                ['backendPid', 'claimScope', 'host', 'lockKey', durationField].sort(),
            );
        }
    });

    it('keeps the password out of the refusal and out of every log field', async () => {
        const recorded: RecordedLog[] = [];
        const scope = scopeFor('log-hygiene-refused');

        const refusal = await expectClaimError(
            async () =>
                claim({
                    connectionString: REFUSING_CONNECTION_STRING,
                    scope,
                    logger: createRecordingLogger(recorded),
                }),
            'database_unreachable',
        );

        const logs = renderLogs(recorded);

        expect(refusal.message).not.toContain(SYNTHETIC_PASSWORD);
        expect(refusal.message).not.toContain(REFUSING_CONNECTION_STRING);
        expect(logs).not.toContain(SYNTHETIC_PASSWORD);
        expect(logs).not.toContain(REFUSING_CONNECTION_STRING);
    });
});

// The claim's whole promise is that it crosses a process boundary and dies with
// the process holding it. Neither half is observable in-process: a second claim
// from this process proves only that the lock is per-connection, and a claim
// this process abandons is still held by a connection this process owns. Both
// are observable in a child.
describe('the claim across a process boundary', () => {
    let childDirectory: string;
    let holderScript: string;
    let children: ChildProcessWithoutNullStreams[] = [];

    beforeAll(() => {
        childDirectory = mkdtempSync(join(tmpdir(), 'soh-import-claim-'));
        holderScript = join(childDirectory, 'hold-claim.js');

        // Plain JavaScript requiring the TypeScript module through
        // `ts-node/register`, which is how `testDb.test.ts` runs repository
        // TypeScript in a child. It claims, announces the claim on stdout, and
        // then holds it until a line arrives on stdin — at which point it exits
        // WITHOUT releasing, so what the parent observes next is PostgreSQL
        // releasing the lock with the session rather than this module unlocking.
        writeFileSync(
            holderScript,
            `'use strict';
const { claimUsdaImport } = require(${JSON.stringify(CLAIM_MODULE)});

claimUsdaImport({
    connectionString: process.env.DATABASE_URL,
    scope: process.env.SOH_CLAIM_SCOPE,
})
    .then((claim) => {
        process.stdout.write('claimed ' + claim.backendPid + '\\n');
        process.stdin.on('data', () => {
            process.exit(0);
        });
        process.stdin.resume();
    })
    .catch((error) => {
        process.stderr.write('refused ' + (error && error.code ? error.code : 'unknown') + '\\n');
        process.exit(1);
    });
`,
        );
    });

    afterAll(() => {
        rmSync(childDirectory, { recursive: true, force: true });
    });

    afterEach(async () => {
        const spawned = children;
        children = [];

        await Promise.all(
            spawned.map(
                (child) =>
                    new Promise<void>((resolve) => {
                        if (child.exitCode !== null || child.signalCode !== null) {
                            resolve();
                            return;
                        }

                        child.once('exit', () => resolve());
                        child.kill('SIGKILL');
                    }),
            ),
        );
    });

    const spawnHolder = (scope: string): ChildProcessWithoutNullStreams => {
        // `stdio` is left at its default, which is a pipe on all three streams:
        // that is the overload whose type guarantees the streams are non-null,
        // and the suite talks to all three.
        const child = spawn(process.execPath, ['--require', 'ts-node/register', holderScript], {
            cwd: BACKEND_ROOT,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                TS_NODE_PROJECT: TEST_TSCONFIG,
                TS_NODE_TRANSPILE_ONLY: '1',
                DATABASE_URL: connectionString,
                SOH_CLAIM_SCOPE: scope,
            },
        });

        // A child that has already exited turns a write into an EPIPE on this
        // stream, and an unhandled one would fail the run from outside any test.
        child.stdin.on('error', () => undefined);

        children.push(child);

        return child;
    };

    /** Resolves with the child's `claimed <pid>` line, or fails with what it printed instead. */
    const awaitClaimed = (child: ChildProcessWithoutNullStreams): Promise<string> =>
        new Promise<string>((resolve, reject) => {
            let stdout = '';
            let stderr = '';

            const timer = setTimeout(() => {
                reject(new Error(`the holder child never claimed (stdout: ${stdout}, stderr: ${stderr})`));
            }, CHILD_TIMEOUT_MS);

            child.stdout.setEncoding('utf8');
            child.stderr.setEncoding('utf8');

            child.stdout.on('data', (chunk: string) => {
                stdout += chunk;

                if (stdout.includes('\n')) {
                    clearTimeout(timer);
                    resolve(stdout.trim());
                }
            });

            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });

            child.once('exit', (code, signal) => {
                clearTimeout(timer);
                reject(
                    new Error(
                        `the holder child exited before claiming (code ${code}, signal ${signal}, ` +
                            `stdout: ${stdout}, stderr: ${stderr})`,
                    ),
                );
            });
        });

    const awaitExit = (child: ChildProcessWithoutNullStreams): Promise<void> =>
        new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
                resolve();
                return;
            }

            child.once('exit', () => resolve());
        });

    it(
        'is refused while another process holds it, and granted once that process exits',
        async () => {
            const scope = scopeFor('cross-process-exit');
            const child = spawnHolder(scope);
            const announced = await awaitClaimed(child);

            expect(announced).toMatch(/^claimed \d+$/);

            const refusal = await expectClaimError(
                async () => claim({ connectionString, scope }),
                'held_by_another_importer',
            );
            expect(refusal.scope).toBe(scope);

            // Tell it to exit. It does not release, so what frees the lock is the
            // session ending with the process.
            child.stdin.write('exit\n');
            await awaitExit(child);

            const held = await claim({ connectionString, scope, waitMs: 20_000, pollIntervalMs: 100 });
            expect(held.isHeld()).toBe(true);
            expect(held.scope).toBe(scope);
        },
        CHILD_TIMEOUT_MS,
    );

    it(
        'is released when the holding process is killed outright',
        async () => {
            const scope = scopeFor('cross-process-kill');
            const child = spawnHolder(scope);

            expect(await awaitClaimed(child)).toMatch(/^claimed \d+$/);

            await expectClaimError(async () => claim({ connectionString, scope }), 'held_by_another_importer');

            child.kill('SIGKILL');
            await awaitExit(child);

            const held = await claim({ connectionString, scope, waitMs: 20_000, pollIntervalMs: 100 });
            expect(held.isHeld()).toBe(true);
        },
        CHILD_TIMEOUT_MS,
    );

    it(
        'refuses the child while this process holds the claim, so the exclusion runs both ways',
        async () => {
            const scope = scopeFor('cross-process-parent-first');
            await claim({ connectionString, scope });

            const child = spawnHolder(scope);
            let stderr = '';
            child.stderr.setEncoding('utf8');
            child.stderr.on('data', (chunk: string) => {
                stderr += chunk;
            });

            const exitCode = await new Promise<number | null>((resolve) => {
                const timer = setTimeout(() => resolve(null), CHILD_TIMEOUT_MS);
                child.once('exit', (code) => {
                    clearTimeout(timer);
                    resolve(code);
                });
            });

            expect(exitCode).toBe(1);
            expect(stderr).toContain('refused held_by_another_importer');
        },
        CHILD_TIMEOUT_MS,
    );
});
