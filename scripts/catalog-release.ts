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
// WHAT MAKES THE MANIFEST LOAD-BEARING. Every member's SHA-256, row count and
// size are measured from the bytes on disk after the write, not from the
// strings in memory — a digest taken before the write would not catch a write
// that failed halfway. catalog-load.ts verifies all six digests before it
// writes anything, so a truncated or hand-edited member is refused instead of
// half-loaded.
//
// components.jsonl IS WRITTEN EVEN WHEN EMPTY, AND ITS EMPTINESS IS CHECKED. A
// release built entirely from source-backed single-ingredient records has no
// derived compositions, so the file has no rows. It is still written, and the
// manifest still records its digest, its row count of 0 and its size of 0: that
// is what makes an empty member an asserted empty set rather than a missing
// file, and it keeps the loader's six-digest check total. Inventing a
// composition to fill it would fabricate a nutrient total, which the catalog
// policy forbids outright.
//
// Presence alone would not settle it, though: a zero-row member and a
// components export that silently dropped every row are indistinguishable on
// disk, because the digest of an empty file verifies either way. So the export
// asserts the invariant that makes the count meaningful — every published
// `ingredient_derived` food must carry at least one component row, since
// otherwise its nutrient totals have no stored composition to have been derived
// from — and raises ReleaseIntegrityError when one does not. An empty
// components.jsonl is therefore a PROVEN consequence of publishing no
// ingredient-derived food, and never an unexplained blank.
//
// WHAT THE EXPORTED BYTES ARE A SNAPSHOT OF. The published graph and the
// pipeline run ledger are read in ONE Repeatable Read transaction, so the
// manifest's counts and the prerequisite-order check describe the same database
// state rather than two states a concurrent ingest moved between. The stage also
// holds the catalog-graph lock SHARED for its whole run (lib/checkpoint.ts's THE
// STAGE LOCK), which is refused while any mutating stage holds it exclusively,
// and it refuses outright when the ledger shows a mutating run still marked
// 'running' — a crashed stage's half-written work is not something to freeze
// into a reviewed artefact.
//
// A RELEASE IS REFUSED RATHER THAN SHIPPED INCOMPLETE. Every published food
// must carry a validation record — that record is the machine-readable
// evidence the feature requires — so a published row without one raises
// ReleaseIntegrityError and nothing is written. The per-category coverage
// shortfall is reported exactly, never rounded and never omitted: a shortfall
// is an unmet requirement, and a release that hides one is worse than a
// release that states it.
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
import {
    ManifestError,
    assertReleaseVersion,
    assertSafePathSegment,
    loadCoveragePlan,
    releaseDir,
} from './lib/manifest';
import type {
    CatalogReleaseManifest,
    CatalogReleaseModelVersions,
    CoverageCategory,
    CoveragePlan,
} from './lib/manifest';
import { ModelBudgetError } from './lib/budget';
import { RateLimitConfigError } from './lib/rateLimiter';
import {
    CheckpointError,
    GRAPH_MUTATING_RUN_KINDS,
    canonicalValidationRunKey,
    catalogInputIdentity,
    isRestrictedValidationRunKey,
    validationRunKeyInputPart,
    validationRunKeyNamesInput,
    withCatalogStageLock,
} from './lib/checkpoint';
import type { CatalogRunKind } from './lib/checkpoint';
import type { ScriptLogger } from './lib/logger';
import { assessComponentCoverage, computeCoverageShortfall } from '../src/services/catalog.logic';
import crypto from 'crypto';

const STAGE = 'catalog-release';

const CATALOG_LOGIC_MODULE = 'src/services/catalog.logic.ts';

const RELEASE_FLAG = '--release';

// `--version` is the flag the feature's file-level specification names for the
// release id, `--release` the one the pipeline's other stages and the operator
// documentation already use (`catalog:load -- --release v1`). Both are accepted
// and mean the same thing, because making an operator remember which stage
// spells it which way is the kind of difference that ends in a release cut
// under the wrong id. Given twice with DIFFERENT values it is a refusal, not a
// precedence rule: there is no reading of two release ids that is safe to guess.
const VERSION_FLAG = '--version';

const OUT_FLAG = '--out';

const logger = createLogger(STAGE);

// ---------------------------------------------------------------------------
// Argument parsing — pure (Rule backend-architecture §1.2).
// ---------------------------------------------------------------------------

export interface ReleaseOptions {
    readonly help: boolean;
    /** The release id exactly as the operator typed it; validated in preflight. */
    readonly release: string;
    readonly force: boolean;
    /**
     * The directory the release directory is created INSIDE, when the operator
     * named one, or `null` for the repository's own
     * `data/meal-planning/catalog/releases`. A release cut somewhere else is
     * still a release — it is reviewed, checksummed and loadable — so the
     * override changes where the six members land and nothing else about them.
     */
    readonly outRoot: string | null;
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
        return { ok: true, options: { help: true, release: '', force: false, outRoot: null } };
    }

    const errors: ArgumentError[] = [];
    let release: string | null = null;
    /** Which spelling supplied the id, so a conflict can name both. */
    let releaseFlag: string | null = null;
    let releaseSeen = false;
    let force = false;
    let outRoot: string | null = null;
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

        if (flag === RELEASE_FLAG || flag === VERSION_FLAG) {
            // Marked seen before its value is read, so a flag given without one
            // is reported as the missing value it is and not additionally as an
            // absent flag — the operator has one thing to fix, not two.
            releaseSeen = true;

            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a release id such as v1` });
                continue;
            }
            if (release !== null) {
                // Two ids, or the same id twice. Neither is resolved by picking
                // one: a release cut under an id the operator did not mean is
                // exactly the mistake this command must not make quietly.
                errors.push({
                    flag,
                    message:
                        release === value
                            ? `${flag} names the same release as ${releaseFlag ?? RELEASE_FLAG}; pass the release id once`
                            : `${releaseFlag ?? RELEASE_FLAG} names release "${release}" and ${flag} names "${value}"; pass a single release id`,
                });
                continue;
            }
            release = value;
            releaseFlag = flag;
            continue;
        }

        if (flag === OUT_FLAG) {
            const alreadySeen = outSeen;
            outSeen = true;

            const value = takeValue(inlineValue);
            if (value === null) {
                errors.push({ flag, message: `${flag} requires a directory to write the release into` });
                continue;
            }
            if (alreadySeen) {
                errors.push({ flag, message: `${flag} was given more than once; it takes a single value` });
                continue;
            }
            outRoot = value;
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
        errors.push({
            flag: RELEASE_FLAG,
            message: `${RELEASE_FLAG} (or ${VERSION_FLAG}) is required; name the release to write, such as v1`,
        });
    }

    if (errors.length > 0) {
        return { ok: false, errors };
    }

    return { ok: true, options: { help: false, release: release === null ? '' : release, force, outRoot } };
};

// ---------------------------------------------------------------------------
// Usage.
// ---------------------------------------------------------------------------

export const describeUsage = (): string =>
    [
        `Usage: npm run catalog:release -- --release <vN> [options]   (${STAGE})`,
        '',
        'Exports the published catalog as a versioned, checksummed release.',
        '',
        'Checks every input first and exits 1 naming the unsatisfied prerequisites',
        'and their remedies, before any directory is created or any file written.',
        'Then writes the six release members — foods, aliases, portions,',
        'components and validation records as JSONL, plus manifest.json — and',
        'records each member\'s SHA-256, row count and size, measured from the',
        'bytes on disk, so catalog:load can verify the release before it writes.',
        '',
        'Refuses to write a release in which a published food carries no validation',
        'record, and reports the exact per-category coverage shortfall rather than',
        'rounding or omitting it.',
        '',
        'Options:',
        '  --release <vN>   Required. The release id to write: "v" followed by digits.',
        '                   Names data/meal-planning/catalog/releases/<vN>/.',
        '  --version <vN>   A synonym of --release. Given both, they must agree.',
        '  --out <dir>      Create the release directory inside <dir> rather than in',
        '                   data/meal-planning/catalog/releases. The six members and',
        '                   every digest are identical either way.',
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

/**
 * Where the release directory goes: inside the operator's `--out` directory
 * when they named one, and in the repository's own releases tree otherwise.
 *
 * The id becomes a path segment in BOTH branches, so it is validated as one
 * safe segment in both. An override is a choice about location, never a way
 * around containment — `--out /tmp --release ../../etc` must not resolve
 * anywhere but inside `/tmp`.
 */
export const resolveReleaseDir = (outRoot: string | null): ((release: string) => string) =>
    outRoot === null
        ? releaseDir
        : (release: string): string =>
              path.join(path.resolve(outRoot), assertSafePathSegment(release, 'release id'));

const defaultPreflightDeps = (
    release: string,
    force: boolean,
    releaseDirFor: (release: string) => string,
): ReleasePreflightDeps => ({
    env: process.env,
    release,
    force,
    loadCoveragePlan,
    assertReleaseVersion,
    // The SAME resolver the export writes through, so the directory preflight
    // refuses to overwrite is the directory the run would have written.
    releaseDir: releaseDirFor,
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
                // The RESOLVED directory, not the repository's default one: with
                // --out the two differ, and a remedy naming a path the operator
                // did not ask for sends them to look at the wrong directory.
                remedy: `Choose the next release id, or pass --force to overwrite ${directory}.`,
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
// The export body.
//
// This stage freezes the published catalog into the six-file release every
// environment loads. It writes no nutrition and decides no disposition: it
// reads published rows and their children, serialises them in a stable order,
// measures the files it wrote, and records those measurements in the manifest.
//
// The manifest is what makes the release verifiable rather than merely
// present: catalog-load.ts checks every file's digest before it writes
// anything, so a truncated or edited member is refused instead of half-loaded.
// ---------------------------------------------------------------------------

/** The six members, in the order the release's format contract lists them. */
export const RELEASE_DATA_FILES: readonly string[] = [
    'foods.jsonl',
    'aliases.jsonl',
    'portions.jsonl',
    'components.jsonl',
    'validation-records.jsonl',
];

export const RELEASE_MANIFEST_FILE_NAME = 'manifest.json';

/** A published food and everything the release carries for it. */
export interface ReleaseFoodRow {
    readonly source_key: string;
    readonly canonical_name: string;
    readonly display_name: string;
    readonly category: string;
    readonly food_state: string;
    readonly food_group: string;
    readonly identity_source: string;
    readonly identity_status: string;
    readonly nutrition_provenance: string;
    readonly publication_status: string;
    readonly nutrition_basis: string;
    readonly basis_amount: number;
    readonly calories: number | null;
    readonly protein_g: number | null;
    readonly carbs_g: number | null;
    readonly fat_g: number | null;
    readonly fiber_g: number | null;
    readonly density_g_per_ml: number | null;
    readonly allergen_tags: string[];
    readonly allergen_status: string;
    readonly diet_tags: string[];
    readonly is_common_dislike: boolean;
    readonly cost_class: number;
    readonly nutrition_version: number;
    readonly metadata_version: number;
    readonly usda_fdc_id: number | null;
    readonly usda_data_type: string | null;
    readonly usda_description: string | null;
    readonly source_version: string | null;
    readonly source_cache_key: string | null;
    readonly search_text: string | null;
    readonly imported_at: Date | null;
    /**
     * The batch that generated this food, for an AI-generated one. Only
     * `batch_key` is exported — it is the portable reference — while `model` and
     * `prompt_version` are read to MEASURE the manifest's `model_versions` from
     * the rows the release actually carries rather than restating the plan.
     */
    readonly catalog_generation_batches: {
        readonly batch_key: string;
        readonly model: string;
        readonly prompt_version: string;
    } | null;
    readonly catalog_food_aliases: { readonly alias: string }[];
    readonly catalog_food_portions: {
        readonly description: string;
        readonly amount: number;
        readonly unit: string;
        readonly gram_weight: number;
        readonly is_default: boolean;
        readonly source: string;
    }[];
    readonly catalog_food_components: {
        readonly quantity_grams: number;
        readonly yield_factor: number;
        readonly component_nutrition_version: number;
        readonly sort_order: number;
        readonly component_catalog_foods: { readonly source_key: string } | null;
    }[];
    readonly catalog_validation_records: {
        readonly canonical_identity: unknown;
        readonly aliases: string[];
        readonly category: string;
        readonly food_state: string;
        readonly identity_source: string;
        readonly identity_status: string;
        readonly nutrition_provenance: string;
        readonly nutrition_method: string;
        readonly nutrition_assumptions: string | null;
        readonly portion_units: unknown;
        readonly identity_evidence: unknown;
        readonly checks: unknown;
        readonly llm_review: unknown;
        readonly outcome: string;
        readonly reviewed_at: Date;
        readonly publication_status: string;
        readonly source_versions: unknown;
        readonly history: unknown;
    } | null;
}

/**
 * The whole database surface this stage touches: read the published catalog,
 * read the pipeline ledger, append one ledger row, all inside one transaction.
 *
 * NO `where` below carries an owner key, which is a deliberate departure from
 * the otherwise non-negotiable rule that every query is scoped by `user_id`
 * (Rule backend-architecture §5.1). It is safe here for a reason that does not
 * generalise: the catalog tables are SHARED reference data and have no
 * `user_id` column at all, and an export runs for an operator rather than for a
 * caller, so there is no identity to scope to — a release is the same bytes for
 * everyone. What stands in for that scoping is the origin check: `./lib/dbGuard`
 * classifies `DATABASE_URL` at module load and refuses an unrecognised one, so
 * "which database may this read" is answered before a client exists rather than
 * per query.
 *
 * `create` appears once and writes the pipeline run LEDGER only. No catalog data
 * table is written by an export — see the note at that call site.
 */
export interface ReleaseDb {
    catalog_foods: { findMany(args: unknown): Promise<ReleaseFoodRow[]> };
    catalog_import_runs: {
        create(args: unknown): Promise<{ id: string }>;
        /**
         * Read to prove the published set is a validated set and not a
         * mid-pipeline one, and to refuse while a mutating run is still open.
         */
        findMany(args: unknown): Promise<ReleaseRunRow[]>;
    };
    /**
     * Both reads happen inside ONE of these, at Repeatable Read — see
     * ONE SNAPSHOT, TWO READS in runRelease. The options are declared narrowly
     * because that isolation level and an explicit timeout are the only two this
     * stage ever asks for.
     */
    $transaction<T>(
        work: (tx: ReleaseDb) => Promise<T>,
        options?: { isolationLevel?: 'RepeatableRead'; timeout?: number },
    ): Promise<T>;
}

/** The slice of a pipeline run this stage reads to check its prerequisite order. */
export interface ReleaseRunRow {
    readonly kind: string;
    readonly manifest_version: string;
    readonly status: string;
    readonly finished_at: Date | null;
}

/**
 * An append-only sink for one release member.
 *
 * The export writes a member as a sequence of lines rather than one string
 * because the whole catalog does not fit comfortably in memory: the validation
 * records alone are ~50 MB of JSON across ~11,000 rows, and holding the parsed
 * rows, the mapped objects and the joined string at once is roughly an order of
 * magnitude more heap than the data. Every member is written through this
 * interface so there is ONE code path, whether the sink is a file descriptor or
 * a buffer a test inspects.
 */
export interface ReleaseFileWriter {
    write(chunk: string): void;
    close(): void;
}

export interface RunReleaseDeps {
    readonly db: ReleaseDb;
    readonly coveragePlan: CoveragePlan;
    readonly release: string;
    readonly logger: ScriptLogger;
    readonly now: () => Date;
    /** Absolute directory for the validated release id. */
    readonly releaseDir: (release: string) => string;
    readonly writeFile: (absolutePath: string, contents: string) => void;
    readonly readFileBytes: (absolutePath: string) => Buffer;
    readonly ensureDir: (absolutePath: string) => void;
    /**
     * Opens a member for incremental writing. OPTIONAL, and the fallback is the
     * point: a caller that supplies only `writeFile` — the in-memory deps the
     * suites build — gets a writer that accumulates and flushes once through
     * it, so those callers keep working untouched while `main()` supplies a
     * descriptor-backed writer and never holds a member in memory.
     */
    readonly openWriter?: (absolutePath: string) => ReleaseFileWriter;
    /**
     * How many published foods are read per page. Optional; the default below
     * is what production uses. Present so a test can force several pages over a
     * handful of rows and prove the paging boundary is not where rows go
     * missing.
     */
    readonly pageSize?: number;
}

export interface ReleaseOutcome {
    readonly release: string;
    readonly publishedFoods: number;
    readonly counts: Readonly<Record<string, number>>;
    readonly shortfallTotal: number;
}

/** `null` rather than an omitted key: the release's readers expect the field. */
const orNull = <T>(value: T | undefined): T | null => (value === undefined ? null : value);

/** A check's name, or `''` for a payload that is not a named check. */
const checkName = (check: unknown): string =>
    typeof check === 'object' && check !== null && typeof (check as { name?: unknown }).name === 'string'
        ? (check as { name: string }).name
        : '';

/**
 * `checks` in the release's stated order: by check name, ascending.
 *
 * Validation writes them in evaluation order — reject tier, then quarantine,
 * then review — which is stable but is not the order the release format states.
 * Sorting happens here, beside the `aliases` sort and for the same reason: the
 * release has to be byte-reproducible, so the ordering belongs to the export
 * rather than to the stored row, and the evaluation order the validator wrote
 * is left undisturbed. Comparison is by code point, not `localeCompare`, so the
 * bytes do not depend on the exporting machine's locale. A payload that is not
 * an array is passed through untouched rather than reshaped into one.
 */
const toReleaseChecks = (checks: unknown): unknown =>
    Array.isArray(checks)
        ? checks.slice().sort((left, right) => {
              const leftName = checkName(left);
              const rightName = checkName(right);
              return leftName < rightName ? -1 : leftName > rightName ? 1 : 0;
          })
        : checks;

/**
 * One `foods.jsonl` line. The key order is the reviewed release's own, so a
 * regenerated file diffs against its predecessor line by line rather than
 * appearing wholly rewritten, and a reader written against either works.
 *
 * `search_vector` is deliberately absent: it is a STORED generated column that
 * PostgreSQL computes from `search_text`, so shipping it would ship a
 * derivation the database owns (Rule backend-architecture §7).
 */
export const toReleaseFoodLine = (row: ReleaseFoodRow): Record<string, unknown> => ({
    source_key: row.source_key,
    canonical_name: row.canonical_name,
    display_name: row.display_name,
    category: row.category,
    food_state: row.food_state,
    food_group: row.food_group,
    identity_source: row.identity_source,
    identity_status: row.identity_status,
    nutrition_provenance: row.nutrition_provenance,
    publication_status: row.publication_status,
    nutrition_basis: row.nutrition_basis,
    basis_amount: row.basis_amount,
    calories: row.calories,
    protein_g: row.protein_g,
    carbs_g: row.carbs_g,
    fat_g: row.fat_g,
    fiber_g: row.fiber_g,
    density_g_per_ml: row.density_g_per_ml,
    allergen_tags: row.allergen_tags.slice().sort(),
    allergen_status: row.allergen_status,
    diet_tags: row.diet_tags.slice().sort(),
    is_common_dislike: row.is_common_dislike,
    cost_class: row.cost_class,
    nutrition_version: row.nutrition_version,
    metadata_version: row.metadata_version,
    usda_fdc_id: row.usda_fdc_id,
    usda_data_type: row.usda_data_type,
    usda_description: row.usda_description,
    source_version: row.source_version,
    source_cache_key: row.source_cache_key,
    // The portable batch reference. The local uuid is never exported: it means
    // nothing in another database.
    generation_batch_key: row.catalog_generation_batches?.batch_key ?? null,
    search_text: row.search_text,
    imported_at: row.imported_at === null ? null : row.imported_at.toISOString(),
});

/**
 * One `validation-records.jsonl` line: the machine-readable record of what the
 * food claims to be, how its nutrition was arrived at, what was assumed, every
 * check that ran with its observed value and bound, and the evidence for its
 * identity.
 *
 * `nutrition_assumptions` is stored as JSON text in a `String?` column and is
 * parsed back to the array the release format states, so a reader never has to
 * know about the storage shape.
 */
export const toReleaseValidationLine = (row: ReleaseFoodRow): Record<string, unknown> | null => {
    const record = row.catalog_validation_records;
    if (record === null) {
        return null;
    }

    let assumptions: unknown = [];
    if (record.nutrition_assumptions !== null && record.nutrition_assumptions.length > 0) {
        try {
            const parsed: unknown = JSON.parse(record.nutrition_assumptions);
            assumptions = Array.isArray(parsed) ? parsed : [record.nutrition_assumptions];
        } catch {
            // Older rows may hold prose rather than JSON. Carried as the single
            // assumption it is, rather than dropped for failing to parse.
            assumptions = [record.nutrition_assumptions];
        }
    }

    return {
        food_source_key: row.source_key,
        canonical_identity: record.canonical_identity,
        aliases: record.aliases.slice().sort(),
        category: record.category,
        food_state: record.food_state,
        identity_source: record.identity_source,
        identity_status: record.identity_status,
        nutrition_provenance: record.nutrition_provenance,
        nutrition_method: record.nutrition_method,
        nutrition_assumptions: assumptions,
        portion_units: record.portion_units,
        identity_evidence: record.identity_evidence,
        checks: toReleaseChecks(record.checks),
        llm_review: orNull(record.llm_review) ?? null,
        outcome: record.outcome,
        reviewed_at: record.reviewed_at.toISOString(),
        publication_status: record.publication_status,
        source_versions: record.source_versions,
        history: record.history ?? [],
    };
};

/**
 * JSONL: one compact object per line, LF-terminated including the last.
 *
 * Emitted a line at a time rather than a joined member, which is what makes a
 * zero-row member an empty file — no line, no trailing newline — and keeps the
 * bytes identical to a joined write for every non-empty one.
 */
const toJsonLine = (row: Record<string, unknown>): string => `${JSON.stringify(row)}\n`;

/**
 * A writer that accumulates and flushes once through `writeFile`.
 *
 * The fallback for deps that supply no `openWriter`. It buffers by definition,
 * which is exactly what streaming exists to avoid — so it is the compatibility
 * path for callers holding a member in memory anyway (the suites' `Map`), never
 * the one `main()` takes.
 */
const bufferedWriter = (
    absolutePath: string,
    writeFile: (absolutePath: string, contents: string) => void,
): ReleaseFileWriter => {
    const chunks: string[] = [];
    return {
        write: (chunk: string): void => {
            chunks.push(chunk);
        },
        close: (): void => {
            writeFile(absolutePath, chunks.join(''));
        },
    };
};

/**
 * A descriptor-backed writer: the bytes leave the process as they are produced.
 *
 * `fs.writeSync` is not guaranteed to consume a whole buffer in one call, so
 * the remainder is written until nothing is left. A short write treated as a
 * complete one would truncate a member and — because the digest is measured
 * from the file afterwards — produce a manifest that verifies a truncated
 * release perfectly.
 */
const descriptorWriter = (absolutePath: string): ReleaseFileWriter => {
    const handle = fs.openSync(absolutePath, 'w');
    return {
        write: (chunk: string): void => {
            const bytes = Buffer.from(chunk, 'utf-8');
            let written = 0;
            while (written < bytes.length) {
                written += fs.writeSync(handle, bytes, written, bytes.length - written);
            }
        },
        close: (): void => {
            fs.closeSync(handle);
        },
    };
};

/**
 * Published foods per page.
 *
 * Each row carries its validation record, so a page is roughly
 * `250 × (1.2 KB food + 4.6 KB record)` ≈ 1.5 MB — small enough that the peak
 * is a page rather than a catalog, large enough that ~11,000 rows are 45 round
 * trips rather than thousands.
 */
const RELEASE_PAGE_SIZE = 250;

/** How many offending keys a refusal names before it summarises the rest. */
const NAMED_OFFENDERS = 5;

/**
 * The offenders a refusal names, and the true total.
 *
 * Only the first few keys are kept: a pathological catalog could put every
 * published food in this list, and a refusal that allocates a second copy of
 * the catalog to describe the first is a failure mode of its own. The COUNT is
 * exact regardless, because "5 of 4,000 foods" and "5 foods" are different
 * facts and the operator needs the real one.
 */
class OffenderTally {
    private readonly named: string[] = [];

    private count = 0;

    public add(sourceKey: string): void {
        this.count += 1;
        if (this.named.length < NAMED_OFFENDERS) {
            this.named.push(sourceKey);
        }
    }

    public get total(): number {
        return this.count;
    }

    public get first(): string | undefined {
        return this.named[0];
    }

    public describe(): string {
        return `${this.named.join(', ')}${this.count > this.named.length ? ', …' : ''}`;
    }
}

/**
 * The published graph and every child the release carries, in the order the
 * release format states. Hoisted to a constant because the read happens inside
 * a Repeatable Read transaction (see ONE SNAPSHOT, TWO READS) and the query is
 * worth reading on its own rather than nested two levels deeper.
 */
const RELEASE_FOOD_SELECT = {
    source_key: true,
    canonical_name: true,
    display_name: true,
    category: true,
    food_state: true,
    food_group: true,
    identity_source: true,
    identity_status: true,
    nutrition_provenance: true,
    publication_status: true,
    nutrition_basis: true,
    basis_amount: true,
    calories: true,
    protein_g: true,
    carbs_g: true,
    fat_g: true,
    fiber_g: true,
    density_g_per_ml: true,
    allergen_tags: true,
    allergen_status: true,
    diet_tags: true,
    is_common_dislike: true,
    cost_class: true,
    nutrition_version: true,
    metadata_version: true,
    usda_fdc_id: true,
    usda_data_type: true,
    usda_description: true,
    source_version: true,
    source_cache_key: true,
    search_text: true,
    imported_at: true,
    catalog_generation_batches: { select: { batch_key: true, model: true, prompt_version: true } },
    catalog_food_aliases: { select: { alias: true }, orderBy: { alias: 'asc' } },
    catalog_food_portions: {
        select: {
            description: true,
            amount: true,
            unit: true,
            gram_weight: true,
            is_default: true,
            source: true,
        },
        orderBy: { description: 'asc' },
    },
    catalog_food_components: {
        select: {
            quantity_grams: true,
            yield_factor: true,
            component_nutrition_version: true,
            sort_order: true,
            component_catalog_foods: { select: { source_key: true } },
        },
        orderBy: { sort_order: 'asc' },
    },
    catalog_validation_records: {
        select: {
            canonical_identity: true,
            aliases: true,
            category: true,
            food_state: true,
            identity_source: true,
            identity_status: true,
            nutrition_provenance: true,
            nutrition_method: true,
            nutrition_assumptions: true,
            portion_units: true,
            identity_evidence: true,
            checks: true,
            llm_review: true,
            outcome: true,
            reviewed_at: true,
            publication_status: true,
            source_versions: true,
            history: true,
        },
    },
};

/**
 * One page of published foods, ordered and resumed by `source_key`.
 *
 * KEYSET, NOT OFFSET. `source_key` is unique and the pages are read inside one
 * snapshot, so `> last` walks the published set exactly once with no row read
 * twice and none skipped, and it stays O(index seek) per page where a growing
 * `OFFSET` would re-scan everything before it. Ordering by that same column is
 * what makes the walk resumable AND makes the emitted order the release's
 * stated order, so paging is invisible in the bytes.
 */
const releaseFoodPageQuery = (cursor: string | null, pageSize: number): unknown => ({
    where:
        cursor === null
            ? { publication_status: 'published' }
            : { publication_status: 'published', source_key: { gt: cursor } },
    orderBy: { source_key: 'asc' },
    take: pageSize,
    select: RELEASE_FOOD_SELECT,
});

/**
 * Ten minutes for the snapshot.
 *
 * Prisma's default interactive-transaction timeout is 5 seconds, which is not a
 * ceiling this export can live with: it walks ~11,000 published parents with
 * five child relations each — on the order of 60,000 rows — and a cold
 * connection pool, a cold page cache or a loaded development machine turns a
 * few seconds into tens of them.
 *
 * The ceiling is generous because the snapshot now spans the WRITES as well as
 * the reads (see STREAMED, NOT BUFFERED), and that costs less than it appears
 * to: a Repeatable Read reader takes no lock that blocks a writer, and the
 * shared stage lock has already excluded every mutating stage for the duration
 * of the run, so nothing is waiting on this transaction. What a tight ceiling
 * would cost instead is a failed release on a slow disk, halfway through a
 * member. Ten minutes is an order of magnitude above the measured export and
 * still unmistakably below "hung".
 */
const RELEASE_SNAPSHOT_TIMEOUT_MS = 600_000;

/**
 * Exports the published catalog.
 *
 * Ordering is by `source_key` throughout, and children are ordered within
 * their parent, because a release must be byte-reproducible: the same database
 * exported twice has to produce the same bytes, or the manifest's digests say
 * nothing.
 */
export const runRelease = async (deps: RunReleaseDeps): Promise<ReleaseOutcome> => {
    const { logger, coveragePlan } = deps;
    const generatedAt = deps.now();

    const directory = deps.releaseDir(deps.release);
    const openWriter = deps.openWriter ?? ((absolutePath: string) => bufferedWriter(absolutePath, deps.writeFile));
    const pageSize = deps.pageSize ?? RELEASE_PAGE_SIZE;

    const rowCounts: Record<string, number> = {
        'foods.jsonl': 0,
        'aliases.jsonl': 0,
        'portions.jsonl': 0,
        'components.jsonl': 0,
        'validation-records.jsonl': 0,
    };

    const withoutValidationRecord = new OffenderTally();
    const withoutUsableDefaultPortion = new OffenderTally();
    const componentFacts: {
        source_key: string;
        nutrition_provenance: string;
        resolvable_component_count: number;
    }[] = [];
    const publishedByCategory: Record<string, number> = {};
    // Every dataset release present per dataset, not just one of them: USDA
    // publishes Foundation periodically and each record carries the release it
    // came from, so this catalog holds fourteen Foundation versions and one
    // each of SR Legacy and Survey. Keeping the whole set lets the manifest
    // name the latest deterministically instead of whichever row was read
    // last, and report the rest rather than discarding it.
    const sourceVersions = new Map<string, Set<string>>();
    // When each dataset's records were actually fetched from the vendor, which
    // is NOT when this release was exported. `imported_at` is written once, on
    // insert, and preserved across re-imports, so the latest one per dataset is
    // the honest answer to "when was this data retrieved" — and it survives a
    // re-export, where the export timestamp would silently move.
    const retrievedAt = new Map<string, Date>();
    /**
     * Which model and prompt produced the AI-generated rows this release
     * carries, read from their batches. Sets, because a release spanning two
     * generation runs carries two, and `model_versions` must be measured from
     * the rows rather than restated from the plan.
     */
    const generationModels = new Set<string>();
    const generationPromptVersions = new Set<string>();
    let aiGeneratedFoods = 0;

    // Sorted by (parent, child) so a member is byte-reproducible whatever order
    // the database returned one parent's children in. Comparison is by code
    // point, not `localeCompare`, so the bytes do not depend on the exporting
    // machine's locale.
    const byChildKey =
        (childKey: string) =>
        (left: Record<string, unknown>, right: Record<string, unknown>): number => {
            const leftChild = String(left[childKey]);
            const rightChild = String(right[childKey]);
            return leftChild < rightChild ? -1 : leftChild > rightChild ? 1 : 0;
        };

    // STREAMED, NOT BUFFERED.
    //
    // The published graph is walked a page at a time and each page's lines go
    // straight to their member, so what this function keeps alive is one page of
    // rows (~1.5 MB) plus the small per-food tallies below — not the catalog.
    // Buffering instead means three copies of it at once: every Prisma row
    // (11,046 parents, whose validation records are 50 MB of JSON as JS
    // objects), every mapped line, and every joined member string, the largest
    // of which the join transiently doubles. Measured on the committed v1
    // release, replacing the descriptor writers with the buffering fallback
    // costs ~59 MiB of peak RSS for the member strings alone, with the
    // Prisma-row copy excluded because the harness feeds rows a page at a time
    // in both modes; a release a few times larger is where that stops being a
    // number and becomes a heap failure on the machine cutting it.
    //
    // The consequence is that the writes now happen INSIDE the snapshot, which
    // is a trade the stage lock has already paid for: see
    // RELEASE_SNAPSHOT_TIMEOUT_MS. What it buys beyond memory is that every
    // member is emitted in ONE walk of the parents, so `foods.jsonl` and the
    // four child members cannot disagree about parent order the way an
    // independently re-sorted child member could.
    const writers: Record<string, ReleaseFileWriter> = {};

    try {
        await deps.db.$transaction(
            async (tx) => {
                // ONE SNAPSHOT, TWO READS.
                //
                // The published graph and the run ledger are two statements that
                // have to describe ONE database state. Read independently, the
                // prerequisite-order check can pass against a ledger the
                // exported bytes do not match: an ingest that commits between
                // them writes the records it touched back as candidates, so the
                // export can carry rows the ledger says nothing about — and the
                // only symptom is a count nobody was watching. Repeatable Read
                // puts every statement below on the same snapshot, so the
                // manifest's counts and the prerequisite check are statements
                // about the same catalog.
                //
                // The ledger is read FIRST, and that ordering is load-bearing
                // now that the walk writes as it reads: the staleness refusal
                // below must reach its verdict before the first byte of the
                // first member exists.
                const pipelineRuns = await loadPipelineRuns(tx);

                // The canonical validation this catalog must have passed,
                // resolved from the SAME snapshot as the rows — the identity of
                // the input and the identity of the run that judged it have to
                // be read together or the pair can disagree.
                const expectedValidationKey = canonicalValidationRunKey(
                    coveragePlan.coveragePlanVersion,
                    catalogInputIdentity(pipelineRuns),
                );
                const staleReason = releaseStalenessReason(pipelineRuns, expectedValidationKey, logger);
                if (staleReason !== null) {
                    throw new ReleaseIntegrityError(staleReason);
                }

                deps.ensureDir(directory);
                for (const fileName of RELEASE_DATA_FILES) {
                    writers[fileName] = openWriter(path.join(directory, fileName));
                }
                const emit = (fileName: string, line: Record<string, unknown>): void => {
                    writers[fileName].write(toJsonLine(line));
                    rowCounts[fileName] += 1;
                };

                let cursor: string | null = null;
                for (;;) {
                    const page: ReleaseFoodRow[] = await tx.catalog_foods.findMany(
                        releaseFoodPageQuery(cursor, pageSize),
                    );
                    if (page.length === 0) {
                        break;
                    }

                    for (const row of page) {
                        emit('foods.jsonl', toReleaseFoodLine(row));
                        publishedByCategory[row.category] = (publishedByCategory[row.category] ?? 0) + 1;

                        if (row.identity_source === 'ai_generated') {
                            aiGeneratedFoods += 1;
                        }
                        if (row.catalog_generation_batches !== null) {
                            generationModels.add(row.catalog_generation_batches.model);
                            generationPromptVersions.add(row.catalog_generation_batches.prompt_version);
                        }

                        if (row.usda_data_type !== null && row.source_version !== null) {
                            const seen = sourceVersions.get(row.usda_data_type) ?? new Set<string>();
                            seen.add(row.source_version);
                            sourceVersions.set(row.usda_data_type, seen);
                            const latest = retrievedAt.get(row.usda_data_type);
                            if (row.imported_at !== null && (latest === undefined || row.imported_at > latest)) {
                                retrievedAt.set(row.usda_data_type, row.imported_at);
                            }
                        }

                        // Sorted on the value that is EXPORTED, not the one the
                        // database ordered by: the alias is lower-cased on the
                        // way out, so ordering by the stored spelling would put
                        // `Brown Rice` and `brown rice` in an order the file
                        // does not show.
                        const aliasLines = row.catalog_food_aliases
                            .map(({ alias }) => ({
                                food_source_key: row.source_key,
                                alias: alias.toLowerCase(),
                            }))
                            .sort(byChildKey('alias'));
                        for (const line of aliasLines) {
                            emit('aliases.jsonl', line);
                        }

                        let defaultPortions = 0;
                        const portionLines = row.catalog_food_portions
                            .map((portion) => {
                                if (portion.is_default && isUsableGramWeight(portion.gram_weight)) {
                                    defaultPortions += 1;
                                }
                                return {
                                    food_source_key: row.source_key,
                                    description: portion.description,
                                    amount: portion.amount,
                                    unit: portion.unit,
                                    gram_weight: portion.gram_weight,
                                    is_default: portion.is_default,
                                    source: portion.source,
                                };
                            })
                            .sort(byChildKey('description'));
                        for (const line of portionLines) {
                            emit('portions.jsonl', line);
                        }
                        if (defaultPortions !== 1) {
                            withoutUsableDefaultPortion.add(row.source_key);
                        }

                        const componentLines = row.catalog_food_components
                            .filter((component) => component.component_catalog_foods !== null)
                            .map((component) => ({
                                food_source_key: row.source_key,
                                // The portable reference, never the local uuid:
                                // a component id means nothing in another
                                // database. The key is spelled
                                // `component_food_source_key` because that is
                                // what catalog-load.ts reads, and the loader's
                                // reader is the release's format contract.
                                component_food_source_key: (
                                    component.component_catalog_foods as { readonly source_key: string }
                                ).source_key,
                                quantity_grams: component.quantity_grams,
                                yield_factor: component.yield_factor,
                                component_nutrition_version: component.component_nutrition_version,
                                sort_order: component.sort_order,
                            }))
                            .sort(byChildKey('component_food_source_key'));
                        for (const line of componentLines) {
                            emit('components.jsonl', line);
                        }

                        componentFacts.push({
                            source_key: row.source_key,
                            nutrition_provenance: row.nutrition_provenance,
                            // Only components that RESOLVE to a food count: a
                            // row pointing at a food this release does not
                            // carry is not something a nutrient total could
                            // have been derived from.
                            resolvable_component_count: componentLines.length,
                        });

                        const validation = toReleaseValidationLine(row);
                        if (validation === null) {
                            withoutValidationRecord.add(row.source_key);
                        } else {
                            emit('validation-records.jsonl', validation);
                        }
                    }

                    cursor = page[page.length - 1].source_key;
                    if (page.length < pageSize) {
                        break;
                    }
                }
            },
            { isolationLevel: 'RepeatableRead', timeout: RELEASE_SNAPSHOT_TIMEOUT_MS },
        );
    } finally {
        // Closed whatever happened. A refusal mid-walk leaves the staging
        // directory for main() to delete, but the descriptors are this
        // function's to release either way.
        for (const writer of Object.values(writers)) {
            writer.close();
        }
    }

    const foodCount = rowCounts['foods.jsonl'];

    // The prerequisite-order refusal (the published set is only meaningful if
    // validation was the last thing to decide it) has already run, inside the
    // snapshot and before the first member was opened — see ONE SNAPSHOT, TWO
    // READS. The refusals below are the ones only the walk can discover, and
    // they are safe to raise after it because every byte written so far is in a
    // staging directory main() deletes rather than promotes.

    if (withoutValidationRecord.total > 0) {
        // Every published food must carry a validation record: it is the
        // machine-readable evidence the feature requires, and a release short
        // of one is not a release. Refused rather than written incomplete.
        throw new ReleaseIntegrityError(
            `${withoutValidationRecord.total} published food(s) carry no validation record, so the release would ship unevidenced rows: ${withoutValidationRecord.describe()}. Run catalog:validate before catalog:release.`,
            { file: 'validation-records.jsonl', sourceKey: withoutValidationRecord.first },
        );
    }

    // EVERY PUBLISHED FOOD HAS EXACTLY ONE USABLE DEFAULT PORTION.
    //
    // The default portion is how a gram weight is attached to a human amount,
    // so it is what every downstream consumer measures with: recipe seeding
    // resolves ingredient gram weights through it, the grocery list picks the
    // unit family from it, and a logged catalog food snapshots its nutrition
    // from it. A published food without one cannot serve any of them, and a
    // food with TWO is worse than a food with none — the database's partial
    // unique index admits only one, so a release carrying two would be refused
    // halfway through loading, after rows had already been written.
    //
    // Checked here, over the portions as they are exported, rather than trusted
    // from validation: this is the last point at which the set being shipped is
    // the set being examined. `default_portion_count` and
    // `default_portion_gram_weight` are the validator's own checks, and this is
    // the same rule re-asserted on the artefact — cheap, and the only way an
    // export that dropped a portion row is distinguishable from a catalog that
    // never had one.
    if (withoutUsableDefaultPortion.total > 0) {
        throw new ReleaseIntegrityError(
            `${withoutUsableDefaultPortion.total} published food(s) do not carry exactly one default portion with a known, positive gram weight, so their amounts cannot be converted to grams by anything that loads this release: ${withoutUsableDefaultPortion.describe()}. Run catalog:validate before catalog:release.`,
            { file: 'portions.jsonl', sourceKey: withoutUsableDefaultPortion.first },
        );
    }

    // WHAT MAKES AN EMPTY components.jsonl AN ASSERTED FACT RATHER THAN A BLANK.
    // A component row is the composition of an INGREDIENT-DERIVED food, so the
    // member is empty exactly when no published food derives its nutrition from
    // one. Stated the other way round: a published `ingredient_derived` food
    // with no composition has nothing its nutrient totals could have been
    // computed FROM, so those totals are unsourced and the release is refused.
    //
    // Without this check a zero-row components.jsonl and a components export
    // that silently dropped every row look identical on disk and in the
    // manifest — the digest of an empty file verifies either way — which is
    // precisely the ambiguity a reviewer cannot resolve by reading the
    // artefact. The check turns the count into a derived consequence: 0 rows is
    // provably correct when, and only when, no ingredient-derived food is
    // published.
    //
    // The opposite repair is forbidden: inventing a composition so the file has
    // rows would fabricate a nutrient total, which the catalog policy and the
    // feature's nutrition-integrity requirement both rule out outright.
    //
    // The rule itself is pure and lives in catalog.logic.ts, beside the
    // `empty_component_set` validation check and `deriveComponentNutrition`
    // (which already refuses a zero-component derivation) and under unit tests.
    // This function decides nothing: it collected the facts the rule reads as
    // it walked — three small fields per food, which is the one thing the walk
    // keeps in memory on purpose, because the alternative is re-implementing
    // the provenance predicate here and giving the rule a second home — and it
    // turns a refusal into the operator's next command.
    const componentCoverage = assessComponentCoverage(componentFacts);
    if (!componentCoverage.ok) {
        const missing = componentCoverage.derivedWithoutComponents;
        throw new ReleaseIntegrityError(
            `${missing.length} published food(s) declare nutrition_provenance 'ingredient_derived' but carry no component rows, so their nutrient totals have no stored composition to derive from: ${missing
                .slice(0, NAMED_OFFENDERS)
                .join(', ')}${missing.length > NAMED_OFFENDERS ? ', …' : ''}. Run catalog:validate before catalog:release.`,
            { file: 'components.jsonl', sourceKey: missing[0] },
        );
    }
    logger.info('components_asserted', {
        components: rowCounts['components.jsonl'],
        published_ingredient_derived: componentCoverage.derivedCount,
    });

    // Every member has been written and closed by now, including
    // components.jsonl when it has no rows. An empty member is still a member:
    // the six-file contract requires the file to exist so the loader verifies
    // six digests, and the manifest records its digest, row count and size,
    // which is what makes an empty components.jsonl an asserted empty set
    // rather than an absent file. Inventing a composition to fill it would
    // fabricate a nutrient total.
    //
    // Measured from the bytes on disk, not from the lines that were emitted:
    // the manifest has to describe the file a loader will actually read, and a
    // digest taken from memory would not catch a write that failed halfway.
    const files = RELEASE_DATA_FILES.map((fileName) => {
        const bytes = deps.readFileBytes(path.join(directory, fileName));
        return {
            path: fileName,
            name: fileName,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            row_count: rowCounts[fileName],
            bytes: bytes.length,
        };
    });

    // THE SHORTFALL IS ARITHMETIC THIS SCRIPT DOES NOT OWN.
    //
    // `computeCoverageShortfall` is the domain's rule (Rule
    // backend-architecture §1.2/§7: a rule someone could get wrong lives in a
    // pure module under test, not in the script that reports it), and it is the
    // same function catalog-report.ts publishes its numbers from — so the
    // report and the release manifest cannot state different shortfalls for one
    // database. It also does two things an inline `max(0, target − published)`
    // here would not: it matches counts to categories on a normalised key, so
    // two spellings of one category sum instead of one being silently dropped
    // into a fabricated shortfall, and it names any category the database
    // carries that the plan does not declare.
    const coverageShortfall = computeCoverageShortfall(coveragePlan, publishedByCategory);
    if (coverageShortfall.unknownCategories.length > 0) {
        // Reported, not absorbed: rows filed under a category the plan does not
        // declare are exported (they are published foods) but no target exists
        // to measure them against, and a total that quietly swallowed them
        // would describe a catalog the plan does not.
        logger.warn('coverage_categories_outside_plan', {
            stage: STAGE,
            categories: coverageShortfall.unknownCategories.join(', '),
        });
    }
    const byCategory = coverageShortfall.categories.map((category) => ({
        category: category.category as CoverageCategory,
        published: category.published,
        // The same count under the name the release format contract uses,
        // written alongside so neither reader has to know the other's
        // spelling — the convention `path`/`name` and
        // `categories`/`by_category` already follow.
        published_actual: category.published,
        published_target: category.publishedTarget,
        shortfall: category.shortfall,
    }));
    // The total shortfall is the SUM of the per-category shortfalls, not the
    // gap between the two totals. Those are different numbers whenever one
    // category overshoots its target while another falls short, and the
    // aggregate hides exactly the fact a reader needs: this release publishes
    // 11,046 foods against a plan total of 11,010, yet a dozen categories sit
    // below their own targets because the overshoot in others covers them.
    // Reporting 0 there would claim per-category coverage this release does
    // not have, which is the one thing the header forbids. The aggregate
    // comparison is still reported, under its own name, so neither fact is
    // lost.
    const shortfallTotal = coverageShortfall.shortfallTotal;
    const publishedGapToTotal = Math.max(0, coveragePlan.publishedTargetTotal - foodCount);

    const manifest: CatalogReleaseManifest = {
        release_id: deps.release,
        manifest_version: 'v1',
        coverage_plan_version: coveragePlan.coveragePlanVersion,
        generated_at: generatedAt.toISOString(),
        produced_by: 'pipeline',
        files,
        counts: {
            foods: foodCount,
            // Every exported food is published — the query selects on that
            // status — so the two spellings are the same measurement, and both
            // are written for the same reason `path` and `name` are.
            published_foods: foodCount,
            aliases: rowCounts['aliases.jsonl'],
            portions: rowCounts['portions.jsonl'],
            components: rowCounts['components.jsonl'],
            // Written beside `components` so the component count is readable on
            // its own terms: a composition belongs to an ingredient-derived
            // food, so zero components is a fact about this release's
            // composition rather than a gap. Taken from the SAME verdict the
            // invariant above was checked with, which is what makes "the two
            // can never disagree" structural instead of a promise — two
            // independent counts of one thing are exactly how a manifest starts
            // describing a release nobody checked.
            published_ingredient_derived: componentCoverage.derivedCount,
            validation_records: rowCounts['validation-records.jsonl'],
        },
        source_datasets: Array.from(sourceVersions.entries())
            .sort((left, right) => (left[0] < right[0] ? -1 : 1))
            .map(([name, versions]) => {
                // Sorted lexically, which for "<dataset> YYYY-MM" is also
                // chronological, so the last entry is the latest release.
                const present = Array.from(versions).sort();
                return {
                    name,
                    version: present[present.length - 1] as string,
                    versions_present: present,
                    retrieved_at: (retrievedAt.get(name) ?? generatedAt).toISOString(),
                    public_domain: true,
                    notes: 'USDA FoodData Central. Public domain, which is the basis on which this release redistributes its descriptions, portions and nutrient values.',
                };
            }),
        // MEASURED, AND NULL WHEN THAT IS THE MEASUREMENT.
        //
        // Every field is derived from whether this release actually carries an
        // AI-generated published food. A release built entirely from sourced
        // USDA records made no model call, so every field is null — and that
        // null is a measurement of the rows, not a constant: naming a model a
        // release did not use would misattribute every food in it, and naming
        // none for a release that did use one would hide the attribution the
        // catalog policy requires.
        //
        // The model and generation prompt come from the batches that produced
        // the rows, which is the only record of what really ran; the plan's
        // declared names are the fallback for a batch that recorded none, and
        // the review prompt version is the plan's because no per-row review
        // record carries it.
        model_versions: modelVersionsFor({
            aiGeneratedFoods,
            generationModels,
            generationPromptVersions,
            coveragePlan,
        }),
        coverage: {
            coverage_plan_version: coveragePlan.coveragePlanVersion,
            published_target_total: coveragePlan.publishedTargetTotal,
            // The count of rows actually emitted, which is the number a reader
            // can verify against foods.jsonl. It is NOT the shortfall verdict's
            // `publishedTotal`: that one excludes any category the plan does
            // not declare, because a target total cannot absorb rows it has no
            // target for — and those rows are still exported and still counted
            // here.
            published_actual_total: foodCount,
            published_total: foodCount,
            shortfall_total: shortfallTotal,
            published_gap_to_total: publishedGapToTotal,
            categories: byCategory,
            by_category: byCategory,
        },
    };

    deps.writeFile(
        path.join(directory, RELEASE_MANIFEST_FILE_NAME),
        `${JSON.stringify(manifest, null, 2)}\n`,
    );

    logger.info('release_written', {
        stage: STAGE,
        release: deps.release,
        foods: foodCount,
        aliases: rowCounts['aliases.jsonl'],
        portions: rowCounts['portions.jsonl'],
        components: rowCounts['components.jsonl'],
        validationRecords: rowCounts['validation-records.jsonl'],
        shortfallTotal,
    });

    // THE ONLY ROW THIS STAGE WRITES, AND IT IS NOT CATALOG DATA.
    //
    // The export is read-only over the catalog graph: not one
    // catalog_foods / catalog_food_aliases / catalog_food_portions /
    // catalog_food_components / catalog_validation_records row is inserted,
    // updated or deleted anywhere in this file, which is what makes cutting a
    // release a safe thing to do twice. What is appended is one row in the
    // pipeline run LEDGER, under the kind prisma/schema.prisma:340 documents
    // for exactly this stage, so an operator reading that ledger can see when a
    // release was cut and from what. It is written directly rather than through
    // checkpoint.ts, whose kind union covers the four stages that RESUME; this
    // one does not resume — it re-cuts.
    await deps.db.catalog_import_runs.create({
        data: {
            kind: 'release',
            manifest_version: deps.release,
            started_at: generatedAt,
            finished_at: deps.now(),
            status: 'succeeded',
            cursor: { release: deps.release },
            counts: {
                foods: foodCount,
                aliases: rowCounts['aliases.jsonl'],
                portions: rowCounts['portions.jsonl'],
                components: rowCounts['components.jsonl'],
                validation_records: rowCounts['validation-records.jsonl'],
            },
            log: [{ event: 'release_written', at: generatedAt.toISOString(), release: deps.release }],
        },
    });

    return {
        release: deps.release,
        publishedFoods: foodCount,
        counts: {
            foods: foodCount,
            aliases: rowCounts['aliases.jsonl'],
            portions: rowCounts['portions.jsonl'],
            components: rowCounts['components.jsonl'],
            validationRecords: rowCounts['validation-records.jsonl'],
        },
        shortfallTotal,
    };
};

/**
 * Whether a portion's gram weight can convert its amount to grams.
 *
 * A stored `0`, a negative, a NaN or an Infinity all mean the same thing here —
 * there is no weight — and they are the values a release must not ship, because
 * every consumer of a default portion divides or multiplies by it.
 */
const isUsableGramWeight = (gramWeight: number): boolean => Number.isFinite(gramWeight) && gramWeight > 0;

/**
 * The single value a `model_versions` field can carry, from what the rows say.
 *
 * One distinct value is the answer. Several is a release produced across more
 * than one model or prompt, and the manifest field holds one string — so the
 * greatest is recorded (deterministic, and for a versioned identifier the
 * latest) and the caller logs the full set, because discarding the fact
 * silently is the one option that is not acceptable.
 */
const singleOrGreatest = (values: ReadonlySet<string>): string | null =>
    values.size === 0 ? null : Array.from(values).sort()[values.size - 1];

/**
 * `model_versions`, measured from the published rows this release carries.
 *
 * Gated on there being an AI-generated food at all: a release of sourced
 * records made no model call, and every field is null for it.
 */
const modelVersionsFor = (input: {
    readonly aiGeneratedFoods: number;
    readonly generationModels: ReadonlySet<string>;
    readonly generationPromptVersions: ReadonlySet<string>;
    readonly coveragePlan: CoveragePlan;
}): CatalogReleaseModelVersions => {
    if (input.aiGeneratedFoods === 0) {
        return {
            generation_model: null,
            review_model: null,
            prompt_version: null,
            generation_prompt_version: null,
            review_prompt_version: null,
        };
    }

    const generationModel = singleOrGreatest(input.generationModels) ?? input.coveragePlan.generationModel ?? null;
    const generationPromptVersion =
        singleOrGreatest(input.generationPromptVersions) ?? input.coveragePlan.promptVersion;

    return {
        generation_model: generationModel,
        review_model: input.coveragePlan.reviewModel ?? null,
        prompt_version: generationPromptVersion,
        // `prompt_version` under the release format contract's spelling, which
        // names it for the generation prompt it records and pairs it with the
        // review prompt beside it.
        generation_prompt_version: generationPromptVersion,
        review_prompt_version: input.coveragePlan.reviewPromptVersion,
    };
};

/**
 * The stages that MUTATE the catalog graph.
 *
 * Two different rules read this one list, which is why it is a list rather than
 * two `in` clauses: the prerequisite-order check compares the newest ingest
 * against the newest validation, and the active-run refusal treats any of them
 * left 'running' as a reason not to export. `release_load` is here because a
 * load upserts foods, replaces their children and retires rows — it is as much
 * a mutator as an import.
 */
const MUTATING_RUN_KINDS: readonly string[] = ['usda_import', 'ai_generation', 'validation', 'release_load'];

/**
 * The command that settles a run of each kind.
 *
 * Named in the refusal message rather than left to the operator to work out,
 * because an abandoned 'running' row from a crashed stage would otherwise block
 * every future release with no stated way out: re-running that stage RESUMES
 * the same run (checkpoint.ts's THE CLAIM finds it by kind + manifest_version)
 * and closes it, which is the only thing that clears the row.
 */
const SETTLING_COMMANDS: Readonly<Record<string, string>> = {
    usda_import: 'npm run catalog:import',
    ai_generation: 'npm run catalog:generate',
    validation: 'npm run catalog:validate',
    release_load: 'npm run catalog:load -- --release <release>',
};

/**
 * Every pipeline run that bears on whether this database may be released:
 * succeeded runs, for the prerequisite order, and runs still marked 'running',
 * because the graph they are writing is the graph this export would freeze.
 *
 * Reading both in one query is what keeps the two rules on one snapshot (see
 * ONE SNAPSHOT, TWO READS).
 */
export const loadPipelineRuns = async (db: ReleaseDb): Promise<ReleaseRunRow[]> =>
    db.catalog_import_runs.findMany({
        // FAILED rows are read too, and that is not incidental. A failed
        // validation attempt of the CURRENT catalog is the most important row in
        // this ledger: without it, an older success for a different input — or an
        // earlier attempt of the same one — reads as "validation passed" and the
        // release ships a catalog whose judgement is known to have not finished.
        // Whether a failure blocks is decided in releaseStalenessReason, which it
        // cannot do for a row it never sees.
        where: { kind: { in: MUTATING_RUN_KINDS }, status: { in: ['succeeded', 'running', 'failed'] } },
        select: { kind: true, manifest_version: true, status: true, finished_at: true },
        orderBy: { finished_at: 'asc' },
    });

/**
 * Why this database is not ready to be released, or `null` when it is.
 *
 * Pure over the run rows so every rule is testable without a database. Four
 * refusals live here, in this order:
 *
 *   1. a mutating run still marked 'running' — the graph is moving;
 *   2. no successful CANONICAL validation for this catalog under the current
 *      coverage plan — a restricted `+scope:` pass judged part of the plan and
 *      cannot stand in for it, and a full pass of a DIFFERENT input judged a
 *      catalog this one no longer is;
 *   3. a later FAILED attempt of that same canonical run — validation closes
 *      itself failed when it could not judge every row it considered, and an
 *      older success must not hide it;
 *   4. an ingest that finished after that validation — the rows it touched are
 *      unpublished right now.
 *
 * A run whose `finished_at` is null never finished and says nothing about
 * ORDER, so rules 3 and 4 ignore it — which is exactly why the open-run rule
 * has to be stated separately rather than folded into them.
 *
 * @param expectedKey the canonical validation run key for the coverage plan and
 * catalog input being released — `canonicalValidationRunKey(planVersion,
 * catalogInputIdentity(runs))`. Passed in rather than derived here so the
 * caller resolves it from the SAME snapshot as the rows (see ONE SNAPSHOT, TWO
 * READS), and so this function stays pure over its arguments.
 */
export const releaseStalenessReason = (
    runs: readonly ReleaseRunRow[],
    expectedKey: string,
    logger: ScriptLogger,
): string | null => {
    // A MUTATING RUN THAT IS STILL OPEN IS CHECKED FIRST, because it makes every
    // other question unanswerable: the run is writing the rows this export would
    // freeze, so the published set is moving and the order check below is
    // comparing against a ledger entry that has not happened yet. The shared
    // stage lock stops a LIVE mutator from overlapping this export; this rule
    // catches the other case — a row left 'running' by a stage that crashed,
    // whose work is genuinely half-done.
    //
    // The remedy has to be stated, because without it an abandoned row would
    // block every future release and an operator's only visible options would be
    // editing the table by hand.
    const active = runs
        .filter((run) => MUTATING_RUN_KINDS.includes(run.kind) && run.status === 'running')
        // Deterministic: the same ledger always names the same run, so the
        // message an operator gets is reproducible.
        .sort((left, right) =>
            left.kind === right.kind
                ? left.manifest_version < right.manifest_version
                    ? -1
                    : left.manifest_version > right.manifest_version
                      ? 1
                      : 0
                : left.kind < right.kind
                  ? -1
                  : 1,
        );

    if (active.length > 0) {
        const run = active[0];
        const settle = SETTLING_COMMANDS[run.kind] ?? 'the stage that opened it';
        return (
            `a ${run.kind} run for ${run.manifest_version} is still marked running${
                active.length > 1 ? ` (${active.length} mutating runs are open)` : ''
            }, so the published set can change underneath this export and the release would freeze a catalog ` +
            'halfway through a stage. Settle it first: re-run that stage with ' +
            `"${settle}", which resumes that same run and closes it — a run left running by a crashed stage is ` +
            'cleared no other way. Then run catalog:validate, then catalog:release.'
        );
    }

    const latest = (predicate: (run: ReleaseRunRow) => boolean): ReleaseRunRow | null =>
        runs
            .filter((run) => predicate(run) && run.finished_at !== null)
            .reduce<ReleaseRunRow | null>(
                (newest, run) =>
                    newest === null || (run.finished_at as Date).getTime() > (newest.finished_at as Date).getTime()
                        ? run
                        : newest,
                null,
            );

    // WHICH VALIDATION ROW COUNTS: THE CANONICAL ONE FOR THIS CATALOG, AND ONLY
    // IT.
    //
    // "The newest validation row" is not the question. A validation run key
    // names the policy it judged against and the catalog input it judged
    // (lib/checkpoint.ts), and a restricted pass — `--category`,
    // `--revalidate-quarantined` — carries a `+scope:` suffix precisely because
    // it judged a FRACTION of the plan. Taking the newest row of any shape lets
    // this sequence through: an old full validation, then an import, then a
    // category-only validation — three rows whose newest is more recent than the
    // import, so the ordering check below passes and the release ships a catalog
    // most of which was judged before the import touched it, stamped with the
    // current coverage plan version. That is the failure this paragraph exists
    // to prevent, and the reason the expected key is passed in rather than
    // guessed at.
    const canonicalRuns = runs.filter((run) => run.kind === 'validation' && run.manifest_version === expectedKey);
    const canonicalSuccess = latest((run) => canonicalRuns.includes(run) && run.status === 'succeeded');
    const canonicalFailure = latest((run) => canonicalRuns.includes(run) && run.status === 'failed');

    if (canonicalSuccess === null) {
        // Naming what IS on record matters here: an operator looking at a
        // ledger full of validation rows needs to know why none of them counts,
        // and the two reasons are different remedies.
        const scoped = runs.filter(
            (run) => run.kind === 'validation' && isRestrictedValidationRunKey(run.manifest_version),
        );
        const fullRuns = runs.filter(
            (run) => run.kind === 'validation' && !isRestrictedValidationRunKey(run.manifest_version),
        );
        const expectedInput = validationRunKeyInputPart(expectedKey);
        const namingAnInput = fullRuns.filter(
            (run) => run.manifest_version !== expectedKey && validationRunKeyNamesInput(run.manifest_version),
        );
        const otherInputs = namingAnInput.filter(
            (run) => validationRunKeyInputPart(run.manifest_version) !== expectedInput,
        );
        // Same catalog, different coverage plan: the rows were judged against
        // bounds this release is not being cut under, which is a different
        // remedy from "an import has run since".
        const otherPlans = namingAnInput.filter(
            (run) => validationRunKeyInputPart(run.manifest_version) === expectedInput,
        );
        // A row from before the run key named the catalog input. It is not
        // wrong, it is SILENT about the one thing this check needs, and saying
        // so beats accusing the operator of an import they did not run.
        const silentAboutInput = fullRuns.filter((run) => !validationRunKeyNamesInput(run.manifest_version));

        if (scoped.length > 0 || otherInputs.length > 0 || otherPlans.length > 0 || silentAboutInput.length > 0) {
            return (
                `no successful catalog:validate run is on record for this catalog under the current coverage plan ` +
                `(expected run ${expectedKey}), so the published set has not been judged as it now stands. ` +
                `${
                    scoped.length > 0
                        ? `${scoped.length} restricted run(s) (--category / --revalidate-quarantined) are on record and cannot stand in for the full pass, because each judged only part of the plan. `
                        : ''
                }${
                    otherInputs.length > 0
                        ? `${otherInputs.length} full run(s) judged a different catalog input — an import or load has run since. `
                        : ''
                }${
                    otherPlans.length > 0
                        ? `${otherPlans.length} full run(s) judged this same catalog under a different coverage plan, so their verdicts came from bounds this release is not being cut under. `
                        : ''
                }${
                    silentAboutInput.length > 0
                        ? `${silentAboutInput.length} full run(s) predate validation runs naming the catalog they judged, so they cannot vouch for this one; re-running validation records it against this catalog and is a no-op thereafter. `
                        : ''
                }` +
                'Run catalog:validate (with no --category and no --revalidate-quarantined), then catalog:release.'
            );
        }

        return 'no successful catalog:validate run is on record, so no food in this database has been judged. Run catalog:validate before catalog:release.';
    }

    if (
        canonicalFailure !== null &&
        (canonicalFailure.finished_at as Date).getTime() > (canonicalSuccess.finished_at as Date).getTime()
    ) {
        // A later attempt of the SAME run key failed, which means the pass that
        // succeeded earlier no longer describes the database: validation closes
        // itself failed when it could not judge every row it considered, and
        // those rows kept the status they already had. An older success must not
        // hide that.
        return (
            `the most recent catalog:validate attempt for this catalog (run ${expectedKey}) FAILED at ` +
            `${(canonicalFailure.finished_at as Date).toISOString()}, after the earlier success at ` +
            `${(canonicalSuccess.finished_at as Date).toISOString()}. Rows it could not judge kept the status they ` +
            'already had, so the published set is not a complete judgement. Run catalog:validate again — it resumes ' +
            'that same run and revisits exactly those rows — then catalog:release.'
        );
    }

    const validation = canonicalSuccess;

    // The ordering rule, kept as a SECOND line of defence rather than the first.
    // Now that the canonical run key names the catalog input, a newer SUCCEEDED
    // ingest changes the expected key and the check above refuses for that
    // reason alone — which is the stronger statement, because it holds even
    // when the newer ingest has no finish time to compare. This check still
    // earns its place twice over:
    //
    //   * it catches a succeeded ingest the identity did not pick as newest (a
    //     tie, a clock that moved), stated in the terms an operator recognises;
    //   * it is THE rule for a FAILED graph mutator that finished after the
    //     validation. catalogInputIdentity counts succeeded runs only, and says
    //     so explicitly, precisely because a failed ingest left a graph nobody
    //     vouched for and naming it would mint a key for a half-written
    //     catalog — it delegates that case here. A failed import writes back
    //     every record it got to before it died, as candidates, so those foods
    //     are unpublished right now and this export would silently omit them.
    //
    // Hence no status predicate, and hence the three GRAPH-MUTATING kinds
    // rather than the two ingest ones: a release_load upserts foods, replaces
    // their children and retires rows, so a load that failed halfway leaves
    // exactly the same partial graph as a failed import. Validation is not in
    // that set (checkpoint.ts states why) — with it, the canonical success
    // would be compared against itself.
    const ingest = latest((run) => GRAPH_MUTATING_RUN_KINDS.includes(run.kind as CatalogRunKind));
    if (ingest === null) {
        // Validated with nothing imported is odd but not incoherent — a
        // release loaded from an earlier bundle has no import run of its own.
        logger.info('no_ingest_run_on_record', { stage: STAGE });
        return null;
    }

    const ingestAt = ingest.finished_at as Date;
    const validatedAt = validation.finished_at as Date;
    if (ingestAt.getTime() <= validatedAt.getTime()) {
        return null;
    }

    return (
        `a ${ingest.kind} run for ${ingest.manifest_version} ${ingest.status === 'failed' ? 'FAILED' : 'finished'} at ` +
        `${ingestAt.toISOString()}, after the last successful validation at ${validatedAt.toISOString()}. ` +
        'Writing the catalog graph writes the records it touches back as candidates, so those foods are unpublished ' +
        `right now and this release would silently omit them${
            ingest.status === 'failed'
                ? ' — a run that failed partway wrote back everything it reached before it died, which is why its ' +
                  'outcome does not excuse it from this rule'
                : ''
        }. Run catalog:validate, then catalog:release.`
    );
};

/** What a refusal is ABOUT, when it is about one artefact rather than the run. */
export interface CatalogReleaseErrorContext {
    /** The release member the refusal concerns, e.g. `portions.jsonl`. */
    readonly file?: string;
    /**
     * The offending food's PORTABLE identity. Never a local uuid: a refusal an
     * operator has to act on must name a key they can grep for in the release
     * and in the recipe seeds, and a uuid means nothing in another database.
     */
    readonly sourceKey?: string;
}

/**
 * This stage's typed failure (Rule backend-architecture §8).
 *
 * The class carries the data a caller needs rather than a string it would have
 * to parse back: `file` names the member a refusal concerns and `sourceKey` the
 * food, so the one thing that must change is reported without re-deriving it
 * from the message. Both are optional because a refusal about the run as a
 * whole — an unmet prerequisite, an origin that cannot be classified — is about
 * neither.
 *
 * It is never caught to be swallowed: it propagates to `main()`, which reports
 * its `code` and exits non-zero, and the staging directory the run was writing
 * into is deleted rather than promoted — so a refusal leaves no release at all
 * instead of a half-written one.
 */
export class CatalogReleaseError extends Error {
    public readonly code: string = 'catalog_release_failed';

    public readonly file?: string;

    public readonly sourceKey?: string;

    public constructor(message: string, context: CatalogReleaseErrorContext = {}) {
        super(message);
        this.name = 'CatalogReleaseError';
        this.file = context.file;
        this.sourceKey = context.sourceKey;
    }
}

/**
 * The release would have shipped rows it cannot vouch for — an unevidenced
 * food, a derived food with no composition, a food with no usable default
 * portion, or a catalog whose judgement is stale.
 *
 * A subclass rather than a second unrelated class so `main()` maps one base
 * type while each refusal still reports its own `code`, and so the existing
 * suites that import this name keep working.
 */
export class ReleaseIntegrityError extends CatalogReleaseError {
    public readonly code = 'release_integrity_failed';

    public constructor(message: string, context: CatalogReleaseErrorContext = {}) {
        super(message, context);
        this.name = 'ReleaseIntegrityError';
    }
}

// ---------------------------------------------------------------------------
// Publication — a release directory never exists half-written.
//
// A release directory is a reviewed, checksummed artefact that other
// environments load, so it must come into existence complete or not at all.
// Writing the six members straight into it cannot promise that: a run that
// dies after four of them leaves a directory that LOOKS like a release, and the
// two states are indistinguishable to anyone who did not watch the run. The
// export therefore writes into a staging directory and the finished directory
// is moved into place in one operation — after every member is closed, every
// digest measured, and the manifest written.
// ---------------------------------------------------------------------------

/**
 * The staging directory for a release: a hidden SIBLING of the final one.
 *
 * Sibling, not a temp directory: `rename` is only atomic within one
 * filesystem, and `os.tmpdir()` is routinely a different mount, where the move
 * would fail with `EXDEV` after the whole export had been written. Dot-prefixed
 * and pid-suffixed so it cannot be mistaken for a release id and two runs
 * cannot stage over each other.
 */
export const stagingDirFor = (finalDirectory: string, pid: number = process.pid): string =>
    path.join(path.dirname(finalDirectory), `.${path.basename(finalDirectory)}.staging-${pid}`);

/**
 * Moves the finished staging directory into its reviewed path.
 *
 * With nothing at the destination this is one `rename`, and a release therefore
 * appears complete or not at all.
 *
 * Replacing an existing release (only reachable with `--force`, since preflight
 * refuses otherwise) takes three steps, because `rename` onto a non-empty
 * directory fails with `ENOTEMPTY`. The OLD release is moved aside FIRST and
 * deleted LAST, which is the ordering that cannot lose it: a run interrupted
 * between the steps leaves the old release under its `.superseded-` name, where
 * an operator can see it and move it back, whereas deleting first would destroy
 * a reviewed artefact to make room for one that might never arrive.
 */
export const publishRelease = (input: {
    readonly stagingDirectory: string;
    readonly finalDirectory: string;
    readonly logger: ScriptLogger;
}): void => {
    const { stagingDirectory, finalDirectory, logger } = input;
    const replacing = directoryExistsOnDisk(finalDirectory);

    if (!replacing) {
        fs.renameSync(stagingDirectory, finalDirectory);
        logger.info('release_published', { stage: STAGE, directory: finalDirectory, replaced: false });
        return;
    }

    const supersededDirectory = path.join(
        path.dirname(finalDirectory),
        `.${path.basename(finalDirectory)}.superseded-${process.pid}`,
    );
    fs.rmSync(supersededDirectory, { recursive: true, force: true });
    fs.renameSync(finalDirectory, supersededDirectory);
    try {
        fs.renameSync(stagingDirectory, finalDirectory);
    } catch (error) {
        // The new release could not take the path, so the old one is put back
        // rather than left aside under a name nothing loads.
        fs.renameSync(supersededDirectory, finalDirectory);
        throw error;
    }
    fs.rmSync(supersededDirectory, { recursive: true, force: true });
    logger.info('release_published', { stage: STAGE, directory: finalDirectory, replaced: true });
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
    // The base type, not each subclass: every CatalogReleaseError reports its
    // own `code`, so a refusal added later is mapped here without this function
    // being touched — and none of them can fall through to `unexpected_error`.
    if (error instanceof CatalogReleaseError) {
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
        release: parsed.options.release,
        force: parsed.options.force,
        outRoot: parsed.options.outRoot,
    });

    const releaseDirFor = resolveReleaseDir(parsed.options.outRoot);

    const gaps = preflight(defaultPreflightDeps(parsed.options.release, parsed.options.force, releaseDirFor));
    if (gaps.length > 0) {
        logger.error('stage_prerequisites_unmet', gapFields(gaps));
        return 1;
    }

    // Reached here rather than at module load: constructing the client is a
    // side effect, and the suites that read parseArgs, preflight and the pure
    // serialisers above must not pay for it.
    const { prisma } = await import('../src/prisma/client');

    const release = assertReleaseVersion(parsed.options.release);
    const finalDirectory = releaseDirFor(release);
    const stagingDirectory = stagingDirFor(finalDirectory);

    // A staging directory left by a run that was killed before it could clean
    // up. Its contents describe nothing — the manifest that would make them a
    // release was never written — so it is discarded rather than resumed.
    fs.rmSync(stagingDirectory, { recursive: true, force: true });

    let outcome: ReleaseOutcome;
    try {
        // THE STAGE CLAIM, TAKEN SHARED. This stage only READS the catalog graph,
        // so two exports of one database are harmless and both may hold the lock;
        // what must not happen is an export running while an import, a generation
        // pass, a validation pass or a load is writing, and a shared lock is
        // refused exactly then (lib/checkpoint.ts's THE STAGE LOCK). It is the
        // outer half of the guarantee the Repeatable Read snapshot makes inside
        // runRelease: the lock keeps a mutator out for the whole export, the
        // snapshot makes every read describe one state even so.
        outcome = await withCatalogStageLock({ stage: 'release', logger }, () =>
            runRelease({
                db: prisma as unknown as ReleaseDb,
                coveragePlan: loadCoveragePlan(),
                release,
                logger,
                now: () => new Date(),
                // The STAGING directory, not the final one: nothing writes to
                // the reviewed path until every member and the manifest exist.
                releaseDir: () => stagingDirectory,
                writeFile: (absolutePath, contents) => {
                    fs.writeFileSync(absolutePath, contents, 'utf-8');
                },
                readFileBytes: (absolutePath) => fs.readFileSync(absolutePath),
                ensureDir: (absolutePath) => {
                    fs.mkdirSync(absolutePath, { recursive: true });
                },
                openWriter: descriptorWriter,
            }),
        );
    } catch (error) {
        // A REFUSAL LEAVES NO RELEASE, NOT A PARTIAL ONE. Whatever members the
        // walk had written go with the staging directory, so the failure cannot
        // be mistaken for a release later — and the previously reviewed release,
        // if there is one, is still exactly where it was.
        fs.rmSync(stagingDirectory, { recursive: true, force: true });
        logger.error('release_discarded', {
            stage: STAGE,
            release,
            staging: stagingDirectory,
            error: safeError(error),
        });
        throw error;
    }

    publishRelease({ stagingDirectory, finalDirectory, logger });

    logger.info('stage_completed', {
        stage: STAGE,
        directory: finalDirectory,
        release: outcome.release,
        publishedFoods: outcome.publishedFoods,
        shortfallTotal: outcome.shortfallTotal,
        counts: JSON.stringify(outcome.counts),
    });

    if (outcome.shortfallTotal > 0) {
        // Written, and reported as short. The release is valid and loadable;
        // the coverage requirement it is measured against is not yet met, and
        // the manifest records the gap per category so nobody has to guess.
        logger.warn('coverage_shortfall', {
            stage: STAGE,
            release: outcome.release,
            publishedFoods: outcome.publishedFoods,
            shortfallTotal: outcome.shortfallTotal,
        });
    }

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
