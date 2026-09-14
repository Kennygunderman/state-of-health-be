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
// WHAT THIS STAGE JUDGES FROM, AND WHY IT IS NOT THE SET-WIDE READ. The
// duplicate pass needs the whole non-rejected table, but a verdict may not be
// written from a row read before the write: a concurrent writer can replace the
// nutrients, the basis, the provenance or the metadata in between, and the
// judgement would then describe facts the row no longer holds. Three things
// stand between that and the table, smallest last: the stage holds the
// catalog-graph lock EXCLUSIVELY for the life of the process
// (lib/checkpoint.ts's THE STAGE LOCK), each food is locked and RE-READ with its
// children inside its own short transaction and its verdict recomputed there,
// and the status write is guarded on the `nutrition_version`,
// `metadata_version` and `publication_status` that re-read returned. A row whose
// facts moved anyway is left unjudged, counted and reported — never published on
// a stale verdict.
//
// RE-RUNNING A SUCCEEDED PASS IS A NO-OP, BY DESIGN. The run is claimed under a
// key derived from the coverage plan version and this invocation's options
// (validationRunScope), and a claim that comes back already completed ends the
// stage with no write at all. Deliberate re-judgement comes from a new coverage
// plan version, which is what the bounds themselves live in.
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

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError } from './lib/dbGuard';
import { createFatalLogger, createLogger, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel } from './lib/logger';
import { ManifestError, loadCoveragePlan, loadEvidenceAllowlist, reportPath } from './lib/manifest';
import type { CatalogFoodState, CoveragePlan } from './lib/manifest';
import { ModelBudgetError, getCatalogModelCallBudget } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import {
    CheckpointError,
    GRAPH_MUTATING_RUN_KINDS,
    VALIDATION_INPUT_SEPARATOR,
    VALIDATION_SCOPE_SEPARATOR,
    appendRunLog,
    canonicalValidationRunKey,
    catalogInputIdentity,
    finishRun,
    mergeCounts,
    openOrResumeRun,
    recordCounts,
    saveCursor,
    validationRunKeyInputPart,
    withCatalogStageLock,
} from './lib/checkpoint';
import type { CatalogInputRunRow, CatalogRunDb } from './lib/checkpoint';
import type { ScriptLogger } from './lib/logger';

// The checks themselves. Pure, so this import opens nothing; the Prisma client
// is reached from main() because constructing it is a module-load side effect.
import { dedupeIdentity, normalizeCanonicalName, validateCatalogCandidate } from '../src/services/catalog.logic';
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
    /**
     * The snapshot counters the import bumps when it changes a row's nutrients
     * or its identity/metadata. Read here for one reason: they are the
     * compare-and-set predicate this stage writes under, so a judgement can only
     * land on the exact facts it was computed from (see the judgement loop).
     */
    readonly nutrition_version: number;
    readonly metadata_version: number;
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
        findUnique(args: unknown): Promise<ValidationFoodRow | null>;
        /**
         * `updateMany`, not `update`: the write is guarded on the row's stored
         * versions and status, and a miss has to come back as a COUNT of zero
         * rather than as Prisma's P2025 — a vendor error shape this file must
         * neither leak nor pattern-match (Rule backend-architecture §9).
         */
        updateMany(args: unknown): Promise<{ count: number }>;
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
    /**
     * Raw SQL, because Prisma cannot express `FOR UPDATE` and the row lock is
     * not optional here (see the judgement loop). Declared with the array type
     * as the parameter, which is how lib/checkpoint.ts's `lockRunForUpdate`
     * calls it, so both raw readers in this pipeline read the same way.
     */
    $queryRaw<TRows = unknown>(query: TemplateStringsArray, ...values: unknown[]): Promise<TRows>;
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
    /**
     * True when this invocation found the run already SUCCEEDED and did
     * nothing: no food update, no validation record, no cursor, no counts, no
     * close and no report file. The counts are the stored ones and
     * `byCategory` is empty, because a run row records totals rather than the
     * per-category figures — those live in the report the closing invocation
     * wrote. Callers must be able to tell this from a pass that ran (see THE
     * COMPLETED-RUN NO-OP), which is why it is part of the outcome rather than
     * a log line.
     */
    readonly alreadyCompleted: boolean;
    /**
     * Rows this invocation considered but did not judge, because the row
     * vanished, a racing writer won the compare-and-set, or its identity group
     * moved under the duplicate pass (see the judgement loop). Zero is the
     * normal case; anything else means the run is NOT a complete judgement of
     * its considered set and is closed as failed so a re-run resumes it.
     */
    readonly unjudged: number;
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

/** The identity facts the duplicate decision is derived from, row-shaped. */
export interface ValidationIdentityFacts {
    readonly source_key: string;
    readonly canonical_name: string;
    readonly food_state: string;
    readonly identity_source: string;
}

/**
 * Whether a row's identity moved between the duplicate pass and its write.
 *
 * THE ONE LIMIT OF RE-JUDGING FROM A FRESH ROW. Every other check is a function
 * of the row alone, so re-reading the row inside its write transaction and
 * recomputing is enough. The duplicate-identity verdict is not: it is a decision
 * about the whole surviving SET, taken by `dedupeIdentity` over every
 * non-rejected row, and it cannot be recomputed from one row. So when the fresh
 * row's identity has moved, the survivor mapping this pass is holding may no
 * longer describe it, and the honest answer is to leave the row unjudged and say
 * so rather than to publish a duplicate or quarantine a survivor.
 *
 * The facts compared are exactly the ones that decision reads:
 * `identityGroupKey` in src/services/catalog.logic.ts is
 * `normalizeCanonicalName(canonical_name)` plus `food_state`; the survivor
 * preference reads `identity_source`; and the mapping itself is keyed by
 * `source_key`, so a moved key would make the lookup answer for a different
 * record. The name is compared NORMALISED, because that is the grain the group
 * key uses — a purely cosmetic re-spelling does not move the group and must not
 * cost the row its judgement.
 */
export const identityGroupMoved = (
    before: ValidationIdentityFacts,
    after: ValidationIdentityFacts,
): boolean =>
    before.source_key !== after.source_key ||
    before.food_state !== after.food_state ||
    before.identity_source !== after.identity_source ||
    normalizeCanonicalName(before.canonical_name) !== normalizeCanonicalName(after.canonical_name);

/** What one food's write transaction reports back, so the tallies happen after it commits. */
type ValidationWriteOutcome =
    | {
          readonly outcome: 'judged';
          readonly publicationStatus: string;
          readonly previousStatus: string;
          readonly verdict: CatalogValidationVerdict;
          readonly identityHeld: boolean;
          readonly awaitingClassification: boolean;
          /** Read from the fresh row, so a re-categorised food is counted where it now sits. */
          readonly category: string;
      }
    | { readonly outcome: 'vanished' | 'raced' | 'identity_moved' };

/**
 * The checkpoint key this invocation may claim.
 *
 * TWO THINGS NAME A VALIDATION RUN, and both are here. The POLICY is the
 * coverage plan version, whose bounds every verdict is computed from. The INPUT
 * is the graph as the last completed ingest left it, carried as
 * `canonicalValidationRunKey`'s hash of `catalogInputIdentity` — so a catalog
 * refresh is new work by construction (AAP §0.5.1, "a refresh re-runs
 * validation") while re-running the stage against an unchanged graph is still
 * the completed-run no-op. Keyed on the policy alone, one success would answer
 * for every later import under the same plan, and catalog-release — which wants
 * a validation newer than the last ingest — would wait on a run that could no
 * longer happen. The shared definition lives in lib/checkpoint.ts because
 * catalog-release.ts must resolve the same key to know which validation row is
 * canonical.
 *
 * Only the canonical full pass claims that key. A pass whose considered set is
 * not the full one — narrowed by `--category`, or widened by
 * `--revalidate-quarantined` — claims a key naming its own restriction instead:
 * it can still resume and still refuses to redo itself, but it must never be
 * able to CLOSE the canonical key, and catalog-release will not accept it as a
 * prerequisite.
 *
 * The suffix is order- AND repetition-insensitive: the categories are sorted
 * and DEDUPLICATED, so `--category dairy --category dairy` names the same
 * considered set as `--category dairy` and therefore the same run, instead of
 * minting a second key that walks straight past the no-op. Mirrors
 * `importRunScope` in catalog-import-usda.ts, which solves exactly this for
 * `--category`/`--limit`.
 *
 * @param inputIdentity from `catalogInputIdentity(ledgerRows)`, read before any graph read
 */
export const validationRunScope = (
    coveragePlanVersion: string,
    options: ValidateOptions,
    inputIdentity: string,
): string => {
    const canonical = canonicalValidationRunKey(coveragePlanVersion, inputIdentity);
    const categories = Array.from(new Set(options.categories)).sort();
    const restricted = categories.length > 0 || options.revalidateQuarantined;

    if (!restricted) {
        return canonical;
    }

    const scope = JSON.stringify({
        categories,
        revalidateQuarantined: options.revalidateQuarantined,
    });

    return `${canonical}${VALIDATION_SCOPE_SEPARATOR}${crypto
        .createHash('sha256')
        .update(scope)
        .digest('hex')
        .slice(0, 16)}`;
};

/**
 * Where an interrupted pass picks up.
 *
 * `nextIndex` indexes the considered list, which is deterministic (`source_key`
 * ascending), and `fingerprint` is what makes that index meaningful: it names
 * the considered set AND the policy the set was judged against, so an index
 * saved against a different work list is recognised as meaningless instead of
 * resumed into the wrong row.
 *
 * `unjudged` carries the positions this run skipped without judging — a row
 * that vanished, lost the compare-and-set or moved identity group. They are
 * revisited FIRST on the next attempt, because the tail pointer has already
 * moved past them and nothing else would ever come back to them.
 */
export interface ValidationCursor {
    readonly fingerprint: string;
    readonly nextIndex: number;
    readonly unjudged: readonly number[];
}

/**
 * How many skipped positions the cursor carries.
 *
 * A skip needs a writer racing this pass, which the exclusive stage lock makes
 * a pathological case rather than an expected one (see main). Past this many,
 * the graph moved so much underneath the pass that revisiting individual rows
 * is not the remedy — a full re-judgement is — so the overflow is counted and
 * reported but not queued.
 */
const UNJUDGED_CURSOR_LIMIT = 500;

/**
 * The fingerprint the cursor is only meaningful against.
 *
 * It covers both halves of "the same work, judged the same way": the considered
 * set in the order the loop walks it, and the policy the checks read. A changed
 * coverage plan therefore restarts the pass rather than resuming into an index
 * that now names a different food — which matters more here than for the import,
 * because the bounds a verdict is computed from live in that same plan.
 */
export const validationPlanFingerprint = (input: {
    readonly coveragePlanVersion: string;
    readonly policy: CatalogValidationPolicy;
    readonly consideredSourceKeys: readonly string[];
}): string =>
    crypto
        .createHash('sha256')
        .update(
            JSON.stringify([
                input.coveragePlanVersion,
                input.policy.categories,
                input.policy.validationBounds,
                input.consideredSourceKeys,
            ]),
        )
        .digest('hex');

/** One checkpoint per hundred judged foods, which is the import's five-batch cadence (5 × 20 records). */
const COUNTS_SAVE_EVERY_FOODS = 100;

/**
 * A validation run left open against a catalog input that has since been
 * replaced.
 *
 * Carried into the run's own failure record, which is the only place an
 * operator meets it: the row is settled by a LATER pass rather than by the
 * process that opened it, so there is nothing to throw to and the message has
 * to explain, on its own, why a run nobody cancelled is marked failed.
 */
export class ValidationRunSupersededError extends Error {
    public readonly code = 'validation_run_superseded';

    public constructor(public readonly runScope: string) {
        super(
            `this run was judging catalog input ${validationRunKeyInputPart(runScope) ?? 'unknown'}, which has since ` +
                'been replaced by a newer import, generation or release load. Its key names that input, so no future ' +
                'invocation can claim it and it can never be resumed. It is settled failed here; the rows it judged ' +
                'keep the statuses it gave them and the pass for the current input re-judges them under its own key.',
        );
        this.name = 'ValidationRunSupersededError';
    }
}

/**
 * Closes validation runs that were left open against a catalog input this
 * database no longer has.
 *
 * Such a row is unresumable by construction: the run key names the input, so
 * re-running the stage claims a different key and nothing will ever come back
 * for that one. It is closed FAILED rather than succeeded, because it is exactly
 * that — a pass that did not finish — and the rows it judged keep the statuses
 * it gave them, which the next pass re-judges from scratch under its own key.
 *
 * Deliberately narrow. A run for the CURRENT input is untouched whatever its
 * state: that is either this pass's own resumable work or a concurrent attempt,
 * and the exclusive stage lock is what decides between those, not this. A run
 * under a different coverage plan version is untouched too — a plan is a
 * deliberate policy change and its runs are not this pass's to settle.
 *
 * @returns the number of runs settled
 */
export const settleUnresumableValidationRuns = async (input: {
    readonly runDb: CatalogRunDb;
    readonly coveragePlanVersion: string;
    readonly currentInputPart: string | null;
    readonly logger: ScriptLogger;
    readonly now: () => Date;
}): Promise<number> => {
    const open = await input.runDb.catalog_import_runs.findMany({
        where: {
            kind: 'validation',
            status: 'running',
            manifest_version: { startsWith: `${input.coveragePlanVersion}${VALIDATION_INPUT_SEPARATOR}` },
        },
        select: { id: true, manifest_version: true },
    });

    const unresumable = open.filter(
        (run) => validationRunKeyInputPart(run.manifest_version) !== input.currentInputPart,
    );

    for (const run of unresumable) {
        input.logger.warn('validation_run_superseded', {
            stage: STAGE,
            runId: run.id,
            runScope: run.manifest_version,
            reason: 'the catalog input this run was judging has been replaced, so the run can never be resumed',
        });
        await finishRun(input.runDb, run.id, 'failed', {
            error: new ValidationRunSupersededError(run.manifest_version),
            logger: input.logger,
        });
    }

    return unresumable.length;
};

/**
 * How much of a skipped row's evidence is written where.
 *
 * The COUNTS are exact whatever happens; these two bound the two places a
 * skipped row is also named, because a skip needs a writer racing this pass and
 * the exclusive stage lock makes that pathological rather than expected. The run
 * log is capped at 200 entries in total (lib/checkpoint.ts), so an unbounded
 * append would push out every other entry describing what the run did.
 */
const SKIP_RUN_LOG_LIMIT = 10;
const SKIP_REPORT_LIMIT = 50;

/**
 * Runs the checks over every row this invocation owns and writes the outcome.
 *
 * The duplicate pass runs first and over the whole non-rejected table, because
 * `dedupeIdentity` decides which of two same-identity rows survives and that
 * answer cannot be derived from either row alone. A loser is quarantined with
 * `duplicate_identity` and its aliases are merged into the survivor, so the
 * name a user might search for still reaches the food that kept the identity.
 *
 * THE COMPLETED-RUN NO-OP. A claim that comes back `alreadyCompleted` ends this
 * function immediately, with no write of any kind. Re-running a succeeded
 * validation used to rewrite every considered food's `updated_at`, every
 * validation record's `reviewed_at` and `history`, and the report — all beneath
 * a closed run whose counts and timing did not change, so the row said one
 * thing and the tables said another.
 *
 * Re-judgement is therefore never a matter of running the stage again — it
 * follows from the run key, which names both the POLICY and the INPUT (see
 * validationRunScope). A new `coveragePlanVersion` is new work because the
 * bounds every check is measured against live in that plan, so "judge it again"
 * and "judge it against something" are the same act. A newer catalog:import or
 * catalog:load is new work because the rows themselves changed — which is what
 * AAP §0.5.1 requires of a refresh, and what keeps catalog-release from waiting
 * on a validation newer than the last ingest that could never happen.
 */
export const runValidation = async (deps: RunValidationDeps): Promise<ValidationOutcome> => {
    const { logger, options, coveragePlan } = deps;

    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };

    // WHICH CATALOG THIS PASS IS ABOUT, resolved before anything else.
    //
    // The run key names the policy AND the graph the last completed ingest left
    // (see validationRunScope), so the ledger is read first. It has to be the
    // LEDGER and not the graph: the completed-run no-op below must be able to
    // answer without reading a single food, and this is the one record of "what
    // was loaded" that costs nothing. A refresh therefore lands on a new key and
    // is judged, instead of being answered for by the pass that judged the
    // catalog before it.
    const ingestRuns = await deps.runDb.catalog_import_runs.findMany({
        where: { kind: { in: [...GRAPH_MUTATING_RUN_KINDS] } },
        select: { kind: true, manifest_version: true, status: true, finished_at: true },
    });
    const inputIdentity = catalogInputIdentity(ingestRuns as CatalogInputRunRow[]);

    // A restricted pass claims its own key and cannot close the canonical one
    // (see validationRunScope).
    const runScope = validationRunScope(coveragePlan.coveragePlanVersion, options, inputIdentity);
    logger.info('validation_input_resolved', {
        stage: STAGE,
        runScope,
        coveragePlanVersion: coveragePlan.coveragePlanVersion,
        catalogInput: inputIdentity,
    });

    // RUNS LEFT OPEN AGAINST A CATALOG THAT NO LONGER EXISTS.
    //
    // Because the key names the input, a pass interrupted BEFORE an import can
    // never be resumed: re-running this stage now claims a different key, so
    // nothing will ever close that row. Left alone it would block every future
    // release — catalog-release refuses on any open mutating run and tells the
    // operator to re-run the stage to settle it, which is advice that cannot
    // work here.
    //
    // So this pass settles them, and only them: open validation runs whose key
    // names a DIFFERENT catalog input. Those are exactly the unresumable ones.
    // An open run for this same input is left strictly alone — that is this
    // pass's own resumable work, or a concurrent attempt, and the stage lock is
    // what decides between those.
    await settleUnresumableValidationRuns({
        runDb: deps.runDb,
        coveragePlanVersion: coveragePlan.coveragePlanVersion,
        currentInputPart: validationRunKeyInputPart(runScope),
        logger,
        now: deps.now,
    });

    // No initialCursor: the fingerprint the cursor is only meaningful against
    // covers the considered set, which is not known until the graph is read —
    // and the read must not happen at all for a run that is already settled.
    // An absent cursor means "nothing judged yet", which is exactly what a
    // resume from index 0 does.
    const claim = await openOrResumeRun<ValidationCursor>(deps.runDb, {
        kind: 'validation',
        manifestVersion: runScope,
        logger,
        now: deps.now,
    });

    if (claim.alreadyCompleted) {
        // Zero writes and zero work: not even the graph read below, because
        // nothing it could produce may be acted on (see THE COMPLETED-RUN
        // NO-OP). The stored counts and the run's finish time are logged
        // because they are the answer to "what did that run do?", and the
        // remedy names BOTH ways new work arises, because an operator reading
        // this line is asking how to get these rows judged again: import or
        // load a catalog (the input changes, so the key does), or publish a new
        // coverage plan version (the policy changes). Re-running the stage
        // against this same catalog under this same plan is a no-op by design.
        logger.info('run_already_completed', {
            stage: STAGE,
            runId: claim.run.id,
            runScope,
            coveragePlanVersion: coveragePlan.coveragePlanVersion,
            catalogInput: inputIdentity,
            finishedAt: claim.run.finishedAt === null ? null : claim.run.finishedAt.toISOString(),
            counts: JSON.stringify(claim.run.counts),
            remedy:
                'This catalog has already been judged under this coverage plan. A newer catalog:import or catalog:load, ' +
                'or a new coveragePlanVersion, each creates a new validation run; re-running this stage against the same ' +
                'input and the same plan is a no-op by design.',
        });

        return {
            runId: claim.run.id,
            counts: claim.run.counts,
            byCategory: {},
            alreadyCompleted: true,
            unjudged: 0,
        };
    }

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
        nutrition_version: true,
        metadata_version: true,
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

    // WHERE THIS INVOCATION PICKS UP.
    //
    // The cursor is only meaningful against the work list it was saved for, so
    // the fingerprint is checked before the index is trusted: a matching one
    // RESUMES from the recorded position, a changed one RESTARTS the pass and
    // says so, exactly as catalog-import-usda.ts handles a changed plan. The
    // re-judgement a restart costs is idempotent for everything except the
    // history append, which is the whole reason the cursor exists.
    const fingerprint = validationPlanFingerprint({
        coveragePlanVersion: coveragePlan.coveragePlanVersion,
        policy,
        consideredSourceKeys: considered.map((row) => row.source_key),
    });

    let startIndex = 0;
    let retryIndexes: number[] = [];
    let restarted = false;
    const savedCursor = claim.run.cursor;

    if (claim.resumed && savedCursor !== null && typeof savedCursor === 'object') {
        const cursor = savedCursor as Partial<ValidationCursor>;
        if (cursor.fingerprint === fingerprint && typeof cursor.nextIndex === 'number') {
            startIndex = Math.max(0, Math.min(cursor.nextIndex, considered.length));
            retryIndexes = Array.isArray(cursor.unjudged)
                ? cursor.unjudged
                      .filter(
                          (index): index is number =>
                              Number.isInteger(index) && index >= 0 && index < startIndex,
                      )
                      .sort((left, right) => left - right)
                : [];
            logger.info('validation_resumed', {
                stage: STAGE,
                runId: claim.run.id,
                startIndex,
                ofFoods: considered.length,
                revisitingSkipped: retryIndexes.length,
            });
        } else {
            // The considered set or the policy changed between attempts, so the
            // saved index names a different food than it did. Restarting is the
            // only correct reading of that, and saying so is better than
            // resuming into the wrong place.
            restarted = true;
            logger.warn('cursor_plan_changed', {
                stage: STAGE,
                runId: claim.run.id,
                savedFingerprint: String(cursor.fingerprint ?? '').slice(0, 16),
                planFingerprint: fingerprint.slice(0, 16),
            });
            await appendRunLog(deps.runDb, claim.run.id, {
                event: 'cursor_plan_changed',
                planFingerprint: fingerprint,
            });
        }
    }

    // A continued attempt of the same work list; a restart is a fresh sweep of a
    // changed one, and its report describes the sweep it ran rather than adding
    // to totals taken over different rows.
    const continuedRun = claim.resumed && !restarted;

    // THIS INVOCATION'S COUNTERS, AND WHY THEY START WHERE THEY DO.
    //
    // `recordCounts` accumulates by ADDITION (checkpoint.ts::mergeCounts), so
    // the run row totals every attempt. A report built from this invocation's
    // slice alone would therefore state a fraction of what the run recorded, and
    // the two would disagree about the same run — so a continued attempt seeds
    // its counters from the row and adds to them.
    const counts: Record<string, number> = mergeCounts(continuedRun ? claim.run.counts : {}, {
        published: 0,
        quarantined: 0,
        rejected: 0,
        unchanged: 0,
        candidatesHeld: 0,
        aliasesMerged: 0,
        aliasRecordsRestated: 0,
        identityNotVerified: 0,
        awaitingClassification: 0,
        judged: 0,
        vanished: 0,
        raced: 0,
        identityGroupMoved: 0,
    });
    // The plan's own size, never an accumulation: a continued attempt considers
    // the same set, and since `mergeCounts` can only add, a `considered`
    // recorded per interval would report one set several times over. It reaches
    // the run row only in the close, and as a difference — see the close for why
    // that is what lands the column on the size exactly.
    counts.considered = considered.length;

    const byCheck: Record<string, number> = {};
    const reviewFlagCounts: Record<string, number> = {};
    const publishedByCategory: Record<string, number> = {};

    const rowsBySourceKey = new Map(allRows.map((row) => [row.source_key, row]));
    const now = deps.now();

    // Counters recorded on the run row at the next checkpoint. Held separately
    // from `counts` because the row accumulates: what it must receive is the
    // INTERVAL's delta, never the running total.
    let pendingCounts: Record<string, number> = {};
    const tally = (key: string, amount = 1): void => {
        counts[key] = (counts[key] ?? 0) + amount;
        pendingCounts[key] = (pendingCounts[key] ?? 0) + amount;
    };

    // The positions this run has considered but not judged. Seeded from the
    // cursor, so a skipped row is revisited by the next attempt instead of being
    // stranded behind the tail pointer.
    const unjudgedPositions = new Set<number>(retryIndexes);
    // Skipped positions first: the tail pointer has already moved past them.
    const plannedQueue: number[] = [...retryIndexes];
    for (let index = startIndex; index < considered.length; index += 1) {
        plannedQueue.push(index);
    }

    // WHAT THIS RUN HAS ALREADY JUDGED IS A FACT ABOUT THE ROW, NOT A POSITION.
    //
    // The cursor's index is the fast path and it is right almost always, but it
    // cannot be the authority, for two reasons that both end in a duplicated
    // history entry — the one thing a judgement is not idempotent about:
    //
    //   * the status write commits before the cursor does, so a crash between
    //     them leaves a judged row behind the pointer; and
    //   * the considered list is filtered by publication status and THIS PASS
    //     CHANGES THAT STATUS, so a candidate this pass rejected is gone from
    //     the list next time and every position after it has shifted — which is
    //     also what makes the plan fingerprint disagree with itself and send an
    //     interrupted attempt down the restart branch.
    //
    // So the queue is filtered by the run's own history: a row this run has
    // already judged is dropped whatever the index says. The predicate reads the
    // record the judgement itself wrote, so it cannot drift from the table the
    // way a separately maintained pointer can.
    const queue = plannedQueue.filter((index) => !runHasJudgedFood(considered[index], claim.run.id));
    const alreadyJudgedByThisRun = plannedQueue.length - queue.length;
    if (alreadyJudgedByThisRun > 0) {
        logger.info('validation_skipping_already_judged', {
            stage: STAGE,
            runId: claim.run.id,
            alreadyJudged: alreadyJudgedByThisRun,
            queued: queue.length,
        });
    }

    let nextIndex = startIndex;
    let judgedThisInvocation = 0;
    let processedThisInvocation = 0;

    const skipped: { vanished: string[]; raced: string[]; identityMoved: string[] } = {
        vanished: [],
        raced: [],
        identityMoved: [],
    };
    let skipLogEntries = 0;

    const recordSkip = async (
        kind: 'vanished' | 'raced' | 'identity_moved',
        row: ValidationFoodRow,
    ): Promise<void> => {
        if (kind === 'vanished') {
            tally('vanished');
            if (skipped.vanished.length < SKIP_REPORT_LIMIT) {
                skipped.vanished.push(row.source_key);
            }
        } else if (kind === 'raced') {
            tally('raced');
            if (skipped.raced.length < SKIP_REPORT_LIMIT) {
                skipped.raced.push(row.source_key);
            }
        } else {
            tally('identityGroupMoved');
            if (skipped.identityMoved.length < SKIP_REPORT_LIMIT) {
                skipped.identityMoved.push(row.source_key);
            }
        }

        logger.warn('food_not_judged', { stage: STAGE, runId: claim.run.id, sourceKey: row.source_key, reason: kind });

        if (skipLogEntries < SKIP_RUN_LOG_LIMIT) {
            skipLogEntries += 1;
            await appendRunLog(deps.runDb, claim.run.id, {
                event: 'food_not_judged',
                reason: kind,
                sourceKey: row.source_key,
            });
        }
    };

    /**
     * Records the counter interval this invocation has accumulated but not yet
     * written to the run row, and empties it so the next flush carries only the
     * next interval.
     *
     * Called on the cadence below, and once more if the judgement loop fails.
     * That second caller is what keeps a RESUMED run's totals true. The cursor
     * advances per food, so an interrupted attempt's judgements are durable and
     * are never repeated — but the counters flush on an interval, and a
     * continued attempt seeds its own from the run row (see THIS INVOCATION'S
     * COUNTERS). An interval lost to the interruption would therefore be lost
     * for good, and the eventually-succeeded run would state fewer judged foods
     * than it considered for a set it had in fact judged completely. Flushing as
     * the error leaves keeps the row, the report and the work done agreeing
     * about the same run.
     */
    const flushPendingCounts = async (): Promise<void> => {
        if (Object.keys(pendingCounts).length === 0) {
            return;
        }
        const delta = pendingCounts;
        pendingCounts = {};
        await recordCounts(deps.runDb, claim.run.id, delta);
    };

    try {
        for (const index of queue) {
            const row = considered[index];

            // ONE FOOD, ONE SHORT TRANSACTION, AND THE VERDICT COMPUTED INSIDE IT.
            //
            // The graph read above is what the duplicate pass needs — the survivor
            // choice is a property of the whole set — but it is NOT what a row may
            // be judged from. Between that read and this write another writer can
            // replace the row's nutrients, its basis, its provenance or its
            // metadata, and a verdict computed from the older facts would then be
            // published against facts it never saw: exactly the wrong judgement, on
            // a row that looks judged. So the row is locked, re-read WITH its
            // children through the same `selection`, and the verdict recomputed
            // from what the lock is holding.
            //
            // The write is then guarded on the versions and the status that re-read
            // returned, so even if the lock were somehow lost the judgement can only
            // land on the facts it was computed from (see THE VERSION PREDICATE).
            const written = await deps.db.$transaction(
                async (tx): Promise<ValidationWriteOutcome> => {
                    // Raw SQL because Prisma cannot express FOR UPDATE, and this is
                    // the lock that makes everything below a snapshot nobody else
                    // can move: lib/checkpoint.ts::lockRunForUpdate is the in-repo
                    // pattern, down to binding the id and casting it in the
                    // statement. An empty result means the row was DELETED under
                    // this pass — not "no such food", since the read above returned
                    // it — and there is nothing left to judge.
                    const locked = await tx.$queryRaw<{ id: string }[]>`
                        SELECT id FROM catalog_foods WHERE id = ${row.id}::uuid FOR UPDATE
                    `;
                    if (locked.length === 0) {
                        return { outcome: 'vanished' };
                    }

                    // Re-read through the SAME selection object the outer read used,
                    // so `candidateFromRow` and the record writers below keep
                    // working on one shape and cannot drift apart.
                    const fresh = await tx.catalog_foods.findUnique({ where: { id: row.id }, select: selection });
                    if (fresh === null) {
                        // Unreachable while the row lock is held; kept as the
                        // guarantee itself rather than as a comment, which is how
                        // lib/checkpoint.ts writes the same situation.
                        return { outcome: 'vanished' };
                    }

                    if (identityGroupMoved(row, fresh)) {
                        // The duplicate decision this pass is holding was taken for
                        // a different identity, and it cannot be recomputed from one
                        // row (see identityGroupMoved).
                        return { outcome: 'identity_moved' };
                    }

                    const verdict = validateCatalogCandidate(candidateFromRow(fresh), policy, {
                        duplicateOfSourceKey: duplicateOf.get(fresh.source_key) ?? null,
                    });

                    let publicationStatus: string = verdict.publicationStatus;
                    const extraAssumptions: string[] = [];
                    let identityHeld = false;
                    let awaitingClassification = false;

                    // Both floors are re-applied to the FRESH row: an import that
                    // changed `identity_status`, or that marked the row for a
                    // curator, changes the answer, and honouring the stale row's
                    // values would publish a food the current row says must not be.
                    if (publicationStatus === 'published' && !publishableIdentity(fresh.identity_status)) {
                        publicationStatus = 'quarantined';
                        identityHeld = true;
                        extraAssumptions.push(
                            `identity_status is "${fresh.identity_status}", so the food is held for review rather than published even though every check passed`,
                        );
                    }
                    if (publicationStatus === 'published' && curatorReviewRequired(fresh)) {
                        // The manifest's own word for this state: "imported as a
                        // candidate and left unpublished pending a curator".
                        publicationStatus = 'candidate';
                        awaitingClassification = true;
                        extraAssumptions.push(
                            'the description matched no classification rule, so the food carries the manifest fallback category and food group and stays a candidate until a curator classifies it',
                        );
                    }

                    // THE VERSION PREDICATE. The write carries the two snapshot
                    // versions and the publication status the re-read returned, so
                    // it applies to that row state and to no other. Under the row
                    // lock a zero count is unreachable; the predicate stays because
                    // it IS the guarantee — if the lock were ever lost or the
                    // isolation weakened, this is what keeps a stale judgement out
                    // of the table, and the assertion below is how that guarantee is
                    // stated (the pattern lib/checkpoint.ts::closeRunOnce uses).
                    const updated = await tx.catalog_foods.updateMany({
                        where: {
                            id: fresh.id,
                            nutrition_version: fresh.nutrition_version,
                            metadata_version: fresh.metadata_version,
                            publication_status: fresh.publication_status,
                        },
                        data: { publication_status: publicationStatus, updated_at: now },
                    });
                    if (updated.count === 0) {
                        return { outcome: 'raced' };
                    }

                    // The history entry is derived from the FRESH row too, so `from`
                    // names the status the transition actually left.
                    const history = appendValidationHistory(fresh, publicationStatus, verdict, now, claim.run.id);

                    // Create and update are separate calls rather than one upsert:
                    // Prisma validates an upsert's `create` branch whether or not
                    // it runs, so a create carrying only the judgement fields is
                    // rejected for the required columns it does not restate — and
                    // restating them on every update would overwrite what the
                    // import established with values re-derived from the row.
                    if (fresh.catalog_validation_records === null) {
                        await tx.catalog_validation_records.create({
                            data: {
                                catalog_food_id: fresh.id,
                                ...validationRecordSeed(fresh, verdict, publicationStatus, extraAssumptions, now),
                                history,
                            },
                        });
                    } else {
                        await tx.catalog_validation_records.update({
                            where: { catalog_food_id: fresh.id },
                            data: {
                                ...validationRecordPatch(
                                    verdict,
                                    publicationStatus,
                                    extraAssumptions,
                                    now,
                                    parseStoredAssumptions(fresh.catalog_validation_records?.nutrition_assumptions),
                                ),
                                history,
                            },
                        });
                    }

                    return {
                        outcome: 'judged',
                        publicationStatus,
                        previousStatus: fresh.publication_status,
                        verdict,
                        identityHeld,
                        awaitingClassification,
                        category: fresh.category,
                    };
                },
                { timeout: TRANSACTION_TIMEOUT_MS },
            );

            processedThisInvocation += 1;
            if (index >= startIndex) {
                nextIndex = Math.max(nextIndex, index + 1);
            }

            // EVERY TALLY HAPPENS HERE, after the transaction has committed and from
            // what it returned. Counting before the write meant counting a
            // judgement that could still roll back — and now that a row can be
            // skipped outright, it would also mean counting one that never
            // happened. The report is the record an operator reads to decide
            // whether a release is complete, so it states what the database was
            // actually left holding.
            if (written.outcome === 'judged') {
                judgedThisInvocation += 1;
                tally('judged');
                unjudgedPositions.delete(index);

                if (written.identityHeld) {
                    tally('identityNotVerified');
                }
                if (written.awaitingClassification) {
                    tally('awaitingClassification');
                }

                for (const check of written.verdict.checks) {
                    if (!check.pass) {
                        byCheck[check.name] = (byCheck[check.name] ?? 0) + 1;
                    }
                }
                for (const flag of written.verdict.reviewFlags) {
                    reviewFlagCounts[flag] = (reviewFlagCounts[flag] ?? 0) + 1;
                }

                if (written.publicationStatus === 'published') {
                    tally('published');
                    publishedByCategory[written.category] = (publishedByCategory[written.category] ?? 0) + 1;
                } else if (written.publicationStatus === 'quarantined') {
                    tally('quarantined');
                } else if (written.publicationStatus === 'rejected') {
                    tally('rejected');
                } else if (written.publicationStatus === 'candidate') {
                    tally('candidatesHeld');
                }
                if (written.publicationStatus === written.previousStatus) {
                    tally('unchanged');
                }
            } else {
                // Skipped, and therefore VISIBLE: counted, logged, kept in the run
                // log up to its cap, reported by source key, and left in the
                // cursor's unjudged set so the next attempt revisits it. A row
                // silently absent from the report is the failure this replaces.
                unjudgedPositions.add(index);
                await recordSkip(written.outcome, row);
            }

            // THE CURSOR ADVANCES PER FOOD, not per interval, and that is a
            // deliberate departure from the import's five-batch cadence. The
            // import's unit of work is a batch of twenty vendor records whose
            // writes are upserts, so repeating one costs a request and changes
            // nothing; here the unit is one food and repeating it APPENDS A SECOND
            // HISTORY ENTRY to its validation record. Advancing per food is what
            // makes a resumed run judge no row twice; the extra cost is one small
            // locked write per food beside the four it already performs, and an
            // offline stage can afford that to keep its audit trail exact.
            await saveCursor<ValidationCursor>(deps.runDb, claim.run.id, {
                fingerprint,
                nextIndex,
                unjudged: sortedUnjudged(unjudgedPositions),
            });

            // The counters are diagnostics rather than a resume point, so they are
            // flushed on the import's cadence instead: a hundred judged foods is
            // five batches of twenty records, and the interval's DELTA is what the
            // accumulating column may receive.
            if (processedThisInvocation % COUNTS_SAVE_EVERY_FOODS === 0) {
                await flushPendingCounts();
                logger.info('validation_progress', {
                    stage: STAGE,
                    runId: claim.run.id,
                    judgedThisInvocation,
                    ofFoods: considered.length,
                    published: counts.published,
                    quarantined: counts.quarantined,
                    candidatesHeld: counts.candidatesHeld,
                });
            }
        }
    } catch (error) {
        // The interval first, then the original error — and a flush that fails
        // must not replace what actually went wrong: the counters are
        // diagnostics, while the judgement failure is the fact the operator has
        // to act on.
        try {
            await flushPendingCounts();
        } catch (flushError) {
            logger.warn('counts_flush_failed', {
                stage: STAGE,
                runId: claim.run.id,
                error: safeError(flushError),
            });
        }
        throw error;
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
        tally('aliasesMerged', inserted.count);
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
            tally('aliasRecordsRestated', restated.count);
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
        // WHAT COVERS THE WHOLE RUN AND WHAT COVERS ONLY THIS INVOCATION.
        //
        // `counts` totals the run: they are seeded from the run row when this
        // invocation continued an interrupted attempt. The per-check and
        // review-flag tallies and the per-category published figures are
        // accumulated in memory from the foods THIS invocation judged, because
        // nothing durable records them at that grain — so on a continued
        // attempt they describe the slice, not the run. On a fresh,
        // uninterrupted pass the two coincide, which is the normal case; they
        // are named here rather than left to be assumed.
        invocation: {
            runScope,
            resumed: claim.resumed,
            restartedBecausePlanChanged: restarted,
            startIndex,
            revisitedSkipped: retryIndexes.length,
            judged: judgedThisInvocation,
            planFingerprint: fingerprint,
            invocationOnlyFigures: ['failedChecks', 'reviewFlags', 'coverage.byCategory.published'],
        },
        // Rows this pass did NOT judge, by source key (capped per reason; the
        // counts above are exact). Reported rather than omitted: a row that was
        // skipped still carries the status it had before, and an operator
        // reading a report that simply lacked it would believe it was judged.
        skipped: {
            vanished: skipped.vanished,
            raced: skipped.raced,
            identityGroupMoved: skipped.identityMoved,
            note: 'A skipped row was left with the status it already had. The run is closed as failed when any row is skipped, so re-running catalog:validate retries that same run and revisits exactly these positions from its cursor. These lists cover THIS invocation; counts.vanished, counts.raced and counts.identityGroupMoved total every such event in the run, so a retry that judged the row keeps the event it recorded.',
        },
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

    // The close carries what the checkpoints have NOT recorded yet — the last
    // interval's delta. Passing the running total instead would add every
    // already-recorded count to the row a second time.
    //
    // `considered` is the one non-additive figure, and it is written as the
    // DIFFERENCE from what the row already holds. The column accumulates
    // (checkpoint.ts::mergeCounts), and a run CAN be closed more than once — a
    // pass that left rows unjudged closes as failed and a re-run retries the
    // same row and closes it again — so adding the set's size at each close
    // would report one set several times over. A difference lands the column on
    // the size exactly, whatever the attempt, and stays correct when a restart
    // considers a set of a different size.
    const storedConsidered =
        typeof claim.run.counts.considered === 'number' && Number.isFinite(claim.run.counts.considered)
            ? claim.run.counts.considered
            : 0;
    const closingCounts: Record<string, number> = {
        ...pendingCounts,
        considered: considered.length - storedConsidered,
    };
    const unjudged = unjudgedPositions.size;

    if (unjudged > 0) {
        // A pass that could not judge every row it considered is NOT a
        // completed judgement of its set, and recording it as one would be
        // unrecoverable: the completed-run no-op would answer every later
        // invocation of this key, so the skipped rows would keep their stale
        // status until a new coverage plan version was published. Closed as
        // failed instead — which is precisely the state a re-run RETRIES
        // (checkpoint.ts::retryFailedRun continues this same row), and the
        // cursor carries the skipped positions so the retry revisits them
        // first.
        const incomplete = new ValidationIncompleteError(unjudged, considered.length);
        logger.error('validation_incomplete', {
            stage: STAGE,
            runId: claim.run.id,
            unjudged,
            vanished: counts.vanished,
            raced: counts.raced,
            identityGroupMoved: counts.identityGroupMoved,
            remedy: incomplete.message,
        });
        await finishRun(deps.runDb, claim.run.id, 'failed', {
            counts: closingCounts,
            error: incomplete,
            logger,
        });
    } else {
        await finishRun(deps.runDb, claim.run.id, 'succeeded', { counts: closingCounts, logger });
    }

    return { runId: claim.run.id, counts, byCategory, alreadyCompleted: false, unjudged };
};

/**
 * A pass that judged fewer rows than it considered.
 *
 * Carried into the run's failure record rather than thrown: the report is
 * written and the counts are recorded first, because they are what tells an
 * operator WHICH rows were left and why. The message names the remedy, since
 * the run's own status is what makes that remedy work.
 */
export class ValidationIncompleteError extends Error {
    public readonly code = 'validation_incomplete';

    public constructor(
        public readonly unjudged: number,
        public readonly considered: number,
    ) {
        super(
            `${unjudged} of ${considered} considered food(s) were not judged: the row vanished, a concurrent writer ` +
                'won the version check, or the identity group moved under the duplicate pass. The run is left failed ' +
                'so that re-running catalog:validate retries it and revisits exactly those rows.',
        );
        this.name = 'ValidationIncompleteError';
    }
}

/** The cursor's skipped positions: ascending and capped (see UNJUDGED_CURSOR_LIMIT). */
const sortedUnjudged = (positions: ReadonlySet<number>): number[] =>
    Array.from(positions)
        .sort((left, right) => left - right)
        .slice(0, UNJUDGED_CURSOR_LIMIT);

/**
 * 30 s: one food is six statements — the row lock, the re-read, the guarded
 * status write and the validation record — but a cold connection pool is not.
 */
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

/**
 * ONE ENTRY PER RUN PER FOOD, and that is what makes a re-judgement harmless.
 *
 * The status write, the validation record and this history live in one
 * transaction; the cursor that says "this food is done" is a separate write
 * after it. Something has to be true in the window between them — a crash, a
 * SIGKILL, a failed cursor write — and if the append were unconditional, the
 * next attempt would judge the food again and leave TWO entries claiming the
 * same transition. The audit trail is the thing this stage exists to produce, so
 * a duplicated entry is not a cosmetic defect.
 *
 * Stamping the entry with the run and REPLACING any entry this run already
 * wrote makes the history itself the ledger of what the run has judged: exactly
 * one entry per (run, food) however many times the row is visited, whether the
 * revisit came from the crash window, from the cursor's skip set, or from a
 * restart. The judgement is otherwise idempotent already — the same locked
 * re-read, the same verdict, the same compare-and-set — so with the append
 * pinned, a repeat costs work and changes nothing.
 *
 * Entries an older release wrote carry no `run` and are never matched, so
 * existing history is preserved rather than reinterpreted.
 *
 * @param runId the validation run this judgement belongs to
 */
export const appendValidationHistory = (
    row: ValidationFoodRow,
    publicationStatus: string,
    verdict: CatalogValidationVerdict,
    now: Date,
    runId: string,
): unknown[] => {
    const existing = Array.isArray(row.catalog_validation_records?.history)
        ? (row.catalog_validation_records?.history as unknown[])
        : [];

    const entry = {
        at: now.toISOString(),
        run: runId,
        from: row.publication_status,
        to: publicationStatus,
        outcome: verdict.outcome,
        deciding_checks: verdict.decidingCheckNames,
        review_flags: verdict.reviewFlags,
    };

    const withoutThisRun = existing.filter((candidate) => !historyEntryBelongsToRun(candidate, runId));

    return withoutThisRun.concat([entry]).slice(-VALIDATION_HISTORY_LIMIT);
};

/**
 * Whether a stored history entry was written by the given run.
 *
 * Also the "has this run judged this food?" predicate the judgement queue uses,
 * which is why it is exported: it reads the record the judgement itself wrote,
 * so it cannot disagree with what is in the table the way a separately
 * maintained index could.
 */
export const historyEntryBelongsToRun = (entry: unknown, runId: string): boolean =>
    typeof entry === 'object' &&
    entry !== null &&
    (entry as { run?: unknown }).run === runId;

/**
 * Whether this run has already judged the food, read from its own history.
 *
 * The queue consults this instead of trusting the cursor's index alone, and it
 * closes a gap the index cannot: the considered list is filtered by publication
 * status, and THIS PASS CHANGES THAT STATUS — a candidate it rejects drops out
 * of the list on the next attempt. The list, and therefore every position in it,
 * can move as a result of the pass's own writes, so an index saved against the
 * earlier list names a different food. The history predicate is immune to that,
 * because it is a fact about the row rather than a position in a list.
 */
export const runHasJudgedFood = (row: ValidationFoodRow, runId: string): boolean => {
    const history = row.catalog_validation_records?.history;
    return Array.isArray(history) && history.some((entry) => historyEntryBelongsToRun(entry, runId));
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

    // THE STAGE CLAIM. Validation MUTATES the catalog graph — it moves
    // publication_status and rewrites validation records — so it holds the
    // catalog-graph lock EXCLUSIVELY for as long as it runs, which no import,
    // generation, load or second validation can then take. The run claim inside
    // runValidation is a different and smaller promise (one run row, not one
    // writer); lib/checkpoint.ts's THE CLAIM and THE STAGE LOCK state the
    // difference. Refusing rather than waiting is the default: a second launch
    // exits naming the stage that holds the graph instead of queueing invisibly
    // behind it.
    const outcome = await withCatalogStageLock({ stage: 'validation', logger }, () =>
        runValidation({
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
        }),
    );

    logger.info('stage_completed', {
        stage: STAGE,
        runId: outcome.runId,
        // Says which of the three outcomes this was, because they are not
        // interchangeable: a pass that judged rows, a no-op on an
        // already-completed run (nothing was written — see THE COMPLETED-RUN
        // NO-OP), or a pass that left rows unjudged and is recorded as failed.
        alreadyCompleted: outcome.alreadyCompleted,
        unjudged: outcome.unjudged,
        counts: JSON.stringify(outcome.counts),
    });

    await prisma.$disconnect();

    // A pass that left rows unjudged closed its run as failed, so the exit code
    // has to agree with the record: the operator's next action is to re-run,
    // which retries that run.
    return outcome.unjudged > 0 ? 1 : 0;
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
