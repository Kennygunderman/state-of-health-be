// What this suite is for.
//
// `scripts/lib/rateLimiter.ts` holds the catalog importer to 900 USDA requests
// per hour so the 100/hour the running API needs on the SAME key survives
// (AAP §0.7.1). That ceiling is only real if it spans processes: the importer
// is a multi-hour run that is expected to be interrupted and resumed, and
// `checkpoint.ts` deliberately allows two launches of one stage to work
// through the same run. A ledger that lived in a closure would hand each of
// those a fresh 900, so the two cases below are the point of this file — a
// RESTART inside the hour, and TWO CONCURRENT IMPORTERS, both proved to keep
// the aggregate at or below the configured rate, the second of them across
// real operating-system processes.
//
// Each of those two is proved TWICE: once with an explicit shared
// `stateFilePath`, which proves the mechanism, and once in DEFAULT
// configuration — no injected ledger, no state path, differing working
// directories — which is what proves that two importers launched
// independently end up on one ledger at all. The default path is the thing
// that decides that, so it is tested as the configuration an operator runs
// rather than as a string.
//
// Everything else here is the fail-closed posture (state that cannot be
// trusted, or a critical section that was not exclusive, stops the import
// instead of admitting an attempt it failed to record), the atomicity of the
// on-disk state, and regression cover for the module behaviour eight CLI
// scripts already depend on.
//
// No network, no database and no real waiting: the clock and `sleep` are
// injected everywhere, so an hour of pacing costs microseconds. Every test
// given a state path writes inside a per-test temporary directory that is
// removed afterwards; the default-configuration tests write into the
// host-scoped default directory, which they share with every other process on
// the machine, so each of them uses a scope unique to this run and removes
// its own files (see 'the default configuration' and 'the suite itself').

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

import type { ScriptLogger } from '../../../scripts/lib/logger';
import {
    DEFAULT_BURST_CAPACITY,
    DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR,
    DEFAULT_USDA_RATE_LEDGER_SCOPE,
    RATE_WINDOW_MS,
    RateLimitConfigError,
    USDA_HOST,
    USDA_RATE_LEDGER_STATE_VERSION,
    USDA_VENDOR_CAP_PER_HOUR,
    UsdaRateLedgerError,
    createFileUsdaRateLedger,
    createProcessLocalUsdaRateLedger,
    createUsdaRateLimiter,
    defaultUsdaRateLedgerDirectory,
    defaultUsdaRateLedgerStateFilePath,
    getUsdaImportRateLimitPerHour,
    isUsdaRequestUrl,
    ledgerLockOwnership,
    pruneAttemptWindow,
    recordAttemptWindow,
    refillBucket,
    waitMsForToken,
    windowWaitMs,
    type UsdaRateLedger,
    type UsdaRateLimiter,
    type UsdaRateReservation,
} from '../../../scripts/lib/rateLimiter';

const BACKEND_ROOT = path.join(__dirname, '..', '..', '..');
const RATE_LIMITER_MODULE = path.join(BACKEND_ROOT, 'scripts', 'lib', 'rateLimiter.ts');
const SCRIPTS_TSCONFIG = path.join(BACKEND_ROOT, 'tsconfig.scripts.json');
// Absolute, not the bare `ts-node/register` specifier: Node resolves a bare
// `--require` id against the CHILD'S WORKING DIRECTORY, and the tests below
// deliberately launch children from directories outside the checkout.
const TS_NODE_REGISTER = path.join(BACKEND_ROOT, 'node_modules', 'ts-node', 'register');

const CHILD_TIMEOUT_MS = 90_000;

interface ChildOutcome {
    status: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Runs one child Node process over the TypeScript module under test.
 *
 * `cwd` is a parameter because it is the subject of two of the tests: the
 * default ledger path must be the same for every importer on the host however
 * each of them was launched.
 *
 * `TMPDIR` is forwarded when the parent has one, so parent and child agree on
 * `os.tmpdir()` — the root the default ledger directory hangs off.
 */
const runChildProcess = (
    scriptPath: string,
    args: readonly string[],
    cwd: string,
): Promise<ChildOutcome> =>
    new Promise((resolve, reject) => {
        const child = spawn(process.execPath, ['--require', TS_NODE_REGISTER, scriptPath, ...args], {
            cwd,
            timeout: CHILD_TIMEOUT_MS,
            env: {
                PATH: process.env.PATH,
                HOME: process.env.HOME,
                ...(process.env.TMPDIR === undefined ? {} : { TMPDIR: process.env.TMPDIR }),
                TS_NODE_PROJECT: SCRIPTS_TSCONFIG,
                TS_NODE_TRANSPILE_ONLY: '1',
            },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.setEncoding('utf8');
        child.stderr.setEncoding('utf8');
        child.stdout.on('data', (chunk: string) => {
            stdout += chunk;
        });
        child.stderr.on('data', (chunk: string) => {
            stderr += chunk;
        });
        child.on('error', reject);
        child.on('close', (status) => {
            resolve({ status, stdout, stderr });
        });
    });

/**
 * A scope no other process can be using. The default ledger directory is
 * HOST-scoped by design, so a test that writes there shares a directory with
 * every other checkout's suite and with any real importer on the machine; a
 * scope carrying this process's pid, the clock and a random tail is what keeps
 * those runs from being accounted against each other. Every character stays
 * inside the `[a-z0-9._-]` set the state file name preserves, so the scope is
 * recoverable from the path a test cleans up.
 */
const uniqueLedgerScope = (label: string): string =>
    `${label}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.test.invalid`;

// An arbitrary but fixed instant, so every expectation below is a plain number
// rather than something derived from the machine's clock.
const T0 = 1_700_000_000_000;

const TEST_SCOPE = 'test.usda.invalid';

interface Clock {
    read: () => number;
    advance: (ms: number) => void;
    sleep: (ms: number) => Promise<void>;
    sleeps: number[];
}

// A clock the tests own. `sleep` advances it, which is what makes an hour of
// pacing instant while keeping the module's own loop honest: it still has to
// compute a wait, and the wait it computes is what moves time.
const createClock = (startMs: number = T0): Clock => {
    let nowMs = startMs;
    const sleeps: number[] = [];

    return {
        read: (): number => nowMs,
        advance: (ms: number): void => {
            nowMs += ms;
        },
        sleep: async (ms: number): Promise<void> => {
            sleeps.push(ms);
            nowMs += ms;
        },
        sleeps,
    };
};

const instantSleep = async (): Promise<void> => undefined;

interface CapturedLog {
    event: string;
    fields: Record<string, unknown>;
}

const createRecordingLogger = (): { lines: CapturedLog[]; logger: ScriptLogger } => {
    const lines: CapturedLog[] = [];
    const record = (event: string, fields?: Record<string, unknown>): void => {
        lines.push({ event, fields: fields ?? {} });
    };

    const logger: ScriptLogger = {
        debug: record,
        info: record,
        warn: record,
        error: record,
        child: (): ScriptLogger => logger,
    };

    return { lines, logger };
};

const readStateDocument = (stateFilePath: string): { version: unknown; scope: unknown; attempts: unknown } =>
    JSON.parse(fs.readFileSync(stateFilePath, 'utf8')) as { version: unknown; scope: unknown; attempts: unknown };

const readStamps = (stateFilePath: string): number[] => {
    const document = readStateDocument(stateFilePath);

    expect(document.version).toBe(USDA_RATE_LEDGER_STATE_VERSION);
    expect(Array.isArray(document.attempts)).toBe(true);

    return document.attempts as number[];
};

const writeStateDocument = (stateFilePath: string, document: unknown): void => {
    fs.writeFileSync(stateFilePath, `${JSON.stringify(document)}\n`, 'utf8');
};

const reserveOnce = (ledger: UsdaRateLedger, nowMs: number, limit: number): Promise<UsdaRateReservation> =>
    ledger.reserve({ nowMs, limit, windowMs: RATE_WINDOW_MS });

const waitForCondition = async (
    satisfied: () => boolean,
    timeoutMs: number,
    description: string,
): Promise<void> => {
    const deadlineMs = Date.now() + timeoutMs;

    while (!satisfied()) {
        if (Date.now() > deadlineMs) {
            throw new Error(`timed out waiting for ${description}`);
        }

        await new Promise<void>((resolve) => {
            setTimeout(resolve, 20);
        });
    }
};

describe('scripts/lib/rateLimiter', () => {
    let workspace: string;

    beforeEach(() => {
        workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'soh-usda-ledger-'));
    });

    afterEach(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
    });

    const statePathFor = (name: string = 'ledger.json'): string => path.join(workspace, name);

    const fileLedgerOver = (stateFilePath: string, scope: string = TEST_SCOPE): UsdaRateLedger =>
        createFileUsdaRateLedger({ stateFilePath, scope, sleep: instantSleep, lockRetryDelayMs: 0 });

    // -----------------------------------------------------------------------
    // The two cases the review asked for.
    // -----------------------------------------------------------------------

    describe('a restart inside the rolling hour', () => {
        const RATE = 5;

        // A ledger instance per limiter is exactly what a restarted process
        // has: the same state file, a fresh in-memory view.
        const limiterOver = (
            stateFilePath: string,
            now: () => number,
            sleep: (ms: number) => Promise<void>,
        ): UsdaRateLimiter =>
            createUsdaRateLimiter({
                requestsPerHour: RATE,
                burstCapacity: RATE,
                now,
                sleep,
                ledger: fileLedgerOver(stateFilePath),
            });

        it('does not hand the restarted process a fresh hourly allowance', async () => {
            const stateFilePath = statePathFor();
            const clock = createClock();

            const before = limiterOver(stateFilePath, clock.read, clock.sleep);
            for (let index = 0; index < RATE; index += 1) {
                await before.acquire();
            }

            expect(before.stats().attempts).toBe(RATE);
            expect(before.stats().pauses).toBe(0);
            expect(before.stats().attemptsInWindow).toBe(RATE);
            expect(readStamps(stateFilePath)).toHaveLength(RATE);

            // Ten minutes of the hour have gone by when the operator restarts.
            clock.advance(600_000);

            // Refused, and the wait is the remainder of the hour measured from
            // the OLDEST stamp the previous process wrote.
            const reservation = await reserveOnce(fileLedgerOver(stateFilePath), clock.read(), RATE);

            expect(reservation.admitted).toBe(false);
            expect(reservation.attemptsInWindow).toBe(RATE);
            expect(reservation.waitMs).toBe(RATE_WINDOW_MS - 600_000);

            // Driven through `acquire`, the restarted limiter waits out exactly
            // that remainder — plus the one millisecond the inclusive far
            // boundary withholds — and then admits.
            const after = limiterOver(stateFilePath, clock.read, clock.sleep);
            await after.acquire();

            expect(clock.sleeps).toEqual([RATE_WINDOW_MS - 600_000, 1]);
            expect(after.stats().attempts).toBe(1);
            expect(after.stats().pauses).toBe(2);
            expect(clock.read()).toBe(T0 + RATE_WINDOW_MS + 1);
            // The five stamps from before the restart have aged out, so the
            // hour holds one attempt, not six.
            expect(readStamps(stateFilePath)).toEqual([T0 + RATE_WINDOW_MS + 1]);
            expect(after.stats().attemptsInWindow).toBe(1);
        });

        it('keeps the aggregate at the configured rate across three consecutive restarts', async () => {
            const stateFilePath = statePathFor();
            const clock = createClock();
            // Any pause at all is a failure here: the point is that the first
            // RATE attempts across three launches go through without waiting,
            // and that the one after them cannot.
            const refuseToWait = async (ms: number): Promise<void> => {
                throw new Error(`unexpected pause of ${ms}ms`);
            };

            let admitted = 0;

            for (let launch = 0; launch < 3; launch += 1) {
                const limiter = limiterOver(stateFilePath, clock.read, refuseToWait);

                for (let index = 0; index < 2; index += 1) {
                    if (admitted < RATE) {
                        await limiter.acquire();
                        admitted += 1;
                        continue;
                    }

                    await expect(limiter.acquire()).rejects.toThrow('unexpected pause');
                }
            }

            // Three launches, six attempts, one hour: five admitted and the
            // sixth paused. A process-local ledger would have admitted all six.
            expect(admitted).toBe(RATE);
            expect(readStamps(stateFilePath)).toHaveLength(RATE);
        });
    });

    describe('two concurrent importers', () => {
        it('admits at most the limit in aggregate from interleaved in-process ledgers', async () => {
            const stateFilePath = statePathFor();
            const limit = 4;
            const ledgers = [fileLedgerOver(stateFilePath), fileLedgerOver(stateFilePath)];

            // Twice the allowance, asked for at the same instant, alternating
            // between the two ledgers and all in flight together.
            const reservations = await Promise.all(
                Array.from({ length: limit * 2 }, (_unused, index) =>
                    reserveOnce(ledgers[index % ledgers.length] as UsdaRateLedger, T0, limit),
                ),
            );

            const admitted = reservations.filter((reservation) => reservation.admitted);

            expect(admitted).toHaveLength(limit);
            expect(readStamps(stateFilePath)).toHaveLength(limit);

            for (const refused of reservations.filter((candidate) => !candidate.admitted)) {
                // The window filled at T0, so nothing can age out before the
                // hour is up.
                expect(refused.waitMs).toBe(RATE_WINDOW_MS);
                expect(refused.attemptsInWindow).toBe(limit);
            }

            // The count each admission saw is 1..limit with no repeats: proof
            // the decision and the record were ONE step, rather than two
            // ledgers both reading the same count and both admitting.
            expect(admitted.map((reservation) => reservation.attemptsInWindow).sort((a, b) => a - b)).toEqual([
                1, 2, 3, 4,
            ]);
        });

        it(
            'admits at most the limit in aggregate across real child processes',
            async () => {
                const stateFilePath = statePathFor();
                const barrierPath = path.join(workspace, 'start');
                const readyPrefix = 'ready.';
                const limit = 6;

                const childScript = path.join(workspace, 'reserve-child.js');
                fs.writeFileSync(
                    childScript,
                    `'use strict';
const fs = require('fs');
const path = require('path');
const { createFileUsdaRateLedger } = require(${JSON.stringify(RATE_LIMITER_MODULE)});

const [statePath, scope, barrier, limit, attempts, nowMs] = process.argv.slice(2);

const ledger = createFileUsdaRateLedger({
    stateFilePath: statePath,
    scope,
    lockAttempts: 2000,
    lockRetryDelayMs: 2,
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
    fs.writeFileSync(path.join(path.dirname(barrier), '${readyPrefix}' + process.pid), '', 'utf8');

    const deadline = Date.now() + 30000;
    while (!fs.existsSync(barrier)) {
        if (Date.now() > deadline) {
            throw new Error('barrier never appeared');
        }
    }

    let admitted = 0;
    for (let index = 0; index < Number(attempts); index += 1) {
        const reservation = await ledger.reserve({
            nowMs: Number(nowMs),
            limit: Number(limit),
            windowMs: ${RATE_WINDOW_MS},
        });

        if (reservation.admitted) {
            admitted += 1;
        }

        // A gap between attempts so the two children really interleave
        // instead of one draining the allowance before the other starts.
        await pause(3);
    }

    process.stdout.write(JSON.stringify({ admitted }));
};

main().then(
    () => process.exit(0),
    (error) => {
        process.stderr.write(String(error && error.message));
        process.exit(1);
    },
);
`,
                    'utf8',
                );

                const runChild = (): Promise<ChildOutcome> =>
                    runChildProcess(
                        childScript,
                        [stateFilePath, TEST_SCOPE, barrierPath, `${limit}`, `${limit}`, `${T0}`],
                        BACKEND_ROOT,
                    );

                const children = [runChild(), runChild()];

                // Released only once BOTH children are booted and spinning on
                // the barrier, so their reservations really do overlap rather
                // than running in sequence.
                await waitForCondition(
                    () => fs.readdirSync(workspace).filter((entry) => entry.startsWith(readyPrefix)).length === 2,
                    CHILD_TIMEOUT_MS / 2,
                    'both children to signal readiness',
                );
                fs.writeFileSync(barrierPath, 'go', 'utf8');

                const [first, second] = await Promise.all(children);

                expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: '' });
                expect({ status: second.status, stderr: second.stderr }).toEqual({ status: 0, stderr: '' });

                const firstAdmitted = (JSON.parse(first.stdout) as { admitted: number }).admitted;
                const secondAdmitted = (JSON.parse(second.stdout) as { admitted: number }).admitted;

                // The whole point: two processes, one hour, one allowance
                // between them, each having asked for all of it. How the limit
                // splits between them is the scheduler's business and is
                // deliberately not asserted; the total is what the vendor sees.
                expect(firstAdmitted + secondAdmitted).toBe(limit);
                expect(readStamps(stateFilePath)).toHaveLength(limit);

                // Nothing left behind: no lock and no half-written temp file.
                expect(
                    fs.readdirSync(workspace).filter((entry) => entry.endsWith('.lock') || entry.endsWith('.tmp')),
                ).toEqual([]);
            },
            CHILD_TIMEOUT_MS,
        );
    });

    // -----------------------------------------------------------------------
    // The same two cases again, in the configuration an operator actually
    // runs: no injected ledger, no `stateFilePath`, nothing but a rate and a
    // scope. Handing two importers one explicit path proves the mechanism; it
    // does not prove that two importers launched independently END UP on one
    // ledger, and the default path is what decides that. Every test here
    // writes into the host-scoped default directory under a scope unique to
    // this run, and removes its own files afterwards.
    // -----------------------------------------------------------------------

    describe('the default configuration', () => {
        const scopesToClean: string[] = [];

        const useUniqueScope = (label: string): string => {
            const scope = uniqueLedgerScope(label);
            scopesToClean.push(scope);

            return scope;
        };

        const defaultStatePathFor = (scope: string): string => defaultUsdaRateLedgerStateFilePath(scope);

        afterEach(() => {
            // Only this run's own files, never the directory: it is shared
            // with every other process on the host, which is the entire point
            // of the default being where it is.
            while (scopesToClean.length > 0) {
                const scope = scopesToClean.pop() as string;
                const statePath = defaultStatePathFor(scope);

                fs.rmSync(`${statePath}.lock`, { force: true });
                fs.rmSync(statePath, { force: true });
            }
        });

        it('keeps the default state file in one host-scoped directory outside every checkout', () => {
            const directory = defaultUsdaRateLedgerDirectory();
            const statePath = defaultUsdaRateLedgerStateFilePath();

            expect(directory).toBe(path.join(os.tmpdir(), 'soh-usda-rate-ledger'));
            expect(path.dirname(directory)).toBe(os.tmpdir());
            expect(path.dirname(statePath)).toBe(directory);
            expect(path.basename(statePath)).toBe(`usda-rate-ledger.${USDA_HOST}.json`);

            // Host-scoped is the requirement, because USDA's 1,000/hour
            // belongs to the KEY: two checkouts on one machine read the same
            // `USDA_API_KEY` and must therefore read the same ledger.
            expect(statePath.startsWith(`${BACKEND_ROOT}${path.sep}`)).toBe(false);
            // And install-independent: a path under `node_modules` loses the
            // hour's record to every `npm ci` or redeploy — the restart
            // boundary the durable ledger exists for.
            expect(statePath).not.toContain('node_modules');
            expect(statePath).not.toContain(path.join('scripts', 'lib'));
        });

        it('derives the same default state file path from two processes with different working directories', async () => {
            const scope = 'default.path.usda.invalid';
            const childScript = path.join(workspace, 'default-path-child.js');

            fs.writeFileSync(
                childScript,
                `'use strict';
const {
    defaultUsdaRateLedgerDirectory,
    defaultUsdaRateLedgerStateFilePath,
} = require(${JSON.stringify(RATE_LIMITER_MODULE)});

process.stdout.write(
    JSON.stringify({
        cwd: process.cwd(),
        directory: defaultUsdaRateLedgerDirectory(),
        statePath: defaultUsdaRateLedgerStateFilePath(process.argv[2]),
    }),
);
`,
                'utf8',
            );

            // One inside the checkout, one outside it and nowhere near it.
            const [insideCheckout, elsewhere] = await Promise.all([
                runChildProcess(childScript, [scope], BACKEND_ROOT),
                runChildProcess(childScript, [scope], workspace),
            ]);

            expect({ status: insideCheckout.status, stderr: insideCheckout.stderr }).toEqual({
                status: 0,
                stderr: '',
            });
            expect({ status: elsewhere.status, stderr: elsewhere.stderr }).toEqual({ status: 0, stderr: '' });

            const first = JSON.parse(insideCheckout.stdout) as { cwd: string; directory: string; statePath: string };
            const second = JSON.parse(elsewhere.stdout) as { cwd: string; directory: string; statePath: string };

            // The premise of the test: the two really did run from different
            // directories.
            expect(first.cwd).not.toBe(second.cwd);
            expect(first.directory).toBe(second.directory);
            expect(first.statePath).toBe(second.statePath);
            // And the path this process derives is the same one again, so a
            // ledger constructed anywhere accounts against the same hour.
            expect(first.statePath).toBe(defaultUsdaRateLedgerStateFilePath(scope));
        });

        it(
            'admits at most the limit in aggregate across two real processes that were given no state path',
            async () => {
                const scope = useUniqueScope('concurrent');
                const statePath = defaultStatePathFor(scope);
                const barrierPath = path.join(workspace, 'start');
                const readyPrefix = 'ready.';
                const limit = 6;

                const childScript = path.join(workspace, 'default-reserve-child.js');
                fs.writeFileSync(
                    childScript,
                    `'use strict';
const fs = require('fs');
const path = require('path');
const {
    createFileUsdaRateLedger,
    defaultUsdaRateLedgerStateFilePath,
} = require(${JSON.stringify(RATE_LIMITER_MODULE)});

const [scope, barrier, limit, attempts, nowMs] = process.argv.slice(2);

// The configuration under test: a scope and nothing else. No stateFilePath,
// so the ledger has to derive where it lives — which is the only way two
// importers launched independently land on one hour.
const ledger = createFileUsdaRateLedger({
    scope,
    lockAttempts: 2000,
    lockRetryDelayMs: 2,
});

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const main = async () => {
    fs.writeFileSync(path.join(path.dirname(barrier), '${readyPrefix}' + process.pid), '', 'utf8');

    const deadline = Date.now() + 30000;
    while (!fs.existsSync(barrier)) {
        if (Date.now() > deadline) {
            throw new Error('barrier never appeared');
        }
    }

    let admitted = 0;
    for (let index = 0; index < Number(attempts); index += 1) {
        const reservation = await ledger.reserve({
            nowMs: Number(nowMs),
            limit: Number(limit),
            windowMs: ${RATE_WINDOW_MS},
        });

        if (reservation.admitted) {
            admitted += 1;
        }

        await pause(3);
    }

    process.stdout.write(
        JSON.stringify({
            admitted,
            cwd: process.cwd(),
            statePath: defaultUsdaRateLedgerStateFilePath(scope),
        }),
    );
};

main().then(
    () => process.exit(0),
    (error) => {
        process.stderr.write(String(error && error.message));
        process.exit(1);
    },
);
`,
                    'utf8',
                );

                const args = [scope, barrierPath, `${limit}`, `${limit}`, `${T0}`];
                // Different working directories, so nothing but the module's
                // own derivation can be putting them on the same ledger.
                const children = [
                    runChildProcess(childScript, args, BACKEND_ROOT),
                    runChildProcess(childScript, args, workspace),
                ];

                await waitForCondition(
                    () => fs.readdirSync(workspace).filter((entry) => entry.startsWith(readyPrefix)).length === 2,
                    CHILD_TIMEOUT_MS / 2,
                    'both children to signal readiness',
                );
                fs.writeFileSync(barrierPath, 'go', 'utf8');

                const [first, second] = await Promise.all(children);

                expect({ status: first.status, stderr: first.stderr }).toEqual({ status: 0, stderr: '' });
                expect({ status: second.status, stderr: second.stderr }).toEqual({ status: 0, stderr: '' });

                const firstReport = JSON.parse(first.stdout) as { admitted: number; cwd: string; statePath: string };
                const secondReport = JSON.parse(second.stdout) as { admitted: number; cwd: string; statePath: string };

                expect(firstReport.cwd).not.toBe(secondReport.cwd);
                // Two processes, two working directories, one allowance
                // between them, each having asked for all of it.
                expect(firstReport.admitted + secondReport.admitted).toBeLessThanOrEqual(limit);
                expect(firstReport.admitted + secondReport.admitted).toBe(limit);

                // The ledger they shared is the host-scoped default one, and
                // it is where the stamps actually are.
                expect(firstReport.statePath).toBe(statePath);
                expect(secondReport.statePath).toBe(statePath);
                expect(path.dirname(statePath)).toBe(defaultUsdaRateLedgerDirectory());
                expect(fs.existsSync(statePath)).toBe(true);
                expect(readStamps(statePath)).toHaveLength(limit);
                expect(readStateDocument(statePath).scope).toBe(scope);
                // No lock and no half-written temp file left in a directory
                // other importers use.
                expect(
                    fs
                        .readdirSync(defaultUsdaRateLedgerDirectory())
                        .filter((entry) => entry.startsWith(path.basename(statePath)) && entry !== path.basename(statePath)),
                ).toEqual([]);
            },
            CHILD_TIMEOUT_MS,
        );

        it('does not hand a restart inside the hour a fresh allowance over the default path', async () => {
            const RATE = 3;
            const scope = useUniqueScope('restart');
            const statePath = defaultStatePathFor(scope);
            const clock = createClock();

            // `createUsdaRateLimiter` with no `ledger` and no
            // `ledgerStateFilePath`: the durable-by-default wiring, over the
            // path an operator gets.
            const before = createUsdaRateLimiter({
                requestsPerHour: RATE,
                burstCapacity: RATE,
                now: clock.read,
                sleep: clock.sleep,
                ledgerScope: scope,
            });

            for (let index = 0; index < RATE; index += 1) {
                await before.acquire();
            }

            expect(before.stats().ledgerKind).toBe('file');
            expect(before.stats().ledgerScope).toBe(scope);
            expect(before.stats().attempts).toBe(RATE);
            expect(clock.sleeps).toEqual([]);
            expect(readStamps(statePath)).toHaveLength(RATE);

            // A quarter of an hour later the operator restarts the importer.
            clock.advance(900_000);

            const pausedFor: number[] = [];
            const after = createUsdaRateLimiter({
                requestsPerHour: RATE,
                burstCapacity: RATE,
                now: clock.read,
                sleep: async (ms: number): Promise<void> => {
                    pausedFor.push(ms);
                    throw new Error('restarted importer paused');
                },
                ledgerScope: scope,
            });

            await expect(after.acquire()).rejects.toThrow('restarted importer paused');

            // Refused, and the wait is the remainder of the hour measured from
            // the oldest stamp the process before the restart wrote — not a
            // fresh 900.
            expect(pausedFor).toEqual([RATE_WINDOW_MS - 900_000]);
            expect(after.stats().attempts).toBe(0);
            expect(after.stats().attemptsInWindow).toBe(RATE);
            expect(readStamps(statePath)).toHaveLength(RATE);
            expect(fs.existsSync(`${statePath}.lock`)).toBe(false);
        });
    });

    // -----------------------------------------------------------------------
    // The ledger port and its two implementations.
    // -----------------------------------------------------------------------

    describe('the ledgers and the pure window rules', () => {
        it('reaches the same decisions the exported rules do, for both implementations', async () => {
            const limit = 3;
            const stateFilePath = statePathFor();
            const ledgers: UsdaRateLedger[] = [
                createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE }),
                fileLedgerOver(stateFilePath),
            ];

            for (const ledger of ledgers) {
                // The expectations are computed independently from the exported
                // rules, so a ledger that grew its own copy of the rolling-hour
                // arithmetic would fail here.
                let expected: number[] = [];

                for (const nowMs of [T0, T0 + 10, T0 + 20, T0 + 30, T0 + RATE_WINDOW_MS + 40]) {
                    const pruned = pruneAttemptWindow(expected, nowMs, RATE_WINDOW_MS);
                    const expectedWaitMs = windowWaitMs(pruned, nowMs, limit, RATE_WINDOW_MS);
                    const reservation = await reserveOnce(ledger, nowMs, limit);

                    expect(reservation.admitted).toBe(expectedWaitMs === 0);
                    expect(reservation.waitMs).toBe(expectedWaitMs);

                    expected = expectedWaitMs === 0 ? recordAttemptWindow(pruned, nowMs, RATE_WINDOW_MS) : pruned;

                    expect(reservation.attemptsInWindow).toBe(expected.length);
                }
            }

            // Only the last attempt is still inside the hour by the end of
            // that sequence, and the file says so.
            expect(readStamps(stateFilePath)).toEqual([T0 + RATE_WINDOW_MS + 40]);
        });

        it('reports its kind and scope', () => {
            expect(createProcessLocalUsdaRateLedger().describe()).toEqual({
                kind: 'process_local',
                scope: DEFAULT_USDA_RATE_LEDGER_SCOPE,
            });
            expect(createFileUsdaRateLedger({ stateFilePath: statePathFor(), scope: 'Shared.KEY' }).describe()).toEqual({
                kind: 'file',
                scope: 'shared.key',
            });
        });

        it('refuses a blank scope rather than pooling unrelated credentials into one ledger', () => {
            expect(() => createFileUsdaRateLedger({ scope: '   ' })).toThrow(RateLimitConfigError);
            expect(() => createProcessLocalUsdaRateLedger({ scope: '' })).toThrow(RateLimitConfigError);
        });

        it('refuses lock settings that would make every lock look fresh or every reservation fail', () => {
            const stateFilePath = statePathFor();

            expect(() => createFileUsdaRateLedger({ stateFilePath, lockStaleMs: Number.NaN })).toThrow(
                RateLimitConfigError,
            );
            expect(() => createFileUsdaRateLedger({ stateFilePath, lockAttempts: 0 })).toThrow(RateLimitConfigError);
            expect(() => createFileUsdaRateLedger({ stateFilePath, lockAttempts: 1.5 })).toThrow(RateLimitConfigError);
            expect(() => createFileUsdaRateLedger({ stateFilePath, lockRetryDelayMs: -1 })).toThrow(
                RateLimitConfigError,
            );
        });

        it('is honest about the process-local ledger not surviving a restart', async () => {
            const limit = 2;

            const first = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });
            expect((await reserveOnce(first, T0, limit)).admitted).toBe(true);
            expect((await reserveOnce(first, T0, limit)).admitted).toBe(true);
            expect((await reserveOnce(first, T0, limit)).admitted).toBe(false);

            // A second instance stands in for a second process, and it knows
            // nothing — which is precisely why the importer does not use it.
            const second = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });
            expect((await reserveOnce(second, T0, limit)).admitted).toBe(true);
        });

        it('touches the filesystem only on the first reservation', async () => {
            const stateFilePath = path.join(workspace, 'nested', 'deeper', 'ledger.json');
            const ledger = fileLedgerOver(stateFilePath);

            expect(fs.existsSync(path.dirname(stateFilePath))).toBe(false);

            await reserveOnce(ledger, T0, 1);

            expect(fs.existsSync(stateFilePath)).toBe(true);
        });

        it('keeps the state file bounded by the limit however long the run lasts', async () => {
            const stateFilePath = statePathFor();
            const limit = 3;
            const ledger = fileLedgerOver(stateFilePath);

            // Six hours of attempts, one every half hour: the window never
            // holds more than the limit and the file never grows past it.
            for (let index = 0; index < 12; index += 1) {
                const reservation = await reserveOnce(ledger, T0 + index * 1_800_000, limit);

                expect(reservation.admitted).toBe(true);
                expect(readStamps(stateFilePath).length).toBeLessThanOrEqual(limit);
            }
        });

        it('persists the pruning it does while a run is waiting out the hour', async () => {
            const stateFilePath = statePathFor();
            const ledger = fileLedgerOver(stateFilePath);

            // Three attempts under a rate of three, the first of them early
            // enough to age out before the others.
            await reserveOnce(ledger, T0, 3);
            await reserveOnce(ledger, T0 + RATE_WINDOW_MS - 2_000, 3);
            await reserveOnce(ledger, T0 + RATE_WINDOW_MS - 1_000, 3);
            expect(readStamps(stateFilePath)).toHaveLength(3);

            // The operator then lowers the rate to two and the run waits. The
            // refusal still has to persist what aged out, or a long wait would
            // leave the file holding expired entries for the rest of the run.
            const refused = await reserveOnce(ledger, T0 + RATE_WINDOW_MS + 1, 2);

            expect(refused.admitted).toBe(false);
            expect(refused.attemptsInWindow).toBe(2);
            expect(readStamps(stateFilePath)).toEqual([
                T0 + RATE_WINDOW_MS - 2_000,
                T0 + RATE_WINDOW_MS - 1_000,
            ]);
        });
    });

    // -----------------------------------------------------------------------
    // Mutual exclusion.
    // -----------------------------------------------------------------------

    describe('the state lock', () => {
        // A lock file as an abandoned holder leaves it: a token, aged past the
        // staleness threshold.
        const abandonLock = (lockFilePath: string, token: string, ageMs: number = 120_000): void => {
            fs.writeFileSync(lockFilePath, token, 'utf8');

            const abandonedAt = new Date(Date.now() - ageMs);
            fs.utimesSync(lockFilePath, abandonedAt, abandonedAt);
        };

        it('breaks a lock older than the staleness threshold instead of deadlocking the run', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            abandonLock(lockFilePath, 'usda-rate-ledger.999999.1.abandoned\n');

            const ledger = createFileUsdaRateLedger({
                stateFilePath,
                scope: TEST_SCOPE,
                lockStaleMs: 30_000,
                sleep: instantSleep,
            });

            const reservation = await reserveOnce(ledger, T0, 1);

            expect(reservation.admitted).toBe(true);
            expect(readStamps(stateFilePath)).toEqual([T0]);
            expect(fs.existsSync(lockFilePath)).toBe(false);
        });

        it('breaks a stale lock that carries no token at all', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            // What a process that died between creating the lock file and
            // stamping it leaves behind — and what an older build's lock looks
            // like. Unbreakable, it would wedge every later run for good.
            abandonLock(lockFilePath, '');

            const ledger = createFileUsdaRateLedger({
                stateFilePath,
                scope: TEST_SCOPE,
                lockStaleMs: 30_000,
                sleep: instantSleep,
            });

            expect((await reserveOnce(ledger, T0, 1)).admitted).toBe(true);
            expect(fs.existsSync(lockFilePath)).toBe(false);
        });

        it('stamps each acquisition with its own token and holds it across the critical section', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            const ledger = fileLedgerOver(stateFilePath);
            const tokensHeldDuringTheWrite: string[] = [];

            // `renameSync` is the last step inside the critical section, so
            // reading the lock file here reads what the reservation is holding.
            const actualRename = fs.renameSync;
            const rename = jest
                .spyOn(fs, 'renameSync')
                .mockImplementation((from: fs.PathLike, to: fs.PathLike): void => {
                    tokensHeldDuringTheWrite.push(fs.readFileSync(lockFilePath, 'utf8'));
                    actualRename(from, to);
                });

            try {
                expect((await reserveOnce(ledger, T0, 5)).admitted).toBe(true);
                expect((await reserveOnce(ledger, T0 + 1, 5)).admitted).toBe(true);
            } finally {
                rename.mockRestore();
            }

            expect(tokensHeldDuringTheWrite).toHaveLength(2);

            for (const token of tokensHeldDuringTheWrite) {
                // The pid is what distinguishes two live holders; the clock and
                // the random tail distinguish two acquisitions by one process.
                expect(token).toContain(`.${process.pid}.`);
                expect(token.trim().length).toBeGreaterThan(`${process.pid}`.length);
            }

            expect(tokensHeldDuringTheWrite[0]).not.toBe(tokensHeldDuringTheWrite[1]);
        });

        it('respects a fresh lock and refuses rather than stealing it', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            fs.writeFileSync(lockFilePath, '', 'utf8');

            const retries: number[] = [];
            const ledger = createFileUsdaRateLedger({
                stateFilePath,
                scope: TEST_SCOPE,
                lockStaleMs: 30_000,
                lockAttempts: 3,
                lockRetryDelayMs: 7,
                sleep: async (ms: number): Promise<void> => {
                    retries.push(ms);
                },
            });

            const thrown = await reserveOnce(ledger, T0, 1).catch((error: unknown) => error);

            expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

            const failure = thrown as UsdaRateLedgerError;
            expect(failure.name).toBe('UsdaRateLedgerError');
            expect(failure.code).toBe('lock_unavailable');
            expect(failure.stateFilePath).toBe(stateFilePath);
            expect(failure.scope).toBe(TEST_SCOPE);
            expect(retries).toEqual([7, 7, 7]);
            // The holder's lock is left exactly as it was, and nothing was
            // admitted or recorded.
            expect(fs.existsSync(lockFilePath)).toBe(true);
            expect(fs.existsSync(stateFilePath)).toBe(false);
        });

        it('releases the lock after every reservation, admitted or not', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            const ledger = fileLedgerOver(stateFilePath);

            expect((await reserveOnce(ledger, T0, 1)).admitted).toBe(true);
            expect(fs.existsSync(lockFilePath)).toBe(false);

            expect((await reserveOnce(ledger, T0, 1)).admitted).toBe(false);
            expect(fs.existsSync(lockFilePath)).toBe(false);
        });

        it('refuses rather than holding a lock it could not stamp', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            const ledger = fileLedgerOver(stateFilePath);

            // The stamp is the only write that goes to a descriptor rather
            // than a path, so failing those and nothing else is exactly the
            // "lock created, token never landed" case.
            const actualWriteFileSync = fs.writeFileSync;
            const writeFile = jest.spyOn(fs, 'writeFileSync').mockImplementation(((
                target: Parameters<typeof fs.writeFileSync>[0],
                data: Parameters<typeof fs.writeFileSync>[1],
                options?: Parameters<typeof fs.writeFileSync>[2],
            ) => {
                if (typeof target === 'number') {
                    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
                }

                return actualWriteFileSync(target, data, options);
            }) as typeof fs.writeFileSync);

            try {
                const thrown = await reserveOnce(ledger, T0, 1).catch((error: unknown) => error);

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                const failure = thrown as UsdaRateLedgerError;
                expect(failure.code).toBe('lock_unavailable');
                expect(failure.message).toContain('could not be stamped');
            } finally {
                writeFile.mockRestore();
            }

            // Nothing admitted, and no unidentifiable lock left to block the
            // next run for the staleness threshold.
            expect(fs.existsSync(lockFilePath)).toBe(false);
            expect(fs.existsSync(stateFilePath)).toBe(false);
            expect((await reserveOnce(ledger, T0, 1)).admitted).toBe(true);
        });

        it('refuses when a lock that exists cannot be read, rather than assuming it is gone', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            abandonLock(lockFilePath, 'usda-rate-ledger.999999.4.other-user\n');

            // What a second OS user meets under the 0700/0600 modes of the
            // default directory. Reading it as "no lock" is how that user
            // would hand itself a second allowance against one key.
            const actualReadFileSync = fs.readFileSync;
            const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                target: Parameters<typeof fs.readFileSync>[0],
                options?: Parameters<typeof fs.readFileSync>[1],
            ) => {
                if (target === lockFilePath) {
                    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
                }

                return actualReadFileSync(target, options);
            }) as typeof fs.readFileSync);

            try {
                const thrown = await reserveOnce(fileLedgerOver(stateFilePath), T0, 1).catch(
                    (error: unknown) => error,
                );

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                const failure = thrown as UsdaRateLedgerError;
                expect(failure.code).toBe('lock_unavailable');
                expect(failure.message).toContain('exists but could not be read');
            } finally {
                readFile.mockRestore();
            }

            expect(fs.existsSync(lockFilePath)).toBe(true);
            expect(fs.existsSync(stateFilePath)).toBe(false);
        });

        it('leaves a stale lock alone when its token changed between the age check and the unlink', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            abandonLock(lockFilePath, 'usda-rate-ledger.999999.1.first\n');

            // Every read of the lock file answers with a different holder, so
            // the token the staleness was measured on is never the token that
            // would be unlinked — the case in which unlinking would tear the
            // lock out from under a live holder that took it a moment ago.
            const actualReadFileSync = fs.readFileSync;
            let holder = 0;
            const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                target: Parameters<typeof fs.readFileSync>[0],
                options?: Parameters<typeof fs.readFileSync>[1],
            ) => {
                if (target === lockFilePath) {
                    holder += 1;

                    return `usda-rate-ledger.999999.1.holder-${holder}\n`;
                }

                return actualReadFileSync(target, options);
            }) as typeof fs.readFileSync);

            const retries: number[] = [];
            const ledger = createFileUsdaRateLedger({
                stateFilePath,
                scope: TEST_SCOPE,
                lockStaleMs: 30_000,
                lockAttempts: 3,
                lockRetryDelayMs: 5,
                sleep: async (ms: number): Promise<void> => {
                    retries.push(ms);
                },
            });

            try {
                const thrown = await reserveOnce(ledger, T0, 1).catch((error: unknown) => error);

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);
                expect((thrown as UsdaRateLedgerError).code).toBe('lock_unavailable');
                // Waited its bounded attempts out rather than stealing it, and
                // the lock file is still there for its holder.
                expect(retries).toEqual([5, 5, 5]);
                expect(fs.existsSync(lockFilePath)).toBe(true);
                expect(fs.existsSync(stateFilePath)).toBe(false);
            } finally {
                readFile.mockRestore();
            }
        });

        it('refuses to report an admission when another importer took the lock after the record was written', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            const ledger = fileLedgerOver(stateFilePath);
            const foreignToken = 'usda-rate-ledger.999999.2.foreign\n';

            // The one outcome the token exists to make impossible: a breaker
            // removed this reservation's lock and took its own while the
            // reservation was inside the critical section. The write may
            // already be on disk — which is the safe direction — but the
            // caller must not be told it may spend the slot.
            const actualRename = fs.renameSync;
            const rename = jest
                .spyOn(fs, 'renameSync')
                .mockImplementationOnce((from: fs.PathLike, to: fs.PathLike): void => {
                    actualRename(from, to);
                    fs.writeFileSync(lockFilePath, foreignToken, 'utf8');
                });

            try {
                const thrown = await reserveOnce(ledger, T0, 5).catch((error: unknown) => error);

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                const failure = thrown as UsdaRateLedgerError;
                expect(failure.code).toBe('lock_unavailable');
                expect(failure.message).toContain('after this attempt was recorded');
                expect(failure.message).toContain('was not exclusive');
            } finally {
                rename.mockRestore();
            }

            // Over-charged rather than under-charged: the stamp is on disk for
            // an attempt the caller was never cleared to make.
            expect(readStamps(stateFilePath)).toEqual([T0]);
            // And the foreign holder's lock was left exactly as it was, so the
            // failure does not cascade into a third process's critical section.
            expect(fs.readFileSync(lockFilePath, 'utf8')).toBe(foreignToken);
        });

        it('refuses to report an admission when the lock disappeared after the record was written', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            const ledger = fileLedgerOver(stateFilePath);

            const actualRename = fs.renameSync;
            const rename = jest
                .spyOn(fs, 'renameSync')
                .mockImplementationOnce((from: fs.PathLike, to: fs.PathLike): void => {
                    actualRename(from, to);
                    fs.rmSync(lockFilePath, { force: true });
                });

            try {
                const thrown = await reserveOnce(ledger, T0, 5).catch((error: unknown) => error);

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);
                expect((thrown as UsdaRateLedgerError).code).toBe('lock_unavailable');
                expect((thrown as UsdaRateLedgerError).message).toContain('had been removed');
            } finally {
                rename.mockRestore();
            }

            expect(readStamps(stateFilePath)).toEqual([T0]);
        });

        it('refuses to report an admission when another importer overwrote the document it just wrote', async () => {
            const stateFilePath = statePathFor();
            const ledger = fileLedgerOver(stateFilePath);
            const clobbered = { version: USDA_RATE_LEDGER_STATE_VERSION, scope: TEST_SCOPE, attempts: [] };

            // The residual case the lock check alone cannot see: the lock file
            // is untouched, but the document this reservation wrote is not the
            // document on disk, so its attempt is not accounted for anywhere.
            const actualRename = fs.renameSync;
            const rename = jest
                .spyOn(fs, 'renameSync')
                .mockImplementationOnce((from: fs.PathLike, to: fs.PathLike): void => {
                    actualRename(from, to);
                    writeStateDocument(stateFilePath, clobbered);
                });

            try {
                const thrown = await reserveOnce(ledger, T0, 5).catch((error: unknown) => error);

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                const failure = thrown as UsdaRateLedgerError;
                expect(failure.code).toBe('lock_unavailable');
                expect(failure.message).toContain('not accounted for');
            } finally {
                rename.mockRestore();
            }

            expect(readStamps(stateFilePath)).toEqual([]);
        });

        it('refuses to report an admission when the document cannot be read back', async () => {
            const stateFilePath = statePathFor();
            const ledger = fileLedgerOver(stateFilePath);

            // The first read is the reservation's own load of the document;
            // the read-back after the write is the one that fails here.
            const actualReadFileSync = fs.readFileSync;
            let stateReads = 0;
            const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                target: Parameters<typeof fs.readFileSync>[0],
                options?: Parameters<typeof fs.readFileSync>[1],
            ) => {
                if (target === stateFilePath) {
                    stateReads += 1;

                    if (stateReads > 1) {
                        throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
                    }
                }

                return actualReadFileSync(target, options);
            }) as typeof fs.readFileSync);

            try {
                const thrown = await reserveOnce(ledger, T0, 5).catch((error: unknown) => error);

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                const failure = thrown as UsdaRateLedgerError;
                expect(failure.code).toBe('state_unreadable');
                expect(failure.message).toContain('cannot be shown to be accounted for');
                expect(stateReads).toBe(2);
            } finally {
                readFile.mockRestore();
            }
        });

        it('will not prune another holder\u2019s document when its own lock has been taken', async () => {
            const stateFilePath = statePathFor();
            const lockFilePath = `${stateFilePath}.lock`;
            const ledger = fileLedgerOver(stateFilePath);

            // Two stamps, the older of which has aged out by the instant the
            // reservation below reads it while the newer still fills the
            // window — so the reservation refuses AND wants to persist the
            // pruning.
            writeStateDocument(stateFilePath, {
                version: USDA_RATE_LEDGER_STATE_VERSION,
                scope: TEST_SCOPE,
                attempts: [T0, T0 + 1],
            });

            const actualReadFileSync = fs.readFileSync;
            const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                target: Parameters<typeof fs.readFileSync>[0],
                options?: Parameters<typeof fs.readFileSync>[1],
            ) => {
                if (target === lockFilePath) {
                    return 'usda-rate-ledger.999999.3.foreign\n';
                }

                return actualReadFileSync(target, options);
            }) as typeof fs.readFileSync);

            try {
                const thrown = await reserveOnce(ledger, T0 + RATE_WINDOW_MS + 1, 1).catch(
                    (error: unknown) => error,
                );

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

                const failure = thrown as UsdaRateLedgerError;
                expect(failure.code).toBe('lock_unavailable');
                expect(failure.message).toContain('before the aged-out stamps were pruned');
            } finally {
                readFile.mockRestore();
            }

            // The document is untouched: a reservation that lost the critical
            // section rewrites nothing, not even a prune.
            expect(readStamps(stateFilePath)).toEqual([T0, T0 + 1]);
        });
    });

    // -----------------------------------------------------------------------
    // The ownership verdict every decision about the lock is made on.
    // -----------------------------------------------------------------------

    describe('ledgerLockOwnership', () => {
        const TOKEN = 'usda-rate-ledger.4242.1700000000000.k3j4h5';

        it('reads an unchanged token as still held, trailing newline included', () => {
            expect(ledgerLockOwnership(TOKEN, TOKEN)).toBe('held');
            expect(ledgerLockOwnership(`${TOKEN}\n`, TOKEN)).toBe('held');
            expect(ledgerLockOwnership(`  ${TOKEN}  `, `${TOKEN}\n`)).toBe('held');
        });

        it('reads a missing lock file as released', () => {
            expect(ledgerLockOwnership(null, TOKEN)).toBe('released');
        });

        it('reads any other token as reacquired by somebody else', () => {
            expect(ledgerLockOwnership(`${TOKEN}x`, TOKEN)).toBe('reacquired');
            expect(ledgerLockOwnership('usda-rate-ledger.4243.1700000000000.k3j4h5', TOKEN)).toBe('reacquired');
        });

        it('never reads a blank lock file as ours', () => {
            // A lock whose stamp never landed cannot be mistaken for a
            // reservation's own lock — a minted token is never blank.
            expect(ledgerLockOwnership('', TOKEN)).toBe('reacquired');
            expect(ledgerLockOwnership('\n', TOKEN)).toBe('reacquired');
        });

        it('reads two blank observations as the same lock, so a token-less lock stays breakable', () => {
            expect(ledgerLockOwnership('', '')).toBe('held');
            expect(ledgerLockOwnership('\n', '')).toBe('held');
        });
    });

    // -----------------------------------------------------------------------
    // Fail closed: never an empty ledger, never an unpaced request.
    // -----------------------------------------------------------------------

    describe('state that cannot be trusted', () => {
        const limiterOver = (ledger: UsdaRateLedger): UsdaRateLimiter =>
            createUsdaRateLimiter({
                requestsPerHour: 5,
                burstCapacity: 5,
                now: () => T0,
                sleep: instantSleep,
                ledger,
            });

        const expectRefusal = async (
            stateFilePath: string,
            code: string,
            prepare: (target: string) => void,
        ): Promise<UsdaRateLedgerError> => {
            prepare(stateFilePath);

            const limiter = limiterOver(fileLedgerOver(stateFilePath));

            const thrown = await limiter.acquire().then(
                () => null,
                (error: unknown) => error,
            );

            expect(thrown).toBeInstanceOf(UsdaRateLedgerError);

            const failure = thrown as UsdaRateLedgerError;
            expect(failure.code).toBe(code);
            expect(failure.name).toBe('UsdaRateLedgerError');
            // The path the operator has to decide about, and what deleting it
            // costs them, are both in the message.
            expect(failure.message).toContain(stateFilePath);
            expect(failure.message).toContain('forfeits');
            expect(failure.stateFilePath).toBe(stateFilePath);
            expect(failure.scope).toBe(TEST_SCOPE);
            // Nothing went out: the request was refused, not admitted unpaced.
            expect(limiter.stats().attempts).toBe(0);

            return failure;
        };

        it('refuses a state file that is not JSON', async () => {
            await expectRefusal(statePathFor(), 'state_unparsable', (target) => {
                fs.writeFileSync(target, '{ not json', 'utf8');
            });
        });

        it('refuses a state file that is not a JSON object', async () => {
            await expectRefusal(statePathFor(), 'state_unparsable', (target) => {
                writeStateDocument(target, [T0]);
            });
        });

        it('refuses a state file written by a newer shape version', async () => {
            await expectRefusal(statePathFor(), 'state_version_unsupported', (target) => {
                writeStateDocument(target, {
                    version: USDA_RATE_LEDGER_STATE_VERSION + 1,
                    scope: TEST_SCOPE,
                    attempts: [],
                });
            });
        });

        it('refuses a state file scoped to another credential', async () => {
            const failure = await expectRefusal(statePathFor(), 'state_scope_mismatch', (target) => {
                writeStateDocument(target, {
                    version: USDA_RATE_LEDGER_STATE_VERSION,
                    scope: 'other.key',
                    attempts: [],
                });
            });

            expect(failure.message).toContain('other.key');
        });

        it('refuses an attempt list that is not all finite numbers', async () => {
            // `null` is what JSON.stringify writes for a NaN, so this is what a
            // corrupted stamp looks like on disk. Dropping it silently would
            // hand back allowance that was already spent.
            await expectRefusal(statePathFor(), 'state_unparsable', (target) => {
                writeStateDocument(target, {
                    version: USDA_RATE_LEDGER_STATE_VERSION,
                    scope: TEST_SCOPE,
                    attempts: [T0, null],
                });
            });
        });

        it('refuses a state file carrying no scope', async () => {
            await expectRefusal(statePathFor(), 'state_unparsable', (target) => {
                writeStateDocument(target, { version: USDA_RATE_LEDGER_STATE_VERSION, attempts: [] });
            });
        });

        it('refuses a state directory that cannot be created', async () => {
            const blocker = path.join(workspace, 'not-a-directory');
            fs.writeFileSync(blocker, 'in the way', 'utf8');

            await expectRefusal(path.join(blocker, 'ledger.json'), 'state_directory_unusable', () => undefined);
        });

        it('refuses a state file that exists but cannot be read', async () => {
            const stateFilePath = statePathFor();
            writeStateDocument(stateFilePath, {
                version: USDA_RATE_LEDGER_STATE_VERSION,
                scope: TEST_SCOPE,
                attempts: [],
            });

            // Scoped to the ledger's own file: a blanket failure would also
            // break whatever else reads a file during the test.
            const actualReadFileSync = fs.readFileSync;
            const readFile = jest.spyOn(fs, 'readFileSync').mockImplementation(((
                target: Parameters<typeof fs.readFileSync>[0],
                options?: Parameters<typeof fs.readFileSync>[1],
            ) => {
                if (target === stateFilePath) {
                    throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
                }

                return actualReadFileSync(target, options);
            }) as typeof fs.readFileSync);

            try {
                await expectRefusal(stateFilePath, 'state_unreadable', () => undefined);
            } finally {
                readFile.mockRestore();
            }
        });

        it('treats an absent state file as a first run rather than a failure', async () => {
            const stateFilePath = statePathFor();
            const limiter = limiterOver(fileLedgerOver(stateFilePath));

            await expect(limiter.acquire()).resolves.toBeUndefined();
            expect(limiter.stats().attempts).toBe(1);
            expect(readStamps(stateFilePath)).toEqual([T0]);
        });
    });

    // -----------------------------------------------------------------------
    // Durability of the write itself.
    // -----------------------------------------------------------------------

    describe('the state write', () => {
        it('writes a temp file in the same directory and renames it over the state file', async () => {
            const stateFilePath = statePathFor();
            const writeFile = jest.spyOn(fs, 'writeFileSync');
            const rename = jest.spyOn(fs, 'renameSync');

            try {
                await reserveOnce(fileLedgerOver(stateFilePath), T0, 2);

                // The first write of the reservation is the lock stamp, and it
                // goes to a DESCRIPTOR rather than a path — which is what
                // keeps it from ever landing in another holder's lock file.
                expect(typeof writeFile.mock.calls[0]?.[0]).toBe('number');

                const pathWrites = writeFile.mock.calls
                    .map((call) => call[0])
                    .filter((target): target is string => typeof target === 'string');
                const writtenPath = String(pathWrites[0]);

                expect(path.dirname(writtenPath)).toBe(path.dirname(stateFilePath));
                expect(path.basename(writtenPath).startsWith(`${path.basename(stateFilePath)}.`)).toBe(true);
                expect(writtenPath.endsWith('.tmp')).toBe(true);
                expect(rename.mock.calls).toEqual([[writtenPath, stateFilePath]]);
                // The state file itself is never written in place, so no reader
                // can observe a truncated document.
                expect(writeFile.mock.calls.map((call) => String(call[0]))).not.toContain(stateFilePath);
            } finally {
                writeFile.mockRestore();
                rename.mockRestore();
            }
        });

        it('never leaves a state file that fails to parse, at any point in a run', async () => {
            const stateFilePath = statePathFor();
            const limit = 4;
            const ledger = fileLedgerOver(stateFilePath);

            for (let index = 0; index < limit * 2; index += 1) {
                await reserveOnce(ledger, T0 + index, limit);

                const document = readStateDocument(stateFilePath);
                const attempts = document.attempts as number[];

                expect(document.version).toBe(USDA_RATE_LEDGER_STATE_VERSION);
                expect(document.scope).toBe(TEST_SCOPE);
                expect(attempts.every((stamp) => Number.isFinite(stamp))).toBe(true);
                expect(attempts.length).toBeLessThanOrEqual(limit);
            }

            expect(fs.readdirSync(workspace)).toEqual([path.basename(stateFilePath)]);
        });

        it('leaves the previous document intact and reports the failure when the rename fails', async () => {
            const stateFilePath = statePathFor();
            const ledger = fileLedgerOver(stateFilePath);

            await reserveOnce(ledger, T0, 5);
            const before = readStamps(stateFilePath);

            const rename = jest.spyOn(fs, 'renameSync').mockImplementationOnce(() => {
                throw Object.assign(new Error('EIO: i/o error'), { code: 'EIO' });
            });

            try {
                const thrown = await reserveOnce(ledger, T0 + 1, 5).catch((error: unknown) => error);

                expect(thrown).toBeInstanceOf(UsdaRateLedgerError);
                expect((thrown as UsdaRateLedgerError).code).toBe('state_write_failed');
            } finally {
                rename.mockRestore();
            }

            // The previous document survives, the temp file is gone, and the
            // lock was released — so the run is recoverable rather than wedged.
            expect(readStamps(stateFilePath)).toEqual(before);
            expect(fs.readdirSync(workspace)).toEqual([path.basename(stateFilePath)]);
            expect((await reserveOnce(ledger, T0 + 2, 5)).admitted).toBe(true);
        });
    });

    // -----------------------------------------------------------------------
    // The limiter's defaulting and its concurrency.
    // -----------------------------------------------------------------------

    describe('createUsdaRateLimiter', () => {
        it('is durable by default when only a rate and a logger are passed', () => {
            const { logger } = createRecordingLogger();
            const limiter = createUsdaRateLimiter({
                requestsPerHour: DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR,
                logger,
            });

            const stats = limiter.stats();

            expect(stats.ledgerKind).toBe('file');
            expect(stats.ledgerScope).toBe(USDA_HOST);
            expect(stats.attemptsInWindow).toBe(0);
            // Every pre-existing field keeps its name and its meaning.
            expect(stats).toMatchObject({
                configuredPerHour: DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR,
                vendorCapPerHour: USDA_VENDOR_CAP_PER_HOUR,
                burstCapacity: DEFAULT_BURST_CAPACITY,
                attempts: 0,
                pauses: 0,
                totalPausedMs: 0,
                longestPauseMs: 0,
                firstAttemptAt: null,
                lastAttemptAt: null,
            });
        });

        it('reports an injected ledger rather than the default', () => {
            const limiter = createUsdaRateLimiter({
                requestsPerHour: 10,
                ledger: createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE }),
            });

            expect(limiter.stats().ledgerKind).toBe('process_local');
            expect(limiter.stats().ledgerScope).toBe(TEST_SCOPE);
        });

        it('derives its default state file from the scope alone, wherever it was constructed from', () => {
            const statePath = defaultUsdaRateLedgerStateFilePath('shared.key.usda.invalid');

            // The location of this module, the working directory and the
            // package's `node_modules` are all absent from the derivation —
            // see 'the default configuration' above for why each of them
            // being absent is the requirement rather than an accident.
            expect(statePath).toBe(
                path.join(defaultUsdaRateLedgerDirectory(), 'usda-rate-ledger.shared.key.usda.invalid.json'),
            );
            expect(statePath).not.toContain(BACKEND_ROOT);
            expect(statePath).not.toContain(path.join(BACKEND_ROOT, 'data'));
            expect(statePath).not.toContain(path.join(BACKEND_ROOT, 'scripts'));
        });

        it('sanitises a scope into the state file name so it cannot steer the path', () => {
            const statePath = defaultUsdaRateLedgerStateFilePath('../../etc/passwd');

            expect(path.dirname(statePath)).toBe(defaultUsdaRateLedgerDirectory());
            // Every path separator is gone, so the scope names a file in the
            // cache directory and cannot climb out of it.
            expect(path.basename(statePath)).toBe('usda-rate-ledger..._.._etc_passwd.json');
            expect(path.basename(statePath)).not.toContain(path.sep);
        });

        it('uses an overridden state file path without an injected ledger', async () => {
            const stateFilePath = statePathFor('overridden.json');
            const limiter = createUsdaRateLimiter({
                requestsPerHour: 2,
                burstCapacity: 2,
                now: () => T0,
                sleep: instantSleep,
                ledgerScope: TEST_SCOPE,
                ledgerStateFilePath: stateFilePath,
            });

            await limiter.acquire();

            expect(limiter.stats().ledgerKind).toBe('file');
            expect(limiter.stats().ledgerScope).toBe(TEST_SCOPE);
            expect(readStamps(stateFilePath)).toEqual([T0]);
        });

        it('serialises concurrent acquisitions so they cannot over-spend the burst', async () => {
            const clock = createClock();
            const { lines, logger } = createRecordingLogger();
            const reserveOrder: number[] = [];
            const inner = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });

            // A ledger that yields to the event loop before answering, which is
            // what a durable one does on every reservation. Without the FIFO
            // queue all three callers would clear the two-token bucket check
            // before any of them had spent a token.
            const ledger: UsdaRateLedger = {
                reserve: async (input) => {
                    await Promise.resolve();
                    const reservation = await inner.reserve(input);
                    reserveOrder.push(reservation.attemptsInWindow);

                    return reservation;
                },
                describe: () => inner.describe(),
            };

            const limiter = createUsdaRateLimiter({
                requestsPerHour: 900,
                burstCapacity: 2,
                now: clock.read,
                sleep: clock.sleep,
                logger,
                ledger,
            });

            await Promise.all([limiter.acquire(), limiter.acquire(), limiter.acquire()]);

            const expectedBurstWaitMs = waitMsForToken(
                { tokens: 0, lastRefillMs: T0 },
                T0,
                900 / RATE_WINDOW_MS,
                2,
            );

            expect(limiter.stats().attempts).toBe(3);
            expect(reserveOrder).toEqual([1, 2, 3]);
            // The third acquisition found the bucket empty and waited for a
            // token instead of borrowing one that did not exist.
            expect(limiter.stats().pauses).toBe(1);
            expect(clock.sleeps).toEqual([expectedBurstWaitMs]);

            const pauses = lines.filter((line) => line.event === 'usda_rate_limit_pause');
            expect(pauses).toHaveLength(1);
            expect(pauses[0]?.fields.reason).toBe('burst');
            expect(pauses[0]?.fields.waitMs).toBe(expectedBurstWaitMs);
        });

        it('pauses on the burst first and then the hourly ceiling, and keeps waiting rather than failing', async () => {
            const clock = createClock();
            const { lines, logger } = createRecordingLogger();
            const limiter = createUsdaRateLimiter({
                requestsPerHour: 2,
                burstCapacity: 2,
                now: clock.read,
                sleep: clock.sleep,
                logger,
                ledger: fileLedgerOver(statePathFor()),
            });

            await limiter.acquire();
            await limiter.acquire();
            await limiter.acquire();

            const burstWaitMs = waitMsForToken({ tokens: 0, lastRefillMs: T0 }, T0, 2 / RATE_WINDOW_MS, 2);
            const pauses = lines.filter((line) => line.event === 'usda_rate_limit_pause');

            // The bucket is checked first, so the third request waits for a
            // token, then for the hour, then for the one millisecond the
            // inclusive far boundary withholds. It is never refused.
            expect(pauses.map((pause) => [pause.fields.reason, pause.fields.waitMs])).toEqual([
                ['burst', burstWaitMs],
                ['hourly_ceiling', RATE_WINDOW_MS - burstWaitMs],
                ['hourly_ceiling', 1],
            ]);
            expect(pauses[1]?.fields.attemptsInWindow).toBe(2);
            expect(limiter.stats().attempts).toBe(3);
            expect(limiter.stats().pauses).toBe(3);
            expect(limiter.stats().totalPausedMs).toBe(RATE_WINDOW_MS + 1);
            expect(clock.read()).toBe(T0 + RATE_WINDOW_MS + 1);
        });

        it('lets a later acquisition succeed after one failed on the ledger', async () => {
            let failNext = true;
            const inner = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });
            const ledger: UsdaRateLedger = {
                reserve: async (input) => {
                    if (failNext) {
                        failNext = false;
                        throw new UsdaRateLedgerError('state_unparsable', 'corrupt', statePathFor(), TEST_SCOPE);
                    }

                    return inner.reserve(input);
                },
                describe: () => inner.describe(),
            };

            const limiter = createUsdaRateLimiter({
                requestsPerHour: 5,
                burstCapacity: 5,
                now: () => T0,
                sleep: instantSleep,
                ledger,
            });

            await expect(limiter.acquire()).rejects.toBeInstanceOf(UsdaRateLedgerError);
            // The queue must not carry one caller's rejection to the next.
            await expect(limiter.acquire()).resolves.toBeUndefined();
            expect(limiter.stats().attempts).toBe(1);
        });

        it('does not spin when an injected ledger refuses without a usable wait', async () => {
            const clock = createClock();
            let refusals = 0;
            const ledger: UsdaRateLedger = {
                reserve: async () => {
                    refusals += 1;

                    return refusals > 2
                        ? { admitted: true, waitMs: 0, attemptsInWindow: refusals }
                        : { admitted: false, waitMs: Number.NaN, attemptsInWindow: refusals };
                },
                describe: () => ({ kind: 'database', scope: TEST_SCOPE }),
            };

            const limiter = createUsdaRateLimiter({
                requestsPerHour: 900,
                burstCapacity: 20,
                now: clock.read,
                sleep: clock.sleep,
                ledger,
            });

            await limiter.acquire();

            expect(clock.sleeps).toEqual([1, 1]);
            expect(limiter.stats().attempts).toBe(1);
            expect(limiter.stats().ledgerKind).toBe('database');
        });
    });

    // -----------------------------------------------------------------------
    // Regression cover for what must not change.
    // -----------------------------------------------------------------------

    describe('what the CLI scripts already depend on', () => {
        const originalFetch = globalThis.fetch;

        afterEach(() => {
            globalThis.fetch = originalFetch;
        });

        const installedLimiter = (): { limiter: UsdaRateLimiter; transport: jest.Mock } => {
            const transport = jest.fn(async () => ({ ok: true }) as unknown as Response);
            globalThis.fetch = transport as unknown as typeof globalThis.fetch;

            return {
                limiter: createUsdaRateLimiter({
                    requestsPerHour: 10,
                    burstCapacity: 10,
                    now: () => T0,
                    sleep: instantSleep,
                    ledger: createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE }),
                }),
                transport,
            };
        };

        it('passes non-USDA traffic through unpaced and with no stats movement', async () => {
            const { limiter, transport } = installedLimiter();
            const restore = limiter.install();

            try {
                await globalThis.fetch('https://openrouter.ai/api/v1/chat/completions');
                await globalThis.fetch('https://pubmed.ncbi.nlm.nih.gov/12345678/');

                expect(transport).toHaveBeenCalledTimes(2);
                expect(limiter.stats().attempts).toBe(0);
                expect(limiter.stats().attemptsInWindow).toBe(0);
                expect(limiter.stats().pauses).toBe(0);

                await globalThis.fetch(`https://${USDA_HOST}/fdc/v1/foods/search?query=egg`);

                expect(limiter.stats().attempts).toBe(1);
                expect(limiter.stats().attemptsInWindow).toBe(1);
            } finally {
                restore();
            }
        });

        it('treats a second install as the same installation', async () => {
            const { limiter } = installedLimiter();
            const restore = limiter.install();
            const wrapper = globalThis.fetch;

            try {
                expect(limiter.install()).toBe(restore);
                expect(globalThis.fetch).toBe(wrapper);

                await globalThis.fetch(`https://${USDA_HOST}/fdc/v1/food/12345`);

                // One token per request, not two: a wrapped wrapper would have
                // silently halved the configured rate.
                expect(limiter.stats().attempts).toBe(1);
            } finally {
                restore();
            }
        });

        it('restores ownership-safely when something else owns fetch', () => {
            const { limiter, transport } = installedLimiter();
            const restore = limiter.install();
            const wrapper = globalThis.fetch;
            const foreign = jest.fn(async () => ({ ok: true }) as unknown as Response);

            globalThis.fetch = foreign as unknown as typeof globalThis.fetch;
            restore();
            expect(globalThis.fetch).toBe(foreign);

            // Once the newer owner steps down, a later restore still succeeds.
            globalThis.fetch = wrapper;
            restore();
            expect(globalThis.fetch).toBe(transport);
        });

        it('matches the paced host the way it always has', () => {
            expect(isUsdaRequestUrl(`https://${USDA_HOST}/fdc/v1/foods`)).toBe(true);
            expect(isUsdaRequestUrl(`https://${USDA_HOST.toUpperCase()}./fdc/v1/foods`)).toBe(true);
            expect(isUsdaRequestUrl(new URL(`https://${USDA_HOST}/fdc/v1/foods`))).toBe(true);
            expect(isUsdaRequestUrl({ url: `https://${USDA_HOST}/fdc/v1/foods` })).toBe(true);
            expect(isUsdaRequestUrl('https://api.nal.usda.gov.evil.test/fdc/v1/foods')).toBe(false);
            expect(isUsdaRequestUrl('not a url')).toBe(false);
            expect(isUsdaRequestUrl(null)).toBe(false);
        });

        it('reads the documented rate forms and refuses the rest', () => {
            expect(getUsdaImportRateLimitPerHour({})).toBe(DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR);
            expect(getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: '  ' })).toBe(
                DEFAULT_USDA_IMPORT_RATE_LIMIT_PER_HOUR,
            );
            expect(getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: '450' })).toBe(450);
            expect(
                getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: `${USDA_VENDOR_CAP_PER_HOUR}` }),
            ).toBe(USDA_VENDOR_CAP_PER_HOUR);

            for (const raw of ['0', '-1', '1001', '1e3', '0x10', '+7', '8.', '\u00a0900', 'many']) {
                expect(() => getUsdaImportRateLimitPerHour({ USDA_IMPORT_RATE_LIMIT_PER_HOUR: raw })).toThrow(
                    RateLimitConfigError,
                );
            }
        });

        it('still refuses a configuration it cannot honour', () => {
            const ledger = createProcessLocalUsdaRateLedger({ scope: TEST_SCOPE });

            expect(() => createUsdaRateLimiter({ requestsPerHour: 0, ledger })).toThrow(RateLimitConfigError);
            expect(() => createUsdaRateLimiter({ requestsPerHour: 1.5, ledger })).toThrow(RateLimitConfigError);
            expect(() => createUsdaRateLimiter({ requestsPerHour: USDA_VENDOR_CAP_PER_HOUR + 1, ledger })).toThrow(
                RateLimitConfigError,
            );
            expect(() => createUsdaRateLimiter({ requestsPerHour: 10, burstCapacity: 11, ledger })).toThrow(
                RateLimitConfigError,
            );
            expect(() => createUsdaRateLimiter({ requestsPerHour: 10, host: '   ', ledger })).toThrow(
                RateLimitConfigError,
            );
        });

        it('keeps the exported window and bucket rules unchanged', () => {
            expect(refillBucket({ tokens: 0, lastRefillMs: T0 }, T0 + 1_000, 1 / 1_000, 20)).toEqual({
                tokens: 1,
                lastRefillMs: T0 + 1_000,
            });
            expect(waitMsForToken({ tokens: 0, lastRefillMs: T0 }, T0, 1 / 1_000, 20)).toBe(1_000);
            expect(pruneAttemptWindow([T0 - RATE_WINDOW_MS - 1, T0 - RATE_WINDOW_MS, T0], T0, RATE_WINDOW_MS)).toEqual([
                T0 - RATE_WINDOW_MS,
                T0,
            ]);
            expect(windowWaitMs([T0], T0, 1, RATE_WINDOW_MS)).toBe(RATE_WINDOW_MS);
            expect(recordAttemptWindow([T0], T0 - 50, RATE_WINDOW_MS)).toEqual([T0, T0]);
        });
    });

    // -----------------------------------------------------------------------
    // The suite's own guard. The default ledger directory is HOST-scoped, so
    // it is shared with every other checkout's suite and with any real
    // importer on the machine: a test given a `stateFilePath` must write
    // nowhere else, and the tests that do use the default path must confine
    // themselves to their own run-unique scope (they clean up after
    // themselves in 'the default configuration' above).
    // -----------------------------------------------------------------------

    describe('the suite itself', () => {
        it('creates no ledger state outside the path it was given', async () => {
            const stateFilePath = statePathFor();
            const sharedStatePath = defaultUsdaRateLedgerStateFilePath();
            // Existence, not absence: this is a shared directory, so the
            // assertion is that the reservation below did not CHANGE what is
            // in it — a real importer's ledger may legitimately be there.
            const sharedStateExisted = fs.existsSync(sharedStatePath);
            fs.mkdirSync(path.join(workspace, 'nested'));

            await reserveOnce(fileLedgerOver(stateFilePath), T0, 1);

            expect(fs.readdirSync(workspace).sort()).toEqual(['ledger.json', 'nested']);
            expect(fs.existsSync(sharedStatePath)).toBe(sharedStateExisted);
            expect(fs.existsSync(`${sharedStatePath}.lock`)).toBe(false);
        });

        it('leaves nothing of its own behind in the shared default directory', () => {
            const directory = defaultUsdaRateLedgerDirectory();

            if (!fs.existsSync(directory)) {
                // Nothing in this suite has had to create it, which is itself
                // the guarantee being asserted.
                return;
            }

            // Every file this suite writes there carries the `.test.invalid`
            // scope suffix `uniqueLedgerScope` appends, and every test that
            // writes one removes it. Anything left would be leakage into a
            // directory other processes on this host read.
            expect(fs.readdirSync(directory).filter((entry) => entry.includes('.test.invalid'))).toEqual([]);
        });
    });
});
