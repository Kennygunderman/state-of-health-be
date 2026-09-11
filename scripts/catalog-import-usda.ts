// Stage 1 of the catalog pipeline: the USDA FoodData Central import.
//
// WHAT THE STAGE DOES when its inputs are present: it walks the curated FDC ids
// in data/meal-planning/usda-manifest.v1.json, fetches them in batches through
// the rate-limited USDA client, normalises each record with
// src/services/catalog.logic.ts, upserts it on `source_key` as a candidate or a
// quarantined row, and writes the inserted/updated/rejected/missing counts to
// data/meal-planning/reports/latest/import-report.json, checkpointing its
// cursor into `catalog_import_runs` so an interruption resumes rather than
// restarts (Agent Action Plan §0.7.1 Group 3).
//
// WHAT IT DOES IN THIS REVISION. Neither the manifest nor the coverage plan nor
// the normaliser exists in this checkout — `data/meal-planning/` holds only
// `evidence-allowlist.v1.json`, and `src/services/catalog.logic.ts` is an Agent
// Action Plan §0.7.1 Group 3 deliverable that has not landed. This entry point
// is therefore the pipeline's *input contract*, and it is exactly that: it
// parses its flags, reports the database origin the guard accepted, checks every
// input the import consumes, and refuses — loudly and with the remedy for each
// missing input — rather than acting. It opens no USDA connection and writes
// nothing to the database on any path. When every input is present the refusal
// changes its reason: the inputs being there means the Group 3 pipeline module
// has landed and this file predates its wiring, which is a different fix and
// gets a different log event.
//
// The two guard imports below are load-bearing and ordered. Rule
// backend-architecture §10 requires the IPv4-first DNS ordering before any
// network module loads, and dbGuard classifies DATABASE_URL at module load —
// TypeScript's CommonJS emit hoists requires in source order, so these two
// running first is what puts both ahead of anything that could reach Prisma or
// the network.
import './lib/bootstrap';
import './lib/dbGuard';

import fs from 'fs';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel } from './lib/logger';
import { ManifestError, loadCoveragePlan, loadUsdaManifest } from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError, getUsdaImportRateLimitPerHour } from './lib/rateLimiter';
import { CheckpointError } from './lib/checkpoint';

const STAGE = 'catalog-import-usda';

/** The module(s) that will carry this stage's body, named in every refusal. */
const WIRED_BY = 'src/services/catalog.logic.ts with data/meal-planning/usda-manifest.v1.json (AAP §0.7.1 Group 3)';

const USDA_API_KEY_ENV = 'USDA_API_KEY';

const CATALOG_LOGIC_MODULE = 'src/services/catalog.logic.ts';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure, so every branch below is decided without touching
// `process`, the filesystem or the clock (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface ImportOptions {
    /** `--help`/`-h`; when true nothing else in this object has been honoured. */
    readonly help: boolean;
    /** `--category`, repeatable. Empty means every category in the coverage plan. */
    readonly categories: readonly string[];
    /** `--limit`; `null` means "no limit", which is not the same as 0. */
    readonly limit: number | null;
    readonly resume: boolean;
    readonly dryRun: boolean;
}

export interface ArgumentError {
    /** The flag or token the operator has to change. */
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: ImportOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

/** One input the stage consumes that is not satisfied. */
export interface PrerequisiteGap {
    /** Stable across revisions: it is what a log consumer greps for. */
    readonly code: string;
    readonly requirement: string;
    /** Names the file to create or the command that produces it. */
    readonly remedy: string;
    /** The narrowed failure behind the gap, when one was observed. */
    readonly detail?: string;
}

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

// dbGuard owns this flag: it reads it straight off process.argv at module load
// to satisfy the `development_or_confirmed` policy. It is accepted and skipped
// here (value included, so it is not mistaken for a positional argument) rather
// than rejected, because an operator who passes it to any stage should get that
// stage's usage, not a parse error about a flag the pipeline does define.
const CONFIRM_TARGET_FLAG = '--confirm-target';

interface Token {
    readonly flag: string;
    /** The `--flag=value` form's value; `null` when the token carried none. */
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
    // Help is answered whatever else is on the line: an operator asking how to
    // use the command must not have to write a valid command line first.
    if (argv.some((token) => HELP_FLAGS.includes(token))) {
        return { ok: true, options: { help: true, categories: [], limit: null, resume: false, dryRun: false } };
    }

    const errors: ArgumentError[] = [];
    const categories: string[] = [];
    let limit: number | null = null;
    let limitSeen = false;
    let resume = false;
    let dryRun = false;

    let index = 0;
    // Reads a flag's value from either form. A following token that is itself a
    // flag is never consumed as a value — `--limit --resume` is a missing value,
    // not a limit of "--resume".
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

        if (flag === '--category') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a coverage-plan category name` });
                continue;
            }
            categories.push(value);
            continue;
        }

        if (flag === '--limit') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a positive integer` });
                continue;
            }
            if (limitSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            limitSeen = true;
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                errors.push({ flag, message: `${flag} must be a positive integer` });
                continue;
            }
            limit = parsed;
            continue;
        }

        if (flag === '--resume') {
            resume = true;
            continue;
        }

        if (flag === '--dry-run') {
            dryRun = true;
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

    return { ok: true, options: { help: false, categories, limit, resume, dryRun } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:import -- [options]   (${STAGE})`,
        '',
        'Checks every input the USDA import consumes and reports what is missing.',
        'This revision carries no import body, so the command never writes to the',
        'database and never calls USDA: it exits 1 naming either the unsatisfied',
        'prerequisites or the pipeline module that still has to be wired in.',
        '',
        'Options:',
        '  --category <name>   Restrict the import to one coverage-plan category.',
        '                      Repeatable. Default: every category in the coverage plan.',
        '  --limit <n>         Stop after n manifest records. Positive integer.',
        '                      Default: no limit.',
        '  --resume            Continue this stage\'s newest unfinished run from its',
        '                      stored cursor instead of starting a new one.',
        '                      Default: off (a new run).',
        '  --dry-run           Report what the import would write without writing it.',
        '                      Default: off.',
        '  --help, -h          Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/usda-manifest.v1.json   curated FDC ids, per-category',
        '  data/meal-planning/coverage-plan.v1.json   category targets and bounds',
        '  src/services/catalog.logic.ts              the per-100g normaliser every',
        '                                             record is written through',
        '',
        'Environment:',
        '  DATABASE_URL                      required; classified by scripts/lib/dbGuard.ts',
        '  USDA_API_KEY                      required; the FoodData Central key',
        '  USDA_IMPORT_RATE_LIMIT_PER_HOUR   optional; integer 1-1000, default 900',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface ImportPreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly loadUsdaManifest: () => unknown;
    readonly loadCoveragePlan: () => unknown;
    readonly resolveRateLimit: (env: NodeJS.ProcessEnv) => number;
    /** Repository-relative existence check, seamed so preflight stays testable. */
    readonly fileExists: (repoRelativePath: string) => boolean;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const defaultPreflightDeps = (): ImportPreflightDeps => ({
    env: process.env,
    loadUsdaManifest,
    loadCoveragePlan,
    resolveRateLimit: getUsdaImportRateLimitPerHour,
    fileExists: repoFileExists,
});

// A manifest that fails for its own documented reasons is a prerequisite gap
// with a remedy; anything else (a permission fault, a directory where a file
// belongs) is an environment problem the caller must see as itself, so it is
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

export const preflight = (deps: ImportPreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    const manifest = manifestGap(
        deps.loadUsdaManifest,
        'usda_manifest_unavailable',
        'data/meal-planning/usda-manifest.v1.json must load and declare usdaManifestVersion v1',
        'Add the curated FDC id manifest at data/meal-planning/usda-manifest.v1.json (AAP §0.7.1 Group 3).',
    );
    if (manifest !== null) {
        gaps.push(manifest);
    }

    const plan = manifestGap(
        deps.loadCoveragePlan,
        'coverage_plan_unavailable',
        'data/meal-planning/coverage-plan.v1.json must load and declare coveragePlanVersion v1',
        'Add the 21-category coverage plan at data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3).',
    );
    if (plan !== null) {
        gaps.push(plan);
    }

    const usdaApiKey = deps.env[USDA_API_KEY_ENV];
    if (usdaApiKey === undefined || usdaApiKey.trim().length === 0) {
        gaps.push({
            code: 'usda_api_key_missing',
            requirement: `${USDA_API_KEY_ENV} must be set: every manifest record is fetched from FoodData Central`,
            remedy: `Set ${USDA_API_KEY_ENV} in backend/.env (see .env.example) or in the environment.`,
        });
    }

    try {
        deps.resolveRateLimit(deps.env);
    } catch (error) {
        if (error instanceof RateLimitConfigError) {
            gaps.push({
                code: 'usda_rate_limit_misconfigured',
                requirement:
                    'USDA_IMPORT_RATE_LIMIT_PER_HOUR must resolve to an integer within the vendor cap so every fetch is paced',
                remedy: 'Set USDA_IMPORT_RATE_LIMIT_PER_HOUR to an integer between 1 and 1000, or unset it to take the default of 900.',
                detail: error.message,
            });
        } else {
            throw error;
        }
    }

    if (!deps.fileExists(CATALOG_LOGIC_MODULE)) {
        gaps.push({
            code: 'catalog_logic_absent',
            requirement: `${CATALOG_LOGIC_MODULE} must exist: it normalises every USDA record to per-100g before the upsert`,
            remedy: `Land ${CATALOG_LOGIC_MODULE} with its unit suite (AAP §0.7.1 Group 3).`,
        });
    }

    return gaps;
};

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

// One field per gap, keyed by the gap's stable code, so a refusal is greppable
// by code and readable in one line per prerequisite.
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

// Every error class this file can observe gets its own reported code, so an
// operator never has to read a stack trace to know which layer refused. The
// three library classes carry a `code` of their own; RateLimitConfigError
// carries its numbers instead, so it is reported under a fixed code. Anything
// unrecognised is reported through safeError under `unexpected_error` — it is
// never swallowed and never printed raw, because a raw error on this pipeline
// can carry a connection URL or a vendor key.
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

    // The URL itself never reaches the log — only the classification, the host
    // and the database name. dbGuard has already refused anything it could not
    // classify, so reaching this line means the origin was accepted.
    const origin = classifyDatabaseOrigin(process.env.DATABASE_URL);
    logger.info('database_origin_accepted', {
        stage: STAGE,
        originClass: origin.originClass,
        host: origin.host,
        database: origin.database,
        reason: origin.reason,
    });
    logger.info('stage_invoked', {
        stage: STAGE,
        categories: parsed.options.categories,
        limit: parsed.options.limit,
        resume: parsed.options.resume,
        dryRun: parsed.options.dryRun,
    });

    const gaps = preflight(defaultPreflightDeps());
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    // Every input is present, so the Group 3 pipeline module has landed and
    // this entry point predates its wiring. Reported as its own event because
    // the fix is a code change here, not an artefact to create.
    logger.error('stage_pipeline_pending', { stage: STAGE, wiredBy: WIRED_BY });
    return 1;
};

// Guarded so importing this module — which is how the later boundary's suites
// reach parseArgs, preflight and describeUsage — never runs the stage.
if (require.main === module) {
    main()
        .then((exitCode) => {
            process.exit(exitCode);
        })
        .catch((error: unknown) => {
            // createFatalLogger, not `logger`: the next statement discards
            // whatever is still buffered on process.stderr.
            const failure = describeFailure(error);
            createFatalLogger(STAGE).error('stage_failed', {
                stage: STAGE,
                code: failure.code,
                error: failure.error,
            });
            process.exit(1);
        });
}
