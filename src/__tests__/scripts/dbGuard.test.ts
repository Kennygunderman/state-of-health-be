/**
 * The database-origin guard itself: `scripts/lib/dbGuard.ts`.
 *
 * WHAT THIS SUITE SETTLES. Agent Action Plan §0.7.1 states the guard's purpose
 * as a property of the pipeline rather than of one script: "no load or seed can
 * run against a non-development one without a human typing its name". The two
 * script suites exercise the guard incidentally, each through its own binding
 * (`catalog-load.test.ts` over `evaluateScriptDatabase`, `recipes-seed.test.ts`
 * over `SCRIPT_DATABASE_POLICIES` and `assertScriptDatabase`), and both do it
 * with the origins their own stage cares about. What neither covers — and what
 * this file exists for — is the POLICY SEAM the release procedure actually
 * lands on: a deployment database is reachable only over loopback (a remote
 * host is `unknown` and refused outright, so `release-and-recovery.md` step 4
 * has no other shape), a loopback host is `development` on the host ALONE, and
 * a `development_or_confirmed` writer must still demand the typed database name
 * there. The complement is asserted just as explicitly, because it is the part
 * a stricter rule could break: a database whose own NAME says development —
 * `soh_dev`, and the `soh_dev_<index>` an agent clone is provisioned with —
 * needs no flag at all.
 *
 * WHAT IT DELIBERATELY DOES NOT SETTLE. The URL-shape refusals
 * (`missing_database_url`, `unparsable_database_url` and the three
 * `ambiguous_database_url` reasons), the message text of each, and the
 * module-load enforcement seen from outside a Jest worker are not re-asserted
 * here: the first two belong to the classification rules exercised by
 * `catalog-load.test.ts`, and the out-of-process proof that a guard aborts a run
 * before Prisma loads is `src/__tests__/setup/testDb.test.ts`'s spawned child.
 *
 * HOW IT DRIVES THE GUARD. Through `assertScriptDatabase({script, argv, env})`
 * with both sources INJECTED. `process.argv` and `process.env` are never
 * written: the ambient `DATABASE_URL` is the database this worker's own
 * identity guard (`setup/jestSetup.ts`) validated before this file loaded, and
 * every URL below is a synthetic string with placeholder userinfo — the guard
 * classifies text and opens nothing, so a real credential would be a committed
 * secret for no gain.
 */
import {
    assertScriptDatabase,
    classifyDatabaseOrigin,
    DatabaseOriginError,
    entryScriptName,
    evaluateScriptDatabase,
    isDevelopmentDatabaseName,
    SCRIPT_DATABASE_POLICIES,
} from '../../../scripts/lib/dbGuard';
import type { DatabaseOrigin } from '../../../scripts/lib/dbGuard';
import { createLogger } from '../../../scripts/lib/logger';
import type { LogLevel, ScriptLogger } from '../../../scripts/lib/logger';

/**
 * Placeholder userinfo, and the string the redaction assertion looks for the
 * absence of. Nothing here opens a connection.
 */
const CREDENTIALS = 'guard_operator:fixture-only';

const urlFor = (host: string, database: string): string => `postgresql://${CREDENTIALS}@${host}:5432/${database}`;

/** The two writers that carry the confirmation door, asserted as one set. */
const WRITERS = ['catalog-load', 'recipes-seed'] as const;

/**
 * A deployment-shaped database name: it says nothing about development, and on
 * a loopback host it is exactly what a release's step 4 points at.
 */
const DEPLOYMENT_DATABASE = 'state_of_health';

const LOOPBACK_DEPLOYMENT_URL = urlFor('127.0.0.1', DEPLOYMENT_DATABASE);
const REMOTE_DEPLOYMENT_URL = urlFor('db.internal.example.com', DEPLOYMENT_DATABASE);

/** Pinned so a captured log line is an exactly assertable value. */
const NOW = new Date('2026-09-17T00:00:00.000Z');

interface CapturedLine {
    readonly level: LogLevel;
    readonly line: string;
    readonly entry: Record<string, unknown>;
}

/**
 * A real `ScriptLogger` over a captured sink, so the redaction assertion reads
 * the BYTES the guard would have emitted rather than the fields it was handed —
 * the only form in which "the classification is reported and the connection
 * string is not" is actually checkable.
 */
const capturingLogger = (captured: CapturedLine[]): ScriptLogger =>
    createLogger('dbGuard', {
        level: 'debug',
        now: () => NOW,
        write: (line, level) => {
            captured.push({ level, line, entry: JSON.parse(line) as Record<string, unknown> });
        },
    });

const guard = (
    script: string,
    databaseUrl: string,
    argv: readonly string[] = [],
    logger?: ScriptLogger,
): DatabaseOrigin =>
    assertScriptDatabase({
        script,
        // argv[0] and argv[1] as a Jest worker sees them, so the module-load
        // enforcement keyed on `process.argv[1]` stays the no-op it has to be
        // and the flag below is read from the injected tail.
        argv: ['node', 'jest', ...argv],
        env: { DATABASE_URL: databaseUrl },
        logger,
    });

const refusalOf = (script: string, databaseUrl: string, argv: readonly string[] = []): DatabaseOriginError => {
    try {
        guard(script, databaseUrl, argv);
    } catch (error) {
        if (error instanceof DatabaseOriginError) {
            return error;
        }
        throw error;
    }
    throw new Error(`the guard allowed ${script} against a target the scenario requires it to refuse`);
};

describe.each(WRITERS)('%s — the confirmation door', (script) => {
    it('runs under development_or_confirmed', () => {
        expect(SCRIPT_DATABASE_POLICIES[script]).toBe('development_or_confirmed');
    });

    /* ----------------------------------------------------------------------
     * A remote host: refused before any policy, flag or no flag
     * -------------------------------------------------------------------- */

    it('refuses a remote deployment host outright', () => {
        const refusal = refusalOf(script, REMOTE_DEPLOYMENT_URL);

        expect(refusal.code).toBe('unrecognised_origin');
        expect(refusal.origin.originClass).toBe('unknown');
        // No rule matched, so there is no half of one to report.
        expect(refusal.origin.match).toBeUndefined();
    });

    it('refuses a remote deployment host even when the flag names its database exactly', () => {
        // The flag confirms WHICH recognised database is being written; it is
        // not a way to assert a classification. This is what stops
        // `--confirm-target state_of_health` from being the one keystroke
        // between a catalog load and a production database.
        const refusal = refusalOf(script, REMOTE_DEPLOYMENT_URL, ['--confirm-target', DEPLOYMENT_DATABASE]);

        expect(refusal.code).toBe('unrecognised_origin');
        expect(refusal.origin.originClass).toBe('unknown');
    });

    /* ----------------------------------------------------------------------
     * A loopback deployment database: development by host alone, so confirmed
     * -------------------------------------------------------------------- */

    it('demands the typed name for a loopback database whose name says nothing about development', () => {
        const refusal = refusalOf(script, LOOPBACK_DEPLOYMENT_URL);

        expect(refusal.code).toBe('confirmation_required');
        expect(refusal.origin).toMatchObject({
            originClass: 'development',
            match: 'host',
            host: '127.0.0.1',
            database: DEPLOYMENT_DATABASE,
        });
        // The remedy, with the name to type, and the reason the class alone
        // was not enough.
        expect(refusal.message).toContain(`--confirm-target ${DEPLOYMENT_DATABASE}`);
        expect(refusal.message).toContain('development by its host alone');
    });

    it('refuses a flag that names a different database than the loopback URL points at', () => {
        const refusal = refusalOf(script, LOOPBACK_DEPLOYMENT_URL, ['--confirm-target', 'soh_dev']);

        expect(refusal.code).toBe('confirmation_mismatch');
        expect(refusal.message).toContain('soh_dev');
        expect(refusal.message).toContain(DEPLOYMENT_DATABASE);
    });

    it('allows the loopback database once the flag names it exactly, in either spelling', () => {
        for (const argv of [
            ['--confirm-target', DEPLOYMENT_DATABASE],
            [`--confirm-target=${DEPLOYMENT_DATABASE}`],
        ]) {
            const origin = guard(script, LOOPBACK_DEPLOYMENT_URL, argv);

            // The classification does not move — the guard cannot tell a
            // deployment database from a development one, and does not claim
            // to. What it enforces is that this one was named aloud.
            expect(origin).toMatchObject({
                originClass: 'development',
                match: 'host',
                host: '127.0.0.1',
                database: DEPLOYMENT_DATABASE,
            });
        }
    });

    /* ----------------------------------------------------------------------
     * A database whose own name says development: unchanged, no flag needed
     * -------------------------------------------------------------------- */

    it.each([
        ['127.0.0.1', 'soh_dev'],
        ['127.0.0.1', 'soh_dev_46'],
        ['127.0.0.1', 'soh_dev_046'],
        ['localhost', 'soh_dev'],
        ['localhost', 'soh_dev_46'],
        ['localhost', 'soh_dev_046'],
        // The container-network service name earns every NAME rule but no host
        // arm, so a `_dev` name is how it reaches `development` at all.
        ['postgres', 'soh_dev'],
    ])('writes %s/%s with no flag at all, matched by name', (host, database) => {
        const url = urlFor(host, database);

        expect(guard(script, url)).toMatchObject({ originClass: 'development', match: 'name', host, database });
        expect(classifyDatabaseOrigin(url)).toMatchObject({ originClass: 'development', match: 'name' });
    });

    /* ----------------------------------------------------------------------
     * test and shadow: untouched by the name/host distinction
     * -------------------------------------------------------------------- */

    it.each([
        ['soh_test', 'test'],
        ['soh_test_46', 'test'],
        ['ci', 'test'],
        ['soh_shadow', 'shadow'],
        ['soh_shadow_46', 'shadow'],
    ])('still refuses the %s database until it is named, then writes it', (database, originClass) => {
        const url = urlFor('127.0.0.1', database);
        const refusal = refusalOf(script, url);

        expect(refusal.code).toBe('confirmation_required');
        expect(refusal.origin).toMatchObject({ originClass, match: 'name', database });
        expect(refusal.message).toContain(`--confirm-target ${database}`);

        expect(guard(script, url, ['--confirm-target', database])).toMatchObject({ originClass, database });
        expect(refusalOf(script, url, ['--confirm-target', 'soh_dev']).code).toBe('confirmation_mismatch');
    });
});

/* ---------------------------------------------------------------------------
 * seed-dev, which this change must not have moved
 * ------------------------------------------------------------------------- */

// The `development_only` policy is asserted here as well as in the writers'
// blocks above because it is the one policy the name/host distinction
// deliberately does NOT reach: `seed-dev` writes user-scoped rows, so its
// answer is a class decision with no flag door, and a later edit that extended
// the distinction to it — refusing a developer's arbitrarily named local
// database, or growing a confirmation door — would be a silent change of
// contract. These tests fail if either happens.
describe('seed-dev — development_only, and no door', () => {
    const SCRIPT = 'seed-dev';

    it('runs under development_only', () => {
        expect(SCRIPT_DATABASE_POLICIES[SCRIPT]).toBe('development_only');
    });

    it('accepts a development origin reached through the host arm alone', () => {
        expect(guard(SCRIPT, LOOPBACK_DEPLOYMENT_URL)).toMatchObject({
            originClass: 'development',
            match: 'host',
            database: DEPLOYMENT_DATABASE,
        });
    });

    it('accepts a development origin reached by name', () => {
        expect(guard(SCRIPT, urlFor('127.0.0.1', 'soh_dev_46'))).toMatchObject({
            originClass: 'development',
            match: 'name',
        });
    });

    it.each([['soh_test'], ['soh_shadow']])('refuses the %s database, with no flag that opens it', (database) => {
        const url = urlFor('127.0.0.1', database);

        expect(refusalOf(SCRIPT, url).code).toBe('development_only');
        expect(refusalOf(SCRIPT, url).message).toContain('no confirmation flag');
        // The flag is parsed for every script, so "no door" has to mean the
        // verdict ignores it rather than that the value never arrives.
        expect(refusalOf(SCRIPT, url, ['--confirm-target', database]).code).toBe('development_only');
    });

    it('refuses an origin it cannot classify', () => {
        expect(refusalOf(SCRIPT, REMOTE_DEPLOYMENT_URL).code).toBe('unrecognised_origin');
    });
});

/* ---------------------------------------------------------------------------
 * The optional `match` field, read the strict way
 * ------------------------------------------------------------------------- */

describe('an origin that does not say which half of its rule matched', () => {
    // `match` is optional so a caller can still compose a `DatabaseOrigin`
    // literal, which is exactly how it could weaken the guard by omission. The
    // branch reads an absent value as the host arm — confirmation required —
    // and this is the test that pins that direction.
    const originWithoutMatch: DatabaseOrigin = {
        originClass: 'development',
        host: '127.0.0.1',
        database: DEPLOYMENT_DATABASE,
        reason: 'host is a development host',
    };

    it('is treated as the host arm, so the confirmation is still demanded', () => {
        const verdict = evaluateScriptDatabase({
            script: 'catalog-load',
            policy: 'development_or_confirmed',
            origin: originWithoutMatch,
            confirmTarget: null,
        });

        expect(verdict.allowed).toBe(false);
        expect(!verdict.allowed && verdict.code).toBe('confirmation_required');
    });

    it('is accepted once the flag names the database', () => {
        expect(
            evaluateScriptDatabase({
                script: 'catalog-load',
                policy: 'development_or_confirmed',
                origin: originWithoutMatch,
                confirmTarget: DEPLOYMENT_DATABASE,
            }),
        ).toEqual({ allowed: true });
    });

    it('is still a development origin to seed-dev, whose policy does not read the field', () => {
        expect(
            evaluateScriptDatabase({
                script: 'seed-dev',
                policy: 'development_only',
                origin: originWithoutMatch,
                confirmTarget: null,
            }),
        ).toEqual({ allowed: true });
    });
});

/* ---------------------------------------------------------------------------
 * What an accepted run records
 * ------------------------------------------------------------------------- */

describe('the accepted-run log line', () => {
    it('reports the classification and nothing the URL carried around it', () => {
        const captured: CapturedLine[] = [];

        const argv = ['--confirm-target', DEPLOYMENT_DATABASE];
        guard('catalog-load', LOOPBACK_DEPLOYMENT_URL, argv, capturingLogger(captured));

        expect(captured).toHaveLength(1);
        expect(captured[0].level).toBe('debug');
        // Exactly the five classified fields beside the logger's own metadata:
        // asserted as a key SET, so a field added here later has to be a
        // deliberate change to this test rather than an accident.
        expect(Object.keys(captured[0].entry).sort()).toEqual(
            ['database', 'event', 'host', 'level', 'originClass', 'policy', 'scope', 'script', 'ts'].sort(),
        );
        expect(captured[0].entry).toMatchObject({
            event: 'database_origin_accepted',
            script: 'catalog-load',
            policy: 'development_or_confirmed',
            originClass: 'development',
            host: '127.0.0.1',
            database: DEPLOYMENT_DATABASE,
        });

        expect(captured[0].line).not.toContain('postgresql://');
        expect(captured[0].line).not.toContain('guard_operator');
        expect(captured[0].line).not.toContain('fixture-only');
        expect(captured[0].line).not.toContain(LOOPBACK_DEPLOYMENT_URL);
    });

    it('records nothing when the run is refused, because the refusal is thrown to be reported once', () => {
        const captured: CapturedLine[] = [];

        expect(() => guard('catalog-load', LOOPBACK_DEPLOYMENT_URL, [], capturingLogger(captured))).toThrow(
            DatabaseOriginError,
        );
        expect(captured).toHaveLength(0);
    });
});

/* ---------------------------------------------------------------------------
 * The development name rule on its own
 * ------------------------------------------------------------------------- */

describe('isDevelopmentDatabaseName', () => {
    // The clone-index spellings matter to the policy, not just to the class: a
    // clone's `soh_dev_46` reaching `development` through the host arm would
    // start demanding `--confirm-target`, which it never needed.
    it.each([['soh_dev'], ['soh_dev_4'], ['soh_dev_46'], ['soh_dev_046']])('accepts %s', (database) => {
        expect(isDevelopmentDatabaseName(database)).toBe(true);
    });

    it.each([['soh_development'], ['dev_soh']])('rejects %s', (database) => {
        expect(isDevelopmentDatabaseName(database)).toBe(false);
    });
});

describe('the module-load enforcement', () => {
    it('is a no-op under Jest, which is what lets this suite import the guard at all', () => {
        // Asserted rather than assumed: if argv[1] ever resolved to a known
        // pipeline script, importing this module would end the run instead of
        // failing a test.
        expect(entryScriptName(process.argv)).toBeNull();
    });
});
