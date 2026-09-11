// Stage 3 of the catalog pipeline: validation and publication.
//
// WHAT THE STAGE DOES when its inputs are present: it runs the deterministic
// checks and per-category bounds from data/meal-planning/coverage-plan.v1.json
// over every candidate row, optionally spends one advisory review model call on
// the cases the deterministic checks cannot settle, writes one
// `catalog_validation_records` row per decision, publishes what passed and
// quarantines what did not (Agent Action Plan §0.7.1 Group 3). The advisory
// review shares the single CATALOG_MODEL_CALL_BUDGET cap with generation, which
// is why this stage resolves that cap even though it is not the stage that
// produces candidates.
//
// WHAT IT DOES IN THIS REVISION. The coverage plan — which carries the check
// names, the kcal review ranges and the validation bounds — and the checks
// themselves (src/services/catalog.logic.ts) are Agent Action Plan §0.7.1
// Group 3 deliverables absent from this checkout. This entry point is
// therefore the stage's input contract: it parses its flags, reports the
// accepted database origin, checks every input validation consumes, and
// refuses, naming either the unsatisfied inputs and their remedies or the
// pipeline module that still has to be wired in. Nothing is published,
// quarantined or reviewed on any path.
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
import { ManifestError, loadCoveragePlan, loadEvidenceAllowlist } from './lib/manifest';
import { ModelBudgetError, getCatalogModelCallBudget } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError } from './lib/checkpoint';

const STAGE = 'catalog-validate';

const WIRED_BY = 'src/services/catalog.logic.ts with data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3)';

const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';

const CATALOG_LOGIC_MODULE = 'src/services/catalog.logic.ts';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface ValidateOptions {
    readonly help: boolean;
    /** `--category`, repeatable. Empty means every category in the coverage plan. */
    readonly categories: readonly string[];
    /** `--revalidate-quarantined`: re-run the checks over quarantined rows too. */
    readonly revalidateQuarantined: boolean;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: ValidateOptions }
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
        return { ok: true, options: { help: true, categories: [], revalidateQuarantined: false } };
    }

    const errors: ArgumentError[] = [];
    const categories: string[] = [];
    let revalidateQuarantined = false;

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

        if (flag === '--category') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a coverage-plan category name` });
                continue;
            }
            categories.push(value);
            continue;
        }

        if (flag === '--revalidate-quarantined') {
            revalidateQuarantined = true;
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

    return { ok: true, options: { help: false, categories, revalidateQuarantined } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:validate -- [options]   (${STAGE})`,
        '',
        'Checks every input catalog validation consumes and reports what is missing.',
        'This revision carries no validation body, so the command publishes nothing,',
        'quarantines nothing and makes no review call: it exits 1 naming either the',
        'unsatisfied prerequisites or the pipeline module that still has to be',
        'wired in.',
        '',
        'Options:',
        '  --category <name>           Restrict validation to one coverage-plan',
        '                              category. Repeatable. Default: every category',
        '                              in the coverage plan.',
        '  --revalidate-quarantined    Re-run the checks over rows already quarantined,',
        '                              so a bounds or evidence fix can release them.',
        '                              Default: off (candidates only).',
        '  --help, -h                  Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/coverage-plan.v1.json      check names, per-category kcal',
        '                                                review ranges and bounds',
        '  data/meal-planning/evidence-allowlist.v1.json the policy a candidate\'s',
        '                                                identity evidence is judged against',
        '  src/services/catalog.logic.ts                 the deterministic checks',
        '',
        'Environment:',
        '  DATABASE_URL                 required; classified by scripts/lib/dbGuard.ts',
        '  CATALOG_MODEL_CALL_BUDGET    required positive integer; the advisory review',
        '                               call shares this cap with catalog:generate',
        '  OPENROUTER_API_KEY           required only for the advisory review call',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// Preflight.
// ---------------------------------------------------------------------------

export interface ValidatePreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly loadCoveragePlan: () => unknown;
    readonly loadEvidenceAllowlist: () => unknown;
    readonly resolveModelCallBudget: (env: NodeJS.ProcessEnv) => number;
    /** Repository-relative existence check, seamed so preflight stays testable. */
    readonly fileExists: (repoRelativePath: string) => boolean;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const defaultPreflightDeps = (): ValidatePreflightDeps => ({
    env: process.env,
    loadCoveragePlan,
    loadEvidenceAllowlist,
    resolveModelCallBudget: getCatalogModelCallBudget,
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

export const preflight = (deps: ValidatePreflightDeps): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    const plan = manifestGap(
        deps.loadCoveragePlan,
        'coverage_plan_unavailable',
        'data/meal-planning/coverage-plan.v1.json must load and declare coveragePlanVersion v1: it carries the check names and the bounds every decision is made against',
        'Add the 21-category coverage plan at data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3).',
    );
    if (plan !== null) {
        gaps.push(plan);
    }

    const allowlist = manifestGap(
        deps.loadEvidenceAllowlist,
        'evidence_allowlist_unavailable',
        'data/meal-planning/evidence-allowlist.v1.json must load and pass its shape check: a candidate\'s identity evidence is judged against it',
        'Restore data/meal-planning/evidence-allowlist.v1.json to a document declaring allowlistVersion v1 with its host classes and specialPurposeRanges table.',
    );
    if (allowlist !== null) {
        gaps.push(allowlist);
    }

    try {
        deps.resolveModelCallBudget(deps.env);
    } catch (error) {
        if (error instanceof ModelBudgetError) {
            gaps.push({
                code: 'model_call_budget_unresolved',
                requirement:
                    'CATALOG_MODEL_CALL_BUDGET must be a positive integer: the advisory review call is metered against the same cap as generation and has no default',
                remedy: 'Set CATALOG_MODEL_CALL_BUDGET in backend/.env (see .env.example) to the maximum number of model calls this run may spend.',
                detail: `${error.code}: ${error.message}`,
            });
        } else {
            throw error;
        }
    }

    // Reported as its own gap rather than folded into the budget one: the
    // advisory review is the only part of this stage that spends, so an
    // operator who has no key still needs to know the deterministic checks are
    // all they will get.
    const openRouterKey = deps.env[OPENROUTER_API_KEY_ENV];
    if (openRouterKey === undefined || openRouterKey.trim().length === 0) {
        gaps.push({
            code: 'openrouter_api_key_missing',
            requirement: `${OPENROUTER_API_KEY_ENV} must be set for the advisory review pass over the cases the deterministic checks cannot settle`,
            remedy: `Set ${OPENROUTER_API_KEY_ENV} in backend/.env (see .env.example) or in the environment.`,
        });
    }

    if (!deps.fileExists(CATALOG_LOGIC_MODULE)) {
        gaps.push({
            code: 'catalog_logic_absent',
            requirement: `${CATALOG_LOGIC_MODULE} must exist: it holds the deterministic validation checks and the category bounds`,
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
    logger.info('stage_invoked', {
        stage: STAGE,
        categories: parsed.options.categories,
        revalidateQuarantined: parsed.options.revalidateQuarantined,
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
