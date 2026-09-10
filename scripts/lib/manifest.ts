// The versioned manifest loader and repository-root path resolver for the
// meal-planning data files under `backend/data/meal-planning/`. Eight of the
// nine CLI entry points in `backend/scripts/` read their inputs through this
// module (`seed-dev.ts` is the exception), and it makes them two promises.
//
// FIRST: paths resolve from the repository root, never from the process working
// directory. A script launched from another directory — or through tooling that
// changes the working directory under it — must still read the same files,
// where `path.resolve('data/…')` would quietly read a different tree or nothing
// at all. `.dockerignore` excludes both `scripts` and `data`, so these paths
// exist only in the repository and in operator checkouts and never inside the
// production image; the nine `npm run` entry points all execute TypeScript from
// source under `ts-node`, so resolving relative to this module's own location
// is correct in every environment the pipeline runs in, while anything derived
// from a `dist/` layout would not be.
//
// SECOND: a manifest whose declared version this build does not understand
// fails loudly. These files carry policy — category targets, validation bounds,
// vendor rate limits, the IANA special-purpose address table — and a `v2` file
// read under `v1` assumptions would not crash. It would import a catalog
// against the wrong numbers and report success. Rule backend-architecture
// §1.6/§9 puts that decision here, at the single boundary where the
// configuration is read, behind accessors that throw rather than coerce (§8).
//
// Scope (§1.1, §7.1): this module resolves paths, reads and writes JSON, and
// compares versions. Checksum verification belongs to `catalog-load.ts`, JSONL
// streaming to the release and load scripts, shortfall arithmetic to
// `catalog-report.ts`, and model-call budgeting to `budget.ts`. It imports two
// Node built-ins and its sibling logger, reads no environment variable, and
// does nothing at import time — every read happens when a caller calls a
// loader, and every argument a rule depends on is a parameter, so the pure
// parts are unit-testable from `src/__tests__/scripts/` (§11: Jest's `roots` is
// `<rootDir>/src`, so no test file can live in this folder).

import fs from 'fs';
import path from 'path';

import { createLogger } from './logger';

const logger = createLogger('manifest');

/**
 * A discriminated code rather than a message to pattern-match on (§8): a
 * calling script recovers differently from each of these. `file_not_found`
 * means an earlier pipeline step has not been run, `version_mismatch` means
 * this build predates the data it was handed, and `repo_root_not_found` means
 * the process is not running inside the checkout it expects.
 */
export type ManifestErrorCode =
    | 'repo_root_not_found'
    | 'file_not_found'
    | 'invalid_json'
    | 'missing_version_field'
    | 'version_mismatch';

export class ManifestError extends Error {
    constructor(
        public readonly code: ManifestErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'ManifestError';
    }
}

export const COVERAGE_PLAN_FILE = 'coverage-plan.v1.json';
export const USDA_MANIFEST_FILE = 'usda-manifest.v1.json';
export const SEARCH_BENCHMARK_FILE = 'search-benchmark.v1.json';
export const EVIDENCE_ALLOWLIST_FILE = 'evidence-allowlist.v1.json';
export const RELEASE_MANIFEST_FILE = 'manifest.json';

export const EXPECTED_COVERAGE_PLAN_VERSION = 'v1';
export const EXPECTED_USDA_MANIFEST_VERSION = 'v1';
export const EXPECTED_SEARCH_BENCHMARK_VERSION = 'v1';
export const EXPECTED_EVIDENCE_ALLOWLIST_VERSION = 'v1';
// The generated release manifest may carry its own schema version alongside the
// coverage-plan version it was produced against; it is checked when present, so
// the comparison needs a reviewed constant rather than an inline literal.
export const EXPECTED_RELEASE_MANIFEST_VERSION = 'v1';

// Each file states the version it was authored for in its own named field, so a
// diff of the data file shows which contract moved. The names are internal
// because they are only ever paired with their loader.
const COVERAGE_PLAN_VERSION_FIELD = 'coveragePlanVersion';
const USDA_MANIFEST_VERSION_FIELD = 'usdaManifestVersion';
const SEARCH_BENCHMARK_VERSION_FIELD = 'benchmarkVersion';
const EVIDENCE_ALLOWLIST_VERSION_FIELD = 'allowlistVersion';
const RELEASE_COVERAGE_PLAN_VERSION_FIELD = 'coverage_plan_version';
const RELEASE_MANIFEST_VERSION_FIELD = 'manifest_version';

const REPO_PACKAGE_NAME = 'state-of-health-be';

// Deep enough to survive a folder being added between this module and the
// package root, shallow enough that a checkout without a `package.json` fails
// here instead of walking out of the repository and matching something else.
const MAX_ASCENT_LEVELS = 6;

// Keyed by the normalised start directory rather than held in a single slot, so
// an injected `fromDir` is never answered with the root found for another one —
// the failure branch stays reachable in a process that has already resolved the
// real root.
const repoRootCache = new Map<string, string>();

const hasRepoPackageJson = (candidate: string): boolean => {
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(candidate, 'package.json'), 'utf8');
    } catch {
        return false;
    }

    try {
        const parsed: unknown = JSON.parse(raw);
        return (
            parsed !== null &&
            typeof parsed === 'object' &&
            (parsed as { name?: unknown }).name === REPO_PACKAGE_NAME
        );
    } catch {
        // An unreadable or malformed `package.json` in some ancestor is simply
        // not this repository's root; the walk continues rather than failing.
        return false;
    }
};

/**
 * The identity of the root is verified, not assumed. From `scripts/lib` the
 * answer is two levels up, and hard-coding `'..', '..'` would keep compiling
 * while silently reading a different tree if this module ever moves — so the
 * walk accepts a directory only once its `package.json` names this package.
 */
export const resolveRepoRoot = (fromDir: string = __dirname): string => {
    const startDir = path.resolve(fromDir);

    const cached = repoRootCache.get(startDir);
    if (cached !== undefined) {
        return cached;
    }

    let candidate = startDir;
    for (let level = 0; level <= MAX_ASCENT_LEVELS; level += 1) {
        if (hasRepoPackageJson(candidate)) {
            repoRootCache.set(startDir, candidate);
            return candidate;
        }

        const parent = path.dirname(candidate);
        if (parent === candidate) {
            break;
        }
        candidate = parent;
    }

    throw new ManifestError(
        'repo_root_not_found',
        `Could not resolve the backend repository root: no package.json naming "${REPO_PACKAGE_NAME}" was found in ${startDir} or its ${MAX_ASCENT_LEVELS} closest ancestors.`,
    );
};

export const dataPath = (...segments: string[]): string =>
    path.join(resolveRepoRoot(), 'data', 'meal-planning', ...segments);

export const releaseDir = (releaseVersion: string): string => dataPath('catalog', 'releases', releaseVersion);

export const releaseFilePath = (releaseVersion: string, fileName: string): string =>
    path.join(releaseDir(releaseVersion), fileName);

export const reportPath = (fileName: string): string => dataPath('reports', 'latest', fileName);

export const recipesDir = (): string => dataPath('recipes');

export const fixturePath = (fileName: string): string => dataPath('fixtures', fileName);

/**
 * Error messages name the repository-relative path: it is the path an operator
 * or a reviewer recognises, and it keeps a machine-specific absolute path out
 * of terminal output and committed reports. Everything here is guarded because
 * a formatter used on the failure path must not throw over the failure it is
 * reporting.
 */
const describePath = (absolutePath: string): string => {
    try {
        const relative = path.relative(resolveRepoRoot(), absolutePath);
        if (relative.length > 0 && !relative.startsWith('..') && !path.isAbsolute(relative)) {
            return relative;
        }
        return path.basename(absolutePath);
    } catch {
        return path.basename(absolutePath);
    }
};

// Both mean "there is nothing at this path": ENOTDIR is what the platform
// reports when a parent component of the path is a file rather than a folder.
const MISSING_FILE_CODES = new Set(['ENOENT', 'ENOTDIR']);

export const readJsonFile = <T>(absolutePath: string): T => {
    let raw: string;
    try {
        raw = fs.readFileSync(absolutePath, 'utf8');
    } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== undefined && MISSING_FILE_CODES.has(code)) {
            throw new ManifestError(
                'file_not_found',
                `${describePath(absolutePath)} does not exist. Run the pipeline step that produces it before this one.`,
            );
        }
        // A permission fault, or a directory where a file belongs, is a real
        // environment problem rather than a missing input: reporting it as
        // `file_not_found` would send the operator to the wrong fix.
        throw error;
    }

    try {
        return JSON.parse(raw) as T;
    } catch {
        // The parser's own message is deliberately dropped rather than
        // forwarded: since Node 20 it quotes the offending part of the document,
        // and file contents must never reach a log or a committed report.
        throw new ManifestError('invalid_json', `${describePath(absolutePath)} is not valid JSON.`);
    }
};

// Four spaces matches the repository's TypeScript style and these artefacts are
// reviewed as pull-request diffs. Should the hand-authored data files land
// indented with two, change this one constant to match them — a report script
// rewriting an artefact's whitespace on every run is review noise.
const JSON_INDENT = 4;

export const writeJsonFile = (absolutePath: string, value: unknown): void => {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    // `JSON.stringify` never ends with a line break, so appending one produces
    // exactly one — the POSIX convention every other tracked file here follows.
    fs.writeFileSync(absolutePath, `${JSON.stringify(value, null, JSON_INDENT)}\n`, 'utf8');
};

/**
 * The check this module exists for. A manifest that declares a version this
 * build was not written against is refused outright, because the alternative
 * failure is invisible: the pipeline would apply `v1` policy to `v2` data and
 * report a successful run.
 */
export const assertManifestVersion = (args: {
    relativePath: string;
    field: string;
    expected: string;
    found: unknown;
}): void => {
    const { relativePath, field, expected, found } = args;

    if (typeof found !== 'string') {
        throw new ManifestError(
            'missing_version_field',
            `${relativePath} declares no "${field}" version. Every manifest must state the version it was written for, and a new manifest version requires a reviewed code change in scripts/lib/manifest.ts.`,
        );
    }

    if (found !== expected) {
        throw new ManifestError(
            'version_mismatch',
            `${relativePath} declares "${field}" "${found}" but this build understands "${expected}". A new manifest version requires a reviewed code change in scripts/lib/manifest.ts.`,
        );
    }
};

// ---------------------------------------------------------------------------
// The manifest shapes.
//
// Five different contracts, declared in exactly one place for the script
// surface (§4/§6). The four policy manifests are hand-authored and camelCase;
// the release manifest is generated output and snake_case. That difference is
// deliberate and is NOT normalised here: a release manifest is an artefact
// produced by `catalog-release.ts` and consumed by `catalog-load.ts`, its keys
// read like the rows it describes, and renaming them in this loader would put a
// third naming convention between the two scripts.
//
// RECONCILIATION: the committed JSON is the authority for every field and key
// name. The shapes below follow the data files' documented specification; where
// a committed file diverges, this is the file that changes. The loaders cast
// rather than validate structurally, so a divergence surfaces in the consuming
// script — deliberate, because a hand-authored policy file is reviewed input,
// not untrusted input, and re-validating every field here would duplicate the
// checks `catalog-validate.ts` already owns.
//
// `src/services/evidence.logic.ts` and `evidence.service.ts` load
// `evidence-allowlist.v1.json` through their own types instead of importing
// `EvidenceAllowlist` from here, because `src/` must never import from
// `scripts/`. That duplication is the architectural boundary itself and is not
// to be "de-duplicated" away.
// ---------------------------------------------------------------------------

/** The closed 21-value category set every catalog food and target is filed under. */
export type CoverageCategory =
    | 'produce_vegetable'
    | 'produce_fruit'
    | 'protein_meat'
    | 'protein_poultry'
    | 'protein_seafood'
    | 'protein_egg'
    | 'protein_plant'
    | 'dairy'
    | 'dairy_alternative'
    | 'grain'
    | 'bread_bakery'
    | 'legume'
    | 'nut_seed'
    | 'oil_fat'
    | 'condiment_sauce'
    | 'spice_herb'
    | 'beverage'
    | 'snack'
    | 'sweet'
    | 'prepared_meal'
    | 'other';

/** Mirrors `catalog_foods.food_state`; raw, dry and cooked forms never merge. */
export type CatalogFoodState = 'raw' | 'cooked' | 'prepared' | 'dry' | 'as_purchased';

/** The relative-cost scale a recipe's budget tier is derived from. */
export type CostClass = 1 | 2 | 3;

export type UsdaDataType = 'Foundation' | 'SR Legacy' | 'Survey (FNDDS)' | 'Branded' | 'Experimental';

export interface KcalRange {
    readonly min: number;
    readonly max: number;
}

export interface CoveragePlanCategory {
    readonly category: CoverageCategory;
    /** Counts toward the published catalog; the per-category targets sum to 11,010. */
    readonly publishedTarget: number;
    /** `ceil(1.25 × publishedTarget)` — the candidate volume import and generation aim for. */
    readonly candidateVolume: number;
    /** Energy outside this band is atypical rather than impossible: it flags for review. */
    readonly kcalReviewRange: KcalRange;
    /**
     * `grain` and `legume` publish both dry and cooked forms, whose plausible
     * energy bands do not overlap, so those categories carry per-state bands
     * that override the category-wide one.
     */
    readonly kcalReviewRangeByFoodState?: Readonly<Partial<Record<CatalogFoodState, KcalRange>>>;
    /** Rejection bound on `|4P + 4C + 9F − kcal|`, as a percentage of stated energy. */
    readonly energyMacroTolerancePercent: number;
}

export interface CoveragePlanFoodGroup {
    readonly foodGroup: string;
    readonly category: CoverageCategory;
    /** Seeds the disliked-ingredient suggestions, so a dislike excludes a whole group. */
    readonly isCommonDislikeGroup: boolean;
}

export interface CoveragePlanValidationBounds {
    readonly maxKcalPer100g: number;
    readonly macroMassToleranceFactor: number;
    readonly energyMacroAbsoluteToleranceKcal: number;
    readonly portionConversionTolerancePercent: number;
}

export interface CoveragePlanCostClassScale {
    readonly costClass: CostClass;
    readonly label: string;
}

export interface CoveragePlan {
    readonly coveragePlanVersion: string;
    readonly promptVersion: string;
    readonly reviewPromptVersion: string;
    /**
     * Generation plus advisory review — two model calls per batch. Surfaced as
     * data and passed into `budget.ts` by the calling script, which is what
     * stops the factor from being written into the budget arithmetic as a
     * literal that no reviewer would ever see change.
     */
    readonly modelCallsPerBatch: number;
    readonly defaultBatchSize: number;
    /**
     * An ordered list rather than a keyed object: batch keys are
     * `<coveragePlanVersion>:<category>:<batchIndex>`, so a rerun must address
     * the same batches, and a declaration order that a reviewer can read is a
     * stronger guarantee of that than key-insertion order in an object.
     */
    readonly categories: readonly CoveragePlanCategory[];
    readonly foodGroups: readonly CoveragePlanFoodGroup[];
    readonly validationBounds: CoveragePlanValidationBounds;
    /** The check names a quarantined candidate may be recorded against. */
    readonly quarantineChecks: readonly string[];
    readonly costClassScale: readonly CoveragePlanCostClassScale[];
}

/**
 * How the importer picks one of a USDA record's `foodPortions` entries. It
 * carries no gram weight by design — the weight is USDA's to state, and an
 * invented one is exactly the fabricated nutrition the catalog policy forbids.
 */
export interface UsdaDefaultPortionSelector {
    readonly description: string;
    readonly amount?: number;
    readonly unit?: string;
    /** FNDDS records match on `portionDescription`, SR Legacy on `modifier`. */
    readonly portionDescription?: string;
    readonly modifier?: string;
}

/** Used where a curated entry names the food to import but not its FDC id. */
export interface UsdaFoodResolveBy {
    readonly query: string;
    readonly dataTypes?: readonly UsdaDataType[];
    readonly requireDescription?: string;
}

export interface UsdaManifestFood {
    readonly fdcId?: number;
    readonly resolveBy?: UsdaFoodResolveBy;
    readonly usdaDataType: UsdaDataType;
    readonly category: CoverageCategory;
    readonly foodState: CatalogFoodState;
    readonly canonicalName: string;
    readonly displayName: string;
    readonly aliases: readonly string[];
    readonly foodGroup: string;
    readonly defaultPortion: UsdaDefaultPortionSelector;
    readonly costClass: CostClass;
    readonly isCommonDislike: boolean;
}

/** Bulk passes over a whole USDA dataset, beside the curated `foods` entries. */
export interface UsdaDatasetSweep {
    readonly dataType: UsdaDataType;
    readonly category?: CoverageCategory;
    readonly pageSize: number;
    readonly maxPages: number;
}

/** Nutrient numbers from USDA's data dictionary, as the strings the API uses. */
export interface UsdaNutrientNumbers {
    readonly protein: string;
    readonly fat: string;
    readonly carbs: string;
    readonly calories: string;
}

/**
 * What `catalog-import-usda.ts` hands to `rateLimiter.ts`. The configured rate
 * sits below the vendor cap on purpose: the running API shares the same key for
 * label scanning and branded search, and an import that consumed the whole hour
 * would starve live requests.
 */
export interface UsdaImportLimits {
    readonly vendorRequestsPerHour: number;
    readonly configuredRequestsPerHour: number;
    readonly detailBatchSize: number;
    readonly maxListPageSize: number;
}

export interface UsdaManifest {
    readonly usdaManifestVersion: string;
    /** `usda:<fdcId>` — the stable identity every rerun upserts against. */
    readonly sourceKeyFormat: string;
    readonly nutrientNumbers: UsdaNutrientNumbers;
    readonly importLimits: UsdaImportLimits;
    readonly datasetSweeps: readonly UsdaDatasetSweep[];
    readonly foods: readonly UsdaManifestFood[];
}

export interface SearchBenchmarkThresholds {
    readonly topThreeHitRate: number;
    readonly topTenHitRate: number;
    readonly maxZeroResultRate: number;
    readonly p95LatencyMs: number;
    /** The page size the latency threshold is stated for. */
    readonly latencyLimit: number;
}

export interface SearchBenchmarkProtocol {
    readonly warmupPasses: number;
    readonly timedPasses: number;
    readonly sequential: boolean;
    readonly connections: number;
    /** Where the stopwatch sits, so a report's numbers are comparable at all. */
    readonly timing: string;
}

export interface SearchBenchmarkPaginationCheck {
    readonly queryIds: readonly string[];
    readonly limit: number;
    readonly pages: number;
    readonly singlePageLimit: number;
}

export interface SearchBenchmarkQuery {
    readonly id: string;
    readonly q: string;
    /** Query family — a plain string so a new family is a data change. */
    readonly kind: string;
    /**
     * Acceptable answers as stable `source_key` values, never database ids:
     * a benchmark that named local UUIDs could not be replayed against a second
     * freshly loaded database, which is how release determinism is evidenced.
     */
    readonly expected: readonly string[];
}

export interface SearchBenchmark {
    readonly benchmarkVersion: string;
    readonly catalogRelease: string;
    readonly thresholds: SearchBenchmarkThresholds;
    /** The ordering the ranks are asserted against, most significant first. */
    readonly ordering: readonly string[];
    readonly protocol: SearchBenchmarkProtocol;
    readonly reportedConditions: readonly string[];
    readonly paginationCheck: SearchBenchmarkPaginationCheck;
    readonly queries: readonly SearchBenchmarkQuery[];
}

/**
 * Exactly as the IANA registries state it: `true`, `false`, or the literal
 * `'n/a'`. The three are not collapsed into a boolean, because only a row
 * marked `true` may be treated as globally routable — `'n/a'` is not "unknown,
 * so probably fine", and flattening it would open the fetch path the evidence
 * policy exists to close.
 */
export type GloballyReachable = boolean | 'n/a';

export interface SpecialPurposeRange {
    readonly cidr: string;
    readonly name: string;
    readonly registry: string;
    readonly globallyReachable: GloballyReachable;
}

export interface EvidenceHostClass {
    readonly id: string;
    readonly description: string;
    /** Exact hosts and `*.` wildcard entries, matched per label, never as substrings. */
    readonly hosts: readonly string[];
    readonly evidenceTypes: readonly string[];
}

export interface EvidenceFetchLimits {
    readonly timeoutMs: number;
    /** Enforced on the decompressed body, so a compressed bomb cannot pass it. */
    readonly maxBodyBytes: number;
    readonly maxRedirects: number;
    readonly allowedContentTypes: readonly string[];
    readonly maxSnippetChars: number;
}

export interface EvidenceAllowlist {
    readonly allowlistVersion: string;
    /** The date the address table was transcribed, so a refresh is a reviewed data change. */
    readonly registrySnapshot: string;
    readonly rowCount: number;
    readonly hostClasses: readonly EvidenceHostClass[];
    readonly specialPurposeRanges: readonly SpecialPurposeRange[];
    readonly fetchLimits: EvidenceFetchLimits;
}

/**
 * Declared for `catalog-load.ts` to read; nothing in this module computes or
 * compares a digest — verifying a release's files is that script's job.
 */
export interface CatalogReleaseFile {
    readonly path: string;
    readonly sha256: string;
    readonly row_count: number;
    readonly bytes: number;
}

export interface CatalogReleaseCounts {
    readonly foods: number;
    readonly aliases: number;
    readonly portions: number;
    readonly components: number;
    readonly validation_records: number;
}

export interface CatalogReleaseSourceDataset {
    readonly name: string;
    readonly version: string;
    readonly retrieved_at?: string;
}

export interface CatalogReleaseModelVersions {
    readonly generation_model: string;
    readonly review_model: string;
    readonly prompt_version: string;
    readonly review_prompt_version: string;
}

export interface CatalogReleaseCoverageRow {
    readonly category: CoverageCategory;
    readonly published: number;
    readonly published_target: number;
    /** Reported exactly and never rounded: a shortfall is an unmet requirement. */
    readonly shortfall: number;
}

export interface CatalogReleaseCoverage {
    readonly published_total: number;
    readonly shortfall_total: number;
    readonly categories: readonly CatalogReleaseCoverageRow[];
}

/** Generated output, so snake_case throughout — see the note above. */
export interface CatalogReleaseManifest {
    readonly release_id: string;
    /** Optional: checked only when the generating script wrote one. */
    readonly manifest_version?: string;
    readonly coverage_plan_version: string;
    readonly generated_at: string;
    readonly produced_by: string;
    readonly files: readonly CatalogReleaseFile[];
    readonly counts: CatalogReleaseCounts;
    readonly source_datasets: readonly CatalogReleaseSourceDataset[];
    readonly model_versions: CatalogReleaseModelVersions;
    readonly coverage: CatalogReleaseCoverage;
}

// ---------------------------------------------------------------------------
// Loaders.
//
// Memoised by absolute path in a module-level map. One run reads the coverage
// plan from several call sites — the batch planner, the validator and the
// report all consult it — and re-reading it would let a single multi-hour run
// act on two different views of the same policy if the file were edited
// underneath it. Reading configuration once is the other half of the rule that
// puts it behind these accessors (§1.6/§9).
//
// The map fills on the first call and never at import time, and
// `clearManifestCache` exists so a test or a long-lived process can force a
// re-read rather than restart.
// ---------------------------------------------------------------------------

const manifestCache = new Map<string, unknown>();

interface VersionCheck {
    readonly field: string;
    readonly expected: string;
    /** An absent optional field is not a missing version, so it is skipped. */
    readonly optional?: boolean;
}

// A document that parses to `null`, an array or a scalar has no version field
// to read. Yielding `undefined` turns that into `missing_version_field` — the
// module's own loud failure — instead of a property access on nothing.
const readVersionField = (value: unknown, field: string): unknown =>
    value !== null && typeof value === 'object' ? (value as Record<string, unknown>)[field] : undefined;

const loadVersionedManifest = <T>(absolutePath: string, checks: readonly VersionCheck[]): T => {
    const cached = manifestCache.get(absolutePath);
    if (cached !== undefined) {
        return cached as T;
    }

    const relativePath = describePath(absolutePath);
    const parsed = readJsonFile<T>(absolutePath);

    let declaredVersion: string | null = null;
    for (const check of checks) {
        const found = readVersionField(parsed, check.field);
        if (check.optional === true && found === undefined) {
            continue;
        }
        assertManifestVersion({ relativePath, field: check.field, expected: check.expected, found });
        if (declaredVersion === null) {
            declaredVersion = found as string;
        }
    }

    // Cached only once every check has passed, so a refused manifest is never
    // memoised and the next call fails the same way instead of succeeding.
    manifestCache.set(absolutePath, parsed);
    // One line per real read: a cache hit is not a load, which also makes the
    // memoisation visible in a run's output.
    logger.info('manifest_loaded', { file: relativePath, version: declaredVersion });

    return parsed;
};

export const loadCoveragePlan = (): CoveragePlan =>
    loadVersionedManifest<CoveragePlan>(dataPath(COVERAGE_PLAN_FILE), [
        { field: COVERAGE_PLAN_VERSION_FIELD, expected: EXPECTED_COVERAGE_PLAN_VERSION },
    ]);

export const loadUsdaManifest = (): UsdaManifest =>
    loadVersionedManifest<UsdaManifest>(dataPath(USDA_MANIFEST_FILE), [
        { field: USDA_MANIFEST_VERSION_FIELD, expected: EXPECTED_USDA_MANIFEST_VERSION },
    ]);

export const loadSearchBenchmark = (): SearchBenchmark =>
    loadVersionedManifest<SearchBenchmark>(dataPath(SEARCH_BENCHMARK_FILE), [
        { field: SEARCH_BENCHMARK_VERSION_FIELD, expected: EXPECTED_SEARCH_BENCHMARK_VERSION },
    ]);

export const loadEvidenceAllowlist = (): EvidenceAllowlist =>
    loadVersionedManifest<EvidenceAllowlist>(dataPath(EVIDENCE_ALLOWLIST_FILE), [
        { field: EVIDENCE_ALLOWLIST_VERSION_FIELD, expected: EXPECTED_EVIDENCE_ALLOWLIST_VERSION },
    ]);

export const loadReleaseManifest = (releaseVersion: string): CatalogReleaseManifest =>
    loadVersionedManifest<CatalogReleaseManifest>(releaseFilePath(releaseVersion, RELEASE_MANIFEST_FILE), [
        // A release is only interpretable against the policy it was produced
        // from, so the coverage-plan version is the load-bearing check here;
        // the manifest's own schema version is checked when one was written.
        { field: RELEASE_COVERAGE_PLAN_VERSION_FIELD, expected: EXPECTED_COVERAGE_PLAN_VERSION },
        { field: RELEASE_MANIFEST_VERSION_FIELD, expected: EXPECTED_RELEASE_MANIFEST_VERSION, optional: true },
    ]);

export const clearManifestCache = (): void => {
    manifestCache.clear();
    // The resolved root is configuration read once as well, so leaving it in
    // place would not be the clean slate a test asking for a reset expects.
    repoRootCache.clear();
};
