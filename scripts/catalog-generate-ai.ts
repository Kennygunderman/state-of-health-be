// Stage 2 of the catalog pipeline: AI generation of the candidates the USDA
// import could not supply.
//
// WHAT THE STAGE DOES. It derives one batch per
// `ceil(aiCandidates / CATALOG_BATCH_SIZE)` from
// data/meal-planning/coverage-plan.v1.json, reserves each model call against
// CATALOG_MODEL_CALL_BUDGET in `catalog_generation_batches` *before* spending
// it, prompts OpenRouter for generic preparations only, retrieves identity
// evidence through src/services/evidence.service.ts under the allowlist policy,
// dedupes against `source_key`, canonical names and aliases, and resumes from
// the batches that are not yet complete (Agent Action Plan §0.7.1 Group 3).
//
// METERING FIRST, AND WHY A FAILED CALL IS NOT REFUNDED. Rule
// backend-architecture §9 states the order and the reason:
// src/services/entitlement.service.ts consumes a user's quota BEFORE the model
// call, because a failed call still spends tokens and failures must not become
// free retries. These calls have no user, so `ai_usage` cannot meter them; the
// same order is kept at operator scope through scripts/lib/budget.ts —
// `model_calls_reserved` is incremented before every call and NEVER
// decremented, `model_calls_used` is recorded afterwards on success and on
// failure alike, and the two diverging is the signal an operator reads. The
// startup gate follows the same instinct: the run's intended spend is logged
// and compared with the cap before the first vendor request, so a plan that
// cannot afford itself never starts.
//
// GENERATION NEVER PUBLISHES. Every row this stage writes is
// `identity_source = 'ai_generated'`, `nutrition_provenance = 'ai_estimated'`
// and, at best, `publication_status = 'candidate'` — the same rule the import
// follows for its own records. catalog-validate.ts is the stage that publishes,
// and the provenance columns follow the food into search, recipe detail and the
// diary, where they are rendered as an estimate. An AI plausibility review is
// never presented as verified nutrition.
//
// FETCHED EVIDENCE IS DATA, NEVER INSTRUCTIONS. A retrieved page is matched
// against the candidate's name, hashed, excerpted and stored in
// `catalog_validation_records.identity_evidence`. There is no path from a
// fetched body back into a prompt in this file, which is what makes the
// evidence boundary a prompt-injection boundary as well as an SSRF one.
//
// WHY NO PRISMA PREDICATE HERE CARRIES AN OWNER (Rule backend-architecture
// §5.1). The catalog tables have no `user_id` column at all: they are shared
// reference data, one row per food for the whole installation, and AAP §0.5.1
// names them as the only authenticated reads without a tenant predicate. The
// guarantee that replaces the owner predicate is the DATABASE ORIGIN, checked
// before any of this runs — `lib/dbGuard.ts` classifies DATABASE_URL at module
// load (the second import below) and refuses an origin it cannot recognise
// rather than guessing. Identity is enforced instead by the keys: every write
// is an upsert on the deterministic `source_key`, so a rerun converges on the
// same rows rather than accumulating new ones.
import './lib/bootstrap';
import './lib/dbGuard';

import fs from 'fs';
import path from 'path';

// The version rule, the search-text derivation and the alias normalisation are
// reused from the import stage rather than reimplemented: `nutrition_version`
// and `metadata_version` decide when a frozen recipe snapshot has gone stale,
// and two stages writing `catalog_foods` by two different rules is precisely
// the forked decision Rule backend-architecture §7 and §13 forbid.
import {
    buildSearchText,
    canonicalJsonString,
    dedupeSortedAliases,
    nextCatalogFoodVersions,
    sha256Hex,
} from './catalog-import-usda';
import type { StoredVersionedFacts } from './catalog-import-usda';
import {
    ModelBudgetError,
    assertModelCallBudget,
    batchKeyFor,
    getCatalogBatchSize,
    getCatalogModelCallBudget,
    getReservedModelCalls,
    planBatches,
    recordModelCallUsage,
    reserveModelCall,
} from './lib/budget';
import type { BatchPlan } from './lib/budget';
import {
    CheckpointError,
    appendRunLog,
    finishRun,
    openOrResumeRun,
    recordCounts,
    saveCursor,
    withCatalogStageLock,
} from './lib/checkpoint';
import type { CatalogRunDb } from './lib/checkpoint';
import { DatabaseOriginError, classifyDatabaseOrigin } from './lib/dbGuard';
import { createFatalLogger, createLogger, hostOf, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, ScriptLogger } from './lib/logger';
import { ManifestError, loadCoveragePlan, loadEvidenceAllowlist, reportPath } from './lib/manifest';
import type { CatalogFoodState, CoveragePlan, EvidenceAllowlist } from './lib/manifest';
import {
    CATALOG_CHECK_NAMES,
    CATALOG_FOOD_STATES,
    PER_100G_BASIS_AMOUNT,
    buildSourceKey,
    catalogCheckTier,
    computeCoverageShortfall,
    dedupeIdentity,
    findBrandPatternMatch,
    isCatalogFoodState,
    normalizeCanonicalName,
    normalizeToPer100g,
    validateCatalogCandidate,
} from '../src/services/catalog.logic';
import type {
    CatalogCheckName,
    CatalogFoodCandidate,
    CatalogFoodPortionCandidate,
    CatalogIdentityCandidate,
    CatalogValidationPolicy,
    CatalogValidationVerdict,
} from '../src/services/catalog.logic';
import { fetchEvidence } from '../src/services/evidence.service';
import { OpenRouterError, callOpenRouter, getOpenRouterConfig, parseModelJson } from '../src/services/openrouter.service';

const STAGE = 'catalog-generate-ai';

/** `catalog_import_runs.kind` for this stage, and its exclusive stage lock. */
const RUN_KIND = 'ai_generation' as const;

const OPENROUTER_API_KEY_ENV = 'OPENROUTER_API_KEY';
const GENERATION_MODEL_ENV = 'CATALOG_GENERATION_MODEL';
const GENERATION_MODEL_FALLBACK_ENV = 'OPENROUTER_MODEL';
const MODEL_CALL_BUDGET_ENV = 'CATALOG_MODEL_CALL_BUDGET';
const BATCH_SIZE_ENV = 'CATALOG_BATCH_SIZE';

/**
 * A batch the generation stage has already completed, so a resume skips it
 * without a model call.
 *
 * The lifecycle in prisma/schema.prisma is
 * 'pending' -> 'generated' -> 'validated' | 'failed'. `pending` is the state
 * budget.ts creates a row in when it reserves, so a batch that reserved and
 * then crashed is `pending` with a standing reservation and IS re-executed —
 * conservative, and the direct consequence of never refunding a reservation.
 */
const COMPLETED_BATCH_STATUSES: readonly string[] = ['generated', 'validated'];

const BATCH_STATUS_GENERATED = 'generated';
const BATCH_STATUS_FAILED = 'failed';

/** Identity evidence is the only claim this stage asks a reference to support. */
const EVIDENCE_CLAIM = 'canonical_identity';

/** Per candidate, so one hallucinated URL list cannot become an unbounded crawl. */
const MAX_EVIDENCE_URLS_PER_CANDIDATE = 3;

/** Model-supplied lists are bounded before they reach a TEXT[] column. */
const MAX_ALIASES_PER_CANDIDATE = 8;
const MAX_TAGS_PER_CANDIDATE = 12;
const MAX_TEXT_FIELD_CHARS = 200;

/** The avoid-list handed to the model, capped so one prompt cannot grow without bound. */
const MAX_AVOID_NAMES = 150;

/** Listed individually because it is a worklist, capped because a report must stay openable. */
const REFUSAL_LIST_LIMIT = 200;

/** A batch writes ~25 foods and their children; a cold pool is the slow part. */
const TRANSACTION_TIMEOUT_MS = 30_000;

/** Longer than the request-time default: nothing is waiting on an offline batch. */
const GENERATION_TIMEOUT_MS = 120_000;

const CURSOR_SAVE_EVERY_BATCHES = 1;

// ---------------------------------------------------------------------------
// Configuration, read once at module load behind loud accessors (Rule
// backend-architecture §9). Nothing below reads process.env inside the batch
// loop: the three values are resolved before the first batch and passed in.
// ---------------------------------------------------------------------------

const GENERATION_MODEL_OVERRIDE = process.env[GENERATION_MODEL_ENV];

/**
 * The generation model: `CATALOG_GENERATION_MODEL` when set, otherwise the
 * vendor boundary's own configured model (`OPENROUTER_MODEL`, then the
 * module's default) — the precedence AAP §0.4.3 states.
 *
 * Loud when the integration is unusable: `getOpenRouterConfig()` throws
 * `OpenRouterError('not_configured')` with no API key, and this stage cannot
 * run a paid batch without one, so it is translated into this file's own error
 * rather than sending an unauthenticated request.
 */
export const getGenerationModel = (): string => {
    const override = GENERATION_MODEL_OVERRIDE === undefined ? '' : GENERATION_MODEL_OVERRIDE.trim();
    if (override.length > 0) {
        return override;
    }

    try {
        return getOpenRouterConfig().model;
    } catch (error) {
        throw asGenerationFailure(error, 'generation_model_unconfigured', {
            detail: `${GENERATION_MODEL_ENV} is unset, so the model comes from ${GENERATION_MODEL_FALLBACK_ENV} through the OpenRouter boundary, which is not configured`,
        });
    }
};

// ---------------------------------------------------------------------------
// Errors (Rule backend-architecture §8). One class, a stable code per cause,
// and the batch key wherever the failure belongs to a batch — an operator
// resuming a 157-batch run needs to know which one stopped it.
// ---------------------------------------------------------------------------

export type CatalogGenerationErrorCode =
    | 'generation_model_unconfigured'
    | 'coverage_plan_unusable'
    | 'evidence_policy_unusable'
    | 'unknown_category'
    | 'model_call_failed'
    | 'model_response_unusable'
    | 'budget_insufficient'
    | 'budget_misconfigured'
    | 'budget_exhausted'
    | 'batch_ledger_mismatch'
    | 'persist_failed';

export class CatalogGenerationError extends Error {
    constructor(
        public readonly code: CatalogGenerationErrorCode,
        message: string,
        public readonly context: {
            readonly batchKey?: string;
            readonly category?: string;
            /** The vendor failure kind, when one is known, never the vendor's error object. */
            readonly kind?: string;
            readonly status?: number;
            readonly detail?: string;
        } = {},
    ) {
        super(message);
        this.name = 'CatalogGenerationError';
    }
}

/**
 * Wraps a vendor or library failure in this stage's own error, so no caller
 * pattern-matches an OpenRouter or Prisma error shape (§9).
 *
 * A `ModelBudgetError` keeps its own code because it already names the cause
 * precisely, and an exhausted budget is a stop reason rather than a defect.
 */
const asGenerationFailure = (
    error: unknown,
    code: CatalogGenerationErrorCode,
    context: { batchKey?: string; category?: string; detail?: string } = {},
): CatalogGenerationError => {
    if (error instanceof CatalogGenerationError) {
        return error;
    }

    if (error instanceof OpenRouterError) {
        return new CatalogGenerationError(code, `OpenRouter call failed (${error.kind}): ${error.message}`, {
            ...context,
            kind: error.kind,
            status: error.status,
        });
    }

    const described = safeError(error);
    return new CatalogGenerationError(code, `${described.name}: ${described.message}`, context);
};

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
    /** `--max-batches`; `null` means "every batch the plan needs". */
    readonly maxBatches: number | null;
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
        return {
            ok: true,
            options: {
                help: true,
                categories: [],
                batchSize: null,
                maxBatches: null,
                resume: false,
                dryRun: false,
            },
        };
    }

    const errors: ArgumentError[] = [];
    const categories: string[] = [];
    let batchSize: number | null = null;
    let batchSizeSeen = false;
    let maxBatches: number | null = null;
    let maxBatchesSeen = false;
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

    // Shared by the two positive-integer flags, so `--batch-size` and
    // `--max-batches` cannot disagree about what a number is.
    const readPositiveInteger = (
        flag: string,
        inlineValue: string | null,
        alreadySeen: boolean,
    ): { value: number } | { rejected: true } => {
        const raw = takeValue(inlineValue);
        if (raw === null) {
            errors.push({ flag, message: `${flag} requires a positive integer` });
            return { rejected: true };
        }
        if (alreadySeen) {
            errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
            return { rejected: true };
        }
        const parsed = Number(raw);
        if (!Number.isInteger(parsed) || parsed <= 0) {
            errors.push({ flag, message: `${flag} must be a positive integer` });
            return { rejected: true };
        }
        return { value: parsed };
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
            const read = readPositiveInteger(flag, inlineValue, batchSizeSeen);
            batchSizeSeen = true;
            if ('value' in read) {
                batchSize = read.value;
            }
            continue;
        }

        if (flag === '--max-batches') {
            const read = readPositiveInteger(flag, inlineValue, maxBatchesSeen);
            maxBatchesSeen = true;
            if ('value' in read) {
                maxBatches = read.value;
            }
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

    return { ok: true, options: { help: false, categories, batchSize, maxBatches, resume, dryRun } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:generate -- [options]   (${STAGE})`,
        '',
        'Fills the coverage gaps the USDA import could not supply with AI-generated',
        'CANDIDATE foods, each carrying retrieved identity evidence and a machine-readable',
        'validation record. Nothing this stage writes is published: catalog:validate is the',
        'stage that publishes, and every row stays labelled as an AI estimate.',
        '',
        'Options:',
        '  --category <name>   Restrict generation to one coverage-plan category.',
        '                      Repeatable. Default: every category in the coverage plan.',
        '  --batch-size <n>    Candidates per batch, overriding CATALOG_BATCH_SIZE for',
        '                      this run. Positive integer. Default: CATALOG_BATCH_SIZE,',
        '                      or 25 when it is unset.',
        '  --max-batches <n>   Stop after this many batches, leaving the rest for a',
        '                      later --resume. Positive integer. Default: every batch.',
        '  --resume            Continue this stage\'s newest unfinished run, addressing',
        '                      the same batch keys and spending what is left of that',
        '                      run\'s budget. Default: off (a new run).',
        '  --dry-run           Report the batches and the budget without spending it:',
        '                      no model call, no run row, no row written. Default: off.',
        '  --help, -h          Print this usage block and exit 0.',
        '',
        'Inputs read:',
        '  data/meal-planning/coverage-plan.v1.json      per-category candidate volume,',
        '                                                food-group taxonomy, prompt version',
        '                                                and the model calls one batch costs',
        '  data/meal-planning/evidence-allowlist.v1.json permitted evidence host classes and',
        '                                                the IANA address table',
        '  catalog_foods                                 the USDA candidates already imported,',
        '                                                which is what the AI volume subtracts',
        '',
        'Environment:',
        `  DATABASE_URL                 required; classified by scripts/lib/dbGuard.ts`,
        `  ${OPENROUTER_API_KEY_ENV}           required; the generation model key`,
        `  ${MODEL_CALL_BUDGET_ENV}    required positive integer; the hard cap on model`,
        '                               calls for one run, with no default',
        `  ${GENERATION_MODEL_ENV}   optional; defaults to ${GENERATION_MODEL_FALLBACK_ENV}`,
        `  ${BATCH_SIZE_ENV}           optional positive integer, default 25`,
        '  EVIDENCE_FETCH_TIMEOUT_MS    optional; bounds every identity-evidence fetch',
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
    /** `--batch-size` when the operator gave one; `null` to take the environment's. */
    readonly batchSizeOverride: number | null;
}

const defaultPreflightDeps = (batchSizeOverride: number | null): GeneratePreflightDeps => ({
    env: process.env,
    loadCoveragePlan,
    loadEvidenceAllowlist,
    resolveModelCallBudget: getCatalogModelCallBudget,
    resolveBatchSize: getCatalogBatchSize,
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
 * Logs what the coverage plan would cost if nothing had been imported yet, as
 * the first act of the run (§9, "meter before you spend"): an operator
 * launching an unattended paid run sees the order of magnitude before anything
 * else is checked.
 *
 * THIS IS INFORMATIONAL, AND THE AUTHORITATIVE GATE IS NOT HERE.
 * `candidateVolume` is the plan's whole pre-import target, so this figure is an
 * UPPER BOUND — the real work is that volume minus what the USDA import already
 * supplied, which needs a `catalog_foods` count. Refusing a run on the upper
 * bound would refuse runs that comfortably fit their cap (the shipped catalog
 * needs 157 batches against an upper bound of 551). The cap is therefore
 * enforced in {@link runGeneration}, on the plan the run will actually execute,
 * before its first vendor call — and `basis` is logged with the figure so the
 * two are never confused.
 */
const meterUpperBoundEstimate = (deps: GeneratePreflightDeps, log?: ScriptLogger): void => {
    const planResult = loadOrNull(deps.loadCoveragePlan);
    if ('error' in planResult) {
        return;
    }
    const plan = planResult.value;

    let batchSize: number;
    let budgetLimit: number | null = null;
    try {
        batchSize = deps.batchSizeOverride !== null ? deps.batchSizeOverride : deps.resolveBatchSize(deps.env);
    } catch (error) {
        if (error instanceof ModelBudgetError) {
            return;
        }
        throw error;
    }
    try {
        budgetLimit = deps.resolveModelCallBudget(deps.env);
    } catch (error) {
        if (!(error instanceof ModelBudgetError)) {
            throw error;
        }
        // Reported as unmetered rather than skipped: the estimate is what an
        // operator needs in order to choose a cap at all.
        budgetLimit = null;
    }

    let upperBound: BatchPlan;
    try {
        upperBound = planBatches({
            aiCandidatesByCategory: upperBoundCandidatesByCategory(plan),
            batchSize,
            modelCallsPerBatch: plan.modelCallsPerBatch,
        });
    } catch (error) {
        if (error instanceof ModelBudgetError) {
            return;
        }
        throw error;
    }

    log?.info('model_budget_upper_bound', {
        stage: STAGE,
        basis: 'coverage_plan_candidate_volume_before_import',
        authoritativeGate: 'runGeneration, against the post-import plan, before the first model call',
        batchSize,
        totalBatches: upperBound.totalBatches,
        estimatedModelCalls: upperBound.estimatedModelCalls,
        budgetEnvVar: MODEL_CALL_BUDGET_ENV,
        budgetLimit,
    });
};

/** The pre-import upper bound per category, guarded because it is JSON from disk. */
const upperBoundCandidatesByCategory = (plan: CoveragePlan): Record<string, number> => {
    const candidates: Record<string, number> = {};
    const categories = Array.isArray(plan.categories) ? plan.categories : [];
    for (const category of categories) {
        if (category === null || typeof category !== 'object') {
            continue;
        }
        candidates[String(category.category)] = category.candidateVolume;
    }
    return candidates;
};

export const preflight = (deps: GeneratePreflightDeps, log?: ScriptLogger): readonly PrerequisiteGap[] => {
    const gaps: PrerequisiteGap[] = [];

    meterUpperBoundEstimate(deps, log);

    // A cache hit after the meter above (manifest.ts memoises by absolute path),
    // so the document is read once per run however many callers consult it.
    const planResult = loadOrNull(deps.loadCoveragePlan);
    if ('error' in planResult) {
        gaps.push({
            code: 'coverage_plan_unavailable',
            requirement: 'data/meal-planning/coverage-plan.v1.json must load and declare coveragePlanVersion v1',
            remedy: 'Restore the 21-category coverage plan at data/meal-planning/coverage-plan.v1.json (AAP §0.7.1 Group 3).',
            detail: `${planResult.error.code}: ${planResult.error.message}`,
        });
    } else if (planResult.value.foodGroups.length === 0) {
        gaps.push({
            code: 'coverage_plan_food_groups_missing',
            requirement:
                'the coverage plan must declare its food-group taxonomy: every generated food carries one group, and the prompt is bounded by the groups the plan declares for the category',
            remedy: 'Restore the foodGroups list in data/meal-planning/coverage-plan.v1.json.',
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
            requirement: `${OPENROUTER_API_KEY_ENV} must be set: generation is a model call`,
            remedy: `Set ${OPENROUTER_API_KEY_ENV} in backend/.env (see .env.example) or in the environment.`,
        });
    }

    try {
        deps.resolveModelCallBudget(deps.env);
    } catch (error) {
        if (error instanceof ModelBudgetError) {
            gaps.push({
                code: 'model_call_budget_unresolved',
                requirement: `${MODEL_CALL_BUDGET_ENV} must be a positive integer: it is the hard cap on paid model calls for one run and has no default`,
                remedy: `Set ${MODEL_CALL_BUDGET_ENV} in backend/.env (see .env.example) to the maximum number of model calls this run may spend.`,
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
                requirement: `${BATCH_SIZE_ENV} must be a positive integer when set: it fixes every batch key, so a typo turns a resume into a restart`,
                remedy: `Set ${BATCH_SIZE_ENV} to a positive integer, or unset it to take the default of 25.`,
                detail: `${error.code}: ${error.message}`,
            });
        } else {
            throw error;
        }
    }

    return gaps;
};

// ---------------------------------------------------------------------------
// The injected seams (Rule backend-architecture §11: dependency injection over
// mocking). Everything this stage reaches — the database, the model, the
// evidence fetcher, the clock and the budget ledger — arrives as a parameter,
// so src/__tests__/scripts/catalog-generate.test.ts drives `runGeneration`
// end to end with no network and no Prisma client.
// ---------------------------------------------------------------------------

/**
 * The narrow slice of the Prisma client this stage uses. Declared structurally
 * so this file never depends on the generated client's shape beyond the five
 * models it touches, and so a fake satisfies it.
 */
export interface GenerationDb {
    catalog_foods: {
        groupBy(args: unknown): Promise<Array<{ category: string; _count: { _all: number } }>>;
        findMany(args: unknown): Promise<Array<{ canonical_name: string }>>;
        findUnique(
            args: unknown,
        ): Promise<({ id: string; imported_at: Date | null } & StoredVersionedFacts) | null>;
        create(args: unknown): Promise<{ id: string }>;
        update(args: unknown): Promise<{ id: string }>;
    };
    catalog_food_aliases: {
        findMany(
            args: unknown,
        ): Promise<Array<{ alias: string; catalog_food_id: string; catalog_foods: { source_key: string } }>>;
        deleteMany(args: unknown): Promise<{ count: number }>;
        createMany(args: unknown): Promise<{ count: number }>;
    };
    catalog_food_portions: {
        deleteMany(args: unknown): Promise<{ count: number }>;
        createMany(args: unknown): Promise<{ count: number }>;
    };
    catalog_validation_records: {
        upsert(args: unknown): Promise<{ id: string }>;
    };
    catalog_generation_batches: {
        findMany(args: unknown): Promise<Array<{ id: string; batch_key: string; status: string }>>;
        updateMany(args: unknown): Promise<{ count: number }>;
    };
    $transaction<T>(work: (tx: GenerationDb) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

/**
 * The model boundary as this stage consumes it.
 *
 * `call` returns `unknown`: the vendor boundary guarantees the transport and
 * the syntax, never the shape, so {@link parseGeneratedFoods} narrows every
 * field it reads.
 */
export interface GenerationModelClient {
    call(systemPrompt: string, userContent: string, jsonSchema: object, model: string): Promise<unknown>;
}

/** The evidence fetcher, typed from the service so a fake cannot drift from it. */
export type GenerationEvidenceFetcher = typeof fetchEvidence;

/** The policy document and the claim, named through the service's own signature. */
type EvidencePolicyDocument = Parameters<GenerationEvidenceFetcher>[2];
type EvidenceClaim = Parameters<GenerationEvidenceFetcher>[3];

/**
 * The budget ledger, in the §9 order: `reserve` before a call, `record` after
 * it — on success AND on failure — and `reserved` to read what a resumed run
 * has already committed.
 */
export interface GenerationBudget {
    reserve(input: {
        runId: string;
        batchKey: string;
        category: string;
        model: string;
        promptVersion: string;
        budgetLimit: number;
        logger?: ScriptLogger;
    }): Promise<{ reserved: number; remaining: number }>;
    record(input: {
        runId: string;
        batchKey: string;
        succeeded: boolean;
        tokensUsed?: number;
        logger?: ScriptLogger;
    }): Promise<void>;
    reserved(runId: string): Promise<number>;
}

export interface GenerationDeps {
    /** The catalog graph this stage writes, through the narrow seam above. */
    readonly prisma: GenerationDb;
    /** The same client as the run and ledger seam (`catalog_import_runs`). */
    readonly runDb: CatalogRunDb;
    readonly openRouter: GenerationModelClient;
    readonly fetchEvidence: GenerationEvidenceFetcher;
    readonly now: () => Date;
    readonly budget: GenerationBudget;
    readonly coveragePlan: CoveragePlan;
    /** The loaded allowlist; every fetch revalidates it before touching a socket. */
    readonly evidencePolicy: EvidencePolicyDocument;
    readonly options: GenerateOptions;
    readonly logger: ScriptLogger;
    /** Resolved once, before the first batch — never read from the environment in the loop. */
    readonly model: string;
    readonly batchSize: number;
    readonly budgetLimit: number;
    readonly writeReport: (report: unknown) => void;
}

/** Why the run stopped, so a caller never has to infer it from counters. */
export type GenerationStopReason = 'completed' | 'budget_exhausted' | 'dry_run' | 'already_completed';

export interface GenerationSummary {
    /** `null` for a dry run, which deliberately opens no run row. */
    readonly runId: string | null;
    readonly resumed: boolean;
    readonly stopReason: GenerationStopReason;
    readonly plannedBatches: number;
    readonly executedBatches: number;
    readonly skippedBatches: number;
    readonly counts: Readonly<Record<string, number>>;
    /** `max(0, publishedTarget − published)` summed over the coverage plan. */
    readonly shortfallTotal: number;
    readonly modelCallsReserved: number;
    readonly modelCallsUsed: number;
}

/** The checkpoint this stage resumes from. */
export interface GenerationCursor {
    readonly fingerprint: string;
    readonly nextBatchIndex: number;
    /**
     * The reservations this run had made when the checkpoint was written.
     *
     * A MIRROR, not the authority: `getReservedModelCalls` sums the ledger
     * rows, which is what a resumed run spends against, because a process
     * killed mid-write can leave this number behind. It is persisted because
     * the checkpoint is what an operator reads, and a resume logs both so a
     * divergence is visible rather than silent.
     */
    readonly modelCallsReserved: number;
}

// ---------------------------------------------------------------------------
// Deterministic batching — the rerun guarantee.
// ---------------------------------------------------------------------------

export interface GenerationBatch {
    readonly batchKey: string;
    readonly category: string;
    readonly batchIndex: number;
    /** The tail batch of a category carries the remainder, never a padded 25. */
    readonly candidateTarget: number;
    /** The coverage-plan food groups the prompt may choose from for this category. */
    readonly foodGroups: readonly string[];
}

export interface GenerationPlan {
    /** Identifies the work list, so a cursor from a changed plan is not resumed into. */
    readonly fingerprint: string;
    readonly batches: readonly GenerationBatch[];
    /** The batches this invocation will execute — what the budget is asserted against. */
    readonly executable: BatchPlan;
    /** Every batch the selected categories need, before `--max-batches`. */
    readonly unrestricted: BatchPlan;
    readonly aiCandidatesByCategory: Readonly<Record<string, number>>;
    readonly usdaImportedByCategory: Readonly<Record<string, number>>;
    readonly truncatedByMaxBatches: boolean;
}

/**
 * The USDA candidates already imported, per category.
 *
 * Read from `catalog_foods` rather than from the import report, and counting
 * EVERY row the import wrote for the category whatever its publication status —
 * which is what `byCategory` in the import report counts, and therefore what
 * makes this figure agree with the one catalog-report.ts publishes. A count
 * narrowed to published rows would re-order work for foods that are merely
 * awaiting validation and would generate candidates the catalog already holds.
 */
const readUsdaImportedByCategory = async (db: GenerationDb): Promise<Record<string, number>> => {
    const grouped = await db.catalog_foods.groupBy({
        by: ['category'],
        where: { identity_source: 'usda' },
        _count: { _all: true },
    });

    const counts: Record<string, number> = {};
    for (const row of grouped) {
        const count = row._count._all;
        counts[row.category] = typeof count === 'number' && Number.isFinite(count) ? count : 0;
    }
    return counts;
};

/**
 * Sizes and names every batch the run will address.
 *
 * `batchKeyFor` owns the key format and its zero padding, and `planBatches`
 * owns the ceil-with-tail arithmetic, so a rerun over the same coverage plan
 * and the same imported catalog addresses exactly the same keys. The remainder
 * is carried by the LAST batch of a category — protein_plant's 438 candidates
 * at a batch size of 25 is 18 batches, 17 full and a tail of 13 — because
 * padding the tail would ask for candidates the plan never budgeted and
 * dropping it would quietly miss the category's target.
 */
export const buildGenerationPlan = async (deps: GenerationDeps): Promise<GenerationPlan> => {
    const { coveragePlan, options, batchSize } = deps;

    const declared = new Map(coveragePlan.categories.map((category) => [category.category, category]));
    const requested = options.categories.length > 0 ? options.categories : [...declared.keys()];

    for (const category of requested) {
        if (!declared.has(category as never)) {
            throw new CatalogGenerationError(
                'unknown_category',
                `--category ${category} is not declared by data/meal-planning/coverage-plan.v1.json. ` +
                    `Declared categories: ${[...declared.keys()].join(', ')}.`,
                { category },
            );
        }
    }

    const selected = coveragePlan.categories.filter((category) => requested.indexOf(category.category) !== -1);
    const usdaImportedByCategory = await readUsdaImportedByCategory(deps.prisma);

    const foodGroupsByCategory = new Map<string, string[]>();
    for (const group of coveragePlan.foodGroups) {
        const groups = foodGroupsByCategory.get(group.category);
        if (groups) {
            groups.push(group.foodGroup);
        } else {
            foodGroupsByCategory.set(group.category, [group.foodGroup]);
        }
    }

    const aiCandidatesByCategory: Record<string, number> = {};
    for (const category of selected) {
        const imported = usdaImportedByCategory[category.category] ?? 0;
        aiCandidatesByCategory[category.category] = Math.max(0, category.candidateVolume - imported);
    }

    const unrestricted = planBatches({
        aiCandidatesByCategory,
        batchSize,
        modelCallsPerBatch: coveragePlan.modelCallsPerBatch,
    });

    const batches: GenerationBatch[] = [];
    for (const category of selected) {
        const batchCount = unrestricted.batchesByCategory[category.category] ?? 0;
        const aiCandidates = aiCandidatesByCategory[category.category] ?? 0;
        const groups = foodGroupsByCategory.get(category.category) ?? [];

        for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
            const isTail = batchIndex === batchCount - 1;
            const candidateTarget = isTail ? aiCandidates - batchIndex * batchSize : batchSize;

            batches.push({
                batchKey: batchKeyFor(coveragePlan.coveragePlanVersion, category.category, batchIndex),
                category: category.category,
                batchIndex,
                candidateTarget,
                foodGroups: groups,
            });
        }
    }

    const truncatedByMaxBatches = options.maxBatches !== null && options.maxBatches < batches.length;
    const executableBatches = truncatedByMaxBatches ? batches.slice(0, options.maxBatches as number) : batches;

    // The executable plan is assembled rather than re-derived, because
    // `--max-batches` takes a PREFIX of a list planBatches already sized: the
    // per-category counts are recounted from that prefix and the call estimate
    // is planBatches' own `totalBatches × modelCallsPerBatch`. Asserting the cap
    // against the unrestricted figure would refuse a narrowed run for calls it
    // will never make.
    const batchesByCategory: Record<string, number> = {};
    for (const category of selected) {
        batchesByCategory[category.category] = 0;
    }
    for (const batch of executableBatches) {
        batchesByCategory[batch.category] = (batchesByCategory[batch.category] ?? 0) + 1;
    }

    const executable: BatchPlan = {
        batchesByCategory,
        totalBatches: executableBatches.length,
        estimatedModelCalls: executableBatches.length * coveragePlan.modelCallsPerBatch,
    };

    const fingerprint = sha256Hex(
        canonicalJsonString({
            coveragePlanVersion: coveragePlan.coveragePlanVersion,
            promptVersion: coveragePlan.promptVersion,
            batchSize,
            aiCandidatesByCategory,
        }),
    );

    return {
        fingerprint,
        batches: executableBatches,
        executable,
        unrestricted,
        aiCandidatesByCategory,
        usdaImportedByCategory,
        truncatedByMaxBatches,
    };
};

/**
 * The checkpoint key this invocation may claim.
 *
 * The canonical full run claims the coverage-plan version itself, and only it
 * ever completes that key. A run narrowed by `--category` or `--max-batches`
 * covers part of the plan, so it claims a key naming its own restriction: it
 * can still resume and still refuses to redo itself, but it cannot answer for
 * work it never attempted.
 */
export const generationRunScope = (coveragePlanVersion: string, options: GenerateOptions): string => {
    const restricted = options.categories.length > 0 || options.maxBatches !== null;
    if (!restricted) {
        return coveragePlanVersion;
    }

    const scope = canonicalJsonString({
        categories: [...options.categories].sort(),
        maxBatches: options.maxBatches,
    });

    return `${coveragePlanVersion}+partial:${sha256Hex(scope).slice(0, 16)}`;
};

// ---------------------------------------------------------------------------
// The prompt. Generic preparations only — the schema has NO brand field.
// ---------------------------------------------------------------------------

const GENERATION_SYSTEM_PROMPT = [
    'You extend a nutrition reference catalog with GENERIC food preparations.',
    '',
    'Hard rules:',
    '- Never name a brand, a manufacturer, a retailer, a restaurant or a packaged product.',
    '  Only generic foods and generic preparations ("brown rice, cooked", "lentil soup").',
    '- State nutrition PER 100 GRAMS of the food as prepared, for the food_state you choose.',
    '- Use null for a nutrient you do not know. Never write 0 to mean unknown.',
    '- Give exactly one default portion, with a realistic gram weight for that portion.',
    '- Give evidence URLs that are public reference pages (government or university',
    '  nutrition references, or established culinary references) whose text names the food.',
    '  Never a manufacturer page, a shop, a blog or a search-results URL.',
    '- Every name must be distinct from the names you are told the catalog already holds.',
    '',
    'You are writing candidates for human and automated review. Values you are unsure of',
    'are recorded as estimates and are labelled as such wherever they are shown.',
].join('\n');

/**
 * The response schema, in the house shape `estimate.service.ts` established
 * (name, `strict: true`, `additionalProperties: false`, every property
 * required) and with the enums bound to the coverage plan's own vocabulary —
 * the food states, the category's food groups and the cost-class scale.
 *
 * THERE IS NO BRAND FIELD, and that is the point: the catalog's branded
 * coverage comes exclusively from USDA Branded records and the existing live
 * branded search. A model-proposed manufacturer domain cannot independently
 * verify a model-proposed product, so a brand claim could never be corroborated
 * and is refused at the schema before it is refused by
 * {@link findBrandPatternMatch} at parse time.
 */
export const buildGenerationSchema = (
    foodGroups: readonly string[],
    costClasses: readonly number[],
): object => ({
    name: 'catalog_generation_batch',
    strict: true,
    schema: {
        type: 'object',
        properties: {
            foods: {
                type: 'array',
                items: {
                    type: 'object',
                    properties: {
                        canonicalName: { type: 'string' },
                        displayName: { type: 'string' },
                        foodState: { type: 'string', enum: [...CATALOG_FOOD_STATES] },
                        foodGroup: { type: 'string', enum: [...foodGroups] },
                        aliases: { type: 'array', items: { type: 'string' } },
                        caloriesPer100g: { type: ['number', 'null'] },
                        proteinGPer100g: { type: ['number', 'null'] },
                        carbsGPer100g: { type: ['number', 'null'] },
                        fatGPer100g: { type: ['number', 'null'] },
                        fiberGPer100g: { type: ['number', 'null'] },
                        costClass: { type: 'integer', enum: [...costClasses] },
                        allergenTags: { type: 'array', items: { type: 'string' } },
                        dietTags: { type: 'array', items: { type: 'string' } },
                        defaultPortion: {
                            type: 'object',
                            properties: {
                                description: { type: 'string' },
                                amount: { type: 'number' },
                                unit: { type: 'string' },
                                gramWeight: { type: 'number' },
                            },
                            required: ['description', 'amount', 'unit', 'gramWeight'],
                            additionalProperties: false,
                        },
                        evidenceUrls: { type: 'array', items: { type: 'string' } },
                    },
                    required: [
                        'canonicalName',
                        'displayName',
                        'foodState',
                        'foodGroup',
                        'aliases',
                        'caloriesPer100g',
                        'proteinGPer100g',
                        'carbsGPer100g',
                        'fatGPer100g',
                        'fiberGPer100g',
                        'costClass',
                        'allergenTags',
                        'dietTags',
                        'defaultPortion',
                        'evidenceUrls',
                    ],
                    additionalProperties: false,
                },
            },
        },
        required: ['foods'],
        additionalProperties: false,
    },
});

/**
 * The user turn: what to generate, and the names not to repeat.
 *
 * Every value here is this pipeline's OWN data — the coverage plan and the
 * canonical names already in `catalog_foods`. No fetched evidence text is ever
 * concatenated into a prompt, which is what keeps the retrieval boundary a
 * prompt-injection boundary (src/services/evidence.service.ts).
 */
export const buildGenerationUserContent = (batch: GenerationBatch, avoidNames: readonly string[]): string =>
    [
        `Category: ${batch.category}`,
        `Foods to propose: ${batch.candidateTarget}`,
        `Allowed food groups: ${batch.foodGroups.join(', ')}`,
        `Allowed food states: ${CATALOG_FOOD_STATES.join(', ')}`,
        '',
        avoidNames.length === 0
            ? 'The catalog holds no food in this category yet.'
            : `Names the catalog already holds — do not repeat any of them: ${avoidNames.join('; ')}`,
    ].join('\n');

// ---------------------------------------------------------------------------
// Narrowing the model's answer. Model output is untrusted structurally: every
// field is read off `unknown` and a candidate that fails a read is refused with
// a named reason rather than coerced.
// ---------------------------------------------------------------------------

export interface GeneratedFood {
    readonly canonicalName: string;
    readonly displayName: string;
    readonly foodState: CatalogFoodState;
    readonly foodGroup: string;
    readonly aliases: readonly string[];
    readonly calories: number | null;
    readonly proteinG: number | null;
    readonly carbsG: number | null;
    readonly fatG: number | null;
    readonly fiberG: number | null;
    readonly costClass: number;
    readonly allergenTags: readonly string[];
    readonly dietTags: readonly string[];
    readonly defaultPortion: {
        readonly description: string;
        readonly amount: number;
        readonly unit: string;
        readonly gramWeight: number;
    };
    readonly evidenceUrls: readonly string[];
}

/** One candidate the run refused, as the report lists it. */
export interface RefusedCandidate {
    readonly batchKey: string;
    readonly category: string;
    readonly name: string;
    /** A `CATALOG_CHECK_NAMES` member where one applies, otherwise a payload-shape code. */
    readonly reason: string;
    readonly observed?: string;
}

const asRecord = (value: unknown): Record<string, unknown> | undefined =>
    typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;

const readText = (value: unknown): string | null => {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim().replace(/\s+/g, ' ').slice(0, MAX_TEXT_FIELD_CHARS);
    return trimmed.length > 0 ? trimmed : null;
};

/** A nullable nutrient: absent, null or non-finite all read as UNKNOWN, never as 0. */
const readNullableNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) ? value : null;

const readPositiveNumber = (value: unknown): number | null =>
    typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

const readStringList = (value: unknown, limit: number): string[] => {
    if (!Array.isArray(value)) {
        return [];
    }
    const kept: string[] = [];
    const seen = new Set<string>();
    for (const entry of value) {
        const text = readText(entry);
        if (text === null) {
            continue;
        }
        const key = text.toLowerCase();
        if (seen.has(key)) {
            continue;
        }
        seen.add(key);
        kept.push(text);
        if (kept.length >= limit) {
            break;
        }
    }
    return kept;
};

/**
 * The foods in a batch response, plus the ones the payload itself refused.
 *
 * A payload that is not `{foods: [...]}` at all is a failure of the batch, not
 * of a candidate, and is reported as `model_response_unusable`.
 */
export const parseGeneratedFoods = (
    payload: unknown,
    batch: GenerationBatch,
    costClasses: readonly number[],
): { foods: GeneratedFood[]; refused: RefusedCandidate[] } => {
    // Some routed models answer with the JSON document as a STRING even under
    // a json_schema response format. The vendor boundary's own fallback parser
    // is the sanctioned recovery for that, and it throws OpenRouterError rather
    // than returning something unparsed.
    const document = typeof payload === 'string' ? parseModelJson(payload) : payload;

    const foodsValue = asRecord(document)?.foods;
    if (!Array.isArray(foodsValue)) {
        throw new CatalogGenerationError(
            'model_response_unusable',
            'the generation response carried no `foods` array',
            { batchKey: batch.batchKey, category: batch.category },
        );
    }

    const allowedGroups = new Set(batch.foodGroups);
    const foods: GeneratedFood[] = [];
    const refused: RefusedCandidate[] = [];

    const refuse = (name: string, reason: string, observed?: string): void => {
        refused.push({ batchKey: batch.batchKey, category: batch.category, name, reason, observed });
    };

    for (const entry of foodsValue) {
        const record = asRecord(entry);
        if (record === undefined) {
            refuse('', 'payload_not_an_object');
            continue;
        }

        const canonicalName = readText(record.canonicalName);
        const displayName = readText(record.displayName) ?? canonicalName;
        if (canonicalName === null || displayName === null || normalizeCanonicalName(canonicalName).length === 0) {
            refuse(String(record.canonicalName ?? ''), 'payload_missing_name');
            continue;
        }

        const foodState = record.foodState;
        if (!isCatalogFoodState(foodState)) {
            refuse(canonicalName, 'payload_invalid_food_state', String(foodState));
            continue;
        }

        const foodGroup = readText(record.foodGroup);
        if (foodGroup === null || !allowedGroups.has(foodGroup)) {
            refuse(canonicalName, 'payload_invalid_food_group', String(record.foodGroup ?? ''));
            continue;
        }

        const costClass = readPositiveNumber(record.costClass);
        if (costClass === null || !Number.isInteger(costClass) || costClasses.indexOf(costClass) === -1) {
            refuse(canonicalName, 'payload_invalid_cost_class', String(record.costClass ?? ''));
            continue;
        }

        const portion = asRecord(record.defaultPortion);
        const portionDescription = portion === undefined ? null : readText(portion.description);
        const portionUnit = portion === undefined ? null : readText(portion.unit);
        const portionAmount = portion === undefined ? null : readPositiveNumber(portion.amount);
        const portionGramWeight = portion === undefined ? null : readPositiveNumber(portion.gramWeight);

        // A published food needs one default portion carrying a SOURCED gram
        // weight, and an invented weight is exactly the fabricated nutrition
        // the catalog policy forbids — so a payload without one is refused
        // under the check name the validator would have used.
        if (
            portionDescription === null ||
            portionUnit === null ||
            portionAmount === null ||
            portionGramWeight === null
        ) {
            refuse(canonicalName, CATALOG_CHECK_NAMES.MISSING_GRAM_WEIGHT, JSON.stringify(record.defaultPortion ?? null));
            continue;
        }

        const aliases = readStringList(record.aliases, MAX_ALIASES_PER_CANDIDATE);

        // THE BRAND REFUSAL, BEFORE ANY EVIDENCE FETCH AND BEFORE ANY WRITE.
        // The rule itself is catalog.logic.ts's (`findBrandPatternMatch`) — no
        // pattern is written here — and it is applied at parse time because the
        // alternative is spending a network round trip and a database write on a
        // candidate whose identity could never be corroborated: a
        // model-proposed manufacturer domain cannot verify a model-proposed
        // product. `validateCatalogCandidate` applies the same rule again for
        // the validation record, which is the audit trail, not the gate.
        const brand = findBrandPatternMatch([canonicalName, displayName, ...aliases]);
        if (brand !== null) {
            refuse(canonicalName, CATALOG_CHECK_NAMES.BRAND_PATTERN_NAME, `${brand.reason}:${brand.token}`);
            continue;
        }

        foods.push({
            canonicalName,
            displayName,
            foodState,
            foodGroup,
            aliases,
            calories: readNullableNumber(record.caloriesPer100g),
            proteinG: readNullableNumber(record.proteinGPer100g),
            carbsG: readNullableNumber(record.carbsGPer100g),
            fatG: readNullableNumber(record.fatGPer100g),
            fiberG: readNullableNumber(record.fiberGPer100g),
            costClass,
            allergenTags: readStringList(record.allergenTags, MAX_TAGS_PER_CANDIDATE),
            dietTags: readStringList(record.dietTags, MAX_TAGS_PER_CANDIDATE),
            defaultPortion: {
                description: portionDescription,
                amount: portionAmount,
                unit: portionUnit,
                gramWeight: portionGramWeight,
            },
            evidenceUrls: readStringList(record.evidenceUrls, MAX_EVIDENCE_URLS_PER_CANDIDATE),
        });
    }

    return { foods, refused };
};

// ---------------------------------------------------------------------------
// Identity evidence. Retrieved only through src/services/evidence.service.ts,
// which enforces the allowlist, the address policy, the pinned DNS resolution,
// the redirect bound, the timeout and the body cap.
// ---------------------------------------------------------------------------

/** The retrieval records for one candidate, and what they establish about it. */
export interface EvidenceOutcome {
    /** Every attempt's record, stored verbatim in the validation record. */
    readonly records: readonly unknown[];
    /** The refusal reasons, by code, for the report and the log. */
    readonly refusals: readonly string[];
    /** `verified` only when a fetched page actually named the food. */
    readonly identityStatus: 'verified' | 'unsourced';
}

/**
 * Retrieves identity evidence for one candidate.
 *
 * A page that was fetched but does NOT mention the candidate is evidence that
 * failed to corroborate (`matchedSnippet === null`), which is a different fact
 * from no evidence at all and still leaves the candidate `unsourced` — the
 * quarantine-tier `unsourced` check is what holds it out of the published
 * catalog, so it never counts toward the coverage target.
 *
 * Only the HOST is logged, never the model-proposed URL or the fetched body.
 */
export const collectIdentityEvidence = async (
    deps: GenerationDeps,
    food: GeneratedFood,
    batch: GenerationBatch,
): Promise<EvidenceOutcome> => {
    const records: unknown[] = [];
    const refusals: string[] = [];
    let identityStatus: 'verified' | 'unsourced' = 'unsourced';

    for (const url of food.evidenceUrls.slice(0, MAX_EVIDENCE_URLS_PER_CANDIDATE)) {
        const result = await deps.fetchEvidence(
            url,
            food.canonicalName,
            deps.evidencePolicy,
            EVIDENCE_CLAIM as EvidenceClaim,
        );

        if (!result.ok) {
            refusals.push(result.reason);
            deps.logger.debug('evidence_refused', {
                stage: STAGE,
                batchKey: batch.batchKey,
                host: result.host ?? hostOf(url),
                reason: result.reason,
            });
            continue;
        }

        records.push(result.record);

        if (result.record.matchedSnippet !== null) {
            identityStatus = 'verified';
            deps.logger.debug('evidence_matched', {
                stage: STAGE,
                batchKey: batch.batchKey,
                host: result.record.finalHost,
                status: result.record.status,
            });
            break;
        }

        refusals.push('name_not_found_in_body');
    }

    return { records, refusals, identityStatus };
};

// ---------------------------------------------------------------------------
// From a generated food to the rows the catalog stores.
// ---------------------------------------------------------------------------

export interface PreparedGeneratedFood {
    readonly sourceKey: string;
    readonly candidate: CatalogFoodCandidate;
    readonly aliases: readonly string[];
    readonly portions: readonly CatalogFoodPortionCandidate[];
    readonly searchText: string;
    readonly foodGroup: string;
    readonly costClass: number;
    readonly isCommonDislike: boolean;
    readonly dietTags: readonly string[];
    readonly evidence: EvidenceOutcome;
    /** The per-100 g values the checks judged, or `null` when the basis was unusable. */
    readonly nutritionPer100g: {
        calories: number | null;
        protein_g: number | null;
        carbs_g: number | null;
        fat_g: number | null;
        fiber_g: number | null;
    } | null;
}

/**
 * Shapes one generated food into the candidate the validator judges and the
 * row set the database stores.
 *
 * WHY `allergen_status` IS ALWAYS `'unknown'` HERE. An allergen list is a
 * SAFETY claim, and this one is a language model's. Marking it `known` would
 * pass the review-tier `allergens_unknown` check on the model's word and let an
 * AI-estimated food be published as if its allergen composition had been
 * established. The tags are still recorded — as the model's claim — so
 * catalog-validate.ts's advisory review or a curator can lift the flag with
 * `confirmedCheckNames`, which is the sanctioned path and the only one. The
 * practical cost is nil: recipe eligibility requires `source_backed` nutrition,
 * so an AI-estimated food is never planned into a meal either way.
 */
export const prepareGeneratedFood = (
    food: GeneratedFood,
    batch: GenerationBatch,
    coveragePlan: CoveragePlan,
    evidence: EvidenceOutcome,
): PreparedGeneratedFood => {
    const sourceKey = buildSourceKey({
        identitySource: 'ai_generated',
        category: batch.category,
        canonicalName: food.canonicalName,
        foodState: food.foodState,
    });

    const aliases = dedupeSortedAliases([food.displayName, ...food.aliases], food.canonicalName);

    const portions: CatalogFoodPortionCandidate[] = [
        {
            description: food.defaultPortion.description,
            amount: food.defaultPortion.amount,
            unit: food.defaultPortion.unit,
            gram_weight: food.defaultPortion.gramWeight,
            is_default: true,
            source: 'ai_generated_portion',
        },
    ];

    const candidate: CatalogFoodCandidate = {
        source_key: sourceKey,
        canonical_name: food.canonicalName,
        display_name: food.displayName,
        aliases,
        category: batch.category,
        food_state: food.foodState,
        identity_source: 'ai_generated',
        identity_status: evidence.identityStatus,
        nutrition_provenance: 'ai_estimated',
        allergen_status: 'unknown',
        allergen_tags: food.allergenTags,
        nutrition_basis: 'per_100g',
        basis_amount: PER_100G_BASIS_AMOUNT,
        calories: food.calories,
        protein_g: food.proteinG,
        carbs_g: food.carbsG,
        fat_g: food.fatG,
        fiber_g: food.fiberG,
        portions,
    };

    // The basis conversion is catalog.logic.ts's decision even though the model
    // is asked for per-100 g values: a stated basis is still a claim, and the
    // module that owns the conversion is the one that decides whether it can be
    // made. The factor here is 1, and delegating keeps it that way by rule
    // rather than by assumption.
    const normalized = normalizeToPer100g(candidate);

    const isCommonDislike = coveragePlan.foodGroups.some(
        (group) => group.foodGroup === food.foodGroup && group.isCommonDislikeGroup,
    );

    return {
        sourceKey,
        candidate,
        aliases,
        portions,
        searchText: buildSearchText(food.canonicalName, aliases, food.foodState, food.foodGroup),
        foodGroup: food.foodGroup,
        costClass: food.costClass,
        isCommonDislike,
        dietTags: food.dietTags,
        evidence,
        nutritionPer100g: normalized.kind === 'ok' ? normalized.normalized.nutrition : null,
    };
};

/**
 * What the generation stage writes to `publication_status`.
 *
 * Generation never publishes — the same rule the import follows. A record the
 * checks would accept is written as a `candidate`, because publication needs
 * the cross-table duplicate decision and the advisory review that only a pass
 * over the whole table can make, and that pass is `catalog:validate`.
 */
export const generationPublicationStatus = (verdict: CatalogValidationVerdict): string =>
    verdict.publicationStatus === 'published' ? 'candidate' : verdict.publicationStatus;

/** The `select` the version decision needs, keyed off the shared fact type. */
const VERSIONED_FACT_SELECT: Record<keyof StoredVersionedFacts, true> = {
    nutrition_version: true,
    metadata_version: true,
    calories: true,
    protein_g: true,
    carbs_g: true,
    fat_g: true,
    fiber_g: true,
    nutrition_basis: true,
    basis_amount: true,
    density_g_per_ml: true,
    nutrition_provenance: true,
    usda_fdc_id: true,
    usda_data_type: true,
    source_version: true,
    canonical_name: true,
    display_name: true,
    food_group: true,
    allergen_status: true,
    allergen_tags: true,
    diet_tags: true,
};

/**
 * Writes one generated food, its aliases, its portions and its validation
 * record.
 *
 * Upserted on `source_key`, which for a generated food is
 * `ai:<category>:<normalized canonical name>:<food_state>` — deterministic, so
 * a rerun of the same batch converges on the same row instead of adding a
 * second one. Aliases and portions are replaced wholesale by their own unique
 * keys, because the batch that produced the food is the authority on both.
 *
 * `search_vector` is NEVER written: it is a STORED generated column computed by
 * PostgreSQL from `search_text`.
 */
export const persistGeneratedFood = async (
    db: GenerationDb,
    prepared: PreparedGeneratedFood,
    verdict: CatalogValidationVerdict,
    publicationStatus: string,
    generationBatchId: string | null,
    now: Date,
    provenance: { coveragePlanVersion: string; promptVersion: string; model: string; batchKey: string },
): Promise<'inserted' | 'updated'> => {
    const existing = await db.catalog_foods.findUnique({
        where: { source_key: prepared.sourceKey },
        select: { id: true, imported_at: true, ...VERSIONED_FACT_SELECT },
    });

    const nutrition = prepared.nutritionPer100g;
    const facts = {
        canonical_name: prepared.candidate.canonical_name,
        display_name: prepared.candidate.display_name ?? prepared.candidate.canonical_name,
        category: prepared.candidate.category,
        food_state: prepared.candidate.food_state,
        identity_source: 'ai_generated',
        identity_status: prepared.candidate.identity_status,
        nutrition_provenance: 'ai_estimated',
        nutrition_basis: 'per_100g',
        basis_amount: PER_100G_BASIS_AMOUNT,
        // A null nutrient is UNKNOWN and is stored as NULL. It is never coerced
        // to 0, which would claim the food contains none of it.
        calories: nutrition === null ? null : nutrition.calories,
        protein_g: nutrition === null ? null : nutrition.protein_g,
        carbs_g: nutrition === null ? null : nutrition.carbs_g,
        fat_g: nutrition === null ? null : nutrition.fat_g,
        fiber_g: nutrition === null ? null : nutrition.fiber_g,
        density_g_per_ml: null,
        usda_fdc_id: null,
        usda_data_type: null,
        usda_description: null,
        source_version: `${STAGE}:${prepared.evidence.identityStatus}`,
        source_cache_key: null,
        generation_batch_id: generationBatchId,
        publication_status: publicationStatus,
        allergen_tags: [...(prepared.candidate.allergen_tags ?? [])],
        allergen_status: prepared.candidate.allergen_status,
        diet_tags: [...prepared.dietTags],
        food_group: prepared.foodGroup,
        is_common_dislike: prepared.isCommonDislike,
        cost_class: prepared.costClass,
        search_text: prepared.searchText,
        updated_at: now,
    };

    const versions = nextCatalogFoodVersions(existing, facts);
    const scalars = {
        ...facts,
        nutrition_version: versions.nutritionVersion,
        metadata_version: versions.metadataVersion,
    };

    const foodId =
        existing === null
            ? (
                  await db.catalog_foods.create({
                      data: { ...scalars, source_key: prepared.sourceKey, imported_at: now },
                  })
              ).id
            : (await db.catalog_foods.update({ where: { id: existing.id }, data: scalars })).id;

    await db.catalog_food_aliases.deleteMany({ where: { catalog_food_id: foodId } });
    if (prepared.aliases.length > 0) {
        await db.catalog_food_aliases.createMany({
            data: prepared.aliases.map((alias) => ({ catalog_food_id: foodId, alias })),
            skipDuplicates: true,
        });
    }

    await db.catalog_food_portions.deleteMany({ where: { catalog_food_id: foodId } });
    // gram_weight is NOT NULL, and a portion without a stated weight was already
    // refused at parse time — this filter is the invariant restated at the write,
    // never a place a zero could be substituted.
    const storablePortions = prepared.portions.filter(
        (portion) => typeof portion.gram_weight === 'number' && portion.gram_weight > 0,
    );
    if (storablePortions.length > 0) {
        await db.catalog_food_portions.createMany({
            data: storablePortions.map((portion) => ({
                catalog_food_id: foodId,
                description: portion.description,
                amount: portion.amount,
                unit: portion.unit,
                gram_weight: portion.gram_weight as number,
                is_default: portion.is_default,
                source: portion.source ?? 'ai_generated_portion',
            })),
            skipDuplicates: true,
        });
    }

    const record = buildGenerationValidationRecord(prepared, verdict, publicationStatus, now, provenance);
    await db.catalog_validation_records.upsert({
        where: { catalog_food_id: foodId },
        create: { catalog_food_id: foodId, ...record, history: [] },
        update: record,
    });

    return existing === null ? 'inserted' : 'updated';
};

/**
 * The machine-readable validation record AAP §0.1.1 requires for every item:
 * what the food claims to be, how its nutrition was arrived at, what was
 * assumed, which checks ran with their observed values and bounds, and what
 * evidence establishes its identity.
 *
 * `llm_review` is null here, and meaningfully so: the generating model is not a
 * reviewer of its own output, and a model name in this field would imply a
 * review that never happened. catalog-validate.ts writes the advisory review.
 */
export const buildGenerationValidationRecord = (
    prepared: PreparedGeneratedFood,
    verdict: CatalogValidationVerdict,
    publicationStatus: string,
    now: Date,
    provenance: { coveragePlanVersion: string; promptVersion: string; model: string; batchKey: string },
): Record<string, unknown> => ({
    canonical_identity: {
        source_key: prepared.sourceKey,
        canonical_name: prepared.candidate.canonical_name,
        display_name: prepared.candidate.display_name,
        food_state: prepared.candidate.food_state,
        category: prepared.candidate.category,
        food_group: prepared.foodGroup,
        usda_fdc_id: null,
    },
    aliases: [...prepared.aliases],
    category: prepared.candidate.category,
    food_state: prepared.candidate.food_state,
    identity_source: 'ai_generated',
    identity_status: prepared.candidate.identity_status,
    nutrition_provenance: 'ai_estimated',
    nutrition_method: 'model_estimated_per_100g',
    nutrition_assumptions: JSON.stringify([
        'Values are a language model\'s estimate for a generic preparation, stated per 100 g and never measured.',
        'The allergen list is the model\'s claim and is recorded with allergen_status unknown, so it is never read as established.',
        prepared.evidence.identityStatus === 'verified'
            ? 'Identity corroborated by an allowlisted reference whose text names the food; the nutrition itself is not corroborated by it.'
            : 'No allowlisted reference corroborated the identity, so the record is unsourced and cannot be published.',
    ]),
    portion_units: prepared.portions.map((portion) => ({
        description: portion.description,
        amount: portion.amount,
        unit: portion.unit,
        gram_weight: portion.gram_weight,
        is_default: portion.is_default,
        source: portion.source ?? 'ai_generated_portion',
    })),
    identity_evidence: [...prepared.evidence.records],
    checks: verdict.checks,
    llm_review: null,
    outcome: verdict.outcome,
    reviewed_at: now,
    publication_status: publicationStatus,
    source_versions: {
        coverage_plan_version: provenance.coveragePlanVersion,
        generation_prompt_version: provenance.promptVersion,
        generation_model: provenance.model,
        generation_batch_key: provenance.batchKey,
    },
});

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

/**
 * The report keys this stage owns, and therefore the only ones it replaces.
 *
 * Every other key in data/meal-planning/reports/latest/import-report.json
 * belongs to a sibling — the import stage's own counts, catalog-report.ts's
 * aggregate sections, the release identity — and survives a generation run
 * untouched. A plain write would delete all of it.
 */
export const GENERATION_REPORT_NOTE_KEY = 'generationStageWrite';

/**
 * Writes the generation half of the report file, MERGING rather than
 * clobbering.
 *
 * A DOCUMENT THAT CANNOT BE PARSED IS REPLACED, NOT PRESERVED, and the run says
 * so: merging into a half-written file would carry unreadable content forward
 * under this run's name, and failing the run over a stale report file would
 * throw away work already committed to the database.
 */
export const writeGenerationReport = (target: string, report: unknown, log: ScriptLogger): void => {
    fs.mkdirSync(path.dirname(target), { recursive: true });

    let existing: Record<string, unknown> = {};
    if (fs.existsSync(target)) {
        try {
            const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf-8'));
            if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
                existing = parsed as Record<string, unknown>;
            } else {
                log.warn('report_replaced', {
                    stage: STAGE,
                    file: path.basename(target),
                    reason: 'the existing report is not a JSON object, so there is nothing to merge into',
                });
            }
        } catch (error) {
            log.warn('report_replaced', {
                stage: STAGE,
                file: path.basename(target),
                reason: 'the existing report could not be parsed as JSON',
                error: safeError(error),
            });
        }
    }

    const written = report as Record<string, unknown>;
    const merged = {
        ...existing,
        ...written,
        [GENERATION_REPORT_NOTE_KEY]: {
            mergedIntoExisting: Object.keys(existing).length > 0,
            preservedKeys: Object.keys(existing)
                .filter((key) => !Object.prototype.hasOwnProperty.call(written, key))
                .sort(),
            basis:
                'The generation stage replaces the keys it measures and preserves every other key in the document, because the import stage and catalog-report.ts write into the same file. preservedKeys names what this write left alone.',
        },
    };

    fs.writeFileSync(target, `${JSON.stringify(merged, null, 2)}\n`, 'utf-8');
};

/** One model call, as the report's `modelSpend.perBatchKey` lists it. */
interface BatchSpend {
    readonly batchKey: string;
    readonly category: string;
    readonly reserved: number;
    readonly used: number;
    readonly succeeded: boolean;
}

/** The per-category outcome split the report's `categories` rows are built from. */
interface CategoryOutcomeCounts {
    written: number;
    candidates: number;
    quarantined: number;
    rejected: number;
}

const categoryOutcome = (
    byCategory: Map<string, CategoryOutcomeCounts>,
    category: string,
): CategoryOutcomeCounts => {
    const existing = byCategory.get(category);
    if (existing) {
        return existing;
    }
    const created: CategoryOutcomeCounts = { written: 0, candidates: 0, quarantined: 0, rejected: 0 };
    byCategory.set(category, created);
    return created;
};

/** Published rows per category, so the reported shortfall is measured and not asserted. */
const readPublishedByCategory = async (db: GenerationDb): Promise<Record<string, number>> => {
    const grouped = await db.catalog_foods.groupBy({
        by: ['category'],
        where: { publication_status: 'published' },
        _count: { _all: true },
    });

    const counts: Record<string, number> = {};
    for (const row of grouped) {
        const count = row._count._all;
        counts[row.category] = typeof count === 'number' && Number.isFinite(count) ? count : 0;
    }
    return counts;
};

/** One quarantined or rejected row, as the report's worklist lists it. */
interface QuarantinedRecord {
    readonly sourceKey: string;
    readonly category: string;
    readonly foodState: string;
    readonly publicationStatus: string;
    readonly identityStatus: string;
    readonly failedChecks: readonly string[];
}

/** Everything the report is assembled from, gathered by the run as it goes. */
interface GenerationTally {
    readonly counts: Record<string, number>;
    readonly byCategoryOutcome: Map<string, CategoryOutcomeCounts>;
    readonly failuresByCheck: Record<string, number>;
    readonly tierByCheckName: Record<string, string>;
    readonly refused: RefusedCandidate[];
    readonly quarantined: QuarantinedRecord[];
    readonly spend: BatchSpend[];
    readonly evidenceRefusals: Record<string, number>;
    readonly duplicateSourceKeys: string[];
}

const newTally = (plannedBatches: number, aiCandidatesPlanned: number): GenerationTally => ({
    counts: {
        plannedBatches,
        aiCandidatesPlanned,
        executedBatches: 0,
        skippedBatches: 0,
        failedBatches: 0,
        modelCallsReserved: 0,
        modelCallsUsed: 0,
        candidatesProposed: 0,
        candidatesRefused: 0,
        duplicatesRemoved: 0,
        inserted: 0,
        updated: 0,
        candidates: 0,
        quarantined: 0,
        rejected: 0,
        evidenceVerified: 0,
        evidenceUnsourced: 0,
    },
    byCategoryOutcome: new Map<string, CategoryOutcomeCounts>(),
    failuresByCheck: {},
    tierByCheckName: {},
    refused: [],
    quarantined: [],
    spend: [],
    evidenceRefusals: {},
    duplicateSourceKeys: [],
});

const bump = (counters: Record<string, number>, key: string, by = 1): void => {
    counters[key] = (counters[key] ?? 0) + by;
};

// The check-name vocabulary as a membership test. Derived from the exported
// constant rather than listed, so a name added to catalog.logic.ts is
// recognised here without an edit, and a refusal reason that is NOT a check
// name (a payload-shape refusal) is grouped honestly instead of being filed
// under a tier it does not have.
const CATALOG_CHECK_NAME_VALUES: readonly string[] = Object.values(CATALOG_CHECK_NAMES);

const isCatalogCheckName = (value: string): value is CatalogCheckName =>
    CATALOG_CHECK_NAME_VALUES.includes(value);

/** `candidate` | `quarantined` | `rejected` → the counter key the report publishes. */
const publicationStatusCountKey = (publicationStatus: string): string =>
    publicationStatus === 'quarantined'
        ? 'quarantined'
        : publicationStatus === 'rejected'
          ? 'rejected'
          : 'candidates';

const buildGenerationReport = (
    deps: GenerationDeps,
    plan: GenerationPlan,
    tally: GenerationTally,
    publishedByCategory: Readonly<Record<string, number>>,
    outcome: {
        readonly runId: string | null;
        readonly resumed: boolean;
        readonly stopReason: GenerationStopReason;
        readonly stoppedAtBatchKey: string | null;
    },
): Record<string, unknown> => {
    const { coveragePlan, options } = deps;
    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };

    // The shortfall is catalog.logic.ts's computation over MEASURED published
    // rows, never this stage's arithmetic and never an estimate: generation
    // publishes nothing, so a shortfall this run "closed" would be a fiction.
    const coverage = computeCoverageShortfall(policy, publishedByCategory);

    const categories = coveragePlan.categories.map((category) => {
        const outcomeCounts = tally.byCategoryOutcome.get(category.category);
        const shortfallRow = coverage.categories.find((row) => row.category === category.category);
        return {
            category: category.category,
            publishedTarget: category.publishedTarget,
            candidateVolume: category.candidateVolume,
            usdaImported: plan.usdaImportedByCategory[category.category] ?? 0,
            aiCandidates: plan.aiCandidatesByCategory[category.category] ?? 0,
            batches: plan.executable.batchesByCategory[category.category] ?? 0,
            written: outcomeCounts?.written ?? 0,
            candidates: outcomeCounts?.candidates ?? 0,
            quarantined: outcomeCounts?.quarantined ?? 0,
            rejected: outcomeCounts?.rejected ?? 0,
            published: shortfallRow?.published ?? 0,
            shortfall: shortfallRow?.shortfall ?? category.publishedTarget,
        };
    });

    const failuresByTier: Record<string, Record<string, number>> = {};
    for (const [name, count] of Object.entries(tally.failuresByCheck)) {
        const tier = tally.tierByCheckName[name] ?? 'unknown';
        const group = failuresByTier[tier] ?? {};
        group[name] = count;
        failuresByTier[tier] = group;
    }

    const modelCallsReserved = tally.counts.modelCallsReserved;
    const modelCallsUsed = tally.counts.modelCallsUsed;

    return {
        stage: STAGE,
        generatedAt: deps.now().toISOString(),
        runId: outcome.runId,
        resumed: outcome.resumed,
        stopReason: outcome.stopReason,
        coveragePlanVersion: coveragePlan.coveragePlanVersion,
        generationPromptVersion: coveragePlan.promptVersion,
        planFingerprint: plan.fingerprint,
        options: {
            categories: options.categories,
            batchSize: deps.batchSize,
            maxBatches: options.maxBatches,
            resume: options.resume,
            dryRun: options.dryRun,
        },
        plannedBatches: plan.batches.length,
        executedBatches: tally.counts.executedBatches,
        skippedBatches: tally.counts.skippedBatches,
        failedBatches: tally.counts.failedBatches,
        truncatedByMaxBatches: plan.truncatedByMaxBatches,
        aiGenerationCounts: { ...tally.counts },
        aiCategories: categories,
        coverageGaps: coverage.categories
            .filter((row) => row.shortfall > 0)
            .map((row) => ({
                category: row.category,
                publishedTarget: row.publishedTarget,
                published: row.published,
                shortfall: row.shortfall,
            })),
        aiCoverage: {
            publishedTotal: coverage.publishedTotal,
            publishedTargetTotal: coverage.publishedTargetTotal,
            shortfallTotal: coverage.shortfallTotal,
            meetsTarget: coverage.meetsTarget,
            unknownCategories: coverage.unknownCategories,
            basis:
                'max(0, publishedTarget − published) per category, over catalog_foods rows whose publication_status is published. Exact: a surplus in one category never offsets a deficit in another, and this stage publishes nothing, so a nonzero shortfall here is the honest state until catalog:validate has run.',
        },
        duplicatesRemoved: {
            generationStage: tally.counts.duplicatesRemoved,
            basis:
                'Identities folded into a survivor before insert: dedupeIdentity within a batch, source keys already written by this run, and an alias already owned by another food. The cross-table decision belongs to catalog:validate, which runs dedupeIdentity over the whole table.',
            sourceKeys: tally.duplicateSourceKeys.slice(0, REFUSAL_LIST_LIMIT),
        },
        failuresByCheck: {
            checkNameVocabulary:
                'src/services/catalog.logic.ts CATALOG_CHECK_NAMES, with the tier recorded on each check by the validator',
            generationStage: failuresByTier,
        },
        aiQuarantined: {
            total: tally.counts.quarantined + tally.counts.rejected,
            listed: tally.quarantined.length,
            truncated: tally.quarantined.length >= REFUSAL_LIST_LIMIT,
            listLimit: REFUSAL_LIST_LIMIT,
            records: tally.quarantined,
        },
        refusedCandidates: {
            total: tally.counts.candidatesRefused,
            listed: tally.refused.length,
            truncated: tally.refused.length >= REFUSAL_LIST_LIMIT,
            listLimit: REFUSAL_LIST_LIMIT,
            records: tally.refused,
            note:
                'Refused before any evidence fetch and before any write. A brand-pattern name is refused by src/services/catalog.logic.ts findBrandPatternMatch, because a model-proposed manufacturer domain cannot independently verify a model-proposed product.',
        },
        aiEvidence: {
            verified: tally.counts.evidenceVerified,
            unsourced: tally.counts.evidenceUnsourced,
            refusalsByReason: tally.evidenceRefusals,
            claim: EVIDENCE_CLAIM,
            maxUrlsPerCandidate: MAX_EVIDENCE_URLS_PER_CANDIDATE,
            policy:
                'src/services/evidence.service.ts, bound by data/meal-planning/evidence-allowlist.v1.json. Fetched pages are stored as retrieval records and matched against the candidate name; no fetched text is ever put into a prompt.',
        },
        modelSpend: {
            meteringOrder:
                'Reserve one call in catalog_generation_batches.model_calls_reserved BEFORE the vendor call, record model_calls_used after it. A FAILED CALL KEEPS ITS RESERVATION, so a failure is never a free retry.',
            scope:
                'Operator scope, not ai_usage: these calls have no user, so the per-user quota ledger cannot meter them. The order Rule backend-architecture §9 requires is kept through scripts/lib/budget.ts.',
            budgetEnvVar: MODEL_CALL_BUDGET_ENV,
            budgetLimit: deps.budgetLimit,
            batchSizeEnvVar: BATCH_SIZE_ENV,
            batchSize: deps.batchSize,
            modelCallsPerBatch: coveragePlan.modelCallsPerBatch,
            generationModelEnvVar: GENERATION_MODEL_ENV,
            generationModelFallbackEnvVar: GENERATION_MODEL_FALLBACK_ENV,
            generationModel: deps.model,
            batchesPlanned: plan.batches.length,
            modelCallsPlannedIfGenerated: plan.executable.estimatedModelCalls,
            modelCallsReserved,
            modelCallsUsed,
            reservedNotYetUsed: modelCallsReserved - modelCallsUsed,
            budgetRemaining: deps.budgetLimit - modelCallsReserved,
            tokensUsed: tally.counts.tokensUsed ?? 0,
            tokensUsedNote:
                'The vendor boundary returns the parsed document only and surfaces no usage block, so token counts are recorded as 0 rather than guessed.',
            budgetExhausted: outcome.stopReason === 'budget_exhausted',
            stoppedAtBatchKey: outcome.stoppedAtBatchKey,
            perBatchKey: tally.spend,
            batchKeyFormat: `${coveragePlan.coveragePlanVersion}:<category>:<batchIndex>`,
            batchIndexPadWidth: 4,
        },
        note:
            'Every food this stage writes is an AI estimate: identity_source ai_generated, nutrition_provenance ai_estimated, publication_status candidate or quarantined. catalog:validate is the stage that publishes, and the estimate labels follow the food through search, recipe details and diary logging.',
    };
};

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** The names the prompt is told to avoid, per category, read once per run. */
const readCategoryNames = async (db: GenerationDb, category: string): Promise<string[]> => {
    const rows = await db.catalog_foods.findMany({
        where: { category },
        select: { canonical_name: true },
        orderBy: { canonical_name: 'asc' },
        take: MAX_AVOID_NAMES,
    });
    return rows.map((row) => row.canonical_name);
};

/**
 * The source key of an existing food that already answers to one of this
 * candidate's names, or `null` when none does.
 *
 * An alias collision is a duplicate identity the source key cannot see: two
 * different canonical names can legitimately produce two keys while one of them
 * is already an alias of the other's food. Passing the owner into the validator
 * as `duplicateOfSourceKey` is what turns that into the quarantine-tier
 * `duplicate_identity` check rather than a second row for one food.
 */
const findAliasOwner = async (db: GenerationDb, prepared: PreparedGeneratedFood): Promise<string | null> => {
    const names = [prepared.candidate.canonical_name, ...prepared.aliases];
    const owners = await db.catalog_food_aliases.findMany({
        where: { alias: { in: names } },
        select: { alias: true, catalog_food_id: true, catalog_foods: { select: { source_key: true } } },
        take: MAX_ALIASES_PER_CANDIDATE,
    });

    const foreign = owners.find((owner) => owner.catalog_foods.source_key !== prepared.sourceKey);
    return foreign === undefined ? null : foreign.catalog_foods.source_key;
};

/**
 * Closes a run that threw, WITHOUT touching its cursor.
 *
 * The saved index is what makes `--resume` pick up where this attempt stopped,
 * and the status is what tells an operator (and `catalog:validate`'s
 * prerequisite read) that the attempt stopped rather than is still in flight. A
 * failure to close is reported BESIDE the original failure, never instead of
 * it: the original is what the operator has to act on.
 */
const closeFailedRun = async (
    deps: GenerationDeps,
    runId: string,
    counts: Record<string, number>,
    error: unknown,
): Promise<void> => {
    try {
        await finishRun(deps.runDb, runId, 'failed', { counts, error, logger: deps.logger });
    } catch (closeError) {
        deps.logger.error('run_close_failed', {
            stage: STAGE,
            runId,
            error: safeError(closeError),
            originalError: safeError(error),
        });
    }
};

/**
 * Generates one run's worth of candidate catalog foods.
 *
 * The order is the one Rule backend-architecture §9 fixes and is not an
 * implementation detail: plan → ASSERT THE BUDGET → claim the run → per batch
 * reserve, call, record, then parse, corroborate, dedupe and write. Nothing
 * before the assertion spends anything, and nothing between a reservation and
 * its usage record can leave the ledger understating what was spent.
 */
export const runGeneration = async (deps: GenerationDeps): Promise<GenerationSummary> => {
    const log = deps.logger;
    const { coveragePlan, options } = deps;

    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };
    const costClasses = coveragePlan.costClassScale.map((entry) => entry.costClass);

    const plan = await buildGenerationPlan(deps);
    const aiCandidatesPlanned = plan.batches.reduce((total, batch) => total + batch.candidateTarget, 0);

    log.info('plan_built', {
        stage: STAGE,
        batches: plan.batches.length,
        aiCandidates: aiCandidatesPlanned,
        fingerprint: plan.fingerprint.slice(0, 16),
        truncatedByMaxBatches: plan.truncatedByMaxBatches,
        batchSize: deps.batchSize,
    });

    // THE AUTHORITATIVE BUDGET GATE (§9), on the plan this invocation will
    // execute, BEFORE the first vendor call. assertModelCallBudget logs the
    // estimate unconditionally — including on the refusal — so an operator
    // reading a rejected launch is told the number to raise the cap to.
    try {
        assertModelCallBudget(plan.executable, deps.budgetLimit, log);
    } catch (error) {
        if (error instanceof ModelBudgetError) {
            throw new CatalogGenerationError(
                error.code === 'budget_insufficient' ? 'budget_insufficient' : 'budget_misconfigured',
                error.message,
                { detail: error.code },
            );
        }
        throw asGenerationFailure(error, 'budget_misconfigured');
    }

    const tally = newTally(plan.batches.length, aiCandidatesPlanned);

    // A DRY RUN OPENS NO RUN ROW, MAKES NO MODEL CALL AND WRITES NOTHING.
    // openOrResumeRun claims (kind, manifestVersion) and a completed claim is a
    // permanent no-op for that pair, so a dry run claiming the canonical key
    // would stop the real generation from ever running. It does READ the
    // catalog — the AI volume is `candidateVolume − imported`, which is a count
    // of rows and cannot be assumed — and reporting the plan and its cost is
    // the whole job here.
    if (options.dryRun) {
        const publishedByCategory = await readPublishedByCategory(deps.prisma);
        deps.writeReport(
            buildGenerationReport(deps, plan, tally, publishedByCategory, {
                runId: null,
                resumed: false,
                stopReason: 'dry_run',
                stoppedAtBatchKey: null,
            }),
        );

        return {
            runId: null,
            resumed: false,
            stopReason: 'dry_run',
            plannedBatches: plan.batches.length,
            executedBatches: 0,
            skippedBatches: 0,
            counts: tally.counts,
            shortfallTotal: computeCoverageShortfall(policy, publishedByCategory).shortfallTotal,
            modelCallsReserved: 0,
            modelCallsUsed: 0,
        };
    }

    const claim = await openOrResumeRun<GenerationCursor>(deps.runDb, {
        kind: RUN_KIND,
        manifestVersion: generationRunScope(coveragePlan.coveragePlanVersion, options),
        initialCursor: { fingerprint: plan.fingerprint, nextBatchIndex: 0, modelCallsReserved: 0 },
        logger: log,
        now: deps.now,
    });

    if (claim.alreadyCompleted) {
        log.info('run_already_completed', {
            stage: STAGE,
            runId: claim.run.id,
            counts: JSON.stringify(claim.run.counts ?? {}),
        });

        const publishedByCategory = await readPublishedByCategory(deps.prisma);
        return {
            runId: claim.run.id,
            resumed: true,
            stopReason: 'already_completed',
            plannedBatches: plan.batches.length,
            executedBatches: 0,
            skippedBatches: 0,
            counts: (claim.run.counts ?? {}) as Record<string, number>,
            shortfallTotal: computeCoverageShortfall(policy, publishedByCategory).shortfallTotal,
            modelCallsReserved: await deps.budget.reserved(claim.run.id),
            modelCallsUsed: 0,
        };
    }

    const runId = claim.run.id;
    let stopReason: GenerationStopReason = 'completed';
    let stoppedAtBatchKey: string | null = null;

    // FROM HERE THE RUN ROW EXISTS, SO EVERY EXIT SETTLES IT.
    try {
        const savedCursor = claim.run.cursor;
        let startIndex = 0;

        if (claim.resumed && savedCursor !== null && typeof savedCursor === 'object') {
            const cursor = savedCursor as Partial<GenerationCursor>;
            if (cursor.fingerprint === plan.fingerprint && typeof cursor.nextBatchIndex === 'number') {
                startIndex = Math.max(0, Math.min(cursor.nextBatchIndex, plan.batches.length));
            } else {
                // The work list changed between runs, so the saved index names a
                // different batch than it did. Restarting is the only correct
                // reading of that, and the upserts make the repeat a no-op —
                // but the reservations are NOT undone, so a resumed run after a
                // plan change spends against what is left.
                log.warn('cursor_plan_changed', {
                    stage: STAGE,
                    runId,
                    savedFingerprint: String(cursor.fingerprint ?? '').slice(0, 16),
                    planFingerprint: plan.fingerprint.slice(0, 16),
                });
                await appendRunLog(deps.runDb, runId, {
                    event: 'cursor_plan_changed',
                    planFingerprint: plan.fingerprint,
                });
            }
        }

        // The ledger is the authority on what a resumed run has already
        // committed; the cursor's copy is a mirror an interrupted write can
        // leave stale. Both are logged, so a divergence is visible instead of
        // silent, and the run spends against the ledger's figure.
        const reservedAtStart = await deps.budget.reserved(runId);
        const mirroredReservations =
            savedCursor !== null && typeof savedCursor === 'object'
                ? ((savedCursor as Partial<GenerationCursor>).modelCallsReserved ?? 0)
                : 0;

        log.info('run_claimed', {
            stage: STAGE,
            runId,
            resumed: claim.resumed,
            startIndex,
            ofBatches: plan.batches.length,
            modelCallsReservedLedger: reservedAtStart,
            modelCallsReservedCursor: mirroredReservations,
            budgetLimit: deps.budgetLimit,
            budgetRemaining: deps.budgetLimit - reservedAtStart,
        });

        tally.counts.modelCallsReserved = reservedAtStart;

        // Resume skips a batch only where it is RECORDED COMPLETE. A 'pending'
        // batch — reserved, then interrupted before its status moved — is
        // re-executed, which is the conservative consequence of never refunding
        // a reservation: its first call may never have been answered, and the
        // upsert on source_key makes the repeat converge rather than duplicate.
        const batchRows = new Map<string, { id: string; status: string }>();
        for (const row of await deps.prisma.catalog_generation_batches.findMany({
            where: { run_id: runId },
            select: { id: true, batch_key: true, status: true },
        })) {
            batchRows.set(row.batch_key, { id: row.id, status: row.status });
        }

        const avoidNames = new Map<string, string[]>();
        const writtenSourceKeys = new Set<string>();
        let lastCheckpointBatchIndex = startIndex;

        for (let index = startIndex; index < plan.batches.length; index += 1) {
            const batch = plan.batches[index];
            const existing = batchRows.get(batch.batchKey);

            if (existing !== undefined && COMPLETED_BATCH_STATUSES.includes(existing.status)) {
                bump(tally.counts, 'skippedBatches');
                log.debug('batch_skipped', {
                    stage: STAGE,
                    batchKey: batch.batchKey,
                    status: existing.status,
                });
                continue;
            }

            if (!avoidNames.has(batch.category)) {
                avoidNames.set(batch.category, await readCategoryNames(deps.prisma, batch.category));
            }
            const names = avoidNames.get(batch.category) ?? [];

            // RESERVE BEFORE THE CALL. An exhausted budget is a clean stop, not
            // a defect: the checkpoint stays where it is and `--resume` picks up
            // from this batch once the cap is raised.
            let reservation: { reserved: number; remaining: number };
            try {
                reservation = await deps.budget.reserve({
                    runId,
                    batchKey: batch.batchKey,
                    category: batch.category,
                    model: deps.model,
                    promptVersion: coveragePlan.promptVersion,
                    budgetLimit: deps.budgetLimit,
                    logger: log,
                });
            } catch (error) {
                if (error instanceof ModelBudgetError && error.code === 'budget_exhausted') {
                    stopReason = 'budget_exhausted';
                    stoppedAtBatchKey = batch.batchKey;
                    log.warn('budget_exhausted', {
                        stage: STAGE,
                        runId,
                        batchKey: batch.batchKey,
                        budgetEnvVar: MODEL_CALL_BUDGET_ENV,
                        budgetLimit: deps.budgetLimit,
                        reserved: error.reserved,
                    });
                    await appendRunLog(deps.runDb, runId, {
                        event: 'budget_exhausted',
                        batchKey: batch.batchKey,
                        budgetLimit: deps.budgetLimit,
                    });
                    break;
                }
                throw asGenerationFailure(error, 'budget_misconfigured', {
                    batchKey: batch.batchKey,
                    category: batch.category,
                });
            }

            tally.counts.modelCallsReserved = reservation.reserved;

            const batchRow =
                batchRows.get(batch.batchKey) ??
                (
                    await deps.prisma.catalog_generation_batches.findMany({
                        where: { run_id: runId, batch_key: batch.batchKey },
                        select: { id: true, batch_key: true, status: true },
                    })
                ).map((row) => ({ id: row.id, status: row.status }))[0];

            if (batchRow === undefined) {
                // reserveModelCall creates the row it reserves against, so its
                // absence means the ledger and this loop disagree about the run.
                throw new CatalogGenerationError(
                    'batch_ledger_mismatch',
                    'the batch row reserved for this call could not be read back',
                    { batchKey: batch.batchKey, category: batch.category },
                );
            }
            batchRows.set(batch.batchKey, batchRow);

            const schema = buildGenerationSchema(batch.foodGroups, costClasses);
            const userContent = buildGenerationUserContent(batch, names);

            let payload: unknown;
            try {
                payload = await deps.openRouter.call(GENERATION_SYSTEM_PROMPT, userContent, schema, deps.model);
            } catch (error) {
                // THE RESERVATION IS NOT REFUNDED, AND THE USAGE IS RECORDED
                // ANYWAY. The vendor was called, so the tokens were spent
                // whatever it answered; a refund here would turn every failure
                // into a free retry, which is exactly the defect §9's ordering
                // exists to prevent (see src/services/entitlement.service.ts).
                await recordSpend(deps, tally, runId, batch, false);
                bump(tally.counts, 'failedBatches');
                await markBatchFailed(deps, runId, batch);
                throw asGenerationFailure(error, 'model_call_failed', {
                    batchKey: batch.batchKey,
                    category: batch.category,
                });
            }

            await recordSpend(deps, tally, runId, batch, true);

            let parsed: { foods: GeneratedFood[]; refused: RefusedCandidate[] };
            try {
                parsed = parseGeneratedFoods(payload, batch, costClasses);
            } catch (error) {
                // A payload that is not a batch of foods at all is a failure of
                // THIS BATCH, not of the run: the other 156 batches are
                // unaffected and the batch stays incomplete, so a later
                // `--resume` retries it. The call it cost is already recorded.
                const failure = asGenerationFailure(error, 'model_response_unusable', {
                    batchKey: batch.batchKey,
                    category: batch.category,
                });
                log.error('batch_response_unusable', {
                    stage: STAGE,
                    runId,
                    batchKey: batch.batchKey,
                    code: failure.code,
                    error: safeError(failure),
                });
                bump(tally.counts, 'failedBatches');
                await markBatchFailed(deps, runId, batch);
                await saveGenerationCursor(deps, runId, plan, tally, index + 1);
                lastCheckpointBatchIndex = index + 1;
                continue;
            }

            bump(tally.counts, 'candidatesProposed', parsed.foods.length + parsed.refused.length);
            bump(tally.counts, 'candidatesRefused', parsed.refused.length);
            for (const refusal of parsed.refused) {
                if (tally.refused.length < REFUSAL_LIST_LIMIT) {
                    tally.refused.push(refusal);
                }
                bump(tally.failuresByCheck, refusal.reason);
                tally.tierByCheckName[refusal.reason] =
                    tally.tierByCheckName[refusal.reason] ??
                    (isCatalogCheckName(refusal.reason) ? catalogCheckTier(refusal.reason) : 'payload_shape');
            }

            const accepted = await writeBatchCandidates(
                deps,
                tally,
                policy,
                batch,
                parsed.foods,
                batchRow.id,
                writtenSourceKeys,
                names,
            );

            await deps.prisma.catalog_generation_batches.updateMany({
                where: { run_id: runId, batch_key: batch.batchKey },
                data: {
                    status: BATCH_STATUS_GENERATED,
                    candidate_count: parsed.foods.length + parsed.refused.length,
                    accepted_count: accepted,
                },
            });
            batchRows.set(batch.batchKey, { id: batchRow.id, status: BATCH_STATUS_GENERATED });
            bump(tally.counts, 'executedBatches');

            const done = index + 1;
            if (done % CURSOR_SAVE_EVERY_BATCHES === 0 || done === plan.batches.length) {
                await saveGenerationCursor(deps, runId, plan, tally, done);
                await recordCounts(deps.runDb, runId, {
                    batchesProcessed: done - lastCheckpointBatchIndex,
                });
                lastCheckpointBatchIndex = done;
                log.info('batch_progress', {
                    stage: STAGE,
                    batchKey: batch.batchKey,
                    batch: done,
                    ofBatches: plan.batches.length,
                    accepted,
                    quarantined: tally.counts.quarantined,
                    refused: tally.counts.candidatesRefused,
                    budgetRemaining: deps.budgetLimit - tally.counts.modelCallsReserved,
                });
            }
        }

        const publishedByCategory = await readPublishedByCategory(deps.prisma);
        deps.writeReport(
            buildGenerationReport(deps, plan, tally, publishedByCategory, {
                runId,
                resumed: claim.resumed,
                stopReason,
                stoppedAtBatchKey,
            }),
        );

        // AN EXHAUSTED BUDGET LEAVES THE RUN OPEN, DELIBERATELY. finishRun
        // takes 'succeeded' or 'failed', and neither is true here: the work is
        // unfinished but nothing is broken. Leaving the row 'running' with its
        // cursor intact is what lets `--resume` continue it once the cap is
        // raised, and the report and the run log both say why it stopped.
        if (stopReason === 'budget_exhausted') {
            log.warn('run_paused', {
                stage: STAGE,
                runId,
                reason: stopReason,
                stoppedAtBatchKey,
                executedBatches: tally.counts.executedBatches,
                remainingBatches: plan.batches.length - tally.counts.executedBatches - tally.counts.skippedBatches,
            });
        } else {
            await finishRun(deps.runDb, runId, 'succeeded', { counts: tally.counts, logger: log });
        }

        return {
            runId,
            resumed: claim.resumed,
            stopReason,
            plannedBatches: plan.batches.length,
            executedBatches: tally.counts.executedBatches,
            skippedBatches: tally.counts.skippedBatches,
            counts: tally.counts,
            shortfallTotal: computeCoverageShortfall(policy, publishedByCategory).shortfallTotal,
            modelCallsReserved: tally.counts.modelCallsReserved,
            modelCallsUsed: tally.counts.modelCallsUsed,
        };
    } catch (error) {
        await closeFailedRun(deps, runId, tally.counts, error);
        // Rethrown, always: main() maps it to a code and a non-zero exit, and
        // swallowing it here would report a failed run as a successful one
        // (Rule backend-architecture §8).
        throw error;
    }
};

/**
 * Records the call that was just made — succeeded or not — and keeps the tally
 * in step with the ledger.
 *
 * A failure to WRITE the usage record on the failure path is reported beside the
 * vendor failure rather than instead of it: the vendor failure is what the
 * operator has to act on, and masking it with a bookkeeping error would hide
 * the cause. On the success path it propagates, because an unrecorded call on a
 * run that is still spending would understate the ledger for every batch after
 * it.
 */
const recordSpend = async (
    deps: GenerationDeps,
    tally: GenerationTally,
    runId: string,
    batch: GenerationBatch,
    succeeded: boolean,
): Promise<void> => {
    const spend: BatchSpend = {
        batchKey: batch.batchKey,
        category: batch.category,
        reserved: 1,
        used: 1,
        succeeded,
    };

    try {
        // `tokensUsed` is deliberately omitted: callOpenRouter returns the
        // parsed document and surfaces no usage block, so a number here would
        // be invented. budget.ts normalises the absence to 0.
        await deps.budget.record({ runId, batchKey: batch.batchKey, succeeded, logger: deps.logger });
    } catch (error) {
        if (succeeded) {
            throw asGenerationFailure(error, 'batch_ledger_mismatch', {
                batchKey: batch.batchKey,
                category: batch.category,
            });
        }
        deps.logger.error('model_usage_unrecorded', {
            stage: STAGE,
            runId,
            batchKey: batch.batchKey,
            error: safeError(error),
        });
    }

    bump(tally.counts, 'modelCallsUsed');
    tally.spend.push(spend);
};

/** Marks a batch failed so a later `--resume` retries it rather than skipping it. */
const markBatchFailed = async (
    deps: GenerationDeps,
    runId: string,
    batch: GenerationBatch,
): Promise<void> => {
    try {
        await deps.prisma.catalog_generation_batches.updateMany({
            where: { run_id: runId, batch_key: batch.batchKey },
            data: { status: BATCH_STATUS_FAILED },
        });
    } catch (error) {
        deps.logger.error('batch_status_unrecorded', {
            stage: STAGE,
            runId,
            batchKey: batch.batchKey,
            error: safeError(error),
        });
    }
};

/** Saves the checkpoint, mirroring the reservation total an operator reads. */
const saveGenerationCursor = async (
    deps: GenerationDeps,
    runId: string,
    plan: GenerationPlan,
    tally: GenerationTally,
    nextBatchIndex: number,
): Promise<void> => {
    await saveCursor<GenerationCursor>(deps.runDb, runId, {
        fingerprint: plan.fingerprint,
        nextBatchIndex,
        modelCallsReserved: tally.counts.modelCallsReserved,
    });
};

/**
 * Corroborates, dedupes, judges and writes one batch's foods, returning how
 * many were written as candidates.
 *
 * ONE TRANSACTION PER FOOD, not one per batch. A single unusable food then
 * costs only itself: the twenty-four beside it stay written, the batch is not
 * marked complete, and a `--resume` re-runs it with upserts that converge on
 * the same rows. A batch-wide transaction would also have to hold open across
 * the evidence fetches, which are network calls.
 */
const writeBatchCandidates = async (
    deps: GenerationDeps,
    tally: GenerationTally,
    policy: CatalogValidationPolicy,
    batch: GenerationBatch,
    foods: readonly GeneratedFood[],
    generationBatchId: string,
    writtenSourceKeys: Set<string>,
    avoidNames: string[],
): Promise<number> => {
    // Within the batch first: two proposals for one identity are folded by
    // catalog.logic.ts's own rule, which is order-independent and prefers a
    // sourced identity, so the survivor is the same whichever order the model
    // listed them in.
    const identities: CatalogIdentityCandidate[] = foods.map((food) => ({
        source_key: buildSourceKey({
            identitySource: 'ai_generated',
            category: batch.category,
            canonicalName: food.canonicalName,
            foodState: food.foodState,
        }),
        canonical_name: food.canonicalName,
        food_state: food.foodState,
        identity_source: 'ai_generated',
        display_name: food.displayName,
        aliases: food.aliases,
    }));

    const dedupe = dedupeIdentity(identities);

    const survivors = new Set(dedupe.survivors.map((survivor) => survivor.source_key));
    if (dedupe.duplicateSourceKeys.length > 0) {
        bump(tally.counts, 'duplicatesRemoved', dedupe.duplicateSourceKeys.length);
        for (const key of dedupe.duplicateSourceKeys) {
            if (tally.duplicateSourceKeys.length < REFUSAL_LIST_LIMIT) {
                tally.duplicateSourceKeys.push(key);
            }
        }
    }

    let accepted = 0;

    for (const food of foods) {
        const sourceKey = buildSourceKey({
            identitySource: 'ai_generated',
            category: batch.category,
            canonicalName: food.canonicalName,
            foodState: food.foodState,
        });

        if (!survivors.has(sourceKey)) {
            continue;
        }

        // Already written by an earlier batch of this run: the upsert would
        // converge, but the second write would replace the first food's aliases
        // and portions with this proposal's, and a run must not overwrite its
        // own accepted work with a later guess at the same identity.
        if (writtenSourceKeys.has(sourceKey)) {
            bump(tally.counts, 'duplicatesRemoved');
            if (tally.duplicateSourceKeys.length < REFUSAL_LIST_LIMIT) {
                tally.duplicateSourceKeys.push(sourceKey);
            }
            continue;
        }

        const evidence = await collectIdentityEvidence(deps, food, batch);
        for (const reason of evidence.refusals) {
            bump(tally.evidenceRefusals, reason);
        }
        bump(tally.counts, evidence.identityStatus === 'verified' ? 'evidenceVerified' : 'evidenceUnsourced');

        const prepared = prepareGeneratedFood(food, batch, deps.coveragePlan, evidence);
        const duplicateOfSourceKey = await findAliasOwner(deps.prisma, prepared);
        if (duplicateOfSourceKey !== null) {
            bump(tally.counts, 'duplicatesRemoved');
            if (tally.duplicateSourceKeys.length < REFUSAL_LIST_LIMIT) {
                tally.duplicateSourceKeys.push(prepared.sourceKey);
            }
        }

        const verdict = validateCatalogCandidate(prepared.candidate, policy, { duplicateOfSourceKey });
        const publicationStatus = generationPublicationStatus(verdict);

        const failedChecks: string[] = [];
        for (const check of verdict.checks) {
            tally.tierByCheckName[check.name] = check.tier;
            if (!check.pass) {
                bump(tally.failuresByCheck, check.name);
                failedChecks.push(check.name);
            }
        }

        let outcome: 'inserted' | 'updated';
        try {
            outcome = await deps.prisma.$transaction(
                (tx) =>
                    persistGeneratedFood(
                        tx,
                        prepared,
                        verdict,
                        publicationStatus,
                        generationBatchId,
                        deps.now(),
                        {
                            coveragePlanVersion: deps.coveragePlan.coveragePlanVersion,
                            promptVersion: deps.coveragePlan.promptVersion,
                            model: deps.model,
                            batchKey: batch.batchKey,
                        },
                    ),
                { timeout: TRANSACTION_TIMEOUT_MS },
            );
        } catch (error) {
            throw asGenerationFailure(error, 'persist_failed', {
                batchKey: batch.batchKey,
                category: batch.category,
                detail: prepared.sourceKey,
            });
        }

        writtenSourceKeys.add(sourceKey);
        if (avoidNames.length < MAX_AVOID_NAMES) {
            avoidNames.push(prepared.candidate.canonical_name);
        }

        bump(tally.counts, outcome);
        bump(tally.counts, publicationStatusCountKey(publicationStatus));

        const categoryCounts = categoryOutcome(tally.byCategoryOutcome, batch.category);
        categoryCounts.written += 1;
        if (publicationStatus === 'quarantined') {
            categoryCounts.quarantined += 1;
        } else if (publicationStatus === 'rejected') {
            categoryCounts.rejected += 1;
        } else {
            categoryCounts.candidates += 1;
        }

        // WHAT `accepted_count` COUNTS, AND WHY IT IS NOT THE 'candidate' ROWS.
        // Every generated food carries `allergen_status: 'unknown'` (see
        // prepareGeneratedFood), which fails the review-tier
        // `allergens_unknown` check, and an unlifted review flag holds an
        // AI-generated candidate quarantined — so a count of `candidate` rows
        // would be zero for every batch of every run by construction, and would
        // read as total failure rather than as "awaiting the advisory review".
        // Accepted here therefore means WRITTEN INTO THE CATALOG FOR REVIEW:
        // candidate or quarantined, never rejected. `candidate_count −
        // accepted_count` is then what the batch lost outright, which is the
        // question an operator actually asks of a batch row.
        if (publicationStatus !== 'rejected') {
            accepted += 1;
        }

        // Listed individually, capped: the list is a worklist an operator acts
        // on rather than a metric, and the per-check and per-category totals
        // above stay complete however long the run is.
        if (publicationStatus !== 'candidate' && tally.quarantined.length < REFUSAL_LIST_LIMIT) {
            tally.quarantined.push({
                sourceKey: prepared.sourceKey,
                category: batch.category,
                foodState: prepared.candidate.food_state,
                publicationStatus,
                identityStatus: prepared.candidate.identity_status ?? 'unsourced',
                failedChecks,
            });
        }
    }

    return accepted;
};

// ---------------------------------------------------------------------------
// The entry point.
// ---------------------------------------------------------------------------

// One field per gap, keyed by the gap's stable code, so a refusal is greppable
// by code and readable one prerequisite per line.
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

/**
 * Every error class this file can observe, mapped to its own reported code, so
 * an operator never reads a stack trace to learn which layer refused.
 *
 * `OpenRouterError` is absent deliberately: it is wrapped into a
 * `CatalogGenerationError` at the call site (§9), so a vendor error shape never
 * reaches this edge and no caller has to recognise one.
 */
export const describeFailure = (error: unknown): { code: string; error: ReturnType<typeof safeError> } => {
    if (error instanceof CatalogGenerationError) {
        return { code: error.code, error: safeError(error) };
    }
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
        batchSize: parsed.options.batchSize,
        maxBatches: parsed.options.maxBatches,
        resume: parsed.options.resume,
        dryRun: parsed.options.dryRun,
    });

    const gaps = preflight(defaultPreflightDeps(parsed.options.batchSize), logger);
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    // Every input is present, so the stage runs. The Prisma client is reached
    // HERE rather than at module load — it instantiates a client on import —
    // so the suites that read parseArgs, preflight, the prompt builders and the
    // pure derivations above reach them without a database.
    const { prisma } = await import('../src/prisma/client');

    const coveragePlan = loadCoveragePlan();
    const allowlist: EvidenceAllowlist = loadEvidenceAllowlist();

    // Resolved ONCE, before the first batch (§9: config behind a loud accessor,
    // read once). Nothing inside the batch loop reads process.env.
    const model = getGenerationModel();
    const batchSize = parsed.options.batchSize ?? getCatalogBatchSize(process.env);
    const budgetLimit = getCatalogModelCallBudget(process.env);

    // The key is resolved before any batch too, so a missing key is a refusal
    // at launch rather than a failure after the plan has been built. The value
    // is never logged and never leaves this call.
    getOpenRouterConfig();

    const deps: GenerationDeps = {
        // `as unknown as` for the same reason the import stage does it: the
        // seam is declared structurally so a fake satisfies it, and the
        // generated client's argument types are narrower than `unknown`.
        prisma: prisma as unknown as GenerationDb,
        runDb: prisma as unknown as CatalogRunDb,
        openRouter: {
            // The caller-facing signature is fixed here and the vendor call is
            // reached only through it: no raw request to the vendor's host
            // appears in this file (§9).
            call: (systemPrompt, userContent, jsonSchema, modelOverride) =>
                callOpenRouter(systemPrompt, userContent, jsonSchema, modelOverride, undefined, GENERATION_TIMEOUT_MS),
        },
        fetchEvidence,
        now: () => new Date(),
        budget: {
            reserve: (input) => reserveModelCall(prisma as unknown as CatalogRunDb, input),
            record: (input) => recordModelCallUsage(prisma as unknown as CatalogRunDb, input),
            reserved: (runId) => getReservedModelCalls(prisma as unknown as CatalogRunDb, runId),
        },
        coveragePlan,
        // THE ONE BRIDGE CAST IN THIS FILE, AND WHY IT IS SAFE.
        // manifest.ts's `EvidenceAllowlist` describes the document's shape for
        // its own loader and omits three members `evidence.logic.ts`'s
        // `EvidencePolicy` requires (registryRowCount, supplementalRowCount,
        // supplementalCidrs) — all three ARE in the committed JSON. Rather than
        // trust either type, `fetchEvidence` revalidates the whole document
        // from `unknown` on every call through `validateEvidencePolicy`, which
        // checks the version, the snapshot date, the row count and the split
        // and refuses the fetch if any of them is wrong. The cast hands over
        // the document; the policy check is what accepts it.
        evidencePolicy: allowlist as unknown as EvidencePolicyDocument,
        options: parsed.options,
        logger,
        model,
        batchSize,
        budgetLimit,
        writeReport: (report) => {
            writeGenerationReport(reportPath('import-report.json'), report, logger);
        },
    };

    // THE GENERATION STAGE'S CLAIM, AND THE ONE INVOCATION THAT DOES NOT TAKE IT.
    //
    // A real generation run MUTATES the catalog graph — it upserts foods and
    // replaces their aliases, portions and validation records by source_key —
    // so it holds the catalog-graph lock EXCLUSIVELY for as long as it runs, and
    // no import, no second generation, no validation pass and no release load
    // can hold it at the same time (lib/checkpoint.ts's THE STAGE LOCK). The run
    // claim cannot give this: its advisory lock is transaction-scoped and
    // released the moment the claim commits, so it guarantees one run ROW rather
    // than one writer.
    //
    // A DRY RUN TAKES NO LOCK. It writes nothing, and an operator must be able
    // to ask what a run would cost while one is in progress.
    const outcome = parsed.options.dryRun
        ? await runGeneration(deps)
        : await withCatalogStageLock({ stage: RUN_KIND, logger }, () => runGeneration(deps));

    logger.info('stage_completed', {
        stage: STAGE,
        runId: outcome.runId,
        resumed: outcome.resumed,
        stopReason: outcome.stopReason,
        plannedBatches: outcome.plannedBatches,
        executedBatches: outcome.executedBatches,
        skippedBatches: outcome.skippedBatches,
        modelCallsReserved: outcome.modelCallsReserved,
        modelCallsUsed: outcome.modelCallsUsed,
        shortfallTotal: outcome.shortfallTotal,
        counts: JSON.stringify(outcome.counts),
    });

    await prisma.$disconnect();

    // A PAUSED RUN IS NOT A SUCCESS. An exhausted budget stopped the run with
    // work outstanding, so the exit code says so — an unattended caller must
    // not read "the catalog is generated" from a run that spent its cap on
    // batch 90 of 157. The checkpoint is intact and `--resume` continues it.
    return outcome.stopReason === 'budget_exhausted' ? 1 : 0;
};

// Guarded so importing this module — which is how
// src/__tests__/scripts/catalog-generate.test.ts reaches runGeneration,
// parseArgs, preflight and the pure derivations — never starts a run.
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

