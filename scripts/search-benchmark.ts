// The catalog search benchmark: measures the in-process search against the
// committed query set and writes the report the release gate reads.
//
// WHAT THIS STAGE DOES. It runs every query in
// data/meal-planning/search-benchmark.v1.json against the loaded catalog
// release through `catalog.service.searchPublishedFoods` — in process, so what
// is measured is the search itself and not an HTTP round trip — under the
// protocol that file declares: one untimed warm-up pass over the whole set,
// then three timed passes, sequential, on a single connection. It scores the
// rank of each query's expected food, checks that paging repeats and drops
// nothing, records the conditions the measurement was taken under, and writes
// data/meal-planning/reports/latest/benchmark-report.json (Agent Action Plan
// §0.7.1 Group 3, §0.9.3).
//
// THIS REPORT IS THE ACCEPTANCE EVIDENCE for the common-food search
// requirement, and the stage is FAIL-CLOSED: every threshold in the contract is
// asserted, a missed threshold exits non-zero with a verdict block naming the
// metric, its measured value and its bound, and a shortfall is reported as an
// unmet requirement rather than smoothed. The Jest suite named in
// NON_ACCEPTANCE_SUITE runs the same mechanics over a synthetic corpus and is
// explicitly NOT acceptance evidence; the report says so in its own body, so
// the distinction survives being read away from this file.
//
// Two inputs decide what a run may claim, and both are hard failures rather
// than soft ones. An expectation names its food by the stable
// `catalog_foods.source_key` the release carries, resolved to the local id
// AFTER the release is loaded: a key that does not resolve means this query set
// and the loaded release disagree about what is published, so the run fails
// naming the keys instead of scoring them as misses. And a condition the
// contract asks for that cannot be read back is refused for the same reason — a
// blank condition field invalidates the evidence.
//
// The two guard imports are ordered and load-bearing: Rule
// backend-architecture §10's IPv4-first DNS ordering, then dbGuard's
// module-load classification of DATABASE_URL, both ahead of anything that could
// reach Prisma or the network. Everything that touches the database is loaded
// dynamically inside the run, after the guard has classified the origin and
// after the pool has been pinned — importing the client statically would
// construct it, and pin its pool size, before either.
import './lib/bootstrap';
import './lib/dbGuard';

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, ScriptLogger } from './lib/logger';
import {
    EXPECTED_SEARCH_BENCHMARK_VERSION,
    ManifestError,
    loadReleaseManifest,
    loadSearchBenchmark,
    releaseFilePath,
    reportPath,
    writeJsonFile,
} from './lib/manifest';
import type { CatalogReleaseManifest, SearchBenchmark, SearchBenchmarkQuery } from './lib/manifest';

const STAGE = 'search-benchmark';

/** The §0.3.3 artefact name; `--out` overrides the location, not the content. */
const DEFAULT_REPORT_FILE = 'benchmark-report.json';

const REPORT_VERSION = 'v1';

/** The command that owns the artefact, recorded in the report as its producer. */
const ACCEPTANCE_RUNNER_COMMAND = 'npm run search:benchmark';

const ACCEPTANCE_RUNNER = 'scripts/search-benchmark.ts';

/**
 * The synthetic-corpus suite. Named in the report so that a reader who never
 * opens this file still learns which artefact is acceptance evidence and which
 * is not.
 */
const NON_ACCEPTANCE_SUITE = 'src/__tests__/api/benchmark.test.ts';

const NON_ACCEPTANCE_FIXTURE = 'data/meal-planning/fixtures/benchmark-synthetic-10k.json';

/** The contract's `measuredUnit`; the stopwatch sits on exactly this function. */
const MEASURED_UNIT = 'catalog.service.searchPublishedFoods';

const CATALOG_SERVICE_MODULE = 'src/services/catalog.service.ts';

/**
 * Window size for the unmeasured scan that locates an expected food beyond the
 * measured page. Larger than the measured page on purpose — the scan is not
 * timed and not part of any reported latency, so the only thing its size
 * changes is how many calls it costs to answer "retrievable but ranked where?".
 * The ordering is total and deterministic, so any window slices the same global
 * order and the computed position is window-independent.
 */
const FULL_SCAN_PAGE_LIMIT = 100;

/** Latency figures are reported in milliseconds to three decimal places. */
const LATENCY_DECIMALS = 3;

/** Rates are reported to three decimal places, as the contract's bounds are. */
const RATE_DECIMALS = 3;

const NANOSECONDS_PER_MILLISECOND = 1_000_000;

const BYTES_PER_GIB = 1024 ** 3;

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Errors (Rule backend-architecture §8) — each carries what the operator needs
// to act, and main() maps it to an exit code.
// ---------------------------------------------------------------------------

/** One threshold's verdict, in the shape the report records it. */
export interface ThresholdCheck {
    readonly contractKey: string;
    readonly bound: number;
    readonly comparison: string;
    readonly measured: number;
    readonly measuredAsCount: string;
    readonly verdict: 'pass' | 'fail';
}

/**
 * A missed threshold. Carries the failing metrics with their measured values
 * and bounds, because "the benchmark failed" is not actionable and the exit
 * code alone cannot say which bar was missed.
 */
export class BenchmarkThresholdError extends Error {
    constructor(public readonly failures: readonly ThresholdCheck[]) {
        super(
            `Search benchmark thresholds missed: ${failures
                .map((failure) => `${failure.contractKey} measured ${failure.measured}, bound ${failure.bound}`)
                .join('; ')}`,
        );
        this.name = 'BenchmarkThresholdError';
    }
}

export type BenchmarkInputCode =
    | 'expectations_unresolved'
    | 'pagination_query_unknown'
    | 'condition_unreadable'
    | 'catalog_empty'
    | 'protocol_unusable';

/**
 * An input the run cannot honestly measure against. Separate from a threshold
 * miss because the two mean opposite things: a threshold miss is a measurement
 * that came out below its bar, while this is the absence of a measurement.
 */
export class BenchmarkInputError extends Error {
    constructor(
        public readonly code: BenchmarkInputCode,
        message: string,
        public readonly detail: readonly string[] = [],
    ) {
        super(message);
        this.name = 'BenchmarkInputError';
    }
}

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
    readonly help: boolean;
    /** `--benchmark`; the query-set version, which must match the contract's. */
    readonly benchmarkVersion: string;
    /** `--out`; `null` means the default artefact path. */
    readonly out: string | null;
    /** `--passes`; always a positive integer. `null` means "use the contract's". */
    readonly passes: number | null;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: BenchmarkOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

export interface PrerequisiteGap {
    readonly code: string;
    readonly requirement: string;
    readonly remedy: string;
    readonly detail?: string;
}

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

// dbGuard's flag, not this parser's: skipped with its value, never rejected.
const CONFIRM_TARGET_FLAG = '--confirm-target';

interface Token {
    readonly flag: string;
    readonly inlineValue: string | null;
}

const splitToken = (token: string): Token => {
    const separator = token.indexOf('=');
    if (!token.startsWith('--') || separator < 0) {
        return { flag: token, inlineValue: null };
    }
    return { flag: token.slice(0, separator), inlineValue: token.slice(separator + 1) };
};

export const parseArgs = (argv: readonly string[]): ParseResult => {
    if (argv.some((token) => HELP_FLAGS.includes(token))) {
        return {
            ok: true,
            options: {
                help: true,
                benchmarkVersion: EXPECTED_SEARCH_BENCHMARK_VERSION,
                out: null,
                passes: null,
            },
        };
    }

    const errors: ArgumentError[] = [];
    let benchmarkVersion = EXPECTED_SEARCH_BENCHMARK_VERSION;
    let benchmarkSeen = false;
    let out: string | null = null;
    let outSeen = false;
    let passes: number | null = null;

    let index = 0;
    const takeValue = (inlineValue: string | null): string | null => {
        if (inlineValue !== null) {
            return inlineValue.length > 0 ? inlineValue : null;
        }
        const next = index < argv.length ? argv[index] : null;
        if (next === null || next.length === 0 || next.startsWith('-')) {
            return null;
        }
        index += 1;
        return next;
    };

    while (index < argv.length) {
        const { flag, inlineValue } = splitToken(argv[index]);
        index += 1;

        if (flag === '--benchmark') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a query-set version, for example v1` });
                continue;
            }
            if (benchmarkSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            benchmarkSeen = true;
            benchmarkVersion = value;
            continue;
        }

        if (flag === '--out') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a file path` });
                continue;
            }
            if (outSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            outSeen = true;
            out = value;
            continue;
        }

        if (flag === '--passes') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a positive integer` });
                continue;
            }
            if (passes !== null) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                errors.push({ flag, message: `${flag} must be a positive integer` });
                continue;
            }
            passes = parsed;
            continue;
        }

        if (flag === CONFIRM_TARGET_FLAG) {
            takeValue(inlineValue);
            continue;
        }

        errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, benchmarkVersion, out, passes } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: ${ACCEPTANCE_RUNNER_COMMAND} -- [options]   (${STAGE})`,
        '',
        'Measures internal catalog search against the committed query set and writes',
        'the acceptance-evidence report. Fail-closed: any missed threshold exits',
        'non-zero with a verdict naming the metric, its measured value and its bound.',
        '',
        'Options:',
        '  --benchmark <ver>  Query-set version to run. Must match the version the',
        `                     committed query set declares. Default: ${EXPECTED_SEARCH_BENCHMARK_VERSION}.`,
        '  --out <path>       Write the report to this path instead of the default.',
        '                     A relative path resolves against the backend package root.',
        `                     Default: data/meal-planning/reports/latest/${DEFAULT_REPORT_FILE}`,
        '  --passes <n>       Override the timed pass count. FOR DIAGNOSIS ONLY — the',
        "                     committed run takes the query set's own timedPasses, which",
        '                     is the single source of truth for the protocol. That count',
        '                     is three because one pass cannot separate a cold cache from',
        '                     the steady state and two cannot show whether the second was',
        '                     representative. A report produced with an override records',
        '                     that it deviated, so it cannot be read as the committed run.',
        '  --help, -h         Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/search-benchmark.v1.json    the query set, the expected',
        '                                                 source_keys per query, the',
        '                                                 thresholds and the protocol',
        '  data/meal-planning/catalog/releases/<ver>/     the release checksums recorded',
        '                                                 as measurement conditions',
        `  ${CATALOG_SERVICE_MODULE}                the in-process search this`,
        '                                                 benchmark times',
        '',
        'Environment:',
        '  DATABASE_URL   required; classified by scripts/lib/dbGuard.ts. The catalog',
        '                 the queries run against is the one loaded in it. Load it with',
        '                 `npm run catalog:load -- --release <ver>` first.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

/**
 * Where the report is written. `null` takes manifest.ts's validated artefact
 * path; an operator value is resolved against the backend package root so the
 * command is working-directory independent.
 */
export const resolveOutPath = (out: string | null): string =>
    out === null ? reportPath(DEFAULT_REPORT_FILE) : path.resolve(__dirname, '..', out);

// ---------------------------------------------------------------------------
// The seams the run is driven through.
// ---------------------------------------------------------------------------

/** One page of the measured unit, in the shape `catalog.service` returns it. */
export interface SearchPage {
    readonly items: ReadonlyArray<{ readonly id: string }>;
    readonly total: number;
}

/**
 * The measured unit. Injected rather than imported at the top level for two
 * reasons: the real one reaches the shared PrismaClient, which must not be
 * constructed before the guard has run, and a caller driving this module in
 * isolation needs a seam that does not require a database.
 */
export type SearchFn = (q: string, page: number, limit: number) => Promise<SearchPage>;

/**
 * The narrow slice of the Prisma client this stage uses. Structural, so the
 * real client passes with a cast the way `catalog-load.ts` passes its own — and
 * narrow because this stage only reads: it resolves expectation keys, counts
 * published foods and asks the server for the conditions it records. There is
 * no write path to any catalog table here.
 */
export interface BenchmarkDb {
    $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
    catalog_foods: {
        findMany(args: {
            where: { source_key: { in: string[] } };
            select: { id: true; source_key: true; publication_status: true };
        }): Promise<Array<{ id: string; source_key: string; publication_status: string }>>;
        count(args: { where: { publication_status: string } }): Promise<number>;
    };
}

export interface BenchmarkDeps {
    readonly db: BenchmarkDb;
    readonly search: SearchFn;
    readonly benchmark: SearchBenchmark;
    readonly releaseManifest: CatalogReleaseManifest;
    readonly releaseVersion: string;
    /** Absolute path of the report artefact. */
    readonly outPath: string;
    readonly logger: ScriptLogger;
    readonly now: () => Date;
    /** Monotonic nanosecond clock; seamed so a driver can supply a fake one. */
    readonly hrtime: () => bigint;
    /** Timed pass count actually used, and whether it deviates from the contract. */
    readonly timedPasses: number;
    readonly passesOverridden: boolean;
    /** Whether the pool was pinned to one connection before the client loaded. */
    readonly singleConnectionPinned: boolean;
    /** Reads a repository file as UTF-8, so the ORDER BY read-back stays seamed. */
    readonly readRepoFile: (repoRelativePath: string) => string;
}

// ---------------------------------------------------------------------------
// Arithmetic. Small and inline on purpose: Rule backend-architecture §7.1
// forbids manufacturing a logic module for expressions a test would only
// restate, and the prompt for this file forbids adding one to this folder.
// ---------------------------------------------------------------------------

const roundTo = (value: number, decimals: number): number => {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
};

const rateOf = (count: number, total: number): number =>
    total === 0 ? 0 : roundTo(count / total, RATE_DECIMALS);

/**
 * Nearest-rank percentile over the sorted sample set — the definition the
 * report names, so a reader can reproduce the figure from the samples rather
 * than having to guess between interpolation conventions.
 */
const percentileOf = (sortedAscending: readonly number[], percentile: number): number => {
    if (sortedAscending.length === 0) {
        return 0;
    }
    const ordinal = Math.ceil((percentile / 100) * sortedAscending.length);
    const index = Math.min(Math.max(ordinal, 1), sortedAscending.length) - 1;
    return roundTo(sortedAscending[index], LATENCY_DECIMALS);
};

// ---------------------------------------------------------------------------
// Expectations: stable source_key → local id.
// ---------------------------------------------------------------------------

export interface ResolvedExpectations {
    /** Every expectation key that resolved, mapped to its local catalog id. */
    readonly idBySourceKey: ReadonlyMap<string, string>;
    /** Local ids per query id, in the query's own expectation order. */
    readonly idsByQueryId: ReadonlyMap<string, readonly string[]>;
    readonly expectationCount: number;
}

/**
 * Resolves every expectation from its release-stable `source_key` to the local
 * `catalog_foods.id`, and refuses the whole run when any key is missing or is
 * not published.
 *
 * Refusing is the contract's own rule, and the reason is worth stating: an
 * unresolvable key means the query set and the loaded release disagree about
 * what is published. Scored as a miss it would look like a ranking problem;
 * skipped it would quietly shrink the denominator. Either way the report would
 * describe a corpus that was never measured.
 */
export const resolveExpectations = async (
    db: BenchmarkDb,
    queries: readonly SearchBenchmarkQuery[],
): Promise<ResolvedExpectations> => {
    const wanted = new Set<string>();
    for (const query of queries) {
        for (const sourceKey of query.expected) {
            wanted.add(sourceKey);
        }
    }

    const rows =
        wanted.size === 0
            ? []
            : await db.catalog_foods.findMany({
                  where: { source_key: { in: [...wanted] } },
                  select: { id: true, source_key: true, publication_status: true },
              });

    const idBySourceKey = new Map<string, string>();
    const unpublished: string[] = [];
    for (const row of rows) {
        if (row.publication_status === 'published') {
            idBySourceKey.set(row.source_key, row.id);
        } else {
            unpublished.push(`${row.source_key} (${row.publication_status})`);
        }
    }

    const missing = [...wanted].filter((sourceKey) => !idBySourceKey.has(sourceKey)).sort();
    if (missing.length > 0) {
        const unpublishedNote =
            unpublished.length === 0 ? '' : ` Present but not published: ${unpublished.sort().join(', ')}.`;
        throw new BenchmarkInputError(
            'expectations_unresolved',
            `${missing.length} of ${wanted.size} expectation source_keys did not resolve to a published catalog food. ` +
                'The loaded release and the query set disagree about what is published, so no run can be scored ' +
                `against it. Load the release the query set names and re-run.${unpublishedNote}`,
            missing,
        );
    }

    const idsByQueryId = new Map<string, readonly string[]>();
    let expectationCount = 0;
    for (const query of queries) {
        const ids = query.expected.map((sourceKey) => idBySourceKey.get(sourceKey) as string);
        idsByQueryId.set(query.id, ids);
        expectationCount += ids.length;
    }

    return { idBySourceKey, idsByQueryId, expectationCount };
};

// ---------------------------------------------------------------------------
// Measurement conditions. Every field the contract's `reportedConditions` names
// is filled from the run itself; a field that cannot be read back refuses the
// run, because a blank condition invalidates the evidence.
// ---------------------------------------------------------------------------

export interface ReleaseChecksum {
    readonly manifestSha256: string;
    readonly files: ReadonlyArray<{ readonly name: string; readonly sha256: string }>;
}

export interface OrderingCollation {
    readonly collation: string;
    readonly appliesTo: readonly string[];
    readonly readBackFrom: string;
    readonly orderBy: string;
    readonly note: string;
}

export interface BenchmarkConditions {
    readonly catalogReleaseChecksum: ReleaseChecksum;
    readonly postgresVersion: string;
    readonly hostCpu: string;
    readonly hostMemory: string;
    readonly sharedBuffers: string;
    readonly warmCacheCondition: {
        readonly warmupPasses: number;
        readonly timedPasses: number;
        readonly sequential: boolean;
        readonly connections: number;
        readonly timing: string;
        readonly measuredUnit: string;
        readonly statement: string;
    };
    readonly orderingCollation: OrderingCollation;
    readonly databaseDefaultCollation: string;
}

const sha256Of = (absolutePath: string): string =>
    crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');

const releaseChecksumOf = (releaseVersion: string, manifest: CatalogReleaseManifest): ReleaseChecksum => ({
    manifestSha256: sha256Of(releaseFilePath(releaseVersion, 'manifest.json')),
    files: manifest.files.map((file) => ({ name: file.name ?? file.path, sha256: file.sha256 })),
});

/**
 * The single-value answer of a `SHOW`/`SELECT` that returns one row of one
 * column. Prisma hands raw results back as an array of objects whose key is the
 * server's own column name, which differs per statement, so the value is taken
 * positionally rather than by a name this file would have to hard-code.
 */
const firstScalar = (rows: unknown): string | null => {
    if (!Array.isArray(rows) || rows.length === 0) {
        return null;
    }
    const row = rows[0] as Record<string, unknown>;
    const values = Object.values(row);
    if (values.length === 0 || values[0] === null || values[0] === undefined) {
        return null;
    }
    return String(values[0]);
};

const scalarOrRefuse = async (db: BenchmarkDb, statement: string, condition: string): Promise<string> => {
    const value = firstScalar(await db.$queryRawUnsafe(statement));
    if (value === null || value.trim().length === 0) {
        throw new BenchmarkInputError(
            'condition_unreadable',
            `The measurement condition ${condition} could not be read back with \`${statement}\`. ` +
                'A report with a blank condition is not evidence, so the run refuses rather than writing one.',
            [condition],
        );
    }
    return value.trim();
};

/**
 * The collation the search statements pin, read back out of the service's own
 * ORDER BY rather than assumed — the query set's `collationEvidenceRule` asks
 * for the evidence, not for a restatement of the intent. `C` is byte order over
 * the stored UTF-8, which is what makes the ranking a property of the release
 * instead of a property of the database that happens to hold it.
 */
export const readOrderingCollation = (readRepoFile: (repoRelativePath: string) => string): OrderingCollation => {
    const source = readRepoFile(CATALOG_SERVICE_MODULE);
    // Line-oriented on purpose. The clause is one line of a tagged template,
    // and it contains the double quotes of COLLATE "C" — a character class that
    // excluded quotes to stop at a statement boundary would truncate the match
    // right before the collation this condition exists to record.
    const match = /^[ \t]*ORDER\s+BY\s+[^\n]*?rank\s+DESC[^\n]*$/im.exec(source);
    if (match === null) {
        throw new BenchmarkInputError(
            'condition_unreadable',
            `The ordering could not be read back from ${CATALOG_SERVICE_MODULE}: no ORDER BY clause ranking by ` +
                'rank DESC was found. The ordering condition is what makes a cross-database comparison readable, ' +
                'so the run refuses rather than recording an assumed one.',
            ['orderingCollation'],
        );
    }

    const orderBy = match[0].replace(/\s+/g, ' ').trim();
    const collateMatch = /COLLATE\s+"([^"]+)"/i.exec(orderBy);
    const appliesTo = ['display_name', 'source_key'].filter((column) =>
        new RegExp(`${column}\\s+COLLATE`, 'i').test(orderBy),
    );

    return {
        collation: collateMatch === null ? 'database default' : collateMatch[1],
        appliesTo,
        readBackFrom: CATALOG_SERVICE_MODULE,
        orderBy,
        note:
            collateMatch === null
                ? 'No COLLATE is pinned in the service ORDER BY, so the text ordering follows the database default ' +
                  'and is NOT portable across databases created with different collations.'
                : `Read back from the service's own ORDER BY rather than assumed. ${collateMatch[1]} is byte order ` +
                  'over the stored UTF-8, so it is identical on every server and is what makes the order a property ' +
                  'of the release rather than of the database.',
    };
};

const describeWarmCache = (deps: BenchmarkDeps): BenchmarkConditions['warmCacheCondition'] => {
    const { protocol } = deps.benchmark;
    const connectionNote = deps.singleConnectionPinned
        ? 'Execution was sequential on a single connection (the datasource pool was pinned to connection_limit=1 ' +
          'before the client was constructed), so a percentile describes the query rather than queueing behind ' +
          'other queries.'
        : 'Execution was sequential — one awaited call at a time, so one connection is in use at a time — but the ' +
          'datasource pool was NOT pinned to one connection for this run.';
    const overrideNote = deps.passesOverridden
        ? ` This run overrode the contract's timedPasses of ${protocol.timedPasses} with ${deps.timedPasses} via ` +
          '--passes, so it is a diagnostic run and not the committed protocol.'
        : '';

    return {
        warmupPasses: protocol.warmupPasses,
        timedPasses: deps.timedPasses,
        sequential: true,
        connections: 1,
        timing: protocol.timing,
        measuredUnit: MEASURED_UNIT,
        statement:
            `${protocol.warmupPasses} untimed warm-up pass over the full query set settled the shared buffers and ` +
            `the GIN index into cache; the ${deps.timedPasses} timed passes that follow measure the steady state. ` +
            `Every call was timed IN PROCESS around ${MEASURED_UNIT} with process.hrtime.bigint(), so these ` +
            'latencies exclude network, Express and JSON-serialisation time and are NOT over-HTTP figures. ' +
            `${connectionNote}${overrideNote}`,
    };
};

export const captureConditions = async (deps: BenchmarkDeps): Promise<BenchmarkConditions> => ({
    catalogReleaseChecksum: releaseChecksumOf(deps.releaseVersion, deps.releaseManifest),
    // version() rather than SHOW server_version because it carries the exact
    // patch level and the build target in one string, and the patch is what
    // keeps the evidence reproducible.
    postgresVersion: await scalarOrRefuse(deps.db, 'SELECT version()', 'postgresVersion'),
    hostCpu: describeHostCpu(),
    hostMemory: describeHostMemory(),
    sharedBuffers: await scalarOrRefuse(deps.db, 'SHOW shared_buffers', 'sharedBuffers'),
    warmCacheCondition: describeWarmCache(deps),
    orderingCollation: readOrderingCollation(deps.readRepoFile),
    databaseDefaultCollation: await scalarOrRefuse(
        deps.db,
        'SELECT datcollate FROM pg_database WHERE datname = current_database()',
        'databaseDefaultCollation',
    ),
});

/**
 * CPU and memory are measurement conditions — they are what make a latency
 * figure comparable — and deliberately not host identity: no hostname, no
 * address and no connection string reaches the report.
 */
const describeHostCpu = (): string => {
    const cpus = os.cpus();
    if (cpus.length === 0) {
        return 'unknown CPU, 0 logical CPUs';
    }
    return `${cpus[0].model.trim()}, ${cpus.length} logical CPUs`;
};

const describeHostMemory = (): string => {
    const bytes = os.totalmem();
    return `${bytes} bytes (${roundTo(bytes / BYTES_PER_GIB, 1)} GiB)`;
};


// ---------------------------------------------------------------------------
// The passes.
// ---------------------------------------------------------------------------

export type QueryOutcome =
    | 'top3'
    | 'top10'
    | 'in_measured_page'
    | 'beyond_measured_page'
    | 'not_retrieved'
    | 'zero_results';

/** What one pass observed for one query. */
interface PassObservation {
    readonly rank: number | null;
    readonly matchedId: string | null;
    readonly matchSetTotal: number;
}

export interface QueryResult {
    readonly id: string;
    readonly q: string;
    readonly kind: string;
    readonly expectedSourceKeys: readonly string[];
    readonly matchedSourceKey: string | null;
    readonly rank: number | null;
    readonly rankInFullResultSet: number | null;
    readonly matchSetTotal: number;
    readonly outcome: QueryOutcome;
    readonly rankStableAcrossPasses: boolean;
}

const observe = (page: SearchPage, expectedIds: readonly string[]): PassObservation => {
    for (let index = 0; index < page.items.length; index += 1) {
        const id = page.items[index].id;
        if (expectedIds.includes(id)) {
            return { rank: index + 1, matchedId: id, matchSetTotal: page.total };
        }
    }
    return { rank: null, matchedId: null, matchSetTotal: page.total };
};

/**
 * One pass over the whole query set at the contract's latency limit.
 *
 * `timed` is what separates the warm-up from the measurement: the warm-up runs
 * the identical calls and keeps none of their durations, so the samples the
 * report percentiles are drawn from describe the steady state. Sequential by
 * construction — one awaited call at a time, never Promise.all — because a
 * percentile over concurrent calls would measure queueing.
 */
const runPass = async (
    deps: BenchmarkDeps,
    expectations: ResolvedExpectations,
    timed: boolean,
): Promise<{ observations: Map<string, PassObservation>; latencies: number[] }> => {
    const limit = deps.benchmark.thresholds.latencyLimit;
    const observations = new Map<string, PassObservation>();
    const latencies: number[] = [];

    for (const query of deps.benchmark.queries) {
        const expectedIds = expectations.idsByQueryId.get(query.id) ?? [];
        const startedAt = deps.hrtime();
        const page = await deps.search(query.q, 1, limit);
        const elapsedNs = deps.hrtime() - startedAt;

        if (timed) {
            latencies.push(Number(elapsedNs) / NANOSECONDS_PER_MILLISECOND);
        }
        observations.set(query.id, observe(page, expectedIds));
    }

    return { observations, latencies };
};

/**
 * Locates an expected food that did not place inside the measured page by
 * walking the ordered result set through the same service function.
 *
 * Untimed and outside every reported latency figure: its only job is to tell
 * "ranked past the page the threshold is stated for" apart from "not
 * retrievable at all", which is the difference between a ranking problem and a
 * retrieval problem. The ordering is total, so a wider window slices the same
 * global order and the position it computes is window-independent.
 */
const locateInFullResultSet = async (
    deps: BenchmarkDeps,
    query: SearchBenchmarkQuery,
    expectedIds: readonly string[],
    matchSetTotal: number,
): Promise<{ position: number | null; matchedId: string | null }> => {
    let page = 1;
    let scanned = 0;

    while (scanned < matchSetTotal) {
        const result = await deps.search(query.q, page, FULL_SCAN_PAGE_LIMIT);
        if (result.items.length === 0) {
            break;
        }
        for (let index = 0; index < result.items.length; index += 1) {
            const id = result.items[index].id;
            if (expectedIds.includes(id)) {
                return { position: scanned + index + 1, matchedId: id };
            }
        }
        scanned += result.items.length;
        page += 1;
    }

    return { position: null, matchedId: null };
};

// ---------------------------------------------------------------------------
// Pagination check.
// ---------------------------------------------------------------------------

export interface PaginationQueryOutcome {
    readonly id: string;
    readonly q: string;
    readonly matchSetTotal: number;
    readonly pagedIds: number;
    readonly referenceIds: number;
    readonly expectedIds: number;
    readonly pagesTraversed: number;
    readonly sequenceMatches: boolean;
    readonly duplicates: number;
    readonly missing: number;
}

export interface PaginationCheckResult {
    readonly perQuery: readonly PaginationQueryOutcome[];
    readonly queriesChecked: number;
    readonly queriesPassed: number;
    readonly duplicateIds: number;
    readonly missingIds: number;
    readonly threePageTraversals: number;
    readonly matchSetWidthRange: readonly [number, number];
    readonly outcome: 'pass' | 'fail';
}

/**
 * Pages each named query and compares the concatenation with a single wide
 * reference fetch of the same query.
 *
 * The reference fetch is read IN PROCESS, and that is a requirement rather than
 * a shortcut: `GET /catalog/foods` validates `limit` as 1..50 (`MAX_LIMIT` in
 * src/utils/pagination.ts), so a `singlePageLimit` of 75 over HTTP answers 400.
 * Lowering the limit to 50 to make it routable would weaken the invariant, and
 * putting it through the endpoint cannot express it. Run after the timed passes
 * and never interleaved with them, so none of its calls can land in a latency
 * sample.
 */
export const runPaginationCheck = async (deps: BenchmarkDeps): Promise<PaginationCheckResult> => {
    const spec = deps.benchmark.paginationCheck;
    const byId = new Map(deps.benchmark.queries.map((query) => [query.id, query]));

    const unknown = spec.queryIds.filter((id) => !byId.has(id));
    if (unknown.length > 0) {
        throw new BenchmarkInputError(
            'pagination_query_unknown',
            `The pagination check names ${unknown.length} query id(s) that the query set does not define, so the ` +
                'invariant cannot be evaluated over the set it was written for.',
            unknown,
        );
    }

    const perQuery: PaginationQueryOutcome[] = [];
    let duplicateIds = 0;
    let missingIds = 0;
    let threePageTraversals = 0;
    let widest = 0;
    let narrowest = Number.MAX_SAFE_INTEGER;

    for (const id of spec.queryIds) {
        const query = byId.get(id) as SearchBenchmarkQuery;

        const pagedIds: string[] = [];
        let pagesTraversed = 0;
        for (let page = 1; page <= spec.pages; page += 1) {
            const result = await deps.search(query.q, page, spec.limit);
            if (result.items.length > 0) {
                pagesTraversed += 1;
            }
            pagedIds.push(...result.items.map((item) => item.id));
        }

        const reference = await deps.search(query.q, 1, spec.singlePageLimit);
        const referenceIds = reference.items.map((item) => item.id);
        const expectedIds = Math.min(spec.singlePageLimit, reference.total);

        const uniquePaged = new Set(pagedIds);
        const duplicates = pagedIds.length - uniquePaged.size;
        const missing = referenceIds.filter((referenceId) => !uniquePaged.has(referenceId)).length;
        const sequenceMatches =
            pagedIds.length === referenceIds.length &&
            pagedIds.every((pagedId, index) => pagedId === referenceIds[index]);

        duplicateIds += duplicates;
        missingIds += missing;
        if (pagesTraversed >= spec.pages) {
            threePageTraversals += 1;
        }
        widest = Math.max(widest, reference.total);
        narrowest = Math.min(narrowest, reference.total);

        perQuery.push({
            id: query.id,
            q: query.q,
            matchSetTotal: reference.total,
            pagedIds: pagedIds.length,
            referenceIds: referenceIds.length,
            expectedIds,
            pagesTraversed,
            sequenceMatches,
            duplicates,
            missing,
        });
    }

    const queriesPassed = perQuery.filter(
        (entry) => entry.sequenceMatches && entry.duplicates === 0 && entry.missing === 0,
    ).length;

    return {
        perQuery,
        queriesChecked: perQuery.length,
        queriesPassed,
        duplicateIds,
        missingIds,
        threePageTraversals,
        matchSetWidthRange: [narrowest === Number.MAX_SAFE_INTEGER ? 0 : narrowest, widest],
        outcome: queriesPassed === perQuery.length && duplicateIds === 0 && missingIds === 0 ? 'pass' : 'fail',
    };
};

// ---------------------------------------------------------------------------
// Rollups and thresholds.
// ---------------------------------------------------------------------------

export interface KindRollup {
    readonly kind: string;
    readonly queries: number;
    readonly topThreeHitRate: number;
    readonly topTenHitRate: number;
    readonly beyondMeasuredPage: number;
}

export interface BenchmarkRollups {
    readonly queriesScored: number;
    readonly topThreeHitRate: number;
    readonly topTenHitRate: number;
    readonly zeroResultCount: number;
    readonly zeroResultRate: number;
    readonly beyondMeasuredPageCount: number;
    readonly notRetrievedCount: number;
    readonly rankStability: {
        readonly queriesStableAcrossAllTimedPasses: number;
        readonly unstable: number;
        readonly statement: string;
    };
    readonly perKind: readonly KindRollup[];
}

const rollUp = (results: readonly QueryResult[], timedPasses: number): BenchmarkRollups => {
    const scored = results.length;
    const topThree = results.filter((result) => result.rank !== null && result.rank <= 3).length;
    const topTen = results.filter((result) => result.rank !== null && result.rank <= 10).length;
    const zeroResults = results.filter((result) => result.matchSetTotal === 0).length;
    const beyondPage = results.filter((result) => result.outcome === 'beyond_measured_page').length;
    const notRetrieved = results.filter((result) => result.outcome === 'not_retrieved').length;
    const stable = results.filter((result) => result.rankStableAcrossPasses).length;

    const kinds = [...new Set(results.map((result) => result.kind))].sort();
    const perKind = kinds.map((kind): KindRollup => {
        const ofKind = results.filter((result) => result.kind === kind);
        return {
            kind,
            queries: ofKind.length,
            topThreeHitRate: rateOf(ofKind.filter((r) => r.rank !== null && r.rank <= 3).length, ofKind.length),
            topTenHitRate: rateOf(ofKind.filter((r) => r.rank !== null && r.rank <= 10).length, ofKind.length),
            beyondMeasuredPage: ofKind.filter((r) => r.outcome === 'beyond_measured_page').length,
        };
    });

    return {
        queriesScored: scored,
        topThreeHitRate: rateOf(topThree, scored),
        topTenHitRate: rateOf(topTen, scored),
        zeroResultCount: zeroResults,
        zeroResultRate: rateOf(zeroResults, scored),
        beyondMeasuredPageCount: beyondPage,
        notRetrievedCount: notRetrieved,
        perKind,
        rankStability: {
            queriesStableAcrossAllTimedPasses: stable,
            unstable: scored - stable,
            statement:
                scored - stable === 0
                    ? `Every query returned the same rank and the same match-set total on all ${timedPasses} timed ` +
                      'passes, so the ranks here are a property of the release and not of one pass.'
                    : `${scored - stable} query/queries returned a different rank or match-set total between the ` +
                      `${timedPasses} timed passes. The reported rank is the first timed pass's; an unstable rank ` +
                      'means the ordering is not total and must be raised, not averaged away.',
        },
    };
};

export interface LatencySummary {
    readonly measuredAtLimit: number;
    readonly timing: string;
    readonly measuredUnit: string;
    readonly samples: number;
    readonly p50LatencyMs: number;
    readonly p95LatencyMs: number;
    readonly p99LatencyMs: number;
    readonly minLatencyMs: number;
    readonly maxLatencyMs: number;
    readonly percentileMethod: string;
    readonly contentionCaveat: string;
}

const summarizeLatency = (samples: readonly number[], limit: number, timing: string): LatencySummary => {
    const sorted = [...samples].sort((a, b) => a - b);
    return {
        measuredAtLimit: limit,
        timing,
        measuredUnit: MEASURED_UNIT,
        samples: sorted.length,
        p50LatencyMs: percentileOf(sorted, 50),
        p95LatencyMs: percentileOf(sorted, 95),
        p99LatencyMs: percentileOf(sorted, 99),
        minLatencyMs: sorted.length === 0 ? 0 : roundTo(sorted[0], LATENCY_DECIMALS),
        maxLatencyMs: sorted.length === 0 ? 0 : roundTo(sorted[sorted.length - 1], LATENCY_DECIMALS),
        percentileMethod: 'nearest-rank over all timed samples',
        contentionCaveat:
            'Latency was measured on whatever host ran this command. A figure taken on a host running other ' +
            'workloads against the same PostgreSQL instance is an upper bound on the query, not a clean ' +
            'measurement of it; the relevance figures and page sequences are unaffected by load.',
    };
};

const evaluateThresholds = (
    benchmark: SearchBenchmark,
    rollups: BenchmarkRollups,
    latency: LatencySummary,
): readonly ThresholdCheck[] => {
    const { thresholds } = benchmark;
    const scored = rollups.queriesScored;
    const topThreeCount = Math.round(rollups.topThreeHitRate * scored);
    const topTenCount = Math.round(rollups.topTenHitRate * scored);

    return [
        {
            contractKey: 'topThreeHitRate',
            bound: thresholds.topThreeHitRate,
            comparison: 'measured >= bound',
            measured: rollups.topThreeHitRate,
            measuredAsCount: `${topThreeCount} of ${scored} queries`,
            verdict: rollups.topThreeHitRate >= thresholds.topThreeHitRate ? 'pass' : 'fail',
        },
        {
            contractKey: 'topTenHitRate',
            bound: thresholds.topTenHitRate,
            comparison: 'measured >= bound',
            measured: rollups.topTenHitRate,
            measuredAsCount: `${topTenCount} of ${scored} queries`,
            verdict: rollups.topTenHitRate >= thresholds.topTenHitRate ? 'pass' : 'fail',
        },
        {
            contractKey: 'maxZeroResultRate',
            bound: thresholds.maxZeroResultRate,
            comparison: 'measured <= bound',
            measured: rollups.zeroResultRate,
            measuredAsCount: `${rollups.zeroResultCount} of ${scored} queries returned no rows`,
            verdict: rollups.zeroResultRate <= thresholds.maxZeroResultRate ? 'pass' : 'fail',
        },
        {
            contractKey: 'p95LatencyMs',
            bound: thresholds.p95LatencyMs,
            comparison: 'measured <= bound',
            measured: latency.p95LatencyMs,
            measuredAsCount: `${latency.samples} timed samples at limit ${latency.measuredAtLimit}`,
            verdict: latency.p95LatencyMs <= thresholds.p95LatencyMs ? 'pass' : 'fail',
        },
    ];
};


// ---------------------------------------------------------------------------
// The report.
// ---------------------------------------------------------------------------

export interface BenchmarkReport {
    readonly stage: string;
    readonly reportVersion: string;
    readonly generatedAt: string;
    readonly benchmarkVersion: string;
    readonly catalogRelease: string;
    readonly producedBy: string;
    readonly verdict: {
        readonly overall: 'pass' | 'fail';
        readonly failedThresholds: readonly string[];
        readonly passedThresholds: readonly string[];
        readonly statement: string;
    };
    readonly provenance: {
        readonly acceptanceRunner: string;
        readonly acceptanceRunnerCommand: string;
        readonly howTheseFiguresWereObtained: string;
    };
    readonly acceptanceEvidence: {
        readonly thisReportIsAcceptanceEvidence: true;
        readonly measuredAgainst: string;
        readonly nonAcceptanceSuite: {
            readonly path: string;
            readonly presentInThisCheckout: boolean;
            readonly fixture: string;
            readonly isAcceptanceEvidence: false;
            readonly statement: string;
        };
    };
    readonly dataLegality: {
        readonly status: 'legal_to_commit';
        readonly basis: string;
        readonly containsUserOwnedData: false;
        readonly userOwnedDataStatement: string;
    };
    readonly conditions: BenchmarkConditions;
    readonly notMeasured: {
        readonly statement: string;
        readonly items: readonly string[];
    };
    readonly corpus: {
        readonly publishedFoods: number;
        readonly manifestPublishedFoods: number;
        readonly countsAgree: boolean;
        readonly loadedBy: string;
        readonly expectationResolution: {
            readonly mode: string;
            readonly expectations: number;
            readonly distinctSourceKeys: number;
            readonly resolved: number;
            readonly unresolved: number;
            readonly statement: string;
        };
    };
    readonly thresholds: {
        readonly source: string;
        readonly policy: 'fail_closed';
        readonly measuredAtLimit: number;
        readonly checks: Readonly<Record<string, ThresholdCheck>>;
    };
    readonly rollups: BenchmarkRollups;
    readonly latency: LatencySummary;
    readonly paginationCheck: {
        readonly queryIds: readonly string[];
        readonly limit: number;
        readonly pages: number;
        readonly singlePageLimit: number;
        readonly referenceMode: string;
        readonly referenceModeStatement: string;
        readonly ordering: readonly string[];
        readonly outcome: 'pass' | 'fail';
        readonly queriesChecked: number;
        readonly queriesPassed: number;
        readonly duplicateIds: number;
        readonly missingIds: number;
        readonly threePageTraversals: number;
        readonly matchSetWidthRange: readonly [number, number];
        readonly statement: string;
        readonly perQuery: readonly PaginationQueryOutcome[];
    };
    readonly crossDatabaseReproduction: {
        readonly outcome: 'not_evaluated_by_a_single_run';
        readonly statement: string;
        readonly howToReproduce: readonly string[];
    };
    readonly diagnostics: {
        readonly beyondMeasuredPage: {
            readonly queries: number;
            readonly statement: string;
            readonly worstRanked: ReadonlyArray<{
                readonly id: string;
                readonly q: string;
                readonly rankInFullResultSet: number;
                readonly matchSetTotal: number;
            }>;
        };
        readonly notRetrieved: {
            readonly queries: number;
            readonly ids: readonly string[];
            readonly statement: string;
        };
        readonly interpretationLimits: string;
    };
    readonly resultsSchema: Readonly<Record<string, string>>;
    readonly results: readonly QueryResult[];
}

const REPORT_SCHEMA: Readonly<Record<string, string>> = {
    rank:
        'One-based position of the best-placed expected food within the measured page (the limit the latency ' +
        'threshold is stated for). Null means no expected food placed inside that page.',
    rankInFullResultSet:
        "The expected food's position in the complete ordered result set, found by an untimed scan through the " +
        'same service function. Equal to rank whenever the food placed inside the measured page; null only when ' +
        'no expected food appears anywhere in the result set.',
    expectedSourceKeys:
        'Acceptable answers, identified only by stable catalog_foods.source_key — never by a database-generated ' +
        'id, so the ranks are comparable across independently loaded databases.',
    matchedSourceKey: 'The expected food that actually placed, or null when none placed within the measured page.',
    outcome:
        'top3 | top10 | in_measured_page | beyond_measured_page | not_retrieved | zero_results. not_retrieved is ' +
        'a retrieval failure; beyond_measured_page is a ranking one.',
    rankStableAcrossPasses:
        'Whether every timed pass returned the same rank and match-set total for this query. False means the ' +
        'ordering is not total and the figure must not be averaged away.',
};

const verdictStatement = (failed: readonly ThresholdCheck[], pagination: PaginationCheckResult): string => {
    if (failed.length === 0 && pagination.outcome === 'pass') {
        return (
            'Search quality meets every bound in the contract, and paging repeats and drops nothing. Under the ' +
            "contract's fail-closed policy this report may be cited as acceptance evidence for the common-food " +
            'search requirement, for the corpus and conditions recorded above and no others.'
        );
    }

    const parts: string[] = [];
    if (failed.length > 0) {
        parts.push(
            `Search quality does NOT meet the contract's acceptance bar: ${failed
                .map((failure) => `${failure.contractKey} measured ${failure.measured} against bound ${failure.bound}`)
                .join(' and ')}.`,
        );
    }
    if (pagination.outcome === 'fail') {
        parts.push(
            `The pagination invariant failed: ${pagination.queriesChecked - pagination.queriesPassed} of ` +
                `${pagination.queriesChecked} checked queries did not page cleanly ` +
                `(${pagination.duplicateIds} duplicated id(s), ${pagination.missingIds} missing id(s)).`,
        );
    }
    parts.push(
        'The run therefore fails closed and exits non-zero: this report is a record of an UNMET requirement and ' +
            'must not be cited as evidence that catalog search meets its bar. The figures are real measurements — ' +
            'the shortfall is reported rather than smoothed, and remedying it belongs to the owners of the query ' +
            'set and the search implementation.',
    );
    return parts.join(' ');
};

const buildReport = (args: {
    readonly deps: BenchmarkDeps;
    readonly conditions: BenchmarkConditions;
    readonly results: readonly QueryResult[];
    readonly rollups: BenchmarkRollups;
    readonly latency: LatencySummary;
    readonly checks: readonly ThresholdCheck[];
    readonly pagination: PaginationCheckResult;
    readonly publishedFoods: number;
    readonly expectations: ResolvedExpectations;
}): BenchmarkReport => {
    const { deps, conditions, results, rollups, latency, checks, pagination, publishedFoods, expectations } = args;
    const { benchmark } = deps;
    const failed = checks.filter((check) => check.verdict === 'fail');
    const manifestPublished = deps.releaseManifest.counts.published_foods ?? deps.releaseManifest.counts.foods;

    const checksByKey: Record<string, ThresholdCheck> = {};
    for (const check of checks) {
        checksByKey[check.contractKey] = check;
    }

    const beyondPage = results
        .filter((result) => result.outcome === 'beyond_measured_page' && result.rankInFullResultSet !== null)
        .sort((a, b) => (b.rankInFullResultSet as number) - (a.rankInFullResultSet as number))
        .slice(0, 10)
        .map((result) => ({
            id: result.id,
            q: result.q,
            rankInFullResultSet: result.rankInFullResultSet as number,
            matchSetTotal: result.matchSetTotal,
        }));
    const notRetrieved = results.filter((result) => result.outcome === 'not_retrieved');

    return {
        stage: STAGE,
        reportVersion: REPORT_VERSION,
        generatedAt: deps.now().toISOString(),
        benchmarkVersion: benchmark.benchmarkVersion,
        catalogRelease: benchmark.catalogRelease,
        producedBy: ACCEPTANCE_RUNNER_COMMAND,
        verdict: {
            overall: failed.length === 0 && pagination.outcome === 'pass' ? 'pass' : 'fail',
            failedThresholds: failed.map((check) => check.contractKey),
            passedThresholds: checks.filter((check) => check.verdict === 'pass').map((check) => check.contractKey),
            statement: verdictStatement(failed, pagination),
        },
        provenance: {
            acceptanceRunner: ACCEPTANCE_RUNNER,
            acceptanceRunnerCommand: ACCEPTANCE_RUNNER_COMMAND,
            howTheseFiguresWereObtained:
                `By driving the contract's measuredUnit (${MEASURED_UNIT}) directly, in process, under the ` +
                `contract's protocol — ${benchmark.protocol.warmupPasses} untimed warm-up pass, then ` +
                `${deps.timedPasses} timed passes, sequential, one connection — over all ` +
                `${benchmark.queries.length} committed queries against the catalog loaded in the database this ` +
                'command addressed.',
        },
        acceptanceEvidence: {
            thisReportIsAcceptanceEvidence: true,
            measuredAgainst: `the loaded catalog release ${benchmark.catalogRelease}, ${publishedFoods} published foods`,
            nonAcceptanceSuite: {
                path: NON_ACCEPTANCE_SUITE,
                presentInThisCheckout: fs.existsSync(path.resolve(__dirname, '..', NON_ACCEPTANCE_SUITE)),
                fixture: NON_ACCEPTANCE_FIXTURE,
                isAcceptanceEvidence: false,
                statement:
                    `${NON_ACCEPTANCE_SUITE} exercises the same search mechanics over a synthetic corpus and is ` +
                    'explicitly NOT acceptance evidence: a synthetic corpus can demonstrate that paging, ranking ' +
                    'and the zero-result path behave, but it cannot establish that real common-food searches find ' +
                    `real foods. Only this report, produced by ${ACCEPTANCE_RUNNER_COMMAND} against a loaded ` +
                    'release, carries that claim.',
            },
        },
        dataLegality: {
            status: 'legal_to_commit',
            basis:
                'This report aggregates catalog and search data only. The catalog it measures is USDA FoodData ' +
                'Central data, which is public domain, together with self-generated generic catalog data; the ' +
                'figures here are ranks, counts and timings over that corpus.',
            containsUserOwnedData: false,
            userOwnedDataStatement:
                'No user identifier, contact address, diary entry, plan or credential is read or recorded by this ' +
                'stage. It queries only the shared catalog tables, which carry no user_id by design, and the ' +
                'conditions it records are machine characteristics rather than host or account identity — no ' +
                'hostname, address or connection string is written.',
        },
        conditions,
        notMeasured: {
            statement:
                'Everything the contract asks a run to report was measured. The items below are adjacent things ' +
                'this report deliberately does not claim, listed so its scope cannot be over-read.',
            items: [
                'Over-HTTP latency. The stopwatch sits on the service function, so Express, JSON serialisation and ' +
                    'network time are excluded by design and the figures are not end-to-end response times.',
                'Relevance beyond the committed query set. The hit rates describe these ' +
                    `${benchmark.queries.length} queries against this release, not search quality in general.`,
                'Cross-database rank identity, which one run cannot establish — see crossDatabaseReproduction for ' +
                    'the procedure that does.',
                'Concurrent-load behaviour. Execution was sequential on a single connection, so nothing here ' +
                    'describes how the query behaves under parallel traffic.',
            ],
        },
        corpus: {
            publishedFoods,
            manifestPublishedFoods: manifestPublished,
            countsAgree: publishedFoods === manifestPublished,
            loadedBy: `npm run catalog:load -- --release ${deps.releaseVersion}`,
            expectationResolution: {
                mode: 'sourceKey',
                expectations: expectations.expectationCount,
                distinctSourceKeys: expectations.idBySourceKey.size,
                resolved: expectations.idBySourceKey.size,
                unresolved: 0,
                statement:
                    'Every expectation resolved from its stable catalog_foods.source_key to a local id after the ' +
                    'release was loaded. An unresolvable key fails the whole run by contract — it is never skipped ' +
                    'and never scored as a miss.',
            },
        },
        thresholds: {
            source: 'data/meal-planning/search-benchmark.v1.json thresholds',
            policy: 'fail_closed',
            measuredAtLimit: benchmark.thresholds.latencyLimit,
            checks: checksByKey,
        },
        rollups,
        latency,
        paginationCheck: {
            queryIds: benchmark.paginationCheck.queryIds,
            limit: benchmark.paginationCheck.limit,
            pages: benchmark.paginationCheck.pages,
            singlePageLimit: benchmark.paginationCheck.singlePageLimit,
            // Stated, not read from the contract: `referenceMode` is prose in
            // the query-set file and is not part of the typed shape, and this
            // is the mode the code above actually used.
            referenceMode: 'in_process',
            referenceModeStatement:
                `The limit=${benchmark.paginationCheck.singlePageLimit} reference page was read IN PROCESS ` +
                `through ${MEASURED_UNIT}, not over HTTP: GET /catalog/foods validates limit as 1..50, so a ` +
                'wider single fetch would answer 400 invalid_request. The limit was not lowered to 50 to make it ' +
                'routable, because that would weaken the invariant this check exists to prove.',
            ordering: benchmark.ordering,
            outcome: pagination.outcome,
            queriesChecked: pagination.queriesChecked,
            queriesPassed: pagination.queriesPassed,
            duplicateIds: pagination.duplicateIds,
            missingIds: pagination.missingIds,
            threePageTraversals: pagination.threePageTraversals,
            matchSetWidthRange: pagination.matchSetWidthRange,
            statement:
                `For ${pagination.queriesPassed} of ${pagination.queriesChecked} queries, pages 1..` +
                `${benchmark.paginationCheck.pages} at limit ${benchmark.paginationCheck.limit} concatenated equal ` +
                `the first min(${benchmark.paginationCheck.singlePageLimit}, total) ids of one wide fetch of the ` +
                'same query, in the same order, with no id repeated and none missing.',
            perQuery: pagination.perQuery,
        },
        crossDatabaseReproduction: {
            outcome: 'not_evaluated_by_a_single_run',
            statement:
                'Release determinism (AAP §0.9.3) is a property of two runs, not of one, so a single run cannot ' +
                'assert it. The ranks and page sequences here are computed from release-stable source_keys under ' +
                'an ordering whose final tiebreaker is the portable source_key, which is what makes them ' +
                'reproducible; the evidence is produced by running this same command against a second, ' +
                'independently loaded database and diffing the two reports.',
            howToReproduce: [
                'Create a second database and apply the migrations.',
                `npm run catalog:load -- --release ${deps.releaseVersion} (against that database)`,
                `${ACCEPTANCE_RUNNER_COMMAND} -- --out <second-report.json>`,
                'Diff results[] and paginationCheck.perQuery between the two reports: ranks and page sequences ' +
                    'must be identical, and only the latency block may differ.',
            ],
        },
        diagnostics: {
            beyondMeasuredPage: {
                queries: rollups.beyondMeasuredPageCount,
                statement:
                    'These queries do retrieve their expected food — it is ranked past the measured page rather ' +
                    'than absent, which makes them a ranking observation and not a retrieval failure. The ten ' +
                    'worst-ranked are listed as the starting point for a ranking review.',
                worstRanked: beyondPage,
            },
            notRetrieved: {
                queries: notRetrieved.length,
                ids: notRetrieved.map((result) => result.id),
                statement:
                    notRetrieved.length === 0
                        ? 'Every expected food appears somewhere in its query result set, so nothing in this query ' +
                          'set is unretrievable.'
                        : 'These queries do not retrieve their expected food anywhere in the result set. That is a ' +
                          'retrieval failure, a different problem from a ranking one, and is not explained by page ' +
                          'depth.',
            },
            interpretationLimits:
                'This report states what was measured and does not diagnose a cause. A hit-rate shortfall is ' +
                'consistent with either expectations authored against a smaller corpus or a ranking that buries ' +
                'the intended food, and this run cannot distinguish them; the per-kind rollup and the ' +
                'beyond-measured-page list are the evidence for that analysis, which belongs to the owners of the ' +
                'query set and of the search implementation.',
        },
        resultsSchema: REPORT_SCHEMA,
        results,
    };
};

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

export interface BenchmarkOutcome {
    readonly report: BenchmarkReport;
    /** Empty on a clean run; non-empty is what makes the exit code non-zero. */
    readonly failures: readonly ThresholdCheck[];
    readonly paginationFailed: boolean;
    readonly outPath: string;
}

/**
 * Runs the benchmark and writes the report. Returns the outcome rather than
 * throwing on a missed threshold, so the caller writes the artefact first and
 * only then fails: a fail-closed run still has to leave the evidence of what
 * it measured behind.
 */
export const runBenchmark = async (deps: BenchmarkDeps): Promise<BenchmarkOutcome> => {
    const { benchmark } = deps;

    if (benchmark.queries.length === 0 || benchmark.thresholds.latencyLimit <= 0 || deps.timedPasses < 1) {
        throw new BenchmarkInputError(
            'protocol_unusable',
            'The query set declares no queries, a non-positive latency limit, or fewer than one timed pass, so ' +
                'there is nothing this run could measure.',
            [
                `queries=${benchmark.queries.length}`,
                `latencyLimit=${benchmark.thresholds.latencyLimit}`,
                `timedPasses=${deps.timedPasses}`,
            ],
        );
    }

    const publishedFoods = await deps.db.catalog_foods.count({ where: { publication_status: 'published' } });
    if (publishedFoods === 0) {
        throw new BenchmarkInputError(
            'catalog_empty',
            'The database this command addressed holds no published catalog foods, so every query would return ' +
                'nothing and the resulting figures would describe an empty corpus. Load the release first with ' +
                `\`npm run catalog:load -- --release ${deps.releaseVersion}\`.`,
            ['publishedFoods=0'],
        );
    }

    const expectations = await resolveExpectations(deps.db, benchmark.queries);
    deps.logger.info('expectations_resolved', {
        stage: STAGE,
        expectations: expectations.expectationCount,
        distinctSourceKeys: expectations.idBySourceKey.size,
        publishedFoods,
    });

    for (let pass = 1; pass <= benchmark.protocol.warmupPasses; pass += 1) {
        await runPass(deps, expectations, false);
        deps.logger.info('warmup_pass_completed', { stage: STAGE, pass, timed: false });
    }

    const latencies: number[] = [];
    const passObservations: Array<Map<string, PassObservation>> = [];
    for (let pass = 1; pass <= deps.timedPasses; pass += 1) {
        const outcome = await runPass(deps, expectations, true);
        latencies.push(...outcome.latencies);
        passObservations.push(outcome.observations);
        deps.logger.info('timed_pass_completed', {
            stage: STAGE,
            pass,
            timed: true,
            samples: outcome.latencies.length,
        });
    }

    const results: QueryResult[] = [];
    for (const query of benchmark.queries) {
        const expectedIds = expectations.idsByQueryId.get(query.id) ?? [];
        const observations = passObservations.map((pass) => pass.get(query.id) as PassObservation);
        const first = observations[0];
        const stable = observations.every(
            (observation) =>
                observation.rank === first.rank && observation.matchSetTotal === first.matchSetTotal,
        );

        let rankInFullResultSet = first.rank;
        let matchedId = first.matchedId;
        if (first.rank === null && first.matchSetTotal > 0) {
            const located = await locateInFullResultSet(deps, query, expectedIds, first.matchSetTotal);
            rankInFullResultSet = located.position;
            matchedId = located.matchedId;
        }

        const sourceKeyOf = (id: string | null): string | null => {
            if (id === null) {
                return null;
            }
            for (const sourceKey of query.expected) {
                if (expectations.idBySourceKey.get(sourceKey) === id) {
                    return sourceKey;
                }
            }
            return null;
        };

        const outcome: QueryOutcome =
            first.matchSetTotal === 0
                ? 'zero_results'
                : first.rank === null
                  ? rankInFullResultSet === null
                      ? 'not_retrieved'
                      : 'beyond_measured_page'
                  : first.rank <= 3
                    ? 'top3'
                    : first.rank <= 10
                      ? 'top10'
                      : 'in_measured_page';

        results.push({
            id: query.id,
            q: query.q,
            kind: query.kind,
            expectedSourceKeys: query.expected,
            // Only a food that placed inside the measured page counts as the
            // match; the deeper scan answers "where", not "did it place".
            matchedSourceKey: first.rank === null ? null : sourceKeyOf(matchedId),
            rank: first.rank,
            rankInFullResultSet,
            matchSetTotal: first.matchSetTotal,
            outcome,
            rankStableAcrossPasses: stable,
        });
    }

    // Deterministic order, so a diff between two reports means the measurement
    // changed rather than the iteration order.
    results.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

    // After the timed passes, never interleaved with them: these calls must not
    // land in a latency sample.
    const pagination = await runPaginationCheck(deps);
    const conditions = await captureConditions(deps);

    const rollups = rollUp(results, deps.timedPasses);
    const latency = summarizeLatency(latencies, benchmark.thresholds.latencyLimit, benchmark.protocol.timing);
    const checks = evaluateThresholds(benchmark, rollups, latency);

    const report = buildReport({
        deps,
        conditions,
        results,
        rollups,
        latency,
        checks,
        pagination,
        publishedFoods,
        expectations,
    });

    writeJsonFile(deps.outPath, report);

    return {
        report,
        failures: checks.filter((check) => check.verdict === 'fail'),
        paginationFailed: pagination.outcome === 'fail',
        outPath: deps.outPath,
    };
};

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface BenchmarkPreflightDeps {
    readonly loadSearchBenchmark: () => SearchBenchmark;
    /** Repository-relative existence check, seamed so preflight stays testable. */
    readonly fileExists: (repoRelativePath: string) => boolean;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const readRepoFile = (repoRelativePath: string): string =>
    fs.readFileSync(path.resolve(__dirname, '..', repoRelativePath), 'utf8');

export const preflight = (deps: BenchmarkPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    try {
        deps.loadSearchBenchmark();
    } catch (error) {
        if (error instanceof ManifestError) {
            gaps.push({
                code: 'search_benchmark_unavailable',
                requirement:
                    'data/meal-planning/search-benchmark.v1.json must load and declare its benchmarkVersion: it ' +
                    'is the query set, the expected source_keys, the thresholds and the protocol',
                remedy: 'Restore the benchmark query set at data/meal-planning/search-benchmark.v1.json (AAP §0.7.1 Group 3).',
                detail: `${error.code}: ${error.message}`,
            });
        } else {
            // A permission fault or an unreadable path is an environment
            // problem, not a missing input, so it reaches main's narrowing
            // catch as itself.
            throw error;
        }
    }

    if (!deps.fileExists(CATALOG_SERVICE_MODULE)) {
        gaps.push({
            code: 'catalog_service_absent',
            requirement: `${CATALOG_SERVICE_MODULE} must exist: it is the in-process search this benchmark measures`,
            remedy: `Land ${CATALOG_SERVICE_MODULE} with its integration coverage (AAP §0.7.1 Group 3).`,
        });
    }

    return gaps;
};

// ---------------------------------------------------------------------------
// Reporting and entry point.
// ---------------------------------------------------------------------------

const gapFields = (gaps: readonly PrerequisiteGap[]): LogFields => {
    const fields: LogFields = { stage: STAGE, gapCount: gaps.length };
    for (const gap of gaps) {
        fields[`gap_${gap.code}`] =
            gap.detail === undefined
                ? `${gap.requirement}. ${gap.remedy}`
                : `${gap.requirement}. ${gap.remedy} [${gap.detail}]`;
    }
    return fields;
};

// Every error class this file can observe gets its own reported code; anything
// unrecognised is reported through safeError under `unexpected_error` rather
// than swallowed or printed raw.
const describeFailure = (error: unknown): { code: string; error: { name: string; message: string } } => {
    if (error instanceof DatabaseOriginError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof ManifestError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof BenchmarkInputError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof BenchmarkThresholdError) {
        return { code: 'thresholds_missed', error: safeError(error) };
    }
    return { code: 'unexpected_error', error: safeError(error) };
};

/**
 * Pins the datasource pool to one connection before the client is constructed,
 * which is the only point at which Prisma reads it.
 *
 * The protocol reports `connections: 1`, and sequential calls alone only make
 * that true in practice; pinning the pool makes it true by construction, so a
 * percentile cannot quietly include time spent queueing behind a second
 * connection. `connection_limit` is a pool setting and not one of dbGuard's
 * connection-redirecting parameters, so it cannot move the run to another
 * database — and the guard has already classified the origin by this point
 * regardless.
 */
export const pinPoolToSingleConnection = (env: NodeJS.ProcessEnv): boolean => {
    const databaseUrl = env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
        return false;
    }
    if (/[?&]connection_limit=/.test(databaseUrl)) {
        return false;
    }
    env.DATABASE_URL = `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}connection_limit=1`;
    return true;
};

const main = async (): Promise<number> => {
    const parsed = parseArgs(process.argv.slice(2));

    if (!parsed.ok) {
        for (const failure of parsed.errors) {
            logger.error('argument_rejected', { stage: STAGE, flag: failure.flag, problem: failure.message });
        }
        writeUsage('error');
        return 1;
    }

    if (parsed.options.help) {
        writeUsage('info');
        return 0;
    }

    const origin = classifyDatabaseOrigin(process.env.DATABASE_URL);
    logger.info('database_origin_accepted', {
        stage: STAGE,
        originClass: origin.originClass,
        host: origin.host,
        database: origin.database,
        reason: origin.reason,
    });

    const outPath = resolveOutPath(parsed.options.out);
    logger.info('stage_invoked', {
        stage: STAGE,
        out: outPath,
        benchmarkVersion: parsed.options.benchmarkVersion,
        passes: parsed.options.passes,
    });

    const gaps = preflight({ loadSearchBenchmark, fileExists: repoFileExists });
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    const benchmark = loadSearchBenchmark();
    if (benchmark.benchmarkVersion !== parsed.options.benchmarkVersion) {
        logger.error('benchmark_version_mismatch', {
            stage: STAGE,
            requested: parsed.options.benchmarkVersion,
            declared: benchmark.benchmarkVersion,
            problem:
                'The committed query set declares a different version than --benchmark requested. Running it ' +
                'anyway would file the report under a version it was not measured against.',
        });
        return 1;
    }

    const releaseVersion = benchmark.catalogRelease;
    const releaseManifest = loadReleaseManifest(releaseVersion);

    const singleConnectionPinned = pinPoolToSingleConnection(process.env);

    // Dynamic, and after the guard and the pin: importing either statically
    // would construct the shared PrismaClient — and fix its pool size — before
    // DATABASE_URL had been classified or pinned.
    const { prisma } = await import('../src/prisma/client');
    const { searchPublishedFoods } = await import('../src/services/catalog.service');

    const timedPasses = parsed.options.passes ?? benchmark.protocol.timedPasses;
    if (parsed.options.passes !== null && parsed.options.passes !== benchmark.protocol.timedPasses) {
        logger.warn('protocol_overridden', {
            stage: STAGE,
            contractTimedPasses: benchmark.protocol.timedPasses,
            requestedTimedPasses: parsed.options.passes,
            consequence:
                'The report will record that it deviated from the committed protocol, so it is a diagnostic run.',
        });
    }

    try {
        const outcome = await runBenchmark({
            db: prisma as unknown as BenchmarkDb,
            search: searchPublishedFoods,
            benchmark,
            releaseManifest,
            releaseVersion,
            outPath,
            logger,
            now: () => new Date(),
            hrtime: () => process.hrtime.bigint(),
            timedPasses,
            passesOverridden: parsed.options.passes !== null && parsed.options.passes !== benchmark.protocol.timedPasses,
            singleConnectionPinned,
            readRepoFile,
        });

        logger.info('report_written', {
            stage: STAGE,
            out: outcome.outPath,
            queriesScored: outcome.report.rollups.queriesScored,
            topThreeHitRate: outcome.report.rollups.topThreeHitRate,
            topTenHitRate: outcome.report.rollups.topTenHitRate,
            zeroResultRate: outcome.report.rollups.zeroResultRate,
            p50LatencyMs: outcome.report.latency.p50LatencyMs,
            p95LatencyMs: outcome.report.latency.p95LatencyMs,
            paginationOutcome: outcome.report.paginationCheck.outcome,
        });

        if (outcome.failures.length > 0 || outcome.paginationFailed) {
            // Fail-closed: the artefact is written first so the evidence of the
            // shortfall survives, then the run refuses.
            if (outcome.failures.length > 0) {
                throw new BenchmarkThresholdError(outcome.failures);
            }
            logger.error('stage_failed', {
                stage: STAGE,
                code: 'pagination_invariant_failed',
                out: outcome.outPath,
                duplicateIds: outcome.report.paginationCheck.duplicateIds,
                missingIds: outcome.report.paginationCheck.missingIds,
            });
            return 1;
        }

        logger.info('stage_completed', {
            stage: STAGE,
            verdict: outcome.report.verdict.overall,
            out: outcome.outPath,
        });
        return 0;
    } finally {
        await prisma.$disconnect();
    }
};

// Guarded so importing this module for parseArgs, preflight, runBenchmark or
// describeUsage never runs the stage.
if (require.main === module) {
    main()
        .then((exitCode) => {
            process.exit(exitCode);
        })
        .catch((error: unknown) => {
            const failure = describeFailure(error);
            const fatal = createFatalLogger(STAGE);
            fatal.error('stage_failed', {
                stage: STAGE,
                code: failure.code,
                error: failure.error,
            });
            if (error instanceof BenchmarkThresholdError) {
                for (const missed of error.failures) {
                    fatal.error('threshold_missed', {
                        stage: STAGE,
                        metric: missed.contractKey,
                        measured: missed.measured,
                        bound: missed.bound,
                        comparison: missed.comparison,
                        measuredAsCount: missed.measuredAsCount,
                    });
                }
            }
            if (error instanceof BenchmarkInputError && error.detail.length > 0) {
                fatal.error('input_detail', {
                    stage: STAGE,
                    code: error.code,
                    items: error.detail.slice(0, 25),
                    itemCount: error.detail.length,
                });
            }
            process.exit(1);
        });
}

