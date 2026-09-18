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
// BECAUSE THE REPORT IS CITED BY PEOPLE WHO NEVER READ THIS FILE, five further
// rules hold, each of them fail-closed and each of them documented where it is
// implemented:
//
//   * THE RUN IS BOUND TO THE ACTIVE RELEASE. The database's active-release
//     pointer must name the release the query set declares, and every count the
//     release manifest states must equal what the database holds, counted the
//     way catalog-load.ts counts them. A disagreement refuses the run
//     (bindRunToActiveRelease) — a report that attributed its figures to a
//     release it did not measure is the one error nobody downstream can detect.
//   * THE CORPUS CANNOT MOVE UNDER THE RUN. main() holds the catalog graph's
//     SHARED stage lock for the whole measurement, and the pointer and the
//     counts are read again afterwards; if either moved, the run refuses and
//     writes NOTHING (reverifyCorpus), because a report assembled across two
//     committed catalog states describes a corpus that never existed.
//   * ACCEPTANCE STANDING IS DERIVED, NEVER DECLARED. A run that overrode the
//     protocol, could not verify its connection limit, or held no stage lock is
//     recorded as diagnostic_only (protocolDeviations) and refuses to write the
//     default artefact path at all.
//   * THRESHOLDS ARE COMPARED EXACTLY AND ROUNDED ONLY FOR DISPLAY, so a rate
//     that rounds onto its bound from the wrong side fails (rateAtLeast).
//   * STRUCTURAL INVARIANTS FAIL THE RUN. Paging that repeats or drops an id, a
//     rank that moves between timed passes, and a second database that
//     reproduces different ranks or page sequences each set the verdict to fail
//     and exit non-zero (collectInvariantFailures) — after the report is
//     written, so the evidence of the failure survives.
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

import { boundedModelText } from './lib/catalogFoodFacts';
import { CATALOG_STAGE_LOCK_MODES, CheckpointError, checkpointErrorFields, getActiveReleaseLoad, withCatalogStageLock } from './lib/checkpoint';
import type { CatalogStageLockMode, CatalogStageName } from './lib/checkpoint';
import { classifyDatabaseOrigin, DatabaseOriginError, originLogFields } from './lib/dbGuard';
import {
    createFatalLogger,
    createLogger,
    formatSafeError,
    isThrownInstanceOf,
    opaqueDigest,
    safeError,
    writeLineSync,
} from './lib/logger';
import type { LogFields, LogLevel, SafeErrorFields, ScriptLogger } from './lib/logger';
import {
    EXPECTED_SEARCH_BENCHMARK_VERSION,
    ManifestError,
    assertSafeArtifactParent,
    loadReleaseManifest,
    loadSearchBenchmark,
    physicalPathIdentity,
    releaseFilePath,
    reportPath,
    writeJsonFile,
} from './lib/manifest';
import type {
    CatalogReleaseCounts,
    CatalogReleaseManifest,
    SearchBenchmark,
    SearchBenchmarkQuery,
} from './lib/manifest';

// The `q` RULE, not a copy of it. `assertSearchBenchmarkShape` has to answer
// "would the search layer accept this query", and the only honest way to answer
// it is to ask the parser that decides for `GET /catalog/foods`: a benchmark
// query the service would refuse cannot be measured, and a second length or
// control-character rule written here would be free to drift from the one the
// requests are held to (Rule backend-architecture §1.2/§7 — one authority per
// rule). Pure and inert on import: `catalog.logic.ts` reaches only `src/types`
// and `src/utils`, so nothing here constructs a Prisma client or reads the
// environment ahead of dbGuard.
import { MAX_SEARCH_QUERY_LENGTH, MIN_SEARCH_QUERY_LENGTH, parseCatalogSearchQuery } from '../src/services/catalog.logic';

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
 * The catalog stage this run contends as, and the mode it takes the graph lock
 * in. Declared in `scripts/lib/checkpoint.ts` — named here as constants so the
 * report states the lock it actually took rather than a string written twice.
 */
const BENCHMARK_STAGE_LOCK_NAME: CatalogStageName = 'benchmark';

const BENCHMARK_STAGE_LOCK_MODE: CatalogStageLockMode = CATALOG_STAGE_LOCK_MODES[BENCHMARK_STAGE_LOCK_NAME];

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

/**
 * The fixed-point scale every rate threshold is COMPARED at, as opposed to the
 * three decimals it is reported at.
 *
 * Rounding a rate and then comparing the rounded figure lets a raw rate that
 * sits outside its bound round onto it and pass: two of three queries is
 * 0.6666…, which rounds to 0.667 and clears a bound of 0.6667 that it does not
 * meet. A bound stated to at most six decimal places has an exact integer
 * numerator at this scale, so `count * RATE_SCALE ⋛ numerator * total` settles
 * the comparison over integers, with no division and no rounding anywhere in
 * it. Both products stay far inside Number.MAX_SAFE_INTEGER for any query set
 * this benchmark could run — a million times the largest count against a
 * million times the largest total is still under 10^12.
 */
const RATE_SCALE = 1_000_000;

/**
 * How many individual items a report block or a refusal names before it falls
 * back to a count.
 *
 * Naming every unstable query in a 426-query set is not more actionable than
 * naming the first twenty-five beside the total, and an uncapped list would
 * turn one log line or one error message into thousands of characters.
 */
const MAX_NAMED_ITEMS = 25;

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
    /** The rounded display figure, at the contract's own number of decimals. */
    readonly measured: number;
    /**
     * The value the verdict was actually decided from: the unrounded ratio for
     * a rate, the unrounded millisecond sample for a percentile. Recorded
     * beside `measured` because the two differ exactly in the case that
     * matters — a measurement that rounds onto its bound from the wrong side.
     */
    readonly measuredExact: number;
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
    | 'portable_ids_unresolved'
    | 'condition_unreadable'
    | 'catalog_empty'
    | 'release_not_loaded'
    | 'release_mismatch'
    | 'release_counts_disagree'
    | 'corpus_moved_during_run'
    | 'diagnostic_run_to_acceptance_path'
    // The artefact's own name is not a name this run may publish to: an entry
    // is already there and it is a symbolic link, a directory, or something
    // whose kind could not be read. Distinct from the two codes below and from
    // the acceptance-path refusal, because the remedy is to correct `--out`.
    | 'output_path_name_unsafe'
    // The write target stopped being the place this run verified: the resolved
    // output directory was replaced, moved or made unreadable, or a symbolic
    // link appeared at the artefact's name, at some point during the
    // measurement. Deliberately separate from
    // `diagnostic_run_to_acceptance_path` so an operator can tell "you aimed at
    // the acceptance artefact" apart from "something moved underneath you".
    | 'output_path_identity_changed'
    | 'compare_report_unreadable'
    | 'compare_report_mismatched_contract'
    | 'compare_report_same_database'
    | 'compare_report_identity_unverifiable'
    | 'compare_report_not_protocol_eligible'
    | 'protocol_unusable'
    // The committed query set does not honour the shape this stage measures
    // against. Distinct from `protocol_unusable`, which is a query set this
    // stage understands and cannot measure anything with (no queries, no
    // latency limit): this one is a document whose fields are not what the
    // declared type says they are, so nothing about it can be trusted yet.
    | 'query_set_invalid';

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
    /**
     * `--compare-with`; a report from a second, independently loaded database
     * to compare this run's ranks and page sequences against. `null` means no
     * comparison, which is what a single run can say.
     */
    readonly compareWith: string | null;
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
                compareWith: null,
            },
        };
    }

    const errors: ArgumentError[] = [];
    let benchmarkVersion = EXPECTED_SEARCH_BENCHMARK_VERSION;
    let benchmarkSeen = false;
    let out: string | null = null;
    let outSeen = false;
    let passes: number | null = null;
    let compareWith: string | null = null;
    let compareWithSeen = false;

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

        if (flag === '--compare-with') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({
                    flag,
                    message:
                        `${flag} requires the path of a benchmark report from a second, independently loaded ` +
                        'database',
                });
                continue;
            }
            if (compareWithSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            compareWithSeen = true;
            compareWith = value;
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

    return { ok: true, options: { help: false, benchmarkVersion, out, passes, compareWith } };
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
        '                     representative. Two consequences, both enforced: the report',
        '                     records standing diagnostic_only with',
        '                     thisReportIsAcceptanceEvidence false, so it cannot be cited',
        '                     as evidence for the search-quality requirement; and the run',
        '                     REFUSES to write the default artefact path, so a diagnostic',
        '                     cannot overwrite the committed acceptance report. Pass',
        '                     --out <path> with it.',
        '  --compare-with <p> Compare this run against a benchmark report produced',
        '                     against a SECOND, independently loaded database, and',
        '                     record the result in crossDatabaseReproduction. Release',
        '                     determinism is a property of two runs: every rank and',
        '                     every page sequence must be identical (page sequences are',
        '                     compared as portable source_keys, never as database ids)',
        '                     and only the latency block may differ. A difference fails',
        '                     the run. Three kinds of comparison are refused rather',
        '                     than reported as agreement: one database with itself; a',
        '                     pair whose PostgreSQL identities could not both be read,',
        '                     which establishes neither sameness nor distinctness; and',
        '                     a pair in which either side deviated from the protocol or',
        '                     did not hold its own rank-stability or pagination',
        '                     invariant.',
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
 *
 * This is the path as SPELLED, and a spelling is not an identity: `path.resolve`
 * collapses `..` and leaves every symlink on the path alone, so two spellings of
 * one file compare as two files. Nothing may decide "is this the acceptance
 * artefact?" from this answer — that question is settled against
 * `physicalPathIdentity` inside `runBenchmark`, which is also where the path the
 * bytes go to is fixed, where the directory it names is verified and
 * remembered, and where both are checked again immediately before the write
 * (see the write-target section below).
 */
export const resolveOutPath = (out: string | null): string =>
    out === null ? reportPath(DEFAULT_REPORT_FILE) : path.resolve(__dirname, '..', out);

/**
 * How an output path is NAMED in a log line: package-relative inside this
 * package, its file name alone outside it, and never absolute.
 *
 * WHY THE LOGGED VALUE DIFFERS FROM THE WRITTEN ONE. `resolveOutPath` returns
 * an absolute path because that is what `writeJsonFile` needs, and an absolute
 * path in a structured log line discloses where this checkout lives — the same
 * class of leak the peer-report refusal was carrying (CWE-532), and it reaches
 * the same CI logs. The operator loses nothing: `data/meal-planning/reports/…`
 * is how they refer to the artefact anyway, and it is how the report itself
 * records its own peers.
 *
 * `peerReportLabel` is reused rather than reimplemented. Its name says "peer"
 * because a peer report was its first caller, but its rule — relative inside
 * the package, basename outside — is exactly the rule wanted here, and sharing
 * it means the artefact and the log cannot start naming the same file
 * differently.
 */
const outPathLabel = (absolutePath: string): string =>
    peerReportLabel(absolutePath, path.resolve(__dirname, '..')).label;

// ---------------------------------------------------------------------------
// THE WRITE TARGET'S IDENTITY, AND THE WINDOW THIS STAGE CANNOT HOLD A
// DESCRIPTOR ACROSS.
//
// Resolving `--out` to one physical path closes the alias an operator (or an
// attacker) spelled, but it does not close the MINUTES between that resolution
// and the write: a benchmark run resolves its output path, then takes a warm-up
// pass, three timed passes, a pagination check and a corpus re-verification,
// and only then publishes. A resolved path stops traversing a symbolic link
// only for as long as the directory it names is still the directory that was
// checked, so a principal who can write the resolved directory's PARENT can
// rename that directory aside mid-run and put a link to
// data/meal-planning/reports/latest in its place — after which a diagnostic
// report lands on the §0.9.3 acceptance evidence (CWE-59/CWE-367).
//
// WHY REVALIDATION RATHER THAN A HELD CAPABILITY. The construction that would
// remove the window is to open the output directory once and publish through a
// descriptor-relative call, so the name is never resolved a second time. Node
// exposes no such call — `fs` has no `openat`/`renameat`/`mkdirat`, and every
// write primitive, `fs.promises.open` included, takes a path — so the strongest
// instrument available here is to verify the parent, remember WHICH directory
// it was, and re-observe the same facts immediately before the write, refusing
// if they moved. What is left is the few microseconds between that last
// observation and the rename, instead of the whole measurement.
//
// The decision itself is pure (Rule backend-architecture §1.2/§7): the caller
// supplies two observations and the predicate names every way they differ, so
// the rule is pinned by `src/__tests__/scripts/search-benchmark.test.ts`
// without a filesystem.
// ---------------------------------------------------------------------------

/**
 * Owner-only, for an output directory this run creates. A directory the stage
 * makes for its own artefact starts private to the operator who ran it, which
 * is also what keeps `assertSafeArtifactParent` from having to refuse it under
 * a permissive `umask`. An existing directory's mode is left exactly as it is.
 */
const OUTPUT_DIRECTORY_MODE = 0o700;

/**
 * What kind of entry sits at the artefact's own name, read with `lstat` so a
 * symbolic link is reported as one instead of as whatever it points at.
 *
 * `absent` is the ordinary first-run case and is publishable; `file` is the
 * ordinary re-run case. Everything else is refused rather than written
 * through.
 */
export type OutputNameKind = 'absent' | 'file' | 'symbolic_link' | 'other' | 'unreadable';

/**
 * One observation of the artefact's write target: which directory it is in,
 * and what is at its name.
 *
 * `parentDevice`/`parentInode` are the identity — they change when the
 * directory at that path is replaced, renamed aside or swapped for a symbolic
 * link, which is exactly the mid-run attack — and `parentIsDirectory` records
 * the swap directly for the sake of the message an operator reads.
 */
export interface OutputPathObservation {
    readonly parentDevice: number;
    readonly parentInode: number;
    readonly parentIsDirectory: boolean;
    readonly nameKind: OutputNameKind;
}

/**
 * Whether the artefact may be published to a name of this kind.
 *
 * Pure and exported because it is half of the symlink rule: a link at the
 * artefact's own name means the name this run was given stands for a file
 * somewhere else, and publishing through it writes wherever the link's owner
 * chose. A directory or an unreadable entry at that name is refused for the
 * same reason the link is — the run cannot say what it would be overwriting.
 */
export const outputNameIsPublishable = (kind: OutputNameKind): boolean =>
    kind === 'absent' || kind === 'file';

/**
 * Every way the write target stopped being the place a run verified — empty
 * when it is still that place.
 *
 * Pure and exported because it is the whole of the post-guard rule (Rule
 * backend-architecture §1.2/§11): the caller takes the two observations, and a
 * test drives every difference with no filesystem at all. A missing `after` is
 * a change rather than an absence of one: a parent that cannot be read after
 * the measurement is a parent this run can no longer prove anything about, and
 * publishing into it would be publishing into the unknown.
 */
export const outputPathIdentityChanges = (
    before: OutputPathObservation,
    after: OutputPathObservation | null,
): readonly string[] => {
    if (after === null) {
        return ['output_parent_unreadable'];
    }

    const changes: string[] = [];
    if (after.parentDevice !== before.parentDevice) {
        changes.push(`parent_device_changed=${before.parentDevice}->${after.parentDevice}`);
    }
    if (after.parentInode !== before.parentInode) {
        changes.push(`parent_inode_changed=${before.parentInode}->${after.parentInode}`);
    }
    if (!after.parentIsDirectory) {
        changes.push('parent_no_longer_a_directory');
    }
    if (!outputNameIsPublishable(after.nameKind)) {
        changes.push(`output_name_not_publishable=${after.nameKind}`);
    }
    return changes;
};

/** `lstat`s one name and classifies it; never follows what it finds. */
const observeNameKind = (absolutePath: string): OutputNameKind => {
    let stats: fs.Stats;
    try {
        stats = fs.lstatSync(absolutePath);
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        // ENOENT and ENOTDIR both mean "nothing is at this name"; anything else
        // (a permission wall on an ancestor, an I/O error) means the kind could
        // not be read, which is not the same statement and is not publishable.
        return code === 'ENOENT' || code === 'ENOTDIR' ? 'absent' : 'unreadable';
    }
    // Order matters: a symbolic link to a file reports `isFile()` false under
    // `lstat`, but asking for the link first keeps that independent of platform.
    if (stats.isSymbolicLink()) {
        return 'symbolic_link';
    }
    return stats.isFile() ? 'file' : 'other';
};

/**
 * Observes the write target, or `null` when its parent cannot be read.
 *
 * `lstat` on the parent rather than `stat`: a parent that has become a symbolic
 * link is the case being detected, and `stat` would report the directory it
 * points at — a different inode than the one captured, but reported as a
 * directory, which loses the reason.
 */
const observeOutputPath = (physicalOutPath: string): OutputPathObservation | null => {
    const parent = path.dirname(physicalOutPath);

    let parentStats: fs.Stats;
    try {
        parentStats = fs.lstatSync(parent);
    } catch {
        return null;
    }

    return {
        parentDevice: parentStats.dev,
        parentInode: parentStats.ino,
        parentIsDirectory: parentStats.isDirectory(),
        nameKind: observeNameKind(physicalOutPath),
    };
};

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
/**
 * A child table counted THROUGH its published parent, which is the only way
 * these counts are comparable with a release manifest: a release carries the
 * published set, so the children a manifest states are the children of
 * published foods, and the rows still hanging off a retired food — which stay
 * in place and referenceable — must be excluded rather than added in.
 *
 * Deliberately the same filter shape `catalog-load.ts::verifyLoadedCounts`
 * counts with. The two have to agree: the loader gates activation on these
 * numbers and this runner gates its evidence on them, and a benchmark that
 * counted differently could contradict the load that produced the corpus.
 */
export interface PublishedChildTable {
    count(args: { where: { catalog_foods: { publication_status: string } } }): Promise<number>;
}

export interface BenchmarkDb {
    $queryRawUnsafe<T = unknown>(query: string): Promise<T>;
    catalog_foods: {
        findMany(args: {
            // Either direction of the portable-identity mapping: expectations
            // arrive as release-stable source_keys and resolve to local ids,
            // while the pagination sequences are collected as local ids and
            // have to be mapped BACK to source_keys before they can be compared
            // with a second database's report.
            where: { source_key: { in: string[] } } | { id: { in: string[] } };
            select: { id: true; source_key: true; publication_status: true };
        }): Promise<Array<{ id: string; source_key: string; publication_status: string }>>;
        count(args: { where: { publication_status: string; nutrition_provenance?: string } }): Promise<number>;
    };
    catalog_food_aliases: PublishedChildTable;
    catalog_food_portions: PublishedChildTable;
    catalog_food_components: PublishedChildTable;
    catalog_validation_records: PublishedChildTable;
}

export interface BenchmarkDeps {
    readonly db: BenchmarkDb;
    readonly search: SearchFn;
    /**
     * The database's active-release pointer: the newest SUCCEEDED
     * `release_load` run, which is the same pointer `GET /catalog/status`
     * reports. Seamed rather than queried here so the binding can be driven
     * with no database, and wired in `main` to
     * `checkpoint.ts::getActiveReleaseLoad` so there is exactly one
     * implementation of the convention in the scripts.
     */
    readonly readActiveRelease: () => Promise<ActiveReleasePointer | null>;
    readonly benchmark: SearchBenchmark;
    readonly releaseManifest: CatalogReleaseManifest;
    readonly releaseVersion: string;
    /**
     * Absolute path of the report artefact AS THE OPERATOR SPELLED IT (`--out`,
     * or the default). The run resolves it to its physical identity once and
     * writes there — see `runBenchmark` — so this value is what log lines and
     * refusals quote back, never what an output decision is taken from.
     */
    readonly outPath: string;
    /**
     * The artefact §0.9.3 cites as the acceptance evidence, which a diagnostic
     * run may not overwrite. `main` wires it to `resolveOutPath(null)`; it is a
     * dep so that the rule can be PROVED — a suite pins it to a temporary file
     * standing in for the committed report, and the test that proves an alias
     * is refused then cannot be the test that destroys the committed report if
     * the refusal ever regresses.
     */
    readonly acceptanceArtifactPath: string;
    readonly logger: ScriptLogger;
    readonly now: () => Date;
    /** Monotonic nanosecond clock; seamed so a driver can supply a fake one. */
    readonly hrtime: () => bigint;
    /** Timed pass count actually used, and whether it deviates from the contract. */
    readonly timedPasses: number;
    readonly passesOverridden: boolean;
    /** What the datasource pool limit actually is — see `pinPoolToSingleConnection`. */
    readonly poolPin: PoolPinOutcome;
    /**
     * Whether the caller holds the catalog graph's shared stage lock for the
     * whole of this run. A dep rather than something this module takes itself:
     * the lock lives on a plain `pg` connection opened from the UNPINNED
     * DATABASE_URL and is held around the run by `main`, and a caller driving
     * `runBenchmark` without one produces a diagnostic report rather than a
     * silently unprotected acceptance claim.
     */
    readonly stageLockHeld: boolean;
    /**
     * A report from a second, independently loaded database to compare this
     * run against (`--compare-with`), already read and digested by the caller;
     * `null` when the flag was not given. Its bytes are read outside this
     * module so the comparison itself stays a pure decision over values.
     */
    readonly peerReport: PeerReportSource | null;
    /** Reads a repository file as UTF-8, so the ORDER BY read-back stays seamed. */
    readonly readRepoFile: (repoRelativePath: string) => string;
}

// ---------------------------------------------------------------------------
// Acceptance standing.
//
// This report is cited as the acceptance evidence for the §0.9.3 search-quality
// requirement by people who never open this file, and the CLI can be told to
// deviate from the committed protocol for diagnosis. Those two facts together
// are why standing is DERIVED rather than declared: a one-pass run, a run whose
// connection count could not be verified, and a run that held no corpus lock
// each measure something real, but none of them is the protocol the requirement
// is stated against, and a literal `true` in the report cannot tell them apart.
//
// A run with no deviations is acceptance-eligible. Any deviation makes the
// report diagnostic — still a real measurement, still written, but not citable
// as evidence that catalog search meets its bar.
// ---------------------------------------------------------------------------

/**
 * What a report may be used for, which is a different question from whether the
 * search met its bounds: a diagnostic run can pass every threshold and still
 * not be the committed protocol, and a run of the committed protocol can fail
 * one and still be the evidence of that failure.
 */
export type AcceptanceStanding = 'acceptance_evidence' | 'diagnostic_only';

/** One way a run differed from the committed protocol. */
export interface ProtocolDeviation {
    readonly code: string;
    readonly detail: string;
}

/** The committed protocol's fields this decision reads, and what the run did. */
export interface ProtocolDeviationInput {
    readonly contract: {
        readonly warmupPasses: number;
        readonly timedPasses: number;
        readonly connections: number;
    };
    readonly timedPasses: number;
    readonly poolPin: PoolPinOutcome;
    readonly stageLockHeld: boolean;
}

/**
 * Every deviation from the committed protocol, one entry per deviation.
 *
 * Pure and exported because it is the whole of the acceptance-standing rule:
 * an empty result is what lets a report call itself acceptance evidence, so
 * the conditions belong in a function a test can enumerate rather than in a
 * chain of `if`s inside the report builder.
 */
export const protocolDeviations = (input: ProtocolDeviationInput): readonly ProtocolDeviation[] => {
    const deviations: ProtocolDeviation[] = [];

    if (input.timedPasses !== input.contract.timedPasses) {
        deviations.push({
            code: 'timed_passes_overridden',
            detail:
                `The committed protocol is ${input.contract.warmupPasses} untimed warm-up pass followed by ` +
                `${input.contract.timedPasses} timed passes; this run took ${input.timedPasses}. One pass cannot ` +
                'separate a cold cache from the steady state and two cannot show whether the second was ' +
                'representative, which is why the count is part of the contract rather than an option.',
        });
    }

    if (input.poolPin.effectiveConnectionLimit === null) {
        deviations.push({
            code: 'connection_limit_unverified',
            detail:
                'The datasource pool limit could not be read back, so this run cannot state the number of ' +
                `connections the contract asks it to measure under (${input.contract.connections}). ` +
                input.poolPin.note,
        });
    } else if (input.poolPin.effectiveConnectionLimit !== input.contract.connections) {
        deviations.push({
            code: 'connection_limit_mismatch',
            detail:
                `The contract measures on ${input.contract.connections} connection(s); this run's datasource pool ` +
                `allowed ${input.poolPin.effectiveConnectionLimit}. A percentile taken with a wider pool can ` +
                'include time spent queueing behind another connection, so it is not the figure the latency ' +
                'threshold is stated for.',
        });
    }

    if (!input.stageLockHeld) {
        deviations.push({
            code: 'stage_lock_not_held',
            detail:
                "The catalog graph's shared stage lock was not held for this run, so nothing prevented a " +
                'concurrent import, generation, validation or release load from changing the corpus between one ' +
                'query and the next. A report assembled across two committed catalog states describes a corpus ' +
                'that never existed as a whole.',
        });
    }

    return deviations;
};

// ---------------------------------------------------------------------------
// Arithmetic. Small and inline on purpose: Rule backend-architecture §7.1
// forbids manufacturing a logic module for expressions a test would only
// restate, and the prompt for this file forbids adding one to this folder.
// ---------------------------------------------------------------------------

const roundTo = (value: number, decimals: number): number => {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
};

/** The exact ratio, for a threshold comparison; `rateOf` is its display form. */
const exactRateOf = (count: number, total: number): number => (total === 0 ? 0 : count / total);

const rateOf = (count: number, total: number): number => roundTo(exactRateOf(count, total), RATE_DECIMALS);

/**
 * The bound as an exact integer numerator at RATE_SCALE.
 *
 * `Math.round` rather than a truncation: the multiplication of a decimal
 * literal by a power of ten is not exact in binary floating point (0.97 *
 * 1e6 is 969999.9999999999), and rounding recovers the integer the literal
 * denotes. Any bound with at most six decimal places is represented exactly.
 */
const rateNumeratorOf = (bound: number): number => Math.round(bound * RATE_SCALE);

/**
 * Whether a count over a total meets a floor, decided exactly.
 *
 * `count / total >= bound` becomes `count * RATE_SCALE >= numerator * total`,
 * which is a comparison of two integers: no division, so no representation
 * error, and no rounding, so a rate that would round ONTO the bound from below
 * fails as it should. The empty-total case reads as a rate of zero, which is
 * what the report records for it.
 */
export const rateAtLeast = (count: number, total: number, bound: number): boolean =>
    total === 0 ? bound <= 0 : count * RATE_SCALE >= rateNumeratorOf(bound) * total;

/** The ceiling form of `rateAtLeast`, for a bound a rate must not exceed. */
export const rateAtMost = (count: number, total: number, bound: number): boolean =>
    total === 0 ? bound >= 0 : count * RATE_SCALE <= rateNumeratorOf(bound) * total;

/**
 * Nearest-rank percentile over the sorted sample set — the definition the
 * report names, so a reader can reproduce the figure from the samples rather
 * than having to guess between interpolation conventions.
 *
 * Returns the RAW sample. Rounding here would have made the returned value
 * both the reported figure and the compared one, and a latency 0.0004 ms over
 * its bound rounds to three decimals onto the bound and passes. Callers round
 * for display and compare the value this returns.
 */
const percentileOf = (sortedAscending: readonly number[], percentile: number): number => {
    if (sortedAscending.length === 0) {
        return 0;
    }
    const ordinal = Math.ceil((percentile / 100) * sortedAscending.length);
    const index = Math.min(Math.max(ordinal, 1), sortedAscending.length) - 1;
    return sortedAscending[index];
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
// The corpus this run is bound to.
//
// A benchmark report names a release, and a reader takes that name as a
// statement about which catalog produced the figures. Nothing in a search
// result can establish it: the queries would run — and score — against a
// half-loaded catalog, a different release, or one loaded from an artefact
// nobody reviewed, and the report would carry release v1 on its face either
// way. So the run BINDS itself to the release first, from the two facts that
// can carry that claim, and refuses when either disagrees:
//
//   * the active-release pointer, which is the newest succeeded `release_load`
//     run and the same pointer GET /catalog/status serves, must NAME the
//     release the query set declares; and
//   * every count the release manifest states must equal what the database
//     holds, counted with `catalog-load.ts::verifyLoadedCounts`'s own
//     semantics, because a matching pointer over a partially applied load
//     would otherwise pass.
//
// A disagreement REFUSES the run rather than being noted in the report. The
// figures from a corpus that is not the named release are not a weaker form of
// evidence for that release; they are evidence about something else.
// ---------------------------------------------------------------------------

/** The active-release pointer, in the shape `getActiveReleaseLoad` returns it. */
export interface ActiveReleasePointer {
    readonly releaseId: string;
    readonly loadedAt: Date;
    readonly runId: string;
}

/** One manifest count against the live one, in the shape the report records it. */
export interface CorpusCountCheck {
    readonly name: string;
    readonly expected: number;
    readonly observed: number;
    readonly ok: boolean;
}

/** The six live counts, named as this file names them rather than as the manifest does. */
export interface CorpusCounts {
    readonly publishedFoods: number;
    readonly aliases: number;
    readonly portions: number;
    readonly components: number;
    readonly validationRecords: number;
    readonly publishedIngredientDerived: number;
}

/**
 * Reads the six counts a release manifest states, with the relation filters
 * `catalog-load.ts::verifyLoadedCounts` uses.
 *
 * Sequential rather than concurrent, deliberately: the whole run is sequential
 * on one connection so a latency percentile describes the query, and six
 * parallel counts would be the one place that quietly opened a second.
 */
export const readCorpusCounts = async (db: BenchmarkDb): Promise<CorpusCounts> => {
    const publishedParent = { catalog_foods: { publication_status: 'published' } };

    return {
        publishedFoods: await db.catalog_foods.count({ where: { publication_status: 'published' } }),
        aliases: await db.catalog_food_aliases.count({ where: publishedParent }),
        portions: await db.catalog_food_portions.count({ where: publishedParent }),
        components: await db.catalog_food_components.count({ where: publishedParent }),
        validationRecords: await db.catalog_validation_records.count({ where: publishedParent }),
        // A published food whose nutrition is derived from a composition. It
        // sits beside `components` because it is what makes that count
        // readable: `components: 0` is correct exactly when no published food
        // derives its nutrition, and indistinguishable on its own from a
        // components export that dropped every row.
        publishedIngredientDerived: await db.catalog_foods.count({
            where: { publication_status: 'published', nutrition_provenance: 'ingredient_derived' },
        }),
    };
};

/**
 * The manifest's counts against the live ones, one check per count.
 *
 * `published_ingredient_derived` is checked only when the manifest carries it,
 * because it is optional in the release format: a manifest written before the
 * field existed states nothing about it, and comparing against an absent value
 * would refuse a release for a count it never claimed.
 */
export const compareCorpusCounts = (
    expected: CatalogReleaseCounts,
    observed: CorpusCounts,
): readonly CorpusCountCheck[] => {
    const checks: CorpusCountCheck[] = [
        {
            // `published_foods` under the name the release format uses, falling
            // back to `foods`: a release exports published foods only, so the
            // two are the same measurement.
            name: 'published_foods',
            expected: expected.published_foods ?? expected.foods,
            observed: observed.publishedFoods,
        },
        { name: 'aliases', expected: expected.aliases, observed: observed.aliases },
        { name: 'portions', expected: expected.portions, observed: observed.portions },
        { name: 'components', expected: expected.components, observed: observed.components },
        { name: 'validation_records', expected: expected.validation_records, observed: observed.validationRecords },
    ].map((check) => ({ ...check, ok: check.expected === check.observed }));

    if (expected.published_ingredient_derived !== undefined) {
        checks.push({
            name: 'published_ingredient_derived',
            expected: expected.published_ingredient_derived,
            observed: observed.publishedIngredientDerived,
            ok: expected.published_ingredient_derived === observed.publishedIngredientDerived,
        });
    }

    return checks;
};

/**
 * Everything that changed about the corpus between two readings of it, as
 * operator-readable lines. Empty means the corpus the report describes is the
 * corpus every one of its figures was measured against.
 *
 * Pure and exported because it is the decision behind a refusal that throws
 * away a complete set of measurements, which is exactly the kind of rule that
 * has to be pinned by a test rather than trusted.
 */
export const corpusMovement = (
    before: { readonly pointer: ActiveReleasePointer; readonly counts: CorpusCounts },
    after: { readonly pointer: ActiveReleasePointer | null; readonly counts: CorpusCounts },
): readonly string[] => {
    const moved: string[] = [];

    if (after.pointer === null) {
        moved.push(
            `activeRelease disappeared during the run (was ${before.pointer.releaseId} loaded by run ` +
                `${before.pointer.runId})`,
        );
    } else {
        if (after.pointer.releaseId !== before.pointer.releaseId) {
            moved.push(`activeRelease.releaseId ${before.pointer.releaseId} -> ${after.pointer.releaseId}`);
        }
        // The run id moves when the SAME release is loaded again, which
        // re-applies every row: the release id alone cannot see that, and a
        // reload concurrent with the passes is precisely the event this check
        // exists for.
        if (after.pointer.runId !== before.pointer.runId) {
            moved.push(`activeRelease.runId ${before.pointer.runId} -> ${after.pointer.runId}`);
        }
    }

    const countNames = Object.keys(before.counts) as ReadonlyArray<keyof CorpusCounts>;
    for (const name of countNames) {
        if (before.counts[name] !== after.counts[name]) {
            moved.push(`counts.${name} ${before.counts[name]} -> ${after.counts[name]}`);
        }
    }

    return moved;
};

/**
 * Re-reads the corpus after the measurement and refuses if it moved.
 *
 * The stage lock makes a concurrent mutator improbable; this makes a moved
 * corpus IMPOSSIBLE TO PUBLISH. A session advisory lock lives on its
 * connection, so a dropped connection releases it with nobody informed, and a
 * caller driving `runBenchmark` directly may hold no lock at all. Reading the
 * pointer and the counts a second time costs one round trip each and turns
 * "nothing should have changed" into "nothing did".
 *
 * It throws BEFORE the report is written, and that is the one place this file
 * departs from writing the artefact first: a missed threshold is a real
 * measurement of a real corpus and its evidence must survive, while a report
 * assembled across two committed catalog states describes a corpus that never
 * existed as a whole. There is nothing for such a file to be evidence of.
 */
const reverifyCorpus = async (
    deps: BenchmarkDeps,
    atStart: { readonly pointer: ActiveReleasePointer; readonly counts: CorpusCounts },
): Promise<{ readonly pointer: ActiveReleasePointer; readonly counts: CorpusCounts }> => {
    const pointer = await deps.readActiveRelease();
    const counts = await readCorpusCounts(deps.db);
    const moved = corpusMovement(atStart, { pointer, counts });

    if (moved.length > 0 || pointer === null) {
        throw new BenchmarkInputError(
            'corpus_moved_during_run',
            'The catalog changed while this run was measuring it, so the figures were taken against more than one ' +
                'committed catalog state and no single corpus they all describe exists. NO REPORT WAS WRITTEN: ' +
                'unlike a missed threshold, this is not a measurement to keep evidence of. Re-run once the stage ' +
                'that is changing the catalog has finished — the shared stage lock this command holds normally ' +
                'prevents it, so a run reaching here was either not holding one or lost its lock connection.',
            moved.length > 0 ? moved : ['activeRelease could not be read back after the run'],
        );
    }

    deps.logger.info('corpus_reverified', {
        stage: STAGE,
        release: pointer.releaseId,
        releaseLoadRunId: pointer.runId,
        publishedFoods: counts.publishedFoods,
    });

    return { pointer, counts };
};

/**
 * Binds the run to the active release, or refuses it.
 *
 * Runs before the warm-up pass, so a run that cannot honestly attribute its
 * figures spends no time measuring them. Each refusal carries its own code
 * because the three mean different things to the operator: nothing is loaded,
 * something else is loaded, or the right release is partially loaded.
 */
const bindRunToActiveRelease = async (
    deps: BenchmarkDeps,
): Promise<{
    readonly pointer: ActiveReleasePointer;
    readonly counts: CorpusCounts;
    readonly countChecks: readonly CorpusCountCheck[];
}> => {
    const contractRelease = deps.benchmark.catalogRelease;
    const pointer = await deps.readActiveRelease();

    if (pointer === null) {
        throw new BenchmarkInputError(
            'release_not_loaded',
            'No succeeded release_load run exists in the database this command addressed, so it holds no active ' +
                `catalog release and nothing here could be attributed to release ${contractRelease}. Load it with ` +
                `\`npm run catalog:load -- --release ${contractRelease}\` and re-run.`,
            [`expectedRelease=${contractRelease}`],
        );
    }

    if (pointer.releaseId !== contractRelease) {
        throw new BenchmarkInputError(
            'release_mismatch',
            `The active catalog release is ${pointer.releaseId}, but the query set is written against ` +
                `${contractRelease}. Measuring one release and filing the report under another is the one error ` +
                'this report cannot be read around, so the run refuses rather than recording the release it was ' +
                'told about instead of the one it measured.',
            [`activeRelease=${pointer.releaseId}`, `expectedRelease=${contractRelease}`, `runId=${pointer.runId}`],
        );
    }

    const counts = await readCorpusCounts(deps.db);

    if (counts.publishedFoods === 0) {
        throw new BenchmarkInputError(
            'catalog_empty',
            'The database this command addressed holds no published catalog foods, so every query would return ' +
                'nothing and the resulting figures would describe an empty corpus. Load the release first with ' +
                `\`npm run catalog:load -- --release ${deps.releaseVersion}\`.`,
            ['publishedFoods=0'],
        );
    }

    const countChecks = compareCorpusCounts(deps.releaseManifest.counts, counts);
    const disagreeing = countChecks.filter((check) => !check.ok);

    if (disagreeing.length > 0) {
        throw new BenchmarkInputError(
            'release_counts_disagree',
            `${disagreeing.length} of ${countChecks.length} release counts disagree with what the database holds, ` +
                `so the corpus is not release ${contractRelease} as the manifest states it — a partially applied ` +
                'load, or a graph something else has changed since. Re-run ' +
                `\`npm run catalog:load -- --release ${contractRelease}\` and re-run this benchmark.`,
            disagreeing.map((check) => `${check.name} expected=${check.expected} observed=${check.observed}`),
        );
    }

    deps.logger.info('release_bound', {
        stage: STAGE,
        release: pointer.releaseId,
        releaseLoadRunId: pointer.runId,
        loadedAt: pointer.loadedAt.toISOString(),
        publishedFoods: counts.publishedFoods,
        countChecks: countChecks.length,
    });

    return { pointer, counts, countChecks };
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
        /**
         * The pool limit this run actually had, read back from the datasource
         * rather than restated from the contract. It falls back to the
         * contract's figure only when nothing could be read, and
         * `connectionsVerified` is what says which of the two this is.
         */
        readonly connections: number;
        readonly connectionsVerified: boolean;
        readonly connectionLimitSource: 'pinned_by_run' | 'preexisting_in_database_url' | 'unverified';
        readonly timing: string;
        readonly measuredUnit: string;
        readonly statement: string;
    };
    readonly corpusStability: CorpusStability;
    readonly databaseIdentity: DatabaseIdentity;
    readonly orderingCollation: OrderingCollation;
    readonly databaseDefaultCollation: string;
}

/**
 * A NON-IDENTIFYING fingerprint of the database this run read, and the one
 * condition that makes "a second, independently loaded database" checkable
 * rather than asserted: a cross-database comparison is only evidence when the
 * two reports describe two databases, and nothing else in either report could
 * show that.
 *
 * Both values are opaque server-side numbers — the oid PostgreSQL assigned the
 * database in its own catalog, and the cluster's `system_identifier`. Neither
 * carries a name, a host, a port, a user or any part of a connection string,
 * and none of those may ever enter this report; §0.9.3's conditions are
 * machine characteristics, not host identity.
 */
export interface DatabaseIdentity {
    readonly databaseOid: number | null;
    readonly systemIdentifier: string | null;
    readonly statement: string;
}

/**
 * The evidence that every figure in this report describes ONE committed catalog
 * state: the lock that kept mutators out, and the pointer read before and after
 * the measurement.
 */
export interface CorpusStability {
    readonly stageLock: {
        readonly held: boolean;
        readonly stage: string;
        readonly mode: string;
    };
    readonly activeReleaseAtStart: {
        readonly releaseId: string;
        readonly loadedAt: string;
        readonly runId: string;
    };
    readonly activeReleaseAfterRun: {
        readonly releaseId: string;
        readonly loadedAt: string;
        readonly runId: string;
    };
    /** Always true in a written report: a count that moved refuses the run. */
    readonly countsReverified: true;
    readonly statement: string;
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

/**
 * Which of the three ways the pool limit came to be, so a reader can tell a
 * number this run established from one it merely found.
 */
const connectionLimitSourceOf = (
    poolPin: PoolPinOutcome,
): BenchmarkConditions['warmCacheCondition']['connectionLimitSource'] => {
    if (poolPin.pinned) {
        return 'pinned_by_run';
    }
    return poolPin.preexisting ? 'preexisting_in_database_url' : 'unverified';
};

const describeWarmCache = (deps: BenchmarkDeps): BenchmarkConditions['warmCacheCondition'] => {
    const { protocol } = deps.benchmark;
    const connectionNote =
        'Execution was sequential — one awaited call at a time, so one connection is in use at a time. ' +
        deps.poolPin.note;
    const overrideNote = deps.passesOverridden
        ? ` This run overrode the contract's timedPasses of ${protocol.timedPasses} with ${deps.timedPasses} via ` +
          '--passes, so it is a diagnostic run and not the committed protocol.'
        : '';

    return {
        warmupPasses: protocol.warmupPasses,
        timedPasses: deps.timedPasses,
        sequential: true,
        connections: deps.poolPin.effectiveConnectionLimit ?? protocol.connections,
        connectionsVerified: deps.poolPin.effectiveConnectionLimit !== null,
        connectionLimitSource: connectionLimitSourceOf(deps.poolPin),
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

/**
 * Reads the database's identity TOLERANTLY, which is the opposite of how every
 * other condition here is read, and deliberately so.
 *
 * `pg_control_system()` is restricted to superusers and members of
 * `pg_read_all_stats` on a hardened server, and the database oid is one
 * `pg_database` read away but that catalog can be restricted too. Neither is a
 * condition the contract's `reportedConditions` asks for: they exist so a
 * cross-database comparison can prove the two reports describe two databases.
 * Refusing the whole run because a permission is missing would trade the
 * measurement for the check, so an unreadable value is recorded as null and the
 * statement says which ones were read — and `compareAcrossDatabases` refuses a
 * same-database comparison only on values it actually has.
 */
const readDatabaseIdentity = async (db: BenchmarkDb): Promise<DatabaseIdentity> => {
    const readScalar = async (statement: string): Promise<string | null> => {
        try {
            return firstScalar(await db.$queryRawUnsafe(statement));
        } catch {
            // The value is unavailable, which this block can express. The
            // reason is a server permission rather than anything about the
            // measurement, and surfacing it as a stage failure would refuse a
            // run over a field that is allowed to be absent.
            return null;
        }
    };

    const oidText = await readScalar('SELECT oid FROM pg_database WHERE datname = current_database()');
    const systemIdentifier = await readScalar('SELECT system_identifier FROM pg_control_system()');
    const parsedOid = oidText === null ? Number.NaN : Number(oidText);
    const databaseOid = Number.isFinite(parsedOid) ? parsedOid : null;

    return {
        databaseOid,
        systemIdentifier,
        statement:
            'An opaque fingerprint of the database this run read, recorded so a cross-database comparison can ' +
            'establish that two reports describe two databases rather than one. It carries no name, host, port, ' +
            'user or connection string, and none may ever be added. ' +
            (databaseOid === null
                ? 'The database oid could not be read on this server. '
                : 'The oid is the one PostgreSQL assigned this database in its own catalog. ') +
            (systemIdentifier === null
                ? 'pg_control_system() was not readable — it is restricted to superusers and pg_read_all_stats — ' +
                  'so the cluster identifier is null rather than the run being refused over a condition the ' +
                  'contract does not ask for.'
                : "The system identifier is the cluster's own, from pg_control_system()."),
    };
};

/**
 * The corpus-stability block, from the two readings the run actually took.
 *
 * `countsReverified` is a literal `true` for the same reason
 * `corpus.activeRelease.matchesContract` is: a run whose counts moved throws
 * before anything is written, so a report carrying this field is by
 * construction one whose counts were re-read and agreed.
 */
const describeCorpusStability = (input: {
    readonly stageLockHeld: boolean;
    readonly atStart: ActiveReleasePointer;
    readonly afterRun: ActiveReleasePointer;
    readonly countChecks: number;
}): CorpusStability => ({
    stageLock: {
        held: input.stageLockHeld,
        stage: BENCHMARK_STAGE_LOCK_NAME,
        mode: BENCHMARK_STAGE_LOCK_MODE,
    },
    activeReleaseAtStart: {
        releaseId: input.atStart.releaseId,
        loadedAt: input.atStart.loadedAt.toISOString(),
        runId: input.atStart.runId,
    },
    activeReleaseAfterRun: {
        releaseId: input.afterRun.releaseId,
        loadedAt: input.afterRun.loadedAt.toISOString(),
        runId: input.afterRun.runId,
    },
    countsReverified: true,
    statement:
        (input.stageLockHeld
            ? `This run held the catalog graph's ${BENCHMARK_STAGE_LOCK_MODE} stage lock for its whole lifetime, ` +
              'so no import, generation, validation or release load could change the corpus between one query ' +
              'and the next. '
            : 'This run did NOT hold the catalog stage lock, so nothing prevented a concurrent stage from ' +
              'changing the corpus while it measured — which is why it is recorded as a protocol deviation and ' +
              'this report is diagnostic. ') +
        `In addition, the active-release pointer and all ${input.countChecks} release counts were read again ` +
        'after the timed passes and the pagination check and compared with the readings taken before the ' +
        'warm-up: they agreed, which is what makes every figure here a measurement of one committed catalog ' +
        'state. A disagreement refuses the run and writes no report at all.',
});

export const captureConditions = async (
    deps: BenchmarkDeps,
    corpusStability: CorpusStability,
    // Read before the passes rather than here, because a comparison against a
    // report from the SAME database has to be refused before it costs a
    // measurement — see runBenchmark. Passed in so there is one reading.
    databaseIdentity: DatabaseIdentity,
): Promise<BenchmarkConditions> => ({
    catalogReleaseChecksum: releaseChecksumOf(deps.releaseVersion, deps.releaseManifest),
    // version() rather than SHOW server_version because it carries the exact
    // patch level and the build target in one string, and the patch is what
    // keeps the evidence reproducible.
    postgresVersion: await scalarOrRefuse(deps.db, 'SELECT version()', 'postgresVersion'),
    hostCpu: describeHostCpu(),
    hostMemory: describeHostMemory(),
    sharedBuffers: await scalarOrRefuse(deps.db, 'SHOW shared_buffers', 'sharedBuffers'),
    warmCacheCondition: describeWarmCache(deps),
    corpusStability,
    databaseIdentity,
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
    /**
     * The paged sequence as release-stable `source_key`s, in the order the
     * pages returned them.
     *
     * COUNTS CANNOT BE COMPARED ACROSS DATABASES, and ids are worse than
     * useless: `catalog_foods.id` is generated per database, so two
     * independently loaded copies of one release agree on every page sequence
     * while sharing not one id. The portable keys are what make AAP §0.9.3's
     * "identical page sequences" a checkable claim rather than an assertion.
     */
    readonly pageSourceKeys: readonly string[];
    /** The wide reference fetch's ids as source_keys, same ordering, same reason. */
    readonly referenceSourceKeys: readonly string[];
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
/**
 * Maps local ids to their release-stable `source_key`s, one untimed read per
 * call.
 *
 * Refuses rather than dropping or blanking an id that does not resolve: the
 * portable sequences are what a second database is compared against, and a
 * sequence with a hole in it would compare as a difference in one direction and
 * as agreement in the other. Every id here was returned by the search moments
 * earlier, so an unresolvable one means the row left the published set
 * mid-check — which the corpus re-verification would also catch, but this
 * refusal names the actual id.
 */
const sourceKeysOfIds = async (db: BenchmarkDb, ids: readonly string[]): Promise<ReadonlyMap<string, string>> => {
    const distinct = [...new Set(ids)];
    if (distinct.length === 0) {
        return new Map();
    }

    const rows = await db.catalog_foods.findMany({
        where: { id: { in: distinct } },
        select: { id: true, source_key: true, publication_status: true },
    });

    const keyById = new Map(rows.map((row) => [row.id, row.source_key]));
    const unresolved = distinct.filter((id) => !keyById.has(id));

    if (unresolved.length > 0) {
        throw new BenchmarkInputError(
            'portable_ids_unresolved',
            `${unresolved.length} of ${distinct.length} food ids returned by the search could not be mapped back ` +
                'to a catalog_foods.source_key, so the page sequences this report records could not be written in ' +
                'the portable form a second database is compared against. The rows left the catalog between the ' +
                'search and this read.',
            unresolved.slice(0, MAX_NAMED_ITEMS),
        );
    }

    return keyById;
};

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

        // Untimed and after this query's own pages, so no call of it can land
        // in a latency sample: one read per query rather than one per id.
        const keyById = await sourceKeysOfIds(deps.db, [...pagedIds, ...referenceIds]);

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
            pageSourceKeys: pagedIds.map((pagedId) => keyById.get(pagedId) as string),
            referenceSourceKeys: referenceIds.map((referenceId) => keyById.get(referenceId) as string),
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
    /** The counts the two rates above are the rounded display form of. */
    readonly topThreeHitCount: number;
    readonly topTenHitCount: number;
    readonly beyondMeasuredPage: number;
}

export interface BenchmarkRollups {
    readonly queriesScored: number;
    readonly topThreeHitRate: number;
    readonly topTenHitRate: number;
    /**
     * The integer counts and unrounded ratios the thresholds were actually
     * compared over. The three rates above are rounded to three decimal places
     * because the contract's bounds are stated that way, and a reader who saw
     * only them would reasonably assume the rounded figure was the one tested —
     * it is not, and these fields are what make that checkable.
     */
    readonly topThreeHitCount: number;
    readonly topTenHitCount: number;
    readonly topThreeHitRateExact: number;
    readonly topTenHitRateExact: number;
    readonly zeroResultRateExact: number;
    readonly rateBasis: {
        readonly displayDecimals: number;
        readonly comparisonScale: number;
        readonly statement: string;
    };
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
        const kindTopThree = ofKind.filter((r) => r.rank !== null && r.rank <= 3).length;
        const kindTopTen = ofKind.filter((r) => r.rank !== null && r.rank <= 10).length;
        return {
            kind,
            queries: ofKind.length,
            topThreeHitRate: rateOf(kindTopThree, ofKind.length),
            topTenHitRate: rateOf(kindTopTen, ofKind.length),
            topThreeHitCount: kindTopThree,
            topTenHitCount: kindTopTen,
            beyondMeasuredPage: ofKind.filter((r) => r.outcome === 'beyond_measured_page').length,
        };
    });

    return {
        queriesScored: scored,
        topThreeHitRate: rateOf(topThree, scored),
        topTenHitRate: rateOf(topTen, scored),
        topThreeHitCount: topThree,
        topTenHitCount: topTen,
        topThreeHitRateExact: exactRateOf(topThree, scored),
        topTenHitRateExact: exactRateOf(topTen, scored),
        zeroResultRateExact: exactRateOf(zeroResults, scored),
        rateBasis: {
            displayDecimals: RATE_DECIMALS,
            comparisonScale: RATE_SCALE,
            statement:
                `The rates in this block are rounded to ${RATE_DECIMALS} decimal places FOR DISPLAY, because the ` +
                "contract's bounds are stated that way. No threshold was compared against a rounded figure: each " +
                `rate check compared the integer count against the bound's exact numerator at a scale of ` +
                `${RATE_SCALE} (count * scale against numerator * total), so a rate that would round onto its ` +
                'bound from the wrong side fails rather than passing. The counts and unrounded ratios here are ' +
                'those comparisons\' own inputs.',
        },
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
                      'means the ordering is not total, and it IS raised rather than averaged away: it fails the ' +
                      'run as the rank_unstable_across_timed_passes invariant, the verdict is fail and the command ' +
                      'exits non-zero. diagnostics.rankInstability names the queries that moved.',
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
    /**
     * The unrounded p95 sample, which is the value the threshold was compared
     * against. `p95LatencyMs` above is its display form.
     */
    readonly p95LatencyMsExact: number;
    readonly p99LatencyMs: number;
    readonly minLatencyMs: number;
    readonly maxLatencyMs: number;
    readonly percentileMethod: string;
    readonly contentionCaveat: string;
}

const summarizeLatency = (samples: readonly number[], limit: number, timing: string): LatencySummary => {
    const sorted = [...samples].sort((a, b) => a - b);
    const p95 = percentileOf(sorted, 95);
    return {
        measuredAtLimit: limit,
        timing,
        measuredUnit: MEASURED_UNIT,
        samples: sorted.length,
        p50LatencyMs: roundTo(percentileOf(sorted, 50), LATENCY_DECIMALS),
        p95LatencyMs: roundTo(p95, LATENCY_DECIMALS),
        p95LatencyMsExact: p95,
        p99LatencyMs: roundTo(percentileOf(sorted, 99), LATENCY_DECIMALS),
        minLatencyMs: sorted.length === 0 ? 0 : roundTo(sorted[0], LATENCY_DECIMALS),
        maxLatencyMs: sorted.length === 0 ? 0 : roundTo(sorted[sorted.length - 1], LATENCY_DECIMALS),
        percentileMethod:
            'nearest-rank over all timed samples, compared against the bound unrounded and rounded only for ' +
            'display',
        contentionCaveat:
            'Latency was measured on whatever host ran this command. A figure taken on a host running other ' +
            'workloads against the same PostgreSQL instance is an upper bound on the query, not a clean ' +
            'measurement of it; the relevance figures and page sequences are unaffected by load.',
    };
};

/**
 * Every threshold in the contract against what was measured.
 *
 * THE COMPARISON IS EXACT AND THE DISPLAY IS ROUNDED, in that order. Each rate
 * check is decided by `rateAtLeast`/`rateAtMost` over the integer count, and
 * the p95 check by the unrounded percentile; `measured` carries the rounded
 * figure for a reader and `measuredExact` the value the verdict came from. The
 * counts in `measuredAsCount` are the real integers the rollup counted, not a
 * count reconstructed from a rounded rate — reconstructing it could name a
 * different number of queries than the ones that were actually scored.
 */
const evaluateThresholds = (
    benchmark: SearchBenchmark,
    rollups: BenchmarkRollups,
    latency: LatencySummary,
): readonly ThresholdCheck[] => {
    const { thresholds } = benchmark;
    const scored = rollups.queriesScored;

    return [
        {
            contractKey: 'topThreeHitRate',
            bound: thresholds.topThreeHitRate,
            comparison: 'measured >= bound',
            measured: rollups.topThreeHitRate,
            measuredExact: rollups.topThreeHitRateExact,
            measuredAsCount: `${rollups.topThreeHitCount} of ${scored} queries`,
            verdict: rateAtLeast(rollups.topThreeHitCount, scored, thresholds.topThreeHitRate) ? 'pass' : 'fail',
        },
        {
            contractKey: 'topTenHitRate',
            bound: thresholds.topTenHitRate,
            comparison: 'measured >= bound',
            measured: rollups.topTenHitRate,
            measuredExact: rollups.topTenHitRateExact,
            measuredAsCount: `${rollups.topTenHitCount} of ${scored} queries`,
            verdict: rateAtLeast(rollups.topTenHitCount, scored, thresholds.topTenHitRate) ? 'pass' : 'fail',
        },
        {
            contractKey: 'maxZeroResultRate',
            bound: thresholds.maxZeroResultRate,
            comparison: 'measured <= bound',
            measured: rollups.zeroResultRate,
            measuredExact: rollups.zeroResultRateExact,
            measuredAsCount: `${rollups.zeroResultCount} of ${scored} queries returned no rows`,
            verdict: rateAtMost(rollups.zeroResultCount, scored, thresholds.maxZeroResultRate) ? 'pass' : 'fail',
        },
        {
            contractKey: 'p95LatencyMs',
            bound: thresholds.p95LatencyMs,
            comparison: 'measured <= bound',
            measured: latency.p95LatencyMs,
            measuredExact: latency.p95LatencyMsExact,
            measuredAsCount: `${latency.samples} timed samples at limit ${latency.measuredAtLimit}`,
            verdict: latency.p95LatencyMsExact <= thresholds.p95LatencyMs ? 'pass' : 'fail',
        },
    ];
};


// ---------------------------------------------------------------------------
// Structural invariants.
//
// A threshold is a measured value against a bound. An invariant is a property
// the measurement itself has to have for the values to mean anything, and there
// are three of them:
//
//   * paging repeats and drops nothing, so a page sequence is a slice of one
//     order rather than of several;
//   * every timed pass returns the same rank and the same match-set total for
//     every query, so the reported rank is a property of the release and not of
//     the pass that happened to be first; and
//   * a second, independently loaded database reproduces the same ranks and
//     page sequences, when one was given to compare against.
//
// All three FAIL THE RUN. `rollups.rankStability` already said an unstable rank
// "must be raised, not averaged away", which is only true if something raises
// it: a benchmark whose ordering is not total can otherwise report a hit rate
// nobody can reproduce and exit zero.
// ---------------------------------------------------------------------------

/** One failed structural invariant, in the shape the report and the log record it. */
export interface InvariantFailure {
    readonly code: string;
    readonly detail: string;
}

/**
 * What a cross-database comparison concluded — see `compareAcrossDatabases`.
 *
 * `not_established` is the outcome for a comparison that was MADE and recorded
 * but concludes nothing: this run's own ordering was not total, or its pages
 * did not hold, so agreement with a second database cannot be read as a
 * property of the release. It is distinct from `not_evaluated_by_a_single_run`,
 * where no second report was given and nothing was compared at all.
 */
export type CrossDatabaseOutcome = 'identical' | 'differs' | 'not_established' | 'not_evaluated_by_a_single_run';

/** One query whose rank moved between this run and the report it was compared with. */
export interface CrossDatabaseRankDifference {
    readonly id: string;
    readonly thisRank: number | null;
    readonly peerRank: number | null;
    readonly thisRankInFullResultSet: number | null;
    readonly peerRankInFullResultSet: number | null;
    readonly thisMatchSetTotal: number;
    readonly peerMatchSetTotal: number;
    readonly thisMatchedSourceKey: string | null;
    readonly peerMatchedSourceKey: string | null;
}

/** The first position at which one of a query's two page sequences diverged. */
export interface CrossDatabasePageDifference {
    readonly id: string;
    /** Which sequence diverged: the paged concatenation or the wide reference fetch. */
    readonly sequence: 'page' | 'reference';
    readonly firstDivergingIndex: number;
    readonly thisSourceKey: string | null;
    readonly peerSourceKey: string | null;
}

/**
 * The cross-database reproduction block.
 *
 * Every comparison field is nullable and null exactly when no peer report was
 * given — the state a single run is always in, which is why `outcome` carries
 * `not_evaluated_by_a_single_run` rather than a comfortable default. A null
 * here is a fact about the run and not an unfilled field.
 */
export interface CrossDatabaseReproduction {
    readonly outcome: CrossDatabaseOutcome;
    readonly comparedWith: {
        /** Package-relative, or the file name alone (see `pathKind`). */
        readonly path: string;
        readonly pathKind: PeerPathKind;
        readonly sha256: string;
        readonly generatedAt: string;
        readonly determinismFingerprint: string;
        readonly publishedFoods: number;
        readonly postgresVersion: string;
        readonly databaseDefaultCollation: string;
        readonly databaseOid: number | null;
        readonly systemIdentifier: string | null;
        readonly standing: AcceptanceStanding;
    } | null;
    /**
     * How this run's database related to the compared report's, as
     * `databaseRelationship` decided it. Always `distinct` in a written
     * comparison — `same` and `unverifiable` refuse — and recorded anyway, so a
     * reader can see that the question was asked and answered rather than
     * having to trust that it was.
     */
    readonly identityRelationship: DatabaseRelationship | null;
    readonly ranks: {
        readonly queriesCompared: number;
        readonly identical: number;
        readonly differingCount: number;
        readonly differing: readonly CrossDatabaseRankDifference[];
        readonly queriesOnlyInThisRun: readonly string[];
        readonly queriesOnlyInComparedReport: readonly string[];
    } | null;
    readonly pageSequences: {
        readonly queriesCompared: number;
        readonly identical: number;
        readonly differingCount: number;
        readonly differing: readonly CrossDatabasePageDifference[];
    } | null;
    readonly fingerprintsMatch: boolean | null;
    readonly statement: string;
    readonly howToReproduce: readonly string[];
}

/**
 * A SHA-256 over everything a second database has to reproduce: per query its
 * rank, its position in the full result set, its match-set total, the portable
 * key that matched and whether that rank held across every timed pass, and per
 * pagination query both of its portable sequences.
 *
 * WITHIN-RUN STABILITY IS PART OF THE MEASUREMENT, not a note beside it. A
 * rank that moved between two passes of one database is not the same
 * observation as one that held, even when the first pass reported the same
 * number, so two reports that agree on every rank while disagreeing on whether
 * those ranks were stable have not made the same measurement and must not
 * share a fingerprint.
 *
 * Two reports with equal fingerprints are rank- and page-identical. That is
 * what makes the §0.9.3 determinism claim checkable without diffing six
 * thousand lines by eye, and what makes an inequality worth investigating with
 * the per-query comparison below.
 *
 * The serialisation is canonical: both inputs are sorted by id, every field is
 * emitted positionally through `JSON.stringify` of a fixed-length array, and
 * nothing environment-local — no id, no timing, no host fact — enters it. A
 * fingerprint therefore changes when the measurement changes and at no other
 * time.
 */
export const determinismFingerprint = (
    results: readonly QueryResult[],
    paginationPerQuery: readonly PaginationQueryOutcome[],
): string => {
    const byId = (a: { readonly id: string }, b: { readonly id: string }): number =>
        a.id < b.id ? -1 : a.id > b.id ? 1 : 0;

    const lines: string[] = [];
    for (const result of [...results].sort(byId)) {
        lines.push(
            `q:${JSON.stringify([
                result.id,
                result.rank,
                result.rankInFullResultSet,
                result.matchSetTotal,
                result.matchedSourceKey,
                result.rankStableAcrossPasses,
            ])}`,
        );
    }
    for (const outcome of [...paginationPerQuery].sort(byId)) {
        lines.push(`p:${JSON.stringify([outcome.id, outcome.pageSourceKeys, outcome.referenceSourceKeys])}`);
    }

    return crypto.createHash('sha256').update(lines.join('\n'), 'utf8').digest('hex');
};

/**
 * The peer report as this run received its bytes: how the comparison names the
 * file, the digest of those bytes, and the parsed value. The digest travels
 * with the value because the report records it as the identity of what was
 * compared — a path alone names a file that can change.
 *
 * WHY `path` IS A LABEL RATHER THAN THE PATH THAT WAS READ. This report is
 * COMMITTED, and a second report produced on an operator's machine normally
 * sits outside this package — in a scratch directory whose absolute path names
 * that machine's layout and opens nothing for anyone else. So a peer inside the
 * package is named by its package-relative path, and one outside it by its file
 * name alone (`pathKind` says which).
 *
 * THE ABSOLUTE PATH IS NOT REPORTED ANYWHERE. It exists only in memory, for the
 * filesystem read itself: the log lines carry `compareWithDigest` and a narrowed
 * artefact label, and a refusal carries `peerReportDigest` with a fixed remedy
 * (see {@link unreadablePeerFile}), because an operator-supplied path written
 * into a durable line discloses that machine's layout to everyone who reads the
 * line afterwards. Nothing is lost by the narrowing: `sha256` and
 * `determinismFingerprint` are what identify the compared measurement, the
 * digest correlates a refusal with the file the operator named, and the
 * procedure that reproduces it is in `howToReproduce`.
 */
export interface PeerReportSource {
    /** Package-relative path, or the file name alone for a peer outside it. */
    readonly path: string;
    readonly pathKind: PeerPathKind;
    readonly sha256: string;
    readonly raw: unknown;
}

/** Whether a peer report's recorded name is a package path or just its file name. */
export type PeerPathKind = 'package_relative' | 'name_only';

/**
 * How a peer report is named in a committed artefact: package-relative when it
 * lies inside this package, its file name alone when it does not.
 *
 * Pure and exported so the narrowing is pinned by a test rather than trusted:
 * an absolute path leaking into the artefact is exactly the kind of regression
 * that survives review because it looks like data.
 */
export const peerReportLabel = (
    absolutePath: string,
    packageRoot: string,
): { readonly label: string; readonly pathKind: PeerPathKind } => {
    const relative = path.relative(packageRoot, absolutePath);
    const insidePackage = relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative);

    return insidePackage
        ? { label: relative.split(path.sep).join('/'), pathKind: 'package_relative' }
        : { label: path.basename(absolutePath), pathKind: 'name_only' };
};

/** The contract fields a peer report must agree with to be comparable at all. */
export interface PeerContractExpectation {
    readonly benchmarkVersion: string;
    readonly catalogRelease: string;
}

/** One query as the peer report recorded it. */
export interface PeerQueryResult {
    readonly id: string;
    readonly rank: number | null;
    readonly rankInFullResultSet: number | null;
    readonly matchSetTotal: number;
    readonly matchedSourceKey: string | null;
}

/** One pagination query as the peer report recorded it. */
export interface PeerPaginationOutcome {
    readonly id: string;
    readonly pageSourceKeys: readonly string[];
    readonly referenceSourceKeys: readonly string[];
}

/** The validated slice of a peer report this run compares itself against. */
export interface ParsedPeerReport {
    readonly path: string;
    readonly pathKind: PeerPathKind;
    readonly sha256: string;
    readonly generatedAt: string;
    readonly determinismFingerprint: string;
    readonly publishedFoods: number;
    readonly postgresVersion: string;
    readonly databaseDefaultCollation: string;
    readonly databaseOid: number | null;
    readonly systemIdentifier: string | null;
    readonly standing: AcceptanceStanding;
    /**
     * `rollups.rankStability.unstable` as the peer recorded it. Read because a
     * comparison is only evidence of release determinism when BOTH runs had a
     * total ordering: a peer whose own ranks moved between its timed passes
     * cannot lend its ranks to a claim about the release.
     */
    readonly unstableQueryCount: number;
    /** `paginationCheck.outcome` — a peer that could not page cleanly likewise. */
    readonly paginationOutcome: 'pass' | 'fail';
    readonly results: readonly PeerQueryResult[];
    readonly pagination: readonly PeerPaginationOutcome[];
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const unreadablePeer = (path: string, problem: string): BenchmarkInputError =>
    new BenchmarkInputError(
        'compare_report_unreadable',
        `The report at ${path} could not be read as a ${STAGE} report: ${problem}. A comparison against a file ` +
            'this run cannot fully understand would report agreement on the parts it managed to read, which is ' +
            'worse than not comparing at all.',
        [problem],
    );

const peerString = (source: Record<string, unknown>, key: string, path: string): string => {
    const value = source[key];
    if (typeof value !== 'string' || value.length === 0) {
        throw unreadablePeer(path, `${key} is missing or is not a non-empty string`);
    }
    return value;
};

const peerNumber = (source: Record<string, unknown>, key: string, path: string): number => {
    const value = source[key];
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw unreadablePeer(path, `${key} is missing or is not a finite number`);
    }
    return value;
};

const peerNullableNumber = (source: Record<string, unknown>, key: string, path: string): number | null => {
    const value = source[key];
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'number' || !Number.isFinite(value)) {
        throw unreadablePeer(path, `${key} is present but is neither null nor a finite number`);
    }
    return value;
};

const peerNullableString = (source: Record<string, unknown>, key: string, path: string): string | null => {
    const value = source[key];
    if (value === null || value === undefined) {
        return null;
    }
    if (typeof value !== 'string') {
        throw unreadablePeer(path, `${key} is present but is neither null nor a string`);
    }
    return value;
};

const peerSourceKeys = (value: unknown, key: string, path: string): readonly string[] => {
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string')) {
        throw unreadablePeer(path, `${key} is missing or is not an array of source_key strings`);
    }
    return value as readonly string[];
};

/**
 * Validates a peer report and narrows it to the fields a comparison needs.
 *
 * Four fields have to agree before any comparison means anything — the stage,
 * the report version, the benchmark version and the catalog release — because
 * a comparison is only evidence of determinism when the two runs measured the
 * same query set against the same release under the same report contract.
 * Two of them make it unreadable (it is not this kind of file) and two make it
 * mismatched (it is this kind of file, about something else), which is why the
 * two refusals carry different codes.
 *
 * Pure: it parses an already-read value and throws, so every branch is
 * reachable without a filesystem.
 */
export const parsePeerReport = (
    source: PeerReportSource,
    expected: PeerContractExpectation,
): ParsedPeerReport => {
    const { path: peerPath, raw } = source;

    if (!isRecord(raw)) {
        throw unreadablePeer(peerPath, 'the file does not contain a JSON object');
    }

    const stage = peerString(raw, 'stage', peerPath);
    const reportVersion = peerString(raw, 'reportVersion', peerPath);
    if (stage !== STAGE || reportVersion !== REPORT_VERSION) {
        throw unreadablePeer(
            peerPath,
            `stage/reportVersion are ${stage}/${reportVersion} rather than ${STAGE}/${REPORT_VERSION}`,
        );
    }

    const benchmarkVersion = peerString(raw, 'benchmarkVersion', peerPath);
    const catalogRelease = peerString(raw, 'catalogRelease', peerPath);
    if (benchmarkVersion !== expected.benchmarkVersion || catalogRelease !== expected.catalogRelease) {
        throw new BenchmarkInputError(
            'compare_report_mismatched_contract',
            `The report at ${peerPath} measured benchmark ${benchmarkVersion} against release ${catalogRelease}, ` +
                `while this run measured ${expected.benchmarkVersion} against ${expected.catalogRelease}. Ranks ` +
                'from two different query sets or two different releases are not expected to agree, so comparing ' +
                'them would evidence nothing either way.',
            [
                `peerBenchmarkVersion=${benchmarkVersion}`,
                `peerCatalogRelease=${catalogRelease}`,
                `thisBenchmarkVersion=${expected.benchmarkVersion}`,
                `thisCatalogRelease=${expected.catalogRelease}`,
            ],
        );
    }

    const verdict = raw.verdict;
    if (!isRecord(verdict)) {
        throw unreadablePeer(peerPath, 'verdict is missing or is not an object');
    }
    const standing = peerString(verdict, 'standing', peerPath);
    if (standing !== 'acceptance_evidence' && standing !== 'diagnostic_only') {
        throw unreadablePeer(peerPath, `verdict.standing is ${standing}, which is not a known standing`);
    }

    const corpus = raw.corpus;
    if (!isRecord(corpus)) {
        throw unreadablePeer(peerPath, 'corpus is missing or is not an object');
    }

    // Required rather than defaulted: every report this runner writes carries
    // it, and a peer whose within-run stability cannot be read is a peer whose
    // eligibility cannot be decided. Defaulting a missing value to "stable"
    // would be the fail-OPEN direction, which is the defect this check exists
    // to close.
    const rollups = raw.rollups;
    if (!isRecord(rollups)) {
        throw unreadablePeer(peerPath, 'rollups is missing or is not an object');
    }
    const rankStability = rollups.rankStability;
    if (!isRecord(rankStability)) {
        throw unreadablePeer(peerPath, 'rollups.rankStability is missing or is not an object');
    }
    const unstableQueryCount = peerNumber(rankStability, 'unstable', peerPath);

    const conditions = raw.conditions;
    if (!isRecord(conditions)) {
        throw unreadablePeer(peerPath, 'conditions is missing or is not an object');
    }
    const databaseIdentity = conditions.databaseIdentity;
    if (!isRecord(databaseIdentity)) {
        throw unreadablePeer(
            peerPath,
            'conditions.databaseIdentity is missing or is not an object, so this run cannot establish that the ' +
                'report describes a different database',
        );
    }

    const rawResults = raw.results;
    if (!Array.isArray(rawResults)) {
        throw unreadablePeer(peerPath, 'results is missing or is not an array');
    }
    const results = rawResults.map((entry): PeerQueryResult => {
        if (!isRecord(entry)) {
            throw unreadablePeer(peerPath, 'results contains an entry that is not an object');
        }
        return {
            id: peerString(entry, 'id', peerPath),
            rank: peerNullableNumber(entry, 'rank', peerPath),
            rankInFullResultSet: peerNullableNumber(entry, 'rankInFullResultSet', peerPath),
            matchSetTotal: peerNumber(entry, 'matchSetTotal', peerPath),
            matchedSourceKey: peerNullableString(entry, 'matchedSourceKey', peerPath),
        };
    });

    const paginationCheck = raw.paginationCheck;
    if (!isRecord(paginationCheck) || !Array.isArray(paginationCheck.perQuery)) {
        throw unreadablePeer(peerPath, 'paginationCheck.perQuery is missing or is not an array');
    }
    const paginationOutcome = peerString(paginationCheck, 'outcome', peerPath);
    if (paginationOutcome !== 'pass' && paginationOutcome !== 'fail') {
        throw unreadablePeer(
            peerPath,
            `paginationCheck.outcome is ${paginationOutcome}, which is neither pass nor fail`,
        );
    }
    const pagination = paginationCheck.perQuery.map((entry): PeerPaginationOutcome => {
        if (!isRecord(entry)) {
            throw unreadablePeer(peerPath, 'paginationCheck.perQuery contains an entry that is not an object');
        }
        return {
            id: peerString(entry, 'id', peerPath),
            pageSourceKeys: peerSourceKeys(entry.pageSourceKeys, 'paginationCheck.perQuery[].pageSourceKeys', peerPath),
            referenceSourceKeys: peerSourceKeys(
                entry.referenceSourceKeys,
                'paginationCheck.perQuery[].referenceSourceKeys',
                peerPath,
            ),
        };
    });

    return {
        path: peerPath,
        pathKind: source.pathKind,
        sha256: source.sha256,
        generatedAt: peerString(raw, 'generatedAt', peerPath),
        determinismFingerprint: peerString(raw, 'determinismFingerprint', peerPath),
        publishedFoods: peerNumber(corpus, 'publishedFoods', peerPath),
        postgresVersion: peerString(conditions, 'postgresVersion', peerPath),
        databaseDefaultCollation: peerString(conditions, 'databaseDefaultCollation', peerPath),
        databaseOid: peerNullableNumber(databaseIdentity, 'databaseOid', peerPath),
        systemIdentifier: peerNullableString(databaseIdentity, 'systemIdentifier', peerPath),
        standing,
        unstableQueryCount,
        paginationOutcome,
        results,
        pagination,
    };
};

/**
 * The block a run with no `--compare-with` records: the procedure, and the
 * honest statement that one run cannot assert a property of two.
 */
const crossDatabaseNotEvaluated = (releaseVersion: string): CrossDatabaseReproduction => ({
    outcome: 'not_evaluated_by_a_single_run',
    comparedWith: null,
    identityRelationship: null,
    ranks: null,
    pageSequences: null,
    fingerprintsMatch: null,
    statement:
        'Release determinism (AAP §0.9.3) is a property of two runs, not of one, so a single run cannot ' +
        'assert it. The ranks and page sequences here are computed from release-stable source_keys under ' +
        'an ordering whose final tiebreaker is the portable source_key, which is what makes them ' +
        'reproducible; the evidence is produced by running this same command against a second, ' +
        'independently loaded database and comparing the two reports with --compare-with.',
    howToReproduce: [
        'Create a second database and apply the migrations.',
        `npm run catalog:load -- --release ${releaseVersion} (against that database)`,
        `${ACCEPTANCE_RUNNER_COMMAND} -- --out <second-report.json>`,
        `${ACCEPTANCE_RUNNER_COMMAND} -- --compare-with <second-report.json> (against the first database), which ` +
            'compares every rank and page sequence and records the outcome in this block; a difference fails the ' +
            'run. Only the latency block may differ between the two.',
    ],
});

/** How two reports' databases relate — see `databaseRelationship`. */
export type DatabaseRelationship = 'same' | 'distinct' | 'unverifiable';

/** The two opaque components a database identity is compared on. */
interface ComparableIdentity {
    readonly databaseOid: number | null;
    readonly systemIdentifier: string | null;
}

/**
 * How two database identities relate: the SAME database, two DISTINCT ones, or
 * a pair the question cannot be answered for at all.
 *
 * WHY THREE VALUES RATHER THAN A BOOLEAN. A boolean has to be negated to reach
 * "these are two databases", and `!same` reads an UNREADABLE identity as
 * positive evidence of distinctness. That is the one reading this comparison
 * cannot survive: `pg_control_system()` is superuser-restricted and
 * `pg_database` can be restricted too, so on a hardened server both sides read
 * null — and a report compared against ITSELF would then be published as the
 * second, independently loaded database AAP §0.9.3 asks for. Absence of
 * evidence is a third answer, so it gets a third value and its own refusal
 * instead of being folded into either of the other two.
 *
 * Pure and exported because it is the predicate behind two refusals, and it is
 * applied twice: once before the passes, so a comparison that cannot evidence
 * anything does not cost a measurement, and once inside the comparison itself,
 * so a caller reaching that function directly cannot skip it.
 */
export const databaseRelationship = (
    mine: ComparableIdentity,
    theirs: ComparableIdentity,
): DatabaseRelationship => {
    if (
        mine.systemIdentifier === null ||
        theirs.systemIdentifier === null ||
        mine.databaseOid === null ||
        theirs.databaseOid === null
    ) {
        return 'unverifiable';
    }

    return mine.systemIdentifier === theirs.systemIdentifier && mine.databaseOid === theirs.databaseOid
        ? 'same'
        : 'distinct';
};

/** The one refusal text, so the early check and the comparison cannot diverge. */
const sameDatabaseRefusal = (peerPath: string): BenchmarkInputError =>
    new BenchmarkInputError(
        'compare_report_same_database',
        `The report at ${peerPath} was produced against the same database as this run (same PostgreSQL system ` +
            'identifier and the same database oid). Release determinism is the claim that two INDEPENDENTLY ' +
            'loaded databases agree, so comparing one database with itself evidences nothing: load the release ' +
            'into a second database and produce that report there.',
        ['sameSystemIdentifier=true', 'sameDatabaseOid=true'],
    );

/**
 * The refusal for a pair of identities that establishes neither sameness nor
 * distinctness, naming which side could not be read and which component.
 *
 * It names components and sides only. The values that ARE readable stay out of
 * it for the same reason they stay out of the report: the identity block exists
 * to tell two databases apart, and a refusal is not a licence to widen what it
 * discloses.
 */
const identityUnverifiableRefusal = (
    peerPath: string,
    mine: ComparableIdentity,
    theirs: ComparableIdentity,
): BenchmarkInputError => {
    const unreadable: string[] = [];
    if (mine.systemIdentifier === null) {
        unreadable.push('thisRun.systemIdentifier');
    }
    if (mine.databaseOid === null) {
        unreadable.push('thisRun.databaseOid');
    }
    if (theirs.systemIdentifier === null) {
        unreadable.push('comparedReport.systemIdentifier');
    }
    if (theirs.databaseOid === null) {
        unreadable.push('comparedReport.databaseOid');
    }

    return new BenchmarkInputError(
        'compare_report_identity_unverifiable',
        `This run and the report at ${peerPath} could not both read their PostgreSQL system identifier and ` +
            `database oid (unreadable: ${unreadable.join(', ')}). Release determinism is the claim that two ` +
            'INDEPENDENTLY loaded databases agree, and an identity nothing could be read from cannot establish ' +
            'that these two reports describe two databases at all — a comparison of one report with itself would ' +
            'pass this check and be published as the second-database evidence. Re-run both sides as a role that ' +
            'can read pg_control_system() and pg_database, which is what makes the two identities comparable.',
        unreadable,
    );
};

/**
 * Admits a comparison only when the two reports demonstrably describe two
 * different databases, and returns the relationship it established.
 *
 * One function so the pre-pass check and the comparison itself cannot drift
 * apart on either the decision or its wording.
 */
const distinctDatabasesOrRefuse = (mine: ComparableIdentity, peer: ParsedPeerReport): DatabaseRelationship => {
    const relationship = databaseRelationship(mine, peer);

    if (relationship === 'same') {
        throw sameDatabaseRefusal(peer.path);
    }
    if (relationship === 'unverifiable') {
        throw identityUnverifiableRefusal(peer.path, mine, peer);
    }

    return relationship;
};

/**
 * Why the two sides of a comparison are not both a measurement of the
 * committed protocol, one entry per reason; empty means they are.
 *
 * WHAT `identical` ACTUALLY CLAIMS, and therefore what it needs. It claims the
 * ordering is a property of release, and two runs can only support that when
 * each of them measured a total ordering under the protocol the requirement is
 * stated against. A one-pass or unlocked peer is, by this file's own standing
 * rule, not acceptance evidence; a peer whose ranks moved between its own
 * timed passes, or that could not page cleanly, did not establish an ordering
 * to lend. Left unchecked, each of those would let `identical` be concluded
 * from a measurement that cannot support it.
 *
 * All four conditions here are INPUTS — the peer's own recorded outcome, and
 * this run's deviations, which are known before a single query is issued — so
 * the caller refuses on them rather than recording an outcome. There is no
 * evidence to preserve at that point: nothing has been measured yet.
 *
 * Pure and exported: it is the whole of the eligibility rule, and it is
 * applied twice for the same reason the identity check is.
 */
export const comparisonEligibilityProblems = (
    peer: ParsedPeerReport,
    protocolDeviationCodes: readonly string[],
): readonly string[] => {
    const problems: string[] = [];

    if (peer.standing !== 'acceptance_evidence') {
        problems.push(`comparedReport.standing=${peer.standing}`);
    }
    if (peer.unstableQueryCount > 0) {
        problems.push(`comparedReport.unstableQueries=${peer.unstableQueryCount}`);
    }
    if (peer.paginationOutcome === 'fail') {
        problems.push('comparedReport.paginationCheck=fail');
    }
    for (const code of protocolDeviationCodes) {
        problems.push(`thisRun.protocolDeviation=${code}`);
    }

    return problems;
};

/** The one refusal text for an ineligible pair, named condition by condition. */
const notProtocolEligibleRefusal = (peerPath: string, problems: readonly string[]): BenchmarkInputError =>
    new BenchmarkInputError(
        'compare_report_not_protocol_eligible',
        `This run and the report at ${peerPath} are not both a measurement of the committed protocol ` +
            `(${problems.join(', ')}), so comparing them could not evidence release determinism either way. ` +
            'AAP §0.9.3 asks whether two INDEPENDENTLY loaded databases, each measured under that protocol, ' +
            'agree on every rank and page sequence; a side that deviated from the protocol, whose own ranks moved ' +
            'between its timed passes, or that could not page cleanly has no ordering to contribute to that ' +
            'question. Produce both reports without protocol overrides and with every structural invariant ' +
            'holding, then compare them.',
        problems,
    );

/**
 * Admits a comparison only when both sides can support the conclusion it would
 * reach: two demonstrably different databases, each measured under the
 * committed protocol. Returns the identity relationship it established.
 *
 * One function so the pre-pass check and the comparison itself cannot drift
 * apart on either the decision or its wording.
 */
const admitComparisonOrRefuse = (
    mine: ComparableIdentity,
    peer: ParsedPeerReport,
    protocolDeviationCodes: readonly string[],
): DatabaseRelationship => {
    const relationship = distinctDatabasesOrRefuse(mine, peer);
    const problems = comparisonEligibilityProblems(peer, protocolDeviationCodes);

    if (problems.length > 0) {
        throw notProtocolEligibleRefusal(peer.path, problems);
    }

    return relationship;
};

/** This run's side of a comparison: the portable facts, and who it measured. */
export interface CrossDatabaseComparisonInput {
    readonly determinismFingerprint: string;
    readonly results: readonly QueryResult[];
    readonly pagination: readonly PaginationQueryOutcome[];
    readonly databaseIdentity: DatabaseIdentity;
    readonly releaseVersion: string;
    readonly peer: ParsedPeerReport | null;
    /**
     * This run's deviations from the committed protocol, by code. Non-empty
     * makes a comparison ineligible: a diagnostic run's ranks cannot evidence a
     * property of the release any more than a diagnostic peer's can.
     */
    readonly protocolDeviationCodes: readonly string[];
    /**
     * Query ids whose rank or match-set total moved between THIS run's timed
     * passes, and this run's pagination verdict. Unlike the fields above these
     * are measurement OUTCOMES rather than inputs, which is why they produce
     * the `not_established` outcome instead of a refusal — see the outcome's
     * own explanation in `compareAcrossDatabases`.
     */
    readonly unstableQueryIds: readonly string[];
    readonly paginationOutcome: 'pass' | 'fail';
}

/** The first index at which two portable sequences differ, or null when they agree. */
const firstDivergence = (
    mine: readonly string[],
    theirs: readonly string[],
): { readonly index: number; readonly mine: string | null; readonly theirs: string | null } | null => {
    const shared = Math.min(mine.length, theirs.length);
    for (let index = 0; index < shared; index += 1) {
        if (mine[index] !== theirs[index]) {
            return { index, mine: mine[index], theirs: theirs[index] };
        }
    }
    // One sequence being a prefix of the other is a difference too, and the
    // first index past the shorter one is where it becomes visible.
    if (mine.length !== theirs.length) {
        return {
            index: shared,
            mine: shared < mine.length ? mine[shared] : null,
            theirs: shared < theirs.length ? theirs[shared] : null,
        };
    }
    return null;
};

/**
 * Compares this run with a report produced against a second, independently
 * loaded database — the comparison AAP §0.9.3 calls release determinism.
 *
 * WHAT IT CAN AND CANNOT ESTABLISH. Equal ranks and equal page sequences over
 * two databases loaded from one release establish that the order is a property
 * of the release rather than of a database; they establish nothing about
 * latency, which is free to differ, and nothing about a third database. A
 * comparison of one database with ITSELF establishes nothing at all, which is
 * why an identical database identity refuses rather than reporting
 * `identical`.
 *
 * Pure, and it throws: `compare_report_same_database`,
 * `compare_report_identity_unverifiable` and
 * `compare_report_not_protocol_eligible` are all refusals about the INPUTS,
 * and the alternative — an `identical` outcome that means "the file agreed
 * with itself", or "two runs that were not the protocol agreed" — is the
 * single most misleading thing this block could say.
 *
 * WHY THIS RUN'S OWN INSTABILITY DOES NOT THROW. An unstable rank or a failed
 * pagination check is known only AFTER the measurement, and the run already
 * fails closed on it through `rank_unstable_across_timed_passes` /
 * `pagination_invariant_failed` with the artefact written first, so the
 * evidence of the failure survives. Throwing here would destroy exactly that
 * evidence, so the comparison is recorded in full under the `not_established`
 * outcome instead: every rank and page difference stays auditable, and the
 * statement says plainly that it concludes nothing.
 */
export const compareAcrossDatabases = (input: CrossDatabaseComparisonInput): CrossDatabaseReproduction => {
    const { peer } = input;

    if (peer === null) {
        return crossDatabaseNotEvaluated(input.releaseVersion);
    }

    const identityRelationship = admitComparisonOrRefuse(
        input.databaseIdentity,
        peer,
        input.protocolDeviationCodes,
    );

    const peerResults = new Map(peer.results.map((result) => [result.id, result]));
    const mineResults = new Map(input.results.map((result) => [result.id, result]));

    const rankDifferences: CrossDatabaseRankDifference[] = [];
    let ranksIdentical = 0;
    let ranksCompared = 0;

    for (const result of input.results) {
        const theirs = peerResults.get(result.id);
        if (theirs === undefined) {
            continue;
        }
        ranksCompared += 1;
        const agrees =
            result.rank === theirs.rank &&
            result.rankInFullResultSet === theirs.rankInFullResultSet &&
            result.matchSetTotal === theirs.matchSetTotal &&
            result.matchedSourceKey === theirs.matchedSourceKey;

        if (agrees) {
            ranksIdentical += 1;
            continue;
        }
        rankDifferences.push({
            id: result.id,
            thisRank: result.rank,
            peerRank: theirs.rank,
            thisRankInFullResultSet: result.rankInFullResultSet,
            peerRankInFullResultSet: theirs.rankInFullResultSet,
            thisMatchSetTotal: result.matchSetTotal,
            peerMatchSetTotal: theirs.matchSetTotal,
            thisMatchedSourceKey: result.matchedSourceKey,
            peerMatchedSourceKey: theirs.matchedSourceKey,
        });
    }

    // A query one report scored and the other did not is a difference in its
    // own right — the same benchmark version over an edited query set — and it
    // is kept apart from a rank difference because its remedy is different.
    const onlyInThisRun = input.results.filter((result) => !peerResults.has(result.id)).map((result) => result.id);
    const onlyInPeer = peer.results.filter((result) => !mineResults.has(result.id)).map((result) => result.id);

    const peerPagination = new Map(peer.pagination.map((outcome) => [outcome.id, outcome]));
    const pageDifferences: CrossDatabasePageDifference[] = [];
    let pagesIdentical = 0;
    let pagesCompared = 0;

    for (const outcome of input.pagination) {
        const theirs = peerPagination.get(outcome.id);
        if (theirs === undefined) {
            continue;
        }
        pagesCompared += 1;
        const pagedDivergence = firstDivergence(outcome.pageSourceKeys, theirs.pageSourceKeys);
        const referenceDivergence = firstDivergence(outcome.referenceSourceKeys, theirs.referenceSourceKeys);

        if (pagedDivergence === null && referenceDivergence === null) {
            pagesIdentical += 1;
            continue;
        }
        if (pagedDivergence !== null) {
            pageDifferences.push({
                id: outcome.id,
                sequence: 'page',
                firstDivergingIndex: pagedDivergence.index,
                thisSourceKey: pagedDivergence.mine,
                peerSourceKey: pagedDivergence.theirs,
            });
        }
        if (referenceDivergence !== null) {
            pageDifferences.push({
                id: outcome.id,
                sequence: 'reference',
                firstDivergingIndex: referenceDivergence.index,
                thisSourceKey: referenceDivergence.mine,
                peerSourceKey: referenceDivergence.theirs,
            });
        }
    }

    const fingerprintsMatch = input.determinismFingerprint === peer.determinismFingerprint;
    const differs =
        !fingerprintsMatch ||
        rankDifferences.length > 0 ||
        pageDifferences.length > 0 ||
        onlyInThisRun.length > 0 ||
        onlyInPeer.length > 0;
    // A disagreement is worth reporting even from a run that could not have
    // established agreement, so `differs` wins: it names something real about
    // one of the two corpora. Only the absence of a disagreement needs this
    // run's own ordering to have held before it can mean anything.
    //
    // Within-run stability is part of the fingerprint, so an unstable run
    // against an eligible (therefore stable) peer normally reaches `differs`
    // on the fingerprint alone. `not_established` is the fail-closed backstop
    // for every remaining way the per-query comparison can come out empty —
    // including a caller reaching this pure function directly — because the
    // one thing this block must never do is report `identical` from a run
    // whose own ordering did not hold.
    const measurementCannotEstablishIt = input.unstableQueryIds.length > 0 || input.paginationOutcome === 'fail';
    const outcome: CrossDatabaseOutcome = differs
        ? 'differs'
        : measurementCannotEstablishIt
          ? 'not_established'
          : 'identical';

    // Assembled here rather than inside the returned object: three branches of
    // prose read as prose in a statement, and as an unreviewable nest of
    // ternaries in an object literal.
    let statement: string;
    if (outcome === 'identical') {
        statement =
            `Every rank and every page sequence in this run equals the one recorded in ${peer.path}, and the ` +
            'two determinism fingerprints are the same. Both databases read back their PostgreSQL system ' +
            'identifier and database oid and the pair was positively established as distinct, so that report ' +
            `describes a second database and the order is a property of release ${input.releaseVersion} ` +
            'rather than of either database. This establishes nothing about latency, which is free to differ ' +
            'between hosts, and nothing about any third database.';
    } else if (outcome === 'not_established') {
        const whyThisRunCannot =
            input.unstableQueryIds.length > 0
                ? `${input.unstableQueryIds.length} query/queries in this run returned a different rank or ` +
                  "match-set total between this run's own timed passes, so its ordering is not total within one " +
                  'database'
                : "this run's pagination check failed, so its page sequences are not slices of a single order";
        statement =
            `This run and ${peer.path} record the same ranks and the same page sequences, and that comparison ` +
            `ESTABLISHES NOTHING about release determinism: ${whyThisRunCannot}. An ordering a single run does ` +
            'not have cannot be shown to be a property of release ' +
            `${input.releaseVersion} by a second run agreeing with it, so this outcome is not_established ` +
            'rather than identical. The per-query comparison below is recorded in full because the figures are ' +
            'real measurements worth auditing; the run itself fails closed on the invariant that did not hold ' +
            '(see verdict.failedInvariants), and the determinism claim needs two runs that each held theirs.';
    } else {
        statement =
            `This run and ${peer.path} do not agree: ${rankDifferences.length} query/queries rank ` +
            `differently, ${pageDifferences.length} page sequence(s) diverge, and the determinism ` +
            `fingerprints ${fingerprintsMatch ? 'match' : 'differ'}. Release determinism (AAP §0.9.3) ` +
            'requires the two to be identical with only latency free to differ, so it fails the run through ' +
            'the cross_database_reproduction_differs invariant. The per-query entries below are the ' +
            'starting point: a difference in every query points at the corpus or the collation, while a ' +
            'difference in a few points at ties the ordering does not break.';
    }

    return {
        outcome,
        comparedWith: {
            path: peer.path,
            pathKind: peer.pathKind,
            sha256: peer.sha256,
            generatedAt: peer.generatedAt,
            determinismFingerprint: peer.determinismFingerprint,
            publishedFoods: peer.publishedFoods,
            postgresVersion: peer.postgresVersion,
            databaseDefaultCollation: peer.databaseDefaultCollation,
            databaseOid: peer.databaseOid,
            systemIdentifier: peer.systemIdentifier,
            standing: peer.standing,
        },
        identityRelationship,
        ranks: {
            queriesCompared: ranksCompared,
            identical: ranksIdentical,
            differingCount: rankDifferences.length,
            differing: rankDifferences.slice(0, MAX_NAMED_ITEMS),
            queriesOnlyInThisRun: onlyInThisRun.slice(0, MAX_NAMED_ITEMS),
            queriesOnlyInComparedReport: onlyInPeer.slice(0, MAX_NAMED_ITEMS),
        },
        pageSequences: {
            queriesCompared: pagesCompared,
            identical: pagesIdentical,
            differingCount: pageDifferences.length,
            differing: pageDifferences.slice(0, MAX_NAMED_ITEMS),
        },
        fingerprintsMatch,
        statement,
        howToReproduce: crossDatabaseNotEvaluated(input.releaseVersion).howToReproduce,
    };
};

export interface InvariantFailureInput {
    readonly pagination: PaginationCheckResult;
    /** Query ids whose rank or match-set total moved between the timed passes. */
    readonly unstableQueryIds: readonly string[];
    readonly crossDatabase: CrossDatabaseOutcome;
}

/**
 * Every structural invariant that did not hold, one entry per invariant.
 *
 * Pure and exported: this is the function that decides whether a run exits
 * non-zero for a reason other than a threshold, and each of its three
 * conditions was computed-and-ignored at some point in this file's history,
 * which is exactly why it is testable in isolation now.
 */
export const collectInvariantFailures = (input: InvariantFailureInput): readonly InvariantFailure[] => {
    const failures: InvariantFailure[] = [];

    if (input.pagination.outcome === 'fail') {
        failures.push({
            code: 'pagination_invariant_failed',
            detail:
                `${input.pagination.queriesChecked - input.pagination.queriesPassed} of ` +
                `${input.pagination.queriesChecked} checked queries did not page cleanly ` +
                `(${input.pagination.duplicateIds} duplicated id(s), ${input.pagination.missingIds} missing id(s)).`,
        });
    }

    if (input.unstableQueryIds.length > 0) {
        const named = input.unstableQueryIds.slice(0, MAX_NAMED_ITEMS);
        const truncated =
            input.unstableQueryIds.length > named.length
                ? ` and ${input.unstableQueryIds.length - named.length} more`
                : '';
        failures.push({
            code: 'rank_unstable_across_timed_passes',
            detail:
                `${input.unstableQueryIds.length} query/queries returned a different rank or match-set total ` +
                `between the timed passes: ${named.join(', ')}${truncated}. The ordering is therefore not total, ` +
                'and a rank that moves between two passes of one database cannot be reproduced by another.',
        });
    }

    // `differs` only, and deliberately not `not_established`: that outcome
    // exists because this run's own rank stability or pagination did not hold,
    // both of which are raised above. A second code for the same fact would
    // count one failure twice and describe it as a cross-database disagreement
    // the comparison did not find.
    if (input.crossDatabase === 'differs') {
        failures.push({
            code: 'cross_database_reproduction_differs',
            detail:
                'The report this run was compared against records different ranks or page sequences for the same ' +
                'release. Release determinism (AAP §0.9.3) requires the two to be identical with only latency ' +
                'free to differ, so one of the two corpora, or the ordering itself, is not a property of the ' +
                'release. See crossDatabaseReproduction for the per-query differences.',
        });
    }

    return failures;
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
    /**
     * SHA-256 over every rank and portable page sequence this run measured —
     * see `determinismFingerprint`. Two reports of one release whose
     * fingerprints are equal are rank- and page-identical; it is the one field
     * that answers "did the second database reproduce this?" without a diff.
     */
    readonly determinismFingerprint: string;
    readonly verdict: {
        /**
         * Whether what was measured met the contract. Deliberately unchanged
         * in meaning: `standing` answers the separate question of whether this
         * report may be CITED, and collapsing the two would make a diagnostic
         * run look like a failing release.
         */
        readonly overall: 'pass' | 'fail';
        readonly standing: AcceptanceStanding;
        readonly failedThresholds: readonly string[];
        readonly passedThresholds: readonly string[];
        readonly failedInvariants: readonly InvariantFailure[];
        readonly statement: string;
    };
    readonly provenance: {
        readonly acceptanceRunner: string;
        readonly acceptanceRunnerCommand: string;
        readonly howTheseFiguresWereObtained: string;
    };
    readonly acceptanceEvidence: {
        /**
         * DERIVED, never declared: true exactly when the run deviated from the
         * committed protocol in no way at all (see `protocolDeviations`).
         */
        readonly thisReportIsAcceptanceEvidence: boolean;
        readonly protocolDeviations: readonly ProtocolDeviation[];
        readonly statement: string;
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
        readonly countChecks: readonly CorpusCountCheck[];
        readonly countsStatement: string;
        /**
         * The database's active-release pointer at the time of the run.
         * `matchesContract` is a literal `true` because the run cannot reach
         * this point otherwise: a pointer naming another release refuses with
         * `release_mismatch` before anything is measured.
         */
        readonly activeRelease: {
            readonly releaseId: string;
            readonly loadedAt: string;
            readonly runId: string;
            readonly matchesContract: true;
        };
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
    readonly crossDatabaseReproduction: CrossDatabaseReproduction;
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
        /**
         * Which queries moved between the timed passes, by id. Named rather
         * than only counted because an unstable rank fails the run, and "one
         * query was unstable" is not something an owner can act on.
         */
        readonly rankInstability: {
            readonly queries: number;
            readonly ids: readonly string[];
            readonly idsTruncated: boolean;
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

/**
 * The standing sentence, appended to every verdict.
 *
 * Stated in the verdict and not only in `acceptanceEvidence`, because the
 * verdict is the block a reader stops at: a diagnostic run whose standing was
 * recorded elsewhere would be quoted as "overall: pass" with nothing beside it
 * to say the protocol was not the committed one.
 */
const standingStatement = (standing: AcceptanceStanding, deviations: readonly ProtocolDeviation[]): string =>
    standing === 'acceptance_evidence'
        ? 'This run deviated from the committed protocol in no way, so its standing is acceptance_evidence.'
        : `Its standing is diagnostic_only: this run deviated from the committed protocol (${deviations
              .map((deviation) => deviation.code)
              .join(', ')}), so whatever it measured, it is not a measurement of the protocol the requirement is ` +
          'stated against and cannot be cited as evidence for or against that requirement.';

const verdictStatement = (args: {
    readonly failed: readonly ThresholdCheck[];
    readonly invariantFailures: readonly InvariantFailure[];
    readonly standing: AcceptanceStanding;
    readonly deviations: readonly ProtocolDeviation[];
}): string => {
    const { failed, invariantFailures, standing, deviations } = args;
    const standingNote = standingStatement(standing, deviations);

    if (failed.length === 0 && invariantFailures.length === 0) {
        // Metrics clean is not the same question as citable, and this sentence
        // is the one a reader stops at. Saying "may be cited as acceptance
        // evidence" here and then appending a standing note that says the
        // opposite leaves the reader to decide which half to believe — which
        // is precisely the citation ambiguity the standing rule exists to
        // remove, so the claim itself is made only for a run that earned it.
        if (standing === 'acceptance_evidence') {
            return (
                'Search quality meets every bound in the contract, and every structural invariant held. Under the ' +
                "contract's fail-closed policy this report may be cited as acceptance evidence for the common-food " +
                `search requirement, for the corpus and conditions recorded above and no others. ${standingNote}`
            );
        }

        return (
            'Search quality meets every bound in the contract and every structural invariant held UNDER THE ' +
            'CONDITIONS THIS RUN MEASURED, which were not the committed protocol. This report therefore cannot ' +
            'be cited as acceptance evidence for the common-food search requirement, and it is not evidence ' +
            "against it either: it records what the search did under this run's own conditions, while the " +
            'requirement is stated against the protocol in the contract. Re-run without the overrides to produce ' +
            `a report that answers that question. ${standingNote}`
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
    for (const invariantFailure of invariantFailures) {
        parts.push(`${invariantFailure.code}: ${invariantFailure.detail}`);
    }
    parts.push(
        'The run therefore fails closed and exits non-zero: this report is a record of an UNMET requirement and ' +
            'must not be cited as evidence that catalog search meets its bar. The figures are real measurements — ' +
            'the shortfall is reported rather than smoothed, and remedying it belongs to the owners of the query ' +
            `set and the search implementation. ${standingNote}`,
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
    readonly activeRelease: ActiveReleasePointer;
    readonly countChecks: readonly CorpusCountCheck[];
    readonly deviations: readonly ProtocolDeviation[];
    readonly invariantFailures: readonly InvariantFailure[];
    readonly unstableQueryIds: readonly string[];
    readonly crossDatabase: CrossDatabaseReproduction;
    /** The fingerprint the cross-database comparison used, computed once. */
    readonly fingerprint: string;
}): BenchmarkReport => {
    const {
        deps,
        conditions,
        results,
        rollups,
        latency,
        checks,
        pagination,
        publishedFoods,
        expectations,
        activeRelease,
        countChecks,
        deviations,
        invariantFailures,
        unstableQueryIds,
        crossDatabase,
        fingerprint,
    } = args;
    const { benchmark } = deps;
    const failed = checks.filter((check) => check.verdict === 'fail');
    const manifestPublished = deps.releaseManifest.counts.published_foods ?? deps.releaseManifest.counts.foods;
    const standing: AcceptanceStanding = deviations.length === 0 ? 'acceptance_evidence' : 'diagnostic_only';
    const namedUnstable = unstableQueryIds.slice(0, MAX_NAMED_ITEMS);

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
        determinismFingerprint: fingerprint,
        verdict: {
            // A threshold miss and a broken invariant both fail the run: the
            // second means the figures the first is computed from are not a
            // property of the release, so passing on it would be worse.
            overall: failed.length === 0 && invariantFailures.length === 0 ? 'pass' : 'fail',
            standing,
            failedThresholds: failed.map((check) => check.contractKey),
            passedThresholds: checks.filter((check) => check.verdict === 'pass').map((check) => check.contractKey),
            failedInvariants: invariantFailures,
            statement: verdictStatement({ failed, invariantFailures, standing, deviations }),
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
            thisReportIsAcceptanceEvidence: standing === 'acceptance_evidence',
            protocolDeviations: deviations,
            statement:
                deviations.length === 0
                    ? 'This run took the committed protocol exactly: the query set\'s own timedPasses, the ' +
                      "contract's connection count verified against the datasource rather than assumed, and the " +
                      "catalog graph's shared stage lock held for the whole run. It is therefore acceptance " +
                      'evidence for the corpus and conditions recorded above.'
                    : 'This report is NOT acceptance evidence. A run that deviates from the committed protocol — ' +
                      'in the number of timed passes, in a connection count it could not verify or that differs ' +
                      'from the contract, or by measuring without the corpus lock held — measures something real, ' +
                      'but not the protocol the §0.9.3 requirement is stated against, so citing it as evidence for ' +
                      'or against that requirement would attribute a claim to a measurement nobody made. See ' +
                      'protocolDeviations above for what differed, and re-run without overrides to produce ' +
                      'acceptance evidence.',
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
                crossDatabase.outcome === 'not_evaluated_by_a_single_run'
                    ? 'Cross-database rank identity, which one run cannot establish — see ' +
                      'crossDatabaseReproduction for the procedure that does.'
                    : 'Cross-database LATENCY identity. crossDatabaseReproduction compared the ranks and page ' +
                      'sequences of this run with a report from a second database; latency is free to differ ' +
                      'between hosts and was not compared.',
                'Concurrent-load behaviour. Execution was sequential on a single connection, so nothing here ' +
                    'describes how the query behaves under parallel traffic.',
            ],
        },
        corpus: {
            publishedFoods,
            manifestPublishedFoods: manifestPublished,
            // The AND of every check rather than the published-foods count
            // alone: a release states six counts, and agreeing on one of them
            // is what a partially applied load looks like.
            countsAgree: countChecks.every((check) => check.ok),
            countChecks,
            countsStatement:
                `All ${countChecks.length} counts the release manifest states were compared with the live ones ` +
                'before anything was measured, through the same published-parent relation filters ' +
                '`catalog-load.ts::verifyLoadedCounts` uses. A disagreement REFUSES the run with ' +
                'release_counts_disagree rather than being noted here, because figures measured over a corpus ' +
                `that is not release ${benchmark.catalogRelease} are not weaker evidence for that release — they ` +
                'are evidence about something else.',
            activeRelease: {
                releaseId: activeRelease.releaseId,
                loadedAt: activeRelease.loadedAt.toISOString(),
                runId: activeRelease.runId,
                matchesContract: true,
            },
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
        crossDatabaseReproduction: crossDatabase,
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
            rankInstability: {
                queries: unstableQueryIds.length,
                ids: namedUnstable,
                idsTruncated: unstableQueryIds.length > namedUnstable.length,
                statement:
                    unstableQueryIds.length === 0
                        ? `Every query returned the same rank and the same match-set total on all ${deps.timedPasses} ` +
                          'timed passes, so the ranks in this report are a property of the release rather than of ' +
                          'the pass that happened to be recorded.'
                        : 'These queries returned a different rank or match-set total between the timed passes, ' +
                          'which means the ordering is not total: a rank that moves between two passes of one ' +
                          'database cannot be reproduced by another, so it fails the run through ' +
                          'rank_unstable_across_timed_passes rather than being averaged away. The reported rank is ' +
                          "the first timed pass's.",
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
    /**
     * The structural invariants that did not hold. Non-empty makes the exit
     * code non-zero exactly as a threshold miss does — it replaces the single
     * `paginationFailed` flag this outcome used to carry, which could only
     * express one of the three invariants.
     */
    readonly invariantFailures: readonly InvariantFailure[];
    /**
     * Where the report was actually written: the physical identity of the
     * requested path, not the spelling that was requested. A caller logging or
     * citing this is naming a file that holds these bytes, which an alias is not
     * guaranteed to still resolve to.
     */
    readonly outPath: string;
}

/**
 * The refusal a diagnostic run aimed at the §0.9.3 acceptance artefact gets.
 *
 * One function for the two moments it can be reached from — before the
 * measurement, where the resolved path already IS that artefact, and
 * immediately before the write, where the resolved path has BECOME it because
 * the directory it named was swapped — so both produce the same code and the
 * same words. An operator who hits the second case has to be told the same
 * thing as one who hits the first, with the target they would have overwritten
 * named.
 */
const refuseDiagnosticRunToAcceptancePath = (
    deps: BenchmarkDeps,
    deviations: readonly ProtocolDeviation[],
    resolvedTarget: string,
): never => {
    throw new BenchmarkInputError(
        'diagnostic_run_to_acceptance_path',
        `This run deviates from the committed protocol (${deviations
            .map((deviation) => deviation.code)
            .join(', ')}), so it is diagnostic and may not be written to the default artefact path ` +
            `${deps.acceptanceArtifactPath} — that path is the acceptance evidence for the §0.9.3 ` +
            'search-quality requirement, and overwriting it with a diagnostic run would destroy the committed ' +
            'report while leaving something that looks like it in its place. ' +
            (deps.outPath === resolvedTarget
                ? ''
                : `The path given (${deps.outPath}) is that same file reached through a link: it resolves to ` +
                  `${resolvedTarget}. `) +
            'Re-run with `--out <path>` to keep the diagnostic beside it, or without the overrides to produce ' +
            'acceptance evidence.',
        deviations.map((deviation) => deviation.code),
    );
};

/**
 * Refuses unless the write target is still the place `atStart` observed.
 *
 * Called immediately before the publication write, which is the only place it
 * can usefully be called: see this module's note on why the instrument is
 * revalidation rather than a descriptor held across the measurement. It writes
 * nothing and repairs nothing — a target that moved is an operator's
 * environment to explain, and a report published into a directory this run
 * cannot identify is worse than no report.
 */
const assertOutputPathUnchanged = (
    deps: BenchmarkDeps,
    atStart: OutputPathObservation,
    physicalOutPath: string,
): void => {
    const changes = outputPathIdentityChanges(atStart, observeOutputPath(physicalOutPath));
    if (changes.length === 0) {
        return;
    }

    throw new BenchmarkInputError(
        'output_path_identity_changed',
        `The directory ${path.dirname(physicalOutPath)} is no longer the directory this run verified before it ` +
            `began measuring (${changes.join(', ')}), so ${physicalOutPath} no longer names the file the output ` +
            'path resolved to and the report was NOT written. ' +
            (deps.outPath === physicalOutPath ? '' : `The path given was ${deps.outPath}. `) +
            'A directory replaced, renamed or symlinked while a run measures is how a report is redirected onto ' +
            'another file — the §0.9.3 acceptance artefact in particular — so this run refuses rather than ' +
            'publishing into a place it cannot identify. Re-run with `--out <path>` under a directory only you ' +
            'can write to, and establish what changed the previous one.',
        changes,
    );
};

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

    const deviations = protocolDeviations({
        contract: benchmark.protocol,
        timedPasses: deps.timedPasses,
        poolPin: deps.poolPin,
        stageLockHeld: deps.stageLockHeld,
    });

    // THE OUTPUT PATH IS RESOLVED TO ONE PHYSICAL IDENTITY, HERE, ONCE — and
    // the acceptance guard below and the write at the end of this function both
    // use that single answer.
    //
    // Both halves of that sentence are load-bearing. A path is checked as a
    // SPELLING in vain: `--out` naming the committed artefact through a
    // symlinked parent directory, through a symlink at the file name, or through
    // any other alias spells something the canonical path does not, so a `===`
    // comparison passes it, and the write then lands a DIAGNOSTIC report on
    // data/meal-planning/reports/latest/benchmark-report.json — the §0.9.3
    // acceptance evidence destroyed and something that looks like it left in its
    // place (CWE-59). And resolving twice, once for the guard and once for the
    // write, would leave the interval between them: a link retargeted in it
    // sends the bytes somewhere the guard never examined. One resolution, used
    // for both, closes that too — the resolved path no longer traverses the
    // link, so retargeting it afterwards cannot redirect this report.
    const physicalOutPath = physicalPathIdentity(deps.outPath);
    const physicalAcceptancePath = physicalPathIdentity(deps.acceptanceArtifactPath);

    // Before anything is measured, and with no I/O of its own beyond the
    // resolution above: a diagnostic run must not overwrite the artefact §0.9.3
    // cites. The report would say it is not acceptance evidence, but it would be
    // sitting at the path everything else calls the acceptance report, and the
    // next reader to open that path gets a one-pass diagnostic with the
    // committed report gone.
    if (deviations.length > 0 && physicalOutPath === physicalAcceptancePath) {
        refuseDiagnosticRunToAcceptancePath(deps, deviations, physicalOutPath);
    }

    if (deviations.length > 0) {
        deps.logger.warn('diagnostic_run', {
            stage: STAGE,
            out: outPathLabel(deps.outPath),
            deviations: deviations.map((deviation) => deviation.code).join(', '),
            consequence:
                'The report will record standing diagnostic_only and thisReportIsAcceptanceEvidence false, so it ' +
                'cannot be cited as evidence for the search-quality requirement.',
        });
    }

    // THE WRITE TARGET'S PARENT IS VERIFIED, AND ITS IDENTITY CAPTURED, BEFORE
    // ANYTHING IS MEASURED — and re-checked immediately before the write.
    //
    // The guard above settles WHICH FILE this run is aiming at. It does not
    // settle that the file will still be in the directory it was aimed at when
    // the bytes move, and everything between this line and `writeJsonFile` at
    // the end of this function is time an attacker has: see this module's
    // section on the write target's identity for why the instrument is
    // revalidation rather than a descriptor held open across the measurement.
    //
    // Three separate statements are established here, and each one is needed:
    //
    //   * The directory EXISTS and is safe to publish into.
    //     `assertSafeArtifactParent` refuses a parent that is a symbolic link,
    //     is not a directory, or is writable by other local principals without
    //     the sticky bit — the condition under which the name this run is about
    //     to create can be pre-placed by someone else. It is created first,
    //     owner-only, because a stage that would fail on a missing output
    //     directory should fail before it spends minutes measuring, and
    //     because `writeJsonFile` would otherwise create it at the very end
    //     with nothing checked about it.
    //   * The artefact's NAME is not a link. `physicalPathIdentity` resolves
    //     the final component, so it answers "which file" for a name that is a
    //     symlink instead of refusing it; `observeNameKind` `lstat`s the name
    //     and this refuses a link (or a directory, or an unreadable entry)
    //     there. Both spellings are checked: the one the operator gave, so a
    //     link they typed is named back to them, and the resolved one, so a
    //     dangling link or an entry planted between the two lookups is caught.
    //   * WHICH directory it is. The captured (device, inode) is what
    //     `assertOutputPathUnchanged` compares against before the write, and it
    //     is the only thing that can detect the parent being swapped for a link
    //     to somewhere else after every check above has passed.
    fs.mkdirSync(path.dirname(physicalOutPath), { recursive: true, mode: OUTPUT_DIRECTORY_MODE });
    assertSafeArtifactParent(physicalOutPath);

    const spelledNameKind = observeNameKind(deps.outPath);
    const resolvedNameKind = observeNameKind(physicalOutPath);
    if (!outputNameIsPublishable(spelledNameKind) || !outputNameIsPublishable(resolvedNameKind)) {
        // Both kinds when they differ, because "the name you typed is a link"
        // and "the name it resolves to is a directory" are different faults
        // with different remedies.
        const nameKinds =
            spelledNameKind === resolvedNameKind
                ? spelledNameKind
                : `${spelledNameKind} as spelled and ${resolvedNameKind} once resolved`;
        throw new BenchmarkInputError(
            'output_path_name_unsafe',
            `${deps.outPath} cannot be published to: the entry at the artefact's own name is ${nameKinds}` +
                ', and this stage publishes only to a plain file or to a name that does not exist yet. A symbolic ' +
                'link at the artefact name stands for a file somewhere else, so writing through it would put this ' +
                'report wherever the link\'s owner chose — the §0.9.3 acceptance artefact included. Point `--out` ' +
                'at a real path.',
            [`spelled=${spelledNameKind}`, `resolved=${resolvedNameKind}`],
        );
    }

    const outputPathAtStart = observeOutputPath(physicalOutPath);
    if (outputPathAtStart === null) {
        throw new BenchmarkInputError(
            'output_path_identity_changed',
            `${path.dirname(physicalOutPath)} could not be read back immediately after it was verified, so this ` +
                'run cannot record which directory it is publishing into and cannot detect it being replaced while ' +
                'the measurement runs. Point `--out` at a directory only you can write to.',
            ['output_parent_unreadable'],
        );
    }

    // Parsed before anything is measured: a peer report this run cannot read,
    // or one about another query set or another release, is an input fault, and
    // discovering it after three timed passes would waste the passes.
    const peer =
        deps.peerReport === null
            ? null
            : parsePeerReport(deps.peerReport, {
                  benchmarkVersion: benchmark.benchmarkVersion,
                  catalogRelease: benchmark.catalogRelease,
              });

    // Before the warm-up pass, and before any measurement: a run that cannot
    // attribute its figures to the release it names has nothing to measure.
    const binding = await bindRunToActiveRelease(deps);
    const publishedFoods = binding.counts.publishedFoods;

    // Read here rather than with the other conditions, because a comparison
    // against a report from the same database evidences nothing and must not
    // cost three timed passes to discover. The eligibility of the two sides is
    // settled at the same point and for the same reason: the peer's standing
    // and invariants are recorded in the file already, and this run's
    // deviations are known before the first query, so neither has to be paid
    // for with a measurement.
    const databaseIdentity = await readDatabaseIdentity(deps.db);
    if (peer !== null) {
        admitComparisonOrRefuse(
            databaseIdentity,
            peer,
            deviations.map((deviation) => deviation.code),
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

    // Everything the report will describe has now been measured, so this is the
    // last moment at which "was it all one corpus?" can still be answered.
    const afterRun = await reverifyCorpus(deps, binding);
    const conditions = await captureConditions(
        deps,
        describeCorpusStability({
            stageLockHeld: deps.stageLockHeld,
            atStart: binding.pointer,
            afterRun: afterRun.pointer,
            countChecks: binding.countChecks.length,
        }),
        databaseIdentity,
    );

    const unstableQueryIds = results.filter((result) => !result.rankStableAcrossPasses).map((result) => result.id);
    // Computed once and then used twice — recorded in the report, and compared
    // with the peer's — so the two can never be over different inputs.
    const fingerprint = determinismFingerprint(results, pagination.perQuery);
    const crossDatabase = compareAcrossDatabases({
        determinismFingerprint: fingerprint,
        results,
        pagination: pagination.perQuery,
        databaseIdentity: conditions.databaseIdentity,
        releaseVersion: deps.releaseVersion,
        peer,
        // The same facts `collectInvariantFailures` is given below, so the
        // comparison's own conclusion and the run's verdict cannot be drawn
        // from two different views of this run.
        protocolDeviationCodes: deviations.map((deviation) => deviation.code),
        unstableQueryIds,
        paginationOutcome: pagination.outcome,
    });
    const invariantFailures = collectInvariantFailures({
        pagination,
        unstableQueryIds,
        crossDatabase: crossDatabase.outcome,
    });

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
        activeRelease: binding.pointer,
        countChecks: binding.countChecks,
        deviations,
        invariantFailures,
        unstableQueryIds,
        crossDatabase,
        fingerprint,
    });

    // The artefact is written BEFORE the caller is told about a failure, and
    // that ordering is deliberate: a fail-closed run has to leave the evidence
    // of what it measured behind. The only paths that write nothing are the
    // ones where nothing was measured, or where what was measured describes a
    // corpus that moved underneath it.
    //
    // To the identity resolved at the top of this function, not to the spelling
    // the operator gave: the spelling may traverse a link, and a link is exactly
    // what a local principal can retarget during the minutes this run spends
    // measuring. The resolved path does not traverse it, so the bytes go to the
    // file the guard above examined and nowhere else.
    //
    // AND THE FACTS THAT DECISION RESTED ON ARE RE-ESTABLISHED FIRST, because
    // by now they are minutes old. A resolved path names a file inside a
    // DIRECTORY, and the directory at that path can be renamed aside and
    // replaced — with a symbolic link to data/meal-planning/reports/latest, in
    // the case that matters — by anyone who can write its parent. Two questions
    // are therefore asked again, in the order an operator needs them answered:
    //
    //   1. Does this path resolve onto the acceptance artefact NOW? A swapped
    //      parent makes it, and the answer is the refusal the guard above would
    //      have given, with the same code and the same words.
    //   2. Is the directory still the one that was verified? The captured
    //      (device, inode) answers that for every other redirection, including
    //      a swap onto a directory that is not the acceptance one.
    //
    // Both refuse without writing. Node has no descriptor-relative open to
    // close the remaining microseconds with (see the write-target section
    // above), so this pair of checks immediately before the rename is the
    // narrowest window this runner can achieve.
    const republishedIdentity = physicalPathIdentity(physicalOutPath);
    if (deviations.length > 0 && republishedIdentity === physicalAcceptancePath) {
        refuseDiagnosticRunToAcceptancePath(deps, deviations, republishedIdentity);
    }
    assertOutputPathUnchanged(deps, outputPathAtStart, physicalOutPath);

    writeJsonFile(physicalOutPath, report);

    return {
        report,
        failures: checks.filter((check) => check.verdict === 'fail'),
        invariantFailures,
        // The path the bytes actually went to, so `report_written` and
        // `stage_completed` name the file a reader can open rather than an alias
        // that may no longer point at it.
        outPath: physicalOutPath,
    };
};

// ---------------------------------------------------------------------------
// The committed query set's shape.
//
// WHY THIS EXISTS. `loadSearchBenchmark` (scripts/lib/manifest.ts) checks the
// document's `benchmarkVersion` and then DECLARES the rest of it: the
// `SearchBenchmark` type is a cast over parsed JSON, which is the trust that
// module extends to the manifests whose fields nothing can misread. This
// document is not one of them, because its fields are ARGUMENTS. `queries[].q`
// becomes a bound parameter of `plainto_tsquery`; `thresholds.latencyLimit` and
// `paginationCheck.{limit,singlePageLimit}` become SQL `LIMIT`s;
// `protocol.warmupPasses`, `deps.timedPasses` and `paginationCheck.pages` are
// loop bounds; `queries[].id` is a Map key AND a field of the committed report;
// `queries[].expected[]` becomes a Prisma `IN` list; and `thresholds`'s rates
// become the integer numerators every verdict is decided over.
//
// A document that disagrees with the declared type therefore does not fail as a
// type error — nothing checks it — it reaches PostgreSQL, the in-memory rollups
// and the acceptance artefact as whatever it actually holds (CWE-20). A `q` of
// `null` binds as null and scores as a miss the report presents as a ranking
// result; a fractional `limit` is an opaque driver error a third of the way
// through a measurement; a repeated `id` silently overwrites another query's
// observation, so the report's own `queriesScored` counts a query that was
// never measured; a `warmupPasses` of 10^9 never returns; and a rate with seven
// decimal places is compared as a slightly different bound than the one the
// contract states.
//
// So the runner VERIFIES the document before it uses it, at both points it is
// loaded — `preflight`, which reports it as a prerequisite gap, and `main`,
// which is the point of use — and it REFUSES rather than coercing: a coerced
// query set is a different query set measured under the committed one's name,
// which is the one error a reader of the artefact cannot detect. Validation
// sits at the LOAD points rather than inside `runBenchmark` because that
// function takes its `benchmark` as a dependency the suite supplies as a value;
// the document only exists at the boundary these two functions own.
//
// WHAT IT DELIBERATELY DOES NOT DO: reject unknown keys. This artefact carries
// its curation notes beside its payload — `description`, `thresholdPolicy`,
// `kinds`, `omittedFoods`, `authoringBasis`, and per-field rationales inside
// `protocol` and `paginationCheck` — and those are why a reviewer can read the
// contract at all. Every field the runner CONSUMES is checked; everything else
// is left exactly as committed, and the document is returned as it was parsed
// rather than rebuilt from the checked fields, so a reviewed addition still
// reaches the report's own copy instead of being quietly dropped here.
// ---------------------------------------------------------------------------

/** The document this stage measures against, named in each refusal below. */
const QUERY_SET_FILE = 'data/meal-planning/search-benchmark.v1.json';

/** Invariant across every way the document can be wrong, so it is stated once. */
const QUERY_SET_REMEDY = `Correct ${QUERY_SET_FILE} — or restore the committed copy — and run the stage again.`;

/**
 * THE CEILINGS, AND WHY A CEILING AT ALL. Each of these bounds a value that
 * costs something when it grows: a loop iteration, a database round trip, a
 * row in a `LIMIT`, or a byte of the committed report — and none of them is
 * a taste judgement about curation. Every one is stated well above what the
 * committed v1 document holds (426 queries, 4-character ids, `q` of 2–32
 * characters, at most 6 expectations each, `usda:<digits>` keys of 12
 * characters, 1 warm-up and 3 timed passes, pages of 25 and 75), so a reviewed
 * expansion of the query set never has to touch this file; what they refuse is
 * the order of magnitude that turns a benchmark run into an unbounded one.
 */
const MAX_BENCHMARK_QUERIES = 2000;

/** An id is a Map key and a report field, never prose; four characters is the committed form. */
const MAX_QUERY_ID_CHARS = 16;

/** A kind is a rollup bucket, so its ceiling is the width of a label. */
const MAX_QUERY_KIND_CHARS = 32;

/**
 * Expectations per query. Each one is scanned against every returned item of
 * every pass, so the cost is per-query rather than amortised — and more than a
 * handful of acceptable answers means the query is not discriminating enough to
 * measure ranking with (the document's `expectedSemantics` says as much).
 */
const MAX_EXPECTED_PER_QUERY = 32;

/** A `source_key` is `<dataset>:<id>`; 64 covers any dataset prefix this catalog could carry. */
const MAX_SOURCE_KEY_CHARS = 64;

/** Version ids, the timing name and one ordering clause: labels, not documents. */
const MAX_CONTRACT_TEXT_CHARS = 128;

/** `ordering` is three clauses and `reportedConditions` eight names today. */
const MAX_CONTRACT_LIST_ENTRIES = 32;

/**
 * Warm-up and timed passes. Each pass is a full sweep of the query set, so this
 * is the difference between a run that finishes and one that appears to hang:
 * 25 passes over 2000 queries is already 50,000 searches.
 */
const MAX_PROTOCOL_PASSES = 25;

/** The contract's declared connection count; reported and compared, never dialled. */
const MAX_PROTOCOL_CONNECTIONS = 64;

/**
 * Any page size this document can ask the service for. Deliberately NOT the
 * route's `MAX_LIMIT` (50): `searchPublishedFoods` accepts a wider page from an
 * in-process caller by design, and the committed `singlePageLimit` of 75 is
 * that exception — so the ceiling here is the point past which a "page" stops
 * being a page and starts being a table scan held in memory.
 */
const MAX_SEARCH_PAGE_LIMIT = 1000;

/** Pages per pagination-check query: one search call each, times every named id. */
const MAX_PAGINATION_PAGES = 25;

/**
 * How far a rate bound may sit from an exact numerator at {@link RATE_SCALE}.
 *
 * `rateNumeratorOf` rounds `bound * RATE_SCALE` to recover the integer a
 * decimal literal denotes, which is exact for a bound of at most six decimal
 * places (0.97 → 969999.9999999999 → 970000) and silently wrong for one with
 * more (0.9000001 → 900000.1 → 900000, a bound of 0.9). Binary representation
 * error at this scale is around 10^-10, so the gap between the two cases is ten
 * thousand times this tolerance.
 */
const RATE_NUMERATOR_TOLERANCE = 1e-6;

/**
 * A refusal naming the FIELD and the RULE, never the value.
 *
 * WHY THE VALUE IS WITHHELD. This function exists because the document is not
 * trusted, and a refusal is a log line: quoting the offending value would put
 * unvalidated file content — the very NUL, control, bidi or oversized string
 * the check just rejected — into the operator's terminal, CI retention and the
 * durable run log (CWE-117/CWE-532), which is the disclosure `safeError` and
 * `boundedModelText` exist to prevent. The field path is document structure
 * this repository authored, and it is what an operator opens the file at; the
 * rule clause says what that field must be. Between them the refusal is fully
 * actionable without republishing one byte of the document.
 */
const shapeRefusal = (field: string, rule: string): BenchmarkInputError =>
    new BenchmarkInputError(
        'query_set_invalid',
        `${QUERY_SET_FILE} does not honour the shape this stage measures against: ${field} ${rule}. ` +
            `${QUERY_SET_REMEDY}`,
        // Third item is the remedy, so the fatal log line carries the next step
        // as well as the fault; `preflight` states it in its gap's own field
        // instead and takes only the first two.
        [`field=${field}`, `rule=${rule}`, QUERY_SET_REMEDY],
    );

const requireDocumentRecord = (value: unknown, field: string): Record<string, unknown> => {
    if (!isRecord(value)) {
        throw shapeRefusal(field, 'is missing or is not a JSON object');
    }
    return value;
};

const requireDocumentArray = (
    value: unknown,
    field: string,
    minimum: number,
    maximum: number,
): readonly unknown[] => {
    if (!Array.isArray(value)) {
        throw shapeRefusal(field, 'is missing or is not an array');
    }
    if (value.length < minimum || value.length > maximum) {
        throw shapeRefusal(field, `must hold between ${minimum} and ${maximum} entries, and holds ${value.length}`);
    }
    return value;
};

/**
 * One string this stage consumes, accepted only AS COMMITTED.
 *
 * {@link boundedModelText} is the shared fail-closed narrowing — it refuses a
 * non-string, NUL, the rest of C0, C1, DEL, the bidi and zero-width format
 * controls and an unpaired surrogate — and it also trims, collapses whitespace
 * and truncates. Here the returned value must EQUAL the committed one, because
 * this function validates rather than cleans: a truncated query is a different
 * query, and a collapsed id is a different id, so a document that needed
 * cleaning is refused instead of being quietly rewritten into one that passes.
 */
const requireCommittedText = (value: unknown, field: string, maxChars: number): string => {
    const narrowed = boundedModelText(value, maxChars);
    if (typeof value !== 'string' || narrowed === null || narrowed !== value) {
        throw shapeRefusal(
            field,
            `must be a string of 1 to ${maxChars} characters, already trimmed and single-spaced, carrying no ` +
                'control, bidi or zero-width character',
        );
    }
    return narrowed;
};

const requireCommittedTextList = (value: unknown, field: string): readonly string[] => {
    const entries = requireDocumentArray(value, field, 1, MAX_CONTRACT_LIST_ENTRIES);
    return entries.map((entry, index) =>
        requireCommittedText(entry, `${field}[${index}]`, MAX_CONTRACT_TEXT_CHARS),
    );
};

const requireDocumentInteger = (
    value: unknown,
    field: string,
    minimum: number,
    maximum: number,
): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
        throw shapeRefusal(field, `must be an integer between ${minimum} and ${maximum}`);
    }
    return value;
};

const requireDocumentBoolean = (value: unknown, field: string): boolean => {
    if (typeof value !== 'boolean') {
        throw shapeRefusal(field, 'must be true or false');
    }
    return value;
};

/**
 * A rate bound: finite, within 0 and 1, and exactly representable as an integer
 * numerator at {@link RATE_SCALE} — which is the scale every rate verdict is
 * decided at, so a bound this stage cannot represent is a bound it would
 * silently test a different value against (see {@link RATE_NUMERATOR_TOLERANCE}).
 */
const requireRateBound = (value: unknown, field: string): number => {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
        throw shapeRefusal(field, 'must be a finite rate between 0 and 1');
    }
    const scaled = value * RATE_SCALE;
    if (Math.abs(scaled - Math.round(scaled)) > RATE_NUMERATOR_TOLERANCE) {
        throw shapeRefusal(
            field,
            `must be stated to at most six decimal places, so the verdict compares the bound the contract ` +
                `states rather than its nearest multiple of 1/${RATE_SCALE}`,
        );
    }
    return value;
};

/**
 * One benchmark query, accepted only if the SEARCH LAYER would accept it.
 *
 * The bound and the control-character rule are `catalog.logic.ts`'s, reached
 * through the parser `GET /catalog/foods` uses, and the parsed value must equal
 * the committed one: the parser TRIMS, so a `q` with surrounding whitespace
 * would otherwise pass validation here and then be sent to the service
 * untrimmed — a different query from the one that was checked, because
 * `runPass` calls the service with `query.q` and not with the parsed form.
 */
const requireSearchableQuery = (value: unknown, field: string): string => {
    const q = requireCommittedText(value, field, MAX_SEARCH_QUERY_LENGTH);
    const parsed = parseCatalogSearchQuery(q);

    if (parsed.kind !== 'ok' || parsed.q !== q) {
        throw shapeRefusal(
            field,
            `must be a query the search layer itself accepts: ${MIN_SEARCH_QUERY_LENGTH} to ` +
                `${MAX_SEARCH_QUERY_LENGTH} characters, no control characters, and no leading or trailing ` +
                'whitespace — a query GET /catalog/foods would refuse cannot be measured',
        );
    }

    return q;
};

/**
 * Verifies `search-benchmark.v1.json` against every field this stage consumes
 * and returns it typed.
 *
 * Exported because it is the boundary itself: `main` and `preflight` both call
 * it, and the tests drive it directly — including against the committed
 * document, which is what pins that these bounds describe the artefact the plan
 * cites rather than a stricter file nobody has.
 */
export const assertSearchBenchmarkShape = (value: unknown): SearchBenchmark => {
    const document = requireDocumentRecord(value, 'its top level');

    // The loader has already refused a document whose `benchmarkVersion` is not
    // `v1`; both fields are re-read here as TYPES, because `main` compares the
    // first against `--benchmark` and hands the second to
    // `loadReleaseManifest`, where `manifest.ts::assertReleaseVersion` owns the
    // path-segment rule that this stage must not restate.
    requireCommittedText(document.benchmarkVersion, 'benchmarkVersion', MAX_CONTRACT_TEXT_CHARS);
    requireCommittedText(document.catalogRelease, 'catalogRelease', MAX_CONTRACT_TEXT_CHARS);

    const thresholds = requireDocumentRecord(document.thresholds, 'thresholds');
    requireRateBound(thresholds.topThreeHitRate, 'thresholds.topThreeHitRate');
    requireRateBound(thresholds.topTenHitRate, 'thresholds.topTenHitRate');
    requireRateBound(thresholds.maxZeroResultRate, 'thresholds.maxZeroResultRate');
    // A latency bound carries no cost when it is large — it is only compared —
    // so it is bounded below rather than above: a non-positive or non-finite
    // millisecond bound is a threshold no measurement can ever meet or miss.
    if (
        typeof thresholds.p95LatencyMs !== 'number' ||
        !Number.isFinite(thresholds.p95LatencyMs) ||
        thresholds.p95LatencyMs <= 0
    ) {
        throw shapeRefusal('thresholds.p95LatencyMs', 'must be a finite number of milliseconds above zero');
    }
    // The measured page size, which reaches the service as its `limit`.
    requireDocumentInteger(thresholds.latencyLimit, 'thresholds.latencyLimit', 1, MAX_SEARCH_PAGE_LIMIT);

    requireCommittedTextList(document.ordering, 'ordering');
    requireCommittedTextList(document.reportedConditions, 'reportedConditions');

    const protocol = requireDocumentRecord(document.protocol, 'protocol');
    // Zero warm-up passes is a coherent protocol (measure cold); zero timed
    // passes is not a protocol at all, which is why the two floors differ.
    requireDocumentInteger(protocol.warmupPasses, 'protocol.warmupPasses', 0, MAX_PROTOCOL_PASSES);
    requireDocumentInteger(protocol.timedPasses, 'protocol.timedPasses', 1, MAX_PROTOCOL_PASSES);
    requireDocumentBoolean(protocol.sequential, 'protocol.sequential');
    requireDocumentInteger(protocol.connections, 'protocol.connections', 1, MAX_PROTOCOL_CONNECTIONS);
    requireCommittedText(protocol.timing, 'protocol.timing', MAX_CONTRACT_TEXT_CHARS);

    const queries = requireDocumentArray(document.queries, 'queries', 1, MAX_BENCHMARK_QUERIES);
    const declaredIds = new Set<string>();
    queries.forEach((entry, index) => {
        const query = requireDocumentRecord(entry, `queries[${index}]`);
        const id = requireCommittedText(query.id, `queries[${index}].id`, MAX_QUERY_ID_CHARS);
        // UNIQUENESS IS NOT COSMETIC. Every pass keys its observations by this
        // id and `resolveExpectations` keys its expectation lists by it, so a
        // repeated id makes the second query overwrite the first's observation
        // while both are still counted in `queriesScored` — a report that
        // scores a query nobody measured, which is exactly the claim this
        // artefact exists to carry.
        if (declaredIds.has(id)) {
            throw shapeRefusal(
                `queries[${index}].id`,
                'repeats an id an earlier query already declares, and the per-pass observations are keyed by it',
            );
        }
        declaredIds.add(id);

        requireSearchableQuery(query.q, `queries[${index}].q`);

        // The kind is bounded and printable rather than drawn from a closed
        // list: `SearchBenchmarkQuery.kind` is deliberately a plain string so
        // that a new query family is a reviewed DATA change, and a vocabulary
        // restated here would make it a code change. What the bound protects is
        // the rollup, where the value becomes a bucket label in the report.
        requireCommittedText(query.kind, `queries[${index}].kind`, MAX_QUERY_KIND_CHARS);

        // At least one expectation, because a query with none cannot be scored
        // at all — the document's own `omittedFoods` note gives that as the
        // reason such queries are omitted rather than carried unscored.
        const expected = requireDocumentArray(
            query.expected,
            `queries[${index}].expected`,
            1,
            MAX_EXPECTED_PER_QUERY,
        );
        expected.forEach((sourceKey, position) => {
            requireCommittedText(
                sourceKey,
                `queries[${index}].expected[${position}]`,
                MAX_SOURCE_KEY_CHARS,
            );
        });
    });

    const pagination = requireDocumentRecord(document.paginationCheck, 'paginationCheck');
    const limit = requireDocumentInteger(pagination.limit, 'paginationCheck.limit', 1, MAX_SEARCH_PAGE_LIMIT);
    const pages = requireDocumentInteger(pagination.pages, 'paginationCheck.pages', 1, MAX_PAGINATION_PAGES);
    const singlePageLimit = requireDocumentInteger(
        pagination.singlePageLimit,
        'paginationCheck.singlePageLimit',
        1,
        MAX_SEARCH_PAGE_LIMIT,
    );
    // An empty `queryIds` is a coherent contract — it checks no pagination —
    // and the suite's fixtures use it; what it may not be is unbounded or
    // repetitive.
    const namedIds = new Set<string>();
    requireDocumentArray(pagination.queryIds, 'paginationCheck.queryIds', 0, MAX_BENCHMARK_QUERIES).forEach(
        (entry, index) => {
            const id = requireCommittedText(
                entry,
                `paginationCheck.queryIds[${index}]`,
                MAX_QUERY_ID_CHARS,
            );
            if (namedIds.has(id)) {
                throw shapeRefusal(
                    `paginationCheck.queryIds[${index}]`,
                    'names a query the list already names, which would page it twice and count it twice',
                );
            }
            namedIds.add(id);
            // Membership in `queries` is NOT checked here on purpose:
            // `runPaginationCheck` already refuses an unknown id under
            // `pagination_query_unknown` and names every one of them, and one
            // rule with two owners is a rule that can disagree with itself.
        },
    );

    // THE ONE CROSS-FIELD INVARIANT THAT DECIDES WHETHER THE CHECK MEANS
    // ANYTHING. The pagination invariant compares `pages` pages of `limit`
    // against one page of `singlePageLimit`; if the two do not describe the same
    // window, the two sequences differ in LENGTH for every query and the check
    // fails everywhere — reported as a paging fault of the release rather than
    // as the arithmetic mistake in this document that it is.
    if (singlePageLimit !== limit * pages) {
        throw shapeRefusal(
            'paginationCheck.singlePageLimit',
            `must equal paginationCheck.limit × paginationCheck.pages (${limit} × ${pages} = ${limit * pages}), ` +
                'because the invariant compares those pages against one page of that width',
        );
    }

    // Every field this stage reads has now been checked against the document
    // itself, which is what makes the narrowing below a verified one rather
    // than the declaration `loadSearchBenchmark` makes.
    return value as SearchBenchmark;
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

/**
 * `--compare-with` resolved against the backend package root, exactly as
 * `--out` is, so the command stays working-directory independent and one file
 * has one resolved identity however the operator spelled the flag.
 */
const resolvePeerReportPath = (comparePath: string): string => path.resolve(__dirname, '..', comparePath);

/**
 * How a peer report is named in a LOG LINE: the digest of its resolved path,
 * never the path.
 *
 * WHY THE PATH CANNOT BE LOGGED, EVEN RELATIVISED. `--compare-with` is an
 * operator-supplied path to a file that is usually outside this repository —
 * a second checkout, a scratch directory, a colleague's home — and every line
 * this stage writes reaches a terminal, CI retention and, through
 * `checkpoint.ts`'s run log, a JSONB column that committed reports are
 * assembled from. Printing the path publishes filesystem layout into all three
 * (CWE-532/CWE-209), and a repository-relative rendering is not a fix: a
 * relative path still describes the layout, and one resolving outside the
 * package would be rendered with `..` segments that describe it more precisely
 * than the absolute form.
 *
 * The digest answers the only question a reader has to answer from the log —
 * were these two runs pointed at the same peer report — and cannot answer
 * "where is it" (see {@link opaqueDigest}). `'none'` when no comparison was
 * requested, which is `opaqueDigest`'s own statement of absence rather than a
 * digest that would read as an identity.
 *
 * Exported because the narrowing is the security property: a test pins that
 * this and not the path is what a log line carries.
 */
export const peerReportDigest = (comparePath: string | null): string =>
    opaqueDigest(comparePath === null ? '' : resolvePeerReportPath(comparePath));

/**
 * The remedy every peer-report refusal carries, written HERE rather than quoted
 * from a filesystem or parser message.
 *
 * The operator invoked the command with the path, so they do not need to be
 * told it back; what they need is the next step, and it is invariant across
 * every way the file can fail to be a report of a run.
 */
const PEER_REPORT_REMEDY =
    'Produce the peer report by running this command against the second database with --out, then point ' +
    '--compare-with at that file.';

/**
 * A `--compare-with` file this stage could not turn into a peer report, in the
 * one shape both refusals below take.
 *
 * WHAT IT SAYS, AND WHAT IT DELIBERATELY DOES NOT. `problem` is this file's own
 * clause naming which step failed, and `cause` is {@link formatSafeError} — the
 * failing class with its machine code, so an `ENOENT` still reaches the
 * operator as `code ENOENT`. What is gone is the foreign prose: `fs` puts the
 * absolute path it opened into its message, and a JSON `SyntaxError` quotes the
 * bytes it choked on — a fragment of a document this stage is not the author of
 * — so forwarding either would put a path and file content into the durable log
 * that `safeError` exists to keep them out of (logger.ts::safeError).
 *
 * The three `detail` items are what the failure is ACTIONABLE on and are all
 * values this repository owns: the correlation digest, the failing class, and
 * the fixed remedy. They travel in `detail` because that is the channel the
 * top-level catch already prints (`input_detail`); the thrown `message` is not
 * logged anywhere, by design.
 */
const unreadablePeerFile = (comparePath: string, problem: string, cause: unknown): BenchmarkInputError =>
    new BenchmarkInputError(
        'compare_report_unreadable',
        `The file named by --compare-with ${problem} (${formatSafeError(cause)}). ${PEER_REPORT_REMEDY}`,
        [
            `peerReportDigest=${peerReportDigest(comparePath)}`,
            `cause=${formatSafeError(cause)}`,
            PEER_REPORT_REMEDY,
        ],
    );

/**
 * Reads the report named by `--compare-with` and digests its BYTES.
 *
 * The digest is taken over the bytes on disk rather than over the re-serialised
 * value, because it is recorded as the identity of the file that was compared:
 * a reader has to be able to run `sha256sum` on that path and get the same
 * string.
 *
 * Exported for the canary tests: the two refusal paths are where a path and a
 * parser message would leak, and asserting their absence needs the real
 * filesystem read rather than a seam that stands in for it.
 */
export const readPeerReport = (comparePath: string): PeerReportSource => {
    const absolutePath = resolvePeerReportPath(comparePath);

    let bytes: Buffer;
    try {
        bytes = fs.readFileSync(absolutePath);
    } catch (error) {
        throw unreadablePeerFile(comparePath, 'could not be read', error);
    }

    let raw: unknown;
    try {
        raw = JSON.parse(bytes.toString('utf8'));
    } catch (error) {
        throw unreadablePeerFile(comparePath, 'does not contain valid JSON', error);
    }

    // Neither the refusals above nor this value carries the path: what reaches
    // the committed artefact is the narrowed label, and what reaches a log line
    // is the digest.
    const { label, pathKind } = peerReportLabel(absolutePath, path.resolve(__dirname, '..'));

    return {
        path: label,
        pathKind,
        sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
        raw,
    };
};

export const preflight = (deps: BenchmarkPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    try {
        // Loaded AND verified: a document that parses and declares `v1` is
        // still not a query set until every field this stage consumes is what
        // the declared type says it is, and preflight is where a prerequisite
        // that does not hold is reported as a gap rather than as a fault.
        assertSearchBenchmarkShape(deps.loadSearchBenchmark());
    } catch (error) {
        if (isThrownInstanceOf(error, ManifestError)) {
            gaps.push({
                code: 'search_benchmark_unavailable',
                requirement:
                    'data/meal-planning/search-benchmark.v1.json must load and declare its benchmarkVersion: it ' +
                    'is the query set, the expected source_keys, the thresholds and the protocol',
                remedy: 'Restore the benchmark query set at data/meal-planning/search-benchmark.v1.json (AAP §0.7.1 Group 3).',
                // The CODE, not the message. `ManifestError`'s text is mostly
                // this repository's own prose, but not all of it: its
                // `repo_root_not_found` names the absolute directory it
                // searched from, and its `invalid_merged_report` quotes
                // `JSON.stringify`'s own failure — so forwarding the message
                // wholesale forwards a path and a foreign parser's words into a
                // gap this stage reports to the operator and writes down. The
                // `requirement` and `remedy` above already name the file and
                // the fix in text written here, which is the actionable half.
                detail: error.code,
            });
        } else if (isThrownInstanceOf(error, BenchmarkInputError) && error.code === 'query_set_invalid') {
            gaps.push({
                code: 'search_benchmark_invalid',
                requirement:
                    `${QUERY_SET_FILE} must honour the shape this stage measures against: the queries it runs, ` +
                    'the expectations it scores, the bounds it compares and the protocol it takes them under',
                remedy: `${QUERY_SET_REMEDY} (AAP §0.7.1 Group 3)`,
                // The field and the rule, which are this repository's own
                // words; the refusal's third detail item is the remedy and is
                // already stated in the gap's own field above.
                detail: error.detail.slice(0, 2).join('; '),
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
// The reported `error` is `SafeErrorFields` — a scrubbed name plus an optional
// machine code and status, and deliberately no `message`: this value reaches the
// durable run log and the operator console, where foreign prose can carry a
// connection URL, a key or a fragment of the document that failed (CWE-532).
// Exported, as catalog-load.ts, catalog-import-usda.ts and recipes-seed.ts
// export theirs: the mapping from error class to reported code and fields is
// the last thing this stage does before it exits, and a test that asserts what
// a failure line may say has to build the line this function actually produces
// rather than a hand-written copy of it.
export const describeFailure = (error: unknown): { code: string; error: SafeErrorFields; detail?: LogFields } => {
    if (isThrownInstanceOf(error, DatabaseOriginError)) {
        return { code: error.code, error: safeError(error) };
    }
    if (isThrownInstanceOf(error, ManifestError)) {
        return { code: error.code, error: safeError(error) };
    }
    // The stage lock's own refusal, which is an outcome rather than a fault: a
    // benchmark that could not take the shared catalog lock was refused
    // because a mutator holds it, and `catalog_stage_locked` tells the
    // operator to re-run after that stage finishes. Reported under
    // `unexpected_error` it would read as a bug in this runner.
    // The one branch that reports TYPED CONTEXT beside the code. A stage-lock
    // refusal names the stage holding the catalog graph and the mode it asked
    // for, and those are what an operator acts on — see checkpointErrorFields
    // for why they travel as data rather than inside the rendered sentence.
    if (isThrownInstanceOf(error, CheckpointError)) {
        return { code: error.code, error: safeError(error), detail: checkpointErrorFields(error) };
    }
    if (isThrownInstanceOf(error, BenchmarkInputError)) {
        return { code: error.code, error: safeError(error) };
    }
    if (isThrownInstanceOf(error, BenchmarkThresholdError)) {
        return { code: 'thresholds_missed', error: safeError(error) };
    }
    return { code: 'unexpected_error', error: safeError(error) };
};

/**
 * Pins the datasource pool to one connection before the client is constructed,
 * which is the only point at which Prisma reads it, and reports what the pool
 * limit ACTUALLY is.
 *
 * The protocol states `connections: 1`, and sequential calls alone only make
 * that true in practice; pinning the pool makes it true by construction, so a
 * percentile cannot quietly include time spent queueing behind a second
 * connection. `connection_limit` is a pool setting and not one of dbGuard's
 * connection-redirecting parameters, so it cannot move the run to another
 * database — and the guard has already classified the origin by this point
 * regardless.
 *
 * WHY IT REPORTS RATHER THAN REPAIRS. An operator's `connection_limit=8` is
 * left exactly where it is: silently rewriting the datasource this command was
 * pointed at is worse than measuring under the limit it was given, because the
 * rewrite is invisible in the report and the limit is not the only thing a
 * hand-built URL may be carrying. What the run must never do is STATE one
 * connection while running under eight, so the outcome below is what the report
 * records and what `protocolDeviations` turns into a deviation — a mismatch
 * makes the report diagnostic instead of making it wrong.
 *
 * The URL itself never leaves this function. `note` describes the shape that
 * was found, never the value it was found in: no host, credential or database
 * name may reach the report or a log line.
 */
export interface PoolPinOutcome {
    /** The limit in force for this run, or null when none could be read. */
    readonly effectiveConnectionLimit: number | null;
    /** Whether THIS run appended the limit. */
    readonly pinned: boolean;
    /** Whether a limit this run did not set was already in force, and readable. */
    readonly preexisting: boolean;
    readonly note: string;
}

/**
 * EVERY occurrence of the parameter, in the order the URL carries them, with
 * the value captured loosely so an empty or non-numeric one still counts as an
 * occurrence.
 *
 * Global, and scanned to the end rather than stopping at the first hit: a URL
 * may carry the parameter twice, the FIRST occurrence is not necessarily the
 * one in force, and a helper that reads only the first would report a limit
 * the run did not measure under. `matchAll` clones the pattern rather than
 * advancing this one, so the shared constant carries no state between calls.
 */
const CONNECTION_LIMIT_OCCURRENCES = /[?&]connection_limit=([^&]*)/g;

/** A value the pool limit can be read back from with no interpretation. */
const PLAIN_INTEGER = /^\d+$/;

export const pinPoolToSingleConnection = (env: NodeJS.ProcessEnv): PoolPinOutcome => {
    const databaseUrl = env.DATABASE_URL;

    if (databaseUrl === undefined || databaseUrl.length === 0) {
        return {
            effectiveConnectionLimit: null,
            pinned: false,
            preexisting: false,
            note:
                'DATABASE_URL was absent or empty, so no pool limit could be set or read back and the number of ' +
                'connections this run had available is unknown.',
        };
    }

    const values = [...databaseUrl.matchAll(CONNECTION_LIMIT_OCCURRENCES)].map((occurrence) => occurrence[1]);

    if (values.length > 1) {
        // WHY A DUPLICATE IS REFUSED RATHER THAN RESOLVED LAST-WINS. Which
        // occurrence a driver honours is not part of any documented contract:
        // Prisma parses the datasource URL's query string with its own rules,
        // and "the last one wins" is an observation about a version rather
        // than a guarantee. Picking either end would make the connection count
        // this report STATES rest on undocumented behaviour, and a measurement
        // condition asserted from undocumented behaviour is not a verified
        // condition — which is the whole point of reading the limit back. So
        // the count becomes unknown, `protocolDeviations` raises
        // connection_limit_unverified, and the run is diagnostic: it still
        // measures and still writes its report, just not to the acceptance
        // path and not under an acceptance standing.
        return {
            effectiveConnectionLimit: null,
            pinned: false,
            preexisting: false,
            note:
                `DATABASE_URL carries the connection_limit parameter ${values.length} times. Which of the ` +
                'duplicated values a driver puts in force depends on an undocumented parameter-precedence rule ' +
                'rather than on anything this run can verify, so the pool limit was left untouched and the number ' +
                'of connections this run had available is unknown. Remove the duplicate to state it.',
        };
    }

    if (values.length === 1) {
        const value = values[0];

        if (!PLAIN_INTEGER.test(value)) {
            // Present but not a plain integer. Reported as unverified rather
            // than as preexisting, because `preexisting` means "a limit this
            // run did not set is in force and was READ": a value nobody could
            // read cannot support a claim about the measurement conditions.
            return {
                effectiveConnectionLimit: null,
                pinned: false,
                preexisting: false,
                note:
                    'DATABASE_URL already carries a connection_limit parameter whose value is not a plain integer, ' +
                    'so the pool limit could not be read back and was left untouched. The number of connections ' +
                    'this run had available is therefore unknown.',
            };
        }

        const limit = Number(value);

        return {
            effectiveConnectionLimit: limit,
            pinned: false,
            preexisting: true,
            note:
                `DATABASE_URL already carried connection_limit=${limit}, which this run left in place rather than ` +
                'rewriting the datasource it was pointed at. The pool limit recorded in this report is that ' +
                'value, read back from the parameter, and not an assumption.',
        };
    }

    env.DATABASE_URL = `${databaseUrl}${databaseUrl.includes('?') ? '&' : '?'}connection_limit=1`;

    return {
        effectiveConnectionLimit: 1,
        pinned: true,
        preexisting: false,
        note:
            'The datasource pool was pinned to connection_limit=1 by this run, before the Prisma client was ' +
            'constructed and therefore before the pool size was fixed, so one connection is true by construction ' +
            'rather than only in practice.',
    };
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
        ...originLogFields(origin),
    });

    const outPath = resolveOutPath(parsed.options.out);
    logger.info('stage_invoked', {
        stage: STAGE,
        out: outPathLabel(outPath),
        benchmarkVersion: parsed.options.benchmarkVersion,
        passes: parsed.options.passes,
        // The two facts this repository owns about the comparison — that one
        // was requested, and which file it was against — stated without the
        // path the operator typed. This line used to carry `--compare-with`
        // verbatim, which put an absolute path to a file outside this
        // repository into the terminal, CI retention and the durable run log
        // (CWE-532); see peerReportDigest for why a relativised path is not a
        // fix either. The digest is logged HERE, once per run and before the
        // file is opened, so it is present for the run that goes on to refuse
        // the file as well as for the run that reads it.
        compareRequested: parsed.options.compareWith !== null,
        compareWithDigest: peerReportDigest(parsed.options.compareWith),
    });

    const gaps = preflight({ loadSearchBenchmark, fileExists: repoFileExists });
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    // Verified at the point of USE as well as in preflight, and the repetition
    // is deliberate: preflight takes its loader as a seam, so its verdict is
    // about whatever loader it was handed, while this call is the one that
    // decides what reaches the search, the maps and the artefact. The loader
    // memoises by path, so the second verification costs a pass over a document
    // already in memory.
    const benchmark = assertSearchBenchmarkShape(loadSearchBenchmark());
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

    // Captured BEFORE the pin, and that ordering is load-bearing:
    // `connection_limit` is a PRISMA parameter, not a PostgreSQL one, and the
    // stage lock is held on a plain `pg` client. Handing the pinned URL to the
    // lock would send an unknown parameter to the server.
    const lockConnectionString = process.env.DATABASE_URL;
    const poolPin = pinPoolToSingleConnection(process.env);

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
        // THE WHOLE RUN IS HELD UNDER THE CATALOG GRAPH'S SHARED STAGE LOCK.
        //
        // Every mutating stage takes that lock exclusively for its lifetime, so
        // holding it shared here is what makes one report describe ONE
        // committed catalog state: without it a `catalog-load` starting between
        // two queries would have the earlier ones measured against the previous
        // release and the later ones against the next, and nothing in the
        // report could show that it had happened. Shared rather than exclusive
        // because this stage only reads — see CATALOG_STAGE_LOCK_MODES — so two
        // benchmark runs of one database still do not contend.
        //
        // It refuses rather than waits (waitMs defaults to 0): a benchmark that
        // queued behind a multi-hour import would look to an operator exactly
        // like one that hung.
        const outcome = await withCatalogStageLock(
            { stage: 'benchmark', logger, connectionString: lockConnectionString },
            () =>
                runBenchmark({
                    db: prisma as unknown as BenchmarkDb,
                    search: searchPublishedFoods,
                    // The scripts' single implementation of the active-release
                    // convention. Reimplementing the query here would let the
                    // benchmark and GET /catalog/status disagree about which
                    // catalog is live, which is the one thing that convention
                    // exists to prevent (see checkpoint.ts's note on
                    // RELEASE_LOAD_RUN_KIND).
                    readActiveRelease: () => getActiveReleaseLoad(prisma),
                    benchmark,
                    releaseManifest,
                    releaseVersion,
                    outPath,
                    // The artefact a diagnostic run may not overwrite, named
                    // from the one resolver that owns the default path so the
                    // guard and the default can never name two different files.
                    acceptanceArtifactPath: resolveOutPath(null),
                    logger,
                    now: () => new Date(),
                    hrtime: () => process.hrtime.bigint(),
                    timedPasses,
                    passesOverridden:
                        parsed.options.passes !== null && parsed.options.passes !== benchmark.protocol.timedPasses,
                    poolPin,
                    // True because the call above holds it for the whole run.
                    stageLockHeld: true,
                    peerReport:
                        parsed.options.compareWith === null ? null : readPeerReport(parsed.options.compareWith),
                    readRepoFile,
                }),
        );

        logger.info('report_written', {
            stage: STAGE,
            out: outPathLabel(outcome.outPath),
            standing: outcome.report.verdict.standing,
            queriesScored: outcome.report.rollups.queriesScored,
            topThreeHitRate: outcome.report.rollups.topThreeHitRate,
            topTenHitRate: outcome.report.rollups.topTenHitRate,
            zeroResultRate: outcome.report.rollups.zeroResultRate,
            p50LatencyMs: outcome.report.latency.p50LatencyMs,
            p95LatencyMs: outcome.report.latency.p95LatencyMs,
            paginationOutcome: outcome.report.paginationCheck.outcome,
        });

        if (outcome.failures.length > 0 || outcome.invariantFailures.length > 0) {
            // Fail-closed: the artefact is written first so the evidence of the
            // shortfall survives, then the run refuses.
            //
            // Every broken invariant is reported with its own code before the
            // exit, and they are reported BEFORE the threshold error is thrown:
            // that error ends this function, and an operator whose ordering is
            // not total needs to be told so even when a threshold was missed as
            // well — the two have different owners and different remedies.
            for (const invariantFailure of outcome.invariantFailures) {
                logger.error('stage_failed', {
                    stage: STAGE,
                    code: invariantFailure.code,
                    out: outPathLabel(outcome.outPath),
                    detail: invariantFailure.detail,
                });
            }

            if (outcome.failures.length > 0) {
                throw new BenchmarkThresholdError(outcome.failures);
            }

            return 1;
        }

        logger.info('stage_completed', {
            stage: STAGE,
            verdict: outcome.report.verdict.overall,
            standing: outcome.report.verdict.standing,
            out: outPathLabel(outcome.outPath),
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
                // Spread, not nested: these are typed facts about the failure
                // (a run id, the stage holding the catalog graph, the mode it
                // asked for), and they read as fields of the failure rather
                // than as one opaque member. Absent for every failure that is
                // not a stage-lock refusal, which is the only branch that
                // supplies them.
                ...failure.detail,
            });
            if (isThrownInstanceOf(error, BenchmarkThresholdError)) {
                for (const missed of error.failures) {
                    fatal.error('threshold_missed', {
                        stage: STAGE,
                        metric: missed.contractKey,
                        measured: missed.measured,
                        // The value the verdict came from, beside the rounded
                        // one: a miss the display figure hides is precisely the
                        // case an operator would otherwise dispute.
                        measuredExact: missed.measuredExact,
                        bound: missed.bound,
                        comparison: missed.comparison,
                        measuredAsCount: missed.measuredAsCount,
                    });
                }
            }
            if (isThrownInstanceOf(error, BenchmarkInputError) && error.detail.length > 0) {
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
