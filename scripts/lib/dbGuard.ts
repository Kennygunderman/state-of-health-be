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

import { createFatalLogger, describeMissingEnv, safeError } from './logger';
import type { ScriptLogger } from './logger';

export type DatabaseOriginClass = 'development' | 'test' | 'shadow' | 'unknown';

export interface DatabaseOrigin {
    originClass: DatabaseOriginClass;
    /**
     * `''` whenever the URL does not fix the host — missing, unparsable, naming
     * no authority, or overridden by a connection parameter in its query
     * string. Never a guess at a real host.
     */
    host: string;
    /**
     * The database name exactly as the URL spells it — no percent-decoding,
     * because that is the name Prisma opens (see parseDatabaseUrl). `''` when
     * the URL is missing, unparsable, or names a database its query string
     * could override.
     */
    database: string;
    /** Safe to log: a fixed phrase naming the rule that matched, never URL content. */
    reason: string;
}

export type ScriptDatabasePolicy = 'development_only' | 'development_or_confirmed' | 'any_recognised';

export type DatabaseGuardCode =
    | 'missing_database_url'
    | 'unparsable_database_url'
    | 'ambiguous_database_url'
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
// The rules themselves are `isLocalDatabaseHost`, `isTestDatabaseOrigin` and
// `isShadowDatabaseOrigin` below, which is what that guard should import.
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

// Connection parameters that move the connection somewhere other than the
// authority and path the URL displays. libpq reads `host`, `hostname`, `port`,
// `dbname` and the `service`/`servicefile` indirection from the query string,
// and both pg-connection-string and Prisma honour the same keys — verified:
// `postgresql://soh:soh@127.0.0.1:5433/soh_dev?host=prod.example.com` parses to
// host `prod.example.com`, and `?port=6000` replaces the port. A guard that
// classified the authority while the driver connected elsewhere would be
// decoration, so any of these present makes the origin unclassifiable rather
// than `development`.
//
// Only the parameter NAMES are ever reported: an operator's value can be a
// service name or a socket directory, and this module logs nothing from the
// URL beyond the classified host and database.
export const CONNECTION_REDIRECTING_PARAMS: readonly string[] = [
    'host',
    'hostname',
    'port',
    'dbname',
    'database',
    'db',
    'service',
    'servicefile',
];

const RECOGNISED_ORIGIN_CLASSES = 'development, test or shadow';

// Reused as identity in evaluateScriptDatabase, which is how an `unknown`
// classification is mapped back to the precise guard code without re-parsing.
const REASON_MISSING_DATABASE_URL = describeMissingEnv(DATABASE_URL_ENV);
const REASON_UNPARSABLE_DATABASE_URL = `${DATABASE_URL_ENV} could not be parsed`;
// A prefix rather than a whole phrase because the matched parameter names are
// appended: they are fixed constants from CONNECTION_REDIRECTING_PARAMS, never
// operator values, so the result stays safe to log. evaluateScriptDatabase
// recognises this reason by its prefix, which is how the names reach the
// operator-facing message without re-parsing the URL.
const REASON_CONNECTION_PARAMS_PREFIX = `${DATABASE_URL_ENV} query string sets connection parameters: `;

const describeConnectionRedirectingParams = (params: readonly string[]): string =>
    `${REASON_CONNECTION_PARAMS_PREFIX}${params.join(', ')}`;

// The other way a URL can fail to name its own target, and the reason it is a
// refusal rather than a classification: `postgresql:///soh_dev` parses, and
// names a database, but carries no authority — verified with
// pg-connection-string, which returns `host: ''` for it. Both `pg` and libpq
// then fall back to PGHOST/PGSERVICE or the default unix socket, so the server
// is chosen outside the URL and can be anywhere, while the `_dev` name rule
// below would otherwise certify the origin as `development`. A host the guard
// cannot see is a host it cannot vouch for.
const REASON_NO_HOST = `${DATABASE_URL_ENV} names no host`;

// The third, and the one that is not a matter of degree: with Prisma opening the
// literal database name and pg decoding it (both measured — see
// parseDatabaseUrl), an encoded name has two possible targets and the guard
// cannot vouch for either.
const REASON_ENCODED_NAME = `${DATABASE_URL_ENV} database name is percent-encoded`;

const REASON_TEST_SUFFIX = `database name ends in ${TEST_DATABASE_SUFFIX} on a local host`;
const REASON_CI_NAME = `database name is ${CI_DATABASE_NAME} on a local host`;
const REASON_SHADOW_SUFFIX = `database name ends in ${SHADOW_DATABASE_SUFFIX} on a local host`;
const REASON_DEVELOPMENT_SUFFIX = `database name ends in ${DEVELOPMENT_DATABASE_SUFFIX}`;
const REASON_DEVELOPMENT_HOST = 'host is a development host';
const REASON_NO_RULE_MATCHED =
    'the database name matches no recognised rule on this host and the host is not a development host';

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
    //
    // The host is deliberately NOT percent-decoded. A `%` can never appear in a
    // LOCAL_HOSTS or DEVELOPMENT_HOSTS entry, so an encoded host matches no host
    // rule and the origin falls to `unknown` — a refusal. Decoding here could
    // only ever turn a refusal into an acceptance, so the asymmetry with the
    // database name below is the fail-closed direction, not an oversight.
    const host = parsed.hostname.toLowerCase().replace(/\.$/, '');

    // `postgresql://host:5432` and `…:5432/` both parse but name no database, so
    // there is nothing to classify.
    const encodedDatabase = parsed.pathname.replace(/^\//, '');
    if (encodedDatabase.length === 0) {
        return null;
    }

    // The name is returned LITERALLY — exactly the text between the path's
    // leading slash and the query — because that is the database these scripts
    // actually open. Measured against this repository's two connectors, which
    // disagree: Prisma 6 does not percent-decode the datasource path (a client
    // pointed at `…/soh%5Fprobe_46` connected to a database literally named
    // `soh%5Fprobe_46`, and `…/soh%5Fdev_46` failed with "Database
    // `soh%5Fdev_46` does not exist" while `soh_dev_46` existed), whereas
    // pg-connection-string runs `decodeURI` and reports `soh_probe_46` for the
    // same URL. The scripts connect through Prisma, so the literal text is the
    // truthful name — and because no single spelling can agree with both,
    // classifyDatabaseOrigin refuses any encoded name outright rather than
    // picking one (hasEncodedDatabaseName below).
    //
    // decodeURIComponent is still called, for its validity check only: a
    // malformed escape (`soh%ZZ`) throws URIError, and that is answered with
    // `null` so the origin becomes `unparsable_database_url` and the run is
    // refused. Its result is deliberately discarded.
    try {
        decodeURIComponent(encodedDatabase);
    } catch {
        return null;
    }

    const database = encodedDatabase;

    return { host, database, port: parsed.port };
};

/**
 * Which CONNECTION_REDIRECTING_PARAMS the URL's query string carries, in the
 * fixed order of that list so the answer — and the message built from it — is
 * deterministic whatever order the operator wrote them in.
 *
 * Keys are compared case-insensitively and after percent-decoding (which
 * `URL.searchParams` performs), because `?HOST=` and `?%68ost=` are the same
 * parameter to a connector that lower-cases its keywords. Values are read but
 * never returned. An unparsable URL yields `[]`: parseDatabaseUrl already
 * refuses it as `unparsable_database_url`.
 */
export const findConnectionRedirectingParams = (databaseUrl: string): string[] => {
    let parsed: URL;
    try {
        parsed = new URL(databaseUrl);
    } catch {
        return [];
    }

    const present = new Set<string>();
    parsed.searchParams.forEach((_value, key) => {
        present.add(key.trim().toLowerCase());
    });

    return CONNECTION_REDIRECTING_PARAMS.filter((parameter) => present.has(parameter));
};

/**
 * Whether the URL's database name carries a percent escape, which makes the
 * name unclassifiable rather than merely odd.
 *
 * A literal `%` in a URL path has to be written `%25`, so a `%` in the path can
 * only introduce an escape — and the two connectors in this repository resolve
 * escapes differently (Prisma opens the literal name, `pg` decodes it; both
 * measured, see parseDatabaseUrl). Whichever spelling the guard classified, the
 * other connector would open a different database, which is the whole failure
 * mode: `…@prod.example.com/prod%5Fdev` classified on the decoded name is a
 * REMOTE database certified `development` by the host-independent `_dev` rule,
 * while `…@127.0.0.1/soh%5Ftest` classified on the literal name skips the
 * `_test` rule and loses `catalog-load`'s `--confirm-target`. Refusing the
 * encoded form is the only answer that is wrong in neither direction.
 *
 * The cost is that a database whose real name contains a `%` cannot be reached
 * through these scripts at all. That is accepted: no environment this pipeline
 * supports names one that way, and the refusal says exactly what to change.
 */
export const hasEncodedDatabaseName = (databaseUrl: string): boolean => {
    let parsed: URL;
    try {
        parsed = new URL(databaseUrl);
    } catch {
        return false;
    }
    return parsed.pathname.replace(/^\//, '').includes('%');
};

/** The canonical pair every rule below decides on, exactly as parseDatabaseUrl returns it. */
export interface DatabaseTarget {
    host: string;
    database: string;
}

// The origin rules as pure predicates, so the one place that owns them is this
// module. src/__tests__/setup/testDb.ts::assertTestDatabase is specified
// (Agent Action Plan §0.7.1) to accept exactly the same origins as the `test`
// class here, and the comment on LOCAL_HOSTS above already promises that
// sharing: it imports these instead of re-deriving `_test`/`ci` from the
// constants, because a second derivation is a second place to get wrong.
//
// Host comparison is on the normalised host parseDatabaseUrl produces;
// database-name comparison is case-sensitive on purpose — PostgreSQL database
// names are case-sensitive, and `--confirm-target` is compared exactly, so
// folding case here would accept a confirmation the operator never typed.
export const isLocalDatabaseHost = (host: string): boolean => LOCAL_HOSTS.includes(host);

// Local-host-gated, which is the whole point: a `_test` suffix is a naming
// convention, not a property of the server, so `…@prod.example.com/app_test`
// is a production database wearing a test name. Gating both halves of this
// rule on LOCAL_HOSTS keeps such an origin `unknown`, which every policy —
// including `any_recognised` — refuses.
export const isTestDatabaseOrigin = (target: DatabaseTarget): boolean =>
    isLocalDatabaseHost(target.host) &&
    (target.database.endsWith(TEST_DATABASE_SUFFIX) || target.database === CI_DATABASE_NAME);

// Local-host-gated for the same reason, and more urgently: Prisma's
// `migrate diff`/`migrate dev --create-only` RESET the shadow database, so a
// remote database named `…_shadow` classifying as `shadow` would be a remote
// database this pipeline is willing to have dropped and recreated.
export const isShadowDatabaseOrigin = (target: DatabaseTarget): boolean =>
    isLocalDatabaseHost(target.host) && target.database.endsWith(SHADOW_DATABASE_SUFFIX);

export const classifyDatabaseOrigin = (databaseUrl: string | undefined): DatabaseOrigin => {
    if (!databaseUrl || databaseUrl.trim().length === 0) {
        return { originClass: 'unknown', host: '', database: '', reason: REASON_MISSING_DATABASE_URL };
    }

    const parsed = parseDatabaseUrl(databaseUrl);
    if (parsed === null) {
        return { originClass: 'unknown', host: '', database: '', reason: REASON_UNPARSABLE_DATABASE_URL };
    }

    // Fail closed by design: when the query string can redirect the connection,
    // the parsed authority is not the target, so there is nothing here worth
    // classifying and `host`/`database` are reported empty rather than as a
    // guess the operator might trust. This also refuses the legitimate local
    // unix-socket form `…/soh_dev?host=/var/run/postgresql`; that is accepted
    // as the cost of the rule, and `ambiguous_database_url` says what to do
    // about it (point DATABASE_URL directly at the database, which for a local
    // socket means the TCP URL the operator setup provisions).
    const redirectingParams = findConnectionRedirectingParams(databaseUrl);
    if (redirectingParams.length > 0) {
        return {
            originClass: 'unknown',
            host: '',
            database: '',
            reason: describeConnectionRedirectingParams(redirectingParams),
        };
    }

    const { host, database } = parsed;

    // Third form of "the URL does not determine its own target", and the one
    // that cannot be settled by choosing a canonicalisation: the connectors
    // disagree about percent escapes in the database name, so an encoded name
    // is refused rather than classified under either spelling. Host and the
    // literal name are both reported — they are the two things the operator
    // has to look at — and the message names the remedy.
    if (hasEncodedDatabaseName(databaseUrl)) {
        return { originClass: 'unknown', host, database, reason: REASON_ENCODED_NAME };
    }

    // Same fail-closed reasoning as the query-parameter check above, for the
    // other half of "the URL does not determine its own target": with no
    // authority there is no host to apply a host rule to, and no host rule is
    // what makes the name rules the whole decision — `postgresql:///soh_dev`
    // would be `development` on a server chosen by PGHOST. The database name is
    // still reported, because it is the one part of the target the URL does fix.
    if (host.length === 0) {
        return { originClass: 'unknown', host: '', database, reason: REASON_NO_HOST };
    }

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
    //
    // The name rules are local-host-gated (isTestDatabaseOrigin /
    // isShadowDatabaseOrigin); the `_dev` rule below is not. That asymmetry is
    // the Agent Action Plan §0.7.1 definition, not an inconsistency: `test` and
    // `shadow` are "the assertTestDatabase rules", which require a host in
    // LOCAL_HOSTS, while `development` is defined there as the disjunction
    // "host in {localhost, 127.0.0.1} OR name ending _dev". A `_dev` name on a
    // remote host therefore still classifies `development` by specification —
    // and it is the weakest class to land in only for `seed-dev`, which writes
    // user-scoped rows it created itself.
    if (isTestDatabaseOrigin({ host, database })) {
        // CI's database is named plainly (`ci`), so the two halves of the test
        // rule are distinguished here only to name the matched rule in `reason`.
        const reason = database.endsWith(TEST_DATABASE_SUFFIX) ? REASON_TEST_SUFFIX : REASON_CI_NAME;
        return { originClass: 'test', host, database, reason };
    }
    if (isShadowDatabaseOrigin({ host, database })) {
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
        // All three "the URL does not determine its own target" reasons —
        // an encoded database name, a redirecting query parameter, and a URL
        // with no host — share the `ambiguous_database_url` code, because in
        // each the URL parses and the origin is not unrecognised, it is
        // undetermined. Each keeps its own message: the operator fixes the
        // three differently.
        if (origin.reason === REASON_ENCODED_NAME) {
            return {
                allowed: false,
                code: 'ambiguous_database_url',
                message:
                    `${script} cannot classify ${DATABASE_URL_ENV}: its database name "${origin.database}" is ` +
                    'percent-encoded, and Prisma would open that name literally while other PostgreSQL ' +
                    'clients would decode it, so the two name different databases. Write the database ' +
                    `name literally in ${DATABASE_URL_ENV}.`,
            };
        }
        if (origin.reason === REASON_NO_HOST) {
            return {
                allowed: false,
                code: 'ambiguous_database_url',
                message:
                    `${script} cannot classify ${DATABASE_URL_ENV}: it names no host, so the server would ` +
                    'come from the environment (PGHOST/PGSERVICE) or a default socket rather than from the ' +
                    `URL. Set ${DATABASE_URL_ENV} to a URL naming both the host and the database.`,
            };
        }
        // Prefix match, because this reason carries the matched parameter names
        // (fixed constants) after the prefix; the message names them so the
        // operator can see which keyword has to go.
        if (origin.reason.startsWith(REASON_CONNECTION_PARAMS_PREFIX)) {
            const parameters = origin.reason.slice(REASON_CONNECTION_PARAMS_PREFIX.length);
            return {
                allowed: false,
                code: 'ambiguous_database_url',
                message:
                    `${script} cannot classify ${DATABASE_URL_ENV}: its query string sets connection ` +
                    `parameters that can change the target (${parameters}); point ${DATABASE_URL_ENV} ` +
                    'directly at the database instead.',
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
        // createFatalLogger, not createLogger: the next statement is
        // process.exit(1), which discards whatever is still buffered in
        // process.stderr — measured at one pipe buffer (65,536 bytes) of a
        // larger write surviving, against all of it when the same bytes go
        // through fs.writeSync. The refusal reason is the only artefact this
        // path produces, and AAP §0.7.1 requires the guard to say why it
        // refused, so it is written to the descriptor before the exit.
        createFatalLogger('dbGuard').error('database_origin_refused', {
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
