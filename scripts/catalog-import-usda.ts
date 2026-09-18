// Stage 1 of the catalog pipeline: the USDA FoodData Central import.
//
// WHAT THE STAGE DOES. It builds its whole work list first — the curated FDC
// ids in data/meal-planning/usda-manifest.v1.json, then the three dataset
// sweeps that document declares — fetches the records in batches of twenty
// through the rate-limited USDA client, normalises each one against the
// checks in src/services/catalog.logic.ts, and upserts it on `source_key` as a
// candidate or a quarantined row together with its aliases, its portions and
// its machine-readable validation record. It checkpoints its cursor into
// `catalog_import_runs` so an interruption resumes rather than restarts, and
// writes its counts to data/meal-planning/reports/latest/import-report.json
// (Agent Action Plan §0.7.1 Group 3).
//
// WHAT IT DELIBERATELY DOES NOT DO: publish. A record every check accepts is
// written as a `candidate`, because the duplicate-identity decision needs a
// view of the whole table that a batch-at-a-time import cannot have. That is
// `catalog:validate`'s job, and keeping the two apart is what makes this stage
// safe to re-run: every write is an upsert on a key derived from the vendor's
// own id, and `imported_at` is written once on insert and never on update.
//
// WHY THE WORK LIST IS BUILT BEFORE ANY DETAIL FETCH. The plan's batch
// membership is a pure function of the manifest and the dataset listings, so a
// rerun produces identical batches — which is also what makes an earlier run's
// `usda_api_cache` entries reusable, since a batch's cache key is derived from
// its sorted id set. It also means the run knows how much work it has before
// it spends a request on any of it, and that a resume into a changed plan can
// be refused rather than silently misaligned.
//
// EVERY DECISION HERE IS DATA-DRIVEN. Classification, food state, the brand
// screen, cost class, allergen and diet derivation, naming and portion
// resolution are all tables in the manifest, and the pure functions below take
// them as arguments. No decision in this file consults a model, the clock or a
// nutrition value, and the manifest's own `sweepClassificationRules.deterministic`
// note is the contract that describes it.
//
// The two guard imports below are load-bearing and ordered. Rule
// backend-architecture §10 requires the IPv4-first DNS ordering before any
// network module loads, and dbGuard classifies DATABASE_URL at module load —
// TypeScript's CommonJS emit hoists requires in source order, so these two
// running first is what puts both ahead of anything that could reach Prisma or
// the network.
import './lib/bootstrap';
import './lib/dbGuard';

import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { classifyDatabaseOrigin, DatabaseOriginError, originLogFields } from './lib/dbGuard';
import { createFatalLogger, createLogger, formatSafeError, isThrownInstanceOf, safeError, writeLineSync } from './lib/logger';
import type { LogFields, LogLevel, SafeErrorFields, ScriptLogger } from './lib/logger';
import {
    EXPECTED_USDA_MANIFEST_VERSION,
    ManifestError,
    USDA_MANIFEST_FILE,
    loadCoveragePlan,
    loadUsdaManifest,
    mergeStageReport,
    reportPath,
    withArtifactPublicationLockSync,
    writeJsonFile,
} from './lib/manifest';
import type {
    CatalogFoodState,
    CostClass,
    CoverageCategory,
    CoveragePlan,
    UsdaDefaultPortionSelector,
    UsdaManifest,
    UsdaManifestFood,
    UsdaSweepAllergenDietRules,
    UsdaSweepBrandExclusionRules,
    UsdaSweepClassificationRules,
    UsdaSweepCostClassRules,
    UsdaSweepFoodStateRules,
    UsdaSweepPortionPolicy,
} from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
// The complete-evidence predicate, shared with validation, release export and
// release loading. This stage writes the retrieval records the other three
// judge, so it is the first place the rule can be applied — and applying the
// same function here is what keeps "publishable evidence" one definition
// instead of four that agree until one of them is edited.
import { assessIdentityEvidence, evidenceGapCodes } from './lib/catalogEvidence';
import type { EvidenceAssessment, EvidenceGapCode } from './lib/catalogEvidence';
// The payload-digest mechanics both writers of `catalog_foods` must take the
// same way. They live in `lib/` rather than here so that
// `catalog-generate-ai.ts` can share them without importing this CLI — see the
// note at the top of that module. The catalog DERIVATIONS the two stages must
// also agree on (the stored alias list, `search_text`, the version counters)
// are domain rules and come from `catalog.logic.ts` below.
import { canonicalJsonString, sha256Hex } from './lib/catalogFoodFacts';
import {
    RateLimitConfigError,
    USDA_IMPORT_POLICY_CAP_PER_HOUR,
    createUsdaRateLimiter,
    getUsdaImportRateLimitPerHour,
} from './lib/rateLimiter';
import type { UsdaRateLimiter, UsdaRequestStats } from './lib/rateLimiter';
import { CheckpointError, appendRunLog, checkpointErrorFields, finishRun, openOrResumeRun, saveCheckpoint, withCatalogStageLock } from './lib/checkpoint';
import type { CatalogRunDb } from './lib/checkpoint';

// The normaliser and the checks. Pure, so importing it costs nothing and opens
// no connection — which is why it is a top-level import where the USDA client
// and the Prisma client, both of which construct state at module load, are
// reached lazily from main().
import {
    CATALOG_CHECK_NAMES,
    buildSearchText,
    buildSourceKey,
    catalogCheckTier,
    computeCoverageShortfall,
    dedupeSortedAliases,
    nextCatalogFoodVersions,
    normalizeCanonicalName,
    validateCatalogCandidate,
} from '../src/services/catalog.logic';
import type {
    CatalogCheckName,
    CatalogFoodCandidate,
    CatalogFoodPortionCandidate,
    CatalogValidationPolicy,
    CatalogValidationVerdict,
    StoredVersionedFacts,
} from '../src/services/catalog.logic';
import type { CatalogIdentityStatus } from '../src/types/catalog';
// The one place the unit vocabulary lives. Asking it, rather than carrying a
// second list here, is what keeps a portion's unit in the family the grocery
// list will later display it in.
import { toBaseQuantity, unitFamily } from '../src/utils/units';
// Type-only: the value side of usda.service constructs a Prisma client for its
// response cache, so it is imported inside main() and these stay erased.
import type {
    UsdaBatchRetrievalFacts,
    UsdaFoodDetail,
    UsdaFoodNutrient,
    UsdaFoodPortion,
    UsdaFoodSummary,
} from '../src/services/usda.service';

const STAGE = 'catalog-import-usda';

const USDA_API_KEY_ENV = 'USDA_API_KEY';

// USDA documents 20 FDC ids as the maximum for one POST /foods call, and
// src/services/usda.service.ts exports the same number as MAX_BATCH_FDC_IDS and
// throws above it. Restated rather than imported because the value side of that
// module is loaded lazily from main(); the two are asserted equal there.
const MAX_BATCH_FDC_IDS = 20;

const CATALOG_LOGIC_MODULE = 'src/services/catalog.logic.ts';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// This stage's own error.
// ---------------------------------------------------------------------------

/** What the stage refused on, stable because an operator greps for it. */
export type CatalogImportErrorCode =
    /** A USDA request did not answer usably — the vendor boundary's failure, wrapped. */
    | 'usda_request_failed'
    /** `--manifest` named a version the loaded manifest does not declare. */
    | 'manifest_version_mismatch'
    /**
     * The manifest and the coverage plan disagree about a category, a food
     * group or a food group's category. Refused before the limiter and the
     * first request, which is what the manifest's own `coveragePlanContract`
     * requires: the disagreement is in the documents, so no amount of the
     * import running makes it resolvable, and half an import is worse to
     * recover from than none.
     */
    | 'manifest_coverage_mismatch'
    /**
     * A key in `sweepAllergenDietRules.byFoodGroup` or
     * `sweepCostClassRules.foodGroupOverrides` names a food group the coverage
     * plan does not declare, so no record can carry it and the allergen set or
     * cost class under it can never be applied.
     *
     * Its own code rather than a shade of `manifest_coverage_mismatch`, because
     * the remedy differs: nothing is mis-filed, so the fix is to re-key the
     * entry onto a food group the plan declares — or to drop it where the live
     * rules already cover its intent — rather than to correct a filing.
     */
    | 'manifest_inert_policy_keys'
    /**
     * A `foods` entry reached the planner without a verified FDC id.
     * `loadUsdaManifest` refuses that document outright (see
     * `assertUsdaManifestShape`), so this is reachable only from a caller that
     * built a manifest object itself. It is a throw rather than a skip because
     * a curated entry silently dropped is a reviewed decision that never
     * reaches the catalog.
     */
    | 'manifest_entry_unresolved';

/**
 * The stage's own failure, and the only shape callers of this file are asked
 * to recognise.
 *
 * WHY IT EXISTS RATHER THAN LETTING `UsdaError` OUT. Rule
 * backend-architecture §9 requires a vendor's failure to be wrapped in an
 * error of ours, so nothing upstream is left pattern-matching a shape
 * `src/services/usda.service.ts` owns and may change. It also carries what the
 * vendor error cannot: WHICH work item stopped — the batch index, the FDC ids
 * in it and the sweep it came from — which is the difference between an
 * operator re-running with `--resume` and an operator reading code.
 *
 * `underlying` holds the original, so nothing is lost by wrapping. It is named
 * that rather than `cause` because this package compiles to ES2016, whose
 * `Error` has neither the `{cause}` constructor option nor the property — a
 * field the runtime would ignore is worse than one it carries. It is never
 * logged raw either way: a raw error on this pipeline can carry a request URL
 * bearing the USDA key, which is why every log goes through `safeError`.
 */
export class CatalogImportError extends Error {
    constructor(
        public readonly code: CatalogImportErrorCode,
        message: string,
        public readonly context: {
            readonly batchIndex?: number;
            readonly fdcIds?: readonly number[];
            readonly fdcId?: number;
            readonly sweepKey?: string;
            readonly manifestVersion?: string;
        } = {},
        public readonly underlying?: unknown,
    ) {
        super(message);
        this.name = 'CatalogImportError';
    }
}

/**
 * What a failure from this stage is worth REPORTING, as typed fields rather
 * than as its rendered sentence.
 *
 * WHY THIS EXISTS. `safeError` carries a closed set of machine-readable members
 * and no `message`, because the field a message would occupy is the one place a
 * request URL bearing `api_key=` can reach an operator log or the
 * `catalog_import_runs.log` column. That leaves the class and the code, which
 * name WHAT refused but not WHICH work item stopped — and the class's own
 * docstring above names that as the reason the wrapping exists: the batch index
 * is what an operator re-runs with `--resume`, and the vendor's HTTP status is
 * what separates a key problem (`403`) from an outage (`503`) from pacing
 * (`429`).
 *
 * So those facts travel as the DATA they already are. Every value is either a
 * number this stage assigned, a manifest version from a reviewed document, a
 * sweep key from this file's own vocabulary, or a list of FDC ids — public USDA
 * identifiers, bounded by the batch size the vendor accepts. None of them is
 * derived from a vendor sentence, and the rendered message stays on the thrown
 * error, where an operator reads it at the terminal.
 *
 * `vendorStatus` is read through `safeError` rather than off `underlying`
 * directly, so it is subject to the same integer-and-range check as every other
 * status this repository logs.
 */
export const importErrorFields = (error: CatalogImportError): LogFields => {
    const vendorStatus = error.underlying === undefined ? undefined : safeError(error.underlying).status;

    return {
        ...(error.context.batchIndex === undefined ? {} : { batchIndex: error.context.batchIndex }),
        ...(error.context.sweepKey === undefined ? {} : { sweepKey: error.context.sweepKey }),
        ...(error.context.manifestVersion === undefined ? {} : { manifestVersion: error.context.manifestVersion }),
        ...(error.context.fdcId === undefined ? {} : { fdcId: error.context.fdcId }),
        ...(error.context.fdcIds === undefined ? {} : { fdcIds: [...error.context.fdcIds] }),
        ...(vendorStatus === undefined ? {} : { vendorStatus }),
    };
};

/**
 * The one error class this stage observes that it cannot name by `instanceof`.
 *
 * `UsdaError` is the vendor boundary's own error, and every batch and
 * enumeration failure arrives as one: a definitive `401`/`403`/`404`, which the
 * boundary reports after a single attempt instead of four, and a request that
 * passed its deadline. Narrowing on the class would mean importing
 * `src/services/usda.service.ts` at module load, which constructs a Prisma
 * client — the very thing `main()` defers with a dynamic import so that this
 * file's pure exports stay importable without a database. The name is set in
 * the class's constructor and pinned by `usda.service.test.ts`, so it is the
 * stable handle available here.
 */
const isUsdaError = (error: unknown): boolean => isThrownInstanceOf(error, Error) && error.name === 'UsdaError';

/**
 * Wraps whatever the vendor boundary threw as this stage's own failure, so
 * nothing upstream is left reading a shape `usda.service.ts` owns (§9).
 *
 * Anything that is NOT a vendor failure is returned untouched: a defect in this
 * file must never be reported as USDA's answer.
 */
const asImportFailure = (error: unknown, context: CatalogImportError['context']): unknown => {
    if (!isUsdaError(error)) {
        return error;
    }
    const where =
        context.batchIndex === undefined
            ? `sweep ${context.sweepKey ?? 'unknown'}`
            : `batch ${context.batchIndex}`;
    return new CatalogImportError(
        'usda_request_failed',
        // The vendor's own sentence is withheld: usda.service.ts builds every
        // request URL with `api_key=` in its query string and quotes the
        // failure back, so the text is the one place the key can appear. The
        // class and the HTTP status are what diagnose it.
        `USDA did not answer usably for ${where} (${formatSafeError(error)})`,
        context,
        error,
    );
};

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
    /**
     * `--manifest`; `null` means the operator stated no expectation, which is
     * not the same as stating the version the checkout happens to ship.
     *
     * It ASSERTS rather than selects, and deliberately so: `loadUsdaManifest`
     * resolves one path (`data/meal-planning/usda-manifest.v1.json`) and
     * version-checks it against `EXPECTED_USDA_MANIFEST_VERSION`, so there is
     * no second curation for a flag to choose between and inventing a path
     * template here would let an unreviewed document into the catalog. What an
     * operator needs from the flag is the other half — writing down which
     * curation they believe they are importing, and being refused before the
     * first request when the checkout disagrees. Same shape as dbGuard's
     * `--confirm-target`: state the target, or accept the one you are given.
     */
    readonly manifestVersion: string | null;
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
// to satisfy the `development_or_confirmed` policy of `catalog-load` and
// `recipes-seed`. This stage is `development_or_test` and has no such door, so
// the flag unlocks nothing here. It is accepted and skipped (value included, so
// it is not mistaken for a positional argument) rather than rejected, because
// an operator who passes it to any stage should get that stage's usage, not a
// parse error about a flag the pipeline does define.
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
        return {
            ok: true,
            options: {
                help: true,
                categories: [],
                limit: null,
                resume: false,
                dryRun: false,
                manifestVersion: null,
            },
        };
    }

    const errors: ArgumentError[] = [];
    const categories: string[] = [];
    let limit: number | null = null;
    let limitSeen = false;
    let resume = false;
    let dryRun = false;
    let manifestVersion: string | null = null;
    let manifestSeen = false;

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

        if (flag === '--manifest') {
            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a manifest version, such as ${EXPECTED_USDA_MANIFEST_VERSION}` });
                continue;
            }
            if (manifestSeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            manifestSeen = true;
            manifestVersion = value;
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

    return { ok: true, options: { help: false, categories, limit, resume, dryRun, manifestVersion } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:import -- [options]   (${STAGE})`,
        '',
        'Imports USDA FoodData Central records into the catalog as candidates.',
        '',
        'Checks every input first and exits 1 naming the unsatisfied prerequisites',
        'and their remedies rather than starting a partial run. Then plans the whole',
        'work list (the curated manifest entries, then the three dataset sweeps),',
        'fetches it in batches of 20 under the configured hourly rate limit, and',
        'upserts each record on its source key together with its aliases, its',
        'portions and its validation record, checkpointing as it goes.',
        '',
        'This stage publishes nothing: a record whose checks pass is written as a',
        'candidate. catalog:validate is the stage that decides publication from',
        'this database, and catalog:load also writes published rows - it applies',
        'a reviewed release and restores the publication statuses it carries.',
        '',
        'Re-running is safe. Every write is an upsert keyed on the vendor id and',
        'the batch plan is a pure function of the manifest, so an interrupted run',
        'converges on the same catalog when it resumes. A run that already',
        'SUCCEEDED for this manifest version is recognised and does no work at',
        'all, which is what makes a repeat import incapable of creating',
        'duplicates. Re-deriving an existing catalog - after changing how a field',
        'is computed, say - therefore needs a new manifest version or an empty',
        'catalog, not a second identical run.',
        '',
        'Options:',
        '  --category <name>   Restrict the import to one coverage-plan category.',
        '                      Repeatable. Default: every category in the coverage plan.',
        '  --limit <n>         Stop after n manifest records. Positive integer.',
        '                      Default: no limit.',
        '  --resume            Continue this stage\'s newest unfinished run from its',
        '                      stored cursor. Required to continue one: without it an',
        '                      unfinished run for this manifest version is refused and',
        '                      nothing is written, because a second run alongside it',
        '                      cannot be opened. A run that already succeeded is',
        '                      recognised and does no work either way.',
        '                      Default: off (refuse rather than continue).',
        '  --dry-run           Report what the import would write without writing it.',
        '                      Default: off.',
        `  --manifest <ver>    Refuse unless the manifest declares this version (${EXPECTED_USDA_MANIFEST_VERSION}).`,
        '                      Checked before the first request, so a checkout carrying a',
        '                      different curation costs nothing to discover.',
        '                      Default: import whichever version the checkout ships.',
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
        if (isThrownInstanceOf(error, ManifestError)) {
            // Closed code only, never the sentence: a ManifestError message can carry
            // an absolute checkout path (manifest.ts `repo_root_not_found`) or a foreign
            // JSON parser message (`invalid_merged_report`), and `requirement` and
            // `remedy` beside it already carry everything an operator acts on.
            return { code, requirement, remedy, detail: error.code };
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
        if (isThrownInstanceOf(error, RateLimitConfigError)) {
            gaps.push({
                code: 'usda_rate_limit_misconfigured',
                requirement:
                    `USDA_IMPORT_RATE_LIMIT_PER_HOUR must resolve to an integer within the import ceiling of ` +
                    `${USDA_IMPORT_POLICY_CAP_PER_HOUR} requests/hour so every fetch is paced and the running API keeps its ` +
                    'share of the same key',
                // The ceiling, not the vendor cap: 901-1,000 is legal for USDA
                // and illegal for this import, because the top 100 per hour are
                // the live API's share of the key (AAP §0.7.1 Group 1). Naming
                // 1,000 here is what sent an operator to a value the limiter
                // refuses.
                remedy:
                    `Set USDA_IMPORT_RATE_LIMIT_PER_HOUR to an integer between 1 and ` +
                    `${USDA_IMPORT_POLICY_CAP_PER_HOUR}, or unset it to take that ceiling as the default. Nothing can ` +
                    'raise it; a lower value only paces the import more gently.',
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
// Classification, naming and derivation — pure functions over the manifest.
//
// Every one of these takes its policy as an argument rather than reading the
// manifest itself, so the import's decisions are testable without a document
// on disk, and so a reviewer can see that no decision here consults nutrition
// values, the clock or the network. The manifest's own
// `sweepClassificationRules.deterministic` note is the contract they implement.
// ---------------------------------------------------------------------------

/** The classification a description resolves to, and whether it is in scope. */
export interface SweepClassification {
    readonly category: CoverageCategory;
    readonly foodGroup: string;
    /** True when a rule matched; false means the fallback supplied the values. */
    readonly matched: boolean;
    /** True when the matching rule marks the description out of scope. */
    readonly excluded: boolean;
}

const matchesRule = (
    lowerDescription: string,
    rule: { descriptionStartsWith?: readonly string[]; descriptionContains?: readonly string[] },
): boolean => {
    const startsWith = rule.descriptionStartsWith ?? [];
    for (const needle of startsWith) {
        if (lowerDescription.startsWith(needle)) {
            return true;
        }
    }
    const contains = rule.descriptionContains ?? [];
    for (const needle of contains) {
        if (lowerDescription.indexOf(needle) >= 0) {
            return true;
        }
    }
    return false;
};

/**
 * First match wins, which is why the rule array's order is policy rather than
 * presentation: composite-dish rules precede ingredient rules so an as-eaten
 * description is not classified as its first ingredient.
 */
export const classifyDescription = (
    description: string,
    rules: UsdaSweepClassificationRules,
): SweepClassification => {
    const lower = description.trim().toLowerCase();

    for (const rule of rules.rules) {
        if (matchesRule(lower, rule)) {
            return {
                category: rule.category,
                foodGroup: rule.foodGroup,
                matched: true,
                excluded: rule.excludeFromPublication === true,
            };
        }
    }

    return {
        category: rules.fallback.category,
        foodGroup: rules.fallback.foodGroup,
        matched: false,
        excluded: false,
    };
};

/**
 * The state is read from the description and, failing that, from the dataset —
 * never from nutrition. Raw, dry and cooked forms stay separate rows because
 * their energy per 100 g differs and grocery aggregation must not merge them.
 */
export const resolveFoodState = (
    description: string,
    dataType: string,
    rules: UsdaSweepFoodStateRules,
): CatalogFoodState => {
    const lower = description.trim().toLowerCase();

    for (const rule of rules.rules) {
        if (matchesRule(lower, rule)) {
            return rule.foodState;
        }
    }

    for (const fallback of rules.datasetFallback) {
        if (fallback.dataType === dataType) {
            return fallback.foodState;
        }
    }

    return 'as_purchased';
};

const LETTERS_ONLY_PATTERN = /[^A-Za-z]/g;

/**
 * The sweeps' brand screen. USDA writes manufacturer names in upper case in
 * its own descriptions, so an unexplained all-caps token is the most reliable
 * brand signal in this corpus; the allowlist carries the abbreviations USDA
 * also capitalises (NFS, RTD, DHA) so they are not mistaken for brands.
 *
 * Returns the signal that fired, so the report can say why a record was
 * skipped rather than only that it was.
 */
export const brandExclusionReason = (
    description: string,
    rules: UsdaSweepBrandExclusionRules,
): string | null => {
    for (const symbol of rules.signals.trademarkSymbols) {
        if (description.indexOf(symbol) >= 0) {
            return `trademark_symbol:${symbol}`;
        }
    }

    const lower = description.toLowerCase();
    for (const word of rules.signals.brandWordContains) {
        if (lower.indexOf(word) >= 0) {
            return `brand_word:${word}`;
        }
    }

    const { minimumLetters, allowedAllCaps } = rules.signals.allCapsRun;
    const allowed = new Set(allowedAllCaps.map((token) => token.toUpperCase()));
    for (const rawToken of description.split(/[\s,./()]+/)) {
        const letters = rawToken.replace(LETTERS_ONLY_PATTERN, '');
        if (letters.length < minimumLetters) {
            continue;
        }
        if (letters === letters.toUpperCase() && !allowed.has(letters)) {
            return `all_caps:${letters}`;
        }
    }

    return null;
};

const PLURAL_EXCEPTIONS: Readonly<Record<string, string>> = {
    leaf: 'leaves',
    loaf: 'loaves',
    half: 'halves',
    potato: 'potatoes',
    tomato: 'tomatoes',
    mango: 'mangoes',
    goose: 'geese',
};

/** English pluralisation, enough for a head noun taken from a description. */
export const pluralizeHeadNoun = (noun: string): string | null => {
    const word = noun.trim().toLowerCase();
    if (word.length === 0 || word.indexOf(' ') >= 0) {
        return null;
    }
    const exception = PLURAL_EXCEPTIONS[word];
    if (exception !== undefined) {
        return exception;
    }
    if (word.endsWith('s') || word.endsWith('x') || word.endsWith('z')) {
        return null;
    }
    if (word.endsWith('y') && word.length > 1 && 'aeiou'.indexOf(word.charAt(word.length - 2)) < 0) {
        return `${word.slice(0, -1)}ies`;
    }
    if (word.endsWith('ch') || word.endsWith('sh')) {
        return `${word}es`;
    }
    return `${word}s`;
};

const STATE_WORDS: readonly string[] = [
    'raw',
    'cooked',
    'boiled',
    'roasted',
    'baked',
    'grilled',
    'broiled',
    'steamed',
    'braised',
    'fried',
    'toasted',
    'dried',
    'dehydrated',
    'uncooked',
    'unprepared',
    'canned',
    'frozen',
    'dry',
];

/**
 * A swept record's aliases come from its own description and nothing else — the
 * manifest's `sweepAliasPolicy`: the leading qualifier reordered in front of
 * the head noun ("Rice, brown, long-grain, raw" gives "brown rice"), plus the
 * head noun's plural. No synonym is invented, because an alias is a claim that
 * two names denote the same food and a wrong claim steals rank from the food
 * the user actually meant.
 */
export const deriveSweepAliases = (description: string, canonicalName: string): string[] => {
    const segments = description
        .toLowerCase()
        .split(',')
        .map((segment) => segment.trim())
        .filter((segment) => segment.length > 0);

    if (segments.length === 0) {
        return [];
    }

    const head = segments[0];
    const aliases: string[] = [];

    for (const qualifier of segments.slice(1)) {
        if (STATE_WORDS.indexOf(qualifier) >= 0 || qualifier.indexOf(' ') >= 0) {
            continue;
        }
        aliases.push(`${qualifier} ${head}`);
        break;
    }

    const headWords = head.split(/\s+/);
    const lastWord = headWords[headWords.length - 1];
    const plural = pluralizeHeadNoun(lastWord);
    if (plural !== null) {
        aliases.push(headWords.length === 1 ? plural : `${headWords.slice(0, -1).join(' ')} ${plural}`);
    }

    const normalizedCanonical = normalizeCanonicalName(canonicalName);
    const seen = new Set<string>();
    const kept: string[] = [];
    for (const alias of aliases) {
        const trimmed = alias.trim().toLowerCase();
        if (trimmed.length === 0 || seen.has(trimmed) || normalizeCanonicalName(trimmed) === normalizedCanonical) {
            continue;
        }
        seen.add(trimmed);
        kept.push(trimmed);
    }
    return kept;
};

/** `1` when the category has no row, so a missing policy is visible, not silent. */
export const resolveCostClass = (
    category: string,
    foodGroup: string,
    rules: UsdaSweepCostClassRules,
): CostClass => rules.foodGroupOverrides[foodGroup] ?? rules.byCategory[category] ?? 2;

/** What the allergen and diet derivation concluded, and why review still applies. */
export interface DerivedSafetyTags {
    readonly allergenTags: string[];
    readonly dietTags: string[];
    /** Names the composite markers found, for the validation record's assumptions. */
    readonly compositeMarkers: string[];
}

/**
 * Derives allergen and diet tags from the food group and the description. The
 * derivation only ever narrows — it adds an allergen and removes a diet tag,
 * never the reverse — and it never sets `allergen_status` to `known`:
 * inference is not review, and `allergen_status` is the column the planner
 * reads before putting a food in front of someone with an allergy.
 */
export const deriveSafetyTags = (
    description: string,
    category: string,
    foodGroup: string,
    rules: UsdaSweepAllergenDietRules,
): DerivedSafetyTags => {
    const lower = description.toLowerCase();

    const allergens = new Set<string>(rules.byFoodGroup[foodGroup] ?? []);
    for (const allergen of rules.allergenVocabulary) {
        const markers = rules.descriptionAllergenMarkers[allergen] ?? [];
        for (const marker of markers) {
            if (lower.indexOf(marker) >= 0) {
                allergens.add(allergen);
                break;
            }
        }
    }

    const derivation = rules.dietDerivation;
    const hasMarker = (markers: readonly string[]): boolean => {
        for (const marker of markers) {
            if (lower.indexOf(marker) >= 0) {
                return true;
            }
        }
        return false;
    };

    const dietTags = new Set<string>(rules.dietTagVocabulary);

    const animalCategory = derivation.animalCategories.indexOf(category) >= 0 && category !== 'protein_seafood';
    if (animalCategory || hasMarker(derivation.animalMarkers)) {
        dietTags.delete('vegan');
        dietTags.delete('vegetarian');
        // Meat and poultry are not pescatarian either, so the third tag goes
        // too. Spelled 'pescatarian' to match dietTagVocabulary in
        // usda-manifest.v1.json and the only spelling
        // recipe.logic.ts::isDietCompatible matches: were this literal to drift
        // from the vocabulary the delete would silently miss, and every meat
        // food would be published as pescatarian-admissible.
        dietTags.delete('pescatarian');
    } else if (category === 'protein_seafood' || hasMarker(derivation.seafoodMarkers)) {
        dietTags.delete('vegan');
        dietTags.delete('vegetarian');
    } else if (hasMarker(derivation.dairyEggMarkers)) {
        dietTags.delete('vegan');
    }

    if (allergens.has('wheat')) {
        dietTags.delete('gluten_free');
    }

    const compositeMarkers: string[] = [];
    for (const marker of rules.compositeMarkers.markers) {
        if (lower.indexOf(marker) >= 0) {
            compositeMarkers.push(marker.trim());
        }
    }

    const allergenOrder = rules.allergenVocabulary;
    const dietOrder = rules.dietTagVocabulary;

    return {
        allergenTags: allergenOrder.filter((tag) => allergens.has(tag)),
        dietTags: dietOrder.filter((tag) => dietTags.has(tag)),
        compositeMarkers,
    };
};

const ISO_MONTH_PATTERN = /^(\d{4})-(\d{2})/;
const US_DATE_PATTERN = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/;

/**
 * `"<dataType> YYYY-MM"`, reproducing the reviewed rows' `"SR Legacy 2019-04"`.
 * USDA states `publicationDate` as `M/D/YYYY` on a detail record and as ISO on
 * a list record, so both forms are parsed rather than one being assumed.
 */
export const buildSourceVersion = (dataType: string, publicationDate: string | undefined): string => {
    const raw = (publicationDate ?? '').trim();

    const iso = ISO_MONTH_PATTERN.exec(raw);
    if (iso !== null) {
        return `${dataType} ${iso[1]}-${iso[2]}`;
    }

    const us = US_DATE_PATTERN.exec(raw);
    if (us !== null) {
        return `${dataType} ${us[3]}-${us[1].padStart(2, '0')}`;
    }

    return dataType;
};

/**
 * Reads one nutrient from a USDA record, tolerating every shape the API uses:
 * a detail record nests the descriptor (`nutrient.number` with `amount`) while
 * list and search results flatten it (`nutrientNumber` with `value`). A
 * missing nutrient is `null` — "unknown", never coerced to zero, because zero
 * is a claim about the food and `null` is the absence of one.
 */
export const readNutrientAmount = (
    nutrients: readonly UsdaFoodNutrient[] | undefined,
    nutrientNumber: string,
): number | null => {
    for (const entry of nutrients ?? []) {
        const nested = entry.nutrient?.number;
        const candidateNumber = nested ?? entry.nutrientNumber ?? (entry as { number?: string | number }).number;
        if (candidateNumber === undefined || String(candidateNumber) !== nutrientNumber) {
            continue;
        }
        const amount = entry.amount ?? entry.value;
        if (typeof amount === 'number' && Number.isFinite(amount)) {
            return amount;
        }
    }
    return null;
};

/** Total dietary fibre. Not one of the four core nutrients, so absence is fine. */
const FIBER_NUTRIENT_NUMBER = '291';

const QUANTITY_NOT_SPECIFIED = 'quantity not specified';
const LEADING_AMOUNT_PATTERN = /^\s*(\d+(?:\.\d+)?)\s*(?:\/\s*(\d+(?:\.\d+)?)\s*)?/;
const UNIT_TOKEN_PATTERN = /[a-z]+/g;

/**
 * A parenthetical in a USDA portion label is a yield or weight note, never the
 * measure: "roast (yield from 714 g raw meat)" is one roast, not one gram.
 */
const PARENTHETICAL_PATTERN = /\([^)]*\)/g;

/** A leading amount has already been read into `amount`; it is not the unit. */
const LEADING_QUANTITY_PATTERN = /^\s*\d+(?:\.\d+)?(?:\s*\/\s*\d+(?:\.\d+)?)?\s*/;

/** Two-word units ("fl oz", "fluid ounce") need the first two tokens as a phrase. */
const UNIT_PHRASE_TOKENS = 2;

/**
 * How far a mass measure's stated weight may drift from the source's own gram
 * weight before the label is judged not to be describing this portion.
 *
 * The only drift this has to absorb is USDA's own rounding: gram weights are
 * recorded as integers, so "1 oz" is stored as 28 or 29 rather than 28.35 and
 * "0.5 oz" as 15 rather than 14.17. That error is bounded in GRAMS, not in
 * percent — which is why the tolerance is an absolute floor with a relative
 * term for large weights, rather than a percentage that would reject a
 * correctly rounded half-ounce.
 */
const MASS_IDENTITY_TOLERANCE_G = 1;
const MASS_IDENTITY_TOLERANCE_RATIO = 0.02;

/** A household measure read off one `foodPortions` entry. */
export interface ParsedPortionLabel {
    readonly description: string;
    readonly amount: number;
    readonly unit: string;
}

/**
 * Turns a USDA portion into the household measure a grocery list can display.
 *
 * THE RULE THIS FILE EXISTS TO ENFORCE. `amount` and `unit` describe the
 * measure the source states; `gram_weight` is the weight, and it is a separate
 * column. Substituting the weight into the measure — storing "1 cup, halves"
 * as `amount: 152, unit: "g"` — destroys the unit family the grocery display
 * depends on and contradicts the row's own description, which is the defect
 * this importer is written to avoid.
 *
 * A unit token `src/utils/units.ts` recognises is kept as that unit. A
 * household noun it does not recognise (apple, patty, fillet, sprig) becomes
 * the count unit `each`, which is what `formatCount` and `pluralizeCount`
 * consume, and the noun stays in the description, where the user reads it.
 */
/**
 * Whether a reviewed selector is describing this source label.
 *
 * The same exact-then-containment rule {@link matchSelectorPortion} pairs them
 * by, applied to the label text alone so the two cannot disagree about what
 * counts as a match. A selector that names no measure at all describes any
 * label, which is the documented "no measure named" fallback.
 */
export const selectorDescribesLabel = (selector: UsdaDefaultPortionSelector, label: string): boolean => {
    const wanted = (selector.modifier ?? selector.portionDescription ?? selector.description ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    if (wanted.length === 0) {
        return true;
    }
    const normalized = label.trim().toLowerCase().replace(/\s+/g, ' ');
    return normalized === wanted || normalized.indexOf(wanted) >= 0 || wanted.indexOf(normalized) >= 0;
};

export const parsePortionLabel = (
    portion: UsdaFoodPortion,
    dataType: string,
    selector?: UsdaDefaultPortionSelector,
): ParsedPortionLabel | null => {
    const labelSource =
        dataType === 'Survey (FNDDS)'
            ? (portion.portionDescription ?? '')
            : dataType === 'Foundation'
              ? [portion.measureUnit?.name, portion.portionDescription]
                    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
                    .join(', ')
              : (portion.modifier ?? '');

    const label = labelSource.trim();
    if (label.length === 0 || label.toLowerCase().indexOf(QUANTITY_NOT_SPECIFIED) >= 0) {
        return null;
    }

    // FNDDS embeds the amount at the start of the label and keeps a numeric
    // measure code in `modifier`; the reference datasets carry the amount in
    // their own `amount` field. Parsing the leading number off the FNDDS label
    // is therefore reading the amount, not guessing it.
    let amount = typeof portion.amount === 'number' && portion.amount > 0 ? portion.amount : null;
    let description = label;

    if (dataType === 'Survey (FNDDS)') {
        const leading = LEADING_AMOUNT_PATTERN.exec(label);
        if (leading !== null && leading[0].trim().length > 0) {
            const numerator = Number(leading[1]);
            const denominator = leading[2] === undefined ? null : Number(leading[2]);
            const parsed = denominator !== null && denominator > 0 ? numerator / denominator : numerator;
            if (Number.isFinite(parsed) && parsed > 0) {
                amount = parsed;
                description = label.slice(leading[0].length).trim();
            }
        }
    }

    if (amount === null || !Number.isFinite(amount) || amount <= 0) {
        return null;
    }
    if (description.length === 0) {
        description = label;
    }

    // The selector's own description is the reviewed wording and wins when one
    // was supplied — but only over the portion the selector actually describes.
    // `matchSelectorPortion` is what pairs the two, and it answers null when
    // nothing matches; this second check makes the guarantee local rather than
    // a property of the caller, so handing this function an unrelated portion
    // and a selector cannot mint "1 cup / 30 g" out of a source "1 slice /
    // 30 g". A selector that does not describe this label is ignored and the
    // source's own measure is derived below.
    if (selector !== undefined && selectorDescribesLabel(selector, label)) {
        return {
            description: selector.description,
            amount: typeof selector.amount === 'number' && selector.amount > 0 ? selector.amount : amount,
            unit: resolvePortionUnit(selector.unit, selector.description),
        };
    }

    // The curated branch above returns the unit a human approved, verbatim. A
    // unit derived here is confirmed against the source's own gram weight
    // before it is trusted, so a label whose head noun happens to collide with
    // a mass token cannot write a portion that contradicts its own weight.
    const derived = resolvePortionUnit(undefined, description);
    const reconciled = reconcileMassUnit(amount, derived, portion.gramWeight);
    if (reconciled === null) {
        return null;
    }

    return { description, amount, unit: reconciled };
};

/**
 * A unit token `units.ts` recognises, or `each`. `units.ts` is the one place
 * the unit vocabulary lives, so this asks it rather than carrying a second
 * list that could drift from the one grocery display actually uses.
 */
export const resolvePortionUnit = (declaredUnit: string | undefined, description: string): string => {
    const declared = (declaredUnit ?? '').trim().toLowerCase();
    if (declared.length > 0 && unitFamily(declared) !== null) {
        return declared;
    }

    // The measure is the HEAD of the label — what precedes the first comma
    // qualifier, with any parenthetical note and any already-read leading
    // amount removed. Scanning the whole label instead reads the "g" out of
    // "roast (yield from 714 g raw meat)" and stores a 591 g roast as one
    // gram: a row that contradicts its own description and drags the grocery
    // row into the mass family. The qualifiers a label carries after its head
    // ("cup, sifted", "steak, excluding refuse") describe the food, not the
    // measure, so they are never a source of units either.
    const head = description
        .toLowerCase()
        .replace(PARENTHETICAL_PATTERN, ' ')
        .split(',')[0]
        .replace(LEADING_QUANTITY_PATTERN, '')
        .trim()
        .replace(/\s+/g, ' ');

    if (head.length > 0 && unitFamily(head) !== null) {
        return head;
    }

    const tokens: string[] = head.match(UNIT_TOKEN_PATTERN) ?? [];
    const phrase = tokens.slice(0, UNIT_PHRASE_TOKENS).join(' ');
    if (phrase.length > 0 && unitFamily(phrase) !== null) {
        return phrase;
    }

    const leading = tokens.length > 0 ? tokens[0] : '';
    if (leading.length > 0 && unitFamily(leading) !== null) {
        return leading;
    }

    // Every remaining household measure is a count of something the
    // description names — "1 apple, medium", "1 patty", "roast (yield from
    // 714 g raw meat)" — so it belongs to the count family, and the noun
    // stays in the description where the user reads it.
    return 'each';
};

/**
 * Confirms a resolved mass unit against the source's own gram weight, and
 * rejects the portion outright when the two cannot both be true.
 *
 * A mass measure's weight IS its amount: "3 oz" weighs 3 oz and "45 g" weighs
 * 45 g. So when a mass unit disagrees with the gram weight the source states
 * for the same portion, the label is not measuring this food in this state.
 * USDA's yield portions are the case that matters: "1 oz, raw (yield after
 * cooking)" carries `gramWeight: 9`, because an ounce of the RAW food yields
 * 9 g cooked. For the cooked food the row is neither an ounce (1 oz is not
 * 9 g) nor a count of anything, so it is not a household measure at all, and
 * `null` drops it. The food keeps its 100 g basis portion, which is the
 * source's own statement and needs no household measure to be true.
 *
 * Dropping is the only honest outcome: naming it `each` would assert a count
 * the label never made, and keeping `oz` would assert a weight the source
 * contradicts. Volume carries no comparable identity — a cup of flour is
 * 120 g and a cup of water 237 g — so only mass can be checked this way, and
 * only mass is.
 */
export const reconcileMassUnit = (
    amount: number,
    unit: string,
    gramWeight: number | null | undefined,
): string | null => {
    if (unitFamily(unit) !== 'mass' || typeof gramWeight !== 'number' || gramWeight <= 0) {
        return unit;
    }

    const statedGrams = toBaseQuantity(amount, unit).amount;
    const tolerance = Math.max(MASS_IDENTITY_TOLERANCE_G, gramWeight * MASS_IDENTITY_TOLERANCE_RATIO);

    return Math.abs(statedGrams - gramWeight) <= tolerance ? unit : null;
};

/**
 * Resolves the portions of one record, household measures first and the
 * source's own 100 g basis always.
 *
 * The basis row is not an invented weight: a per-100 g record states its
 * nutrition for 100 g, so a 100 g portion is that statement restated. It is
 * what lets a Foundation record carrying no `foodPortions` publish without
 * anyone fabricating a household measure, and a household portion always wins
 * the default when the record states one.
 */
export const resolvePortions = (
    detail: UsdaFoodDetail,
    dataType: string,
    policy: UsdaSweepPortionPolicy,
    selector?: UsdaDefaultPortionSelector,
): CatalogFoodPortionCandidate[] => {
    const sourcePortions = (detail.foodPortions ?? [])
        .map((portion, index) => ({ portion, index }))
        .filter(({ portion }) => typeof portion.gramWeight === 'number' && portion.gramWeight > 0)
        .sort((left, right) => {
            const sequence =
                Number(left.portion.sequenceNumber ?? Number.MAX_SAFE_INTEGER) -
                Number(right.portion.sequenceNumber ?? Number.MAX_SAFE_INTEGER);
            if (Number.isFinite(sequence) && sequence !== 0) {
                return sequence;
            }
            const byWeight = Number(left.portion.gramWeight) - Number(right.portion.gramWeight);
            return byWeight !== 0 ? byWeight : left.index - right.index;
        });

    const household: CatalogFoodPortionCandidate[] = [];
    const seenDescriptions = new Set<string>();

    if (selector !== undefined) {
        const matched = matchSelectorPortion(sourcePortions.map(({ portion }) => portion), dataType, selector);
        if (matched !== null) {
            const label = parsePortionLabel(matched, dataType, selector);
            if (label !== null) {
                seenDescriptions.add(label.description.toLowerCase());
                household.push({
                    description: label.description,
                    amount: label.amount,
                    unit: label.unit,
                    gram_weight: Number(matched.gramWeight),
                    is_default: true,
                    source: 'usda_food_portion',
                });
            }
        }
    }

    if (household.length === 0) {
        for (const { portion } of sourcePortions) {
            if (household.length >= MAX_HOUSEHOLD_PORTIONS) {
                break;
            }
            const label = parsePortionLabel(portion, dataType);
            if (label === null) {
                continue;
            }
            const key = label.description.toLowerCase();
            if (seenDescriptions.has(key)) {
                continue;
            }
            seenDescriptions.add(key);
            household.push({
                description: label.description,
                amount: label.amount,
                unit: label.unit,
                gram_weight: Number(portion.gramWeight),
                is_default: household.length === 0,
                source: 'usda_food_portion',
            });
        }
    }

    const basis = policy.basisPortion;
    if (!seenDescriptions.has(basis.description.toLowerCase())) {
        household.push({
            description: basis.description,
            amount: basis.amount,
            unit: basis.unit,
            gram_weight: basis.gramWeight,
            is_default: household.length === 0,
            source: basis.source,
        });
    }

    return household;
};

/** At most three household measures: enough to display, short of a catalogue. */
const MAX_HOUSEHOLD_PORTIONS = 3;

/**
 * The manifest's `portionResolution.matching` rule: amount must equal the
 * selector's, label equality is preferred over containment, and the lowest
 * gram weight breaks a remaining tie so resolution is deterministic.
 */
export const matchSelectorPortion = (
    portions: readonly UsdaFoodPortion[],
    dataType: string,
    selector: UsdaDefaultPortionSelector,
): UsdaFoodPortion | null => {
    const wanted = (selector.modifier ?? selector.portionDescription ?? selector.description ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' ');
    const wantedAmount = typeof selector.amount === 'number' ? selector.amount : null;

    const eligible = portions.filter((portion) => {
        if (typeof portion.gramWeight !== 'number' || portion.gramWeight <= 0) {
            return false;
        }
        if (wantedAmount === null) {
            return true;
        }
        // FNDDS keeps the amount inside the label, so its own `amount` field is
        // not comparable and the label carries the check instead.
        if (dataType === 'Survey (FNDDS)') {
            return true;
        }
        return typeof portion.amount === 'number' && Math.abs(portion.amount - wantedAmount) < 1e-9;
    });

    const labelOf = (portion: UsdaFoodPortion): string =>
        (dataType === 'Survey (FNDDS)'
            ? (portion.portionDescription ?? '')
            : dataType === 'Foundation'
              ? [portion.measureUnit?.name, portion.portionDescription]
                    .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
                    .join(', ')
              : (portion.modifier ?? '')
        )
            .trim()
            .toLowerCase()
            .replace(/\s+/g, ' ');

    const byWeight = (left: UsdaFoodPortion, right: UsdaFoodPortion): number =>
        Number(left.gramWeight) - Number(right.gramWeight);

    const exact = eligible.filter((portion) => labelOf(portion) === wanted).sort(byWeight);
    if (exact.length > 0) {
        return exact[0];
    }

    if (wanted.length > 0) {
        const contained = eligible.filter((portion) => labelOf(portion).indexOf(wanted) >= 0).sort(byWeight);
        if (contained.length > 0) {
            return contained[0];
        }
        const containing = eligible.filter((portion) => wanted.indexOf(labelOf(portion)) >= 0 && labelOf(portion).length > 0).sort(byWeight);
        if (containing.length > 0) {
            return containing[0];
        }

        // The selector NAMES a measure and no source label matches it, so there
        // is no portion here that the selector describes. Returning the
        // lowest-weight eligible portion instead would hand `parsePortionLabel`
        // an unrelated row to relabel: a source "1 slice / 30 g" would be
        // published as the selector's "1 cup / 30 g", a conversion no source
        // states and the same contradiction between measure and weight that
        // this importer exists to prevent. The record's own portions are
        // resolved on their own labels instead, and the unresolved selector is
        // recorded on the validation record for review.
        return null;
    }

    // The selector names nothing to match against — it carries an amount only —
    // so the lowest-weight eligible portion contradicts no claim.
    return eligible.length > 0 ? eligible.slice().sort(byWeight)[0] : null;
};

// ---------------------------------------------------------------------------
// Building one catalog row from one USDA record.
// ---------------------------------------------------------------------------

/** Everything one record contributes, assembled before anything is written. */
export interface PreparedCatalogFood {
    readonly sourceKey: string;
    readonly fdcId: number;
    readonly candidate: CatalogFoodCandidate;
    readonly aliases: readonly string[];
    readonly portions: readonly CatalogFoodPortionCandidate[];
    readonly row: {
        readonly canonical_name: string;
        readonly display_name: string;
        readonly category: string;
        readonly food_state: string;
        readonly identity_status: string;
        readonly usda_data_type: string;
        readonly usda_description: string;
        readonly source_version: string;
        readonly source_cache_key: string;
        readonly food_group: string;
        readonly is_common_dislike: boolean;
        readonly cost_class: number;
        readonly search_text: string;
        readonly diet_tags: readonly string[];
    };
    /** Why this record's numbers are what they are, for the validation record. */
    readonly assumptions: readonly string[];
    /**
     * True when the description matched no classification rule, so the food
     * took the manifest's fallback category and food group. Its identity is
     * sound — USDA states it — but its category is a placeholder, and
     * publishing it would file it in the wrong grocery aisle and leave it
     * invisible to the dislike exclusions, which work through `food_group`.
     * Recorded on the validation record so validation holds it as a candidate
     * however many times it is re-judged.
     */
    readonly curatorReviewRequired: boolean;
    /**
    /**
     * The sentence `catalog_validation_records.nutrition_method` carries, which
     * has to agree with {@link assumptions}: a record whose assumptions say
     * energy was derived cannot have a method that says nothing was derived.
     * Derived here, next to the derivation, rather than written as a fixed
     * string by the caller — the two drifted apart exactly once that way.
     */
    readonly nutritionMethod: string;
    /**
     * How this record was actually obtained, for
     * `catalog_validation_records.identity_evidence`. USDA records are their
     * own identity evidence (Agent Action Plan §0.7.3), so this is a retrieval
     * record for the vendor request rather than for a fetched web page — which
     * is why it names the request it describes instead of borrowing
     * `evidence.service.ts`'s web-page shape.
     *
     * Every field states something observed. `url` and `method` are the
     * endpoint the client really calls (the batch `POST /foods`, never a
     * per-food `GET /food/{id}` — nothing in this pipeline makes one), and
     * `source_cache_key` is the key that response is recorded under in
     * `usda_api_cache`, so a reader can look the payload up and recompute
     * `body_sha256` from it.
     *
     * `http_status` is the upstream status the vendor exchange answered with,
     * taken from the retrieval the client reported and never derived from
     * anything else. It used to be computed as "null if the response came from
     * cache, otherwise 200", which stated a status nobody had observed and — for
     * the great majority of records, because the origin was misread — no status
     * at all. It is now: this run's observed status when this run fetched, the
     * status recorded on the cache row when this run replayed one, and `null`
     * only for a row cached before `usda_api_cache.http_status` existed.
     * `http_status_source` says which of those three it is, so the value is
     * never left to be guessed at from `retrieval_source`.
     */
    readonly evidence: {
        readonly url: string;
        readonly method: string;
        readonly request_body: { readonly fdcIds: readonly number[]; readonly format: string };
        readonly final_host: string;
        readonly http_status: number | null;
        readonly http_status_source: string;
        readonly source_cache_key: string;
        readonly source_cache_key_scheme: string;
        readonly retrieval_source: UsdaRetrievalSource;
        readonly body_sha256: string;
        readonly body_sha256_subject: string;
        readonly record_sha256: string;
        readonly record_sha256_subject: string;
        readonly matched_snippet: string;
        readonly fetched_at: string;
        readonly fetched_at_source: string;
    };
    readonly curated: boolean;
}

/** Where a record came from: a reviewed entry, or a dataset sweep. */
export type ImportAssignment =
    | { readonly kind: 'curated'; readonly entry: UsdaManifestFood }
    | {
          readonly kind: 'sweep';
          readonly sweepKey: string;
          readonly category: CoverageCategory;
          readonly foodGroup: string;
          readonly classified: boolean;
      };

const USDA_API_HOST = 'api.nal.usda.gov';

/**
 * The one endpoint this stage reads detail records from. `usda.service.ts`
 * exposes a single-record `getFoodDetail` as well, but this pipeline never
 * calls it: twenty ids per request is what keeps a 13,000-food sweep inside the
 * vendor's hourly cap, so every record here arrives in a batch response and the
 * evidence record must say so.
 */
export const USDA_BATCH_PATH = '/foods';
export const USDA_BATCH_ENDPOINT = `https://${USDA_API_HOST}/fdc/v1${USDA_BATCH_PATH}`;
/** The `format` the client sends; part of the cached request body, so part of the key. */
export const USDA_BATCH_FORMAT = 'full';

/**
 * The cache-key scheme every imported row's `source_cache_key` follows, stated
 * as data so the manifest's own declaration can be compared against it.
 *
 * The manifest used to describe this key as `/food/<fdcId>?format=full`, a
 * per-food detail path that nothing in this pipeline ever requests — so no
 * `usda_api_cache` row has ever existed under it and the documented provenance
 * could not be checked against anything. The key rows actually carry is the
 * batch key below, shared by the (up to twenty) foods one `POST /foods`
 * response carried, which is exactly what makes it checkable: a reader takes
 * the key off the row, reads the cache row it names, and recomputes the
 * evidence digests from the payload.
 *
 * Derived from this file's own endpoint constants rather than written out, so
 * the declaration cannot drift from the request the import makes; `main()`
 * refuses to run when the manifest's declaration disagrees with it, and the
 * suite pins it against a real `cacheKeyForRequest` call.
 */
export interface UsdaSourceCacheKeyScheme {
    readonly method: string;
    readonly path: string;
    /** Empty: the batch request carries no query parameter, so none is in the key. */
    readonly queryParams: readonly string[];
    readonly requestBodyKeys: readonly string[];
    readonly format: string;
    readonly shape: string;
    /** True: one key names one response, and a response carries many foods. */
    readonly sharedAcrossBatch: boolean;
    readonly maxFoodsPerKey: number;
}

export const USDA_SOURCE_CACHE_KEY_SCHEME: UsdaSourceCacheKeyScheme = {
    method: 'POST',
    path: USDA_BATCH_PATH,
    queryParams: [],
    requestBodyKeys: ['fdcIds', 'format'],
    format: USDA_BATCH_FORMAT,
    shape: `POST ${USDA_BATCH_PATH}?#{"fdcIds":[<ascending de-duplicated fdc ids>],"format":"${USDA_BATCH_FORMAT}"}`,
    sharedAcrossBatch: true,
    maxFoodsPerKey: MAX_BATCH_FDC_IDS,
};

/** Where the manifest states the scheme, for the message a disagreement prints. */
export const SOURCE_CACHE_KEY_SCHEME_MANIFEST_PATH = 'sweepNamingPolicy.sourceCacheKeyScheme';

/**
 * Field-by-field disagreement between the manifest's declared scheme and the
 * one above; empty when they agree.
 *
 * Pure and total: it takes `unknown` because `UsdaManifest` does not type this
 * documentary block, and it reports an absent or malformed declaration as a
 * disagreement rather than treating it as agreement. Silence on an absent
 * declaration is how the old `/food/<fdcId>` claim survived unnoticed — nothing
 * read it, so nothing could contradict it.
 */
export const sourceCacheKeySchemeDisagreements = (
    declared: unknown,
    expected: UsdaSourceCacheKeyScheme = USDA_SOURCE_CACHE_KEY_SCHEME,
): readonly string[] => {
    if (declared === null || typeof declared !== 'object' || Array.isArray(declared)) {
        return [
            `${SOURCE_CACHE_KEY_SCHEME_MANIFEST_PATH} is absent or is not an object, so the source_cache_key the ` +
                `import writes ("${expected.shape}") is stated nowhere a reader can check it`,
        ];
    }

    const record = declared as Record<string, unknown>;
    const disagreements: string[] = [];

    type ScalarField = 'method' | 'path' | 'format' | 'shape' | 'sharedAcrossBatch' | 'maxFoodsPerKey';

    const compareScalar = (field: ScalarField): void => {
        const value = record[field];
        if (value !== expected[field]) {
            disagreements.push(
                `${SOURCE_CACHE_KEY_SCHEME_MANIFEST_PATH}.${field} declares ${JSON.stringify(value)} but the import ` +
                    `writes ${JSON.stringify(expected[field])}`,
            );
        }
    };

    const compareList = (field: 'queryParams' | 'requestBodyKeys'): void => {
        const value = record[field];
        const declaredList = Array.isArray(value) ? value.map((entry) => String(entry)) : null;
        if (declaredList === null || declaredList.join(',') !== expected[field].join(',')) {
            disagreements.push(
                `${SOURCE_CACHE_KEY_SCHEME_MANIFEST_PATH}.${field} declares ${JSON.stringify(value)} but the import ` +
                    `sends ${JSON.stringify(expected[field])}`,
            );
        }
    };

    compareScalar('method');
    compareScalar('path');
    compareList('queryParams');
    compareList('requestBodyKeys');
    compareScalar('format');
    compareScalar('shape');
    compareScalar('sharedAcrossBatch');
    compareScalar('maxFoodsPerKey');

    return disagreements;
};

/**
 * Where a batch response came from on this run.
 *
 * `usda_api_cache` means the response was already on record when this run
 * looked, so the run read it and issued no request — and the recorded
 * `fetched_at` is the vendor retrieval time, which is the honest answer to
 * "when was this obtained from USDA". `import_run` means this run fetched it,
 * so the retrieval time is this run's own clock.
 *
 * These two values are the vocabulary already published in
 * `catalog_validation_records.identity_evidence`, so the client's `'cache'` /
 * `'network'` origin is mapped onto them rather than replacing them.
 */
export type UsdaRetrievalSource = 'usda_api_cache' | 'import_run';

/**
 * The observed facts about one batch request, produced by the client that makes
 * it (see {@link ImportUsdaClient.fetchBatch}) rather than inferred here,
 * because only the client knows how it reaches the vendor and what its cache
 * recorded.
 *
 * Every member is observed BY the call that returned the records, not re-read
 * afterwards. That ordering is the fix for a defect worth stating: the retrieval
 * used to be described by a second `usda_api_cache` lookup made after the fetch,
 * which raced the fetch's own best-effort cache write — so a response this run
 * had just fetched was usually reported as having been read from cache, and the
 * HTTP status on its evidence record was decided by that mistaken origin rather
 * than by anything USDA answered.
 */
export interface UsdaBatchRetrieval {
    /** The ids that addressed the response, normalised the way the cache key is. */
    readonly requestedFdcIds: readonly number[];
    /** `usda_api_cache.cache_key` for this request — the row that holds the payload. */
    readonly cacheKey: string;
    /**
     * sha256 of the canonical JSON of the whole response payload the records
     * were read out of — the same payload recorded under {@link cacheKey}.
     *
     * Never null: the client hands the payload back with the records, so there
     * is always something to digest. It used to be nullable because the digest
     * was taken from a separate cache read that could find no row.
     */
    readonly responseSha256: string;
    readonly source: UsdaRetrievalSource;
    /**
     * The upstream HTTP status of the exchange that produced the payload: this
     * run's observed status when it fetched, and the status recorded on the
     * cache row when it replayed one.
     *
     * `null` means the recorded response predates `usda_api_cache.http_status`,
     * so no status was ever observed for it. It never means "unknown, probably
     * 200" — an evidence record quotes this value, and a status nobody saw is
     * the claim this field exists to stop.
     */
    readonly httpStatus: number | null;
    /** `usda_api_cache.fetched_at`; `null` when this run fetched the response itself. */
    readonly cachedAt: Date | null;
}

/**
 * The retrieval facts as the vendor client states them, in the vocabulary the
 * evidence records publish. Pure, so the mapping is asserted without a fetch.
 *
 * `origin` is the client's observation, and it is the only thing that decides
 * `source`: `cachedAt` carries the row's own retrieval time for a replay and is
 * left null for a live fetch, so the evidence record falls back to the run clock
 * exactly when there is no vendor retrieval time to state. The digest is taken
 * from the payload the records came out of, which is why it is always present.
 */
export const toBatchRetrieval = (facts: UsdaBatchRetrievalFacts): UsdaBatchRetrieval => ({
    requestedFdcIds: facts.requestedFdcIds,
    cacheKey: facts.cacheKey,
    responseSha256: sha256Hex(canonicalJsonString(facts.payload)),
    source: facts.origin === 'cache' ? 'usda_api_cache' : 'import_run',
    httpStatus: facts.httpStatus,
    cachedAt: facts.origin === 'cache' ? facts.fetchedAt : null,
});

/**
 * Assembles one candidate from one USDA detail record.
 *
 * Nutrition is read per 100 g, which is what every generic USDA data type
 * states. A record that states macros but no energy takes the manifest's
 * documented Atwater derivation, and the derivation is recorded as an
 * assumption on the food's validation record rather than applied silently —
 * "nutrition_method" and "nutrition_assumptions" exist so a reader can tell a
 * stated value from a derived one.
 */
export const prepareCatalogFood = (
    detail: UsdaFoodDetail,
    assignment: ImportAssignment,
    manifest: UsdaManifest,
    fetchedAt: Date,
    retrieval: UsdaBatchRetrieval,
): PreparedCatalogFood => {
    const description = (detail.description ?? '').trim();
    const dataType = (detail.dataType ?? (assignment.kind === 'curated' ? assignment.entry.usdaDataType : '')).trim();
    const nutrients = detail.foodNutrients;

    const protein = readNutrientAmount(nutrients, manifest.nutrientNumbers.protein);
    const carbs = readNutrientAmount(nutrients, manifest.nutrientNumbers.carbs);
    const fat = readNutrientAmount(nutrients, manifest.nutrientNumbers.fat);
    const fiber = readNutrientAmount(nutrients, FIBER_NUTRIENT_NUMBER);
    const statedCalories = readNutrientAmount(nutrients, manifest.nutrientNumbers.calories);

    const assumptions: string[] = [];
    let calories = statedCalories;
    let caloriesDerived = false;
    if (calories === null && protein !== null && carbs !== null && fat !== null) {
        calories = Math.round((4 * protein + 4 * carbs + 9 * fat) * 100) / 100;
        caloriesDerived = true;
        assumptions.push(
            `calories derived from the manifest's documented fallback (${manifest.caloriesFallback}); the source stated no energy value`,
        );
    }

    const curated = assignment.kind === 'curated';
    const category = curated ? assignment.entry.category : assignment.category;
    const foodGroup = curated ? assignment.entry.foodGroup : assignment.foodGroup;

    const foodState = curated
        ? assignment.entry.foodState
        : resolveFoodState(description, dataType, manifest.sweepFoodStateRules);

    const canonicalName = curated ? assignment.entry.canonicalName : description.toLowerCase().replace(/\s+/g, ' ');
    const displayName = curated ? assignment.entry.displayName : description;

    const aliases = curated
        ? dedupeSortedAliases(assignment.entry.aliases, canonicalName)
        : dedupeSortedAliases(deriveSweepAliases(description, canonicalName), canonicalName);

    const portions = resolvePortions(
        detail,
        dataType,
        manifest.sweepPortionPolicy,
        curated ? assignment.entry.defaultPortion : undefined,
    );

    if (curated && !portions.some((portion) => portion.source === 'usda_food_portion')) {
        assumptions.push(
            `the reviewed portion selector "${assignment.entry.defaultPortion.description}" resolved to no gram weight on the live record; the food carries the source's 100 g basis instead and its household measure needs re-verification`,
        );
    } else if (
        curated &&
        !portions.some(
            (portion) =>
                portion.source === 'usda_food_portion' &&
                portion.description === assignment.entry.defaultPortion.description,
        )
    ) {
        // The selector named a measure the live record does not carry, so the
        // default portion below is the record's own, resolved on its own label.
        // Said plainly because the reviewed household measure is the thing a
        // curator would want to re-check, and silence here would read as if the
        // selector had been honoured.
        assumptions.push(
            `no portion on the live record matches the reviewed selector "${assignment.entry.defaultPortion.description}", so the default portion is the record's own measure rather than the reviewed one; the selector needs re-verification against the current record`,
        );
    }

    // A curated food's safety metadata comes from its reviewed determination
    // and from nowhere else — never from derivation, and never from an empty
    // set standing in for one. An empty `allergenTags` list is the positive
    // claim "reviewed, and this food contains none of the nine", so writing it
    // beside `allergen_status: 'known'` on a food whose allergens were never
    // reviewed is how wheat flour, egg, peanut butter, shrimp and salmon would
    // come to look safe to an allergic user, and the planner's hard exclusion
    // reads exactly these two columns.
    const reviewed = curated ? assignment.entry.reviewedSafety : undefined;
    const reviewedStatus = reviewed?.allergenStatus === 'known' ? 'known' : 'unknown';
    // A reviewed entry's tags are carried whatever its status, because the two
    // columns say different things: `allergen_tags` is what the food is known
    // to contain, and `allergen_status` is whether that list is complete. A
    // reviewed entry recorded as "unknown" with `wheat` on it means "contains
    // wheat, and we are not certain nothing else is in it" — dropping the
    // wheat would throw away a reviewed fact, and promoting the status would
    // claim a completeness nobody established. Only the status gates planning
    // (Agent Action Plan §0.7.3), so carrying the tags is safe in both
    // directions: the food stays out of every plan, and a user reading it in
    // Add Food still sees the allergen that is known to be there.
    const reviewedTags = reviewed === undefined ? null : [...reviewed.allergenTags];
    const safety = curated
        ? {
              allergenTags: reviewedTags ?? [],
              dietTags: [...(reviewed?.dietTags ?? [])],
              compositeMarkers: [] as string[],
          }
        : deriveSafetyTags(description, category, foodGroup, manifest.sweepAllergenDietRules);

    if (curated) {
        const tagText = safety.allergenTags.length > 0 ? safety.allergenTags.join(', ') : 'none of the nine';
        if (reviewedTags === null) {
            assumptions.push(
                'no reviewed allergen determination is recorded for this entry, so allergen_status is "unknown" and no allergen or diet tag is asserted; the food is searchable but never planned as an ingredient',
            );
        } else if (reviewedStatus === 'known') {
            assumptions.push(
                `allergen and diet tags are the reviewed determination recorded for this entry in the manifest (allergens: ${tagText}); allergen_status is "known", so the food may be planned as an ingredient`,
            );
        } else {
            assumptions.push(
                `allergen and diet tags are the reviewed determination recorded for this entry in the manifest (allergens: ${tagText}), but the review did not establish that the list is complete, so allergen_status is "unknown": the tags are a floor and the food is searchable but never planned as an ingredient`,
            );
        }
    }

    if (!curated) {
        assumptions.push(
            'allergen and diet tags were derived from the food group and the description, not reviewed; allergen_status is "unknown" so the food is searchable but never planned as an ingredient',
        );
        if (safety.compositeMarkers.length > 0) {
            assumptions.push(
                `the description names a composite preparation (${safety.compositeMarkers.join(', ')}), so its derived allergen set is a floor rather than a complete set`,
            );
        }
        if (!assignment.classified) {
            assumptions.push(
                'the description matched no classification rule, so the food took the manifest fallback category and is left unpublished pending a curator',
            );
        }
    }

    const expected = curated ? (assignment.entry.expectedUsdaDescription ?? '').trim() : '';
    const identityStatus: CatalogIdentityStatus =
        expected.length > 0 && expected.toLowerCase() !== description.toLowerCase() ? 'ambiguous' : 'verified';
    if (identityStatus === 'ambiguous') {
        assumptions.push(
            `the live description "${description}" differs from the reviewed "${expected}", so identity_status is "ambiguous" and the record is not published`,
        );
    }

    const candidate: CatalogFoodCandidate = {
        source_key: buildSourceKey({ identitySource: 'usda', fdcId: detail.fdcId }),
        canonical_name: canonicalName,
        display_name: displayName,
        aliases,
        category,
        food_state: foodState,
        identity_source: 'usda',
        identity_status: identityStatus,
        nutrition_provenance: 'source_backed',
        allergen_status: curated ? reviewedStatus : 'unknown',
        allergen_tags: safety.allergenTags,
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        calories,
        protein_g: protein,
        carbs_g: carbs,
        fat_g: fat,
        fiber_g: fiber,
        density_g_per_ml: null,
        portions,
    };

    return {
        sourceKey: candidate.source_key as string,
        fdcId: detail.fdcId,
        candidate,
        aliases,
        portions,
        row: {
            canonical_name: canonicalName,
            display_name: displayName,
            category,
            food_state: foodState,
            identity_status: identityStatus,
            usda_data_type: dataType,
            usda_description: description,
            source_version: buildSourceVersion(dataType, detail.publicationDate),
            // The key of the batch response this row was read out of, so the
            // payload behind it can be looked up. Shared by the (up to twenty)
            // foods of that batch, which is what it means — and what
            // USDA_SOURCE_CACHE_KEY_SCHEME states and the manifest now declares.
            source_cache_key: retrieval.cacheKey,
            food_group: foodGroup,
            // Only the reviewed entries seed the dislike suggestions: a swept
            // record flagged by its group would crowd the twelve curated chips
            // out of `GET /catalog/foods/suggestions`, and the dislike
            // exclusion itself works through food_group, so nothing is lost.
            is_common_dislike: curated ? assignment.entry.isCommonDislike : false,
            cost_class: curated
                ? assignment.entry.costClass
                : resolveCostClass(category, foodGroup, manifest.sweepCostClassRules),
            search_text: buildSearchText(canonicalName, aliases, foodState, foodGroup),
            diet_tags: safety.dietTags,
        },
        assumptions,
        nutritionMethod: caloriesDerived
            ? `protein, fat, carbohydrate and fibre read per 100 g from the record's own foodNutrients (203 protein, 204 fat, 205 carbohydrate, 291 fibre); the record stated no energy value (208), so energy was derived from those same macros by the manifest's documented fallback (${manifest.caloriesFallback}). No value came from another food.`
            : "every value read per 100 g from the record's own foodNutrients (203 protein, 204 fat, 205 carbohydrate, 208 energy, 291 fibre); nothing was scaled, derived or estimated",
        curatorReviewRequired: !curated && !assignment.classified,
        evidence: {
            url: USDA_BATCH_ENDPOINT,
            method: USDA_SOURCE_CACHE_KEY_SCHEME.method,
            request_body: { fdcIds: retrieval.requestedFdcIds, format: USDA_BATCH_FORMAT },
            final_host: USDA_API_HOST,
            http_status: retrieval.httpStatus,
            http_status_source:
                retrieval.httpStatus === null
                    ? 'null: the response was already recorded in usda_api_cache before that table carried http_status, so no upstream status was ever observed for it. Not a substituted 200 — re-importing this batch records the status of the exchange that answers.'
                    : retrieval.source === 'usda_api_cache'
                      ? 'usda_api_cache.http_status: the status recorded when this response was retrieved from USDA, replayed by this run'
                      : "this run's own POST /foods exchange, as src/services/usda.service.ts observed it on the attempt that returned the records",
            source_cache_key: retrieval.cacheKey,
            source_cache_key_scheme: USDA_SOURCE_CACHE_KEY_SCHEME.shape,
            retrieval_source: retrieval.source,
            body_sha256: retrieval.responseSha256,
            body_sha256_subject: `sha256 of the key-sorted JSON of the whole ${USDA_BATCH_PATH} response payload this food's record was read out of, as recorded in usda_api_cache under source_cache_key`,
            record_sha256: sha256Hex(canonicalJsonString(detail)),
            record_sha256_subject: "sha256 of the key-sorted JSON of this food's own record within that response",
            matched_snippet: description.slice(0, 500),
            fetched_at: (retrieval.cachedAt ?? fetchedAt).toISOString(),
            fetched_at_source:
                retrieval.cachedAt === null
                    ? 'import run clock: this run fetched the response itself, so the retrieval time is its own'
                    : 'usda_api_cache.fetched_at: the time the response was retrieved from USDA',
        },
        curated,
    };
};

// ---------------------------------------------------------------------------
// Persistence.
//
// WHY NOT ONE `where` HERE CARRIES AN OWNER, AND WHY THAT IS NOT A §5.1
// VIOLATION. Rule backend-architecture §5.1 requires every Prisma predicate to
// include `user_id: userId`, because a write found by id alone is a cross-user
// write waiting to happen. The four tables below have no `user_id` column AT
// ALL, by design: `catalog_foods` and its aliases, portions and validation
// records are shared reference data — one row per food for the whole
// installation, exactly like the recipe catalog — so there is no owner to scope
// to and an owner predicate here would not compile, let alone protect anything.
// AAP §0.5.1 names them as the only authenticated reads without a tenant
// predicate.
//
// The guarantee that replaces it is the DATABASE ORIGIN, checked before any of
// this runs: `lib/dbGuard.ts` classifies DATABASE_URL at module load (the
// second import in this file) and refuses an origin it cannot recognise rather
// than guessing, so this stage cannot be pointed at production data by
// accident. Identity is enforced instead by the keys: every write below is an
// upsert on `source_key`, which is derived from USDA's own id, so a rerun
// converges on the same rows rather than accumulating new ones.
// ---------------------------------------------------------------------------

/**
 * The narrow slice of the Prisma client this stage writes through. Declared
 * structurally so the script-level suite can drive `runImport` against a fake
 * without a database, and so this file never depends on the generated client's
 * shape beyond the four models it touches.
 */
export interface ImportDb {
    catalog_foods: {
        /**
         * The stored row carries `id` and `imported_at` for the write itself
         * and {@link StoredVersionedFacts} for the version decision, as one
         * intersection rather than a second hand-maintained field list: a fact
         * the comparison reads and the read does not return would be invisible
         * to it, and that is the failure this shape rules out.
         */
        findUnique(
            args: unknown,
        ): Promise<({ id: string; imported_at: Date | null } & StoredVersionedFacts) | null>;
        create(args: unknown): Promise<{ id: string }>;
        update(args: unknown): Promise<{ id: string }>;
    };
    catalog_food_aliases: {
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
    $transaction<T>(work: (tx: ImportDb) => Promise<T>, options?: { timeout?: number }): Promise<T>;
}

/**
 * The batch transaction's client, viewed as the run ledger's.
 *
 * `ImportDb` and `CatalogRunDb` are two narrow structural views of ONE real
 * Prisma client: `main()` casts the singleton to the first and hands the same
 * object to `runDb` as the second, and the client `deps.db.$transaction` yields
 * is that same object mid-transaction. Declaring the intersection instead is not
 * available — `CatalogRunDb` is a union of two generated Prisma types, so an
 * intersection with it would demand a full `PrismaClient` where a transaction
 * client (which has no `$transaction` of its own) is what exists.
 *
 * So the conversion is a cast, and it lives here alone rather than at the call
 * site, with the contract it asserts written down: the object must carry
 * `catalog_import_runs` and the raw-query escape hatch the run row's lock is
 * taken with. `src/__tests__/scripts/catalog-import.test.ts` is what holds it to
 * that — it drives the batch loop against a client whose transactions really do
 * carry the run ledger, so a fake that did not would fail there rather than in
 * production.
 */
const asRunLedger = (tx: ImportDb): CatalogRunDb => tx as unknown as CatalogRunDb;

/** What persisting one record did, so the report counts real outcomes. */
export type PersistOutcome = 'inserted' | 'updated';

// TWO FIELDS THIS STAGE WRITES ARE DELIBERATELY IN NEITHER SET, because the
// next reader's first instinct is to add them and a spurious bump is not free:
// it makes every recipe using the food stale, and `recipes-seed.ts` answers a
// stale ingredient by publishing a NEW recipe version and retiring the old one.
//   * source_cache_key is retrieval bookkeeping — the key of the batch response
//     this row was read out of. Re-fetching the same food in a differently
//     composed batch changes it while changing no snapshot value and no
//     provenance, so bumping on it would version the catalog by how the import
//     happened to group its requests.
//   * category is read by no snapshot column. It drives the grocery aisle,
//     which is derived live from the current row at list time, so a
//     recategorised food is already reported correctly without a new version.
// Both remain fully written by the upsert below; they are simply not evidence
// that a frozen snapshot has stopped describing this food.

/**
 * The Prisma `select` the version decision needs, typed as a total record over
 * {@link StoredVersionedFacts} so that adding a field to a comparison set
 * without selecting it is a compile error. Left unselected it would arrive as
 * `undefined` on every read and bump the counter on every rerun.
 */
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
 * Writes one food, its aliases, its portions and its validation record.
 *
 * Aliases and portions are replaced wholesale rather than merged: the source
 * record is the authority on both, so a rerun after a manifest change must
 * converge on what the manifest now says instead of accumulating every alias
 * the food has ever had. `imported_at` is written once on insert and never on
 * update, which is what keeps a rerun's exported release byte-identical.
 */
export const persistPreparedFood = async (
    db: ImportDb,
    prepared: PreparedCatalogFood,
    verdict: CatalogValidationVerdict,
    publicationStatus: string,
    now: Date,
): Promise<PersistOutcome> => {
    const existing = await db.catalog_foods.findUnique({
        where: { source_key: prepared.sourceKey },
        select: {
            id: true,
            imported_at: true,
            ...VERSIONED_FACT_SELECT,
        },
    });

    // Assembled without the two version counters, because the counters are
    // DERIVED from these very values: comparing what this write is about to
    // store — rather than re-reading `prepared` a second time — is what keeps
    // the comparison and the write from ever describing different facts.
    const facts = {
        canonical_name: prepared.row.canonical_name,
        display_name: prepared.row.display_name,
        category: prepared.row.category,
        food_state: prepared.row.food_state,
        identity_source: 'usda',
        identity_status: prepared.row.identity_status,
        nutrition_provenance: 'source_backed',
        nutrition_basis: 'per_100g',
        basis_amount: 100,
        calories: prepared.candidate.calories,
        protein_g: prepared.candidate.protein_g,
        carbs_g: prepared.candidate.carbs_g,
        fat_g: prepared.candidate.fat_g,
        fiber_g: prepared.candidate.fiber_g ?? null,
        density_g_per_ml: null,
        usda_fdc_id: prepared.fdcId,
        usda_data_type: prepared.row.usda_data_type,
        usda_description: prepared.row.usda_description,
        source_version: prepared.row.source_version,
        source_cache_key: prepared.row.source_cache_key,
        publication_status: publicationStatus,
        allergen_tags: prepared.candidate.allergen_tags ?? [],
        allergen_status: prepared.candidate.allergen_status,
        diet_tags: prepared.row.diet_tags,
        food_group: prepared.row.food_group,
        is_common_dislike: prepared.row.is_common_dislike,
        cost_class: prepared.row.cost_class,
        search_text: prepared.row.search_text,
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
            ? (await db.catalog_foods.create({ data: { ...scalars, source_key: prepared.sourceKey, imported_at: now } }))
                  .id
            : (await db.catalog_foods.update({ where: { id: existing.id }, data: scalars })).id;

    await db.catalog_food_aliases.deleteMany({ where: { catalog_food_id: foodId } });
    if (prepared.aliases.length > 0) {
        await db.catalog_food_aliases.createMany({
            data: prepared.aliases.map((alias) => ({ catalog_food_id: foodId, alias })),
            skipDuplicates: true,
        });
    }

    await db.catalog_food_portions.deleteMany({ where: { catalog_food_id: foodId } });
    // gram_weight is NOT NULL, so a portion whose weight the source never
    // stated is not persisted — it stays on the candidate, where the
    // `missing_gram_weight` check can see it, rather than being written as a
    // zero that would read as a fact.
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
                source: portion.source ?? 'usda_food_portion',
            })),
            skipDuplicates: true,
        });
    }

    const record = buildValidationRecordData(prepared, verdict, publicationStatus, now);
    await db.catalog_validation_records.upsert({
        where: { catalog_food_id: foodId },
        create: { catalog_food_id: foodId, ...record, history: [] },
        update: record,
    });

    return existing === null ? 'inserted' : 'updated';
};

/**
 * The machine-readable validation record AAP 0.1.1 requires for every item:
 * what the food claims to be, how its nutrition was arrived at, what was
 * assumed, which checks ran with their observed values and bounds, and what
 * evidence establishes its identity.
 *
 * `nutrition_assumptions` is a JSON-encoded array in a TEXT column — the
 * column Prisma declares is `String?`, and the release exporter parses it back
 * to the array the release format states.
 */
export const buildValidationRecordData = (
    prepared: PreparedCatalogFood,
    verdict: CatalogValidationVerdict,
    publicationStatus: string,
    now: Date,
): Record<string, unknown> => ({
    canonical_identity: {
        source_key: prepared.sourceKey,
        canonical_name: prepared.row.canonical_name,
        display_name: prepared.row.display_name,
        food_state: prepared.row.food_state,
        category: prepared.row.category,
        food_group: prepared.row.food_group,
        usda_fdc_id: prepared.fdcId,
        usda_data_type: prepared.row.usda_data_type,
        usda_description: prepared.row.usda_description,
        // Read by validation, which holds such a row as a candidate no matter
        // how many times it is re-judged: the checks can see nothing wrong
        // with an unclassified food, because what is missing is a category
        // only a curator can assign.
        curator_review_required: prepared.curatorReviewRequired,
    },
    aliases: prepared.aliases.slice(),
    category: prepared.row.category,
    food_state: prepared.row.food_state,
    // The same constant the evidence assessment is made under, so the record is
    // judged against the requirements of the source it declares.
    identity_source: IMPORT_IDENTITY_SOURCE,
    identity_status: prepared.row.identity_status,
    nutrition_provenance: 'source_backed',
    // Derived alongside the numbers it describes, so a record whose
    // assumptions state a derivation cannot carry a method that denies one.
    nutrition_method: prepared.nutritionMethod,
    nutrition_assumptions: JSON.stringify(prepared.assumptions),
    portion_units: prepared.portions.map((portion) => ({
        description: portion.description,
        amount: portion.amount,
        unit: portion.unit,
        gram_weight: portion.gram_weight,
        is_default: portion.is_default,
        source: portion.source ?? 'usda_food_portion',
    })),
    identity_evidence: [prepared.evidence],
    checks: verdict.checks,
    // Null on purpose, and meaningfully so: no model was consulted about this
    // food. A model name here would imply a review that never happened.
    llm_review: null,
    // Either import-stage refusal holds the record, whatever the checks said:
    // an unclassified category (curator review) or incomplete retrieval
    // evidence (mandatory fields, AAP §0.3.2). The reason is readable off the
    // record itself — `identity_evidence[0].http_status_source` says which case
    // a null status is — so the outcome never has to be explained from outside
    // the row.
    //
    // The evidence half is the shared floor's decision, read through the same
    // helper `importPublicationStatus` uses: the two fields are one statement
    // about one record, and a row written `quarantined` with an `accepted`
    // outcome (or the reverse) would contradict itself on disk.
    outcome:
        prepared.curatorReviewRequired || !importEvidenceAssessment(prepared).complete
            ? 'quarantined'
            : verdict.outcome,
    reviewed_at: now,
    publication_status: publicationStatus,
    source_versions: {
        usda_data_type: prepared.row.usda_data_type,
        source_version: prepared.row.source_version,
        usda_manifest_version: 'v1',
        coverage_plan_version: 'v1',
    },
});

// ---------------------------------------------------------------------------
// The cross-document check the manifest's own `coveragePlanContract` assigns to
// this stage.
//
// `loadUsdaManifest` verifies the manifest against its declared shape and its
// own vocabularies (`assertUsdaManifestShape`), and deliberately loads no
// second document — so the half of the contract that spans two files has
// nowhere else to live. What it spans is worth stating precisely: the manifest
// files every food under a `category` and a `foodGroup`, and the coverage plan
// is where those two are defined and where the food group's OWN category is
// declared. An entry naming a category the plan does not target contributes to
// no target; one naming an unknown food group is invisible to the dislike
// exclusions built from food groups; and one whose category disagrees with its
// food group's category in the plan is counted against one category while it
// behaves as another. None of the three fails at runtime.
//
// It runs before the rate limiter is installed and before the first vendor
// request, because a disagreement between two committed documents is not
// something the import can work through: no number of records fetched makes it
// resolvable, and stopping halfway is strictly worse to recover from than
// stopping at the start.
// ---------------------------------------------------------------------------

/** Cap on the entries one refusal or warning lists, so a wholesale disagreement is still readable. */
const COVERAGE_MISMATCH_LIST_LIMIT = 10;

/**
 * What the manifest and the coverage plan agree and disagree about, split by
 * what the disagreement costs.
 */
export interface CoveragePlanAgreement {
    /**
     * A record would be FILED under a category or food group the plan does not
     * declare, or under a category that is not its food group's own. Every one
     * of these mis-files a row: it is counted against a category nothing
     * targets, or behaves as one category while being counted as another. This
     * is the agreement the manifest's `coveragePlanContract` states, and a
     * non-empty list stops the run before its first vendor request.
     */
    readonly filingMismatches: readonly string[];
    /**
     * A KEY in one of the manifest's derivation tables names a food group no
     * record can carry, so the cost class or allergen set under it can never be
     * applied. Nothing is mis-filed, but a policy a curator wrote is not in
     * force — and for the allergen table that means a record the curator
     * intended to mark as containing milk carries no such tag.
     *
     * Kept as its own list because the two disagreements are different facts
     * and each deserves its own message, but it is **as fatal as a
     * filing mismatch**: the manifest's `coveragePlanContract` promises that
     * every food group below exists in the named plan and that a mismatch stops
     * the run before a USDA request, and a promise enforced only by a log line
     * is not one. Reporting without refusing is what let 30 such keys accumulate
     * across a taxonomy rename while every import kept succeeding.
     */
    readonly inertPolicyKeys: readonly string[];
}

/**
 * Compares the manifest with the coverage plan. Pure (§1.2/§7): both documents
 * are arguments, nothing is read from the environment and nothing is logged, so
 * the whole comparison is unit-testable and the caller decides what each half
 * of the result means.
 */
export const checkManifestAgainstCoveragePlan = (
    manifest: UsdaManifest,
    coveragePlan: CoveragePlan,
): CoveragePlanAgreement => {
    const planCategories = new Set<string>(coveragePlan.categories.map((row) => row.category));
    const categoryOfFoodGroup = new Map<string, string>(
        coveragePlan.foodGroups.map((row) => [row.foodGroup, row.category]),
    );

    const filingMismatches: string[] = [];
    const inertPolicyKeys: string[] = [];

    // Before any heading is compared: every check below reads this plan as the
    // authority on what a category and a food group mean, so comparing against
    // a plan the manifest was not written for proves nothing. Headings the two
    // versions happen to share would pass, and headings only the intended plan
    // declares would be reported as unknown — or worse, accepted.
    if (manifest.coveragePlanVersion !== coveragePlan.coveragePlanVersion) {
        filingMismatches.push(
            `the manifest is written against coverage plan ${manifest.coveragePlanVersion}, but the loaded plan ` +
                `declares coveragePlanVersion ${coveragePlan.coveragePlanVersion}`,
        );
    }

    /** One filing — a curated entry, a sweep rule, the fallback — checked all three ways. */
    const checkFiling = (where: string, category: string, foodGroup: string): void => {
        if (!planCategories.has(category)) {
            filingMismatches.push(`${where} files under category ${category}, which coverage-plan does not declare`);
            return;
        }
        const declared = categoryOfFoodGroup.get(foodGroup);
        if (declared === undefined) {
            filingMismatches.push(`${where} files under foodGroup ${foodGroup}, which coverage-plan does not declare`);
            return;
        }
        if (declared !== category) {
            filingMismatches.push(
                `${where} files ${foodGroup} under ${category}, but coverage-plan declares that foodGroup under ${declared}`,
            );
        }
    };

    manifest.foods.forEach((entry, index) => {
        checkFiling(`foods[${index}] (${entry.canonicalName}, ${entry.foodState})`, entry.category, entry.foodGroup);
    });

    // The sweeps file swept records under these same two fields, so a rule
    // naming an unknown pair mis-files every record it matches — thousands of
    // them, from one line nobody re-read.
    manifest.sweepClassificationRules.rules.forEach((rule, index) => {
        checkFiling(`sweepClassificationRules.rules[${index}]`, rule.category, rule.foodGroup);
    });
    checkFiling(
        'sweepClassificationRules.fallback',
        manifest.sweepClassificationRules.fallback.category,
        manifest.sweepClassificationRules.fallback.foodGroup,
    );

    manifest.datasetSweeps.forEach((sweep, index) => {
        if (sweep.category !== undefined && !planCategories.has(sweep.category)) {
            filingMismatches.push(
                `datasetSweeps[${index}] (${sweep.sweepKey}) declares category ${sweep.category}, which coverage-plan does not declare`,
            );
        }
    });

    // A category key is load-bearing the same way a filing is: the cost class it
    // carries is the one every record of that category takes.
    Object.keys(manifest.sweepCostClassRules.byCategory).forEach((category) => {
        if (!planCategories.has(category)) {
            filingMismatches.push(
                `sweepCostClassRules.byCategory names category ${category}, which coverage-plan does not declare`,
            );
        }
    });
    manifest.sweepAllergenDietRules.dietDerivation.animalCategories.forEach((category, index) => {
        if (!planCategories.has(category)) {
            filingMismatches.push(
                `sweepAllergenDietRules.dietDerivation.animalCategories[${index}] is ${category}, which coverage-plan does not declare`,
            );
        }
    });

    // The two food-group-keyed tables. A key outside the plan matches no record,
    // so what it carries is simply never applied.
    Object.keys(manifest.sweepCostClassRules.foodGroupOverrides).forEach((foodGroup) => {
        if (!categoryOfFoodGroup.has(foodGroup)) {
            inertPolicyKeys.push(
                `sweepCostClassRules.foodGroupOverrides.${foodGroup} applies to no record: coverage-plan declares no such foodGroup`,
            );
        }
    });
    Object.keys(manifest.sweepAllergenDietRules.byFoodGroup).forEach((foodGroup) => {
        if (!categoryOfFoodGroup.has(foodGroup)) {
            inertPolicyKeys.push(
                `sweepAllergenDietRules.byFoodGroup.${foodGroup} tags no record: coverage-plan declares no such foodGroup`,
            );
        }
    });

    return { filingMismatches, inertPolicyKeys };
};

/** `a; b; c; and 20 more` — a list an operator can read, whatever its length. */
const describeMismatchList = (entries: readonly string[]): string => {
    const listed = entries.slice(0, COVERAGE_MISMATCH_LIST_LIMIT);
    const remainder = entries.length - listed.length;
    return `${listed.join('; ')}${remainder > 0 ? `; and ${remainder} more` : ''}`;
};

/**
 * Refuses the manifest/coverage-plan pair on ANY disagreement the manifest's
 * `coveragePlanContract` covers — a mis-filed record, a plan version the
 * manifest was not written against, or a derivation key naming a food group the
 * plan does not declare.
 *
 * Called before the rate limiter is installed and before the first vendor
 * request, because a disagreement between two committed documents is not
 * something the import can work through: no number of records fetched makes it
 * resolvable, and stopping halfway is strictly worse to recover from than
 * stopping at the start.
 *
 * Both halves are fatal. An inert key costs no mis-filed row, so reporting it
 * was tempting — but the contract in `usda-manifest.v1.json` promises the
 * agreement holds, and an unenforced promise is how a taxonomy rename left 30
 * such keys behind while every import kept reporting success. A curation gap
 * that no run refuses is a curation gap nobody fixes.
 */
export const assertManifestMatchesCoveragePlan = (
    manifest: UsdaManifest,
    coveragePlan: CoveragePlan,
    logger: ScriptLogger,
): CoveragePlanAgreement => {
    const agreement = checkManifestAgainstCoveragePlan(manifest, coveragePlan);

    if (agreement.filingMismatches.length > 0) {
        throw new CatalogImportError(
            'manifest_coverage_mismatch',
            `data/meal-planning/${USDA_MANIFEST_FILE} (usdaManifestVersion ${manifest.usdaManifestVersion}) and the ` +
                `coverage plan (coveragePlanVersion ${coveragePlan.coveragePlanVersion}) disagree on ` +
                `${agreement.filingMismatches.length} ` +
                `${agreement.filingMismatches.length === 1 ? 'heading' : 'headings'}: ` +
                `${describeMismatchList(agreement.filingMismatches)}. The two documents must be reconciled before ` +
                'this import runs — it is refused here rather than halfway through, because no amount of importing ' +
                'resolves a disagreement between two committed files.',
            { manifestVersion: manifest.usdaManifestVersion },
        );
    }

    if (agreement.inertPolicyKeys.length > 0) {
        throw new CatalogImportError(
            'manifest_inert_policy_keys',
            `data/meal-planning/${USDA_MANIFEST_FILE} (usdaManifestVersion ${manifest.usdaManifestVersion}) carries ` +
                `${agreement.inertPolicyKeys.length} derivation ` +
                `${agreement.inertPolicyKeys.length === 1 ? 'key' : 'keys'} naming a foodGroup coverage plan ` +
                `${coveragePlan.coveragePlanVersion} does not declare, so the cost class or allergen set under each ` +
                `can never be applied to any record: ${describeMismatchList(agreement.inertPolicyKeys)}. ` +
                'Re-key each onto a foodGroup the plan declares, or remove it where the live rules already cover ' +
                'the intent — an allergen a curator wrote and the importer never applies reads as "contains none of ' +
                'it" rather than "not determined".',
            { manifestVersion: manifest.usdaManifestVersion },
        );
    }

    logger.info('manifest_coverage_plan_agreed', {
        stage: STAGE,
        usdaManifestVersion: manifest.usdaManifestVersion,
        coveragePlanVersion: coveragePlan.coveragePlanVersion,
        foodGroups: coveragePlan.foodGroups.length,
    });

    return agreement;
};

// ---------------------------------------------------------------------------
// The work plan.
// ---------------------------------------------------------------------------

/** One detail fetch: up to `detailBatchSize` ids that share an assignment kind. */
export interface ImportBatch {
    readonly index: number;
    readonly source: 'curated' | string;
    readonly fdcIds: readonly number[];
}

export interface ImportPlan {
    readonly batches: readonly ImportBatch[];
    /** Assignments keyed by FDC id, so a batch's records are mapped without a lookup table per batch. */
    readonly assignments: ReadonlyMap<number, ImportAssignment>;
    /** Identifies the plan, so a resume into a changed plan is refused rather than silently misaligned. */
    readonly fingerprint: string;
    readonly skipped: Readonly<Record<string, number>>;
}

const chunk = <T>(items: readonly T[], size: number): T[][] => {
    const out: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
        out.push(items.slice(index, index + size));
    }
    return out;
};

/**
 * Builds the whole fetch plan before any detail request, from the curated
 * entries and then the dataset sweeps, in the manifest's declared order.
 *
 * The list pass is what makes the plan deterministic: the sweeps' ids, their
 * classification and the brand screen are all decided here, so the batch
 * membership a rerun produces is identical — which is also what makes the
 * `usda_api_cache` entries from an earlier run reusable, since a batch's cache
 * key is derived from its sorted id set.
 */
export const buildImportPlan = async (
    manifest: UsdaManifest,
    coveragePlan: CoveragePlan,
    listFoodsForDataType: (dataType: string, pageSize: number, pageNumber: number) => Promise<UsdaFoodSummary[]>,
    options: ImportOptions,
    logger: ScriptLogger,
): Promise<ImportPlan> => {
    const assignments = new Map<number, ImportAssignment>();
    const skipped: Record<string, number> = {
        skippedExcludedClass: 0,
        skippedBrandPattern: 0,
        skippedCuratedFdcId: 0,
        skippedCuratedIdentity: 0,
        // Permanently zero, and kept for exactly that reason. An entry without a
        // verified FDC id used to be counted here and dropped; it is now refused
        // — by `assertUsdaManifestShape` when the document is loaded, and by the
        // throw below for a caller that built a manifest object itself — so the
        // field states the guarantee ("none was skipped, because none can be")
        // to every reader of the report that carries it, rather than
        // disappearing from a shape the committed artefact declares.
        skippedUnresolvedEntry: 0,
        skippedDuplicateInPlan: 0,
        skippedCategoryFilter: 0,
        /** A sweep record whose category had already reached its candidate volume. */
        skippedCategoryVolumeReached: 0,
    };

    const wantedCategories = new Set(options.categories);
    const inScope = (category: string): boolean => wantedCategories.size === 0 || wantedCategories.has(category);

    // THE CANDIDATE-VOLUME BUDGET. The coverage plan states a `candidateVolume`
    // per category — `ceil(1.25 × publishedTarget)`, the number import and
    // generation aim for — and a sweep that declares
    // `stopWhenCategoryCandidateVolumeReached` is asking to be held to it. Two
    // costs come from ignoring it, and the manifest's own `sweepPageBounds` note
    // names it as one of the two real stopping conditions: records beyond the
    // volume are fetched with requests from a 900/hour budget that the other
    // categories need, and they overfill the category, which then publishes more
    // than the plan targets and reports a shortfall computed against a number it
    // has already passed.
    //
    // Curated entries count toward a category's volume but are never refused by
    // it: they are reviewed curation, pinned by name in the search benchmark,
    // and the flag is declared per sweep. Only swept records are skipped.
    const categoryCandidateVolume = new Map<string, number>(
        coveragePlan.categories.map((row) => [row.category, row.candidateVolume]),
    );
    const plannedByCategory = new Map<string, number>();
    const countPlanned = (category: string): void => {
        plannedByCategory.set(category, (plannedByCategory.get(category) ?? 0) + 1);
    };
    const hasCategoryCapacity = (category: string): boolean => {
        const volume = categoryCandidateVolume.get(category);
        // A category the plan states no volume for is unbudgeted rather than
        // full: refusing it would make this a cap the coverage plan never set.
        return volume === undefined || (plannedByCategory.get(category) ?? 0) < volume;
    };
    /**
     * Every category this run could still file a record under is full.
     *
     * `budgeted.length > 0` is load-bearing, not defensive: `[].every(...)` is
     * TRUE, so a coverage plan that states no volume for any category in scope
     * would make this answer "all full" before the first page and end the sweep
     * having imported nothing. An unbudgeted scope has no budget to reach,
     * which is also what `hasCategoryCapacity` says one category at a time —
     * the two have to agree or the page-level stop contradicts the per-record
     * one.
     */
    const everyInScopeCategoryFull = (): boolean => {
        const budgeted = [...categoryCandidateVolume.keys()].filter((category) => inScope(category));

        return budgeted.length > 0 && budgeted.every((category) => !hasCategoryCapacity(category));
    };

    // `--limit` is documented as "stop after n manifest records", so it is one
    // budget over the whole work list in workListOrder — the curated entries
    // first, then the sweeps — not n per sweep. Applied where a record is
    // accepted, so the planned record count and the batches that get fetched
    // are the same number rather than two.
    const atLimit = (): boolean => options.limit !== null && assignments.size >= options.limit;

    const curatedIds = new Set<number>();
    const curatedIdentities = new Set<string>();
    const curatedFdcIds: number[] = [];

    for (const [entryIndex, entry] of manifest.foods.entries()) {
        // Every curated entry names its food by an FDC id read from a live USDA
        // response, and `loadUsdaManifest` refuses a document that does not (see
        // `assertUsdaManifestShape`, which rejects the old `resolveBy` form by
        // name). Reaching here without one therefore means a caller built the
        // manifest object itself, and the honest answer is to refuse rather than
        // to count it: the previous revision incremented
        // `skippedUnresolvedEntry` and moved on, so a reviewed curation was
        // dropped from the catalog and said so only in a counter.
        //
        // Written as an integer test rather than `=== undefined` because
        // `fdcId` is a required `number` in the declared shape — the comparison
        // would not compile — and this still catches the absent, null and
        // non-integer cases a hand-built object can carry.
        if (!Number.isInteger(entry.fdcId) || entry.fdcId < 1) {
            throw new CatalogImportError(
                'manifest_entry_unresolved',
                `foods[${entryIndex}] (${entry.canonicalName}, ${entry.foodState}) carries no verified fdcId ` +
                    `(received ${JSON.stringify(entry.fdcId)}). This importer resolves no entry: verify the id ` +
                    `against a live USDA response and write it into data/meal-planning/${USDA_MANIFEST_FILE}, or ` +
                    'remove the entry. A curated food is never imported under a guessed id and never silently skipped.',
                { fdcId: entry.fdcId },
            );
        }
        curatedIdentities.add(`${normalizeCanonicalName(entry.canonicalName)}\u0000${entry.foodState}`);
        if (!inScope(entry.category)) {
            skipped.skippedCategoryFilter += 1;
            curatedIds.add(entry.fdcId);
            continue;
        }
        if (curatedIds.has(entry.fdcId)) {
            skipped.skippedDuplicateInPlan += 1;
            continue;
        }
        curatedIds.add(entry.fdcId);
        // Recorded in curatedIds above even when the budget is spent, so the
        // sweeps still dedupe against every curated id rather than re-importing
        // one under a swept identity.
        if (atLimit()) {
            continue;
        }
        curatedFdcIds.push(entry.fdcId);
        assignments.set(entry.fdcId, { kind: 'curated', entry });
        countPlanned(entry.category);
    }

    const batches: ImportBatch[] = [];
    const batchSize = Math.max(1, Math.min(manifest.importLimits.detailBatchSize, MAX_BATCH_FDC_IDS));

    for (const ids of chunk(curatedFdcIds, batchSize)) {
        batches.push({ index: batches.length, source: 'curated', fdcIds: ids });
    }

    for (const sweep of manifest.datasetSweeps) {
        const sweepIds: number[] = [];
        // THE SWEEP'S PAGE BOUND IS `maxPages`, AND NOTHING ELSE.
        //
        // `observedLastNonEmptyPage` is a MEASUREMENT taken on `observedOn` by
        // binary-searching the last page that still returned records. The
        // previous revision took `min(maxPages, observedLastNonEmptyPage)` as
        // the bound, which turns that dated measurement into a permanent
        // ceiling: USDA adds records to these datasets, and every record past
        // the page count someone measured once would never be imported — with
        // nothing in the run's output to say so, because the sweep ends
        // normally.
        //
        // The document's own `sweepPageBounds` note states the design directly:
        // `maxPages` "sits above the observed count so a dataset that grows
        // between authoring and import is not silently truncated", and "the real
        // stopping conditions are an empty page and
        // stopWhenCategoryCandidateVolumeReached; maxPages only caps a runaway".
        // So the measurement is used as an EXPECTATION — exceeding it is logged
        // as growth, because that is the signal to re-measure and raise
        // `maxPages` — and `assertUsdaManifestShape` refuses a document whose
        // `maxPages` sits below its own observed page, which is what keeps the
        // remaining bound from truncating anything.
        const observedLastPage = sweep.observedLastNonEmptyPage;
        // Opt-in, per sweep: the flag is an explicit request in the document,
        // and reading its absence as "on" would hold a future sweep to a budget
        // its author never asked for.
        const honoursCategoryVolume = sweep.stopWhenCategoryCandidateVolumeReached === true;
        let volumeStoppedAtPage: number | null = null;
        let grewBeyondObserved = false;

        for (let page = 1; page <= sweep.maxPages; page += 1) {
            if (atLimit()) {
                break;
            }
            // Checked BEFORE the request, which is the point: once every
            // category this run can file under is full, each further page costs
            // a token from the same 900/hour budget and yields nothing.
            if (honoursCategoryVolume && everyInScopeCategoryFull()) {
                volumeStoppedAtPage = page - 1;
                break;
            }
            // Wrapped at the boundary (§9): a sweep that dies on page 43 of a
            // dataset is reported as this stage's failure naming that sweep,
            // not as a vendor error the caller has to interpret.
            let rows: UsdaFoodSummary[];
            try {
                rows = await listFoodsForDataType(sweep.dataType, sweep.pageSize, page);
            } catch (error) {
                throw asImportFailure(error, { sweepKey: sweep.sweepKey });
            }
            if (rows.length === 0) {
                break;
            }
            if (observedLastPage !== undefined && page > observedLastPage) {
                // Not a warning about a problem: it is the evidence that the
                // dataset has grown past its last measurement, which is what
                // tells a curator to re-measure and confirm `maxPages` still
                // sits above the data. Recorded once per sweep.
                grewBeyondObserved = true;
            }

            for (const row of rows) {
                if (atLimit()) {
                    break;
                }
                const description = (row.description ?? '').trim();
                if (description.length === 0) {
                    continue;
                }
                if (sweep.skipFdcIdsPresentInFoods !== false && curatedIds.has(row.fdcId)) {
                    skipped.skippedCuratedFdcId += 1;
                    continue;
                }
                if (assignments.has(row.fdcId)) {
                    skipped.skippedDuplicateInPlan += 1;
                    continue;
                }

                const brand = brandExclusionReason(description, manifest.sweepBrandExclusionRules);
                if (brand !== null) {
                    skipped.skippedBrandPattern += 1;
                    continue;
                }

                const classification = classifyDescription(description, manifest.sweepClassificationRules);
                if (classification.excluded) {
                    skipped.skippedExcludedClass += 1;
                    continue;
                }
                if (!inScope(classification.category)) {
                    skipped.skippedCategoryFilter += 1;
                    continue;
                }
                // The per-record half of the volume budget: this category has
                // the candidates the coverage plan asks for, so one more would
                // overfill it. Other categories on this same page are still
                // accepted, which is why this is a `continue` and the page loop
                // above stops only when every one of them is full.
                if (honoursCategoryVolume && !hasCategoryCapacity(classification.category)) {
                    skipped.skippedCategoryVolumeReached += 1;
                    continue;
                }

                const foodState = resolveFoodState(description, sweep.dataType, manifest.sweepFoodStateRules);
                const identity = `${normalizeCanonicalName(description)}\u0000${foodState}`;
                if (curatedIdentities.has(identity)) {
                    // A curated identity is reviewed and is pinned by name in
                    // the search benchmark. dedupeIdentity's survivor tiebreak
                    // is the lexicographically smaller source key and knows
                    // nothing about curation, so the collision is avoided here
                    // rather than resolved later in the curated row's favour.
                    skipped.skippedCuratedIdentity += 1;
                    continue;
                }

                assignments.set(row.fdcId, {
                    kind: 'sweep',
                    sweepKey: sweep.sweepKey,
                    category: classification.category,
                    foodGroup: classification.foodGroup,
                    classified: classification.matched,
                });
                countPlanned(classification.category);
                sweepIds.push(row.fdcId);
            }
        }

        logger.info('sweep_planned', {
            stage: STAGE,
            sweepKey: sweep.sweepKey,
            dataType: sweep.dataType,
            planned: sweepIds.length,
            maxPages: sweep.maxPages,
            // Both are stated so the sweep's own output answers why it stopped:
            // a page number here means the candidate volumes ended it, and
            // `grewBeyondObserved` means the dataset now holds more pages than
            // the document's measurement records.
            volumeStoppedAtPage,
            observedLastNonEmptyPage: observedLastPage ?? null,
            grewBeyondObserved,
        });

        for (const ids of chunk(sweepIds, batchSize)) {
            batches.push({ index: batches.length, source: sweep.sweepKey, fdcIds: ids });
        }
    }

    const fingerprint = crypto
        .createHash('sha256')
        .update(JSON.stringify(batches.map((batch) => [batch.source, batch.fdcIds])))
        .digest('hex');

    return { batches, assignments, fingerprint, skipped };
};

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

/** The checkpoint this stage resumes from. */
/**
 * What a resumed run has to carry forward, and why it lives in the cursor.
 *
 * THE DEFECT THIS EXISTS FOR. Every report dimension — the outcome counters,
 * the per-category and per-check tallies, the identity and nutrition-method
 * splits, the refusal list — used to be process-local and to start at zero.
 * A run interrupted after 9,000 records and resumed therefore wrote a final
 * report describing the resumed ATTEMPT: the 9,000 records the first attempt
 * imported appeared nowhere, and the artefact a reviewer reads as the record of
 * the import understated it by most of the catalog. `batchesProcessed` was the
 * only figure that survived, because it alone was recorded durably.
 *
 * WHY THE CURSOR AND NOT THE RUN'S COUNTS. `recordCounts` and `finishRun` merge
 * ADDITIVELY into `catalog_import_runs.counts`, which is exactly right for the
 * run row: each attempt contributes its own delta and the row totals the work.
 * The report needs the opposite — a single cumulative statement of the whole
 * run — and computing it by re-merging the row would double count. The cursor
 * is the one piece of run state that is REPLACED rather than merged, and it is
 * written at the same instant as the batch index, so a snapshot taken with it
 * describes exactly the batches the index has passed: nothing is ever persisted
 * for work beyond the durable cursor, and a resumed attempt re-processes from
 * the index and re-measures those batches itself (its upserts make the repeat a
 * no-op in the catalog, and the outcome it records — `updated` rather than
 * `inserted` — is what actually happened).
 *
 * PLAN-TIME FIGURES ARE NOT CARRIED. `planned` and the `skipped*` counters are
 * recomputed identically by every attempt from the same manifest, so carrying
 * them would double them on resume. They are applied once, at report time.
 */
export interface ImportReportSnapshot {
    /** Attempts that have contributed to the figures below, including the one that saved them. */
    readonly attempts: number;
    /** The batch index the figures cover — always the cursor's own index. */
    readonly throughBatchIndex: number;
    readonly processedBatches: number;
    /** Outcome counters only: inserted, updated, candidates, quarantined, rejected, missingFromVendor. */
    readonly counts: Readonly<Record<string, number>>;
    readonly byCategory: Readonly<Record<string, number>>;
    readonly byCheck: Readonly<Record<string, number>>;
    readonly byIdentityStatus: Readonly<Record<string, number>>;
    readonly byNutritionMethod: Readonly<Record<string, number>>;
    readonly byCategoryOutcome: Readonly<Record<string, CategoryOutcomeCounts>>;
    /**
     * The refusal worklist as far as its bound. Truncation is not recorded
     * here: the report derives it per tier from `total > listed`, which stays
     * correct however the list was capped.
     */
    readonly refused: readonly QuarantinedRecord[];
}

export interface ImportCursor {
    /** Identifies the plan the indices belong to. */
    readonly fingerprint: string;
    readonly nextBatchIndex: number;
    /**
     * The report figures as of `nextBatchIndex`. Optional because a cursor
     * written by an earlier revision of this stage carries none: such a resume
     * reports the attempt it can measure and says so through
     * `runAggregation.carriedFromEarlierAttempts`, rather than failing a run
     * whose work is already committed.
     */
    readonly report?: ImportReportSnapshot;
}

/** One batch response: the records, and the observed facts about the request. */
export interface ImportBatchFetch {
    readonly details: UsdaFoodDetail[];
    readonly retrieval: UsdaBatchRetrieval;
}

export interface ImportUsdaClient {
    readonly listFoods: (dataType: string, pageSize: number, pageNumber: number) => Promise<UsdaFoodSummary[]>;
    /**
     * The records AND the retrieval facts of the request that served them, in
     * one call.
     *
     * One call rather than two on purpose. This used to be a `getFoodsBatch`
     * followed by a `describeBatchRetrieval` that re-read `usda_api_cache` —
     * which cannot establish where a response came from: the fetch's cache write
     * races the read, so a freshly fetched response was reported as a replay,
     * and the evidence record's HTTP status was then decided by that mistaken
     * origin. Only the call that reached the vendor knows whether it did, so the
     * client reports it and nothing here infers it.
     */
    readonly fetchBatch: (fdcIds: readonly number[]) => Promise<ImportBatchFetch>;
}

export interface RunImportDeps {
    readonly db: ImportDb;
    readonly runDb: CatalogRunDb;
    readonly usda: ImportUsdaClient;
    readonly manifest: UsdaManifest;
    readonly coveragePlan: CoveragePlan;
    readonly options: ImportOptions;
    readonly logger: ScriptLogger;
    readonly now: () => Date;
    /** Installs the pacing over `fetch` and returns the restore. Seamed so a test runs unpaced. */
    readonly installRateLimiter: () => () => void;
    /**
     * What the pacing actually did, read AFTER the run so the report states
     * measured attempts and pauses rather than a plan.
     *
     * Optional because an unpaced caller has nothing to report: a suite that
     * installs no limiter would otherwise have to invent a stats object, and a
     * fabricated zero is exactly what `usdaRequests.unmeasured` exists to
     * avoid. `main()` always supplies it, so every real run measures.
     */
    readonly rateLimiterStats?: () => UsdaRequestStats;
    /**
     * Publishes one report, to the destination the run names.
     *
     * The destination is part of the contract rather than a decision the writer
     * infers, because the two destinations are not the same artefact: only a
     * real run may touch `import-report.json`, and a dry run's figures are
     * hypotheses (see {@link IMPORT_REPORT_DESTINATIONS}).
     */
    readonly writeReport: (report: unknown, destination: ImportReportDestination) => void;
}

/**
 * WHERE A REPORT MAY LAND, AND WHY A DRY RUN MAY NOT LAND IN THE EVIDENCE.
 *
 * `canonical` is `data/meal-planning/reports/latest/import-report.json` — a
 * committed artefact a reviewer reads as the record of what the import
 * measured, and the file `catalog-report.ts` aggregates into.
 *
 * `dry_run_preview` exists because a dry run reports what an import WOULD do:
 * every outcome counter in it is zero by construction, nothing was written to
 * the catalog, and no run row or cursor was touched. Publishing that into the
 * canonical artefact replaced a real run's measurements with hypothetical
 * zeros, and it did so while holding no lock of any kind — `main()`
 * deliberately takes no catalog stage lock for a dry run, precisely so an
 * operator can ask what an import would cost while one is running, which means
 * a dry run could overwrite the report of the import running beside it.
 *
 * So a dry run publishes to a distinct, non-canonical preview file outside the
 * data tree, and the run logs its absolute path. The preview is disposable
 * output for the operator who asked, never evidence, and it can never be
 * mistaken for — or committed as — the artefact.
 */
export const IMPORT_REPORT_DESTINATIONS = ['canonical', 'dry_run_preview'] as const;
export type ImportReportDestination = (typeof IMPORT_REPORT_DESTINATIONS)[number];

/** The canonical evidence artefact this stage writes its half of. */
export const IMPORT_REPORT_FILE = 'import-report.json';

/**
 * The destination a set of options may publish to: a dry run gets the preview,
 * everything else the artefact.
 *
 * Exported and argument-driven so the rule — rather than its consequence — is
 * what the suite pins (Rule backend-architecture §11).
 */
export const importReportDestination = (options: ImportOptions): ImportReportDestination =>
    options.dryRun ? 'dry_run_preview' : 'canonical';

/**
 * The absolute path a destination resolves to.
 *
 * The preview path carries the process id so two operators previewing at once
 * do not overwrite each other's file, and it sits under the OS temporary
 * directory so it is outside the repository and outside every path
 * `scripts/lib/manifest.ts` will build inside the data tree.
 */
export const importReportTarget = (destination: ImportReportDestination): string =>
    destination === 'canonical'
        ? reportPath(IMPORT_REPORT_FILE)
        : path.join(os.tmpdir(), `soh-catalog-import-dry-run-${process.pid}.json`);

export interface ImportOutcome {
    /** `null` for a dry run, which deliberately opens no run — see runImport. */
    readonly runId: string | null;
    readonly resumed: boolean;
    /**
     * WHAT THIS INVOCATION DID, never what some earlier one did.
     *
     * A second run of a scope that already succeeded writes nothing and fetches
     * nothing, so every write counter here is 0 and `processedBatches` is 0 —
     * the no-op counts AAP §0.7.1 Group 3 requires of an identical rerun. It
     * used to return the stored counts of the run that did the work, which made
     * a no-op invocation report thousands of inserts it had not performed; a
     * caller comparing runs, or a report built from this, could not tell the two
     * apart. The durable totals are still available, under
     * {@link historicalCounts}, where they cannot be mistaken for this run's.
     *
     * `planned` and the plan-time `skipped*` keys are this invocation's own:
     * the plan is built before the run is claimed, so those are facts about
     * work this invocation really did.
     */
    readonly counts: Readonly<Record<string, number>>;
    readonly plannedBatches: number;
    readonly processedBatches: number;
    /**
     * True when the (kind, manifestVersion) scope had already succeeded, so this
     * invocation stopped at the claim. `resumed` alone cannot say this — it is
     * also true of a run that resumed a cursor and then imported the rest.
     */
    readonly alreadyCompleted: boolean;
    /**
     * The durable totals recorded by the run that did the work, when this
     * invocation did none; `null` otherwise. Separate from {@link counts} so
     * "this scope holds 11,983 records" and "this invocation wrote 0" are two
     * readable facts rather than one ambiguous number.
     */
    readonly historicalCounts: Readonly<Record<string, number>> | null;
}

/**
 * The count set an invocation starts from: its own plan size, its own plan-time
 * skips, and a zero for everything only a write can raise.
 *
 * One function for both the working path and the already-completed path, so the
 * no-op counts cannot drift from the real ones into a different set of keys — a
 * consumer reading `counts.inserted` must find the key whether or not this
 * invocation did any work.
 */
export const initialImportCounts = (plan: ImportPlan): Record<string, number> => ({
    planned: plan.assignments.size,
    inserted: 0,
    updated: 0,
    candidates: 0,
    quarantined: 0,
    rejected: 0,
    missingFromVendor: 0,
    // The durable batch counter belongs in the zero shape too. It is the one
    // additive key recorded as the run goes rather than at the end, so a no-op
    // invocation that omitted it reported a counts object one key SHORT of the
    // working path's — and a consumer reading `counts.batchesProcessed` on an
    // already-completed scope found `undefined` where every other figure was 0.
    batchesProcessed: 0,
    ...plan.skipped,
});

/**
 * One record this stage refused to publish, as the report lists it.
 *
 * The failing check names are carried, not a prose reason: every name is a
 * member of `CATALOG_CHECK_NAMES`, so the list stays greppable and the
 * coverage plan's own vocabulary is the only one the artefact uses.
 */
export interface QuarantinedRecord {
    readonly sourceKey: string;
    readonly fdcId: number;
    readonly category: string;
    readonly foodState: string;
    readonly publicationStatus: string;
    readonly failedChecks: readonly string[];
}

/** The per-category outcome split the report's `categories` rows are built from. */
interface CategoryOutcomeCounts {
    /** Every record written for the category, whatever its publication status. */
    written: number;
    candidates: number;
    quarantined: number;
    rejected: number;
}

/**
 * What ONE batch's transaction did, and the reason the report's totals are
 * assembled from these rather than mutated in place.
 *
 * Every field here is produced inside the batch's transaction and merged into
 * the run's in-memory totals only after that transaction has COMMITTED. The
 * previous revision added to the totals inside the transaction, so a batch that
 * rolled back — a statement timeout, a serialisation failure, a vendor-shaped
 * record the persist step refused — left its rows absent from the database and
 * its counts present in the report for the rest of the run: an import that
 * reported 12,000 records written where 11,980 existed, with nothing to say
 * which reading was wrong. A delta the commit gates is what makes the totals a
 * statement about the database rather than about the attempt.
 */
interface BatchDelta {
    /** The additive ledger keys: inserted, updated, candidates, quarantined, rejected, missingFromVendor, batchesProcessed. */
    readonly counts: Record<string, number>;
    readonly byCategory: Record<string, number>;
    readonly byCheck: Record<string, number>;
    readonly byIdentityStatus: Record<string, number>;
    readonly byNutritionMethod: Record<string, number>;
    readonly categoryOutcomes: Map<string, CategoryOutcomeCounts>;
    /**
     * Every record this batch refused, uncapped — a batch is at most
     * `detailBatchSize` records, so the list is bounded by construction. The
     * report's cap is applied when the delta is merged, not here: a rolled-back
     * batch must not consume slots in a list it never contributed to.
     */
    readonly quarantined: QuarantinedRecord[];
}

const emptyBatchDelta = (): BatchDelta => ({
    counts: {},
    byCategory: {},
    byCheck: {},
    byIdentityStatus: {},
    byNutritionMethod: {},
    categoryOutcomes: new Map<string, CategoryOutcomeCounts>(),
    quarantined: [],
});

const bumpCount = (target: Record<string, number>, key: string, by = 1): void => {
    target[key] = (target[key] ?? 0) + by;
};

const mergeCountMap = (target: Record<string, number>, delta: Readonly<Record<string, number>>): void => {
    for (const [key, value] of Object.entries(delta)) {
        bumpCount(target, key, value);
    }
};

/**
 * Runs the import: plan, then fetch and persist batch by batch, checkpointing
 * as it goes.
 *
 * The plan is built first and in full, so the run knows how much work it has
 * before it spends a request on any of it, and so a resume can be refused
 * rather than misaligned when the plan has changed underneath it. Records are
 * fetched, mapped and written one batch at a time and never accumulated: a
 * full sweep is ~11,500 detail records, and holding them would cost hundreds
 * of megabytes for no benefit.
 */
/**
 * The checkpoint key this invocation may claim.
 *
 * The canonical full import claims the manifest version itself, and only it
 * ever completes that key. A run narrowed by `--category` or `--limit` covers
 * part of the plan, so it claims a key naming its own restriction: it can still
 * resume and still refuses to redo itself, but it cannot answer for work it
 * never attempted. The suffix is derived from the options so two different
 * restrictions never share a run.
 */
export const importRunScope = (manifestVersion: string, options: ImportOptions): string => {
    const restricted = options.categories.length > 0 || options.limit !== null;
    if (!restricted) {
        return manifestVersion;
    }

    const scope = JSON.stringify({
        categories: [...options.categories].sort(),
        limit: options.limit,
    });

    return `${manifestVersion}+partial:${crypto.createHash('sha256').update(scope).digest('hex').slice(0, 16)}`;
};

// ---------------------------------------------------------------------------
// The durable report snapshot (see ImportReportSnapshot).
//
// Three pure functions, all argument-driven so the resume arithmetic is pinned
// by the suite rather than inferred from a run (Rule backend-architecture §11):
// what may be carried, how a stored snapshot is read back, and how the carried
// figures and the live ones are added up.
// ---------------------------------------------------------------------------

/**
 * The counters a resumed run carries forward: measured outcomes only.
 *
 * `planned` and every `skipped*` counter are recomputed identically from the
 * manifest by each attempt, so carrying them would double them.
 */
export const CARRIED_IMPORT_COUNT_KEYS: readonly string[] = [
    'inserted',
    'updated',
    'candidates',
    'quarantined',
    'rejected',
    'missingFromVendor',
];

const numericRecordOf = (value: unknown): Record<string, number> => {
    const result: Record<string, number> = {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return result;
    }
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry === 'number' && Number.isFinite(entry)) {
            result[key] = entry;
        }
    }
    return result;
};

const addNumericRecords = (
    left: Readonly<Record<string, number>>,
    right: Readonly<Record<string, number>>,
): Record<string, number> => {
    const sum: Record<string, number> = { ...left };
    for (const [key, value] of Object.entries(right)) {
        sum[key] = (sum[key] ?? 0) + value;
    }
    return sum;
};

const categoryOutcomeRecordOf = (value: unknown): Record<string, CategoryOutcomeCounts> => {
    const result: Record<string, CategoryOutcomeCounts> = {};
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return result;
    }
    for (const [category, entry] of Object.entries(value as Record<string, unknown>)) {
        const counts = numericRecordOf(entry);
        result[category] = {
            written: counts.written ?? 0,
            candidates: counts.candidates ?? 0,
            quarantined: counts.quarantined ?? 0,
            rejected: counts.rejected ?? 0,
        };
    }
    return result;
};

const addCategoryOutcomes = (
    carried: Readonly<Record<string, CategoryOutcomeCounts>>,
    live: ReadonlyMap<string, CategoryOutcomeCounts>,
): Record<string, CategoryOutcomeCounts> => {
    const sum: Record<string, CategoryOutcomeCounts> = {};
    for (const [category, counts] of Object.entries(carried)) {
        sum[category] = { ...counts };
    }
    for (const [category, counts] of live) {
        const existing = sum[category];
        sum[category] =
            existing === undefined
                ? { ...counts }
                : {
                      written: existing.written + counts.written,
                      candidates: existing.candidates + counts.candidates,
                      quarantined: existing.quarantined + counts.quarantined,
                      rejected: existing.rejected + counts.rejected,
                  };
    }
    return sum;
};

/**
 * A refusal record as the snapshot stores it, or `null` when the stored value
 * is not one — a cursor is JSONB and this stage reads back what some earlier
 * revision of it wrote, so every field is checked rather than asserted.
 */
const refusalRecordOf = (value: unknown): QuarantinedRecord | null => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return null;
    }
    const record = value as Partial<QuarantinedRecord>;
    if (
        typeof record.sourceKey !== 'string' ||
        typeof record.fdcId !== 'number' ||
        typeof record.category !== 'string' ||
        typeof record.foodState !== 'string' ||
        typeof record.publicationStatus !== 'string'
    ) {
        return null;
    }
    return {
        sourceKey: record.sourceKey,
        fdcId: record.fdcId,
        category: record.category,
        foodState: record.foodState,
        publicationStatus: record.publicationStatus,
        failedChecks: Array.isArray(record.failedChecks)
            ? record.failedChecks.filter((check): check is string => typeof check === 'string')
            : [],
    };
};

/**
 * Reads a stored snapshot back off a cursor, or `null` when the cursor carries
 * none or carries something unusable.
 *
 * A cursor whose snapshot cannot be read is treated as an absent one rather
 * than as a failure: the batch index beside it is still valid, the work it
 * names is already committed to the catalog, and refusing to resume would
 * abandon it. The report says which case it is.
 */
export const readImportReportSnapshot = (cursor: unknown): ImportReportSnapshot | null => {
    if (cursor === null || typeof cursor !== 'object' || Array.isArray(cursor)) {
        return null;
    }
    const stored = (cursor as Partial<ImportCursor>).report;
    if (stored === null || stored === undefined || typeof stored !== 'object' || Array.isArray(stored)) {
        return null;
    }
    const snapshot = stored as Partial<ImportReportSnapshot>;
    const refused = Array.isArray(snapshot.refused)
        ? snapshot.refused.map(refusalRecordOf).filter((record): record is QuarantinedRecord => record !== null)
        : [];

    return {
        attempts: typeof snapshot.attempts === 'number' && snapshot.attempts > 0 ? Math.floor(snapshot.attempts) : 1,
        throughBatchIndex: typeof snapshot.throughBatchIndex === 'number' ? Math.max(0, snapshot.throughBatchIndex) : 0,
        processedBatches: typeof snapshot.processedBatches === 'number' ? Math.max(0, snapshot.processedBatches) : 0,
        counts: numericRecordOf(snapshot.counts),
        byCategory: numericRecordOf(snapshot.byCategory),
        byCheck: numericRecordOf(snapshot.byCheck),
        byIdentityStatus: numericRecordOf(snapshot.byIdentityStatus),
        byNutritionMethod: numericRecordOf(snapshot.byNutritionMethod),
        byCategoryOutcome: categoryOutcomeRecordOf(snapshot.byCategoryOutcome),
        refused,
    };
};

/**
 * The live figures added to the carried ones — the whole run as of one batch
 * index, which is what both the checkpoint and the final report state.
 *
 * The refusal list is carried in order (earlier attempts first) and deduplicated
 * by source key, because a resumed attempt re-processes the batches between the
 * cursor and wherever the previous attempt stopped and would otherwise list the
 * same record twice; it is then bounded by the same limit the live list uses, and
 * the report derives truncation from `total > listed`.
 */
export const combineImportReportFigures = (input: {
    readonly carried: ImportReportSnapshot | null;
    readonly attempts: number;
    readonly throughBatchIndex: number;
    readonly processedBatches: number;
    readonly counts: Readonly<Record<string, number>>;
    readonly byCategory: Readonly<Record<string, number>>;
    readonly byCheck: Readonly<Record<string, number>>;
    readonly byIdentityStatus: Readonly<Record<string, number>>;
    readonly byNutritionMethod: Readonly<Record<string, number>>;
    readonly byCategoryOutcome: ReadonlyMap<string, CategoryOutcomeCounts>;
    readonly refused: readonly QuarantinedRecord[];
    readonly refusalListLimit: number;
}): ImportReportSnapshot => {
    const carried = input.carried;
    const liveCounts: Record<string, number> = {};
    for (const key of CARRIED_IMPORT_COUNT_KEYS) {
        liveCounts[key] = input.counts[key] ?? 0;
    }

    const seen = new Set<string>();
    const refused: QuarantinedRecord[] = [];
    for (const record of [...(carried?.refused ?? []), ...input.refused]) {
        if (seen.has(record.sourceKey) || refused.length >= input.refusalListLimit) {
            continue;
        }
        seen.add(record.sourceKey);
        refused.push(record);
    }

    return {
        attempts: input.attempts,
        throughBatchIndex: input.throughBatchIndex,
        processedBatches: (carried?.processedBatches ?? 0) + input.processedBatches,
        counts: addNumericRecords(carried?.counts ?? {}, liveCounts),
        byCategory: addNumericRecords(carried?.byCategory ?? {}, input.byCategory),
        byCheck: addNumericRecords(carried?.byCheck ?? {}, input.byCheck),
        byIdentityStatus: addNumericRecords(carried?.byIdentityStatus ?? {}, input.byIdentityStatus),
        byNutritionMethod: addNumericRecords(carried?.byNutritionMethod ?? {}, input.byNutritionMethod),
        byCategoryOutcome: addCategoryOutcomes(carried?.byCategoryOutcome ?? {}, input.byCategoryOutcome),
        refused,
    };
};

/**
 * Reports what a dry run would write, without a run row, a cursor or a
 * completion — see the note at the call site.
 */
const reportDryRun = async (
    deps: RunImportDeps,
    plan: ImportPlan,
    coveragePlan: CoveragePlan,
): Promise<ImportOutcome> => {
    const counts: Record<string, number> = {
        planned: plan.assignments.size,
        inserted: 0,
        updated: 0,
        candidates: 0,
        quarantined: 0,
        rejected: 0,
        missingFromVendor: 0,
        ...plan.skipped,
    };

    deps.logger.info('dry_run_planned', {
        stage: STAGE,
        batches: plan.batches.length,
        records: plan.assignments.size,
        planFingerprint: plan.fingerprint.slice(0, 16),
        note: 'no run row, cursor or completion was written, so the canonical import is unaffected',
        previewReport: importReportTarget('dry_run_preview'),
    });

    // The PREVIEW destination, never the canonical artefact: these counters are
    // hypotheses about an import that has not happened, and this invocation
    // holds no stage lock (see IMPORT_REPORT_DESTINATIONS).
    deps.writeReport(
        {
            stage: STAGE,
            reportKind: 'dry_run_preview',
            reportKindBasis:
                'A preview of the plan, not evidence of an import: every outcome counter below is zero because nothing was fetched, written or validated, and this invocation held no catalog stage lock. The canonical import-report.json was not touched.',
            generatedAt: deps.now().toISOString(),
            runId: null,
            usdaManifestVersion: deps.manifest.usdaManifestVersion,
            coveragePlanVersion: coveragePlan.coveragePlanVersion,
            planFingerprint: plan.fingerprint,
            options: {
                categories: deps.options.categories,
                limit: deps.options.limit,
                resume: deps.options.resume,
                dryRun: true,
                manifestVersion: deps.options.manifestVersion,
            },
            plannedBatches: plan.batches.length,
            processedBatches: 0,
            counts,
            byCategory: {},
            failedChecks: {},
            // A plan-time fact, so a dry run can state it: both mechanisms are
            // applied while the work list is built, before any fetch. The measured
            // blocks (categories, failuresByCheck, quarantined) are deliberately
            // NOT here — nothing was validated or written, and an empty block
            // would read as "none found" rather than "never looked".
            duplicatesRemoved: buildDuplicatesRemovedBlock(plan),
            // Reported for a dry run too, because a dry run really does spend
            // vendor requests: buildImportPlan walks the dataset sweeps through
            // /foods/list to decide the batches. Omitting the block would make the
            // one command an operator runs to find out what an import costs the
            // only one that does not say what it cost.
            usdaRequests: buildUsdaRequestsBlock(deps.manifest, deps.rateLimiterStats),
            note: 'dry run: the plan only. Any dataset-sweep enumeration pages the plan needed were fetched and are counted in usdaRequests (attempts states how many), but no detail record was fetched, nothing was written, and no run or checkpoint state was touched, so the canonical import still has its work to do.',
        },
        'dry_run_preview',
    );

    return {
        runId: null,
        resumed: false,
        counts,
        plannedBatches: plan.batches.length,
        processedBatches: 0,
        // A dry run claims no run row, so it can neither complete a scope nor
        // find one completed: it has no history to report and is not a no-op
        // invocation of an imported scope, it is a plan.
        alreadyCompleted: false,
        historicalCounts: null,
    };
};

/**
 * How many refused records the report lists by source key before it stops.
 *
 * Generous enough to carry every refusal a healthy run produces (the observed
 * figure is under 100), and bounded so a systematically failing run — a bound
 * mis-set in the coverage plan, say — writes a report an operator can still
 * open. `quarantinedListTruncated` states when it bound.
 */
const QUARANTINE_LIST_LIMIT = 500;

/** Accumulates one written record into its category's outcome split. */
const countCategoryOutcome = (
    byCategory: Map<string, CategoryOutcomeCounts>,
    category: string,
    publicationStatus: string,
): void => {
    const row = byCategory.get(category) ?? { written: 0, candidates: 0, quarantined: 0, rejected: 0 };
    row.written += 1;
    if (publicationStatus === 'candidate') {
        row.candidates += 1;
    } else if (publicationStatus === 'quarantined') {
        row.quarantined += 1;
    } else if (publicationStatus === 'rejected') {
        row.rejected += 1;
    }
    byCategory.set(category, row);
};

/** Adds one batch's per-category outcome rows into the run's totals, after its commit. */
const mergeCategoryOutcomes = (
    target: Map<string, CategoryOutcomeCounts>,
    delta: ReadonlyMap<string, CategoryOutcomeCounts>,
): void => {
    for (const [category, row] of delta) {
        const total = target.get(category) ?? { written: 0, candidates: 0, quarantined: 0, rejected: 0 };
        total.written += row.written;
        total.candidates += row.candidates;
        total.quarantined += row.quarantined;
        total.rejected += row.rejected;
        target.set(category, total);
    }
};

/**
 * Groups the failing-check totals by the tier that decides what the check
 * costs a record, which is the shape `failuresByCheck` carries.
 *
 * The tier is asked of `catalog.logic.ts` rather than restated: a check moved
 * from `review` to `quarantine` there must move here with it, and a second
 * table in this file is how the two would come to disagree (§7).
 */
const groupChecksByTier = (byCheck: Readonly<Record<string, number>>): Record<string, Record<string, number>> => {
    const grouped: Record<string, Record<string, number>> = { reject: {}, quarantine: {}, review: {} };
    for (const [name, count] of Object.entries(byCheck)) {
        // A name the vocabulary does not carry is reported under `unknown`
        // rather than dropped: a count this file cannot classify is still a
        // count, and losing it would understate the refusals.
        const tier = isCatalogCheckName(name) ? catalogCheckTier(name) : 'unknown';
        const bucket = grouped[tier] ?? {};
        bucket[name] = count;
        grouped[tier] = bucket;
    }
    return grouped;
};

/** Whether a string is one of the check names `catalog.logic.ts` declares. */
const isCatalogCheckName = (name: string): name is CatalogCheckName =>
    (Object.values(CATALOG_CHECK_NAMES) as readonly string[]).includes(name);

/**
 * The report's coverage half: one row per coverage-plan category, the
 * categories the plan does not declare, and the exact shortfall.
 *
 * TWO MEASURES, KEPT APART, BECAUSE THEY ANSWER DIFFERENT QUESTIONS.
 * `candidates` against `candidateVolume` is what THIS stage can be held to: it
 * produced candidates, and a category short of its volume is a gap the import
 * is the one to close. `published` against `publishedTarget` is the
 * requirement, and it is 0 here for every category BY DESIGN — this stage
 * never publishes (see importPublicationStatus) — so the shortfall it reports
 * is the whole target until `catalog:validate` runs. That is stated rather
 * than softened: AAP §0.7.3 requires the shortfall exactly, never rounded,
 * estimated or fabricated, and `shortfallBasis` is how the number is read
 * correctly instead of made comfortable.
 *
 * The shortfall arithmetic itself is `catalog.logic.ts`'s, not this file's: it
 * is the rule that decides whether a requirement is met, and a second
 * `max(0, target − published)` written here is how the two would diverge (§7).
 */
const buildImportReportCoverage = (
    coveragePlan: CoveragePlan,
    policy: CatalogValidationPolicy,
    byCategoryOutcome: ReadonlyMap<string, CategoryOutcomeCounts>,
): Record<string, unknown> => {
    // Published rows per category: zero for each category this run wrote to,
    // because this stage publishes nothing. The categories are listed rather
    // than an empty object passed, so `unknownCategories` still does its job —
    // a category this run wrote rows for that the coverage plan does not
    // declare is surfaced by the comparison rather than silently absorbed.
    const publishedByCategory: Record<string, number> = {};
    for (const category of byCategoryOutcome.keys()) {
        publishedByCategory[category] = 0;
    }
    const shortfall = computeCoverageShortfall(policy, publishedByCategory);
    const shortfallByCategory = new Map(shortfall.categories.map((row) => [row.category, row]));

    const categories = coveragePlan.categories.map((planned) => {
        const outcome = byCategoryOutcome.get(planned.category) ?? {
            written: 0,
            candidates: 0,
            quarantined: 0,
            rejected: 0,
        };
        const row = shortfallByCategory.get(planned.category);
        return {
            category: planned.category,
            publishedTarget: planned.publishedTarget,
            candidateVolume: planned.candidateVolume,
            candidates: outcome.candidates,
            recordsWritten: outcome.written,
            quarantined: outcome.quarantined,
            rejected: outcome.rejected,
            published: row?.published ?? 0,
            shortfall: row?.shortfall ?? planned.publishedTarget,
            candidateVolumeShortfall: Math.max(0, planned.candidateVolume - outcome.candidates),
        };
    });

    return {
        categories,
        categoriesLegend: {
            publishedTarget: "The category's publishedTarget in coverage-plan.v1.json.",
            candidateVolume: "The category's candidateVolume in coverage-plan.v1.json, ceil(1.25 x publishedTarget).",
            candidates: 'Records this run wrote for the category with publication_status candidate.',
            recordsWritten: 'Every record this run wrote for the category, whatever its publication status.',
            quarantined: 'Records this run wrote for the category with publication_status quarantined.',
            rejected: 'Records this run wrote for the category with publication_status rejected.',
            published: 'Rows this run published: 0 for every category, because this stage never publishes.',
            shortfall: 'max(0, publishedTarget - published) from catalog.logic.ts computeCoverageShortfall. See shortfallBasis.',
            candidateVolumeShortfall:
                'max(0, candidateVolume - candidates) - the gap this stage is the one to close, and the number to read after an import.',
        },
        shortfallBasis:
            'Measured against published rows, of which this stage writes none by design, so every shortfall equals its publishedTarget until catalog:validate has run. Reported exactly rather than suppressed: it is an unmet requirement, not a metric, and softening it here is how a catalog ships short. candidateVolumeShortfall is the figure that judges THIS stage.',
        coverage: {
            publishedTotal: shortfall.publishedTotal,
            publishedTargetTotal: shortfall.publishedTargetTotal,
            shortfallTotal: shortfall.shortfallTotal,
            meetsTarget: shortfall.meetsTarget,
            candidatesTotal: categories.reduce((total, row) => total + row.candidates, 0),
            candidateVolumeTotal: categories.reduce((total, row) => total + row.candidateVolume, 0),
            unknownCategories: shortfall.unknownCategories,
        },
        // Only the categories this stage left short of their candidate volume:
        // the published-side gap is every category here and says nothing about
        // the import, so listing it as a gap would bury the real ones.
        coverageGaps: categories
            .filter((row) => row.candidateVolumeShortfall > 0)
            .map((row) => ({
                category: row.category,
                candidateVolume: row.candidateVolume,
                candidates: row.candidates,
                candidateVolumeShortfall: row.candidateVolumeShortfall,
                publishedTarget: row.publishedTarget,
            })),
    };
};

/**
 * The report keys this stage owns, and therefore the only ones it replaces.
 *
 * Every other key in the artefact belongs to a sibling — `catalog-report.ts`'s
 * aggregate sections, the release identity, the reconciliation between stages —
 * and survives an import untouched.
 */
export const IMPORT_REPORT_NOTE_KEY = 'importStageWrite';

/**
 * Writes the import half of the report file, MERGING rather than clobbering.
 *
 * WHY MERGE. `import-report.json` is not this stage's private artefact: a
 * sibling pass aggregates into the same document (release identity,
 * cross-stage reconciliation, the measurement gaps a reviewer reads), and a
 * plain writeFileSync would delete all of it every time an import ran. So the
 * existing document is read first and this report is layered over it: the keys
 * this stage measured win, and the keys it knows nothing about are preserved
 * exactly. An import therefore updates the import half and leaves the rest of
 * the file as the stage that produced it wrote it.
 *
 * A DOCUMENT THAT CANNOT BE PARSED IS REPLACED, NOT PRESERVED, and the run
 * says so: merging into a half-written or hand-edited file would carry
 * unreadable content forward under this run's name, and failing the import
 * over a stale report file would throw away work that is already committed to
 * the database. Neither is silent.
 *
 * HOW THE MERGE IS DONE, AND WHY NOT WITH A TOP-LEVEL SPREAD. Two kinds of key
 * live in this document. A stage-private key (`counts`, `usdaRequests`,
 * `aiGenerationCounts`) belongs to one stage and is replaced by it. A
 * CO-WRITTEN block — `duplicatesRemoved`, `failuresByCheck` — carries one
 * sub-key per stage (`skippedCuratedIdentityAtImport`, `importStage`,
 * `generationStage`, `validateStage`) because the three stages answer the same
 * question from three vantage points and a reader wants them side by side. A
 * top-level spread replaces the whole block, so an import used to delete
 * generation's `generationStage` sub-key and a generation run used to delete
 * the import's. `mergeStageReport` in scripts/lib/manifest.ts is the one place
 * that knows the difference, and it is shared with the generation stage's
 * writer so the two cannot drift apart.
 *
 * HOW IT IS PUBLISHED. The merge is a read-modify-write of a committed evidence
 * artefact, so it runs under the artefact directory's publication lock — two
 * stages interleaving would lose one of them entirely, even though each write
 * is atomic on its own — and the document replaces the file through
 * `writeJsonFile`'s staged-then-renamed write, so an interrupted run leaves the
 * previous complete report rather than a truncated one.
 */
export const writeImportReport = (target: string, report: unknown, log: ScriptLogger): void => {
    withArtifactPublicationLockSync(path.dirname(target), `${STAGE}:report`, () => {
        let existing: Record<string, unknown> = {};
        if (fs.existsSync(target)) {
            try {
                const parsed: unknown = JSON.parse(fs.readFileSync(target, 'utf-8'));
                // Objects only. A JSON array or scalar is a valid document and a
                // useless base to merge into, so it is treated as unusable rather
                // than spread into an object shape it does not have.
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

        const merged = mergeStageReport(existing, report as Record<string, unknown>, {
            noteKey: IMPORT_REPORT_NOTE_KEY,
            stage: STAGE,
        });

        writeJsonFile(target, merged.document);

        log.info('report_written', {
            stage: STAGE,
            file: path.basename(target),
            preservedKeys: merged.preservedKeys.length,
            preservedSubKeys: Object.keys(merged.preservedSubKeys).length,
        });
    });
};

/**
 * The two import-stage dedupe mechanisms, and whose job the third one is.
 *
 * Both of these are applied while the plan is built, before any fetch, which
 * is why a dry run can report them. The CROSS-TABLE duplicate decision is
 * deliberately not one of them.
 */
const buildDuplicatesRemovedBlock = (plan: ImportPlan): Record<string, unknown> => ({
    skippedCuratedIdentityAtImport: plan.skipped.skippedCuratedIdentity ?? 0,
    skippedDuplicateInPlanAtImport: plan.skipped.skippedDuplicateInPlan ?? 0,
    // `basisAtImport`, not `basis`: this block is co-written — the generation
    // stage contributes `generationStage` and its own prose, and the report
    // stage contributes the catalog-wide figures — so a shared `basis` key
    // meant whichever stage ran last described only its own sub-keys while
    // appearing to describe the block. Stage-suffixed, like the two counters
    // above it (scripts/lib/manifest.ts, CROSS-STAGE REPORT MERGING).
    basisAtImport:
        'Two import-stage mechanisms, both applied while the plan is built and before any fetch: a swept record whose normalised identity collides with a reviewed curated entry is never assigned, and an FDC id already in the plan is never assigned twice. The cross-table duplicate decision is deliberately NOT made here - it needs a view of the whole non-rejected table that a batch-at-a-time import cannot have - so dedupeIdentity runs in catalog:validate and its duplicate_identity counts appear in the validation report.',
});

/**
 * One refusal tier as the report states it: its own total, its own bounded
 * worklist, and truncation derived from the two.
 *
 * `tier` is the `publication_status` the block counts, so the figure is
 * self-describing rather than needing the reader to know which statuses this
 * stage can write.
 */
export const buildRefusalBlock = (
    tier: 'quarantined' | 'rejected',
    figures: ImportReportSnapshot,
): Record<string, unknown> => {
    const records = figures.refused.filter((record) => record.publicationStatus === tier);
    const total = figures.counts[tier] ?? 0;

    return {
        tier,
        total,
        listed: records.length,
        // `total > listed`, never `listed >= limit`: the worklist is capped, so
        // the only honest statement of truncation is that the run refused more
        // records than the list names.
        truncated: total > records.length,
        listLimit: QUARANTINE_LIST_LIMIT,
        records,
        basis:
            tier === 'quarantined'
                ? 'Records this run wrote with publication_status quarantined: held because a check could not be satisfied with the data available, re-validated by catalog:validate, and publishable once it can be.'
                : 'Records this run wrote with publication_status rejected: refused outright by a reject-tier check (physically impossible nutrition, a brand-pattern name, a conversion that does not reconcile) and never publishable. Counted separately from quarantined because the two are different outcomes and summing them overstates what a later pass can recover.',
    };
};

/**
 * The `usdaRequests` block, written from the limiter's own counters.
 *
 * `UsdaRequestStats` is spread VERBATIM: its field names are a contract
 * (scripts/lib/rateLimiter.ts says so, and catalog-report.ts reconciles
 * against them), so this function adds the accounting facts around it and
 * renames nothing inside it.
 *
 * WITH NO STATS SEAM THE BLOCK SAYS SO. An unpaced caller has no attempts to
 * report, and writing zeros would state that a run made no vendor request —
 * which for a real import is false. `unmeasured` plus a reason is the honest
 * shape, and it is the one the previous revision's report had to describe from
 * the outside because this block did not exist at all.
 */
const buildUsdaRequestsBlock = (
    manifest: UsdaManifest,
    readStats: (() => UsdaRequestStats) | undefined,
): Record<string, unknown> => {
    const accounting = {
        accountingBasis:
            'Attempt-based, not logical-call-based. src/services/usda.service.ts retries a bounded number of physical fetches per logical call and deliberately retries 400 alongside 408, 429 and 5xx, because USDA intermittently answers 400 to a request that succeeds when retried verbatim. One logical call can therefore cost several tokens, and the limiter counts physical attempts. Counting logical calls would understate consumption against the vendor cap.',
        // The attempt ceiling and the retryable-status set are usda.service.ts's
        // rules (MAX_ATTEMPTS, isRetryableUsdaStatus), and the module that owns
        // them is named above rather than having its numbers copied into this
        // artefact: a restated constant is one that goes stale silently, and it
        // would make a report disagree with the code that produced it (§7).
        rulesOwnedBy: 'src/services/usda.service.ts',
        rateLimitEnvVar: 'USDA_IMPORT_RATE_LIMIT_PER_HOUR',
        detailBatchSize: manifest.importLimits.detailBatchSize,
        maxListPageSize: manifest.importLimits.maxListPageSize,
        headroomPerHour: manifest.importLimits.vendorRequestsPerHour - manifest.importLimits.configuredRequestsPerHour,
        headroomReason:
            "Left on the same key for the running API's estimate, label-scan and branded-search traffic, which share the credential with this import.",
        limiterCountsPhysicalAttempts: true,
        // The ceiling is the code's, not this document's: a value above it is
        // refused at startup by getUsdaImportRateLimitPerHour and again by
        // createUsdaRateLimiter, so `configuredPerHour` can never exceed it and
        // the headroom above is a guarantee rather than a convention.
        importCeilingPerHour: USDA_IMPORT_POLICY_CAP_PER_HOUR,
        importCeilingBasis:
            'scripts/lib/rateLimiter.ts USDA_IMPORT_POLICY_CAP_PER_HOUR. USDA allows 1,000 requests/hour per key; the import is capped at 900 and refuses any higher configuration at startup, because the remaining 100/hour are the running API\'s share of the same key. 901-1,000 is legal for the vendor and illegal for this import, and a lower value only paces the import more gently.',
        pausesNote:
            'An exhausted bucket or a spent hour makes the import WAIT, never fail, so a non-zero pause count is the ceiling working rather than an error. The limiter fails the run only when its durable ledger cannot be trusted.',
        // The split IS counted, in the one place that can count it: the limiter
        // wraps the transport, so it holds each physical response and reads its
        // status, while usda.service.ts's retry ladder resolves several physical
        // answers into one logical outcome and can no longer say how many were
        // 429s. This block used to carry a sentence saying nobody counted them.
        statusClassCountsBasis:
            'Measured by scripts/lib/rateLimiter.ts at the transport, one bucket per physical attempt: 400, 408 and 429 exactly, the rest of 4xx as otherClientError, 5xx as serverError, 2xx as ok2xx, anything unreadable as otherStatus. A request that never produced a response is counted under transportFailures instead.',
        statusClassCountsIdentity:
            'attempts === ok2xx + retryable400 + timeout408 + throttled429 + otherClientError + serverError + otherStatus + transportFailures. Every admitted attempt is charged to the hour and to exactly one bucket, so this identity is how the block is checked from the artefact alone.',
    };

    if (readStats === undefined) {
        return {
            ...accounting,
            unmeasured: true,
            unmeasuredReason:
                'This invocation installed no rate limiter, so there are no attempt, pause or status counters to report — attempts, pauses, totalPausedMs, longestPauseMs, firstAttemptAt, lastAttemptAt, attemptsInWindow, ledgerKind, ledgerScope, policyCapPerHour, statusClassCounts and transportFailures are all absent rather than zero, because zero would claim the run issued no vendor request and answered none.',
        };
    }

    return { ...readStats(), ...accounting, unmeasured: false };
};

/**
 * Settles a run row an attempt is abandoning, and never replaces the failure
 * an operator has to act on.
 *
 * The cursor is left exactly as the last committed batch wrote it: the row
 * records that the attempt stopped, while the saved batch index is what
 * `--resume` continues from. A failure to record the failure is reported BESIDE
 * the original, never instead of it — the caller rethrows what it caught.
 *
 * IT MERGES NO COUNTS, AND THAT IS THE FIX FOR A DOUBLE COUNT. Each batch now
 * records its own counts inside its own transaction, so by the time this runs
 * the ledger already holds exactly the work that committed. The previous
 * revision passed this attempt's absolute totals to `finishRun`, which merges
 * additively: with the cursor saved only every fifth batch, up to four batches'
 * worth of committed rows sat beyond it, a retry reprocessed them, and their
 * counts were merged a second time — so a run that imported N records could
 * report more than N, and the overstatement grew with every retry. The totals
 * are still LOGGED here, because what this attempt did is what the operator is
 * reading; they are simply not written again.
 */
const closeFailedRun = async (
    deps: RunImportDeps,
    runId: string,
    counts: Readonly<Record<string, number>>,
    error: unknown,
): Promise<void> => {
    const failure = describeFailure(error);
    deps.logger.error('run_failed', {
        stage: STAGE,
        runId,
        code: failure.code,
        error: failure.error,
        // WHICH work item stopped, as typed fields: the batch index an operator
        // re-runs from, the FDC ids in it, and the vendor's HTTP status. These
        // used to reach the reader inside the failure's rendered sentence, which
        // is the field `safeError` now withholds because it is where a request
        // URL bearing `api_key=` would appear. See importErrorFields.
        ...failure.detail,
        attemptCounts: JSON.stringify(counts),
        note: 'each batch recorded its own counts and cursor in its own transaction, so `npm run catalog:import -- --resume` continues from the last committed batch and nothing is counted twice',
    });

    try {
        await finishRun(deps.runDb, runId, 'failed', { error, logger: deps.logger });
    } catch (closeError) {
        deps.logger.error('run_close_failed', { stage: STAGE, runId, error: safeError(closeError) });
    }
};

export const runImport = async (deps: RunImportDeps): Promise<ImportOutcome> => {
    const { manifest, coveragePlan, logger, options } = deps;

    // BEFORE THE LIMITER, THE PLAN AND THE FIRST REQUEST. An operator who
    // stated which curation they meant to import and got a different one must
    // spend no vendor request and touch no run state finding out.
    if (options.manifestVersion !== null && options.manifestVersion !== manifest.usdaManifestVersion) {
        throw new CatalogImportError(
            'manifest_version_mismatch',
            `--manifest ${options.manifestVersion} was given, but data/meal-planning/${USDA_MANIFEST_FILE} declares ` +
                `usdaManifestVersion ${manifest.usdaManifestVersion}. Re-run without --manifest to import the curation this ` +
                'checkout ships, or check out the revision that carries the one you meant.',
            { manifestVersion: options.manifestVersion },
        );
    }

    // ALSO BEFORE THE LIMITER, THE PLAN AND THE FIRST REQUEST. The manifest's
    // own `coveragePlanContract` assigns this cross-file check to the importer
    // and requires it to stop the run before the first USDA request: a category
    // or food group the two documents disagree about mis-files every record it
    // touches, and no part of the import resolves a disagreement between two
    // committed files.
    assertManifestMatchesCoveragePlan(manifest, coveragePlan, logger);

    const policy: CatalogValidationPolicy = {
        categories: coveragePlan.categories,
        validationBounds: coveragePlan.validationBounds,
    };

    const restoreFetch = deps.installRateLimiter();
    try {
        const plan = await buildImportPlan(manifest, coveragePlan, deps.usda.listFoods, options, logger);
        logger.info('plan_built', {
            stage: STAGE,
            batches: plan.batches.length,
            records: plan.assignments.size,
            fingerprint: plan.fingerprint.slice(0, 16),
            ...plan.skipped,
        });

        // A DRY RUN TOUCHES NO RUN STATE AT ALL. openOrResumeRun claims
        // (kind, manifestVersion) and finishRun closes it 'succeeded', after
        // which that pair is a permanent no-op — so a dry run that claimed the
        // canonical key would report what it *would* write and thereby stop the
        // real import from ever writing it. Reporting the plan is the whole job
        // here, and it needs no run row.
        if (options.dryRun) {
            const planned = await reportDryRun(deps, plan, coveragePlan);
            return planned;
        }

        // A run restricted by --category or --limit is NOT the canonical import,
        // and must not be able to close the canonical key. Scoping the version
        // string gives each distinct restriction its own resumable run and
        // leaves the full plan's key untouched, so "partial run, then full run"
        // imports everything instead of the partial set only.
        const runScope = importRunScope(manifest.usdaManifestVersion, options);
        const claim = await openOrResumeRun<ImportCursor>(deps.runDb, {
            kind: 'usda_import',
            manifestVersion: runScope,
            initialCursor: { fingerprint: plan.fingerprint, nextBatchIndex: 0 },
            logger,
            now: deps.now,
            // What makes `--resume` mean something. The flag was parsed and then
            // never reached the claim, so an unfinished run was continued
            // whether or not the operator asked for it — and the usage line
            // saying otherwise described no code. Passing it here makes
            // continuing explicit: without the flag an unfinished run under this
            // key is refused (`run_resume_not_requested`) and nothing is
            // written, and a run that already SUCCEEDED is still recognised and
            // still does no work, because that is not a resume.
            resume: options.resume,
        });

        if (claim.alreadyCompleted) {
            const historicalCounts = (claim.run.counts ?? {}) as Record<string, number>;
            logger.info('run_already_completed', {
                stage: STAGE,
                runId: claim.run.id,
                // Both, labelled: what this invocation did (nothing) and what
                // the scope holds. One `counts` field carrying the stored
                // totals is what made a no-op look like an import.
                counts: JSON.stringify(initialImportCounts(plan)),
                historicalCounts: JSON.stringify(historicalCounts),
                note: 'this invocation fetched nothing and wrote nothing; the counts above are its own and the historical ones belong to the run that imported the scope',
            });
            return {
                runId: claim.run.id,
                resumed: true,
                counts: initialImportCounts(plan),
                plannedBatches: plan.batches.length,
                processedBatches: 0,
                alreadyCompleted: true,
                historicalCounts,
            };
        }

        // Declared before the attempt below, so the failure path can report the
        // partial work: only `batchesProcessed` is recorded durably as the run
        // goes, and a run closed 'failed' with nothing else would say a run
        // that imported 9,000 records imported none.
        const counts: Record<string, number> = initialImportCounts(plan);
        const byCategory: Record<string, number> = {};
        const byCheck: Record<string, number> = {};
        const byIdentityStatus: Record<string, number> = {};
        const byNutritionMethod: Record<string, number> = {};
        const byCategoryOutcome = new Map<string, CategoryOutcomeCounts>();
        const quarantined: QuarantinedRecord[] = [];
        let processedBatches = 0;

        // FROM HERE THE RUN ROW EXISTS, SO EVERY EXIT HAS TO SETTLE IT.
        // An uncaught throw used to leave the row 'running' forever: the
        // checkpoint survived, so a resume still worked, but nothing on the row
        // said the attempt had stopped, and `catalog:validate`'s prerequisite
        // read cannot tell a crashed import from one still in flight. Closing
        // it 'failed' with the reason records that, and deliberately does NOT
        // touch the cursor — the saved index is what makes `--resume` pick up
        // where this attempt stopped (AAP §0.7.1 Group 3; the same shape as
        // catalog-load.ts's closeFailedRun).
        try {
        const savedCursor = claim.run.cursor;
        let startIndex = 0;
        // The figures earlier attempts of THIS run measured, as of the batch
        // index the cursor names. Restored only when the cursor belongs to this
        // plan: a changed work list restarts at zero, so its figures describe
        // batches this attempt is about to redo (see ImportReportSnapshot).
        let carriedReport: ImportReportSnapshot | null = null;
        if (claim.resumed && savedCursor !== null && typeof savedCursor === 'object') {
            const cursor = savedCursor as Partial<ImportCursor>;
            if (cursor.fingerprint === plan.fingerprint && typeof cursor.nextBatchIndex === 'number') {
                startIndex = Math.max(0, Math.min(cursor.nextBatchIndex, plan.batches.length));
                carriedReport = readImportReportSnapshot(savedCursor);
                logger.info('report_state_restored', {
                    stage: STAGE,
                    runId: claim.run.id,
                    throughBatchIndex: carriedReport?.throughBatchIndex ?? 0,
                    carriedAttempts: carriedReport?.attempts ?? 0,
                    carriedInserted: carriedReport?.counts.inserted ?? 0,
                    basis:
                        carriedReport === null
                            ? 'the cursor carries no report snapshot (written by an earlier revision of this stage), so the final report states this attempt only and says so'
                            : 'the final report states the whole run: these figures plus what this attempt measures',
                });
            } else {
                // The work list changed between runs, so the saved index names
                // a different batch than it did. Restarting is the only correct
                // reading of that, and saying so is better than resuming into
                // the wrong place; the upserts make the repeat a no-op.
                logger.warn('cursor_plan_changed', {
                    stage: STAGE,
                    runId: claim.run.id,
                    savedFingerprint: String(cursor.fingerprint ?? '').slice(0, 16),
                    planFingerprint: plan.fingerprint.slice(0, 16),
                });
                await appendRunLog(deps.runDb, claim.run.id, {
                    event: 'cursor_plan_changed',
                    planFingerprint: plan.fingerprint,
                });
            }
        }

        // THE PLAN'S OWN TOTALS, RECORDED ONCE PER RUN ROW.
        //
        // `planned` and the `skipped*` keys describe the WORK LIST, not any
        // batch, and the run ledger merges additively — so recording them on
        // every attempt would multiply them by the number of times the run was
        // resumed. A fresh run row records them here, before its first batch, so
        // an interrupted run's row already says how much work the attempt set
        // out to do; a resumed row already carries them from the attempt that
        // opened it.
        //
        // The additive keys are written at zero in the same statement, so the
        // row carries its whole shape from the moment it opens. Adding zero is
        // arithmetically nothing — the batches below still supply every real
        // increment — but it is the difference between a reader seeing
        // `inserted: 0` on a run that inserted nothing and seeing no `inserted`
        // key at all, which reads as a ledger that does not track inserts.
        if (!claim.resumed) {
            await saveCheckpoint<ImportCursor>(deps.runDb, claim.run.id, {
                cursor: { fingerprint: plan.fingerprint, nextBatchIndex: startIndex },
                // The same zero shape the outcome reports, from the one helper
                // that states it: two copies of this list drifted apart once
                // already, and the row's shape and the outcome's shape are the
                // same promise made to two readers.
                counts: initialImportCounts(plan),
            });
        }

        // This attempt's number within the run, fixed before the first batch so
        // every checkpoint of it records the same value.
        const attemptNumber = (carriedReport?.attempts ?? 0) + 1;

        // The whole run's figures as of a batch index: the carried snapshot plus
        // whatever this attempt has measured. Used both for the checkpoint and
        // for the final report, so the two can never disagree.
        const figuresThrough = (throughBatchIndex: number): ImportReportSnapshot =>
            combineImportReportFigures({
                carried: carriedReport,
                attempts: attemptNumber,
                throughBatchIndex,
                processedBatches,
                counts,
                byCategory,
                byCheck,
                byIdentityStatus,
                byNutritionMethod,
                byCategoryOutcome,
                refused: quarantined,
                refusalListLimit: QUARANTINE_LIST_LIMIT,
            });

        for (let index = startIndex; index < plan.batches.length; index += 1) {
            const batch = plan.batches[index];
            const fetchedAt = deps.now();
            // Both vendor reads are wrapped at the boundary (§9), and with the
            // batch's own ids: "USDA did not answer usably for batch 137" plus
            // the twenty ids is what an operator needs, and re-running with
            // `--resume` picks up from the checkpoint below rather than from
            // the start.
            let details: UsdaFoodDetail[];
            let retrieval: UsdaBatchRetrieval | null;
            try {
                // One call, so the records and the facts describing how they
                // were obtained cannot come from two different requests.
                const fetched = options.dryRun ? null : await deps.usda.fetchBatch(batch.fdcIds);
                details = fetched === null ? [] : fetched.details;
                retrieval = fetched === null ? null : fetched.retrieval;
            } catch (error) {
                throw asImportFailure(error, {
                    batchIndex: batch.index,
                    fdcIds: batch.fdcIds,
                    sweepKey: batch.source,
                });
            }
            // Derived from what the vendor answered, before the transaction, so
            // the whole delta below — including the records USDA did not return
            // — is computed from data the transaction does not depend on.
            const returned = new Set<number>(details.map((detail) => detail.fdcId));
            const missing = batch.fdcIds.filter((fdcId) => !returned.has(fdcId));

            if (!options.dryRun && retrieval !== null) {
                // ONE TRANSACTION PER BATCH, CARRYING THE ROWS, THE CURSOR AND
                // THE COUNTS.
                //
                // The three used to be three commits: the rows here, then
                // `saveCursor` and `recordCounts` afterwards on `runDb`, and
                // only every fifth batch. Two things followed, and both were
                // silent. A crash between them left a run whose cursor named an
                // earlier batch than its counts described, so the resume redid
                // work the ledger had already claimed; and with the cursor
                // written every fifth batch, up to four batches of committed
                // rows were invisible to it, so a retry reprocessed them and
                // (because the closure merged this attempt's absolute totals)
                // counted them twice.
                //
                // `deps.db` and `deps.runDb` are two structural views of ONE
                // Prisma client — `main()` casts the singleton for the first and
                // passes the same object as the second — so the batch's
                // transaction client can carry the ledger write too, and
                // `saveCheckpoint` run inside a caller's transaction holds its
                // row lock until that transaction commits. The batch is
                // therefore atomic in the only sense that matters to a resume:
                // its rows exist if and only if its cursor and counts say so.
                const delta = await deps.db.$transaction(
                    async (tx): Promise<BatchDelta> => {
                        const batchDelta = emptyBatchDelta();
                        for (const detail of details) {
                            const assignment = plan.assignments.get(detail.fdcId);
                            if (assignment === undefined) {
                                continue;
                            }

                            const prepared = prepareCatalogFood(detail, assignment, manifest, fetchedAt, retrieval);
                            const verdict = validateCatalogCandidate(prepared.candidate, policy);
                            const publicationStatus = importPublicationStatus(prepared, verdict);

                            const outcome = await persistPreparedFood(
                                tx,
                                prepared,
                                verdict,
                                publicationStatus,
                                fetchedAt,
                            );
                            bumpCount(batchDelta.counts, outcome);
                            bumpCount(batchDelta.counts, publicationStatusCountKey(publicationStatus));
                            bumpCount(batchDelta.byCategory, prepared.row.category);

                            // Measured from the row that was just written, not
                            // asserted from what this stage "always" writes: a
                            // report that states its own policy back to itself
                            // cannot show the policy being broken.
                            bumpCount(batchDelta.byIdentityStatus, prepared.row.identity_status);
                            bumpCount(batchDelta.byNutritionMethod, prepared.nutritionMethod);
                            countCategoryOutcome(
                                batchDelta.categoryOutcomes,
                                prepared.row.category,
                                publicationStatus,
                            );

                            const failedChecks: string[] = [];
                            for (const check of verdict.checks) {
                                if (!check.pass) {
                                    bumpCount(batchDelta.byCheck, check.name);
                                    failedChecks.push(check.name);
                                }
                            }
                            // The import-stage refusal, counted and named the
                            // same way so a quarantined record is never
                            // unexplained in the report. It is not a member of
                            // catalog.logic.ts's CATALOG_CHECK_NAMES because
                            // that registry judges the FOOD, and this judges
                            // the retrieval — see IMPORT_CHECK_MISSING_RETRIEVAL_STATUS.
                            //
                            // One entry per gap the shared floor found, rather
                            // than one for the whole record: a report that says
                            // only "evidence incomplete" cannot tell an
                            // operator whether to re-retrieve, re-export or
                            // look at the vendor boundary.
                            //
                            // COUNTED INTO THE BATCH DELTA, NOT THE RUN MAP.
                            // Everything else in this loop accumulates into
                            // `batchDelta`, which is discarded whole if the
                            // transaction rolls back and merged into the run's
                            // figures only once it commits. This counter used
                            // to increment the run-level `byCheck` directly, so
                            // a batch that rolled back left its count behind
                            // and the report described rows no database held.
                            for (const code of evidenceGapCodes(importEvidenceAssessment(prepared))) {
                                const name = importEvidenceCheckName(code);
                                bumpCount(batchDelta.byCheck, name);
                                failedChecks.push(name);
                            }

                            // Collected in full for this batch; the report's cap
                            // is applied when the delta is merged, so a batch
                            // that rolls back consumes none of the list.
                            if (publicationStatus !== 'candidate') {
                                batchDelta.quarantined.push({
                                    sourceKey: prepared.sourceKey,
                                    fdcId: prepared.fdcId,
                                    category: prepared.row.category,
                                    foodState: prepared.row.food_state,
                                    publicationStatus,
                                    failedChecks,
                                });
                            }
                        }

                        bumpCount(batchDelta.counts, 'missingFromVendor', missing.length);
                        bumpCount(batchDelta.counts, 'batchesProcessed');

                        // LAST STATEMENT IN THE TRANSACTION, AND THE REASON IT
                        // IS A TRANSACTION. The cursor names the NEXT batch, so
                        // writing it here means "everything up to and including
                        // this batch is durable" — a claim that is true because
                        // the rows above it are in the same commit. It also
                        // takes the run row's lock, which a concurrent writer of
                        // the same run then queues on rather than racing.
                        await saveCheckpoint<ImportCursor>(asRunLedger(tx), claim.run.id, {
                            cursor: { fingerprint: plan.fingerprint, nextBatchIndex: index + 1 },
                            counts: batchDelta.counts,
                        });

                        return batchDelta;
                    },
                    { timeout: TRANSACTION_TIMEOUT_MS },
                );

                // AFTER THE COMMIT, NEVER INSIDE IT. Everything below describes
                // rows that now exist.
                mergeCountMap(counts, delta.counts);
                mergeCountMap(byCategory, delta.byCategory);
                mergeCountMap(byCheck, delta.byCheck);
                mergeCountMap(byIdentityStatus, delta.byIdentityStatus);
                mergeCountMap(byNutritionMethod, delta.byNutritionMethod);
                mergeCategoryOutcomes(byCategoryOutcome, delta.categoryOutcomes);
                // Listed individually, capped, because the list is a worklist an
                // operator acts on rather than a metric: a 12,000-record refusal
                // must not produce a report too large to open, and the per-check
                // and per-category totals above stay complete either way.
                for (const record of delta.quarantined) {
                    if (quarantined.length >= QUARANTINE_LIST_LIMIT) {
                        break;
                    }
                    quarantined.push(record);
                }
                processedBatches += 1;

                // THE FIGURES A RESUME INHERITS, CARRIED WITH THE INDEX. The
                // transaction above made this batch's rows, cursor and counts
                // durable together; this write adds the report snapshot for
                // exactly the batches that are committed, taken after the delta
                // was merged, so a resumed attempt inherits the run's totals
                // without inheriting a claim about work it will redo itself. It
                // names the same index the transaction wrote and carries no
                // counts, so it can neither move the cursor nor double-count.
                await saveCheckpoint<ImportCursor>(deps.runDb, claim.run.id, {
                    cursor: {
                        fingerprint: plan.fingerprint,
                        nextBatchIndex: index + 1,
                        report: figuresThrough(index + 1),
                    },
                });
            }

            // One line per batch, after its commit, so what it reports is what
            // the database holds. There is no save interval to report against
            // any more: the checkpoint is part of the batch.
            logger.info('batch_progress', {
                stage: STAGE,
                batch: index + 1,
                ofBatches: plan.batches.length,
                inserted: counts.inserted,
                updated: counts.updated,
                candidates: counts.candidates,
                quarantined: counts.quarantined,
            });
        }

        // THE WHOLE RUN, NOT THIS ATTEMPT. Every figure below comes from the
        // carried snapshot plus what this attempt measured, so a run that was
        // interrupted and resumed reports the records it actually imported
        // rather than the tail of them (see ImportReportSnapshot). The last
        // batch always checkpoints, so these figures equal the final cursor's.
        const runFigures = figuresThrough(plan.batches.length);
        const runOutcomeCounts: Record<string, number> = {
            planned: plan.assignments.size,
            ...plan.skipped,
            ...runFigures.counts,
        };

        const report = {
            stage: STAGE,
            reportKind: 'canonical' as ImportReportDestination,
            generatedAt: deps.now().toISOString(),
            runId: claim.run.id,
            usdaManifestVersion: manifest.usdaManifestVersion,
            coveragePlanVersion: coveragePlan.coveragePlanVersion,
            planFingerprint: plan.fingerprint,
            options: {
                categories: options.categories,
                limit: options.limit,
                resume: options.resume,
                dryRun: options.dryRun,
                manifestVersion: options.manifestVersion,
            },
            plannedBatches: plan.batches.length,
            processedBatches: runFigures.processedBatches,
            counts: runOutcomeCounts,
            byCategory: runFigures.byCategory,
            failedChecks: runFigures.byCheck,
            ...buildImportReportCoverage(
                coveragePlan,
                policy,
                new Map(Object.entries(runFigures.byCategoryOutcome)),
            ),
            // How the figures above were arrived at, so a reader can tell a
            // single-attempt run from a resumed one instead of inferring it
            // from a batch count that does not add up.
            runAggregation: {
                attempts: runFigures.attempts,
                resumedFromBatchIndex: startIndex,
                batchesThisAttempt: processedBatches,
                carriedFromEarlierAttempts: carriedReport !== null,
                carriedThroughBatchIndex: carriedReport?.throughBatchIndex ?? null,
                carriedProcessedBatches: carriedReport?.processedBatches ?? 0,
                // The one field that answers "can I read these totals as the
                // run's?" without parsing prose. It is FALSE in exactly one
                // case: the cursor pointed past the first batch but carried no
                // figures, so the batches before it were measured by an
                // attempt whose numbers are gone and are not re-processed
                // here. A resume that restarts at batch 0 re-processes every
                // batch, so its figures do cover the run - rows an earlier
                // attempt already wrote are counted as updated, which is what
                // actually happened.
                figuresCoverWholeRun: carriedReport !== null || startIndex === 0,
                basis:
                    carriedReport !== null
                        ? 'A resumed run: the figures are the snapshot the cursor carried (measured by earlier attempts, through carriedThroughBatchIndex) plus what this attempt measured. Batches between the cursor and wherever the previous attempt stopped are re-processed and re-measured by this attempt, so they are counted once - as updated rather than inserted, which is what actually happened.'
                        : startIndex > 0
                          ? `A resumed attempt starting at batch ${startIndex} whose cursor carried no report snapshot (it was written by an earlier revision of this stage), so the figures cover THIS attempt only and understate the run by the batches before that index. Re-run the stage from a fresh run key if a whole-run report is required.`
                          : 'A single pass over the whole work list: every figure in this report was measured by it. A run resumed at batch 0 reads the same way, because it re-processes every batch.',
                countsExcludedFromCarry: [
                    'planned',
                    ...Object.keys(plan.skipped).sort(),
                ],
                countsExcludedFromCarryReason:
                    'Plan-time figures, recomputed identically from the manifest by every attempt. They are applied once here; carrying them would double them on resume.',
            },
            countsByIdentitySource: {
                usda: Object.values(runFigures.byIdentityStatus).reduce((total, count) => total + count, 0),
                ai_generated: 0,
                byIdentityStatus: runFigures.byIdentityStatus,
                measuredFrom: 'the identity_source and identity_status written on each catalog_foods row by this run',
                aiGeneratedZeroReason:
                    'This stage imports FoodData Central records only. An AI-estimated food can be created by catalog:generate and never here, which is what makes every row this stage writes source_backed.',
            },
            countsByNutritionProvenance: {
                source_backed: Object.values(runFigures.byNutritionMethod).reduce((total, count) => total + count, 0),
                ingredient_derived: 0,
                ai_estimated: 0,
                byNutritionMethod: runFigures.byNutritionMethod,
                measuredFrom: 'the nutrition_provenance written on each catalog_foods row and the nutrition_method on its validation record',
            },
            duplicatesRemoved: buildDuplicatesRemovedBlock(plan),
            failuresByCheck: {
                checkNameVocabulary:
                    'src/services/catalog.logic.ts CATALOG_CHECK_NAMES, with the tier per name from catalogCheckTier',
                importStage: groupChecksByTier(runFigures.byCheck),
            },
            // TWO TIERS, TWO BLOCKS. `quarantined` and `rejected` are distinct
            // publication_status values with distinct meanings — a quarantined
            // record is held because a check could not be satisfied with the
            // data available and is re-validated by a later pass, a rejected
            // one is refused outright and is never publishable. A single block
            // whose total was `quarantined + rejected` therefore reported every
            // refusal as recoverable: the committed evidence for this catalog
            // holds 74 quarantined records and 195 rejected ones, and the old
            // block called all 269 quarantined. Each block now counts its own
            // status and lists its own records, and truncation is
            // `total > listed`: a run whose refusals happen to number exactly
            // the list bound is not truncated, and the previous
            // `listed >= limit` reading called it so.
            quarantined: buildRefusalBlock('quarantined', runFigures),
            rejected: buildRefusalBlock('rejected', runFigures),
            usdaRequests: buildUsdaRequestsBlock(manifest, deps.rateLimiterStats),
            note: 'publication_status is candidate, quarantined or rejected here by design: this stage publishes nothing, catalog:validate is the stage that publishes, and the two refusal tiers are reported in their own blocks above.',
        };
        deps.writeReport(report, 'canonical');

        // No counts, for the same reason `closeFailedRun` passes none: every
        // batch recorded its own inside its own transaction and the plan's
        // totals were recorded once when the row was opened, so the ledger is
        // already exactly what committed. Merging this attempt's absolute totals
        // here would double every batch a resumed run did not perform itself.
        // `finishRun` logs the row's counts as it reads them back, so the
        // run_finished line still states the whole run's totals.
        await finishRun(deps.runDb, claim.run.id, 'succeeded', { logger });

        return {
            runId: claim.run.id,
            resumed: claim.resumed,
            counts,
            plannedBatches: plan.batches.length,
            processedBatches,
            // This invocation did the work, whether it started the scope or
            // resumed it, so its counts ARE the invocation's own and there is no
            // separate history to keep apart from them.
            alreadyCompleted: false,
            historicalCounts: null,
        };
        } catch (error) {
            await closeFailedRun(deps, claim.run.id, counts, error);
            // Rethrown, always: main() maps it to a code and a non-zero exit,
            // and swallowing it here would report a failed import as a
            // successful one (Rule backend-architecture §8).
            throw error;
        }
    } finally {
        // Unconditional: install() replaced globalThis.fetch, and leaving a
        // paced fetch behind would silently throttle everything that runs after
        // this stage in the same process.
        restoreFetch();
    }
};

/** 30 s: a batch is 20 foods and ~80 statements, well inside it, but a cold pool is not. */
const TRANSACTION_TIMEOUT_MS = 30_000;

/**
 * The refusal this stage names itself, reported beside the validation checks: a
 * mandatory field of the record's own retrieval evidence (Agent Action Plan
 * §0.3.2) is missing or unusable, so the record is held as `quarantined`.
 *
 * ITS NAME IS HISTORICAL AND STAYS THAT WAY. A null HTTP status is the gap this
 * stage was written to catch and remains the overwhelmingly likely one, so the
 * key an operator greps the report for does not change; the gap that actually
 * held the record is named in full in `quarantined[].failedChecks`, which
 * carries one entry per gap code (see {@link importEvidenceCheckName}).
 *
 * Deliberately NOT a member of `catalog.logic.ts`'s `CATALOG_CHECK_NAMES`.
 * That registry — and the tier map beside it — judges the candidate FOOD: its
 * nutrients, its identity, its portions. This judges how the response was
 * obtained, which that module neither sees nor should see, and its `name` field
 * is typed to the registry's closed union, so a retrieval fault cannot be
 * expressed there without widening a vocabulary that belongs to validation.
 * The report's `failuresByCheck` map is keyed by plain strings, so the two
 * appear side by side without either owning the other's names.
 */
export const IMPORT_CHECK_MISSING_RETRIEVAL_STATUS = 'missing_retrieval_status';

/**
 * The identity source every row this stage writes declares.
 *
 * Read by the evidence assessment below as well as written onto the validation
 * record, from this one constant: the floor asks MORE of a USDA row than of a
 * generated one (it additionally requires the `usda_api_cache` key and the
 * per-food record digest), so assessing a record under a source other than the
 * one it declares would apply the wrong set of requirements to it.
 */
const IMPORT_IDENTITY_SOURCE = 'usda';

/**
 * The evidence record this stage is about to write, assessed against the shared
 * complete-evidence floor.
 *
 * WHY THE RECORD AND NOT A FLAG. `prepared.evidence` is the exact object that
 * lands in `catalog_validation_records.identity_evidence`, and it is what
 * validation, the release exporter and the release loader each later assess
 * with this same function. Deciding this stage's disposition from one boolean
 * about one field meant a record could be written here with a non-2xx status, a
 * malformed digest, a blank cache key, a blank snippet or an unparseable
 * `fetched_at` — every one of which the three later stages refuse — and the
 * disagreement would only surface at the stage that had to reject work already
 * done. Assessing the record itself makes the four stages one rule.
 *
 * WHAT THIS IS AND IS NOT. It is defense in depth, not the closing of a live
 * publication hole: this stage writes `candidate` or `quarantined` and never
 * `published`, so an incomplete record it wrote could not have reached a
 * consumer without `catalog:validate` publishing it, and validation applies
 * this same floor. What it buys is that the record is held at the stage that
 * PRODUCED it, under the name of the gap, rather than surviving to be held
 * later by a stage that can only say the row is unpublishable.
 *
 * Recomputed at each of the three sites that need it rather than threaded
 * through `persistPreparedFood`'s signature: it is a pure read of sixteen
 * fields with no hashing and no I/O, which is nothing beside the batch's own
 * round trips, and threading it would put a derived value in three signatures
 * where it can drift from the record it describes.
 */
export const importEvidenceAssessment = (prepared: PreparedCatalogFood): EvidenceAssessment =>
    assessIdentityEvidence([prepared.evidence], { identitySource: IMPORT_IDENTITY_SOURCE });

/**
 * The report's check name for one evidence gap.
 *
 * The status gap keeps the name the report has always used, so an operator's
 * existing query still finds it; every other gap is reported under its own code
 * behind the same prefix, so two records held for different reasons are never
 * collapsed into one count. `groupChecksByTier` files names it does not know
 * under `unknown`, which is where an import-stage fault belongs — the tier map
 * grades the FOOD's checks.
 */
export const importEvidenceCheckName = (code: EvidenceGapCode): string =>
    code === 'retrieval_status_missing'
        ? IMPORT_CHECK_MISSING_RETRIEVAL_STATUS
        : `${IMPORT_CHECK_MISSING_RETRIEVAL_STATUS}:${code}`;

/**
 * What the import writes to `publication_status`.
 *
 * The import never publishes. A record the checks would accept is written as a
 * `candidate`, because publication needs the cross-table duplicate check that
 * only a pass over the whole table can make — that is `catalog:validate`'s
 * job, and keeping the two apart is what makes the import safe to re-run.
 *
 * ONE IMPORT-STAGE REFUSAL SITS ABOVE THE VERDICT. A record whose own retrieval
 * evidence is incomplete is held as `quarantined` however clean its nutrient
 * checks are, because AAP §0.3.2 makes those fields mandatory and §0.7.3
 * classes missing identity evidence as quarantine-tier. It is decided here
 * rather than in the validation checks because the fault is a property of THIS
 * STAGE'S retrieval rather than of the candidate's stated values:
 * `catalog.logic.ts` judges the food, and it neither sees nor should see how the
 * response was obtained.
 *
 * The decision is {@link importEvidenceAssessment}'s, so it is the same
 * decision validation, the exporter and the loader make about the same bytes.
 */
export const importPublicationStatus = (
    prepared: PreparedCatalogFood,
    verdict: CatalogValidationVerdict,
): string =>
    !importEvidenceAssessment(prepared).complete
        ? 'quarantined'
        : verdict.publicationStatus === 'published'
          ? 'candidate'
          : verdict.publicationStatus;

const publicationStatusCountKey = (publicationStatus: string): string =>
    publicationStatus === 'candidate'
        ? 'candidates'
        : publicationStatus === 'quarantined'
          ? 'quarantined'
          : publicationStatus === 'rejected'
            ? 'rejected'
            : 'candidates';

// ---------------------------------------------------------------------------
// Reporting.
// ---------------------------------------------------------------------------

// One structured entry per gap under a single neutral key, so a refusal is
// greppable by code and still carries the sentence that says what to do.
//
// NOT one field per gap code, which is what this did and why it is written out:
// a field NAME must be a fixed identifier, never derived from data
// (scripts/lib/logger.ts states the contract beside the vocabulary that
// enforces it). The logger redacts the value of any key whose name reads as a
// credential, matching credential phrases anywhere in the name — deliberately,
// so `serviceAccountJson` and `apiKeyHeader` cannot slip past — and
// `gap_usda_api_key_missing` reads as exactly such a name. The most important
// gap this stage can report, a missing USDA_API_KEY, therefore reached the
// operator as `"gap_usda_api_key_missing":"***"`: the requirement and the
// remedy gone, and nothing secret protected, because a requirement sentence is
// not a credential.
//
// With the code in a `code` VALUE the prose survives intact, while the value
// rules still scrub a real credential that appears inside it — an env
// assignment keeps its name and loses its value, a DSN loses its userinfo — so
// this is strictly safer than a field name that happens to avoid the
// vocabulary.
const gapFields = (gaps: readonly PrerequisiteGap[]): LogFields => ({
    stage: STAGE,
    gapCount: gaps.length,
    gaps: gaps.map((gap) => ({
        code: gap.code,
        requirement: gap.requirement,
        remedy: gap.remedy,
        // Present as `null` rather than omitted, so every entry has the same
        // shape for a report reader that indexes these events by key.
        detail: gap.detail ?? null,
    })),
});

// Every error class this file can observe gets its own reported code, so an
// operator never has to read a stack trace to know which layer refused.
// CatalogImportError and the three library classes carry a `code` of their own;
// RateLimitConfigError carries its numbers instead, so it is reported under a
// fixed code. `usda_request_failed` says the run stopped on USDA's answer (or
// its silence) rather than on a defect here, which is the difference between
// re-running with `--resume` and reading code.
//
// The bare `isUsdaError` branch is a BACKSTOP, not the main path: every call
// this stage makes is wrapped by `asImportFailure`, so a vendor error reaching
// here unwrapped means a call site was added without it. Classifying it
// correctly anyway is strictly better than reporting it as a defect, and it is
// also the contract `usda.service.test.ts` asserts from the other side.
//
// Anything unrecognised is reported through safeError under `unexpected_error`
// — it is never swallowed and never printed raw, because a raw error on this
// pipeline can carry a connection URL or a vendor key.
//
// Exported for the same reason every other decision in this file is: the code
// an operator reads is a behaviour, and `src/__tests__/scripts/` asserts it
// without running a stage.
// The reported `error` is `SafeErrorFields` — a scrubbed name plus an optional
// machine code and status, and deliberately no `message`: this value reaches the
// durable run log and the operator console, where foreign prose can carry a
// connection URL, a key or a fragment of the document that failed (CWE-532).
export const describeFailure = (error: unknown): { code: string; error: SafeErrorFields; detail?: LogFields } => {
    // First, because it is this stage's OWN error and the one every vendor
    // failure now arrives as. It already names the batch that stopped, so its
    // code is reported straight rather than re-derived from what it wrapped.
    if (isThrownInstanceOf(error, CatalogImportError)) {
        return { code: error.code, error: safeError(error), detail: importErrorFields(error) };
    }
    if (isThrownInstanceOf(error, DatabaseOriginError)) {
        return { code: error.code, error: safeError(error) };
    }
    if (isThrownInstanceOf(error, ManifestError)) {
        return { code: error.code, error: safeError(error) };
    }
    if (isThrownInstanceOf(error, ModelBudgetError)) {
        return { code: error.code, error: safeError(error) };
    }
    // The one branch that reports TYPED CONTEXT beside the code. A stage-lock
    // refusal names the stage holding the catalog graph and the mode it asked
    // for, and those are what an operator acts on — see checkpointErrorFields
    // for why they travel as data rather than inside the rendered sentence.
    if (isThrownInstanceOf(error, CheckpointError)) {
        return { code: error.code, error: safeError(error), detail: checkpointErrorFields(error) };
    }
    if (isThrownInstanceOf(error, RateLimitConfigError)) {
        return { code: 'rate_limit_misconfigured', error: safeError(error) };
    }
    if (isUsdaError(error)) {
        return { code: 'usda_request_failed', error: safeError(error) };
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

    // The URL never reaches the log, and neither does the host or the database
    // name: originLogFields is the one origin-reporting shape and carries the
    // classification, the fixed reason and an opaque target digest instead (see
    // scripts/lib/dbGuard.ts for why). dbGuard has already refused anything it
    // could not classify, so reaching this line means the origin was accepted.
    const origin = classifyDatabaseOrigin(process.env.DATABASE_URL);
    logger.info('database_origin_accepted', {
        stage: STAGE,
        ...originLogFields(origin),
    });
    logger.info('stage_invoked', {
        stage: STAGE,
        categories: parsed.options.categories,
        limit: parsed.options.limit,
        resume: parsed.options.resume,
        dryRun: parsed.options.dryRun,
        expectedManifestVersion: parsed.options.manifestVersion,
    });

    const gaps = preflight(defaultPreflightDeps());
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    // Every input is present, so the stage runs. The USDA client and the Prisma
    // client are reached here rather than at module load: both construct state
    // on import, and the suites that read parseArgs, preflight and the pure
    // derivations above must be able to do so without either.
    const usdaService = await import('../src/services/usda.service');
    const { prisma } = await import('../src/prisma/client');

    if (usdaService.MAX_BATCH_FDC_IDS !== MAX_BATCH_FDC_IDS) {
        // The client throws above its own ceiling, so a divergence would fail
        // mid-run on a batch this file had already built. Said plainly instead.
        logger.error('batch_ceiling_disagrees', {
            stage: STAGE,
            scriptCeiling: MAX_BATCH_FDC_IDS,
            clientCeiling: usdaService.MAX_BATCH_FDC_IDS,
        });
        return 1;
    }

    const manifest = loadUsdaManifest();
    const coveragePlan = loadCoveragePlan();
    const requestsPerHour = getUsdaImportRateLimitPerHour(process.env);

    // THE MANIFEST'S RATE MUST SIT UNDER THE CODE'S CEILING. The document
    // declares the rate the import is meant to run at and the vendor cap it
    // leaves headroom against; the ceiling that is actually enforced lives in
    // rateLimiter.ts. A manifest asking for more than the code will allow is a
    // disagreement an operator has to see as itself, not as a rate limit
    // silently lower than the one the document promises — the same treatment
    // the batch ceiling gets above.
    if (manifest.importLimits.configuredRequestsPerHour > USDA_IMPORT_POLICY_CAP_PER_HOUR) {
        logger.error('rate_ceiling_disagrees', {
            stage: STAGE,
            manifestConfiguredPerHour: manifest.importLimits.configuredRequestsPerHour,
            importCeilingPerHour: USDA_IMPORT_POLICY_CAP_PER_HOUR,
            vendorCapPerHour: manifest.importLimits.vendorRequestsPerHour,
            remedy: `lower importLimits.configuredRequestsPerHour in data/meal-planning/${USDA_MANIFEST_FILE} to at most ${USDA_IMPORT_POLICY_CAP_PER_HOUR}: the top ${manifest.importLimits.vendorRequestsPerHour - USDA_IMPORT_POLICY_CAP_PER_HOUR} requests/hour of the vendor cap are the running API's share of the same key`,
        });
        return 1;
    }

    // THE DOCUMENTED CACHE-KEY SCHEME MUST BE THE ONE THE IMPORT WRITES. Every
    // imported row carries a `source_cache_key`, and every validation record
    // publishes it as retrieval evidence, so a manifest describing a different
    // key than the client builds documents provenance a reader cannot check —
    // which is exactly what the earlier `/food/<fdcId>?format=full` claim did,
    // unnoticed, because nothing compared it with anything.
    const declaredScheme = (manifest as unknown as { sweepNamingPolicy?: { sourceCacheKeyScheme?: unknown } })
        .sweepNamingPolicy?.sourceCacheKeyScheme;
    const schemeDisagreements = sourceCacheKeySchemeDisagreements(declaredScheme);
    if (schemeDisagreements.length > 0) {
        logger.error('source_cache_key_scheme_disagrees', {
            stage: STAGE,
            manifestPath: `data/meal-planning/${USDA_MANIFEST_FILE} ${SOURCE_CACHE_KEY_SCHEME_MANIFEST_PATH}`,
            disagreements: schemeDisagreements.join('; '),
            importWrites: USDA_SOURCE_CACHE_KEY_SCHEME.shape,
        });
        return 1;
    }

    // And the key the client actually builds must match the declared shape, not
    // merely agree with a constant in this file. Built from a deliberately
    // unsorted, duplicated sample, which also pins the "ascending de-duplicated
    // fdc ids" the shape claims — cacheKeyForRequest normalises the id list
    // itself, so the whole scheme is checked and the check costs no request.
    const sampleKey = usdaService.cacheKeyForRequest('POST', USDA_BATCH_PATH, {}, {
        fdcIds: [2, 1, 2],
        format: USDA_BATCH_FORMAT,
    });
    const expectedSampleKey = `POST ${USDA_BATCH_PATH}?#{"fdcIds":[1,2],"format":"${USDA_BATCH_FORMAT}"}`;
    if (sampleKey !== expectedSampleKey) {
        logger.error('source_cache_key_builder_disagrees', {
            stage: STAGE,
            clientBuilds: sampleKey,
            schemeDeclares: expectedSampleKey,
            note: 'src/services/usda.service.ts cacheKeyForRequest no longer produces the shape USDA_SOURCE_CACHE_KEY_SCHEME and the manifest state, so every source_cache_key this run would write is documented wrongly',
        });
        return 1;
    }

    // Assigned by installRateLimiter below and read by rateLimiterStats, so
    // the report states what the pacing measured rather than what it intended.
    let limiter: UsdaRateLimiter | null = null;

    const importDeps: RunImportDeps = {
        db: prisma as unknown as ImportDb,
        runDb: prisma as unknown as CatalogRunDb,
        usda: {
            listFoods: (dataType, pageSize, pageNumber) => usdaService.listFoods(dataType, pageSize, pageNumber),
            // The records and their provenance come out of ONE call, and every
            // fact on the retrieval is the client's own observation: the cache
            // key it filed the response under, whether it reached the vendor,
            // the status that exchange answered with, and when the payload was
            // obtained. Nothing is re-derived here — the previous wiring read
            // `usda_api_cache` back after the fetch, which could not tell a live
            // fetch from a replay (the fetch's own cache write races the read)
            // and therefore put an unobserved HTTP status on every evidence
            // record. `toBatchRetrieval` only renames the client's vocabulary
            // into the one the evidence records publish, and digests the payload
            // the records were read out of.
            fetchBatch: async (fdcIds) => {
                const { details, retrieval } = await usdaService.getFoodsBatchWithRetrieval(fdcIds);
                return { details, retrieval: toBatchRetrieval(retrieval) };
            },
        },
        manifest,
        coveragePlan,
        options: parsed.options,
        logger,
        now: () => new Date(),
        // The limiter is held so the report can read its counters afterwards.
        // Building it inside installRateLimiter and discarding it was why the
        // report had no usdaRequests block to write: stats() was unreachable,
        // and the counters the limiter had been keeping all along went
        // unrecorded (scripts/lib/rateLimiter.ts UsdaRequestStats).
        installRateLimiter: () => {
            limiter = createUsdaRateLimiter({
                requestsPerHour,
                vendorCapPerHour: manifest.importLimits.vendorRequestsPerHour,
                // Passed explicitly although it is also the default: the
                // import's ceiling is a promise this stage makes about a shared
                // key, and a promise a reader has to infer from a default is one
                // a later edit can drop without anyone noticing. `requestsPerHour`
                // has already been bounded by getUsdaImportRateLimitPerHour, so
                // this is the second gate rather than the first.
                policyCapPerHour: USDA_IMPORT_POLICY_CAP_PER_HOUR,
                logger,
            });
            return limiter.install();
        },
        rateLimiterStats: () => {
            if (limiter === null) {
                // Unreachable through runImport, which installs before it
                // plans and reads the stats after the last batch. Throwing
                // rather than returning zeros keeps that ordering a defect if
                // it is ever broken, instead of a quietly empty report.
                throw new CatalogImportError(
                    'usda_request_failed',
                    'the rate limiter was asked for its counters before it was installed',
                );
            }
            return limiter.stats();
        },
        writeReport: (report, destination) => {
            const target = importReportTarget(destination);
            if (destination === 'canonical') {
                writeImportReport(target, report, logger);
                return;
            }

            // A PREVIEW IS NOT MERGED AND NOT LOCKED, because it shares nothing
            // with the evidence artefact: it is this invocation's own file,
            // written whole (atomically, like every artefact this pipeline
            // writes) and named in the line below so the operator who asked for
            // it can read it.
            writeJsonFile(target, report);
            logger.info('dry_run_preview_written', {
                stage: STAGE,
                file: target,
                canonicalReportUntouched: reportPath(IMPORT_REPORT_FILE),
                basis: 'a dry run reports the plan only, so it never writes the committed evidence artefact',
            });
        },
    };

    // THE IMPORT'S STAGE CLAIM, AND THE ONE INVOCATION THAT DOES NOT TAKE IT.
    //
    // A real import MUTATES the catalog graph — it upserts foods and replaces
    // their aliases and portions by source_key — so it holds the catalog-graph
    // lock EXCLUSIVELY for as long as it runs, and no second import, no
    // generation, no validation pass and no release load can hold it at the same
    // time (lib/checkpoint.ts's THE STAGE LOCK). The run claim cannot give this:
    // its advisory lock is transaction-scoped and released the moment the claim
    // commits, so it guarantees one run ROW rather than one writer, and a
    // validation pass judging a row this import is about to rewrite was the
    // difference between those two promises.
    //
    // A DRY RUN TAKES NO LOCK, for the same reason it opens no run: it reaches
    // neither `db` nor `runDb` — reportDryRun touches only the plan it was
    // handed, and the suite proves it by refusing every property access on both
    // clients — so it has nothing to exclude and nothing to be excluded from. An
    // operator must be able to ask what an import would do while one is running.
    const outcome = parsed.options.dryRun
        ? await runImport(importDeps)
        : await withCatalogStageLock({ stage: 'usda_import', logger }, () => runImport(importDeps));

    logger.info('stage_completed', {
        stage: STAGE,
        runId: outcome.runId,
        resumed: outcome.resumed,
        alreadyCompleted: outcome.alreadyCompleted,
        plannedBatches: outcome.plannedBatches,
        processedBatches: outcome.processedBatches,
        // This invocation's own counts, always. The scope's durable totals are
        // reported beside them and only when this invocation did no work, so a
        // no-op rerun reads as one instead of as a second import.
        counts: JSON.stringify(outcome.counts),
        ...(outcome.historicalCounts === null
            ? {}
            : {
                  historicalCounts: JSON.stringify(outcome.historicalCounts),
                  note: 'this scope had already succeeded, so this invocation fetched nothing and wrote nothing; historicalCounts belongs to the run that imported it',
              }),
    });

    await prisma.$disconnect();
    return 0;
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
                // Spread, not nested: these are typed facts about the failure
                // (a run id, the stage holding the catalog graph, the mode it
                // asked for), and they read as fields of the failure rather
                // than as one opaque member. Absent for every failure that is
                // not a stage-lock refusal, which is the only branch that
                // supplies them.
                ...failure.detail,
            });
            process.exit(1);
        });
}
