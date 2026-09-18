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
 * this file exists for — are the four seams that decide where an unowned write
 * may land:
 *
 *   1. THE DEPLOYMENT DATABASE, which is reachable only over loopback (a remote
 *      host is `unknown` and refused outright, so `release-and-recovery.md`
 *      step 4 has no other shape) and therefore classifies `development` on the
 *      host ALONE. Every policy without a confirmation door refuses it, and
 *      `development_or_confirmed` demands the typed database name there. The
 *      complement is asserted just as explicitly, because it is the part a
 *      stricter rule could break: a database whose own NAME says development —
 *      `soh_dev`, and the `soh_dev_<index>` an agent clone is provisioned with —
 *      needs no flag at all.
 *   2. THE SHADOW DATABASE, refused to every script whatever its policy and
 *      whatever the flag says, because Prisma's schema tooling resets it. Its
 *      mirror is `evaluateShadowDatabase`, which accepts a shadow database and
 *      nothing else.
 *   3. THE POLICY TABLE ITSELF, asserted as data: which of the four policies
 *      each of the nine scripts runs under, so a stage that mutates shared
 *      catalog data cannot quietly acquire the read-only one.
 *   4. THE SCHEMA REDIRECT — `?schema=`, `?options=-c search_path=…` — which
 *      leaves the host and the database name matching every rule and moves the
 *      tables an unqualified statement reaches.
 *
 * WHAT IT DELIBERATELY DOES NOT SETTLE. The other URL-shape refusals
 * (`missing_database_url`, `unparsable_database_url`, and the encoded-name and
 * no-host `ambiguous_database_url` reasons), the message text of each, and the
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
    assertShadowDatabase,
    classifyDatabaseOrigin,
    DatabaseOriginError,
    entryScriptName,
    evaluateScriptDatabase,
    evaluateShadowDatabase,
    isDevelopmentDatabaseName,
    SCRIPT_DATABASE_POLICIES,
} from '../../../scripts/lib/dbGuard';
import type { DatabaseOrigin, ScriptDatabasePolicy } from '../../../scripts/lib/dbGuard';
import { createLogger, opaqueDigest } from '../../../scripts/lib/logger';
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
     * test: untouched by the name/host distinction
     * -------------------------------------------------------------------- */

    it.each([['soh_test'], ['soh_test_46'], ['ci']])(
        'still refuses the %s database until it is named, then writes it',
        (database) => {
            const url = urlFor('127.0.0.1', database);
            const refusal = refusalOf(script, url);

            expect(refusal.code).toBe('confirmation_required');
            expect(refusal.origin).toMatchObject({ originClass: 'test', match: 'name', database });
            expect(refusal.message).toContain(`--confirm-target ${database}`);

            expect(guard(script, url, ['--confirm-target', database])).toMatchObject({
                originClass: 'test',
                database,
            });
            expect(refusalOf(script, url, ['--confirm-target', 'soh_dev']).code).toBe('confirmation_mismatch');
        },
    );

    /* ----------------------------------------------------------------------
     * shadow: refused outright, and the flag is not a door to it
     * -------------------------------------------------------------------- */

    // The confirmation door used to open the shadow database, which contradicted
    // the contract that class exists to state: Prisma's schema tooling RESETS it
    // (measured — a shadow database carrying an operator's table came back with
    // that table dropped), so §0.4.4 says nothing of value may live there. A
    // catalog load into it would be a load whose next reader destroys it, and it
    // would report success. No flag changes that answer.
    it.each([['soh_shadow'], ['soh_shadow_46']])('refuses the %s database, flag or no flag', (database) => {
        const url = urlFor('127.0.0.1', database);

        for (const argv of [[], ['--confirm-target', database], [`--confirm-target=${database}`]]) {
            const refusal = refusalOf(script, url, argv);

            expect(refusal.code).toBe('shadow_database');
            expect(refusal.origin).toMatchObject({ originClass: 'shadow', match: 'name', database });
            // The refusal has to say why, because an operator holding a working
            // `--confirm-target` for a test database will try it here.
            expect(refusal.message).toContain('RESETS it');
            expect(refusal.message).toContain(`No policy and no --confirm-target opens it`);
        }
    });
});

/* ---------------------------------------------------------------------------
 * seed-dev, which this change must not have moved
 * ------------------------------------------------------------------------- */

// `seed-dev` is the script the name/host distinction matters most for, and it
// used to be the one place the distinction was NOT applied. It writes
// user-scoped rows — a development user, its preferences, its diary buckets —
// and `--reset-user` DELETES a user and everything cascading from it, which is
// exactly what Rule backend-architecture §5.1 protects. Accepting the class
// meant accepting every database answering on loopback, so a deployment
// database reached through an SSH tunnel or a published container port was a
// legitimate target with nothing to type and nothing to read back. A NAME is
// the only evidence this module has that a database was made for development,
// so a name is what it requires, and there is still no door to soften that.
describe('seed-dev — development by name, and no door', () => {
    const SCRIPT = 'seed-dev';

    it('runs under development_only', () => {
        expect(SCRIPT_DATABASE_POLICIES[SCRIPT]).toBe('development_only');
    });

    it('refuses a development origin reached through the host arm alone', () => {
        const refusal = refusalOf(SCRIPT, LOOPBACK_DEPLOYMENT_URL);

        expect(refusal.code).toBe('development_only');
        expect(refusal.origin).toMatchObject({
            originClass: 'development',
            match: 'host',
            database: DEPLOYMENT_DATABASE,
        });
        // The refusal names the rule, the reason the class was not enough, and
        // the absence of any flag — the three things an operator staring at a
        // target the guard just called "development" needs.
        expect(refusal.message).toContain('a database name ending _dev');
        expect(refusal.message).toContain('development by its host alone');
        expect(refusal.message).toContain('no confirmation flag');
        // And no flag reaches it, in either spelling.
        expect(refusalOf(SCRIPT, LOOPBACK_DEPLOYMENT_URL, ['--confirm-target', DEPLOYMENT_DATABASE]).code).toBe(
            'development_only',
        );
        expect(refusalOf(SCRIPT, LOOPBACK_DEPLOYMENT_URL, [`--confirm-target=${DEPLOYMENT_DATABASE}`]).code).toBe(
            'development_only',
        );
    });

    it.each([
        ['127.0.0.1', 'soh_dev'],
        ['127.0.0.1', 'soh_dev_46'],
        ['127.0.0.1', 'soh_dev_046'],
        ['localhost', 'soh_dev'],
        ['postgres', 'soh_dev'],
    ])('accepts %s/%s, a development origin reached by name', (host, database) => {
        expect(guard(SCRIPT, urlFor(host, database))).toMatchObject({
            originClass: 'development',
            match: 'name',
            host,
            database,
        });
    });

    it('refuses the soh_test database, with no flag that opens it', () => {
        const url = urlFor('127.0.0.1', 'soh_test');

        expect(refusalOf(SCRIPT, url).code).toBe('development_only');
        expect(refusalOf(SCRIPT, url).message).toContain('no confirmation flag');
        // The flag is parsed for every script, so "no door" has to mean the
        // verdict ignores it rather than that the value never arrives.
        expect(refusalOf(SCRIPT, url, ['--confirm-target', 'soh_test']).code).toBe('development_only');
    });

    it('refuses the shadow database through the rule that covers every script', () => {
        const url = urlFor('127.0.0.1', 'soh_shadow');

        // `shadow_database`, not `development_only`: the shadow refusal runs
        // ahead of every policy, so the message an operator reads is about the
        // database's purpose rather than about this script's privilege.
        expect(refusalOf(SCRIPT, url).code).toBe('shadow_database');
        expect(refusalOf(SCRIPT, url, ['--confirm-target', 'soh_shadow']).code).toBe('shadow_database');
    });

    it('refuses an origin it cannot classify', () => {
        expect(refusalOf(SCRIPT, REMOTE_DEPLOYMENT_URL).code).toBe('unrecognised_origin');
    });
});

/* ---------------------------------------------------------------------------
 * The four stages that BUILD catalog data: development by name or test, no door
 * ------------------------------------------------------------------------- */

// These four mutate shared reference data — the first three write
// `catalog_foods` and its children, `catalog-release` opens and closes a
// `catalog_import_runs` ledger row around its export — and §0.7.5 states as a
// rule of the release that a catalog is built on a development machine,
// reviewed as a release, and installed elsewhere by `catalog-load`. Under the
// older `any_recognised` setting each of them would have rewritten the catalog
// of any origin the module could classify, a loopback deployment database
// included. The door is deliberately absent: the legitimate invocation against
// a shared environment is `catalog-load`, which has one.
describe.each(['catalog-import-usda', 'catalog-generate-ai', 'catalog-validate', 'catalog-release'])(
    '%s — a development name or a test database, and nothing else',
    (script) => {
        it('runs under development_or_test', () => {
            expect(SCRIPT_DATABASE_POLICIES[script]).toBe('development_or_test');
        });

        it.each([
            ['127.0.0.1', 'soh_dev'],
            ['127.0.0.1', 'soh_dev_46'],
            ['postgres', 'soh_dev'],
        ])('accepts %s/%s, matched by name', (host, database) => {
            expect(guard(script, urlFor(host, database))).toMatchObject({ originClass: 'development', host, database });
        });

        it.each([['soh_test'], ['soh_test_46'], ['ci']])('accepts the %s database, which is disposable', (database) => {
            expect(guard(script, urlFor('127.0.0.1', database))).toMatchObject({ originClass: 'test', database });
        });

        it('refuses a loopback deployment database, with no flag that opens it', () => {
            const refusal = refusalOf(script, LOOPBACK_DEPLOYMENT_URL);

            expect(refusal.code).toBe('development_only');
            expect(refusal.origin).toMatchObject({ originClass: 'development', match: 'host' });
            expect(refusal.message).toContain('development by its host alone');
            // The remedy is a route, not a flag, so the message has to name it.
            expect(refusal.message).toContain('catalog-load');

            for (const argv of [['--confirm-target', DEPLOYMENT_DATABASE], [`--confirm-target=${DEPLOYMENT_DATABASE}`]]) {
                expect(refusalOf(script, LOOPBACK_DEPLOYMENT_URL, argv).code).toBe('development_only');
            }
        });

        it('refuses the shadow database', () => {
            expect(refusalOf(script, urlFor('127.0.0.1', 'soh_shadow')).code).toBe('shadow_database');
        });

        it('refuses a remote host outright', () => {
            expect(refusalOf(script, REMOTE_DEPLOYMENT_URL).code).toBe('unrecognised_origin');
        });
    },
);

/* ---------------------------------------------------------------------------
 * The read-only stages: any recognised origin except shadow
 * ------------------------------------------------------------------------- */

// `catalog-report`'s Prisma surface declares `findMany` and nothing else, and
// `search-benchmark` issues `$queryRawUnsafe` SELECTs, so there is nothing for a
// confirmation to protect. They keep the widest policy for a concrete reason
// rather than for symmetry: §0.7.5's release order runs `search:benchmark` ON
// the deployment host to record that environment's own benchmark report, which
// is a loopback origin that is development by its host alone — precisely what
// the four mutating stages above refuse.
describe.each(['catalog-report', 'search-benchmark'])('%s — read-only, so any recognised origin', (script) => {
    it('runs under read_only_recognised', () => {
        expect(SCRIPT_DATABASE_POLICIES[script]).toBe('read_only_recognised');
    });

    it('accepts a loopback deployment database with no flag', () => {
        expect(guard(script, LOOPBACK_DEPLOYMENT_URL)).toMatchObject({
            originClass: 'development',
            match: 'host',
            database: DEPLOYMENT_DATABASE,
        });
    });

    it.each([['soh_dev'], ['soh_test'], ['ci']])('accepts the %s database with no flag', (database) => {
        expect(() => guard(script, urlFor('127.0.0.1', database))).not.toThrow();
    });

    it('still refuses the shadow database, because nothing may read a database that is reset', () => {
        expect(refusalOf(script, urlFor('127.0.0.1', 'soh_shadow')).code).toBe('shadow_database');
    });

    it('still refuses a remote host', () => {
        expect(refusalOf(script, REMOTE_DEPLOYMENT_URL).code).toBe('unrecognised_origin');
    });
});

/* ---------------------------------------------------------------------------
 * The policy table as data
 * ------------------------------------------------------------------------- */

// The table is the whole of the per-script decision, so it is asserted as a
// whole: which policy each script runs under, and that the set of scripts is
// the set this pipeline has. A stage added later with no entry falls back to
// the strictest policy (`development_only`), which is safe but silent — this
// test is what makes it loud instead.
describe('SCRIPT_DATABASE_POLICIES', () => {
    const EXPECTED: Readonly<Record<string, ScriptDatabasePolicy>> = {
        'catalog-load': 'development_or_confirmed',
        'recipes-seed': 'development_or_confirmed',
        'seed-dev': 'development_only',
        'catalog-import-usda': 'development_or_test',
        'catalog-generate-ai': 'development_or_test',
        'catalog-validate': 'development_or_test',
        'catalog-release': 'development_or_test',
        'catalog-report': 'read_only_recognised',
        'search-benchmark': 'read_only_recognised',
    };

    it('lists exactly the nine pipeline scripts, each under the policy its writes justify', () => {
        expect(SCRIPT_DATABASE_POLICIES).toEqual(EXPECTED);
    });

    it('gives no script the shadow database, whatever its policy', () => {
        // One assertion over the whole table, so the global rule cannot be true
        // of the scripts a test happens to name and false of the rest.
        for (const script of Object.keys(SCRIPT_DATABASE_POLICIES)) {
            expect(refusalOf(script, urlFor('127.0.0.1', 'soh_shadow')).code).toBe('shadow_database');
        }
    });
});

/* ---------------------------------------------------------------------------
 * The schema redirect: the host and the name pass, and the tables move
 * ------------------------------------------------------------------------- */

// Measured on PostgreSQL 16.15 with a decoy `live` schema beside `public`:
// `?schema=live` (Prisma) and `?options=-c search_path=live` (Prisma and `pg`)
// both move `current_schema()`, and an unqualified `TRUNCATE`/`INSERT` lands in
// the redirected schema while `public` is untouched. The URL below is a
// `_test`-named database on a local host, so every host and name rule in this
// module passes it — which is exactly why the redirect has to be refused
// before they are consulted.
describe('a query string that redirects the schema', () => {
    const REDIRECTS: ReadonlyArray<readonly [string, string]> = [
        ['schema', 'postgresql://u:p@127.0.0.1:5432/soh_test?schema=live'],
        ['options', 'postgresql://u:p@127.0.0.1:5432/soh_test?options=-c%20search_path%3Dlive'],
        ['search_path', 'postgresql://u:p@127.0.0.1:5432/soh_test?search_path=live'],
        // Case and encoding of the KEY are irrelevant to a connector that
        // lower-cases its keywords, so they are irrelevant here too.
        ['an upper-case key', 'postgresql://u:p@127.0.0.1:5432/soh_test?SCHEMA=live'],
        // Two schemas named is one schema too many, whichever came first.
        ['a repeated key', 'postgresql://u:p@127.0.0.1:5432/soh_test?schema=public&schema=live'],
    ];

    it.each(REDIRECTS)('is unclassifiable when the URL carries %s', (_label, url) => {
        const origin = classifyDatabaseOrigin(url);

        expect(origin.originClass).toBe('unknown');
        expect(origin.reason).toContain('redirects the schema');
        // The host and the database ARE determined here, unlike the other
        // ambiguity reasons, and both are reported so the operator can see that
        // the database was right and the schema was not.
        expect(origin).toMatchObject({ host: '127.0.0.1', database: 'soh_test' });
    });

    it.each(REDIRECTS)('is refused to every script when the URL carries %s', (_label, url) => {
        for (const script of Object.keys(SCRIPT_DATABASE_POLICIES)) {
            const refusal = refusalOf(script, url);

            expect(refusal.code).toBe('ambiguous_database_url');
            expect(refusal.message).toContain('moves the schema');
            expect(refusal.message).toContain('public');
        }
    });

    it('is refused even when --confirm-target names the database correctly', () => {
        // The flag confirms WHICH database, and the database was never the
        // problem.
        expect(
            refusalOf('catalog-load', 'postgresql://u:p@127.0.0.1:5432/soh_test?schema=live', [
                '--confirm-target',
                'soh_test',
            ]).code,
        ).toBe('ambiguous_database_url');
    });

    it('accepts schema=public, which names the schema everything here already uses', () => {
        // Refusing it would be a refusal with no failure behind it: Prisma sets
        // `search_path` to `public`, which is where the migrations put every
        // table, and it is what a Prisma-generated `.env` commonly spells out.
        const url = 'postgresql://u:p@127.0.0.1:5432/soh_dev?schema=public';

        expect(classifyDatabaseOrigin(url)).toMatchObject({ originClass: 'development', match: 'name' });
        expect(() => guard('seed-dev', url)).not.toThrow();
    });

    it('accepts an unrelated connection parameter, so the rule stays narrow', () => {
        // `connection_limit`, `sslmode`, `application_name` and the like move
        // neither the database nor the schema, and a guard that refused them
        // would refuse working configurations.
        const url = 'postgresql://u:p@127.0.0.1:5432/soh_dev?connection_limit=5&application_name=soh';

        expect(classifyDatabaseOrigin(url)).toMatchObject({ originClass: 'development', match: 'name' });
    });
});

/* ---------------------------------------------------------------------------
 * The mirror: the schema tooling, which may address a shadow database and
 * nothing else
 * ------------------------------------------------------------------------- */

// `scripts/schema-diff.ts` is the only caller. The commands behind it —
// `migrate diff --from-migrations`, `migrate dev --create-only` — RESET the
// database they are given, and were documented as raw command lines carrying
// `--shadow-database-url "$SHADOW_DATABASE_URL"` with nothing between an
// inherited or mistyped value and that reset. Measured: the diff dropped an
// operator table out of the database it was pointed at and still exited 2.
describe('evaluateShadowDatabase', () => {
    const COMMAND = 'schema-diff';

    const refusal = (databaseUrl: string | undefined): { code: string; message: string } => {
        const verdict = evaluateShadowDatabase({ command: COMMAND, databaseUrl });

        if (verdict.allowed) {
            throw new Error('the guard allowed a shadow target the scenario requires it to refuse');
        }

        return { code: verdict.code, message: verdict.message };
    };

    it.each([['soh_shadow'], ['soh_shadow_46'], ['soh_shadow_046']])('accepts the local %s database', (database) => {
        const verdict = evaluateShadowDatabase({ command: COMMAND, databaseUrl: urlFor('127.0.0.1', database) });

        expect(verdict.allowed).toBe(true);
        expect(verdict.allowed && verdict.origin).toMatchObject({ originClass: 'shadow', match: 'name', database });
    });

    it.each([
        ['a development database', 'soh_dev'],
        ['a test database', 'soh_test'],
        ['a deployment database', DEPLOYMENT_DATABASE],
    ])('refuses %s, because Prisma would reset it', (_label, database) => {
        const { code, message } = refusal(urlFor('127.0.0.1', database));

        expect(code).toBe('shadow_required');
        expect(message).toContain('RESETS');
        expect(message).toContain('_shadow');
    });

    it('refuses a remote shadow name, because the reset would be remote', () => {
        expect(refusal(urlFor('db.internal.example.com', 'soh_shadow')).code).toBe('shadow_required');
    });

    it('names SHADOW_DATABASE_URL rather than DATABASE_URL in every refusal', () => {
        // The variable in the message is the variable the operator has to edit.
        for (const url of [undefined, 'not-a-url', urlFor('127.0.0.1', 'soh_dev')]) {
            const { message } = refusal(url);

            expect(message).toContain('SHADOW_DATABASE_URL');
            // Every mention has to be the shadow variable: `DATABASE_URL` is a
            // substring of `SHADOW_DATABASE_URL`, so the shadow name is
            // replaced out before the plain one is looked for.
            expect(message.replace(/SHADOW_DATABASE_URL/g, '<shadow-url>')).not.toContain('DATABASE_URL');
        }
    });

    it.each([
        ['missing', undefined, 'missing_database_url'],
        ['unparsable', 'shadow.example', 'unparsable_database_url'],
        ['redirecting its connection', 'postgresql://u:p@127.0.0.1:5432/soh_shadow?host=prod.example.com', 'ambiguous_database_url'],
        ['redirecting its schema', 'postgresql://u:p@127.0.0.1:5432/soh_shadow?options=-c%20search_path%3Dlive', 'ambiguous_database_url'],
        ['percent-encoding its name', 'postgresql://u:p@127.0.0.1:5432/soh%5Fshadow', 'ambiguous_database_url'],
    ])('refuses a URL that is %s', (_label, url, code) => {
        expect(refusal(url as string | undefined).code).toBe(code);
    });

    it('throws a DatabaseOriginError from assertShadowDatabase, carrying the classification', () => {
        try {
            assertShadowDatabase({ command: COMMAND, env: { SHADOW_DATABASE_URL: urlFor('127.0.0.1', 'soh_dev') } });
        } catch (error) {
            expect(error).toBeInstanceOf(DatabaseOriginError);
            expect((error as DatabaseOriginError).code).toBe('shadow_required');
            expect((error as DatabaseOriginError).origin.database).toBe('soh_dev');

            return;
        }

        throw new Error('assertShadowDatabase accepted a development database as a shadow database');
    });

    it('returns the classified origin from assertShadowDatabase on a pass, and reads the variable it is given', () => {
        expect(
            assertShadowDatabase({
                command: COMMAND,
                env: { SOH_ALTERNATE_SHADOW_URL: urlFor('localhost', 'soh_shadow_46') },
                urlEnvName: 'SOH_ALTERNATE_SHADOW_URL',
            }),
        ).toMatchObject({ originClass: 'shadow', host: 'localhost', database: 'soh_shadow_46' });
    });

    it('logs the accepted classification and never the connection string', () => {
        const captured: CapturedLine[] = [];

        assertShadowDatabase({
            command: COMMAND,
            env: { SHADOW_DATABASE_URL: urlFor('127.0.0.1', 'soh_shadow') },
            logger: capturingLogger(captured),
        });

        expect(captured).toHaveLength(1);
        expect(captured[0].entry).toMatchObject({
            event: 'shadow_database_accepted',
            command: COMMAND,
            urlEnvName: 'SHADOW_DATABASE_URL',
            originClass: 'shadow',
            host: '127.0.0.1',
            database: 'soh_shadow',
        });
        expect(captured[0].line).not.toContain('postgresql://');
        expect(captured[0].line).not.toContain('guard_operator');
        expect(captured[0].line).not.toContain('fixture-only');
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

    it('is refused to seed-dev, whose policy now reads the field and has no door', () => {
        const verdict = evaluateScriptDatabase({
            script: 'seed-dev',
            policy: 'development_only',
            origin: originWithoutMatch,
            confirmTarget: null,
        });

        expect(verdict.allowed).toBe(false);
        expect(!verdict.allowed && verdict.code).toBe('development_only');
    });

    it('is refused to a mutating build stage for the same reason', () => {
        const verdict = evaluateScriptDatabase({
            script: 'catalog-import-usda',
            policy: 'development_or_test',
            origin: originWithoutMatch,
            confirmTarget: DEPLOYMENT_DATABASE,
        });

        expect(verdict.allowed).toBe(false);
        expect(!verdict.allowed && verdict.code).toBe('development_only');
    });

    it('is still accepted by a read-only stage, which asks nothing of the field', () => {
        expect(
            evaluateScriptDatabase({
                script: 'search-benchmark',
                policy: 'read_only_recognised',
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
        // Exactly the classified fields beside the logger's own metadata:
        // asserted as a key SET, so a field added here later has to be a
        // deliberate change to this test rather than an accident. `host` and
        // `database` are ABSENT from that set and that is the point of the
        // assertion — see the disclosure case below.
        expect(Object.keys(captured[0].entry).sort()).toEqual(
            [
                'event',
                'level',
                'match',
                'originClass',
                'policy',
                'reason',
                'scope',
                'script',
                'targetDigest',
                'ts',
            ].sort(),
        );
        expect(captured[0].entry).toMatchObject({
            event: 'database_origin_accepted',
            script: 'catalog-load',
            policy: 'development_or_confirmed',
            originClass: 'development',
            // Reported as the policy reads it: this URL's database name matches
            // no development rule, so it was certified by its loopback host
            // alone — which is exactly why the `--confirm-target` flag above
            // was required.
            match: 'host',
        });
        // A fixed phrase from the guard's own rule table, never URL content.
        expect(typeof captured[0].entry.reason).toBe('string');

        expect(captured[0].line).not.toContain('postgresql://');
        expect(captured[0].line).not.toContain('guard_operator');
        expect(captured[0].line).not.toContain('fixture-only');
        expect(captured[0].line).not.toContain(LOOPBACK_DEPLOYMENT_URL);
    });

    // The accepted line is written on EVERY run of every stage, so it lands in
    // CI logs, operator terminals and whatever ships those onward. A host and a
    // database name there describe the deployment's topology to any later reader
    // of the log, which is the disclosure CWE-532 names and which the
    // classification an operator actually acts on does not require. The digest
    // keeps the one question a reader legitimately asks of two lines — same
    // target, or different? — answerable without naming the target.
    it('identifies the target by an opaque digest instead of its host and name', () => {
        const captured: CapturedLine[] = [];

        const argv = ['--confirm-target', DEPLOYMENT_DATABASE];
        guard('catalog-load', LOOPBACK_DEPLOYMENT_URL, argv, capturingLogger(captured));

        const digest = captured[0].entry.targetDigest;
        expect(digest).toBe(opaqueDigest(`127.0.0.1/${DEPLOYMENT_DATABASE}`));
        expect(digest).toMatch(/^[0-9a-f]{12}$/);

        // Neither half of the target is recoverable from the line, by name or
        // by value. `127.0.0.1` is asserted on the serialized line rather than
        // on a field, because a substring is how it would leak.
        expect(Object.keys(captured[0].entry)).not.toContain('host');
        expect(Object.keys(captured[0].entry)).not.toContain('database');
        expect(captured[0].line).not.toContain('127.0.0.1');
        expect(captured[0].line).not.toContain(DEPLOYMENT_DATABASE);
    });

    // Same classification, different target: the digest is what tells the two
    // runs apart, so a reader can still say "this is not the database the last
    // run wrote to" from the log alone.
    it('gives two different targets two different digests', () => {
        const first: CapturedLine[] = [];
        const second: CapturedLine[] = [];

        guard('catalog-load', LOOPBACK_DEPLOYMENT_URL, ['--confirm-target', DEPLOYMENT_DATABASE], capturingLogger(first));
        guard('catalog-load', urlFor('127.0.0.1', 'soh_dev'), [], capturingLogger(second));

        expect(first[0].entry.originClass).toBe(second[0].entry.originClass);
        expect(first[0].entry.targetDigest).not.toBe(second[0].entry.targetDigest);
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
