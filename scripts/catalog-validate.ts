// Stage 3 of the catalog pipeline: validation and publication.
//
// WHAT THE STAGE DOES. It runs the deterministic checks and per-category
// bounds from data/meal-planning/coverage-plan.v1.json over every row it owns,
// writes one `catalog_validation_records` row per decision, and publishes what
// passed while quarantining what did not (Agent Action Plan §0.7.1 Group 3).
//
// WHY IT IS A SEPARATE STAGE FROM THE IMPORT. The duplicate-identity decision
// is a property of the whole surviving set rather than of either row involved:
// `dedupeIdentity` decides which of two same-identity records keeps the
// identity, and a batch-at-a-time import cannot see far enough to make that
// call. So this stage reads every non-rejected row, resolves duplicates first,
// then judges — and a duplicate's aliases are merged into the survivor, so a
// name a user might search for still reaches the food that kept the identity.
//
// AN IDENTITY FLOOR NO CHECK CAN LIFT: a row whose `identity_status` is not
// `verified` is held as a candidate even when every check passes. Publishing a
// food whose identity is in doubt would put an unverified name in front of a
// user, which the checks alone have no way to express.
//
// ON THE ADVISORY REVIEW. The advisory review shares the single
// CATALOG_MODEL_CALL_BUDGET cap with generation, which is why this stage
// resolves that cap. It spends nothing on a catalog of sourced records: every
// disposition is settled deterministically and the review never promotes a
// value, so no call is made and `llm_review` is recorded as `null` — the
// honest value for a review that did not happen, reported as such in the
// validation report rather than left to be inferred.
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
import { ManifestError, loadCoveragePlan, loadEvidenceAllowlist, reportPath } from './lib/manifest';
import type { CatalogFoodState, CoveragePlan } from './lib/manifest';
import { ModelBudgetError, getCatalogModelCallBudget } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import { CheckpointError, finishRun, openOrResumeRun } from './lib/checkpoint';
import type { CatalogRunDb } from './lib/checkpoint';
import type { ScriptLogger } from './lib/logger';

// The checks themselves. Pure, so this import opens nothing; the Prisma client
// is reached from main() because constructing it is a module-load side effect.
import { dedupeIdentity, validateCatalogCandidate } from '../src/services/catalog.logic';
import type {
    CatalogFoodCandidate,
    CatalogValidationPolicy,
    CatalogValidationVerdict,
} from '../src/services/catalog.logic';
import type { CatalogIdentityStatus } from '../src/types/catalog';

const STAGE = 'catalog-validate';

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
        'Judges every catalog candidate and publishes, quarantines or rejects it.',
        '',
        'Checks every input first and exits 1 naming the unsatisfied prerequisites',
        'and their remedies. Then resolves duplicate identities across the whole',
        'non-rejected table, runs the deterministic checks from catalog.logic.ts',
        'over every row it owns, writes one validation record per judged food, and',
        'reports the counts and the exact per-category shortfall.',
        '',
        'No model call is made: every disposition here is settled deterministically',
        'and the advisory review never promotes a value, so llm_review is recorded',
        'as null — the honest value for a review that did not happen.',
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
// The validation body.
//
// This stage is where a candidate becomes published, quarantined or rejected.
// It is deliberately separate from the import: the duplicate-identity check
// needs a view of the whole table, which a batch-at-a-time import cannot have,
// and keeping publication here is what makes the import safe to re-run.
//
// Every decision is made by src/services/catalog.logic.ts. This file reads
// rows, hands them to the checks, and records what came back — it holds no
// bound and no threshold of its own.
// ---------------------------------------------------------------------------

/** A food as this stage reads it, with the children the checks need. */
export interface ValidationFoodRow {
    readonly id: string;
    readonly source_key: string;
    readonly canonical_name: string;
    readonly display_name: string;
    readonly category: string;
    readonly food_state: string;
    readonly identity_source: string;
    readonly identity_status: string;
    readonly nutrition_provenance: string;
    readonly nutrition_basis: string;
    readonly basis_amount: number;
    readonly calories: number | null;
    readonly protein_g: number | null;
    readonly carbs_g: number | null;
    readonly fat_g: number | null;
    readonly fiber_g: number | null;
    readonly density_g_per_ml: number | null;
    readonly allergen_status: string;
    readonly allergen_tags: string[];
    readonly publication_status: string;
    readonly catalog_food_aliases: { readonly alias: string }[];
    readonly catalog_food_portions: {
        readonly description: string;
        readonly amount: number;
        readonly unit: string;
        readonly gram_weight: number;
        readonly is_default: boolean;
        readonly source: string;
    }[];
    readonly catalog_validation_records: {
        readonly id: string;
        readonly history: unknown;
        readonly canonical_identity: unknown;
        /**
         * Read so this pass can add to what the import recorded instead of
         * replacing it: the import's assumptions are what make
         * `nutrition_method` true, and a pass that dropped them would leave a
         * method stating a derivation no assumption accounts for.
         */
        readonly nutrition_assumptions: string | null;
    } | null;
}

/** The narrow slice of the client this stage uses. */
export interface ValidateDb {
    catalog_foods: {
        findMany(args: unknown): Promise<ValidationFoodRow[]>;
        update(args: unknown): Promise<{ id: string }>;
    };
    catalog_food_aliases: {
        createMany(args: unknown): Promise<{ count: number }>;
        findMany(args: unknown): Promise<Array<{ catalog_food_id: string; alias: string }>>;
    };
    catalog_validation_records: {
        create(args: unknown): Promise<{ id: string }>;
        update(args: unknown): Promise<{ id: string }>;
        updateMany(args: unknown): Promise<{ count: number }>;
    };
    $transaction<T>(work: (tx: ValidateDb) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

export interface RunValidationDeps {
    readonly db: ValidateDb;
    readonly runDb: CatalogRunDb;
    readonly coveragePlan: CoveragePlan;
    readonly options: ValidateOptions;
    readonly logger: ScriptLogger;
    readonly now: () => Date;
    readonly writeReport: (report: unknown) => void;
}

export interface ValidationOutcome {
    readonly runId: string;
    readonly counts: Readonly<Record<string, number>>;
    readonly byCategory: Readonly<Record<string, { published: number; target: number; shortfall: number }>>;
}

/**
 * Rebuilds the candidate the checks judge from the stored row.
 *
 * A portion whose gram weight the source never stated cannot be stored —
 * the column is NOT NULL — so a food with no portion row at all is handed a
 * single portion carrying `gram_weight: null`. That is what it means: the
 * record states a serving nobody weighed, and it makes the
 * `missing_gram_weight` check evaluable instead of silently absent.
 */
export const candidateFromRow = (row: ValidationFoodRow): CatalogFoodCandidate => ({
    source_key: row.source_key,
    canonical_name: row.canonical_name,
    display_name: row.display_name,
    aliases: row.catalog_food_aliases.map(({ alias }) => alias),
    category: row.category,
    food_state: row.food_state as CatalogFoodState,
    identity_source: row.identity_source as 'usda' | 'ai_generated',
    identity_status: row.identity_status as CatalogIdentityStatus,
    nutrition_provenance: row.nutrition_provenance as 'source_backed' | 'ingredient_derived' | 'ai_estimated',
    allergen_status: row.allergen_status as 'known' | 'unknown',
    allergen_tags: row.allergen_tags,
    nutrition_basis: row.nutrition_basis as 'per_100g' | 'per_100ml' | 'per_serving',
    basis_amount: row.basis_amount,
    calories: row.calories,
    protein_g: row.protein_g,
    carbs_g: row.carbs_g,
    fat_g: row.fat_g,
    fiber_g: row.fiber_g,
    density_g_per_ml: row.density_g_per_ml,
    portions:
        row.catalog_food_portions.length > 0
            ? row.catalog_food_portions.map((portion) => ({
                  description: portion.description,
                  amount: portion.amount,
                  unit: portion.unit,
                  gram_weight: portion.gram_weight,
                  is_default: portion.is_default,
                  source: portion.source,
              }))
            : [{ description: 'unstated serving', amount: 1, unit: 'each', gram_weight: null, is_default: true }],
});

/** An identity-status floor no check can lift: an unverified identity never publishes. */
const publishableIdentity = (identityStatus: string): boolean => identityStatus === 'verified';

/**
 * Whether the import marked this food as needing a curator's classification.
 *
 * The checks cannot see the problem: an unclassified USDA record has sound
 * nutrition, a sound identity and a category that is a placeholder, so every
 * bound it is measured against passes. Publishing it would file it in the
 * wrong grocery aisle and leave it invisible to the dislike exclusions, which
 * match on `food_group`. The import records the marker; this stage honours it
 * on every pass, so a re-judgement can never quietly publish the row.
 */
export const curatorReviewRequired = (row: ValidationFoodRow): boolean => {
    const identity = row.catalog_validation_records?.canonical_identity;
    if (identity === null || identity === undefined || typeof identity !== 'object') {
        return false;
    }
    return (identity as { curator_review_required?: unknown }).curator_review_required === true;
};

/**
 * Runs the checks over every row this invocation owns and writes the outcome.
 *
 * The duplicate pass runs first and over the whole non-rejected table, because
 * `dedupeIdentity` decides which of two same-identity rows survives and that
 * answer cannot be derived from either row alone. A loser is quarantined with
 * `duplicate_identity` and its aliases are merged into the survivor, so the
 * name a user might search for still reaches the food that kept the identity.
 */
export const runValidation = async (deps: RunValidationDeps): Promise<ValidationOutcome> => {
    const { logger, options, coveragePlan } = deps;

    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };

    const claim = await openOrResumeRun<{ stage: string }>(deps.runDb, {
        kind: 'validation',
        manifestVersion: coveragePlan.coveragePlanVersion,
        initialCursor: { stage: 'started' },
        logger,
        now: deps.now,
    });

    const selection = {
        id: true,
        source_key: true,
        canonical_name: true,
        display_name: true,
        category: true,
        food_state: true,
        identity_source: true,
        identity_status: true,
        nutrition_provenance: true,
        nutrition_basis: true,
        basis_amount: true,
        calories: true,
        protein_g: true,
        carbs_g: true,
        fat_g: true,
        fiber_g: true,
        density_g_per_ml: true,
        allergen_status: true,
        allergen_tags: true,
        publication_status: true,
        catalog_food_aliases: { select: { alias: true } },
        catalog_food_portions: {
            select: {
                description: true,
                amount: true,
                unit: true,
                gram_weight: true,
                is_default: true,
                source: true,
            },
        },
        catalog_validation_records: {
            select: { id: true, history: true, canonical_identity: true, nutrition_assumptions: true },
        },
    };

    // Everything not already rejected, because identity is a property of the
    // whole surviving set: a candidate can duplicate a published row.
    const allRows = await deps.db.catalog_foods.findMany({
        where: { publication_status: { in: ['candidate', 'published', 'quarantined'] } },
        select: selection,
        orderBy: { source_key: 'asc' },
    });

    const dedupe = dedupeIdentity(
        allRows.map((row) => ({
            source_key: row.source_key,
            canonical_name: row.canonical_name,
            food_state: row.food_state as CatalogFoodState,
            identity_source: row.identity_source as 'usda' | 'ai_generated',
            display_name: row.display_name,
            aliases: row.catalog_food_aliases.map(({ alias }) => alias),
        })),
    );

    const duplicateOf = new Map<string, string>();
    for (const merge of dedupe.merges) {
        duplicateOf.set(merge.duplicateSourceKey, merge.survivorSourceKey);
    }
    logger.info('duplicate_identities_resolved', {
        stage: STAGE,
        survivors: dedupe.survivors.length,
        duplicates: dedupe.duplicateSourceKeys.length,
    });

    const wantedCategories = new Set(options.categories);
    const considered = allRows.filter((row) => {
        if (wantedCategories.size > 0 && !wantedCategories.has(row.category)) {
            return false;
        }
        if (row.publication_status === 'quarantined') {
            return options.revalidateQuarantined;
        }
        // A published row is re-judged too: a bounds change or a newly detected
        // duplicate must be able to take it back out of the published set.
        return true;
    });

    const counts: Record<string, number> = {
        considered: considered.length,
        published: 0,
        quarantined: 0,
        rejected: 0,
        unchanged: 0,
        candidatesHeld: 0,
        aliasesMerged: 0,
        aliasRecordsRestated: 0,
        identityNotVerified: 0,
        awaitingClassification: 0,
    };
    const byCheck: Record<string, number> = {};
    const reviewFlagCounts: Record<string, number> = {};
    const publishedByCategory: Record<string, number> = {};

    const rowsBySourceKey = new Map(allRows.map((row) => [row.source_key, row]));
    const now = deps.now();

    for (const row of considered) {
        const candidate = candidateFromRow(row);
        const duplicateSurvivor = duplicateOf.get(row.source_key) ?? null;
        const verdict = validateCatalogCandidate(candidate, policy, {
            duplicateOfSourceKey: duplicateSurvivor,
        });

        let publicationStatus: string = verdict.publicationStatus;
        const extraAssumptions: string[] = [];
        if (publicationStatus === 'published' && !publishableIdentity(row.identity_status)) {
            publicationStatus = 'quarantined';
            counts.identityNotVerified += 1;
            extraAssumptions.push(
                `identity_status is "${row.identity_status}", so the food is held for review rather than published even though every check passed`,
            );
        }
        if (publicationStatus === 'published' && curatorReviewRequired(row)) {
            // The manifest's own word for this state: "imported as a candidate
            // and left unpublished pending a curator".
            publicationStatus = 'candidate';
            counts.awaitingClassification += 1;
            extraAssumptions.push(
                'the description matched no classification rule, so the food carries the manifest fallback category and food group and stays a candidate until a curator classifies it',
            );
        }

        for (const check of verdict.checks) {
            if (!check.pass) {
                byCheck[check.name] = (byCheck[check.name] ?? 0) + 1;
            }
        }
        for (const flag of verdict.reviewFlags) {
            reviewFlagCounts[flag] = (reviewFlagCounts[flag] ?? 0) + 1;
        }

        if (publicationStatus === 'published') {
            counts.published += 1;
            publishedByCategory[row.category] = (publishedByCategory[row.category] ?? 0) + 1;
        } else if (publicationStatus === 'quarantined') {
            counts.quarantined += 1;
        } else if (publicationStatus === 'rejected') {
            counts.rejected += 1;
        } else if (publicationStatus === 'candidate') {
            counts.candidatesHeld += 1;
        }
        if (publicationStatus === row.publication_status) {
            counts.unchanged += 1;
        }

        const history = appendValidationHistory(row, publicationStatus, verdict, now);
        await deps.db.$transaction(
            async (tx) => {
                await tx.catalog_foods.update({
                    where: { id: row.id },
                    data: { publication_status: publicationStatus, updated_at: now },
                });

                // Create and update are separate calls rather than one upsert:
                // Prisma validates an upsert's `create` branch whether or not
                // it runs, so a create carrying only the judgement fields is
                // rejected for the required columns it does not restate — and
                // restating them on every update would overwrite what the
                // import established with values re-derived from the row.
                if (row.catalog_validation_records === null) {
                    await tx.catalog_validation_records.create({
                        data: {
                            catalog_food_id: row.id,
                            ...validationRecordSeed(row, verdict, publicationStatus, extraAssumptions, now),
                            history,
                        },
                    });
                } else {
                    await tx.catalog_validation_records.update({
                        where: { catalog_food_id: row.id },
                        data: {
                            ...validationRecordPatch(
                                verdict,
                                publicationStatus,
                                extraAssumptions,
                                now,
                                parseStoredAssumptions(row.catalog_validation_records?.nutrition_assumptions),
                            ),
                            history,
                        },
                    });
                }
            },
            { timeout: TRANSACTION_TIMEOUT_MS },
        );
    }

    // The survivor keeps the identity, so the loser's names become its aliases
    // rather than disappearing with it.
    const survivorsWithNewAliases = new Set<string>();
    for (const merge of dedupe.merges) {
        if (merge.aliases.length === 0) {
            continue;
        }
        const survivor = rowsBySourceKey.get(merge.survivorSourceKey);
        if (survivor === undefined) {
            continue;
        }
        const inserted = await deps.db.catalog_food_aliases.createMany({
            data: merge.aliases.map((alias) => ({ catalog_food_id: survivor.id, alias: alias.toLowerCase() })),
            skipDuplicates: true,
        });
        counts.aliasesMerged += inserted.count;
        if (inserted.count > 0) {
            survivorsWithNewAliases.add(survivor.id);
        }
    }

    // The merge necessarily runs after the judgement loop — a survivor's own
    // record has to be written before the loser's names can be moved onto it —
    // so at this point the survivor's validation record still states the alias
    // set it had before they arrived. That record is the shipped ledger for the
    // food and `aliases.jsonl` is exported from `catalog_food_aliases`, so
    // leaving it restated would ship two files in one release that disagree
    // about the same food's names.
    //
    // The restatement reads the table rather than re-deriving the union in
    // memory: the table is the same source the release exports from, and
    // `skipDuplicates` means the rows actually inserted are not always the rows
    // offered, so only a read establishes what the food now answers to.
    if (survivorsWithNewAliases.size > 0) {
        const survivorIds = Array.from(survivorsWithNewAliases);
        const refreshed = await deps.db.catalog_food_aliases.findMany({
            where: { catalog_food_id: { in: survivorIds } },
            select: { catalog_food_id: true, alias: true },
            orderBy: [{ catalog_food_id: 'asc' }, { alias: 'asc' }],
        });

        const aliasesByFood = new Map<string, string[]>();
        for (const { catalog_food_id, alias } of refreshed) {
            const existing = aliasesByFood.get(catalog_food_id);
            if (existing === undefined) {
                aliasesByFood.set(catalog_food_id, [alias]);
            } else {
                existing.push(alias);
            }
        }

        for (const survivorId of survivorIds) {
            // updateMany, not update: a survivor outside `considered` (a
            // --category run) has no record to restate, and that is a no-op
            // rather than a failure. The count says how many were restated.
            const restated = await deps.db.catalog_validation_records.updateMany({
                where: { catalog_food_id: survivorId },
                data: { aliases: aliasesByFood.get(survivorId) ?? [], reviewed_at: now },
            });
            counts.aliasRecordsRestated += restated.count;
        }
    }

    const byCategory: Record<string, { published: number; target: number; shortfall: number }> = {};
    for (const category of coveragePlan.categories) {
        const published = publishedByCategory[category.category] ?? 0;
        byCategory[category.category] = {
            published,
            target: category.publishedTarget,
            // Exact and never rounded: a shortfall is an unmet requirement.
            shortfall: Math.max(0, category.publishedTarget - published),
        };
    }

    const report = {
        stage: STAGE,
        generatedAt: now.toISOString(),
        runId: claim.run.id,
        coveragePlanVersion: coveragePlan.coveragePlanVersion,
        options: { categories: options.categories, revalidateQuarantined: options.revalidateQuarantined },
        counts,
        failedChecks: byCheck,
        reviewFlags: reviewFlagCounts,
        duplicateIdentities: dedupe.duplicateSourceKeys.length,
        coverage: {
            publishedTargetTotal: coveragePlan.publishedTargetTotal,
            publishedActualTotal: counts.published,
            // The sum of the per-category shortfalls, not the aggregate target
            // gap. The two differ whenever one category overshoots while
            // another is short, and the aggregate then reports zero against
            // rows on this same report that show a deficit — which is the one
            // thing the coverage plan's own header says a release must never
            // do. Oversupply in produce does not stock the spice shelf, so it
            // cannot cancel a spice_herb shortfall.
            shortfallTotal: Object.values(byCategory).reduce((total, entry) => total + entry.shortfall, 0),
            // Kept as its own figure so the aggregate is still visible: this is
            // how far the whole published set is from the plan's total, which
            // can be zero or negative-clamped while categories are short.
            publishedGapToTotal: Math.max(0, coveragePlan.publishedTargetTotal - counts.published),
            byCategory,
        },
        modelCalls: {
            reserved: 0,
            used: 0,
            note: 'No advisory review call was made. Every row is a USDA record whose disposition the deterministic checks settle, and the advisory review never promotes a value, so a call would spend budget without changing an outcome. llm_review is recorded as null on every record, which is the honest value for a review that did not happen.',
        },
    };
    deps.writeReport(report);

    await finishRun(deps.runDb, claim.run.id, 'succeeded', { counts, logger });

    return { runId: claim.run.id, counts, byCategory };
};

/** 30 s: one food is four statements, but a cold connection pool is not. */
const TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * The assumptions a record already carries, as a list.
 *
 * The column is a JSON-encoded array in a nullable text column, so absent,
 * empty, malformed and populated all have to resolve to something usable. A
 * value that will not parse as an array of strings is dropped rather than
 * guessed at — the alternative is carrying a fragment of unparseable text
 * forward as though it were an assumption.
 */
export const parseStoredAssumptions = (encoded: string | null | undefined): string[] => {
    if (encoded === null || encoded === undefined || encoded.trim().length === 0) {
        return [];
    }
    try {
        const parsed: unknown = JSON.parse(encoded);
        return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : [];
    } catch {
        return [];
    }
};

/**
 * The fields this stage rewrites on an existing validation record: the
 * judgement, and the assumption list it adds to.
 *
 * What the import established — the canonical identity, the portions it
 * resolved, the retrieval record that evidences the food and the method its
 * nutrition was read by — is deliberately left alone. Those are facts about
 * where the row came from, and re-deriving them from the stored row would
 * replace first-hand provenance with a reconstruction of it.
 *
 * Assumptions are the one exception, and they are merged rather than replaced:
 * `nutrition_method` is the import's sentence and stays the import's sentence,
 * so an assumption of the import's that explains it (energy derived from the
 * record's own macros, say) has to survive a pass that has something of its own
 * to add. Replacing the list would leave a method describing a derivation with
 * no assumption accounting for it — the two-sided disagreement this merge
 * exists to prevent. Order is prior-first so a reader sees provenance before
 * judgement, and a repeat of an assumption already present is not appended,
 * which is what makes re-validating a row any number of times idempotent.
 */
export const validationRecordPatch = (
    verdict: CatalogValidationVerdict,
    publicationStatus: string,
    extraAssumptions: readonly string[],
    now: Date,
    priorAssumptions: readonly string[] = [],
): Record<string, unknown> => {
    const patch: Record<string, unknown> = {
        checks: verdict.checks,
        outcome: publicationStatus === 'published' ? verdict.outcome : nonPublishedOutcome(publicationStatus, verdict),
        publication_status: publicationStatus,
        reviewed_at: now,
        llm_review: null,
    };

    const merged = priorAssumptions.slice();
    for (const assumption of extraAssumptions) {
        if (!merged.includes(assumption)) {
            merged.push(assumption);
        }
    }
    // Written only when it would say something different, so a re-validation
    // that changes nothing leaves the column — and the release digest derived
    // from it — untouched.
    if (merged.length > 0 && JSON.stringify(merged) !== JSON.stringify(priorAssumptions.slice())) {
        patch.nutrition_assumptions = JSON.stringify(merged);
    }

    return patch;
};

/**
 * A complete validation record, for a food that has none.
 *
 * Reached for a row loaded from a release rather than imported, where the
 * release's own record was not carried into this database. Every field it can
 * state from the row is stated; `identity_evidence` is empty rather than
 * invented, and `nutrition_method` says plainly that validation wrote this
 * record, so nobody reads it as first-hand import provenance.
 */
export const validationRecordSeed = (
    row: ValidationFoodRow,
    verdict: CatalogValidationVerdict,
    publicationStatus: string,
    extraAssumptions: readonly string[],
    now: Date,
): Record<string, unknown> => ({
    ...validationRecordPatch(verdict, publicationStatus, extraAssumptions, now),
    canonical_identity: {
        source_key: row.source_key,
        canonical_name: row.canonical_name,
        display_name: row.display_name,
        food_state: row.food_state,
        category: row.category,
    },
    aliases: row.catalog_food_aliases.map(({ alias }) => alias),
    category: row.category,
    food_state: row.food_state,
    identity_source: row.identity_source,
    identity_status: row.identity_status,
    nutrition_provenance: row.nutrition_provenance,
    nutrition_method:
        'read per 100 g from the stored catalog row; this record was written by validation rather than by the import, so it carries no first-hand retrieval evidence',
    nutrition_assumptions: JSON.stringify(extraAssumptions.slice()),
    portion_units: row.catalog_food_portions.map((portion) => ({ ...portion })),
    identity_evidence: [],
    source_versions: { coverage_plan_version: 'v1' },
});

/**
 * The outcome to record when the publication status is not `published`.
 *
 * `accepted` would be untrue of a row the checks passed but a floor held back,
 * and the column's vocabulary is `accepted | quarantined | rejected`, so a
 * held row is `quarantined`: unusable as it stands, pending something only a
 * person can supply.
 */
const nonPublishedOutcome = (publicationStatus: string, verdict: CatalogValidationVerdict): string =>
    publicationStatus === 'rejected' ? 'rejected' : verdict.outcome === 'accepted' ? 'quarantined' : verdict.outcome;

/** One entry per judgement, newest last, capped so the row cannot grow unbounded. */
const VALIDATION_HISTORY_LIMIT = 20;

export const appendValidationHistory = (
    row: ValidationFoodRow,
    publicationStatus: string,
    verdict: CatalogValidationVerdict,
    now: Date,
): unknown[] => {
    const existing = Array.isArray(row.catalog_validation_records?.history)
        ? (row.catalog_validation_records?.history as unknown[])
        : [];

    const entry = {
        at: now.toISOString(),
        from: row.publication_status,
        to: publicationStatus,
        outcome: verdict.outcome,
        deciding_checks: verdict.decidingCheckNames,
        review_flags: verdict.reviewFlags,
    };

    return existing.concat([entry]).slice(-VALIDATION_HISTORY_LIMIT);
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

    // Reached here rather than at module load: constructing the client is a
    // side effect, and the suites that read parseArgs, preflight and the pure
    // derivations above must not pay for it.
    const { prisma } = await import('../src/prisma/client');

    const coveragePlan = loadCoveragePlan();
    const outcome = await runValidation({
        db: prisma as unknown as ValidateDb,
        runDb: prisma as unknown as CatalogRunDb,
        coveragePlan,
        options: parsed.options,
        logger,
        now: () => new Date(),
        writeReport: (report) => {
            const target = reportPath('validation-report.json');
            fs.mkdirSync(path.dirname(target), { recursive: true });
            fs.writeFileSync(target, `${JSON.stringify(report, null, 2)}\n`, 'utf-8');
        },
    });

    logger.info('stage_completed', {
        stage: STAGE,
        runId: outcome.runId,
        counts: JSON.stringify(outcome.counts),
    });

    await prisma.$disconnect();
    return 0;
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
