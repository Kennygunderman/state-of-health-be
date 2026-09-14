// The versioned manifest loader and repository-root path resolver for the
// meal-planning data files under `backend/data/meal-planning/`. Eight of the
// nine CLI entry points in `backend/scripts/` read their inputs through this
// module (`seed-dev.ts` is the exception), and it makes them two promises.
//
// FIRST: paths resolve from the repository root, never from the process working
// directory, and they stay inside `data/meal-planning`. A script launched from
// another directory — or through tooling that changes the working directory
// under it — must still read the same files, where `path.resolve('data/…')`
// would quietly read a different tree or nothing at all. `.dockerignore`
// excludes both `scripts` and `data`, so these paths exist only in the
// repository and in operator checkouts and never inside the production image;
// the nine `npm run` entry points all execute TypeScript from source under
// `ts-node`, so resolving relative to this module's own location is correct in
// every environment the pipeline runs in, while anything derived from a `dist/`
// layout would not be. Containment is the other half of the same promise: a
// segment reaching these helpers from an operator's flag or from a manifest on
// disk is validated as one name inside the tree before it becomes a path, so
// what a caller reads and writes is a meal-planning data file and nothing else.
//
// SECOND: a manifest whose declared version this build does not understand
// fails loudly. These files carry policy — category targets, validation bounds,
// vendor rate limits, the IANA special-purpose address table — and a `v2` file
// read under `v1` assumptions would not crash. It would import a catalog
// against the wrong numbers and report success. Rule backend-architecture
// §1.6/§9 puts that decision here, at the single boundary where the
// configuration is read, behind accessors that throw rather than coerce (§8).
//
// Scope (§1.1, §7.1): this module resolves paths, reads and writes JSON,
// compares versions, and verifies that the one policy document whose missing
// fields would silently remove a security limit — the evidence allowlist —
// carries the fields its declared shape promises. Checksum verification belongs
// to `catalog-load.ts`, JSONL streaming to the release and load scripts,
// shortfall arithmetic to `catalog-report.ts`, the evidence policy's meaning to
// `src/services/evidence.logic.ts`, and model-call budgeting to `budget.ts`. It imports two
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
 *
 * The last three are refusals rather than absences, and an operator acts on
 * each of them differently. `invalid_path_segment` means a name this module was
 * asked to build a path from — a `--release` id, a file name read out of a
 * release manifest — is not a single name inside the data tree, so the argument
 * is wrong. `path_outside_data_root` is the containment invariant itself
 * failing: bad input is already refused by the segment rule, so this one means
 * the module or the checkout layout moved, not that a caller passed something
 * odd. `invalid_manifest_shape` means a policy document parsed and declared the
 * version this build understands but does not carry the fields that version
 * promises, so the document and this loader have to be reconciled before the
 * run continues.
 */
export type ManifestErrorCode =
    | 'repo_root_not_found'
    | 'file_not_found'
    | 'invalid_json'
    | 'missing_version_field'
    | 'version_mismatch'
    | 'invalid_path_segment'
    | 'path_outside_data_root'
    | 'invalid_manifest_shape';

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

// A byte-order mark is the one invisible reason a reviewed JSON file refuses to
// parse, and reading as `utf8` hands it straight through: Node decodes the three
// UTF-8 bytes to U+FEFF and leaves it at the head of the string, where
// `JSON.parse` rejects it as an unexpected token. RFC 8259 §8.1 lets a parser
// ignore it, every editor renders the document as ordinary JSON, and it arrives
// by accident rather than by intent — an editor or an export saving "UTF-8 with
// BOM" over a file authored here. So one leading mark is dropped before parsing,
// at both of this module's parse sites, and the reader names it (below) instead
// of a run dying over a byte nobody can see.
//
// One, and only at the head. A second mark, or one between values, is document
// content rather than an encoding artefact, and a file carrying it stays
// invalid — tolerating those would start repairing documents, which is not this
// module's job.
const UTF8_BOM = '\uFEFF';

const stripUtf8Bom = (text: string): string =>
    text.startsWith(UTF8_BOM) ? text.slice(UTF8_BOM.length) : text;

const hasRepoPackageJson = (candidate: string): boolean => {
    let raw: string;
    try {
        raw = fs.readFileSync(path.join(candidate, 'package.json'), 'utf8');
    } catch {
        return false;
    }

    try {
        // Stripped here too, and silently: a mark on the repository's own
        // `package.json` would otherwise make this candidate unparseable, the
        // walk run out of ancestors, and the failure report `repo_root_not_found`
        // — sending an operator to look for a wrong checkout over one byte in a
        // file that is not even the one being loaded.
        const parsed: unknown = JSON.parse(stripUtf8Bom(raw));
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

// ---------------------------------------------------------------------------
// Path building, and why it is guarded.
//
// Not every segment these helpers receive is a literal written above them. A
// release id arrives from an operator's `--release <id>` flag, and a release
// file name arrives from the `files[].path` entries of a manifest read off
// disk. `path.join` resolves `..` without complaint, so
// `releaseFilePath('..', '../../../etc/passwd')` used to normalise to a path
// outside the data tree — which the callers then read through `readJsonFile`
// and write through `writeJsonFile`, and `writeJsonFile` creates missing
// parents on the way. Root containment is one of this module's two promises
// (see the header), so it is enforced here, at the single place every path is
// built, rather than left to nine CLI scripts to remember.
//
// A segment is therefore one name — a single directory or file inside the data
// tree — held to an allowlist rather than checked against a `..` denylist: a
// denylist has to anticipate every spelling of "parent" a platform accepts,
// while an allowlist admits only the shapes the committed tree actually uses
// (`catalog`, `releases`, `v1`, `foods.jsonl`, `coverage-plan.v1.json`,
// `chicken-burrito-bowl.json`). Callers that need a nested path pass several
// segments, which is already the established style: `dataPath('catalog',
// 'releases', version)`.
// ---------------------------------------------------------------------------

const SAFE_PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

// Named so the refusal can say which of the two it was, instead of reporting a
// character-class failure for the one input an operator is most likely to try.
const RELATIVE_SEGMENTS = new Set(['.', '..']);

// `v1`, `v2`, … — the release identifier form the catalog release tree is laid
// out under (`data/meal-planning/catalog/releases/v<N>/`). Checked separately
// from the generic segment rule so `--release ../../etc` is answered with the
// expected form rather than with a character class.
const RELEASE_VERSION_PATTERN = /^v[0-9]+$/;

// A rejected name is diagnostic gold, and quoting it is how an operator sees
// what their flag actually contained; the length cap is why it can be quoted at
// all — a file name read out of a manifest is file content, and this module
// never lets a document's bytes reach a log or a committed report unbounded.
const MAX_DESCRIBED_SEGMENT_CHARS = 80;

const describeSegment = (value: unknown): string => {
    const rendered = typeof value === 'string' ? value : String(value);
    const bounded =
        rendered.length > MAX_DESCRIBED_SEGMENT_CHARS
            ? `${rendered.slice(0, MAX_DESCRIBED_SEGMENT_CHARS)}…`
            : rendered;
    // Quoted rather than interpolated bare, so a name that is empty, or is all
    // whitespace, or ends in a separator is visible as such in the message.
    return JSON.stringify(bounded);
};

/**
 * Accepts one path segment and returns it, or throws
 * `ManifestError('invalid_path_segment')`. `role` names the argument in the
 * message ("release id", "report file name") so the refusal reads as something
 * about the caller's input rather than about this module's internals.
 *
 * Exported and argument-driven because it is the decision worth pinning from
 * `src/__tests__/scripts/` (rule backend-architecture §11): its failure
 * branches are the traversal guard.
 */
export const assertSafePathSegment = (segment: string, role: string): string => {
    if (typeof segment !== 'string' || segment.length === 0) {
        throw new ManifestError(
            'invalid_path_segment',
            `A meal-planning ${role} must be a non-empty name; received ${describeSegment(segment)}.`,
        );
    }

    if (RELATIVE_SEGMENTS.has(segment)) {
        throw new ManifestError(
            'invalid_path_segment',
            `A meal-planning ${role} may not be ${describeSegment(segment)}: it names a directory relative to its parent rather than something inside data/meal-planning.`,
        );
    }

    if (!SAFE_PATH_SEGMENT.test(segment)) {
        throw new ManifestError(
            'invalid_path_segment',
            `A meal-planning ${role} must be a single name of letters, digits, ".", "-" and "_" starting with a letter or digit; received ${describeSegment(segment)}. Path separators, "..", and absolute paths are refused so a name that reaches this module from a flag or a manifest cannot address a file outside data/meal-planning.`,
        );
    }

    return segment;
};

/**
 * The release id is the one segment an operator types by hand, so it carries
 * its own rule on top of the segment rule.
 */
export const assertReleaseVersion = (releaseVersion: string): string => {
    assertSafePathSegment(releaseVersion, 'release id');

    if (!RELEASE_VERSION_PATTERN.test(releaseVersion)) {
        throw new ManifestError(
            'invalid_path_segment',
            `A catalog release id must be "v" followed by digits, for example "v1"; received ${describeSegment(releaseVersion)}.`,
        );
    }

    return releaseVersion;
};

/** The canonical directory every path this module returns must live in. */
const mealPlanningDataRoot = (): string => path.resolve(resolveRepoRoot(), 'data', 'meal-planning');

/**
 * Validate, resolve canonically, then prove containment. The third step is
 * unreachable while the segment rule holds, and it is kept deliberately: it is
 * the invariant the other two steps exist to produce, it costs one `path.relative`
 * per call, and it is what still fails loudly if this module later grows a
 * caller that builds a segment some other way.
 */
const buildDataPath = (segments: readonly string[], role: string): string => {
    const root = mealPlanningDataRoot();
    const checked = segments.map((segment) => assertSafePathSegment(segment, role));
    const resolved = path.resolve(root, ...checked);

    const relative = path.relative(root, resolved);
    const escapes = relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
    if (escapes) {
        throw new ManifestError(
            'path_outside_data_root',
            `data/meal-planning/${checked.join('/')} resolves outside the meal-planning data root. Every path this module returns must name the data root itself or something inside it.`,
        );
    }

    return resolved;
};

export const dataPath = (...segments: string[]): string => buildDataPath(segments, 'path segment');

export const releaseDir = (releaseVersion: string): string =>
    buildDataPath(['catalog', 'releases', assertReleaseVersion(releaseVersion)], 'release id');

// Built from the full segment list rather than by joining onto `releaseDir`'s
// answer, so the file name passes the same gate as every other segment instead
// of being appended to an already-validated path.
export const releaseFilePath = (releaseVersion: string, fileName: string): string =>
    buildDataPath(['catalog', 'releases', assertReleaseVersion(releaseVersion), fileName], 'release file name');

export const reportPath = (fileName: string): string =>
    buildDataPath(['reports', 'latest', fileName], 'report file name');

export const recipesDir = (): string => buildDataPath(['recipes'], 'path segment');

export const fixturePath = (fileName: string): string => buildDataPath(['fixtures', fileName], 'fixture file name');

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

    const hadBom = raw.startsWith(UTF8_BOM);
    if (hadBom) {
        // Named rather than swallowed. The document parses once the mark is
        // ignored, so the run continues — but the mark is invisible in every
        // editor, it survives into a reviewed diff, and the bytes of a file are
        // what `catalog-load.ts` checksums a release against, so an operator who
        // is never told keeps a file that reads as correct and hashes as
        // something else. A mark is a fact about the file's encoding rather than
        // any of its content, so saying so leaves the rule below intact.
        logger.warn('manifest_bom_stripped', {
            file: describePath(absolutePath),
            remedy: 'Re-save the file as UTF-8 without a byte-order mark.',
        });
    }

    try {
        return JSON.parse(stripUtf8Bom(raw)) as T;
    } catch {
        // The parser's own message is deliberately dropped rather than
        // forwarded: since Node 20 it quotes the offending part of the document,
        // and file contents must never reach a log or a committed report. What
        // takes its place is the one cause an operator cannot see in the file
        // itself, so a document that still fails after its mark was ignored says
        // that much rather than leaving the encoding as an open question.
        throw new ManifestError(
            'invalid_json',
            hadBom
                ? `${describePath(absolutePath)} is not valid JSON, even with its leading byte-order mark ignored. Re-save it as UTF-8 without a byte-order mark, then check the document parses.`
                : `${describePath(absolutePath)} is not valid JSON.`,
        );
    }
};

// Two spaces, because that is what the committed artefacts under
// `data/meal-planning/` are indented with — `evidence-allowlist.v1.json` is the
// one that exists as this is written, and it uses two. These files are reviewed
// as pull-request diffs, so a report or release script that reindented an
// artefact on every run would produce a whitespace-only diff over the whole
// file and bury the change a reviewer is there to read. The repository's
// four-space rule governs TypeScript source, which this constant is not about.
const JSON_INDENT = 2;

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
// a committed file diverges, this is the file that changes — and for the one
// document that is committed today it did: `EvidenceHostClass` and
// `EvidenceFetchLimits` are transcribed from `evidence-allowlist.v1.json` as it
// actually stands, not from the intended field list (see the note above each).
//
// Four of the five loaders cast rather than validate structurally, so a
// divergence surfaces in the consuming script — deliberate, because a
// hand-authored policy file is reviewed input, not untrusted input, and
// re-validating every field here would duplicate the checks
// `catalog-validate.ts` already owns.
//
// `evidence-allowlist.v1.json` is the exception, and `loadEvidenceAllowlist`
// validates it at runtime, because "surfaces in the consuming script" is not
// true of this one document: it is the SSRF policy. A `fetchLimits` member that
// is missing rather than wrong does not throw downstream, it removes a limit —
// an absent `maxBodyBytes` is no size cap at all — and a `specialPurposeRanges`
// row whose `cidr` is missing silently drops a range from the non-globally-
// routable table, which turns every address inside it into an address the fetch
// path accepts. Neither failure is visible in a run's output. So this loader
// checks the fields the policy is made of and refuses the document otherwise
// (`invalid_manifest_shape`); it does not re-derive the policy, which belongs
// to `src/services/evidence.logic.ts`.
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
    /** The model names generation and review would use; recorded, not invoked here. */
    readonly generationModel?: string;
    readonly reviewModel?: string;
    /**
     * The sum of every category's `publishedTarget` — 11,010, which carries
     * 1,010 of slack over the 10,000 the feature requires, so late
     * quarantines do not put the requirement at risk. Stated in the document
     * rather than summed in code, so a reviewer can see the intended total and
     * a report can name the shortfall against it exactly.
     */
    readonly publishedTargetTotal: number;
    /** `ceil(1.25 × publishedTargetTotal)` — what import and generation aim for. */
    readonly candidateVolumeTotal?: number;
    /** Asserted against `foodGroups.length`, so a truncated document is caught. */
    readonly foodGroupCount?: number;
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
    /**
     * The description the record carried when its id was verified. The importer
     * compares it with the live record and downgrades `identity_status` to
     * `ambiguous` on a mismatch rather than importing under a stale identity.
     */
    readonly expectedUsdaDescription?: string;
    readonly category: CoverageCategory;
    readonly foodState: CatalogFoodState;
    readonly canonicalName: string;
    readonly displayName: string;
    readonly aliases: readonly string[];
    readonly foodGroup: string;
    readonly defaultPortion: UsdaDefaultPortionSelector;
    readonly costClass: CostClass;
    readonly isCommonDislike: boolean;
    /**
     * The reviewed allergen and diet determination for this food, and the ONLY
     * source of a curated food's safety metadata — see the document's
     * `curatedSafetyContract`. Optional in the type because an older manifest
     * predates it, and an entry without one is treated as `unknown`: an empty
     * `allergenTags` list is the claim "reviewed, and this food contains none
     * of the nine", so it may only ever be written from a block that actually
     * says `known`.
     */
    readonly reviewedSafety?: UsdaReviewedSafety;
}

/**
 * A reviewed safety determination. `allergenStatus` is what the planner reads
 * to decide whether a food may be put in front of someone with an allergy
 * (AAP 0.7.3 requires `known` for every planned ingredient), so it is never
 * inferred: derivation from a description or food group is exactly what
 * `sweepAllergenDietRules.allergenStatusRule` refuses to call review.
 */
export interface UsdaReviewedSafety {
    readonly allergenStatus: 'known' | 'unknown';
    readonly allergenTags: readonly string[];
    readonly dietTags: readonly string[];
    /** Why no determination exists, on an entry that carries none. */
    readonly note?: string;
}

/**
 * One classification rule of `sweepClassificationRules`. Exactly one of the two
 * match fields is present, and rules are evaluated in array order with the
 * first match winning — so the array's order is part of the policy, and the
 * document's own `appendOnlyContract` is what makes adding a rule safe.
 */
export interface UsdaSweepClassificationRule {
    readonly descriptionStartsWith?: readonly string[];
    readonly descriptionContains?: readonly string[];
    readonly category: CoverageCategory;
    readonly foodGroup: string;
    /**
     * `true` marks a description that is recognised and deliberately out of
     * scope — restaurant menu items, infant and baby foods. The record is
     * skipped rather than imported under a guessed identity.
     */
    readonly excludeFromPublication?: boolean;
    /** Records which review pass appended the rule; absent on the original set. */
    readonly appendedBy?: string;
}

/** Where an unmatched description lands: a candidate a curator still owns. */
export interface UsdaSweepClassificationFallback {
    readonly category: CoverageCategory;
    readonly foodGroup: string;
    readonly requiresCuratorReview: boolean;
    readonly reason: string;
}

export interface UsdaSweepClassificationRules {
    readonly rules: readonly UsdaSweepClassificationRule[];
    readonly fallback: UsdaSweepClassificationFallback;
}

export interface UsdaSweepFoodStateRule {
    readonly descriptionContains?: readonly string[];
    readonly descriptionStartsWith?: readonly string[];
    readonly foodState: CatalogFoodState;
}

export interface UsdaSweepFoodStateRules {
    readonly rules: readonly UsdaSweepFoodStateRule[];
    /** The state an unmatched description takes, decided by its dataset. */
    readonly datasetFallback: readonly { readonly dataType: UsdaDataType; readonly foodState: CatalogFoodState }[];
}

/**
 * The sweeps' brand screen. It enforces the manifest's own
 * `brandedDataTypePolicy` — a manufacturer identity enters the catalog only
 * through a curated entry — and is deliberately not
 * `findBrandPatternMatch`, whose proper-noun heuristic is scoped to
 * AI-generated candidates and false-positives on USDA's comma-inverted
 * descriptions.
 */
export interface UsdaSweepBrandExclusionRules {
    readonly signals: {
        readonly trademarkSymbols: readonly string[];
        readonly brandWordContains: readonly string[];
        readonly allCapsRun: {
            readonly minimumLetters: number;
            readonly allowedAllCaps: readonly string[];
        };
    };
}

/** Relative cost policy for swept records, which carry no curated `costClass`. */
export interface UsdaSweepCostClassRules {
    readonly byCategory: Readonly<Record<string, CostClass>>;
    readonly foodGroupOverrides: Readonly<Record<string, CostClass>>;
}

/**
 * How a swept record's allergen and diet tags are derived. The derivation only
 * narrows — it can add an allergen and remove a diet tag, never the reverse —
 * and `allergen_status` is `unknown` for every swept record, because inference
 * is not review.
 */
export interface UsdaSweepAllergenDietRules {
    readonly allergenVocabulary: readonly string[];
    readonly byFoodGroup: Readonly<Record<string, readonly string[]>>;
    readonly descriptionAllergenMarkers: Readonly<Record<string, readonly string[]>>;
    readonly dietTagVocabulary: readonly string[];
    readonly dietDerivation: {
        readonly animalCategories: readonly string[];
        readonly animalMarkers: readonly string[];
        readonly seafoodMarkers: readonly string[];
        readonly dairyEggMarkers: readonly string[];
    };
    readonly compositeMarkers: { readonly markers: readonly string[] };
}

/** The `100 g` row every published per-100 g record carries: the stated basis. */
export interface UsdaSweepBasisPortion {
    readonly description: string;
    readonly amount: number;
    readonly unit: string;
    readonly gramWeight: number;
    readonly source: string;
    readonly isDefaultWhenNoHouseholdPortion: boolean;
}

export interface UsdaSweepPortionPolicy {
    readonly basisPortion: UsdaSweepBasisPortion;
}

/** Bulk passes over a whole USDA dataset, beside the curated `foods` entries. */
export interface UsdaDatasetSweep {
    /** Stable across reruns: it is what a checkpoint and a report name. */
    readonly sweepKey: string;
    readonly dataType: UsdaDataType;
    readonly category?: CoverageCategory;
    readonly listEndpoint: string;
    readonly pageSize: number;
    readonly maxPages: number;
    /** Measured, so a sweep stops one page past the data instead of guessing. */
    readonly observedLastNonEmptyPage?: number;
    readonly observedApproximateRecordCount?: number;
    readonly observedOn?: string;
    readonly detailFetch: {
        readonly endpoint: string;
        readonly method: string;
        readonly batchSize: number;
    };
    /** A curated entry is authoritative, so the sweep never re-imports its id. */
    readonly skipFdcIdsPresentInFoods?: boolean;
    readonly stopWhenCategoryCandidateVolumeReached?: boolean;
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
    /**
     * `4*protein + 4*carbs + 9*fat` — the documented derivation for a record
     * that states macros but no energy value, which is common in Foundation.
     * Applied by the importer and recorded as a nutrition assumption on the
     * food's validation record, never silently.
     */
    readonly caloriesFallback: string;
    readonly importLimits: UsdaImportLimits;
    readonly datasetSweeps: readonly UsdaDatasetSweep[];
    readonly foods: readonly UsdaManifestFood[];
    readonly sweepClassificationRules: UsdaSweepClassificationRules;
    readonly sweepFoodStateRules: UsdaSweepFoodStateRules;
    readonly sweepBrandExclusionRules: UsdaSweepBrandExclusionRules;
    readonly sweepCostClassRules: UsdaSweepCostClassRules;
    readonly sweepAllergenDietRules: UsdaSweepAllergenDietRules;
    readonly sweepPortionPolicy: UsdaSweepPortionPolicy;
    /**
     * The written rule that {@link UsdaManifestFood.reviewedSafety} is the only
     * source of a curated food's allergen and diet metadata, and that an empty
     * `allergenTags` list under `allergenStatus: 'known'` is itself a reviewed
     * claim rather than an absence of one. Declared here because a reader of
     * the manifest has to be able to find it, and a reviewer has to be able to
     * see it change.
     */
    readonly curatedSafetyContract?: string;
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

/**
 * One curated allowlist entry group, transcribed from the committed document:
 * `hostClasses[]` entries carry `class`, `hosts` and `evidenceTypes`, and
 * nothing else. They carry no `id` and no `description`, and an earlier version
 * of this interface declared both as required `string`s — a script reading
 * `hostClass.id` would have been handed `undefined` under a type promising a
 * string, and `hostClass.class`, the identifier the document does write, was
 * not visible to the type at all.
 *
 * `src/services/evidence.logic.ts` resolves the identifier through
 * `evidenceHostClassId`, which prefers `class`; this shape is what that
 * preference was written for.
 */
export interface EvidenceHostClass {
    /** `usda_fdc`, `government_nutrition_reference`, … — the document's own key. */
    readonly class: string;
    /** Exact hosts and `*.` wildcard entries, matched per label, never as substrings. */
    readonly hosts: readonly string[];
    /** The evidence kinds this class may corroborate; every committed class states at least one. */
    readonly evidenceTypes: readonly string[];
}

/**
 * The fetch policy as the committed document declares it. `schemes` and
 * `allowedPorts` are the https-only and port-443-only halves of that policy and
 * were absent from an earlier version of this interface, so a script could not
 * see the two limits it is required to enforce.
 *
 * `maxSnippetChars` is optional because the committed v1 document does not
 * state it: `src/services/evidence.logic.ts` applies the reviewed canonical cap
 * when it is absent. Declaring it required here would have certified a value
 * the file does not carry — and `slice(0, undefined)` returns the whole body,
 * which is the snippet cap disappearing rather than failing.
 *
 * Enforcement itself belongs to `evidence.service.ts`, which owns the socket.
 */
export interface EvidenceFetchLimits {
    /** `['https']` — a scheme list, because the policy is an allowlist, not a flag. */
    readonly schemes: readonly string[];
    /** `[443]` — the default https port only; a non-default port is refused. */
    readonly allowedPorts: readonly number[];
    readonly maxRedirects: number;
    readonly timeoutMs: number;
    /** Enforced on the decompressed body, so a compressed bomb cannot pass it. */
    readonly maxBodyBytes: number;
    readonly allowedContentTypes: readonly string[];
    /** Absent from the committed v1 document — see the note above. */
    readonly maxSnippetChars?: number;
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

// ---------------------------------------------------------------------------
// Evidence-allowlist shape validation.
//
// Hand-written, because no schema validator is installed and none is being
// added: validation in this repository is written out. Focused, because this is
// not a second copy of the evidence policy — it answers one question, "does the
// document carry the fields the declared type promises", so that what the type
// says and what has been checked are the same set. Everything about what those
// values MEAN — which schemes are permitted, how a CIDR is matched, which
// address families nest — stays in `src/services/evidence.logic.ts`.
//
// Every check takes its data as an argument and the whole entry point is
// exported, so `src/__tests__/scripts/` can drive each failure branch without a
// database and without touching the committed document (rule
// backend-architecture §11).
// ---------------------------------------------------------------------------

/**
 * The third value the IANA registries state, beside `true` and `false`. Named
 * because it appears in both the check and the message it produces, and a typo
 * in either would be a check that accepts nothing or a message that misreports
 * what the document may say.
 */
const GLOBALLY_REACHABLE_NA = 'n/a';

const shapeError = (relativePath: string, detail: string): ManifestError =>
    new ManifestError(
        'invalid_manifest_shape',
        `${relativePath} ${detail}. The document and the shape declared in scripts/lib/manifest.ts must be reconciled before this run can continue.`,
    );

const requireRecord = (value: unknown, relativePath: string, field: string): Record<string, unknown> => {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw shapeError(relativePath, `declares ${field} as something other than a JSON object`);
    }
    return value as Record<string, unknown>;
};

const requireNonEmptyString = (value: unknown, relativePath: string, field: string): string => {
    if (typeof value !== 'string' || value.length === 0) {
        throw shapeError(relativePath, `declares no non-empty string ${field}`);
    }
    return value;
};

/**
 * Integers only: every numeric field in this document is a count, a duration in
 * milliseconds, a byte size or a port, and a fractional or non-finite value in
 * any of them is a document error rather than a limit to round.
 */
const requireInteger = (value: unknown, relativePath: string, field: string, minimum: number): number => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum) {
        throw shapeError(relativePath, `declares ${field} as something other than an integer of at least ${minimum}`);
    }
    return value;
};

const requireNonEmptyArray = (value: unknown, relativePath: string, field: string): readonly unknown[] => {
    if (!Array.isArray(value) || value.length === 0) {
        throw shapeError(relativePath, `declares ${field} as something other than a non-empty array`);
    }
    return value;
};

const requireNonEmptyStringArray = (value: unknown, relativePath: string, field: string): readonly string[] =>
    requireNonEmptyArray(value, relativePath, field).map((entry, index) =>
        requireNonEmptyString(entry, relativePath, `${field}[${index}]`),
    );

/**
 * `false` and `'n/a'` both reject a fetch and only `true` permits one, so the
 * one thing this check must not do is accept a near-miss: the string `'false'`
 * is truthy, and a row that carried it would read as globally routable to any
 * consumer testing the value for truth rather than for `=== true`.
 */
const requireGloballyReachable = (value: unknown, relativePath: string, field: string): GloballyReachable => {
    if (typeof value === 'boolean' || value === GLOBALLY_REACHABLE_NA) {
        return value;
    }
    throw shapeError(
        relativePath,
        `declares ${field} as something other than true, false or "${GLOBALLY_REACHABLE_NA}", which is how the IANA registries state it`,
    );
};

/**
 * Refuses `evidence-allowlist.v1.json` unless it carries every field the
 * declared `EvidenceAllowlist` shape promises, and returns it typed.
 *
 * The document is verified in place and returned as-is rather than rebuilt from
 * the checked fields, so a reviewed addition to it still reaches the script that
 * wants it instead of being quietly dropped by this function.
 */
export const assertEvidenceAllowlistShape = (value: unknown, relativePath: string): EvidenceAllowlist => {
    const document = requireRecord(value, relativePath, 'its top level');

    requireNonEmptyString(document.allowlistVersion, relativePath, 'allowlistVersion');
    // The snapshot date is what makes an address-table refresh a reviewed data
    // change rather than a silent one, so a table without one is refused even
    // though nothing at runtime branches on the date.
    requireNonEmptyString(document.registrySnapshot, relativePath, 'registrySnapshot');
    const declaredRowCount = requireInteger(document.rowCount, relativePath, 'rowCount', 1);

    const hostClasses = requireNonEmptyArray(document.hostClasses, relativePath, 'hostClasses');
    hostClasses.forEach((entry, index) => {
        const hostClass = requireRecord(entry, relativePath, `hostClasses[${index}]`);
        requireNonEmptyString(hostClass.class, relativePath, `hostClasses[${index}].class`);
        // An empty host list matches nothing and an empty evidence-type list
        // corroborates nothing: either makes the class inert, which is a
        // curation mistake worth failing on rather than a permissive default.
        requireNonEmptyStringArray(hostClass.hosts, relativePath, `hostClasses[${index}].hosts`);
        requireNonEmptyStringArray(hostClass.evidenceTypes, relativePath, `hostClasses[${index}].evidenceTypes`);
    });

    const ranges = requireNonEmptyArray(document.specialPurposeRanges, relativePath, 'specialPurposeRanges');
    ranges.forEach((entry, index) => {
        const range = requireRecord(entry, relativePath, `specialPurposeRanges[${index}]`);
        // A row without a CIDR cannot classify an address, which does not fail
        // — it removes the range from the table and makes every address inside
        // it look globally routable.
        requireNonEmptyString(range.cidr, relativePath, `specialPurposeRanges[${index}].cidr`);
        requireNonEmptyString(range.name, relativePath, `specialPurposeRanges[${index}].name`);
        requireNonEmptyString(range.registry, relativePath, `specialPurposeRanges[${index}].registry`);
        requireGloballyReachable(
            range.globallyReachable,
            relativePath,
            `specialPurposeRanges[${index}].globallyReachable`,
        );
    });

    // `rowCount` is the document's own statement of how many address rows it
    // carries, and the pair is what a truncated or half-merged table shows up
    // as. This check is deliberately document-internal — the declared count
    // against the rows actually carried — because this loader holds no reviewed
    // values of its own to compare against, and one that invented some would be
    // a second policy nobody reviewed.
    //
    // The numbers are pinned against something the document cannot edit
    // elsewhere: `src/services/__tests__/evidence.logic.test.ts` reads this same
    // file off disk and asserts the snapshot date, this total, the
    // registry-derived count, the supplemental count and the supplemental block
    // set agree three ways — the document, the reviewed attestation in
    // `src/services/evidence.logic.ts`, and the values transcribed into
    // `docs/meal-planning/catalog-policy.md` — so a refresh of any one of the
    // three alone turns that suite red.
    if (ranges.length !== declaredRowCount) {
        throw shapeError(
            relativePath,
            `declares rowCount ${declaredRowCount} but carries ${ranges.length} specialPurposeRanges rows`,
        );
    }

    const fetchLimits = requireRecord(document.fetchLimits, relativePath, 'fetchLimits');
    requireNonEmptyStringArray(fetchLimits.schemes, relativePath, 'fetchLimits.schemes');
    requireNonEmptyArray(fetchLimits.allowedPorts, relativePath, 'fetchLimits.allowedPorts').forEach((port, index) => {
        requireInteger(port, relativePath, `fetchLimits.allowedPorts[${index}]`, 1);
    });
    // Zero redirects is a valid policy (follow none); zero milliseconds, zero
    // bytes or zero content types are not — each would be a limit that can
    // never be satisfied rather than a strict one.
    requireInteger(fetchLimits.maxRedirects, relativePath, 'fetchLimits.maxRedirects', 0);
    requireInteger(fetchLimits.timeoutMs, relativePath, 'fetchLimits.timeoutMs', 1);
    requireInteger(fetchLimits.maxBodyBytes, relativePath, 'fetchLimits.maxBodyBytes', 1);
    requireNonEmptyStringArray(fetchLimits.allowedContentTypes, relativePath, 'fetchLimits.allowedContentTypes');
    if (fetchLimits.maxSnippetChars !== undefined) {
        requireInteger(fetchLimits.maxSnippetChars, relativePath, 'fetchLimits.maxSnippetChars', 1);
    }

    // Every member the declared type promises has now been checked against the
    // document itself, which is what makes this a verified narrowing rather than
    // the declarative cast the other four loaders make.
    return value as EvidenceAllowlist;
};

/**
 * Declared for `catalog-load.ts` to read; nothing in this module computes or
 * compares a digest — verifying a release's files is that script's job.
 */
export interface CatalogReleaseFile {
    /**
     * The file's bare name inside the release directory. `path` is what
     * `catalog-load.ts` reads and rejects if it is not a single segment;
     * `name` is the same string under the name the release's own format
     * contract uses. Both are written so neither reader has to know about the
     * other's spelling.
     */
    readonly path: string;
    readonly name?: string;
    readonly sha256: string;
    readonly row_count: number;
    readonly bytes: number;
}

export interface CatalogReleaseCounts {
    readonly foods: number;
    /**
     * `foods` under the name the release's own format contract uses. A release
     * exports published foods only, so the two are the same measurement;
     * writing both keeps either spelling readable without a translation step,
     * as `path`/`name` above does. Optional: only a manifest written after
     * this field existed carries it.
     */
    readonly published_foods?: number;
    readonly aliases: number;
    readonly portions: number;
    readonly components: number;
    /**
     * How many published foods declare `nutrition_provenance`
     * `ingredient_derived` — the foods a component row can belong to.
     *
     * It sits beside `components` because it is what makes that count
     * readable. A component row is a composition, so `components: 0` is
     * correct exactly when no published food derives its nutrition from one,
     * and indistinguishable from a components export that dropped every row
     * when read on its own. The pair states the fact and its reason together,
     * and `catalog-release.ts` refuses a release where the two disagree.
     * Optional: only a manifest written after this field existed carries it.
     */
    readonly published_ingredient_derived?: number;
    readonly validation_records: number;
}

export interface CatalogReleaseSourceDataset {
    readonly name: string;
    /**
     * The LATEST dataset release present among this release's records — the
     * version the catalog is current to. USDA publishes Foundation in periodic
     * releases and every record carries its own, so a single value has to be
     * chosen deterministically rather than taken from whichever row happened
     * to be read last; `versions_present` carries the rest.
     */
    readonly version: string;
    /**
     * Every distinct dataset release the records of this dataset carry, sorted.
     * One entry for a single-release dataset such as SR Legacy; fourteen for
     * Foundation. Optional: only a manifest written after this field existed
     * carries it.
     */
    readonly versions_present?: readonly string[];
    readonly retrieved_at?: string;
    /**
     * Whether the dataset may be redistributed in this repository. USDA
     * FoodData Central is public domain, which is the basis on which a release
     * ships its descriptions, aliases and nutrient values at all.
     */
    readonly public_domain?: boolean;
    readonly notes?: string;
}

/**
 * Nullable throughout: a release built entirely from sourced records made no
 * model call, and `null` is the honest value for a model that was never
 * invoked. Writing a model name a release did not use would misattribute
 * every row in it.
 */
export interface CatalogReleaseModelVersions {
    readonly generation_model: string | null;
    readonly review_model: string | null;
    readonly prompt_version: string | null;
    /**
     * `prompt_version` under the release format contract's spelling, which
     * names it for the generation prompt it records and pairs it with
     * `review_prompt_version`. Optional: only a manifest written after this
     * field existed carries it.
     */
    readonly generation_prompt_version?: string | null;
    readonly review_prompt_version: string | null;
}

export interface CatalogReleaseCoverageRow {
    readonly category: CoverageCategory;
    readonly published: number;
    /**
     * `published` under the name the release format contract uses, written
     * alongside it for the same reason `by_category` accompanies `categories`.
     * Optional: only a manifest written after this field existed carries it.
     */
    readonly published_actual?: number;
    readonly published_target: number;
    /** Reported exactly and never rounded: a shortfall is an unmet requirement. */
    readonly shortfall: number;
}

export interface CatalogReleaseCoverage {
    /**
     * The coverage plan the totals below are measured against. It repeats the
     * manifest's top-level `coverage_plan_version` on purpose: a reader holding
     * only this block can still say which policy produced the numbers, and
     * `loadReleaseManifest` gates on the top-level field.
     */
    readonly coverage_plan_version?: string;
    readonly published_target_total?: number;
    readonly published_actual_total?: number;
    readonly published_total: number;
    /**
     * The SUM of the per-category shortfalls — not the gap between the two
     * totals, which is a different number whenever one category overshoots
     * its target while another falls short, and which would claim
     * per-category coverage a release may not have.
     */
    readonly shortfall_total: number;
    /**
     * How far the published total itself falls below the plan total, reported
     * separately so neither the per-category nor the aggregate reading is
     * lost. Optional: only a manifest written after this field existed
     * carries it.
     */
    readonly published_gap_to_total?: number;
    readonly categories: readonly CatalogReleaseCoverageRow[];
    /** `categories` under the name the release format contract uses. */
    readonly by_category?: readonly CatalogReleaseCoverageRow[];
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

/**
 * A loader's optional structural check. It runs after the version checks — a
 * `v2` document is refused for its version, not for failing a `v1` shape — and
 * before the result is cached, so a refused document is never memoised.
 *
 * Only `loadEvidenceAllowlist` passes one; the reason that document is the
 * exception is written out above the shapes.
 */
type ManifestShapeCheck<T> = (value: unknown, relativePath: string) => T;

const loadVersionedManifest = <T>(
    absolutePath: string,
    checks: readonly VersionCheck[],
    validateShape?: ManifestShapeCheck<T>,
): T => {
    const cached = manifestCache.get(absolutePath);
    if (cached !== undefined) {
        return cached as T;
    }

    const relativePath = describePath(absolutePath);
    // Read as `unknown`: the parsed document only becomes a `T` once its
    // version has been checked and — where a loader supplies one — its shape
    // has been verified. The cast below is the declarative one described above
    // the shapes, and it is confined to this line.
    const parsed = readJsonFile<unknown>(absolutePath);

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

    const value = validateShape === undefined ? (parsed as T) : validateShape(parsed, relativePath);

    // Cached only once every check has passed, so a refused manifest is never
    // memoised and the next call fails the same way instead of succeeding.
    manifestCache.set(absolutePath, value);
    // One line per real read: a cache hit is not a load, which also makes the
    // memoisation visible in a run's output.
    logger.info('manifest_loaded', { file: relativePath, version: declaredVersion });

    return value;
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
    loadVersionedManifest<EvidenceAllowlist>(
        dataPath(EVIDENCE_ALLOWLIST_FILE),
        [{ field: EVIDENCE_ALLOWLIST_VERSION_FIELD, expected: EXPECTED_EVIDENCE_ALLOWLIST_VERSION }],
        // The one loader that verifies its document rather than declaring it:
        // this file is the SSRF policy, and a field missing from it removes a
        // limit instead of raising one.
        assertEvidenceAllowlistShape,
    );

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
