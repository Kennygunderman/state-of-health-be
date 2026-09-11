// Stage 5 of the catalog pipeline: exporting the accepted catalog as a
// versioned release.
//
// WHAT THE STAGE DOES when its inputs are present: it writes the published
// foods, their aliases, portions, components and validation records out to
// data/meal-planning/catalog/releases/v<N>/ as JSONL files plus a manifest.json
// carrying the release id, a SHA-256 per file, the row counts, the source
// dataset versions and the prompt/model versions — the reviewed artefact every
// environment then loads with catalog:load (Agent Action Plan §0.7.1 Group 3).
// A release is produced on a development machine and reviewed as a pull
// request; it is never regenerated during a deployment.
//
// WHAT IT DOES IN THIS REVISION. The coverage plan the release's coverage
// section is computed against, and the identity rules the export groups by
// (src/services/catalog.logic.ts), are Agent Action Plan §0.7.1 Group 3
// deliverables absent from this checkout. This entry point is therefore the
// stage's input contract: it parses its flags, reports the accepted database
// origin, checks every input the export consumes, and refuses, naming either
// the unsatisfied inputs and their remedies or the pipeline module that still
// has to be wired in. No release directory is created and no file is written on
// any path.
//
// THE OVERWRITE RULE is checked here rather than at write time, because a
// release directory is a reviewed artefact: writing over one silently would
// replace a checksummed release that another environment may already have
// loaded. An existing directory is refused unless the operator passes --force.
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
import { ManifestError, assertReleaseVersion, loadCoveragePlan, releaseDir } from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError } from './lib/checkpoint';

const STAGE = 'catalog-release';

const WIRED_BY = 'src/services/catalog.logic.ts with data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3)';

const CATALOG_LOGIC_MODULE = 'src/services/catalog.logic.ts';

const RELEASE_FLAG = '--release';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface ReleaseOptions {
    readonly help: boolean;
    /** The release id exactly as the operator typed it; validated in preflight. */
    readonly release: string;
    readonly force: boolean;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: ReleaseOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

export interface PrerequisiteGap {
    readonly code: string;
    readonly requirement: string;
    readonly remedy: string;
    readonly detail?: string;
}

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

// dbGuard's flag, not this parser's: skipped with its value, never rejected.
// This stage's policy is `any_recognised`, so the flag changes nothing here —
// it is tolerated so an operator running the whole pipeline with one command
// line still gets this stage's usage rather than a parse error.
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
        return { ok: true, options: { help: true, release: '', force: false } };
    }

    const errors: ArgumentError[] = [];
    let release: string | null = null;
    let releaseSeen = false;
    let force = false;

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

        if (flag === RELEASE_FLAG) {
            // Marked seen before its value is read, so a flag given without one
            // is reported as the missing value it is and not additionally as an
            // absent flag — the operator has one thing to fix, not two.
            const alreadySeen = releaseSeen;
            releaseSeen = true;

            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a release id such as v1` });
                continue;
            }
            if (alreadySeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            release = value;
            continue;
        }

        if (flag === '--force') {
            force = true;
            continue;
        }

        if (flag === CONFIRM_TARGET_FLAG) {
            takeValue(inlineValue);
            continue;
        }

        errors.push({ flag, message: `${flag} is not a flag ${STAGE} accepts` });
    }

    // A required flag with no sane default: exporting over the wrong release id
    // is exactly the mistake this command must not be able to make by omission.
    if (!releaseSeen) {
        errors.push({ flag: RELEASE_FLAG, message: `${RELEASE_FLAG} is required; name the release to write, such as v1` });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, release: release === null ? '' : release, force } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:release -- --release <vN> [options]   (${STAGE})`,
        '',
        'Checks every input the catalog export consumes and reports what is missing.',
        'This revision carries no export body, so no release directory is created and',
        'no file is written: the command exits 1 naming either the unsatisfied',
        'prerequisites or the pipeline module that still has to be wired in.',
        '',
        'Options:',
        '  --release <vN>   Required. The release id to write: "v" followed by digits.',
        '                   Names data/meal-planning/catalog/releases/<vN>/.',
        '  --force          Overwrite an existing release directory. Default: off, so',
        '                   an existing reviewed release is refused rather than',
        '                   replaced.',
        '  --help, -h       Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/coverage-plan.v1.json   the per-category published',
        '                                             targets the release\'s coverage',
        '                                             section is computed against',
        '  src/services/catalog.logic.ts              the identity rules the export',
        '                                             groups foods and children by',
        '',
        'Environment:',
        '  DATABASE_URL   required; classified by scripts/lib/dbGuard.ts. The published',
        '                 rows that make up the release are read from it.',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface ReleasePreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly release: string;
    readonly force: boolean;
    readonly loadCoveragePlan: () => unknown;
    /** manifest.ts's release id rule, seamed so the invalid-id branch is testable. */
    readonly assertReleaseVersion: (release: string) => string;
    /** Absolute directory for a validated release id. */
    readonly releaseDir: (release: string) => string;
    readonly directoryExists: (absolutePath: string) => boolean;
    /** Repository-relative existence check. */
    readonly fileExists: (repoRelativePath: string) => boolean;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const directoryExistsOnDisk = (absolutePath: string): boolean => {
    try {
        return fs.statSync(absolutePath).isDirectory();
    } catch {
        // Absent, or a path component that is not a directory. Either way there
        // is no release directory here to refuse.
        return false;
    }
};

const defaultPreflightDeps = (release: string, force: boolean): ReleasePreflightDeps => ({
    env: process.env,
    release,
    force,
    loadCoveragePlan,
    assertReleaseVersion,
    releaseDir,
    directoryExists: directoryExistsOnDisk,
    fileExists: repoFileExists,
});

export const preflight = (deps: ReleasePreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    // The id is checked first and its failure stops the directory check: every
    // path this stage would write is built from it, so an unvalidated id has no
    // directory to reason about.
    let releaseValid = true;
    try {
        deps.assertReleaseVersion(deps.release);
    } catch (error) {
        if (error instanceof ManifestError) {
            releaseValid = false;
            gaps.push({
                code: 'release_id_invalid',
                requirement: 'The --release value must be "v" followed by digits, and a single path segment',
                remedy: 'Pass a release id such as --release v1.',
                detail: `${error.code}: ${error.message}`,
            });
        } else {
            throw error;
        }
    }

    if (releaseValid && !deps.force) {
        const directory = deps.releaseDir(deps.release);
        if (deps.directoryExists(directory)) {
            gaps.push({
                code: 'release_directory_exists',
                requirement: `Release ${deps.release} must not already exist: a release directory is a reviewed, checksummed artefact other environments load`,
                remedy: `Choose the next release id, or pass --force to overwrite data/meal-planning/catalog/releases/${deps.release}.`,
            });
        }
    }

    try {
        deps.loadCoveragePlan();
    } catch (error) {
        if (error instanceof ManifestError) {
            gaps.push({
                code: 'coverage_plan_unavailable',
                requirement:
                    'data/meal-planning/coverage-plan.v1.json must load and declare coveragePlanVersion v1: the release manifest records the plan version it was produced against and its per-category coverage',
                remedy: 'Add the 21-category coverage plan at data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3).',
                detail: `${error.code}: ${error.message}`,
            });
        } else {
            throw error;
        }
    }

    if (!deps.fileExists(CATALOG_LOGIC_MODULE)) {
        gaps.push({
            code: 'catalog_logic_absent',
            requirement: `${CATALOG_LOGIC_MODULE} must exist: the export groups foods and their children by its identity rules`,
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
    logger.info('stage_invoked', { stage: STAGE, release: parsed.options.release, force: parsed.options.force });

    const gaps = preflight(defaultPreflightDeps(parsed.options.release, parsed.options.force));
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
