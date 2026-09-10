// The one database-origin guard for the meal-planning CLI pipeline.
//
// Rule backend-architecture §1.5/§5.1 makes ownership a per-row guarantee:
// every Prisma predicate carries `user_id`, there is no "get by id" without an
// owner, and a write that finds by id alone is a cross-user write waiting to
// happen. The tables this pipeline writes are the documented exception —
// catalog_foods and its children, recipes, recipe_versions, the import runs and
// the generation batches carry no `user_id` by design, because they are shared
// reference data (Agent Action Plan §0.5.1 records them as the only
// authenticated reads without a tenant predicate). That exemption removes the
// per-row guarantee, so this module reinstates it one level up, per process: an
// unowned write can only ever land in a database the rules below recognise, and
// the two scripts that could populate a shared environment — `catalog-load` and
// `recipes-seed` — proceed against a non-development database only when a human
// has typed that database's name after `--confirm-target`. `seed-dev` is the one
// script here that writes user-scoped rows, which is exactly what §5.1 protects,
// so it gets no confirmation door at all.
//
// Nothing in this file opens a connection or reads a credential. It imports only
// ./logger (deliberately not Prisma — the whole point is to be safe to load
// before any client exists), classifies the DATABASE_URL it is handed, and
// refuses. The URL value itself is never logged, thrown or interpolated: its
// userinfo carries the database password (.env.example:2), so only the parsed
// host, the database name and the resulting classification ever reach a log.

import { createLogger, describeMissingEnv, safeError } from './logger';
import type { ScriptLogger } from './logger';

export type DatabaseOriginClass = 'development' | 'test' | 'shadow' | 'unknown';

export interface DatabaseOrigin {
    originClass: DatabaseOriginClass;
    /** `''` when the URL is missing or unparsable — never a guess at a real host. */
    host: string;
    /** `''` when the URL is missing or unparsable. */
    database: string;
    /** Safe to log: a fixed phrase naming the rule that matched, never URL content. */
    reason: string;
}

export type ScriptDatabasePolicy = 'development_only' | 'development_or_confirmed' | 'any_recognised';

export type DatabaseGuardCode =
    | 'missing_database_url'
    | 'unparsable_database_url'
    | 'unrecognised_origin'
    | 'confirmation_required'
    | 'confirmation_mismatch'
    | 'development_only';

// §8: a failure the caller must distinguish carries the data rather than a
// string, following entitlement.service.ts's DailyQuotaError. `origin` travels
// with the error so the reporter can log the classification without re-reading
// the environment.
export class DatabaseOriginError extends Error {
    constructor(
        message: string,
        public readonly code: DatabaseGuardCode,
        public readonly origin: DatabaseOrigin,
    ) {
        super(message);
        this.name = 'DatabaseOriginError';
    }
}

const DATABASE_URL_ENV = 'DATABASE_URL';

const CONFIRM_TARGET_FLAG = '--confirm-target';

// Hosts that can only be this machine or the container network beside it.
// Exported because src/__tests__/setup/testDb.ts::assertTestDatabase builds its
// own check on these same rules; duplicating them there would let the two drift.
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', 'postgres'];

// Narrower than LOCAL_HOSTS on purpose. `postgres` is a container-network
// service name, which in CI or a compose stack can resolve to a database that is
// nobody's development box. It earns membership in the test and `ci` rules,
// where the database *name* is what identifies the origin, but it must not make
// an unrecognised name pass as development: `…@postgres/state_of_health` is
// therefore `unknown` and refused, while `…@postgres/soh_test` is `test`.
export const DEVELOPMENT_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

export const TEST_DATABASE_SUFFIX = '_test';
export const SHADOW_DATABASE_SUFFIX = '_shadow';
export const DEVELOPMENT_DATABASE_SUFFIX = '_dev';
export const CI_DATABASE_NAME = 'ci';

const RECOGNISED_ORIGIN_CLASSES = 'development, test or shadow';

// Reused as identity in evaluateScriptDatabase, which is how an `unknown`
// classification is mapped back to the precise guard code without re-parsing.
const REASON_MISSING_DATABASE_URL = describeMissingEnv(DATABASE_URL_ENV);
const REASON_UNPARSABLE_DATABASE_URL = `${DATABASE_URL_ENV} could not be parsed`;
const REASON_TEST_SUFFIX = `database name ends in ${TEST_DATABASE_SUFFIX}`;
const REASON_CI_NAME = `database name is ${CI_DATABASE_NAME} on a local host`;
const REASON_SHADOW_SUFFIX = `database name ends in ${SHADOW_DATABASE_SUFFIX}`;
const REASON_DEVELOPMENT_SUFFIX = `database name ends in ${DEVELOPMENT_DATABASE_SUFFIX}`;
const REASON_DEVELOPMENT_HOST = 'host is a development host';
const REASON_NO_RULE_MATCHED = 'host is not a development host and the database name matches no recognised suffix';

export const SCRIPT_DATABASE_POLICIES: Readonly<Record<string, ScriptDatabasePolicy>> = {
    // The loader is the only sanctioned way to populate a shared environment
    // with catalog data, so it keeps a door — guarded by an explicit flag.
    'catalog-load': 'development_or_confirmed',
    'recipes-seed': 'development_or_confirmed',
    // Writes user-scoped rows (a development user, its preferences, its diary
    // buckets), so there is no door to open.
    'seed-dev': 'development_only',
    // Development-machine pipeline stages. They still must never address an
    // origin this module cannot classify.
    'catalog-import-usda': 'any_recognised',
    'catalog-generate-ai': 'any_recognised',
    'catalog-validate': 'any_recognised',
    'catalog-report': 'any_recognised',
    'catalog-release': 'any_recognised',
    'search-benchmark': 'any_recognised',
};

// A script name absent from the table is a caller mistake, and a mistake must
// not make the guard weaker than its strictest setting.
const FALLBACK_POLICY: ScriptDatabasePolicy = 'development_only';

export const parseDatabaseUrl = (databaseUrl: string): { host: string; database: string; port: string } | null => {
    let parsed: URL;
    try {
        parsed = new URL(databaseUrl);
    } catch {
        return null;
    }

    // `postgresql:` is not a WHATWG "special" scheme, so its authority is parsed
    // as an opaque host: unlike an http URL the host is *not* lower-cased and a
    // fully-qualified trailing dot survives. Both are normalised here, or
    // `…@LOCALHOST/soh_dev` and `…@localhost./soh_dev` would miss the host rule
    // and be refused as unrecognised origins.
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
    // Left percent-encoded on purpose: decodeURIComponent throws on a malformed
    // sequence, and an encoded name simply matches no suffix, which fails closed.
    const database = parsed.pathname.replace(/^\//, '');

    // `postgresql://host:5432` and `…:5432/` both parse but name no database, so
    // there is nothing to classify.
    if (database.length === 0) {
        return null;
    }

    return { host, database, port: parsed.port };
};

export const classifyDatabaseOrigin = (databaseUrl: string | undefined): DatabaseOrigin => {
    if (!databaseUrl || databaseUrl.trim().length === 0) {
        return { originClass: 'unknown', host: '', database: '', reason: REASON_MISSING_DATABASE_URL };
    }

    const parsed = parseDatabaseUrl(databaseUrl);
    if (parsed === null) {
        return { originClass: 'unknown', host: '', database: '', reason: REASON_UNPARSABLE_DATABASE_URL };
    }

    const { host, database } = parsed;

    // NAME BEFORE HOST — this order is a decision, not an accident, and must not
    // be rearranged. The operator setup provisions soh_dev, soh_test and
    // soh_shadow on the same localhost (Agent Action Plan §0.4.4), so the host
    // establishes only "not production"; the database *name* is the only thing
    // that tells the three apart. If the host rule ran first, soh_test on
    // localhost would classify `development`, `catalog-load` would stop demanding
    // `--confirm-target`, and the §0.9.1 gate — which requires
    // `catalog:load --release v1 --confirm-target soh_test` to succeed *while the
    // same run without the flag is refused* — would pass vacuously, silently
    // voiding the only automated proof that the confirmation door exists.
    // `shadow` is its own class rather than a flavour of development because
    // Prisma's `migrate diff` resets that database.
    if (database.endsWith(TEST_DATABASE_SUFFIX)) {
        return { originClass: 'test', host, database, reason: REASON_TEST_SUFFIX };
    }
    // CI's database is named plainly, so the local-host requirement is what keeps
    // a remote database that happens to be called `ci` out of this class.
    if (database === CI_DATABASE_NAME && LOCAL_HOSTS.includes(host)) {
        return { originClass: 'test', host, database, reason: REASON_CI_NAME };
    }
    if (database.endsWith(SHADOW_DATABASE_SUFFIX)) {
        return { originClass: 'shadow', host, database, reason: REASON_SHADOW_SUFFIX };
    }
    if (database.endsWith(DEVELOPMENT_DATABASE_SUFFIX)) {
        return { originClass: 'development', host, database, reason: REASON_DEVELOPMENT_SUFFIX };
    }
    if (DEVELOPMENT_HOSTS.includes(host)) {
        return { originClass: 'development', host, database, reason: REASON_DEVELOPMENT_HOST };
    }

    return { originClass: 'unknown', host, database, reason: REASON_NO_RULE_MATCHED };
};

export const parseConfirmTarget = (argv: readonly string[]): string | null => {
    const prefixed = `${CONFIRM_TARGET_FLAG}=`;

    for (let index = 0; index < argv.length; index += 1) {
        const argument = argv[index];

        if (argument === CONFIRM_TARGET_FLAG) {
            // `--confirm-target --release` names no database. Reading the next
            // flag as the answer would fabricate a confirmation the operator
            // never gave, so a missing value is `null`, never `''`.
            const value = index + 1 < argv.length ? argv[index + 1] : '';
            return value.length === 0 || value.startsWith('--') ? null : value;
        }

        if (argument.startsWith(prefixed)) {
            const value = argument.slice(prefixed.length);
            return value.length === 0 || value.startsWith('--') ? null : value;
        }
    }

    return null;
};

export const entryScriptName = (argv: readonly string[]): string | null => {
    if (argv.length < 2) {
        return null;
    }

    const entry = argv[1];
    if (entry.length === 0) {
        return null;
    }

    // Basename by hand: only ./logger may be imported, so `path` is unavailable.
    // Both separators are handled so a Windows checkout classifies identically.
    const lastSeparator = Math.max(entry.lastIndexOf('/'), entry.lastIndexOf('\\'));
    const basename = lastSeparator >= 0 ? entry.slice(lastSeparator + 1) : entry;
    const script = basename.replace(/\.(ts|js)$/, '');

    // hasOwnProperty, not `in`: a file named `constructor.ts` or `toString.ts`
    // would otherwise resolve through Object's prototype and be treated as a
    // known script with a nonsense policy.
    return Object.prototype.hasOwnProperty.call(SCRIPT_DATABASE_POLICIES, script) ? script : null;
};

export const evaluateScriptDatabase = (input: {
    script: string;
    policy: ScriptDatabasePolicy;
    origin: DatabaseOrigin;
    confirmTarget: string | null;
}): { allowed: true } | { allowed: false; code: DatabaseGuardCode; message: string } => {
    const { script, policy, origin, confirmTarget } = input;
    const target = `database "${origin.database}" on host "${origin.host}"`;

    if (origin.originClass === 'unknown') {
        if (origin.reason === REASON_MISSING_DATABASE_URL) {
            return {
                allowed: false,
                code: 'missing_database_url',
                message: `${script} needs ${DATABASE_URL_ENV} to be set, and it is not.`,
            };
        }
        if (origin.reason === REASON_UNPARSABLE_DATABASE_URL) {
            return {
                allowed: false,
                code: 'unparsable_database_url',
                message: `${script} cannot read ${DATABASE_URL_ENV}: it is not a connection URL naming a database.`,
            };
        }
        return {
            allowed: false,
            code: 'unrecognised_origin',
            message: `${script} refuses to run against ${target}: it is not a recognised ${RECOGNISED_ORIGIN_CLASSES} origin.`,
        };
    }

    if (policy === 'development_only' && origin.originClass !== 'development') {
        return {
            allowed: false,
            code: 'development_only',
            message:
                `${script} writes user-scoped rows, so it runs against a development database only ` +
                `(host ${DEVELOPMENT_HOSTS.join(' or ')}, or a name ending ${DEVELOPMENT_DATABASE_SUFFIX}); ` +
                `${target} is ${origin.originClass}. There is no confirmation flag for this script.`,
        };
    }

    if (policy === 'development_or_confirmed' && origin.originClass !== 'development') {
        if (confirmTarget === null) {
            return {
                allowed: false,
                code: 'confirmation_required',
                message:
                    `${script} would write to the ${origin.originClass} ${target}: ` +
                    `pass ${CONFIRM_TARGET_FLAG} ${origin.database} to confirm.`,
            };
        }
        if (confirmTarget !== origin.database) {
            return {
                allowed: false,
                code: 'confirmation_mismatch',
                message:
                    `${script} was confirmed for database "${confirmTarget}", but ${DATABASE_URL_ENV} ` +
                    `points at ${target}.`,
            };
        }
    }

    return { allowed: true };
};

export const assertScriptDatabase = (options: {
    script: string;
    argv?: readonly string[];
    env?: NodeJS.ProcessEnv;
    logger?: ScriptLogger;
}): DatabaseOrigin => {
    const { script } = options;
    // The only place in this module that touches `process` (§1.6/§9: config is
    // read once, at the boundary, and never branched on deeper down). Both
    // sources are injectable so every rule above is reachable from a unit test
    // without spawning a process.
    const argv = options.argv ?? process.argv;
    const env = options.env ?? process.env;

    const origin = classifyDatabaseOrigin(env[DATABASE_URL_ENV]);
    const policy = Object.prototype.hasOwnProperty.call(SCRIPT_DATABASE_POLICIES, script)
        ? SCRIPT_DATABASE_POLICIES[script]
        : FALLBACK_POLICY;
    const verdict = evaluateScriptDatabase({
        script,
        policy,
        origin,
        confirmTarget: parseConfirmTarget(argv),
    });

    if (!verdict.allowed) {
        throw new DatabaseOriginError(verdict.message, verdict.code, origin);
    }

    // Diagnostics only, and below the logger's default level so an ordinary run
    // stays quiet — the refusal is the path that has to be loud. This function
    // throws rather than logging a refusal itself (§8: throw, and let the
    // reporter report once).
    if (options.logger) {
        options.logger.debug('database_origin_accepted', {
            script,
            policy,
            originClass: origin.originClass,
            host: origin.host,
            database: origin.database,
        });
    }

    return origin;
};

// Module-load enforcement — the single side effect of importing this file.
//
// TypeScript's CommonJS emit hoists every module load above the module body, so
// a script that imports the shared PrismaClient singleton and then calls
// assertScriptDatabase() from its own top level has already executed
// `new PrismaClient()` — that client module is two lines, and its second one
// constructs the client at import time — by the time the call runs. Enforcing at
// import time is therefore the only placement that actually precedes the client,
// and it is one of the two side effects this folder sanctions (the other being
// bootstrap.ts's DNS and dotenv ordering).
//
// When argv[1] is not one of the nine known scripts, this block does NOTHING —
// deliberately, and load-bearingly. That no-op path is what lets
// src/__tests__/setup/testDb.ts import classifyDatabaseOrigin and the suffix and
// host constants, and what lets src/__tests__/scripts/catalog-import.test.ts,
// catalog-generate.test.ts, catalog-load.test.ts and recipes-seed.test.ts import
// their scripts for the run*(deps) entry points: under Jest argv[1] is the jest
// binary, and importing a module must never end a test run. Inside Jest the
// database guard is jestSetup.ts's assertTestDatabase(), which is built on the
// same exported rules.
const entryScript = entryScriptName(process.argv);
if (entryScript !== null) {
    try {
        assertScriptDatabase({ script: entryScript });
    } catch (error) {
        if (!(error instanceof DatabaseOriginError)) {
            // A genuine bug in this module must surface as itself, not as a
            // refusal an operator would try to fix with a flag.
            throw error;
        }
        createLogger('dbGuard').error('database_origin_refused', {
            script: entryScript,
            code: error.code,
            originClass: error.origin.originClass,
            host: error.origin.host,
            database: error.origin.database,
            error: safeError(error),
        });
        process.exit(1);
    }
}
