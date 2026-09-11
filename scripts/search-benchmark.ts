// The catalog search benchmark: measures the in-process search against the
// committed query set and writes the report the release gate reads.
//
// WHAT THE STAGE DOES when its inputs are present: it runs every query in
// data/meal-planning/search-benchmark.v1.json against the loaded catalog
// through src/services/catalog.service.ts — in process, so what is measured is
// the search itself and not an HTTP round trip — repeats the set once per pass
// to separate warm from cold timings, and writes latency percentiles, the
// expected-canonical-id hit rate and the measurement conditions to
// data/meal-planning/reports/latest/benchmark-report.json (Agent Action Plan
// §0.7.1 Group 3, §0.9.3).
//
// WHAT IT DOES IN THIS REVISION. Neither the query set nor the search service
// exists in this checkout: data/meal-planning/search-benchmark.v1.json and
// src/services/catalog.service.ts are Agent Action Plan §0.7.1 Group 3
// deliverables. This entry point is therefore the stage's input contract: it
// parses its flags, reports the accepted database origin, checks the inputs the
// benchmark consumes, and refuses, naming either the unsatisfied inputs and
// their remedies or the pipeline module that still has to be wired in. No query
// is issued and no report is written on any path — an empty or stale benchmark
// report must never be mistakable for a measured one.
//
// The two guard imports are ordered and load-bearing: Rule
// backend-architecture §10's IPv4-first DNS ordering, then dbGuard's
// module-load classification of DATABASE_URL, both ahead of anything that
// could reach Prisma or the network.
import './lib/bootstrap';
import './lib/dbGuard';

import fs from 'fs';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel } from './lib/logger';
import { ManifestError, loadSearchBenchmark, reportPath } from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError } from './lib/checkpoint';

const STAGE = 'search-benchmark';

const WIRED_BY =
    'src/services/catalog.service.ts with data/meal-planning/search-benchmark.v1.json (AAP §0.7.1 Group 3)';

const CATALOG_SERVICE_MODULE = 'src/services/catalog.service.ts';

/** The §0.3.3 artefact name; `--out` overrides the location, not the content. */
const DEFAULT_REPORT_FILE = 'benchmark-report.json';

/**
 * Three passes, because one pass cannot separate a cold cache from the steady
 * state and two cannot show whether the second was representative. It is the
 * protocol §0.9.3 reports, so it is the default rather than a tuning knob.
 */
export const DEFAULT_PASSES = 3;

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface BenchmarkOptions {
    readonly help: boolean;
    /** `--out`; `null` means the default artefact path. */
    readonly out: string | null;
    /** `--passes`; always a positive integer, defaulted to DEFAULT_PASSES. */
    readonly passes: number;
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
        return { ok: true, options: { help: true, out: null, passes: DEFAULT_PASSES } };
    }

    const errors: ArgumentError[] = [];
    let out: string | null = null;
    let outSeen = false;
    let passes = DEFAULT_PASSES;
    let passesSeen = false;

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
            if (passesSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            passesSeen = true;
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

    return { ok: true, options: { help: false, out, passes } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run search:benchmark -- [options]   (${STAGE})`,
        '',
        'Checks every input the search benchmark consumes and reports what is missing.',
        'This revision carries no benchmark body, so no query is issued and no report',
        'is written: the command exits 1 naming either the unsatisfied prerequisites',
        'or the pipeline module that still has to be wired in.',
        '',
        'Options:',
        '  --out <path>     Write the report to this path instead of the default.',
        '                   A relative path resolves against the backend package root.',
        `                   Default: data/meal-planning/reports/latest/${DEFAULT_REPORT_FILE}`,
        `  --passes <n>     Times the whole query set is run, so a cold first pass can`,
        '                   be separated from the steady state. Positive integer.',
        `                   Default: ${DEFAULT_PASSES}.`,
        '  --help, -h       Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/search-benchmark.v1.json   the query set with the',
        '                                                expected canonical id per query',
        '                                                and the latency thresholds',
        '  src/services/catalog.service.ts               the in-process search the',
        '                                                benchmark times',
        '',
        'Environment:',
        '  DATABASE_URL   required; classified by scripts/lib/dbGuard.ts. The catalog',
        '                 the queries run against is the one loaded in it.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

/**
 * Where the report would be written. `null` takes manifest.ts's validated
 * artefact path; an operator value is resolved against the backend package
 * root so the command is working-directory independent.
 */
export const resolveOutPath = (out: string | null): string =>
    out === null ? reportPath(DEFAULT_REPORT_FILE) : path.resolve(__dirname, '..', out);

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface BenchmarkPreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly loadSearchBenchmark: () => unknown;
    /** Repository-relative existence check, seamed so preflight stays testable. */
    readonly fileExists: (repoRelativePath: string) => boolean;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const defaultPreflightDeps = (): BenchmarkPreflightDeps => ({
    env: process.env,
    loadSearchBenchmark,
    fileExists: repoFileExists,
});

export const preflight = (deps: BenchmarkPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    try {
        deps.loadSearchBenchmark();
    } catch (error) {
        if (error instanceof ManifestError) {
            gaps.push({
                code: 'search_benchmark_unavailable',
                requirement:
                    'data/meal-planning/search-benchmark.v1.json must load and declare benchmarkVersion v1: it is the query set, the expected ids and the thresholds',
                remedy: 'Add the benchmark query set at data/meal-planning/search-benchmark.v1.json (at least 250 queries, AAP §0.7.1 Group 3).',
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
// Reporting.
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
    if (error instanceof ModelBudgetError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof CheckpointError) {
        return { code: error.code, error: safeError(error) };
    }
    if (error instanceof RateLimitConfigError) {
        return { code: 'rate_limit_misconfigured', error: safeError(error) };
    }
    return { code: 'unexpected_error', error: safeError(error) };
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
    // The destination is resolved and logged before the inputs are checked, so
    // a refusal still tells the operator which file a measured run would have
    // produced.
    logger.info('stage_invoked', {
        stage: STAGE,
        out: resolveOutPath(parsed.options.out),
        passes: parsed.options.passes,
    });

    const gaps = preflight(defaultPreflightDeps());
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    logger.error('stage_pipeline_pending', { stage: STAGE, wiredBy: WIRED_BY });
    return 1;
};

// Guarded so importing this module for parseArgs, preflight or describeUsage
// never runs the stage.
if (require.main === module) {
    main()
        .then((exitCode) => {
            process.exit(exitCode);
        })
        .catch((error: unknown) => {
            const failure = describeFailure(error);
            createFatalLogger(STAGE).error('stage_failed', {
                stage: STAGE,
                code: failure.code,
                error: failure.error,
            });
            process.exit(1);
        });
}
