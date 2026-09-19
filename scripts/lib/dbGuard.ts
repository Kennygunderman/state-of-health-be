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
// unowned write can only ever land in a database the rules below recognise.
//
// FOUR RULES DECIDE EVERY RUN, and the first two admit no exception:
//
//   1. An origin this module cannot classify is refused. Every recognised class
//      requires a LOCAL host, so a `_dev`, `_test` or `_shadow` name on a
//      remote host is `unknown` and no flag reaches it.
//   2. The SHADOW database is refused to every script. Prisma's schema tooling
//      resets it, so nothing of value may live there and nothing may write
//      there (§0.4.4). `evaluateShadowDatabase` at the foot of this file is its
//      mirror: the schema tooling may address a shadow database and nothing
//      else.
//   3. A database that is development by its HOST ALONE is not a licence. The
//      host arm of the development class covers every database answering on
//      loopback — a deployment database reached through an SSH tunnel or a
//      published container port included — so only a database whose own NAME
//      says development (a `_dev` suffix, with or without a clone index, on a
//      local host) is treated as one. `seed-dev`, which writes user-scoped rows
//      and deletes them with `--reset-user` (exactly what §5.1 protects),
//      requires that and has no confirmation door. The four stages that MUTATE
//      shared catalog data require it or a `_test` database, and have no door
//      either: reviewed catalog data reaches a shared environment through
//      `catalog-load`.
//   4. `catalog-load` and `recipes-seed` — the two writers §0.7.5 does point at
//      a deployment database — proceed without a human typing that database's
//      name after `--confirm-target` only under rule 3's licence; anywhere else
//      the typed name is required.
//
// A URL must also DETERMINE ITS OWN TARGET, in four ways: no connection
// parameter that moves the server or the database, no percent-escape in the
// database name, an authority that names a host, and no parameter that
// redirects the SCHEMA an unqualified statement resolves in (measured, see
// SCHEMA_REDIRECTING_PARAMS — `?options=-c search_path=…` made a legitimate
// `_test` URL resolve its tables in another schema of that database under both
// connectors this repository uses).
//
// Nothing in this file opens a connection or reads a credential. It imports only
// ./logger (deliberately not Prisma — the whole point is to be safe to load
// before any client exists), classifies the DATABASE_URL it is handed, and
// refuses. The URL value itself is never logged, thrown or interpolated: its
// userinfo carries the database password (.env.example:2), and the parsed host
// and database name do not reach a log either — {@link originLogFields} is the
// one shape an origin is reported in, and it carries the classification, the
// fixed reason and an opaque digest of the target instead (see the reasoning
// there).

import { createFatalLogger, describeMissingEnv, isThrownInstanceOf, opaqueDigest, safeError } from './logger';
import type { LogFields, ScriptLogger } from './logger';

export type DatabaseOriginClass = 'development' | 'test' | 'shadow' | 'unknown';

/**
 * WHICH HALF of a recognised class's rule matched — the database's own name, or
 * the host on its own. Every recognised class is host-gated, so `'name'` always
 * means "this name, on a local host"; `'host'` is reachable only through the
 * DEVELOPMENT_HOSTS arm at the end of classifyDatabaseOrigin, where the name
 * matched no rule at all.
 */
export type DatabaseOriginMatch = 'name' | 'host';

export interface DatabaseOrigin {
    originClass: DatabaseOriginClass;
    /**
     * Which half of the matched rule certified this origin, on a recognised
     * class; absent on `unknown`, where no rule matched.
     *
     * OPTIONAL by design, so a caller composing a `DatabaseOrigin`-shaped
     * literal to drive evaluateScriptDatabase keeps compiling. That optionality
     * is the one place the policy could be weakened by omission, so the
     * `development_or_confirmed` branch treats an absent value as `'host'` —
     * the stricter reading, which demands the typed database name.
     */
    match?: DatabaseOriginMatch;
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

/**
 * THE ONE SHAPE AN ORIGIN IS REPORTED IN — by this module's own two log lines
 * and by all nine stage entry points, which is what keeps a terminal, a CI log
 * and a committed report from disagreeing about what a run is allowed to say
 * about its target.
 *
 * WHAT IS IN IT, AND WHY NOT THE HOST AND THE DATABASE NAME. The classification
 * is the fact a reader needs — `development`, `test`, `shadow` — together with
 * WHICH half of the rule certified it and the fixed `reason` phrase naming that
 * rule. The host and the database name were also being logged, and they are
 * infrastructure topology: a stage log is read in a terminal, retained by CI and
 * copied into `catalog_import_runs.log` and the committed report artefacts, so
 * every run was publishing the name and address of an internal database to all
 * three (CWE-532). Neither value decides anything a reader acts on — the policy
 * decision is already in `originClass`/`match`, and the refusal path carries a
 * `code` — so they are replaced by a digest.
 *
 * `targetDigest` is one-way (see {@link opaqueDigest}) and answers exactly one
 * question: were two runs pointed at the same database. An operator who needs
 * to know WHICH database computes the digest from their own `DATABASE_URL`;
 * nothing in the log discloses it. The `host`/`database` fields the origin
 * carries remain available to callers that must ACT on them — the confirmation
 * flag compares `--confirm-target` against `origin.database` — because acting
 * on a value in memory is not the same as printing it.
 */
export const originLogFields = (origin: DatabaseOrigin): LogFields => ({
    originClass: origin.originClass,
    // Stated as the policy reads it rather than as the field spells it: an
    // absent `match` is treated as `'host'` everywhere in this module (see
    // DatabaseOrigin), so reporting it as absent would describe a different
    // origin from the one that was evaluated.
    match: origin.match ?? 'host',
    reason: origin.reason,
    targetDigest: opaqueDigest(`${origin.host}/${origin.database}`),
});

/**
 * What a script is allowed to address, from strictest to most permissive. Every
 * one of them is additionally gated by two rules that no policy can waive: an
 * origin this module cannot classify is refused, and a `shadow` origin is
 * refused (see `evaluateScriptDatabase`).
 *
 *   `development_only`          A database whose own NAME says development, on a
 *                               local host. No confirmation flag exists, and
 *                               "development by its host alone" is not enough.
 *                               For a script that writes user-scoped rows.
 *   `development_or_test`       The same, or a `test`-class database. No
 *                               confirmation flag. For the build stages that
 *                               MUTATE shared catalog data, which are produced
 *                               on a development machine and installed
 *                               elsewhere by `catalog-load`.
 *   `development_or_confirmed`  Development by name needs nothing; any other
 *                               recognised origin needs `--confirm-target
 *                               <dbname>`. For the two writers that may be
 *                               asked to populate a shared environment.
 *   `read_only_recognised`      Any recognised origin, including one that is
 *                               development by its host alone. For stages that
 *                               only READ, so there is nothing to confirm.
 */
export type ScriptDatabasePolicy =
    | 'development_only'
    | 'development_or_test'
    | 'development_or_confirmed'
    | 'read_only_recognised';

export type DatabaseGuardCode =
    | 'missing_database_url'
    | 'unparsable_database_url'
    | 'ambiguous_database_url'
    | 'unrecognised_origin'
    | 'confirmation_required'
    | 'confirmation_mismatch'
    | 'development_only'
    // A pipeline script addressed the shadow database. Its own code rather than
    // one of the two above, because no policy and no flag changes the answer.
    | 'shadow_database'
    // The mirror of it: the schema tooling addressed something that is NOT the
    // shadow database (see evaluateShadowDatabase).
    | 'shadow_required';

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

/**
 * The confirmation flag, exported because two modules must agree on it and
 * only one of them parses it. `parseConfirmTarget` below reads it; the refusal
 * messages here and in `src/__tests__/setup/testDb.ts`'s guarded recreate NAME
 * it, and a message naming a flag the parser no longer recognises is a remedy
 * that does not work. One spelling, so the two cannot drift apart.
 */
export const CONFIRM_TARGET_FLAG = '--confirm-target';

// Hosts that can only be this machine or the container network beside it.
// Exported because src/__tests__/setup/testDb.ts::assertTestDatabase builds its
// own check on these same rules; duplicating them there would let the two drift.
// The rules themselves are `isLocalDatabaseHost`, the three `…Name` predicates
// (`isTestDatabaseName`, `isShadowDatabaseName`, `isDevelopmentDatabaseName`)
// and the three `…Origin` predicates built from them (`isTestDatabaseOrigin`,
// `isShadowDatabaseOrigin`, `isDevelopmentDatabaseOrigin`) below, which is what
// that guard should import: each `…Name` predicate owns the database-name half
// of its rule (including the clone-index form where the name carries one), and
// each `…Origin` predicate applies this host half on top of it. Every class is
// host-gated, so no database name on its own reaches one.
export const LOCAL_HOSTS: readonly string[] = ['localhost', '127.0.0.1', 'postgres'];

// Narrower than LOCAL_HOSTS on purpose, and the line it draws is between the two
// arms of the development rule rather than between classes. `postgres` is a
// container-network service name, which in CI or a compose stack can resolve to a
// database that is nobody's development box. It earns membership in every NAME
// rule — `_test`, `ci`, `_shadow` and `_dev`, where the database name is what
// identifies the origin — but not in the HOST arm below, so it must not make an
// unrecognised name pass as development: `…@postgres/state_of_health` is
// therefore `unknown` and refused, while `…@postgres/soh_test` is `test` and
// `…@postgres/soh_dev` is `development`.
export const DEVELOPMENT_HOSTS: readonly string[] = ['localhost', '127.0.0.1'];

export const TEST_DATABASE_SUFFIX = '_test';
export const SHADOW_DATABASE_SUFFIX = '_shadow';
export const DEVELOPMENT_DATABASE_SUFFIX = '_dev';
export const CI_DATABASE_NAME = 'ci';

// The clone-index tail, and the reason the name rules are patterns rather than
// `endsWith` calls. An agent clone is provisioned with one database triple of
// its own — `soh_dev_<index>`, `soh_test_<index>`, `soh_shadow_<index>`, all on
// the same local host — so on such a machine every mandated name carries a
// numeric index AFTER the suffix and `endsWith(TEST_DATABASE_SUFFIX)` is false
// for all three. Left unrecognised they fell through to the host rule at the
// end of classifyDatabaseOrigin and classified `development`, the weakest
// class: `catalog-load`/`recipes-seed` stopped demanding `--confirm-target`
// before writing catalog data into the clone's TEST database, `seed-dev` became
// willing to write user-scoped rows there, and the shared test-origin rule that
// src/__tests__/setup/testDb.ts is specified to import did not recognise the
// name the operator was told to use.
//
// The index is OPTIONAL, which is what makes this additive: every bare Agent
// Action Plan §0.4.4 name (`soh_dev`, `soh_test`, `soh_shadow`) still matches,
// and matches through the same rule and the same reason as before.
//
// All three patterns are BUILT FROM the exported suffix constants instead of
// being re-typed as regex literals, so renaming a constant can never leave the
// rule and the constant it is named after disagreeing. Interpolating them is
// safe: each is an underscore followed by lower-case letters, with no
// regular-expression metacharacter, so each contributes only literal
// characters to the pattern.
//
// Digits only, and a zero-padded index (`soh_test_038`) is accepted too,
// because the clone identifier is published in both a plain and a zero-padded
// form; rejecting the padded spelling would reinstate exactly the `development`
// fall-through these rules close.
//
// None of the three carries the `g` or `y` flag. They are module-level
// constants shared by every call, and those flags make `RegExp.prototype.test`
// advance `lastIndex`, which would let one input classify differently on
// alternate calls — a guard that is right every other time is not a guard.
//
// CLONE_INDEX_TAIL_SOURCE is the tail ALONE, with no `$` folded into it, and the
// anchor is written where each pattern is built. It is exported for the same
// reason the suffixes are, so a caller composing its own rule gets the one
// definition of "a clone index" rather than a second guess at it — and a tail
// that carried a hidden anchor could only be used at the end of a pattern,
// which is not what its name promises.
export const CLONE_INDEX_TAIL_SOURCE = '(?:_[0-9]+)?';
export const TEST_DATABASE_NAME_PATTERN = new RegExp(`${TEST_DATABASE_SUFFIX}${CLONE_INDEX_TAIL_SOURCE}$`);
export const SHADOW_DATABASE_NAME_PATTERN = new RegExp(`${SHADOW_DATABASE_SUFFIX}${CLONE_INDEX_TAIL_SOURCE}$`);
export const DEVELOPMENT_DATABASE_NAME_PATTERN = new RegExp(
    `${DEVELOPMENT_DATABASE_SUFFIX}${CLONE_INDEX_TAIL_SOURCE}$`,
);

// The database-name half of the test rule, with no host in it: a `_test`
// suffix with or without a clone index, or CI's plainly named database.
//
// Exported as part of the same shared surface as the host and suffix constants
// (see LOCAL_HOSTS above): src/__tests__/setup/testDb.ts::assertTestDatabase
// accepts exactly the `test` class of this module, so it imports this rather
// than re-deriving `_test`/`ci` from the constants — and the name half is what
// that guard checks against its own `DATABASE_URL`.
//
// CI_DATABASE_NAME stays an EXACT match on purpose: CI provisions exactly one
// database, named `ci`, and there is no indexed form of it to accept. Widening
// it would only add names nothing provisions.
export const isTestDatabaseName = (database: string): boolean =>
    TEST_DATABASE_NAME_PATTERN.test(database) || database === CI_DATABASE_NAME;

// The database-name half of the shadow rule. Kept separate from the test one
// because the two classes are not interchangeable: Prisma resets the shadow
// database (see isShadowDatabaseOrigin below).
export const isShadowDatabaseName = (database: string): boolean => SHADOW_DATABASE_NAME_PATTERN.test(database);

// The database-name half of the development rule, named and exported for the
// same reason as the two above: one definition, so a caller composing its own
// check cannot derive a second one that disagrees.
//
// The clone-index pattern, exactly like its test and shadow siblings, and the
// symmetry is now load-bearing rather than tidy. This predicate used to be a
// plain `endsWith(DEVELOPMENT_DATABASE_SUFFIX)`, on the reasoning that a
// clone's `soh_dev_<index>` is provisioned on 127.0.0.1 and so reaches
// `development` through the DEVELOPMENT_HOSTS arm at the end of
// classifyDatabaseOrigin anyway. That reasoning stopped holding the moment the
// two arms stopped being interchangeable: `evaluateScriptDatabase` now demands
// `--confirm-target` for a `development_or_confirmed` script whenever the class
// came from the host alone, because a deployment database reached over loopback
// is indistinguishable from a development one on the host. An indexed
// development database has to match HERE, by name, or an agent clone's own
// `soh_dev_46` would start demanding a flag it never needed.
//
// The widening is acceptance-ADDING for this predicate — `…@postgres/app_dev_7`
// is a name it did not accept before — and that is contained: the two
// `…Origin` predicates below gate every name rule on LOCAL_HOSTS, and the only
// thing a name rule buys over the host arm is freedom from the confirmation
// flag on a local host. `soh_dev`, `soh_dev_46` and `soh_dev_046` all match.
export const isDevelopmentDatabaseName = (database: string): boolean =>
    DEVELOPMENT_DATABASE_NAME_PATTERN.test(database);

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

// The schema this repository's migrations write to, and the schema every
// unqualified statement in these scripts and in the test harness is meant to
// resolve in. Named once and exported, because the rule below decides on it and
// src/__tests__/setup/testDb.ts qualifies its destructive statement with it.
//
// Measured rather than assumed: `npx prisma migrate deploy` against an empty
// database puts all 33 tables in `public`, and `public` is the only non-system
// schema the migrated database holds.
export const DEFAULT_SCHEMA = 'public';

// The SECOND way a query string can move the target, and the reason it needs a
// list of its own: these parameters leave the server and the database exactly
// where the URL displays them and move the SCHEMA an unqualified statement
// resolves in. A guard that classified only the host and the database name
// would pass such a URL — the name rules match, the host rules match — while
// the connection resolved its tables somewhere else entirely.
//
// Measured against this repository's two connectors on PostgreSQL 16.15, with a
// decoy `live` schema beside `public` inside a database this module classifies
// `test`:
//
//   * `…/soh_test_34?schema=live` — Prisma reports `current_schema() = live`,
//     and `$executeRawUnsafe('TRUNCATE TABLE "probe_rows" CASCADE')` emptied
//     `live.probe_rows` while `public.probe_rows` was left untouched. (`pg`
//     ignores the keyword; Prisma's PostgreSQL connector reads it and sets the
//     session `search_path` from it.)
//   * `…/soh_test_34?options=-c search_path=live` — BOTH connectors report
//     `current_schema() = live`: the same unqualified `TRUNCATE` emptied the
//     `live` copy under Prisma, and an unqualified `INSERT` under `pg` landed
//     there. `options` is libpq's arbitrary-startup-settings keyword, and both
//     pg-connection-string and Prisma forward it verbatim.
//
// So a `DATABASE_URL` wearing a legitimate `_test` name could make the suite's
// own `TRUNCATE … CASCADE` destroy a different schema of that database — which
// for a deployment keeping its tables outside `public` is its data. Both keys
// therefore make the origin unclassifiable, with the one no-op exception
// findSchemaRedirectingParams records.
//
// `search_path` is in the list although neither connector honours it as a URL
// parameter: it is the spelling an operator reaches for, and a URL carrying it
// is a URL whose author intended a redirect. Refusing it costs nothing that
// works today and says so explicitly.
//
// Only the parameter NAMES are ever reported, for the same reason as above.
export const SCHEMA_REDIRECTING_PARAMS: readonly string[] = ['schema', 'options', 'search_path'];

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

// The schema half of the same shape, and a prefix for the same reason: the
// matched names are appended and they are fixed constants, never operator
// values.
const REASON_SCHEMA_PARAMS_PREFIX = `${DATABASE_URL_ENV} query string redirects the schema: `;

const describeConnectionRedirectingParams = (params: readonly string[]): string =>
    `${REASON_CONNECTION_PARAMS_PREFIX}${params.join(', ')}`;

const describeSchemaRedirectingParams = (params: readonly string[]): string =>
    `${REASON_SCHEMA_PARAMS_PREFIX}${params.join(', ')}`;

// The other way a URL can fail to name its own target, and the reason it gets a
// refusal of its own rather than falling through to the generic one:
// `postgresql:///soh_dev` parses, and names a database, but carries no
// authority — verified with pg-connection-string, which returns `host: ''` for
// it. Both `pg` and libpq then fall back to PGHOST/PGSERVICE or the default unix
// socket, so the server is chosen outside the URL and can be anywhere. Every
// name rule is host-gated, so such a URL could not reach a recognised class in
// any case; naming this reason explicitly is what turns the answer from "no rule
// matched" into the one thing the operator can act on — the URL, not the
// database, is what has to change. A host the guard cannot see is a host it
// cannot vouch for.
const REASON_NO_HOST = `${DATABASE_URL_ENV} names no host`;

// The third, and the one that is not a matter of degree: with Prisma opening the
// literal database name and pg decoding it (both measured — see
// parseDatabaseUrl), an encoded name has two possible targets and the guard
// cannot vouch for either.
const REASON_ENCODED_NAME = `${DATABASE_URL_ENV} database name is percent-encoded`;

// "with or without a clone index" is in the phrase because the rule accepts
// both spellings: a reason that claimed the name "ends in _test" would be
// literally false for `soh_test_38`, and this string is the only account of the
// decision an operator or a log reader gets.
const REASON_TEST_SUFFIX = `database name ends in ${TEST_DATABASE_SUFFIX}, with or without a clone index, on a local host`;
const REASON_CI_NAME = `database name is ${CI_DATABASE_NAME} on a local host`;
const REASON_SHADOW_SUFFIX = `database name ends in ${SHADOW_DATABASE_SUFFIX}, with or without a clone index, on a local host`;
// "on a local host" for the same reason the two above carry it: the rule is
// host-gated (isDevelopmentDatabaseOrigin), and a reason that named the suffix
// alone would read as a licence the rule does not grant.
const REASON_DEVELOPMENT_SUFFIX = `database name ends in ${DEVELOPMENT_DATABASE_SUFFIX}, on a local host`;
const REASON_DEVELOPMENT_HOST = 'host is a development host';
const REASON_NO_RULE_MATCHED =
    'the database name matches no recognised rule on this host and the host is not a development host';

// The development LICENCE in one phrase, defined once because three
// operator-facing refusals quote it and a rule described three ways is a rule
// an operator has to guess at.
//
// It is deliberately the NARROWER of the development class's two arms. The
// class is "host localhost or 127.0.0.1, or a `_dev` name on a local host"
// (classifyDatabaseOrigin), and it used to be what every development-only
// refusal quoted — but the host arm is not a licence to write anything: it
// covers every database that happens to answer on loopback, a deployment
// database reached through a tunnel or a published container port included.
// Only a NAME is evidence that a database was made for development, so only a
// name appears here.
const DEVELOPMENT_BY_NAME_DESCRIPTION =
    `a database name ending ${DEVELOPMENT_DATABASE_SUFFIX}, with or without a clone index, ` +
    `on host ${LOCAL_HOSTS.join(', ')}`;

// Why the host arm on its own is never that licence. One sentence, quoted by
// every refusal that turns on the distinction, so the three of them cannot
// describe the same fact three ways.
const DEVELOPMENT_BY_HOST_ALONE_CLAUSE =
    'is development by its host alone: its name matches no recognised rule, so nothing distinguishes it ' +
    'from a deployment database reached over loopback';

// The sentence an operator needs when a remote database wearing a recognised
// name is refused. Without it the `unrecognised_origin` message names the three
// classes and leaves someone who deliberately called their database `app_dev`
// with no way to tell that the host, not the name, is what disqualified it.
const LOCAL_ORIGIN_REQUIREMENT =
    `Every recognised origin is on host ${LOCAL_HOSTS.join(', ')}: a ${DEVELOPMENT_DATABASE_SUFFIX}, ` +
    `${TEST_DATABASE_SUFFIX} or ${SHADOW_DATABASE_SUFFIX} name does not make a remote database one.`;

export const SCRIPT_DATABASE_POLICIES: Readonly<Record<string, ScriptDatabasePolicy>> = {
    // The loader is the only sanctioned way to populate a shared environment
    // with catalog data, so it keeps a door — guarded by an explicit flag.
    // Agent Action Plan §0.7.5 publishes that as the release step: run on the
    // deployment host, read the target back, and pass `--confirm-target` to
    // both writers.
    'catalog-load': 'development_or_confirmed',
    'recipes-seed': 'development_or_confirmed',
    // Writes user-scoped rows, so there is no door to open. The wording the
    // refusal quotes is not repeated here: it lives once in
    // DEVELOPMENT_ONLY_RATIONALES below, so the reason an operator reads and the
    // reason recorded beside the policy cannot drift apart.
    'seed-dev': 'development_only',
    // The four stages that BUILD catalog data, and they mutate: the first three
    // write catalog_foods and its children, and `catalog-release` opens and
    // closes a `catalog_import_runs` ledger row around its export. They are
    // development-machine stages by design — §0.7.5 states it as a rule of the
    // release ("Regenerating the catalog from vendor/model output on a target
    // environment is never part of a release: a new version is produced on a
    // development machine, reviewed … in a pull request, and loaded the same
    // way") — so they get `development_or_test` and NO confirmation door.
    //
    // The door is what is deliberately absent. Under the older
    // `any_recognised` setting each of these four would mutate any origin the
    // module could classify, and a deployment database reached over loopback
    // classifies `development` on its host alone: a pipeline pointed at one
    // would have rewritten its catalog rows with candidate data and opened
    // ledger rows in it, with nothing to type and nothing to read back. There
    // is no flag here because there is no legitimate invocation to unlock —
    // reviewed catalog data reaches a shared environment through
    // `catalog-load`, whose door exists for exactly that.
    'catalog-import-usda': 'development_or_test',
    'catalog-generate-ai': 'development_or_test',
    'catalog-validate': 'development_or_test',
    'catalog-release': 'development_or_test',
    // Read-only stages: `catalog-report`'s Prisma surface declares `findMany`
    // and nothing else, and `search-benchmark` issues `$queryRawUnsafe`
    // SELECTs. They keep the widest policy because there is nothing for a
    // confirmation to protect, and because §0.7.5's release order runs
    // `search:benchmark` ON the deployment host to record that environment's
    // own report — a loopback origin that is development by its host alone,
    // which is precisely what this policy admits and the two above do not.
    'catalog-report': 'read_only_recognised',
    'search-benchmark': 'read_only_recognised',
};

// A script name absent from the table is a caller mistake, and a mistake must
// not make the guard weaker than its strictest setting. The strictest setting
// happens to be `seed-dev`'s, which is exactly why the refusal has to name
// which of the two reasons applied — see describeDevelopmentOnlyPolicy.
const FALLBACK_POLICY: ScriptDatabasePolicy = 'development_only';

// Why a particular script is development-only. A `development_only` refusal is
// the only account of that decision an operator gets, so it states the reason
// that applies to the caller in front of it rather than one script's reason for
// all of them: told that their module "writes user-scoped rows", someone
// debugging an unlisted entry point goes looking for a write path that does not
// exist, and never learns that the policy table is what they are missing.
//
// A map rather than a conditional so that adding a second development-only
// script is a one-line data change that cannot silently inherit seed-dev's
// rationale.
const DEVELOPMENT_ONLY_RATIONALES: Readonly<Record<string, string>> = {
    'seed-dev': 'writes user-scoped rows (a development user, its preferences, its diary buckets)',
};

const DEVELOPMENT_ONLY_CLAUSE = 'runs against a development database only';

/**
 * The opening clause of a `development_only` refusal: the script, why the policy
 * applies to it, and the policy itself.
 *
 * Three cases, each true of its input — a script the table lists with a
 * recorded rationale, a script absent from the table (FALLBACK_POLICY, and the
 * absence IS the reason), and a listed script with no rationale yet, which
 * states the policy without inventing a motive for it. Both lookups go through
 * hasOwnProperty for the reason entryScriptName does: a caller named
 * `constructor` or `toString` would otherwise resolve through Object's
 * prototype and produce a rationale out of a function body.
 */
const describeDevelopmentOnlyPolicy = (script: string): string => {
    if (Object.prototype.hasOwnProperty.call(DEVELOPMENT_ONLY_RATIONALES, script)) {
        return `${script} ${DEVELOPMENT_ONLY_RATIONALES[script]}, so it ${DEVELOPMENT_ONLY_CLAUSE}`;
    }

    if (!Object.prototype.hasOwnProperty.call(SCRIPT_DATABASE_POLICIES, script)) {
        return `${script} is not a known pipeline script, so it falls back to the strictest policy and ${DEVELOPMENT_ONLY_CLAUSE}`;
    }

    return `${script} ${DEVELOPMENT_ONLY_CLAUSE}`;
};

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
 * Which SCHEMA_REDIRECTING_PARAMS the URL carries, in that list's fixed order
 * so the answer and the message built from it are deterministic — minus the one
 * value that redirects nothing.
 *
 * THE ONE EXCEPTION is `schema=public`: it names the schema everything here
 * already resolves in, so accepting it refuses nothing real, and it is what a
 * Prisma-generated `.env` commonly spells out. It is also, strictly, narrower
 * than the default — PostgreSQL's default `search_path` is `"$user", public`,
 * and Prisma sets `public` alone — so accepting it cannot widen what a
 * statement reaches. Every OTHER value of `schema` is reported, and `options`
 * and `search_path` are reported by PRESENCE: `options` carries arbitrary
 * startup settings and there is no subset of them worth parsing for safety.
 *
 * Keys are compared case-insensitively and after percent-decoding, exactly as
 * findConnectionRedirectingParams compares them, because `?SCHEMA=` and
 * `?%73chema=` are the same parameter to a connector that lower-cases its
 * keywords, and `?options=-c%20search_path%3Dlive` is the form an operator
 * actually writes.
 *
 * The VALUE comparison is exact and case-sensitive: PostgreSQL schema names are
 * case-sensitive and Prisma quotes the value it is handed, so `PUBLIC` is a
 * different schema and is reported. A repeated key must be `public` in EVERY
 * occurrence (`?schema=public&schema=live` is reported), which is the
 * fail-closed reading of a URL that names two schemas.
 *
 * An unparsable URL yields `[]`: parseDatabaseUrl already refuses it as
 * `unparsable_database_url`.
 */
export const findSchemaRedirectingParams = (databaseUrl: string): string[] => {
    let parsed: URL;
    try {
        parsed = new URL(databaseUrl);
    } catch {
        return [];
    }

    const values = new Map<string, string[]>();
    parsed.searchParams.forEach((value, key) => {
        const parameter = key.trim().toLowerCase();
        const seen = values.get(parameter);
        if (seen === undefined) {
            values.set(parameter, [value]);
        } else {
            seen.push(value);
        }
    });

    return SCHEMA_REDIRECTING_PARAMS.filter((parameter) => {
        const carried = values.get(parameter);
        if (carried === undefined) {
            return false;
        }
        // `schema` redirects unless every occurrence names the schema this
        // repository already uses; the other two redirect by being there.
        return parameter !== 'schema' || carried.some((value) => value !== DEFAULT_SCHEMA);
    });
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
 * mode, and it is reachable in both directions: `…@127.0.0.1/soh%5Ftest`
 * classified on the literal name skips the `_test` rule, falls through to the
 * host rule as `development`, and loses `catalog-load`'s `--confirm-target`,
 * while `…@postgres/soh%5Fdev` is `unknown` on the literal name and
 * `development` on the decoded one. Refusing the encoded form is the only answer
 * that is wrong in neither direction.
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
// sharing: it imports these — and `isTestDatabaseName`/`isShadowDatabaseName`,
// the name half they are composed from — instead of re-deriving
// `_test`/`_test_<index>`/`ci` from the constants, because a second derivation
// is a second place to get wrong.
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
// including the most permissive, `read_only_recognised` — refuses, because
// `unknown` is rejected before any policy is consulted. The clone-indexed spelling is a naming
// convention in exactly the same way, so it is gated identically:
// `…@prod.example.com/app_test_38` stays `unknown` too.
export const isTestDatabaseOrigin = (target: DatabaseTarget): boolean =>
    isLocalDatabaseHost(target.host) && isTestDatabaseName(target.database);

// Local-host-gated for the same reason, and more urgently: Prisma's
// `migrate diff`/`migrate dev --create-only` RESET the shadow database, so a
// remote database named `…_shadow` (or `…_shadow_38`) classifying as `shadow`
// would be a remote database this pipeline is willing to have dropped and
// recreated.
export const isShadowDatabaseOrigin = (target: DatabaseTarget): boolean =>
    isLocalDatabaseHost(target.host) && isShadowDatabaseName(target.database);

// Local-host-gated like the two above, and this is the rule whose gate matters
// most, because this predicate certifies the most privileged origin this module
// hands out: the only one `catalog-load` and `recipes-seed` write to without
// `--confirm-target` (the class's other arm, a development HOST with an
// unrecognised name, does not buy that — see evaluateScriptDatabase), and part
// of the only class `seed-dev` accepts at all. Ungated — the
// literal reading of the Agent Action Plan §0.7.1 disjunction, "host in
// {localhost, 127.0.0.1} OR name ending _dev" — a remote database called
// `app_dev` reached that class on the strength of its name, so all three of
// those writes proceeded against it silently, while `…@prod.example.com/app_test`
// was refused. The asymmetry ran the wrong way: the two *less* privileged
// classes were pinned to a local host and the most privileged one was not.
//
// §0.4.4 is the sentence that settles it — "every script and test refuses a
// DATABASE_URL whose host is not localhost/127.0.0.1/postgres" — and that host
// set is LOCAL_HOSTS. Gating here is the only reading under which both
// requirements hold at once, and it makes §0.7.1's own stated goal true rather
// than aspirational: no load or seed can run against a non-development database
// without a human typing its name.
//
// The gate is LOCAL_HOSTS, not the narrower DEVELOPMENT_HOSTS, so that a
// container-network `…@postgres/soh_dev` keeps the class it has always had;
// narrowing further would refuse a compose-stack database that no finding is
// about. The change is therefore purely acceptance-REMOVING: a remote `_dev`
// name now matches no rule, falls through to `unknown`, and is refused by every
// policy including the most permissive one, `read_only_recognised` —
// `--confirm-target` cannot reach it either,
// because an unclassifiable origin is refused before any policy is consulted.
export const isDevelopmentDatabaseOrigin = (target: DatabaseTarget): boolean =>
    isLocalDatabaseHost(target.host) && isDevelopmentDatabaseName(target.database);

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
    // authority there is no host to vouch for, and the server comes from PGHOST
    // or a default socket rather than from the URL. The host-gated name rules
    // below would already refuse it — an empty host is in no host list — so this
    // branch exists for the diagnosis: `ambiguous_database_url` names the URL as
    // the thing to fix, where `unrecognised_origin` would point at the database.
    // The database name is still reported, because it is the one part of the
    // target the URL does fix.
    if (host.length === 0) {
        return { originClass: 'unknown', host: '', database, reason: REASON_NO_HOST };
    }

    // The FOURTH form, and the last of them: the server and the database are
    // determined, and the SCHEMA an unqualified statement would resolve in is
    // not. It is checked last of the four because it is the narrowest — a URL
    // that also redirects its server, hides its host or encodes its database
    // name is reported by the more fundamental fault — and it is checked BEFORE
    // every name rule because a redirected schema must never reach a recognised
    // class: `…@127.0.0.1/soh_test_34?options=-c search_path=live` matches the
    // `_test` name rule and the local-host rule exactly, and is the URL that
    // made the suite's own `TRUNCATE` destroy another schema of that database
    // (see SCHEMA_REDIRECTING_PARAMS for the measurement).
    //
    // Host and database ARE carried into this origin, unlike the first two
    // forms where the pair would be a guess: here the pair is accurate and the
    // tables are what is in doubt, and the message built from this reason says
    // so — an operator reading `database "soh_test_34" on host "127.0.0.1"`
    // has to be told the schema is the part that disqualified it.
    const schemaParams = findSchemaRedirectingParams(databaseUrl);
    if (schemaParams.length > 0) {
        return {
            originClass: 'unknown',
            host,
            database,
            reason: describeSchemaRedirectingParams(schemaParams),
        };
    }

    // NAME BEFORE HOST — this order is a decision, not an accident, and must not
    // be rearranged. The operator setup provisions soh_dev, soh_test and
    // soh_shadow on the same localhost (Agent Action Plan §0.4.4), so the host
    // establishes only "not production"; the database *name* is the only thing
    // that tells the three apart. If the host rule ran first, soh_test on
    // localhost would classify `development` with `match: 'host'`, so
    // `catalog:load --release v1 --confirm-target soh_test` would still be
    // demanded — the §0.9.1 gate would survive — but every refusal, every
    // accepted-run log line and `seed-dev`'s whole policy would report the
    // clone's TEST database as a development one, and `seed-dev` would write
    // user-scoped rows into it. `shadow` is its own class rather than a flavour
    // of development because Prisma's `migrate diff` resets that database.
    //
    // All three name rules are local-host-gated — isTestDatabaseOrigin,
    // isShadowDatabaseOrigin and isDevelopmentDatabaseOrigin — so every
    // recognised class requires a host in LOCAL_HOSTS and a database name alone
    // never certifies an origin. That makes the `_dev` arm of the Agent Action
    // Plan §0.7.1 disjunction narrower than its literal wording, which the
    // predicate documents in full; §0.4.4's "every script and test refuses a
    // DATABASE_URL whose host is not localhost/127.0.0.1/postgres" is the
    // requirement that decides it.
    if (isTestDatabaseOrigin({ host, database })) {
        // CI's database is named plainly (`ci`), so the two halves of the test
        // rule are distinguished here only to name the matched rule in `reason`.
        // The same pattern the rule matched on is re-applied here rather than an
        // `endsWith` shortcut: with the clone-index form accepted, `endsWith`
        // would report `soh_test_38` under REASON_CI_NAME — "database name is ci
        // on a local host" — which is simply untrue of it, and a reason is the
        // only account of the decision that reaches a log.
        const reason = TEST_DATABASE_NAME_PATTERN.test(database) ? REASON_TEST_SUFFIX : REASON_CI_NAME;
        return { originClass: 'test', host, database, reason, match: 'name' };
    }
    if (isShadowDatabaseOrigin({ host, database })) {
        return { originClass: 'shadow', host, database, reason: REASON_SHADOW_SUFFIX, match: 'name' };
    }
    // `match: 'name'` here and `match: 'host'` below — the two arms of the
    // §0.7.1 development disjunction, told apart because they are not equally
    // informative. A `_dev` name (with or without a clone index) is a database
    // somebody named for development; a bare local host is every database that
    // happens to answer on loopback, deployment databases included. The policy
    // in evaluateScriptDatabase turns on that distinction, which is why the
    // field is set here rather than re-derived from `reason` by a caller.
    if (isDevelopmentDatabaseOrigin({ host, database })) {
        return { originClass: 'development', host, database, reason: REASON_DEVELOPMENT_SUFFIX, match: 'name' };
    }
    if (DEVELOPMENT_HOSTS.includes(host)) {
        return { originClass: 'development', host, database, reason: REASON_DEVELOPMENT_HOST, match: 'host' };
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

/**
 * The help tokens every entry script answers, spelled here because the
 * module-load exemption below has to agree with the scripts EXACTLY.
 *
 * Each of the nine declares its own `HELP_FLAGS` with these two values and
 * makes `if (argv.some((token) => HELP_FLAGS.includes(token)))` the FIRST
 * statement of its `parseArgs`, over `process.argv.slice(2)`. This constant is
 * a copy of that list rather than an import of it because the dependency only
 * runs the other way — a script imports this module, and this module imports
 * nothing but ./logger so it stays safe to load before any Prisma client
 * exists (see the header). `catalogScriptFlags.test.ts` pins the two spellings
 * against every script's own parser, so a divergence fails a test rather than
 * quietly widening or narrowing the exemption.
 */
export const HELP_FLAGS: readonly string[] = ['--help', '-h'];

/**
 * Where a script's own arguments start in `process.argv`: index 0 is the node
 * binary and index 1 the script, which is what every `parseArgs` call site
 * expresses as `process.argv.slice(2)`. Scanning from here rather than from 0
 * keeps a path that happens to contain `-h` out of the decision.
 */
const ARGUMENT_TAIL_START = 2;

/**
 * Whether this invocation is asking for the usage block — decided from argv
 * alone, and the one thing that exempts a run from the module-load assertion
 * below.
 *
 * It is exact-token equality against {@link HELP_FLAGS} and nothing more: no
 * prefix matching, no `--help=value` handling, no case folding. That is not
 * conservatism for its own sake, it is the requirement. The exemption may be
 * neither wider nor narrower than the scripts' own predicate — wider and a
 * token a script parses as an ordinary flag would skip the guard and reach the
 * stage's work unguarded; narrower and the finding this exemption exists for
 * comes back for the spelling that was left out. `--help=x` is NOT help to any
 * script (its parser reports it as an unrecognised flag and exits 1), so it is
 * not help here either.
 *
 * Total and side-effect-free by construction: it reads no environment, opens
 * nothing, and returns `false` for an absent or too-short `argv` — the same
 * tolerance {@link entryScriptName} has, because both run at module load on a
 * path that may be about to refuse, and a throw from here would replace a
 * refusal an operator can act on with a stack trace they cannot.
 */
export const isHelpInvocation = (argv: readonly string[] | undefined): boolean => {
    if (argv === undefined) {
        return false;
    }

    for (let index = ARGUMENT_TAIL_START; index < argv.length; index += 1) {
        if (HELP_FLAGS.includes(argv[index])) {
            return true;
        }
    }

    return false;
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
        // All four "the URL does not determine its own target" reasons — an
        // encoded database name, a URL with no host, a schema-redirecting query
        // parameter and a connection-redirecting one — share the
        // `ambiguous_database_url` code, because in each the URL parses and the
        // origin is not unrecognised, it is undetermined. Each keeps its own
        // message: the operator fixes the four differently.
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
        // Prefix match for the same reason as the connection-parameter branch
        // below, and its own message because the operator fixes it differently:
        // the database in the URL is the right one and the schema keyword is
        // what has to go.
        if (origin.reason.startsWith(REASON_SCHEMA_PARAMS_PREFIX)) {
            const parameters = origin.reason.slice(REASON_SCHEMA_PARAMS_PREFIX.length);
            return {
                allowed: false,
                code: 'ambiguous_database_url',
                message:
                    `${script} cannot classify ${DATABASE_URL_ENV}: it names ${target}, but its query ` +
                    `string moves the schema an unqualified statement would resolve in (${parameters}), so ` +
                    'the tables it would read and write are not this database\'s ' +
                    `${DEFAULT_SCHEMA} tables. Remove ${parameters} from ${DATABASE_URL_ENV}; the ` +
                    `${DEFAULT_SCHEMA} schema is the one this repository's migrations create.`,
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
            message:
                `${script} refuses to run against ${target}: it is not a recognised ` +
                `${RECOGNISED_ORIGIN_CLASSES} origin. ${LOCAL_ORIGIN_REQUIREMENT}`,
        };
    }

    // THE SHADOW DATABASE IS REFUSED FOR EVERY SCRIPT, ahead of every policy
    // and every flag.
    //
    // It is a recognised class, so `any_recognised` used to accept it and the
    // confirmation door used to open it — which contradicted the contract the
    // class exists to express. `SHADOW_DATABASE_URL` belongs to Prisma's schema
    // tooling, reached through `scripts/schema-diff.ts`: `migrate diff
    // --from-migrations` RESETS the database that variable names (measured — a
    // shadow database carrying an operator's table came back with that table
    // dropped and the command still exited 2), while `migrate dev
    // --create-only` ignores the variable and resets a temporary shadow
    // database of its own on the `DATABASE_URL` server instead (the block at
    // the foot of this file has the measurements). §0.4.4 says of the shadow
    // database: "Nothing of value may live here, and no other command reads
    // it". A stage that wrote catalog rows, a release ledger row or a
    // development user into it would be writing rows whose next reader is a
    // schema replay that destroys them — and, worse for the operator, it would
    // look like a successful run.
    //
    // Refusing it here rather than per policy is deliberate: a policy is a
    // statement about how much privilege a script needs, and none of them needs
    // this. `evaluateShadowDatabase` is the mirror — the only entry point
    // allowed to address a shadow database is the schema tooling, and it is
    // refused everything else.
    if (origin.originClass === 'shadow') {
        return {
            allowed: false,
            code: 'shadow_database',
            message:
                `${script} refuses to run against the shadow ${target}. The shadow database belongs to ` +
                'Prisma\'s schema tooling, which RESETS it (`migrate diff --from-migrations`, through ' +
                'scripts/schema-diff.ts), so nothing of value may live in it. No policy and no ' +
                `${CONFIRM_TARGET_FLAG} opens it: point ${DATABASE_URL_ENV} at a development or test ` +
                'database instead.',
        };
    }

    // WHETHER THE DATABASE'S OWN NAME SAID DEVELOPMENT. `origin.match ===
    // 'name'` is the whole test, and it is deliberately not `originClass ===
    // 'development'`: the host arm hands that class to every database answering
    // on loopback, which is exactly how a deployment database is reached during
    // a release (release-and-recovery.md step 4 — a remote host is `unknown`
    // and refused above, so loopback is the only shape a release can use).
    //
    // Three policies turn on this one value, which is why it is computed once,
    // here, above all of them.
    //
    // FAIL CLOSED on an absent `match`. The field is optional (see
    // DatabaseOrigin), so a caller-built origin can omit it; omission is read
    // as `'host'` — the stricter arm — because the alternative would let the
    // strictest case be waived by leaving a field out.
    const developmentByName = origin.originClass === 'development' && origin.match === 'name';

    // `development_only` reads that value too, and this is the correction that
    // matters most in this file. It used to accept the CLASS: any database
    // answering on loopback was `development`, so `seed-dev` would write its
    // user-scoped rows into — and `--reset-user` would DELETE a user and
    // everything cascading from it out of — a deployment database reached
    // through an SSH tunnel or a published container port, with no flag to
    // type, nothing to read back, and a log line calling the target
    // "development". A name is the only evidence this module has that a
    // database was made for development, so a name is what it now requires.
    //
    // There is still no door. §0.7.1 gives `seed-dev` none because it writes
    // user-scoped rows (Rule backend-architecture §5.1), and adding one here to
    // soften the refusal would be the same mistake in the other direction.
    if (policy === 'development_only' && !developmentByName) {
        return {
            allowed: false,
            code: 'development_only',
            message:
                `${describeDevelopmentOnlyPolicy(script)} (${DEVELOPMENT_BY_NAME_DESCRIPTION}); ` +
                (origin.originClass === 'development'
                    ? `${target} ${DEVELOPMENT_BY_HOST_ALONE_CLAUSE}.`
                    : `${target} is ${origin.originClass}.`) +
                ' There is no confirmation flag for this script.',
        };
    }

    // The mutating build stages: development by name, or a test database, and
    // nothing else. `test` is admitted because it is what the §0.9.1 gates run
    // these stages against — a disposable database the harness already owns —
    // and because a database named `_test` on a local host is a database
    // somebody made to be emptied. Everything a `development_or_test` refusal
    // can reach here is therefore the host arm, so the message names that case
    // and the one legitimate route out of it.
    if (policy === 'development_or_test' && !developmentByName && origin.originClass !== 'test') {
        return {
            allowed: false,
            code: 'development_only',
            message:
                `${script} builds shared catalog data, so it runs against ${DEVELOPMENT_BY_NAME_DESCRIPTION} ` +
                `or a ${TEST_DATABASE_SUFFIX} database on a local host; ${target} ` +
                `${DEVELOPMENT_BY_HOST_ALONE_CLAUSE}. There is no confirmation flag for this script: build ` +
                'the catalog on a development machine, review the release, and install it with ' +
                'catalog-load, which is the stage that carries a door.',
        };
    }

    // The confirmation door. Under the older reading this branch was skipped
    // for a loopback deployment database, and both writers wrote it with no
    // confirmation demanded while accepting and ignoring `--confirm-target`,
    // which is not what §0.7.1 states the guard is for: "no load or seed can
    // run against a non-development one without a human typing its name".
    if (policy === 'development_or_confirmed' && !developmentByName) {
        if (confirmTarget === null) {
            return {
                allowed: false,
                code: 'confirmation_required',
                // Two messages under one code, because the two cases are not
                // the same news. A `test` origin is a database the guard can
                // name the class of; a host-arm `development` one is a database
                // it knows nothing about beyond where it answers, and an
                // operator who has just been told the origin is "development"
                // needs to read why that is not enough here. Both keep the
                // literal `--confirm-target <database>` remedy. (`shadow` is
                // the third recognised class and cannot arrive here: it is
                // refused for every script above.)
                message:
                    origin.originClass === 'development'
                        ? `${script} would write to ${target}, which ${DEVELOPMENT_BY_HOST_ALONE_CLAUSE}. ` +
                          `Pass ${CONFIRM_TARGET_FLAG} ${origin.database} to confirm that is the database ` +
                          'you mean.'
                        : `${script} would write to the ${origin.originClass} ${target}: ` +
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

    // Everything that reaches here is allowed, and for `read_only_recognised`
    // that is the whole rule: a recognised origin — including one that is
    // development by its host alone, which is what §0.7.5's release order
    // points `search:benchmark` at — and no flag, because a stage that only
    // reads has nothing to confirm. The two refusals every policy shares
    // (`unknown` and `shadow`) are already behind us.
    return { allowed: true };
};

/* ---------------------------------------------------------------------------
 * The other side of the shadow rule: the schema tooling, and only it.
 *
 * `evaluateScriptDatabase` above refuses a shadow origin to every pipeline
 * script. That only tells half the story, because the two Prisma commands that
 * DO belong there — `migrate diff --from-migrations` and `migrate dev
 * --create-only` — were documented as raw command lines with nothing between an
 * inherited, mistyped or stale value and a database Prisma resets. Measured: the
 * diff dropped an operator table out of the database it was pointed at and still
 * exited 2, reporting success.
 *
 * THE TWO COMMANDS DO NOT SHARE A TARGET, which is why they are not guarded
 * through one variable. Measured against prisma 6.9.0:
 *
 *   `migrate diff --from-migrations` takes `--shadow-database-url` and RESETS
 *   the database that flag names, so `SHADOW_DATABASE_URL` is its destructive
 *   surface and `assertShadowDatabase` below is what validates it.
 *
 *   `migrate dev --create-only` has NO `--shadow-database-url` flag and
 *   prisma/schema.prisma declares no `shadowDatabaseUrl` datasource field, so it
 *   ignores `SHADOW_DATABASE_URL` entirely — it exited 0 with that variable
 *   pointing at an unreachable host. What it actually does is create, replay and
 *   drop a TEMPORARY shadow database on the `DATABASE_URL` server, and reset the
 *   `DATABASE_URL` database itself if it finds drift. Its destructive surface is
 *   therefore `DATABASE_URL`, held to `development_only` above — development by
 *   NAME, on a local host — and validating the shadow variable for it would be a
 *   guard on a value the command never reads.
 *
 * THE ONE POLICY, stated the same way here, in docs/meal-planning/README.md and
 * in docs/meal-planning/release-and-recovery.md: `diff` validates the local
 * shadow target; `create-only` validates `DATABASE_URL` as
 * development-by-name; `catalog-load` and `recipes-seed` require an exact
 * `--confirm-target` for host-only loopback targets.
 *
 * So the same classification runs on the shadow URL before the diff is invoked,
 * in one place, with messages that name the variable actually at fault.
 * `scripts/schema-diff.ts` is the only caller of both entry points: it asserts
 * here (or through `evaluateScriptDatabase` in `create-only` mode), reads the
 * target back over a connection, and only then spawns Prisma.
 *
 * The checks are spelled out rather than delegated to `evaluateScriptDatabase`
 * because every message that function composes names `DATABASE_URL`, and an
 * operator told to fix `DATABASE_URL` when `SHADOW_DATABASE_URL` is what is
 * wrong has been sent to the wrong line of their `.env`. The RULES are not
 * duplicated: every predicate below is the one this module already owns.
 * ------------------------------------------------------------------------- */

export const SHADOW_DATABASE_URL_ENV = 'SHADOW_DATABASE_URL';

/**
 * Whether `databaseUrl` may be handed to a Prisma command that resets it.
 *
 * `command` names the caller in the refusal (`schema-diff`, and the mode within
 * it), and `urlEnvName` names the variable the value came from so the remedy
 * points at the right place.
 */
export const evaluateShadowDatabase = (input: {
    command: string;
    databaseUrl: string | undefined;
    urlEnvName?: string;
}): { allowed: true; origin: DatabaseOrigin } | { allowed: false; code: DatabaseGuardCode; message: string } => {
    const { command, databaseUrl } = input;
    const urlEnvName = input.urlEnvName ?? SHADOW_DATABASE_URL_ENV;

    if (databaseUrl === undefined || databaseUrl.trim().length === 0) {
        return {
            allowed: false,
            code: 'missing_database_url',
            message:
                `${command} needs ${urlEnvName} to be set, and it is not. It must name a DISPOSABLE local ` +
                `database whose name ends ${SHADOW_DATABASE_SUFFIX} (optionally with a clone index): the ` +
                'command resets the database it is given.',
        };
    }

    const parsed = parseDatabaseUrl(databaseUrl);
    if (parsed === null) {
        return {
            allowed: false,
            code: 'unparsable_database_url',
            message: `${command} cannot read ${urlEnvName}: it is not a connection URL naming a database.`,
        };
    }

    // Three of the four forms of "the URL does not determine its own target"
    // the script guard refuses, through the same predicates: a redirecting
    // connection parameter, an encoded database name and a redirecting schema
    // parameter. The fourth — a URL naming no host — needs no check here,
    // because `classifyDatabaseOrigin` below answers `unknown` for it and this
    // function demands `shadow`. They matter more here than anywhere else in
    // this module, because what follows a pass is a reset rather than a write.
    const redirectingParams = findConnectionRedirectingParams(databaseUrl);
    if (redirectingParams.length > 0) {
        return {
            allowed: false,
            code: 'ambiguous_database_url',
            message:
                `${command} cannot classify ${urlEnvName}: its query string sets connection parameters ` +
                `that can change the target (${redirectingParams.join(', ')}), so the database it would ` +
                `RESET is not the one the URL displays. Point ${urlEnvName} directly at the database.`,
        };
    }

    if (hasEncodedDatabaseName(databaseUrl)) {
        return {
            allowed: false,
            code: 'ambiguous_database_url',
            message:
                `${command} cannot classify ${urlEnvName}: its database name "${parsed.database}" is ` +
                'percent-encoded, and Prisma would open that name literally while other PostgreSQL clients ' +
                `would decode it. Write the database name literally in ${urlEnvName}.`,
        };
    }

    const schemaParams = findSchemaRedirectingParams(databaseUrl);
    if (schemaParams.length > 0) {
        return {
            allowed: false,
            code: 'ambiguous_database_url',
            message:
                `${command} cannot classify ${urlEnvName}: its query string redirects the schema ` +
                `(${schemaParams.join(', ')}). The replay this command performs belongs in the ` +
                `${DEFAULT_SCHEMA} schema of a disposable database; remove those parameters.`,
        };
    }

    const origin = classifyDatabaseOrigin(databaseUrl);
    if (origin.originClass !== 'shadow') {
        return {
            allowed: false,
            code: 'shadow_required',
            message:
                `${command} refuses to use database "${parsed.database}" on host "${parsed.host}" as a ` +
                `shadow database: it classified as ${origin.originClass} (${origin.reason}). Prisma RESETS ` +
                `the shadow database, so ${urlEnvName} must name one made to be thrown away — a name ending ` +
                `${SHADOW_DATABASE_SUFFIX}, with or without a clone index, on host ${LOCAL_HOSTS.join(', ')}.`,
        };
    }

    return { allowed: true, origin };
};

/**
 * `evaluateShadowDatabase` against the process environment, throwing
 * `DatabaseOriginError` on a refusal and returning the classified origin on a
 * pass — the same contract `assertScriptDatabase` has, so a caller reports a
 * refusal from either in one place.
 */
export const assertShadowDatabase = (options: {
    command: string;
    env?: NodeJS.ProcessEnv;
    urlEnvName?: string;
    logger?: ScriptLogger;
}): DatabaseOrigin => {
    const env = options.env ?? process.env;
    const urlEnvName = options.urlEnvName ?? SHADOW_DATABASE_URL_ENV;
    const verdict = evaluateShadowDatabase({
        command: options.command,
        databaseUrl: env[urlEnvName],
        urlEnvName,
    });

    if (!verdict.allowed) {
        // The refused origin carried by the error is classified from the same
        // value, so a reporter can log the host and database without re-reading
        // the environment. It is `unknown` for every URL-shape refusal, which is
        // what the classifier says of them too.
        throw new DatabaseOriginError(verdict.message, verdict.code, classifyDatabaseOrigin(env[urlEnvName]));
    }

    if (options.logger) {
        options.logger.debug('shadow_database_accepted', {
            command: options.command,
            urlEnvName,
            originClass: verdict.origin.originClass,
            host: verdict.origin.host,
            database: verdict.origin.database,
        });
    }

    return verdict.origin;
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
            ...originLogFields(origin),
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
//
// AND IT DOES NOTHING FOR A HELP INVOCATION, for the reason the guard exists at
// all. Printing a usage block reads no database: every script answers
// `--help`/`-h` in the first statement of its `parseArgs` — before a value is
// consumed, before its prerequisite checks, and before the lazy
// `await import('../src/prisma/client')` each stage defers its client behind —
// and returns 0 from `main()` without touching a target. Asserting the origin
// ahead of that made the usage block unreachable for exactly the operator who
// needs it most, the one who has not pointed DATABASE_URL anywhere the policies
// accept yet, and left `docs/meal-planning/README.md`'s claim that every CLI
// prints its own usage true only on a guard-accepted database.
//
// The exemption is argv-only and is measured against the scripts' own
// predicate, {@link isHelpInvocation} — so it cannot let real work run
// unguarded: a help token anywhere on the line is a usage block and an exit,
// whatever else is written beside it (`--confirm-target -h` included, which
// every script also answers as help). Every OTHER invocation, including
// `--help=x`, which no script reads as help, still takes the assertion below
// and still refuses fatally with the same code, fields, remedy and exit 1.
//
// The skip is deliberately SILENT. Usage is the artefact this path produces and
// the operator reads it on stdout, so nothing else may land there; a `debug`
// line would be suppressed by the logger's default `info` threshold anyway, and
// no caller can raise that threshold at module load.
const entryScript = entryScriptName(process.argv);
if (entryScript !== null && !isHelpInvocation(process.argv)) {
    try {
        assertScriptDatabase({ script: entryScript });
    } catch (error) {
        if (!(isThrownInstanceOf(error, DatabaseOriginError))) {
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
        // WHAT THIS LINE SAYS, NOW THAT IT SAYS NEITHER THE DATABASE NOR THE
        // MESSAGE. §0.7.1 requires the guard to say WHY it refused, and it does:
        // `code` names the rule that refused (`unrecognised_origin`,
        // `development_only`, `confirmation_required`, `confirmation_mismatch`),
        // `reason` is the fixed phrase naming the classification rule that
        // matched, and `originClass`/`match` say what the origin was taken to
        // be. What is gone is the refusal MESSAGE, which named the database and
        // the host in prose, and the two fields that named them outright. The
        // remedy is invariant and stated here rather than quoted from the
        // message, so an operator still knows the next step without the line
        // disclosing the target.
        createFatalLogger('dbGuard').error('database_origin_refused', {
            script: entryScript,
            code: error.code,
            ...originLogFields(error.origin),
            remedy:
                `Point ${DATABASE_URL_ENV} at a local development, test or shadow database, or — for ` +
                `catalog-load and recipes-seed — pass ${CONFIRM_TARGET_FLAG} with the database name that ` +
                `${DATABASE_URL_ENV} already carries.`,
            error: safeError(error),
        });
        process.exit(1);
    }
}
