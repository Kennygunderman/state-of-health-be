// Stage 4 of the catalog pipeline: the coverage and quality report.
//
// WHAT THE STAGE DOES when its inputs are present: it reads the published,
// candidate and quarantined counts out of `catalog_foods` and
// `catalog_validation_records`, compares each category against its
// `publishedTarget` in data/meal-planning/coverage-plan.v1.json, and writes
// counts, duplicate identities, quarantine reasons and the **exact** per-category
// shortfall to data/meal-planning/reports/latest/validation-report.json — the
// artefact the release gate reads (Agent Action Plan §0.7.1 Group 3). A
// shortfall is reported exactly and never rounded: it is an unmet requirement,
// not a metric.
//
// WHAT IT DOES IN THIS REVISION. The coverage plan the shortfall is measured
// against, and the identity and grouping rules the duplicate section needs
// (src/services/catalog.logic.ts), are Agent Action Plan §0.7.1 Group 3
// deliverables absent from this checkout. This entry point is therefore the
// stage's input contract: it parses its flags, reports the accepted database
// origin, checks every input the report consumes, and refuses, naming either
// the unsatisfied inputs and their remedies or the pipeline module that still
// has to be wired in. No report file is written on any path, so an operator can
// never mistake a stale or empty report for a fresh one.
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
import { ManifestError, loadCoveragePlan, reportPath } from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError } from './lib/checkpoint';

const STAGE = 'catalog-report';

const WIRED_BY = 'src/services/catalog.logic.ts with data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3)';

const CATALOG_LOGIC_MODULE = 'src/services/catalog.logic.ts';

/** The §0.3.3 artefact name; `--out` overrides the location, not the content. */
const DEFAULT_REPORT_FILE = 'validation-report.json';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface ReportOptions {
    readonly help: boolean;
    /**
     * `--out`; `null` means the default artefact path. A relative value is
     * resolved against the backend package root by `resolveOutPath` below, so
     * the same command writes the same file from any working directory.
     */
    readonly out: string | null;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: ReportOptions }
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
        return { ok: true, options: { help: true, out: null } };
    }

    const errors: ArgumentError[] = [];
    let out: string | null = null;
    let outSeen = false;

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

        if (flag === CONFIRM_TARGET_FLAG) {
            takeValue(inlineValue);
            continue;
        }

        errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, out } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:report -- [options]   (${STAGE})`,
        '',
        'Checks every input the catalog report consumes and reports what is missing.',
        'This revision carries no report body, so no file is written on any path: the',
        'command exits 1 naming either the unsatisfied prerequisites or the pipeline',
        'module that still has to be wired in.',
        '',
        'Options:',
        '  --out <path>   Write the report to this path instead of the default.',
        '                 A relative path resolves against the backend package root.',
        `                 Default: data/meal-planning/reports/latest/${DEFAULT_REPORT_FILE}`,
        '  --help, -h     Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/coverage-plan.v1.json   the per-category published',
        '                                             targets every shortfall is',
        '                                             measured against',
        '  src/services/catalog.logic.ts              the identity and grouping rules',
        '                                             the duplicate section needs',
        '',
        'Environment:',
        '  DATABASE_URL   required; classified by scripts/lib/dbGuard.ts. The counts',
        '                 come from catalog_foods and catalog_validation_records in it.',
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

export interface ReportPreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly loadCoveragePlan: () => unknown;
    /** Repository-relative existence check, seamed so preflight stays testable. */
    readonly fileExists: (repoRelativePath: string) => boolean;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const defaultPreflightDeps = (): ReportPreflightDeps => ({
    env: process.env,
    loadCoveragePlan,
    fileExists: repoFileExists,
});

// A document that fails for one of manifest.ts's own documented reasons is a
// prerequisite gap with a remedy; anything else is an environment fault and is
// rethrown to main's narrowing catch rather than flattened into a gap.
const manifestGap = (
    load: () => unknown,
    code: string,
    requirement: string,
    remedy: string,
): PrerequisiteGap | null => {
    try {
        load();
        return null;
    } catch (error) {
        if (error instanceof ManifestError) {
            return { code, requirement, remedy, detail: `${error.code}: ${error.message}` };
        }
        throw error;
    }
};

export const preflight = (deps: ReportPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    const plan = manifestGap(
        deps.loadCoveragePlan,
        'coverage_plan_unavailable',
        'data/meal-planning/coverage-plan.v1.json must load and declare coveragePlanVersion v1: without it there is no published target to measure a shortfall against',
        'Add the 21-category coverage plan at data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3).',
    );
    if (plan !== null) {
        gaps.push(plan);
    }

    if (!deps.fileExists(CATALOG_LOGIC_MODULE)) {
        gaps.push({
            code: 'catalog_logic_absent',
            requirement: `${CATALOG_LOGIC_MODULE} must exist: the duplicate and coverage sections are grouped by its identity rules`,
            remedy: `Land ${CATALOG_LOGIC_MODULE} with its unit suite (AAP §0.7.1 Group 3).`,
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
    // a refusal still tells the operator which file a successful run would
    // have produced. Resolving it can itself fail — manifest.ts validates the
    // default artefact path — which main's narrowing catch reports as the
    // ManifestError it is.
    logger.info('stage_invoked', { stage: STAGE, out: resolveOutPath(parsed.options.out) });

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
