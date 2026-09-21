/**
 * The guarded schema-command wrapper — `scripts/schema-diff.ts` — on injected
 * doubles, plus one regression against a real PostgreSQL.
 *
 * WHAT THIS SUITE SETTLES, and why the assertions that matter are NEGATIVE.
 * The two commands this wrapper fronts RESET the database they are given:
 * measured against prisma 6.9.0 on PostgreSQL 16.15, `migrate diff
 * --from-migrations` dropped an operator's table out of the shadow database it
 * was pointed at and still exited 2, reporting success. The wrapper exists so
 * that every way of getting the target wrong is a refusal instead, and a
 * refusal is only worth anything if the command did not run: so every refusal
 * case below asserts the code AND that no Prisma process was spawned. For the
 * STRING-LEVEL refusals it additionally asserts that no connection was opened,
 * which is where that claim is true — the read-back, occupancy and row-security
 * refusals necessarily open a connection first and close it again. A guard that
 * reports a refusal after spawning the command has not guarded anything.
 *
 * THE FIVE SEAMS:
 *
 *   1. The URL guard, driven through the REAL `scripts/lib/dbGuard.ts` by
 *      setting the environment rather than by injecting a fake verdict — the
 *      point is that the production wiring refuses, not that a double can.
 *      Every refusal `evaluateShadowDatabase` can produce is reachable that
 *      way, and each one is listed.
 *   2. The read-back, which catches what no string can: a database other than
 *      the one the URL names, a `search_path` moved server-side by a role or
 *      database default, a reset target that holds rows, and a reset target
 *      whose rows a row-level security policy could hide from the session
 *      asking.
 *   3. `buildPrismaInvocation`, the pure decision about WHICH arguments Prisma
 *      gets and WHETHER `DATABASE_URL` reaches it — deleted for the diff, which
 *      needs none, and kept for `migrate dev`, which does.
 *   4. `describeRun`, the exit-code vocabulary 0.9.1's gate and
 *      docs/meal-planning/expected-schema-diff.sql both decide on. Every code
 *      it returns means PRISMA RAN: 2 is the expected success, 0 means the
 *      committed capture is stale, and 1 means Prisma failed AFTER a read-back
 *      that had already succeeded — the refusals never reach it and exit 3.
 *   5. THE ROW-SECURITY REGRESSION at the end of this file, which is the one
 *      part that needs a real PostgreSQL: whether the occupancy question can be
 *      trusted is a question about the server, not about this code, and the
 *      answer was measured to be "not while it obeys row-level security". It
 *      builds the verifier's database — a non-bypass owner, a forced deny-all
 *      policy, one hidden row — on probe databases it creates and drops itself,
 *      and asserts the refusal AND that the row survives.
 *
 * Everything except that last block runs on doubles: no connection, no process,
 * no PostgreSQL. That block needs the server `DATABASE_URL` names and the
 * privilege to create a role and a database on it; it never touches the
 * database `DATABASE_URL` itself points at.
 *
 * Run it with:
 *
 *   NODE_ENV=test ALLOW_DB_TRUNCATE=true \
 *     DATABASE_URL=postgresql://…@127.0.0.1:5433/<name>_test \
 *     npx jest --ci --runInBand src/__tests__/scripts/schemaDiff.test.ts
 */
import { DatabaseOriginError } from '../../../scripts/lib/dbGuard';
import type { ScriptLogger } from '../../../scripts/lib/logger';
import {
    PRISMA_DIFFERENCES_EXIT_CODE,
    SCHEMA_DIFF_MODES,
    SCHEMA_DIFF_REFUSED_EXIT_CODE,
    SchemaDiffError,
    buildOccupancyStatement,
    buildPrismaInvocation,
    describeRun,
    describeUsage,
    openPostgresConnection,
    parseSchemaDiffArgs,
    runSchemaDiff,
    targetEnvNameFor,
} from '../../../scripts/schema-diff';
import type {
    PrismaInvocation,
    PrismaRunResult,
    SchemaDiffConnection,
    SchemaDiffMode,
    SchemaDiffOutcome,
    SchemaDiffTarget,
} from '../../../scripts/schema-diff';

const PACKAGE_ROOT = '/repo/backend';
const NODE_EXECUTABLE = '/usr/bin/node';
const PRISMA_CLI = '/repo/backend/node_modules/prisma/build/index.js';

const SHADOW_URL = 'postgresql://soh:secret@127.0.0.1:5433/soh_shadow_34';
const DEVELOPMENT_URL = 'postgresql://soh:secret@127.0.0.1:5433/soh_dev_34';

/**
 * The statement that makes the occupancy check fail closed, spelled here as the
 * wrapper spells it: a query that OBEYS row-level security cannot certify a
 * relation empty, because the role that owns the relation can still drop it.
 */
const ROW_SECURITY_OFF = 'SET row_security = off';

/**
 * What PostgreSQL 16.15 raises for a role that cannot bypass RLS once
 * `row_security = off` is in force — SQLSTATE 42501, measured. Before the
 * setting was issued the same relation answered "empty" and the replay dropped
 * it.
 */
const ROW_SECURITY_ERROR = new Error(
    'query would be affected by row-level security policy for table "operator_rows"',
);

/** A logger that records, so a rule's own diagnostics are assertable. */
const recordingLogger = (): { readonly lines: { level: string; event: string; fields: unknown }[]; logger: ScriptLogger } => {
    const lines: { level: string; event: string; fields: unknown }[] = [];
    const at =
        (level: string) =>
        (event: string, fields?: unknown): void => {
            lines.push({ level, event, fields });
        };
    const logger = {
        debug: at('debug'),
        info: at('info'),
        warn: at('warn'),
        error: at('error'),
        child: (): ScriptLogger => logger,
    } as unknown as ScriptLogger;
    return { lines, logger };
};

// ---------------------------------------------------------------------------
// The doubles.
// ---------------------------------------------------------------------------

interface TargetAnswers {
    readonly database: string;
    readonly schema?: string;
    readonly searchPath?: string;
    readonly tables?: readonly string[];
    readonly occupied?: readonly string[];
    /** Tables the catalog reports with `relrowsecurity` set. */
    readonly rowSecurityEnabled?: readonly string[];
    /** Tables the catalog reports with `relforcerowsecurity` set. */
    readonly rowSecurityForced?: readonly string[];
    /** Omit both row-security columns from the catalog answer entirely. */
    readonly omitRowSecurityColumns?: boolean;
    readonly failConnect?: Error;
    readonly failIdentity?: Error;
    readonly failEnd?: Error;
    /** Raised by every occupancy statement, the way `row_security = off` makes PostgreSQL raise 42501. */
    readonly failOccupancy?: Error;
    /** Answer the identity query with no row at all. */
    readonly emptyIdentity?: boolean;
}

interface Harness {
    readonly events: string[];
    readonly connections: { connectionString: string; queries: string[]; closed: boolean }[];
    readonly invocations: PrismaInvocation[];
    readonly openConnection: (connectionString: string) => SchemaDiffConnection;
    readonly runPrisma: (invocation: PrismaInvocation) => Promise<PrismaRunResult>;
}

const harnessFor = (answers: TargetAnswers, result: PrismaRunResult = { exitCode: 2, signal: null, stderr: '' }): Harness => {
    const events: string[] = [];
    const connections: { connectionString: string; queries: string[]; closed: boolean }[] = [];
    const invocations: PrismaInvocation[] = [];

    const openConnection = (connectionString: string): SchemaDiffConnection => {
        const record = { connectionString, queries: [] as string[], closed: false };
        connections.push(record);
        events.push('open');

        return {
            connect: async (): Promise<void> => {
                events.push('connect');
                if (answers.failConnect !== undefined) {
                    throw answers.failConnect;
                }
            },
            query: async <TRow>(text: string): Promise<{ rows: TRow[] }> => {
                record.queries.push(text);

                if (text.includes('current_database()')) {
                    if (answers.failIdentity !== undefined) {
                        throw answers.failIdentity;
                    }
                    if (answers.emptyIdentity === true) {
                        return { rows: [] as TRow[] };
                    }
                    return {
                        rows: [
                            {
                                database: answers.database,
                                schema: answers.schema ?? 'public',
                                role: 'soh',
                                server_version: 'PostgreSQL 16.15',
                                server_address: '172.17.0.2/32',
                                server_port: 5432,
                                search_path: answers.searchPath ?? 'public',
                            },
                        ] as unknown as TRow[],
                    };
                }

                if (text.includes('pg_catalog.pg_class')) {
                    const enabled = answers.rowSecurityEnabled ?? [];
                    const forced = answers.rowSecurityForced ?? [];
                    return {
                        rows: (answers.tables ?? []).map((table) =>
                            answers.omitRowSecurityColumns === true
                                ? { table_name: table }
                                : {
                                      table_name: table,
                                      row_security_enabled: enabled.includes(table),
                                      row_security_forced: forced.includes(table),
                                  },
                        ) as unknown as TRow[],
                    };
                }

                if (text.includes('WHERE EXISTS')) {
                    if (answers.failOccupancy !== undefined) {
                        throw answers.failOccupancy;
                    }
                    const occupied = answers.occupied ?? [];
                    return {
                        rows: occupied
                            .filter((table) => text.includes(`'${table}'`))
                            .map((table) => ({ table_name: table })) as unknown as TRow[],
                    };
                }

                // `SET row_security = off`, which answers no rows. Matched
                // explicitly rather than falling through, because the fall-through
                // below is what makes an unexpected statement a test failure.
                if (text === ROW_SECURITY_OFF) {
                    return { rows: [] as TRow[] };
                }

                throw new Error(`the wrapper issued an unexpected statement: ${text}`);
            },
            end: async (): Promise<void> => {
                record.closed = true;
                events.push('end');
                if (answers.failEnd !== undefined) {
                    throw answers.failEnd;
                }
            },
        };
    };

    const runPrisma = async (invocation: PrismaInvocation): Promise<PrismaRunResult> => {
        invocations.push(invocation);
        events.push('spawn');
        return result;
    };

    return { events, connections, invocations, openConnection, runPrisma };
};

/** A harness whose connection must never be opened; used by the refusal cases. */
const untouchedHarness = (): Harness =>
    harnessFor({ database: 'unreachable-in-this-test' }, { exitCode: 0, signal: null, stderr: '' });

interface RunInput {
    readonly mode?: SchemaDiffMode;
    readonly migrationName?: string | null;
    readonly env: NodeJS.ProcessEnv;
    readonly harness: Harness;
}

const run = async (input: RunInput) => {
    const { logger, lines } = recordingLogger();
    const outcome = await runSchemaDiff({
        mode: input.mode ?? 'diff',
        migrationName: input.migrationName ?? null,
        env: input.env,
        logger,
        openConnection: input.harness.openConnection,
        runPrisma: input.harness.runPrisma,
        packageRoot: PACKAGE_ROOT,
        nodeExecutable: NODE_EXECUTABLE,
        prismaCliPath: PRISMA_CLI,
    });
    return { outcome, lines };
};

const refusal = async (input: RunInput): Promise<unknown> => {
    try {
        await run(input);
    } catch (error) {
        return error;
    }
    throw new Error('the run was expected to be refused and was not');
};

// ---------------------------------------------------------------------------
// Arguments.
// ---------------------------------------------------------------------------

describe('parseSchemaDiffArgs', () => {
    it('accepts each mode as a positional argument', () => {
        expect(parseSchemaDiffArgs(['diff'])).toEqual({
            ok: true,
            options: { help: false, mode: 'diff', migrationName: null },
        });
        expect(parseSchemaDiffArgs(['create-only', '--name', 'meal_planning'])).toEqual({
            ok: true,
            options: { help: false, mode: 'create-only', migrationName: 'meal_planning' },
        });
        expect(parseSchemaDiffArgs(['create-only', '--name=meal_planning'])).toEqual({
            ok: true,
            options: { help: false, mode: 'create-only', migrationName: 'meal_planning' },
        });
    });

    it('declares both modes it accepts', () => {
        expect(SCHEMA_DIFF_MODES).toEqual(['diff', 'create-only']);
    });

    // A missing mode must never default: defaulting to either one would mean a
    // mistyped invocation silently ran the other command against the same URL.
    it('refuses a run with no mode, naming both', () => {
        const parsed = parseSchemaDiffArgs([]);
        expect(parsed.ok).toBe(false);
        if (parsed.ok) {
            throw new Error('expected a refusal');
        }
        expect(parsed.errors).toHaveLength(1);
        expect(parsed.errors[0].flag).toBe('<mode>');
        expect(parsed.errors[0].message).toContain('diff or create-only');
    });

    it('refuses an unknown mode, a second mode and an unknown flag', () => {
        const unknownMode = parseSchemaDiffArgs(['dif']);
        expect(unknownMode.ok).toBe(false);
        if (!unknownMode.ok) {
            expect(unknownMode.errors[0].message).toContain('is not a mode');
        }

        const twoModes = parseSchemaDiffArgs(['diff', 'create-only']);
        expect(twoModes.ok).toBe(false);
        if (!twoModes.ok) {
            expect(twoModes.errors.some((failure) => failure.message.includes('takes one mode'))).toBe(true);
        }

        const unknownFlag = parseSchemaDiffArgs(['diff', '--force']);
        expect(unknownFlag.ok).toBe(false);
        if (!unknownFlag.ok) {
            expect(unknownFlag.errors[0].message).toContain('is not a flag');
        }
    });

    // Prisma prompts for a name interactively, which a scripted run cannot
    // answer, so the parser demands it rather than letting the child hang.
    it('requires --name for create-only and rejects it for diff', () => {
        const missingName = parseSchemaDiffArgs(['create-only']);
        expect(missingName.ok).toBe(false);
        if (!missingName.ok) {
            expect(missingName.errors.some((failure) => failure.flag === '--name')).toBe(true);
        }

        const strayName = parseSchemaDiffArgs(['diff', '--name', 'x']);
        expect(strayName.ok).toBe(false);
        if (!strayName.ok) {
            expect(strayName.errors[0].message).toContain('belongs to create-only');
        }

        const repeated = parseSchemaDiffArgs(['create-only', '--name', 'a', '--name', 'b']);
        expect(repeated.ok).toBe(false);
        if (!repeated.ok) {
            expect(repeated.errors.some((failure) => failure.message.includes('more than once'))).toBe(true);
        }

        const valueless = parseSchemaDiffArgs(['create-only', '--name']);
        expect(valueless.ok).toBe(false);
        if (!valueless.ok) {
            expect(valueless.errors.some((failure) => failure.message.includes('requires a migration name'))).toBe(true);
        }
    });

    it('skips dbGuard\'s --confirm-target instead of rejecting it, in either spelling', () => {
        expect(parseSchemaDiffArgs(['diff', '--confirm-target', 'soh_shadow'])).toEqual({
            ok: true,
            options: { help: false, mode: 'diff', migrationName: null },
        });
        expect(parseSchemaDiffArgs(['diff', '--confirm-target=soh_shadow'])).toEqual({
            ok: true,
            options: { help: false, mode: 'diff', migrationName: null },
        });
    });

    it('short-circuits on help, before the mode is required', () => {
        for (const flag of ['--help', '-h']) {
            expect(parseSchemaDiffArgs([flag])).toEqual({
                ok: true,
                options: { help: true, mode: null, migrationName: null },
            });
        }
    });

    // The usage block is the only place an operator reads the exit-code
    // vocabulary, and getting 2 wrong there is worse than not printing it.
    it('documents the exit codes and the non-empty-target measurement in its usage', () => {
        const usage = describeUsage();
        expect(usage).toContain(`${PRISMA_DIFFERENCES_EXIT_CODE}   differences exist`);
        expect(usage).toContain(
            `${SCHEMA_DIFF_REFUSED_EXIT_CODE}   this wrapper stopped the run and no Prisma verdict was produced`,
        );
        expect(usage).toContain('A non-empty target is NOT exit 1');
        expect(usage).toContain('SHADOW_DATABASE_URL');
        expect(usage).toContain('DATABASE_URL is deleted from the child environment');
    });

    // THE EXIT CODES AS THIS WRAPPER EXITS, not as raw Prisma does. Measured:
    // SHADOW_DATABASE_URL on an unreachable port exits 3 with no Prisma
    // invocation, because the `pg` read-back reaches the failure first — so
    // P1001, P1003 and P1000 are this wrapper's 3 and exit 1 is what is left
    // once the read-back has already succeeded.
    it('puts the connection, authentication and missing-database failures under the refusal code', () => {
        const usage = describeUsage();
        const refused = usage.slice(usage.indexOf(`  ${SCHEMA_DIFF_REFUSED_EXIT_CODE}   this wrapper stopped the run`));
        const failed = usage.slice(usage.indexOf('  1   Prisma itself failed'), usage.indexOf(`  ${SCHEMA_DIFF_REFUSED_EXIT_CODE}   this wrapper stopped the run`));

        expect(refused).toContain('P1001');
        expect(refused).toContain('P1003');
        expect(refused).toContain('P1000');
        expect(refused).toContain('occupancy or row-security refusal');
        expect(failed).toContain('AFTER the read-back had already succeeded');
        expect(failed).toContain('P3006');
        expect(failed).not.toContain('P1001');

        // The "nothing was opened" claim belongs to the string-level refusals
        // only: the read-back, occupancy and row-security refusals and
        // prisma_unavailable all happen after a connection was opened.
        expect(refused).toContain('No connection is opened for the');
        expect(refused).toContain('string-level refusals');
    });

    // The guarantee the code actually makes, in the words the CI gate and the
    // committed evidence use.
    it('states the occupancy guarantee as the reached public schema rather than the database', () => {
        const usage = describeUsage();

        expect(usage).toContain('no ordinary or');
        expect(usage).toContain('partitioned base table of the reached public schema holds a');
        expect(usage).toContain('rather than a guarantee that the database is empty');
        expect(usage).toContain('certified with row security OFF');
    });

    it('names the environment variable each mode guards', () => {
        expect(targetEnvNameFor('diff')).toBe('SHADOW_DATABASE_URL');
        expect(targetEnvNameFor('create-only')).toBe('DATABASE_URL');
    });
});

// ---------------------------------------------------------------------------
// Seam 1 — the URL guard, through the real dbGuard.
// ---------------------------------------------------------------------------

describe('the shadow-database guard refuses before anything is opened', () => {
    // Every refusal `evaluateShadowDatabase` can produce, each reached by
    // setting the variable the way an operator would get it wrong.
    const cases: { readonly name: string; readonly url: string | undefined; readonly code: string }[] = [
        { name: 'an unset variable', url: undefined, code: 'missing_database_url' },
        { name: 'a blank variable', url: '   ', code: 'missing_database_url' },
        { name: 'a value that is not a URL', url: 'soh_shadow', code: 'unparsable_database_url' },
        { name: 'a URL naming no database', url: 'postgresql://soh:secret@127.0.0.1:5433', code: 'unparsable_database_url' },
        {
            name: 'a connection parameter that can move the target',
            url: 'postgresql://soh:secret@127.0.0.1:5433/soh_shadow_34?host=other',
            code: 'ambiguous_database_url',
        },
        {
            name: 'a percent-encoded database name',
            url: 'postgresql://soh:secret@127.0.0.1:5433/soh%5Fshadow',
            code: 'ambiguous_database_url',
        },
        {
            name: 'a schema-redirecting query parameter',
            url: 'postgresql://soh:secret@127.0.0.1:5433/soh_shadow_34?options=-c%20search_path%3Dlive',
            code: 'ambiguous_database_url',
        },
        {
            name: 'a shadow name on a remote host',
            url: 'postgresql://soh:secret@db.example.com:5432/soh_shadow',
            code: 'shadow_required',
        },
        {
            name: 'a development database',
            url: DEVELOPMENT_URL,
            code: 'shadow_required',
        },
        {
            name: 'a test database',
            url: 'postgresql://soh:secret@127.0.0.1:5433/soh_test_34',
            code: 'shadow_required',
        },
    ];

    for (const testCase of cases) {
        it(`refuses ${testCase.name} with ${testCase.code}, opening nothing and spawning nothing`, async () => {
            const harness = untouchedHarness();
            const env: NodeJS.ProcessEnv = {};
            if (testCase.url !== undefined) {
                env.SHADOW_DATABASE_URL = testCase.url;
            }

            const error = await refusal({ mode: 'diff', env, harness });

            expect(error).toBeInstanceOf(DatabaseOriginError);
            expect((error as DatabaseOriginError).code).toBe(testCase.code);
            expect(harness.connections).toHaveLength(0);
            expect(harness.invocations).toHaveLength(0);
            expect(harness.events).toEqual([]);
        });
    }

    it('names SHADOW_DATABASE_URL rather than DATABASE_URL in its refusal', async () => {
        const harness = untouchedHarness();
        const error = await refusal({ mode: 'diff', env: { DATABASE_URL: DEVELOPMENT_URL }, harness });

        expect((error as Error).message).toContain('SHADOW_DATABASE_URL');
        // Every mention must be the SHADOW variable: an operator sent to fix
        // `DATABASE_URL` when `SHADOW_DATABASE_URL` is what is wrong has been
        // sent to the wrong line of their .env.
        expect((error as Error).message.replace(/SHADOW_DATABASE_URL/g, '<shadow>')).not.toContain('DATABASE_URL');
    });

    // The reset target is SHADOW_DATABASE_URL, so a DATABASE_URL the pipeline
    // guard would refuse must not refuse the diff: the value is deleted from
    // the child environment a few lines later.
    it('ignores DATABASE_URL entirely in diff mode', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', tables: ['users'], occupied: [] });
        const { outcome } = await run({
            mode: 'diff',
            env: {
                SHADOW_DATABASE_URL: SHADOW_URL,
                DATABASE_URL: 'postgresql://app:secret@production.example.com:5432/state_of_health',
            },
            harness,
        });

        expect(outcome.verdict).toBe('differences_found');
        expect(harness.invocations).toHaveLength(1);
        expect(Object.prototype.hasOwnProperty.call(harness.invocations[0].env, 'DATABASE_URL')).toBe(false);
    });
});

describe('create-only holds DATABASE_URL to development by name', () => {
    const cases: { readonly name: string; readonly url: string | undefined; readonly code: string }[] = [
        { name: 'an unset variable', url: undefined, code: 'missing_database_url' },
        { name: 'a remote host', url: 'postgresql://app:secret@db.example.com:5432/soh_dev', code: 'unrecognised_origin' },
        { name: 'a test database', url: 'postgresql://soh:secret@127.0.0.1:5433/soh_test_34', code: 'development_only' },
        { name: 'a shadow database', url: SHADOW_URL, code: 'shadow_database' },
        {
            name: 'a loopback database that is development by its host alone',
            url: 'postgresql://app:secret@127.0.0.1:5433/state_of_health',
            code: 'development_only',
        },
    ];

    for (const testCase of cases) {
        it(`refuses ${testCase.name} with ${testCase.code}, opening nothing and spawning nothing`, async () => {
            const harness = untouchedHarness();
            const env: NodeJS.ProcessEnv = {};
            if (testCase.url !== undefined) {
                env.DATABASE_URL = testCase.url;
            }

            const error = await refusal({ mode: 'create-only', migrationName: 'probe', env, harness });

            expect(error).toBeInstanceOf(DatabaseOriginError);
            expect((error as DatabaseOriginError).code).toBe(testCase.code);
            expect(harness.connections).toHaveLength(0);
            expect(harness.invocations).toHaveLength(0);
        });
    }

    // dbGuard composes this refusal from its policy TABLE ("is not a known
    // pipeline script, so it falls back to the strictest policy"), which is
    // true of the lookup and misleading here: the absence of this entry point
    // from that table is deliberate. The wrapper replaces that one sentence
    // with the reason that actually applies.
    it('explains the policy through the command rather than through the policy table', async () => {
        const harness = untouchedHarness();
        const error = await refusal({
            mode: 'create-only',
            migrationName: 'probe',
            env: { DATABASE_URL: 'postgresql://soh:secret@127.0.0.1:5433/soh_test_34' },
            harness,
        });

        const message = (error as Error).message;
        expect(message).toContain('prisma migrate dev');
        expect(message).toContain('resets the database it is pointed at if it finds drift');
        expect(message).toContain('_dev');
        expect(message).not.toContain('not a known pipeline script');
    });

    it('accepts a development database by name, with or without a clone index', async () => {
        for (const url of ['postgresql://soh:secret@localhost:5432/soh_dev', DEVELOPMENT_URL]) {
            const harness = harnessFor(
                { database: url.slice(url.lastIndexOf('/') + 1), tables: ['users'], occupied: ['users'] },
                { exitCode: 0, signal: null, stderr: '' },
            );
            const { outcome } = await run({
                mode: 'create-only',
                migrationName: 'meal_planning',
                env: { DATABASE_URL: url },
                harness,
            });

            expect(outcome.verdict).toBe('migration_created');
            expect(harness.invocations).toHaveLength(1);
        }
    });
});

// ---------------------------------------------------------------------------
// Seam 2 — the read-back.
// ---------------------------------------------------------------------------

describe('the read-back over a real connection', () => {
    const diffEnv = { SHADOW_DATABASE_URL: SHADOW_URL };

    it('asks the target what it is, and records the server without comparing it', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', tables: ['users', 'meals'], occupied: [] });
        const { outcome, lines } = await run({ env: diffEnv, harness });

        expect(harness.connections).toHaveLength(1);
        expect(harness.connections[0].connectionString).toBe(SHADOW_URL);
        expect(harness.connections[0].closed).toBe(true);

        const target: SchemaDiffTarget = outcome.target;
        expect(target).toMatchObject({
            host: '127.0.0.1',
            database: 'soh_shadow_34',
            schema: 'public',
            serverAddress: '172.17.0.2/32',
            serverPort: 5432,
            tablesInSchema: 2,
            occupiedTables: [],
            rowSecurityProtectedTables: [],
        });

        // Measured: through a container's published port the server reports its
        // own address and port (172.17.0.2:5432) while the URL names the
        // published pair (127.0.0.1:5433). The read-back must therefore record
        // them and pass, never compare them and refuse.
        expect(outcome.verdict).toBe('differences_found');
        expect(lines.some((line) => line.event === 'target_verified')).toBe(true);
    });

    it('refuses when the connection reaches a different database than the URL names', async () => {
        const harness = harnessFor({ database: 'state_of_health' });
        const error = await refusal({ env: diffEnv, harness });

        expect(error).toBeInstanceOf(SchemaDiffError);
        expect((error as SchemaDiffError).code).toBe('target_database_mismatch');
        expect((error as Error).message).toContain('reached "state_of_health"');
        expect(harness.invocations).toHaveLength(0);
        expect(harness.connections[0].closed).toBe(true);
    });

    // The refusal no URL parse can make: `ALTER ROLE … SET search_path` and
    // `ALTER DATABASE … SET search_path` move the schema server-side, where the
    // URL shows nothing, and the replay's unqualified DDL would follow it.
    it('refuses when an unqualified statement resolves outside the public schema', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', schema: 'live', searchPath: 'live' });
        const error = await refusal({ env: diffEnv, harness });

        expect((error as SchemaDiffError).code).toBe('target_schema_redirected');
        expect((error as Error).message).toContain('resolves in schema "live"');
        expect((error as Error).message).toContain('RESET search_path');
        expect(harness.invocations).toHaveLength(0);
    });

    it('refuses to reset a target that holds rows, naming the tables', async () => {
        const harness = harnessFor({
            database: 'soh_shadow_34',
            tables: ['grocery_items', 'meals', 'users'],
            occupied: ['users', 'meals'],
        });
        const error = await refusal({ env: diffEnv, harness });

        expect((error as SchemaDiffError).code).toBe('target_not_disposable');
        expect((error as Error).message).toContain('holds rows in 2 of the 3 base table(s) of schema "public"');
        expect((error as Error).message).toContain('meals, users');
        expect(harness.invocations).toHaveLength(0);
    });

    it('summarises rather than listing every occupied table', async () => {
        const tables = Array.from({ length: 14 }, (_value, index) => `table_${String(index).padStart(2, '0')}`);
        const harness = harnessFor({ database: 'soh_shadow_34', tables, occupied: tables });
        const error = await refusal({ env: diffEnv, harness });

        expect((error as Error).message).toContain('and 4 more');
    });

    it('asks the occupancy question once per table, as an EXISTS that stops at the first row', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', tables: ['users', 'meals'], occupied: [] });
        await run({ env: diffEnv, harness });

        const occupancy = harness.connections[0].queries.filter((text) => text.includes('WHERE EXISTS'));
        expect(occupancy).toHaveLength(1);
        expect(occupancy[0]).toContain('SELECT 1 FROM "public"."users"');
        expect(occupancy[0]).toContain('SELECT 1 FROM "public"."meals"');
        expect(occupancy[0]).toContain('UNION ALL');
    });

    // An empty schema has nothing to ask about, and a statement built from an
    // empty list would be invalid SQL.
    it('skips the occupancy statement when the schema holds no table', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', tables: [] });
        const { outcome } = await run({ env: diffEnv, harness });

        expect(harness.connections[0].queries.some((text) => text.includes('WHERE EXISTS'))).toBe(false);
        expect(outcome.target.tablesInSchema).toBe(0);
        expect(harness.invocations).toHaveLength(1);
    });

    // ---------------------------------------------------------------------
    // Row-level security, and why the occupancy check has to fail closed.
    //
    // MEASURED on PostgreSQL 16.15 before this was in place: a
    // `NOSUPERUSER NOBYPASSRLS` role owning `public.operator_rows`, one row in
    // it, `ENABLE` + `FORCE ROW LEVEL SECURITY` and a `USING (false)` policy —
    // the wrapper logged `tablesInSchema: 1`, judged the target disposable,
    // spawned Prisma, exited 2, and afterwards
    // `to_regclass('public.operator_rows')` was NULL. The relation and the row
    // nobody could see were both gone. A query that obeys row security cannot
    // certify a relation empty, because the role that owns the relation can
    // still drop it.
    // ---------------------------------------------------------------------

    it('turns row security off before it asks anything about the target content', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', tables: ['users'], occupied: [] });
        const { outcome, lines } = await run({ env: diffEnv, harness });

        const queries = harness.connections[0].queries;
        expect(queries[0]).toBe(ROW_SECURITY_OFF);
        expect(queries.findIndex((text) => text.includes('current_database()'))).toBeGreaterThan(0);
        expect(queries.findIndex((text) => text.includes('WHERE EXISTS'))).toBeGreaterThan(0);
        expect(outcome.verdict).toBe('differences_found');

        // The log has to say the check ran with row security off and found no
        // policy-protected relation, or "verified" is an unexamined word.
        const verified = lines.find((line) => line.event === 'target_verified');
        expect(verified?.fields).toMatchObject({ rowSecurityDisabledForCheck: true, rowSecurityProtectedTables: 0 });
    });

    it('refuses a relation whose rows a policy could hide, without asking whether it holds rows', async () => {
        const harness = harnessFor({
            database: 'soh_shadow_34',
            tables: ['operator_rows', 'users'],
            rowSecurityEnabled: ['operator_rows'],
            occupied: [],
        });
        const error = await refusal({ env: diffEnv, harness });

        expect(error).toBeInstanceOf(SchemaDiffError);
        expect((error as SchemaDiffError).code).toBe('target_row_security');
        expect((error as Error).message).toContain('row-level security');
        expect((error as Error).message).toContain('operator_rows');
        // Asking would have produced an answer that means nothing, and the
        // refusal must not depend on that answer.
        expect(harness.connections[0].queries.some((text) => text.includes('WHERE EXISTS'))).toBe(false);
        expect(harness.invocations).toHaveLength(0);
    });

    it('refuses a relation with row security FORCED on its own owner', async () => {
        const harness = harnessFor({
            database: 'soh_shadow_34',
            tables: ['operator_rows'],
            rowSecurityForced: ['operator_rows'],
            occupied: [],
        });
        const error = await refusal({ env: diffEnv, harness });

        expect((error as SchemaDiffError).code).toBe('target_row_security');
        expect(harness.invocations).toHaveLength(0);
    });

    // The fail-closed branch of the flag reader: BASE_TABLE_QUERY asks for both
    // columns by name, so an answer without them is an unanswered question, and
    // an unanswered question about row security cannot certify a relation empty.
    it('refuses when the catalog answer carries no row-security state at all', async () => {
        const harness = harnessFor({
            database: 'soh_shadow_34',
            tables: ['users'],
            omitRowSecurityColumns: true,
            occupied: [],
        });
        const error = await refusal({ env: diffEnv, harness });

        expect((error as SchemaDiffError).code).toBe('target_row_security');
        expect(harness.invocations).toHaveLength(0);
    });

    // The second half of the fix, and the one the catalog read cannot make: a
    // relation that gains a policy between the two statements, or any other
    // reason the occupancy question cannot be answered, must REFUSE. A thrown
    // error falling through to "no rows found" is the original defect.
    it('refuses rather than certifying empty when the occupancy statement itself fails', async () => {
        const harness = harnessFor({
            database: 'soh_shadow_34',
            tables: ['operator_rows'],
            failOccupancy: ROW_SECURITY_ERROR,
        });
        const error = await refusal({ env: diffEnv, harness });

        expect(error).toBeInstanceOf(SchemaDiffError);
        expect((error as SchemaDiffError).code).toBe('target_not_disposable');
        expect((error as Error).message).toContain('row-level security policy for table "operator_rows"');
        expect((error as Error).message).toContain('refusal rather than an empty target');
        expect(harness.invocations).toHaveLength(0);
        expect(harness.connections[0].closed).toBe(true);
    });

    // Rows are the whole point of a development database, so the occupancy
    // check belongs to the RESET target only.
    it('does not ask the occupancy question for create-only', async () => {
        const harness = harnessFor({ database: 'soh_dev_34', tables: ['users'], occupied: ['users'] }, { exitCode: 0, signal: null, stderr: '' });
        const { outcome } = await run({
            mode: 'create-only',
            migrationName: 'meal_planning',
            env: { DATABASE_URL: DEVELOPMENT_URL },
            harness,
        });

        expect(harness.connections[0].queries.some((text) => text.includes('WHERE EXISTS'))).toBe(false);
        expect(outcome.verdict).toBe('migration_created');
        // Nor is row security touched: nothing is being certified empty here,
        // and a development database is entitled to its policies.
        expect(harness.connections[0].queries).not.toContain(ROW_SECURITY_OFF);
    });

    // The same relation state that refuses the reset target is recorded and
    // allowed for the database `create-only` only reads and migrates.
    it('records a policy-protected relation for create-only instead of refusing it', async () => {
        const harness = harnessFor(
            {
                database: 'soh_dev_34',
                tables: ['operator_rows', 'users'],
                rowSecurityEnabled: ['operator_rows'],
            },
            { exitCode: 0, signal: null, stderr: '' },
        );
        const { outcome } = await run({
            mode: 'create-only',
            migrationName: 'meal_planning',
            env: { DATABASE_URL: DEVELOPMENT_URL },
            harness,
        });

        expect(outcome.verdict).toBe('migration_created');
        expect(outcome.target.rowSecurityProtectedTables).toEqual(['operator_rows']);
    });

    it('refuses when the target cannot be connected to, carrying the driver message', async () => {
        const harness = harnessFor({
            database: 'soh_shadow_34',
            failConnect: new Error('connect ECONNREFUSED 127.0.0.1:5433'),
        });
        const error = await refusal({ env: diffEnv, harness });

        expect((error as SchemaDiffError).code).toBe('target_unreadable');
        expect((error as Error).message).toContain('ECONNREFUSED');
        expect(harness.invocations).toHaveLength(0);
        expect(harness.connections[0].closed).toBe(true);
    });

    it('refuses when the read-back statement itself fails', async () => {
        const harness = harnessFor({
            database: 'soh_shadow_34',
            failIdentity: new Error('permission denied for function inet_server_addr'),
        });
        const error = await refusal({ env: diffEnv, harness });

        expect((error as SchemaDiffError).code).toBe('target_unreadable');
        expect((error as Error).message).toContain('permission denied');
        expect(harness.invocations).toHaveLength(0);
    });

    it('refuses when the server answers nothing about itself', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', emptyIdentity: true });
        const error = await refusal({ env: diffEnv, harness });

        expect((error as SchemaDiffError).code).toBe('target_unreadable');
        expect((error as Error).message).toContain('no row for its own identity');
        expect(harness.invocations).toHaveLength(0);
    });

    // A failed hang-up must not replace the verdict: the refusal is the
    // artefact of the run, and `end()` is called from a finally.
    it('keeps the verdict when closing the connection fails', async () => {
        const harness = harnessFor({ database: 'state_of_health', failEnd: new Error('Connection terminated') });
        const error = await refusal({ env: diffEnv, harness });

        expect((error as SchemaDiffError).code).toBe('target_database_mismatch');
        expect(harness.invocations).toHaveLength(0);
    });

    // The order IS the contract: read back, hang up, then spawn.
    it('closes the read-back connection before Prisma is spawned', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', tables: [] });
        await run({ env: diffEnv, harness });

        expect(harness.events).toEqual(['open', 'connect', 'end', 'spawn']);
    });
});

// ---------------------------------------------------------------------------
// Seam 3 — the invocation.
// ---------------------------------------------------------------------------

describe('buildPrismaInvocation', () => {
    const base = {
        migrationName: null,
        shadowDatabaseUrl: SHADOW_URL,
        packageRoot: PACKAGE_ROOT,
        nodeExecutable: NODE_EXECUTABLE,
        prismaCliPath: PRISMA_CLI,
    };

    // The exact command 0.9.1 prescribes, fixed here rather than typed by an
    // operator, and run from the package root because both paths are relative
    // to it — a run from another directory would diff nothing and report that
    // the ledger and the datamodel agree.
    it('builds the 0.9.1 diff command verbatim, from the package root', () => {
        const invocation = buildPrismaInvocation({ ...base, mode: 'diff', env: {} });

        expect(invocation.command).toBe(NODE_EXECUTABLE);
        expect(invocation.args).toEqual([
            PRISMA_CLI,
            'migrate',
            'diff',
            '--from-migrations',
            'prisma/migrations',
            '--to-schema-datamodel',
            'prisma/schema.prisma',
            '--shadow-database-url',
            SHADOW_URL,
            '--exit-code',
            '--script',
        ]);
        expect(invocation.cwd).toBe(PACKAGE_ROOT);
    });

    // Measured: the diff exits 2 under `env -u DATABASE_URL`, so the variable
    // is removed rather than passed on — which removes the whole class of
    // accident where a deployment DATABASE_URL is sitting in the shell.
    it('deletes DATABASE_URL from the diff child environment and leaves everything else', () => {
        const invocation = buildPrismaInvocation({
            ...base,
            mode: 'diff',
            env: { DATABASE_URL: 'postgresql://app:secret@production.example.com:5432/state_of_health', PATH: '/usr/bin', NODE_ENV: 'development' },
        });

        expect(Object.prototype.hasOwnProperty.call(invocation.env, 'DATABASE_URL')).toBe(false);
        expect(invocation.env.PATH).toBe('/usr/bin');
        expect(invocation.env.NODE_ENV).toBe('development');
    });

    it('does not mutate the environment it was handed', () => {
        const env = { DATABASE_URL: DEVELOPMENT_URL };
        buildPrismaInvocation({ ...base, mode: 'diff', env });

        expect(env.DATABASE_URL).toBe(DEVELOPMENT_URL);
    });

    // `migrate dev` reads the migration state of DATABASE_URL, creates and
    // drops a temporary shadow database on its server, and resets that database
    // on drift — so it keeps the variable, and the guard has already held it to
    // development-by-name.
    it('keeps DATABASE_URL for create-only and passes the migration name', () => {
        const invocation = buildPrismaInvocation({
            ...base,
            mode: 'create-only',
            migrationName: 'meal_planning',
            env: { DATABASE_URL: DEVELOPMENT_URL },
        });

        expect(invocation.args).toEqual([PRISMA_CLI, 'migrate', 'dev', '--create-only', '--name', 'meal_planning']);
        expect(invocation.env.DATABASE_URL).toBe(DEVELOPMENT_URL);
        // Measured against prisma 6.9.0: `migrate dev` has no
        // --shadow-database-url flag, and prisma/schema.prisma declares no
        // shadowDatabaseUrl, so the shadow URL must not appear here — it would
        // be an argument the CLI rejects.
        expect(invocation.args).not.toContain('--shadow-database-url');
        expect(invocation.args).not.toContain(SHADOW_URL);
    });
});

describe('buildOccupancyStatement', () => {
    it('asks for existence rather than a count, one branch per table', () => {
        expect(buildOccupancyStatement('public', ['users'])).toBe(
            'SELECT \'users\' AS table_name WHERE EXISTS (SELECT 1 FROM "public"."users")',
        );
    });

    // The names come out of pg_class, so they are quoted as identifiers and as
    // literals rather than interpolated: a relation named with a quote
    // character must produce valid SQL, not a syntax error at the moment the
    // guard is most needed.
    it('quotes identifiers and literals', () => {
        const statement = buildOccupancyStatement('we"ird', ["o'clock"]);

        expect(statement).toContain('"we""ird"');
        expect(statement).toContain('"o\'clock"');
        expect(statement).toContain("'o''clock' AS table_name");
    });

    it('unions one branch per table', () => {
        const statement = buildOccupancyStatement('public', ['a', 'b', 'c']);

        expect(statement.split('UNION ALL')).toHaveLength(3);
    });
});

// ---------------------------------------------------------------------------
// Seam 4 — the exit-code vocabulary.
// ---------------------------------------------------------------------------

describe('describeRun', () => {
    const origin = { originClass: 'shadow' as const, host: '127.0.0.1', database: 'soh_shadow_34', reason: 'x' };
    const target: SchemaDiffTarget = {
        host: '127.0.0.1',
        database: 'soh_shadow_34',
        schema: 'public',
        role: 'soh',
        serverVersion: 'PostgreSQL 16.15',
        serverAddress: '172.17.0.2/32',
        serverPort: 5432,
        searchPath: 'public',
        tablesInSchema: 0,
        occupiedTables: [],
        rowSecurityProtectedTables: [],
    };

    const describe_ = (mode: SchemaDiffMode, result: PrismaRunResult) => {
        const { logger, lines } = recordingLogger();
        return { outcome: describeRun({ mode, origin, target, result, logger }), lines };
    };

    // 2 is the success case and the gate decides on it, so it is passed through
    // rather than normalised to 0.
    it('reads the diff\'s exit 2 as the expected result and passes it through', () => {
        const { outcome, lines } = describe_('diff', { exitCode: 2, signal: null, stderr: '' });

        expect(outcome).toMatchObject({ verdict: 'differences_found', exitCode: 2 });
        expect(lines.some((line) => line.event === 'schema_differences_found' && line.level === 'info')).toBe(true);
    });

    it('reads the diff\'s exit 0 as a stale committed capture, and says so', () => {
        const { outcome, lines } = describe_('diff', { exitCode: 0, signal: null, stderr: '' });

        expect(outcome).toMatchObject({ verdict: 'no_differences', exitCode: 0 });
        const line = lines.find((entry) => entry.event === 'schema_no_differences');
        expect(line?.level).toBe('error');
        expect(JSON.stringify(line?.fields)).toContain('expected-schema-diff.sql');
    });

    // Exit 1 means Prisma failed AFTER a successful read-back, so P1001, P1003
    // and P1000 must NOT be named here: the read-back reaches those first and
    // the wrapper exits 3 without invoking Prisma at all (measured).
    it('reads exit 1 as a Prisma failure after a successful read-back, naming only the residual causes', () => {
        const { outcome, lines } = describe_('diff', { exitCode: 1, signal: null, stderr: 'Error: P3006' });

        expect(outcome).toMatchObject({ verdict: 'command_failed', exitCode: 1 });
        const fields = JSON.stringify(lines.find((entry) => entry.event === 'prisma_failed')?.fields);
        expect(fields).toContain('after the read-back had already succeeded');
        expect(fields).toContain('P3006');
        expect(fields).not.toContain('P1001');
        expect(fields).not.toContain('P1003');
        expect(fields).not.toContain('P1000');
    });

    it('reports a killed child as a failure rather than as a verdict', () => {
        const { outcome, lines } = describe_('diff', { exitCode: null, signal: 'SIGKILL', stderr: '' });

        expect(outcome).toMatchObject({ verdict: 'command_failed', exitCode: 1 });
        expect(lines.some((line) => line.event === 'prisma_terminated')).toBe(true);
    });

    it('reads create-only\'s codes on their own terms', () => {
        expect(describe_('create-only', { exitCode: 0, signal: null, stderr: '' }).outcome).toMatchObject({
            verdict: 'migration_created',
            exitCode: 0,
        });
        expect(describe_('create-only', { exitCode: 1, signal: null, stderr: '' }).outcome).toMatchObject({
            verdict: 'command_failed',
            exitCode: 1,
        });
    });
});

// ---------------------------------------------------------------------------
// The whole run.
// ---------------------------------------------------------------------------

describe('runSchemaDiff', () => {
    it('guards, reads back and spawns once, in that order, and reports the target it verified', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', tables: ['users'], occupied: [] });
        const { outcome, lines } = await run({ env: { SHADOW_DATABASE_URL: SHADOW_URL }, harness });

        expect(harness.events).toEqual(['open', 'connect', 'end', 'spawn']);
        expect(outcome).toMatchObject({
            mode: 'diff',
            verdict: 'differences_found',
            exitCode: PRISMA_DIFFERENCES_EXIT_CODE,
        });
        expect(outcome.origin.originClass).toBe('shadow');
        expect(outcome.target.database).toBe('soh_shadow_34');

        // The URL carries a password in its userinfo, so the logged argument
        // list must not carry the URL itself.
        const invoked = lines.find((line) => line.event === 'prisma_invoked');
        expect(JSON.stringify(invoked?.fields)).toContain('<validated-url>');
        expect(JSON.stringify(invoked?.fields)).not.toContain('secret');
    });

    it('runs create-only against a development database and keeps DATABASE_URL for it', async () => {
        const harness = harnessFor(
            { database: 'soh_dev_34', tables: ['users'], occupied: ['users'] },
            { exitCode: 0, signal: null, stderr: '' },
        );
        const { outcome } = await run({
            mode: 'create-only',
            migrationName: 'meal_planning',
            env: { DATABASE_URL: DEVELOPMENT_URL },
            harness,
        });

        expect(outcome).toMatchObject({ mode: 'create-only', verdict: 'migration_created', exitCode: 0 });
        expect(harness.invocations[0].env.DATABASE_URL).toBe(DEVELOPMENT_URL);
        expect(harness.invocations[0].args).toContain('--create-only');
    });

    it('passes a failed Prisma run through as its own exit code', async () => {
        const harness = harnessFor({ database: 'soh_shadow_34', tables: [] }, { exitCode: 1, signal: null, stderr: 'Error: P3006' });
        const { outcome } = await run({ env: { SHADOW_DATABASE_URL: SHADOW_URL }, harness });

        expect(outcome).toMatchObject({ verdict: 'command_failed', exitCode: 1 });
    });
});

// ---------------------------------------------------------------------------
// THE ROW-SECURITY REGRESSION, AGAINST A REAL POSTGRESQL TARGET.
//
// Everything above runs on injected doubles, which is right for the decisions
// the wrapper makes but cannot settle the one that was actually wrong: whether
// PostgreSQL's own answer to the occupancy question can be trusted. It could
// not. Reproduced on PostgreSQL 16.15 before the fix — a `NOSUPERUSER
// NOBYPASSRLS` role owning `public.operator_rows`, one row in it, `ENABLE` plus
// `FORCE ROW LEVEL SECURITY` and a `USING (false)` policy — the wrapper logged
// `tablesInSchema: 1`, judged the target disposable, spawned Prisma, exited 2,
// and afterwards `to_regclass('public.operator_rows')` was NULL: the relation
// and the row nobody could see were both gone.
//
// So this block builds that database for real and asserts the refusal AND the
// survival of the row. Prisma is the one thing still injected, because the
// assertion is that it is never reached; a real spawn here would destroy the
// evidence the test exists to check.
//
// EVERY OBJECT IT CREATES IT DROPS. Three probe databases and one login role,
// all named with a per-process suffix so concurrent runs cannot collide, all
// created in `beforeAll` and dropped in `afterAll` — the suite touches no
// database anybody else provisioned, and `DATABASE_URL` is read only to learn
// which server to build them on.
// ---------------------------------------------------------------------------

// A narrow typed surface over node-postgres, for the two things this block does
// that no injected double can: CREATE/DROP DATABASE and ROLE, and reading the
// probe back as the role that owns it. `pg` is a runtime dependency of this
// service but ships no type declarations, and @types/pg is deliberately not
// added for a handful of test files — this mirrors the declarations in
// `src/__tests__/api/compat.test.ts` and `src/__tests__/api/catalogCollation.test.ts`
// for the same reason.
interface ProbeQueryResult<TRow> {
    rows: TRow[];
}

interface ProbeClient {
    connect(): Promise<void>;
    query<TRow = Record<string, unknown>>(text: string): Promise<ProbeQueryResult<TRow>>;
    end(): Promise<void>;
}

interface ProbePgModule {
    Client: new (config: { connectionString: string }) => ProbeClient;
}

// eslint-disable-next-line @typescript-eslint/no-var-requires -- see the note above
const probePg = require('pg') as ProbePgModule;

/** The role that reproduces the trap: it owns the relation and cannot bypass its policies. */
const PROBE_PASSWORD = 'rls-probe-password';

/**
 * Per-process, because the suite may run beside other clones on one server and
 * a fixed name would make two runs fight over one database.
 */
const PROBE_SUFFIX = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 6)}`;
const PROBE_ROLE = `soh_rlsprobe_${PROBE_SUFFIX}`;

/** Every probe database name ends `_shadow`: dbGuard refuses the diff anything else. */
const PROBE_DATABASES = {
    rowSecurity: `soh_rlsprobe_${PROBE_SUFFIX}_rls_shadow`,
    occupied: `soh_rlsprobe_${PROBE_SUFFIX}_rows_shadow`,
    empty: `soh_rlsprobe_${PROBE_SUFFIX}_none_shadow`,
} as const;

/** SQL identifier quoting for the names this block composes. */
const quoted = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

/**
 * The server the suite's own `DATABASE_URL` names, pointed at `postgres` and
 * stripped of any query string: `CREATE DATABASE` cannot run inside the
 * database it creates, and a `?schema=` parameter would follow the connection
 * into the maintenance session.
 */
const maintenanceUrl = (): string => {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
        throw new Error(
            'the row-security regression needs DATABASE_URL to name the PostgreSQL server the probe ' +
                'databases are built on; run the suite the way jest.config.ts documents.',
        );
    }

    const url = new URL(databaseUrl);
    url.pathname = '/postgres';
    url.search = '';
    return url.toString();
};

/** The same server, addressed as the probe role, for one probe database. */
const probeUrlFor = (database: string): string => {
    const url = new URL(maintenanceUrl());
    url.username = PROBE_ROLE;
    url.password = PROBE_PASSWORD;
    url.pathname = `/${database}`;
    return url.toString();
};

/** One connection, one statement list, closed whatever happens. */
const onConnection = async (connectionString: string, statements: readonly string[]): Promise<void> => {
    const client = new probePg.Client({ connectionString });
    await client.connect();
    try {
        for (const statement of statements) {
            await client.query(statement);
        }
    } finally {
        await client.end();
    }
};

const queryOnConnection = async <TRow extends Record<string, unknown>>(
    connectionString: string,
    statement: string,
): Promise<TRow[]> => {
    const client = new probePg.Client({ connectionString });
    await client.connect();
    try {
        const result = await client.query<TRow>(statement);
        return result.rows;
    } finally {
        await client.end();
    }
};

interface RealRunResult {
    readonly error: unknown;
    readonly outcome: SchemaDiffOutcome | null;
    readonly spawned: PrismaInvocation[];
}

/**
 * The wrapper against a real target, with the REAL `pg` read-back and an
 * injected Prisma runner that records rather than runs.
 */
const runAgainstProbe = async (database: string): Promise<RealRunResult> => {
    const { logger } = recordingLogger();
    const spawned: PrismaInvocation[] = [];

    try {
        const outcome = await runSchemaDiff({
            mode: 'diff',
            migrationName: null,
            env: { SHADOW_DATABASE_URL: probeUrlFor(database) },
            logger,
            openConnection: openPostgresConnection,
            runPrisma: async (invocation: PrismaInvocation): Promise<PrismaRunResult> => {
                spawned.push(invocation);
                return { exitCode: PRISMA_DIFFERENCES_EXIT_CODE, signal: null, stderr: '' };
            },
            packageRoot: PACKAGE_ROOT,
            nodeExecutable: NODE_EXECUTABLE,
            prismaCliPath: PRISMA_CLI,
        });
        return { error: null, outcome, spawned };
    } catch (error) {
        return { error, outcome: null, spawned };
    }
};

describe('the occupancy check against a real PostgreSQL target', () => {
    const PROBE_SETUP_TIMEOUT_MS = 60_000;
    const PROBE_TEST_TIMEOUT_MS = 30_000;

    beforeAll(async () => {
        const admin = maintenanceUrl();

        // Idempotent, so a run interrupted before its teardown does not block
        // the next one on this server.
        await onConnection(admin, [
            ...Object.values(PROBE_DATABASES).map((database) => `DROP DATABASE IF EXISTS ${quoted(database)}`),
            `DROP ROLE IF EXISTS ${quoted(PROBE_ROLE)}`,
            `CREATE ROLE ${quoted(PROBE_ROLE)} LOGIN PASSWORD '${PROBE_PASSWORD}' NOSUPERUSER NOBYPASSRLS ` +
                'NOCREATEDB NOCREATEROLE',
            ...Object.values(PROBE_DATABASES).map(
                (database) => `CREATE DATABASE ${quoted(database)} OWNER ${quoted(PROBE_ROLE)}`,
            ),
        ]);

        // The verifier's setup, exactly: the owner cannot bypass the policy it
        // installs, so the row becomes invisible to the very session that would
        // certify the database disposable.
        await onConnection(probeUrlFor(PROBE_DATABASES.rowSecurity), [
            'CREATE TABLE public.operator_rows (id integer PRIMARY KEY, note text)',
            "INSERT INTO public.operator_rows VALUES (1, 'the operator row that must survive')",
            'ALTER TABLE public.operator_rows ENABLE ROW LEVEL SECURITY',
            'ALTER TABLE public.operator_rows FORCE ROW LEVEL SECURITY',
            'CREATE POLICY deny_all ON public.operator_rows USING (false)',
        ]);

        await onConnection(probeUrlFor(PROBE_DATABASES.occupied), [
            'CREATE TABLE public.operator_rows (id integer PRIMARY KEY, note text)',
            "INSERT INTO public.operator_rows VALUES (1, 'a row in plain sight')",
        ]);
    }, PROBE_SETUP_TIMEOUT_MS);

    afterAll(async () => {
        // FORCE, because a refused run still opened and closed a connection and
        // PostgreSQL may not have reaped the backend yet; the role goes last,
        // once nothing it owns is left.
        await onConnection(maintenanceUrl(), [
            ...Object.values(PROBE_DATABASES).map(
                (database) => `DROP DATABASE IF EXISTS ${quoted(database)} WITH (FORCE)`,
            ),
            `DROP ROLE IF EXISTS ${quoted(PROBE_ROLE)}`,
        ]);
    }, PROBE_SETUP_TIMEOUT_MS);

    it(
        'refuses a forced deny-all policy, and the hidden row survives',
        async () => {
            const probe = probeUrlFor(PROBE_DATABASES.rowSecurity);

            // THE TRAP, measured rather than asserted from the docs: the
            // occupancy question this wrapper used to trust answers "empty" for
            // a table that holds a row.
            const [visibility] = await queryOnConnection<{ occupied: boolean }>(
                probe,
                'SELECT EXISTS (SELECT 1 FROM public.operator_rows) AS occupied',
            );
            expect(visibility.occupied).toBe(false);

            const { error, outcome, spawned } = await runAgainstProbe(PROBE_DATABASES.rowSecurity);

            expect(outcome).toBeNull();
            expect(error).toBeInstanceOf(SchemaDiffError);
            expect((error as SchemaDiffError).code).toBe('target_row_security');
            expect((error as Error).message).toContain('operator_rows');
            expect(spawned).toHaveLength(0);

            // The relation and the row are still there — which is the whole
            // point of the refusal, and what failed before it existed.
            const [relation] = await queryOnConnection<{ relation: string | null }>(
                probe,
                "SELECT to_regclass('public.operator_rows')::text AS relation",
            );
            expect(relation.relation).toBe('operator_rows');

            // Counted with the owner's exemption restored rather than through a
            // superuser, so the assertion needs no privilege the probe role
            // does not already have.
            await onConnection(probe, ['ALTER TABLE public.operator_rows NO FORCE ROW LEVEL SECURITY']);
            const [rows] = await queryOnConnection<{ count: string }>(
                probe,
                'SELECT count(*)::text AS count FROM public.operator_rows',
            );
            expect(rows.count).toBe('1');
        },
        PROBE_TEST_TIMEOUT_MS,
    );

    it(
        'refuses a plainly occupied table too, and that row survives as well',
        async () => {
            const { error, outcome, spawned } = await runAgainstProbe(PROBE_DATABASES.occupied);

            expect(outcome).toBeNull();
            expect((error as SchemaDiffError).code).toBe('target_not_disposable');
            expect((error as Error).message).toContain('operator_rows');
            expect(spawned).toHaveLength(0);

            const [rows] = await queryOnConnection<{ count: string }>(
                probeUrlFor(PROBE_DATABASES.occupied),
                'SELECT count(*)::text AS count FROM public.operator_rows',
            );
            expect(rows.count).toBe('1');
        },
        PROBE_TEST_TIMEOUT_MS,
    );

    // The positive control. Without it, every assertion above is satisfied by a
    // wrapper that refuses everything, which would break the gate this file
    // serves rather than guard it.
    it(
        'still certifies a genuinely empty shadow database and reaches Prisma',
        async () => {
            const { error, outcome, spawned } = await runAgainstProbe(PROBE_DATABASES.empty);

            expect(error).toBeNull();
            expect(outcome).toMatchObject({ verdict: 'differences_found', exitCode: PRISMA_DIFFERENCES_EXIT_CODE });
            expect(outcome?.target).toMatchObject({
                database: PROBE_DATABASES.empty,
                schema: 'public',
                tablesInSchema: 0,
                occupiedTables: [],
                rowSecurityProtectedTables: [],
            });
            expect(spawned).toHaveLength(1);
        },
        PROBE_TEST_TIMEOUT_MS,
    );
});
