// Stage 2 of the catalog pipeline: AI generation of the candidates the USDA
// import could not supply.
//
// WHAT THE STAGE DOES when its inputs are present: it derives one batch per
// `ceil(aiCandidates / CATALOG_BATCH_SIZE)` from data/meal-planning/coverage-plan.v1.json,
// reserves each model call against CATALOG_MODEL_CALL_BUDGET in
// `catalog_generation_batches` *before* spending it, prompts OpenRouter for
// generic preparations only, retrieves identity evidence through
// src/services/evidence.service.ts under the allowlist policy, dedupes against
// `source_key`, canonical names and aliases, and resumes from the batches that
// are not yet validated (Agent Action Plan §0.7.1 Group 3).
//
// WHAT IT DOES IN THIS REVISION. The coverage plan, the generation prompt's
// normaliser (src/services/catalog.logic.ts) and the evidence retrieval service
// (src/services/evidence.service.ts) are Agent Action Plan §0.7.1 Group 3
// deliverables absent from this checkout; the evidence allowlist
// (data/meal-planning/evidence-allowlist.v1.json) is present and this entry
// point proves it loads. So the file is the stage's input contract and nothing
// more: it parses its flags, reports the accepted database origin, meters the
// run it *would* make before checking anything else, and then refuses — naming
// either the unsatisfied inputs and their remedies, or the pipeline module that
// still has to be wired in. No OpenRouter call is made and no row is written on
// any path.
//
// METERING FIRST is not presentation. Rule backend-architecture §9 ("meter
// before you spend") is why budget.ts reserves a call ahead of the vendor
// request, and the same order applies to the startup estimate: an operator
// launching an unattended paid run sees what it intends to spend before the run
// decides whether it can proceed at all. So `preflight` runs planBatches and
// assertModelCallBudget as its first act, whenever the plan and the cap can be
// resolved, and only then checks the remaining inputs.
import './lib/bootstrap';
import './lib/dbGuard';

import fs from 'fs';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, ScriptLogger } from './lib/logger';
import { ManifestError, loadCoveragePlan, loadEvidenceAllowlist } from './lib/manifest';
import type { CoveragePlan } from './lib/manifest';
import {
    ModelBudgetError,
    assertModelCallBudget,
    getCatalogBatchSize,
    getCatalogModelCallBudget,
    planBatches,
} from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError } from './lib/checkpoint';

const STAGE = 'catalog-generate-ai';

const WIRED_BY =
    'src/services/catalog.logic.ts and src/services/evidence.service.ts with data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3)';

const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';

const CATALOG_LOGIC_MODULE = 'src/services/catalog.logic.ts';
const EVIDENCE_SERVICE_MODULE = 'src/services/evidence.service.ts';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface GenerateOptions {
    readonly help: boolean;
    /** `--category`, repeatable. Empty means every category in the coverage plan. */
    readonly categories: readonly string[];
    /** `--batch-size`; `null` means "take CATALOG_BATCH_SIZE, or its default". */
    readonly batchSize: number | null;
    readonly resume: boolean;
    readonly dryRun: boolean;
}

export interface ArgumentError {
    readonly flag: string;
    readonly message: string;
}

export type ParseResult =
    | { readonly ok: true; readonly options: GenerateOptions }
    | { readonly ok: false; readonly errors: readonly ArgumentError[] };

export interface PrerequisiteGap {
    readonly code: string;
    readonly requirement: string;
    readonly remedy: string;
    readonly detail?: string;
}

const HELP_FLAGS: readonly string[] = ['--help', '-h'];

// dbGuard's flag, not this parser's: accepted and skipped with its value so it
// is never mistaken for a positional argument, and never rejected.
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
        return { ok: true, options: { help: true, categories: [], batchSize: null, resume: false, dryRun: false } };
    }

    const errors: ArgumentError[] = [];
    const categories: string[] = [];
    let batchSize: number | null = null;
    let batchSizeSeen = false;
    let resume = false;
    let dryRun = false;

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

        if (flag === '--batch-size') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a positive integer` });
                continue;
            }
            if (batchSizeSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            batchSizeSeen = true;
            const parsed = Number(value);
            if (!Number.isInteger(parsed) || parsed <= 0) {
                errors.push({ flag, message: `${flag} must be a positive integer` });
                continue;
            }
            batchSize = parsed;
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

    return { ok: true, options: { help: false, categories, batchSize, resume, dryRun } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:generate -- [options]   (${STAGE})`,
        '',
        'Meters the generation run it would make, checks every input AI generation',
        'consumes, and reports what is missing. This revision carries no generation',
        'body, so the command never calls OpenRouter and never writes a row: it',
        'exits 1 naming either the unsatisfied prerequisites or the pipeline module',
        'that still has to be wired in.',
        '',
        'Options:',
        '  --category <name>   Restrict generation to one coverage-plan category.',
        '                      Repeatable. Default: every category in the coverage plan.',
        '  --batch-size <n>    Candidates per batch, overriding CATALOG_BATCH_SIZE for',
        '                      this run. Positive integer. Default: CATALOG_BATCH_SIZE,',
        '                      or 25 when it is unset.',
        '  --resume            Continue this stage\'s newest unfinished run, addressing',
        '                      the same batch keys and spending what is left of that',
        '                      run\'s budget. Default: off (a new run).',
        '  --dry-run           Report the batches and the budget without spending it.',
        '                      Default: off.',
        '  --help, -h          Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/coverage-plan.v1.json      per-category candidate volume,',
        '                                                prompt version and the model',
        '                                                calls one batch costs',
        '  data/meal-planning/evidence-allowlist.v1.json permitted evidence host classes',
        '  src/services/evidence.service.ts              identity-evidence retrieval',
        '  src/services/catalog.logic.ts                 candidate normalisation and dedupe',
        '',
        'Environment:',
        '  DATABASE_URL                 required; classified by scripts/lib/dbGuard.ts',
        '  OPENROUTER_API_KEY           required; the generation and review model key',
        '  CATALOG_MODEL_CALL_BUDGET    required positive integer; the hard cap on model',
        '                               calls for one run, with no default',
        '  CATALOG_BATCH_SIZE           optional positive integer, default 25',
    ].join('\n');

const writeUsage = (level: LogLevel): void => {
    writeLineSync(describeUsage(), level);
};

// ---------------------------------------------------------------------------
// Preflight, metering first.
// ---------------------------------------------------------------------------

export interface GeneratePreflightDeps {
    readonly env: NodeJS.ProcessEnv;
    readonly loadCoveragePlan: () => CoveragePlan;
    readonly loadEvidenceAllowlist: () => unknown;
    readonly resolveModelCallBudget: (env: NodeJS.ProcessEnv) => number;
    readonly resolveBatchSize: (env: NodeJS.ProcessEnv) => number;
    /** Repository-relative existence check, seamed so preflight stays testable. */
    readonly fileExists: (repoRelativePath: string) => boolean;
    /** `--batch-size` when the operator gave one; `null` to take the environment's. */
    readonly batchSizeOverride: number | null;
}

const repoFileExists = (repoRelativePath: string): boolean =>
    fs.existsSync(path.resolve(__dirname, '..', repoRelativePath));

const defaultPreflightDeps = (batchSizeOverride: number | null): GeneratePreflightDeps => ({
    env: process.env,
    loadCoveragePlan,
    loadEvidenceAllowlist,
    resolveModelCallBudget: getCatalogModelCallBudget,
    resolveBatchSize: getCatalogBatchSize,
    fileExists: repoFileExists,
    batchSizeOverride,
});

// `null` when the document failed for one of manifest.ts's own documented
// reasons — the caller turns that into a gap. Anything else is an environment
// fault and is rethrown to main's narrowing catch.
const loadOrNull = <T>(load: () => T): { value: T } | { error: ManifestError } => {
    try {
        return { value: load() };
    } catch (error) {
        if (error instanceof ManifestError) {
            return { error };
        }
        throw error;
    }
};

/**
 * The candidate volume generation would have to produce, per category.
 *
 * `candidateVolume` is the plan's whole target for the category, i.e. the
 * pre-import upper bound: the real figure is that volume minus what the USDA
 * import already supplied, which only the wired stage can know because it has
 * to count `catalog_foods`. Reporting the upper bound is the fail-closed choice
 * for an estimate whose purpose is to refuse a run that cannot afford itself,
 * and `basis` is logged with the estimate so the figure is never mistaken for
 * the post-import one.
 */
const aiCandidatesByCategory = (plan: CoveragePlan): Record<string, number> => {
    const candidates: Record<string, number> = {};
    // Guarded rather than trusted: this comes from a JSON document on disk, so
    // its declared type does not bind what actually arrives.
    const categories = Array.isArray(plan.categories) ? plan.categories : [];
    for (const category of categories) {
        if (category === null || typeof category !== 'object') {
            continue;
        }
        candidates[String(category.category)] = category.candidateVolume;
    }
    return candidates;
};

/**
 * Logs the run's intended spend and reports whether the configured cap can
 * cover it. Runs before every other check (§9, "meter before you spend").
 *
 * A plan or a cap that cannot be resolved is not this function's failure to
 * report — the checks below name those gaps with their remedies — so it logs
 * what it can and returns `null`. What it does own is the one budget verdict
 * that needs both: a plan that does not fit its cap.
 */
const meterModelCallBudget = (deps: GeneratePreflightDeps, log?: ScriptLogger): PrerequisiteGap | null => {
    const planResult = loadOrNull(deps.loadCoveragePlan);
    if ('error' in planResult) {
        return null;
    }
    const plan = planResult.value;

    let batchSize: number;
    try {
        batchSize = deps.batchSizeOverride !== null ? deps.batchSizeOverride : deps.resolveBatchSize(deps.env);
    } catch (error) {
        if (error instanceof ModelBudgetError) {
            return null;
        }
        throw error;
    }

    try {
        const batches = planBatches({
            aiCandidatesByCategory: aiCandidatesByCategory(plan),
            batchSize,
            modelCallsPerBatch: plan.modelCallsPerBatch,
        });

        let budgetLimit: number;
        try {
            budgetLimit = deps.resolveModelCallBudget(deps.env);
        } catch (error) {
            if (error instanceof ModelBudgetError) {
                // The spend is still reported, loudly, because it is what the
                // operator needs in order to choose a cap at all.
                log?.warn('model_budget_unmetered', {
                    stage: STAGE,
                    basis: 'coverage_plan_candidate_volume',
                    batchSize,
                    totalBatches: batches.totalBatches,
                    estimatedModelCalls: batches.estimatedModelCalls,
                    problem: error.message,
                });
                return null;
            }
            throw error;
        }

        log?.info('model_budget_basis', { stage: STAGE, basis: 'coverage_plan_candidate_volume', batchSize });
        assertModelCallBudget(batches, budgetLimit, log);
        return null;
    } catch (error) {
        if (error instanceof ModelBudgetError) {
            return {
                code: 'model_call_budget_insufficient',
                requirement:
                    'CATALOG_MODEL_CALL_BUDGET must cover the model calls the coverage plan needs before a paid run starts',
                remedy: 'Raise CATALOG_MODEL_CALL_BUDGET to the figure in the message, or reduce the candidate volume in the coverage plan.',
                detail: `${error.code}: ${error.message}`,
            };
        }
        throw error;
    }
};

export const preflight = (deps: GeneratePreflightDeps, log?: ScriptLogger): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    const budgetGap = meterModelCallBudget(deps, log);
    if (budgetGap !== null) {
        gaps.push(budgetGap);
    }

    // A cache hit after the meter above (manifest.ts memoises by absolute path),
    // so the document is read once per run however many callers consult it.
    const planResult = loadOrNull(deps.loadCoveragePlan);
    if ('error' in planResult) {
        gaps.push({
            code: 'coverage_plan_unavailable',
            requirement: 'data/meal-planning/coverage-plan.v1.json must load and declare coveragePlanVersion v1',
            remedy: 'Add the 21-category coverage plan at data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3).',
            detail: `${planResult.error.code}: ${planResult.error.message}`,
        });
    }

    const allowlistResult = loadOrNull(deps.loadEvidenceAllowlist);
    if ('error' in allowlistResult) {
        gaps.push({
            code: 'evidence_allowlist_unavailable',
            requirement:
                'data/meal-planning/evidence-allowlist.v1.json must load and pass its shape check: it is the SSRF policy every evidence fetch is bound by',
            remedy: 'Restore data/meal-planning/evidence-allowlist.v1.json to a document declaring allowlistVersion v1 with its host classes and specialPurposeRanges table.',
            detail: `${allowlistResult.error.code}: ${allowlistResult.error.message}`,
        });
    }

    const openRouterKey = deps.env[OPENROUTER_API_KEY_ENV];
    if (openRouterKey === undefined || openRouterKey.trim().length === 0) {
        gaps.push({
            code: 'openrouter_api_key_missing',
            requirement: `${OPENROUTER_API_KEY_ENV} must be set: generation and its advisory review are model calls`,
            remedy: `Set ${OPENROUTER_API_KEY_ENV} in backend/.env (see .env.example) or in the environment.`,
        });
    }

    try {
        deps.resolveModelCallBudget(deps.env);
    } catch (error) {
        if (error instanceof ModelBudgetError) {
            gaps.push({
                code: 'model_call_budget_unresolved',
                requirement:
                    'CATALOG_MODEL_CALL_BUDGET must be a positive integer: it is the hard cap on paid model calls for one run and has no default',
                remedy: 'Set CATALOG_MODEL_CALL_BUDGET in backend/.env (see .env.example) to the maximum number of model calls this run may spend.',
                detail: `${error.code}: ${error.message}`,
            });
        } else {
            throw error;
        }
    }

    try {
        deps.resolveBatchSize(deps.env);
    } catch (error) {
        if (error instanceof ModelBudgetError) {
            gaps.push({
                code: 'catalog_batch_size_invalid',
                requirement:
                    'CATALOG_BATCH_SIZE must be a positive integer when set: it fixes every batch key, so a typo turns a resume into a restart',
                remedy: 'Set CATALOG_BATCH_SIZE to a positive integer, or unset it to take the default of 25.',
                detail: `${error.code}: ${error.message}`,
            });
        } else {
            throw error;
        }
    }

    if (!deps.fileExists(EVIDENCE_SERVICE_MODULE)) {
        gaps.push({
            code: 'evidence_service_absent',
            requirement: `${EVIDENCE_SERVICE_MODULE} must exist: every generated candidate's identity evidence is retrieved through it under the allowlist policy`,
            remedy: `Land ${EVIDENCE_SERVICE_MODULE} with evidence.logic.ts's predicates (AAP §0.7.1 Group 3).`,
        });
    }

    if (!deps.fileExists(CATALOG_LOGIC_MODULE)) {
        gaps.push({
            code: 'catalog_logic_absent',
            requirement: `${CATALOG_LOGIC_MODULE} must exist: it normalises, dedupes and bounds-checks every generated candidate`,
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
        batchSize: parsed.options.batchSize,
        resume: parsed.options.resume,
        dryRun: parsed.options.dryRun,
    });

    const gaps = preflight(defaultPreflightDeps(parsed.options.batchSize), logger);
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
